# OneKhusa Webhook Verification Failure — Technical Report

**Status:** Open — blocking production transactions
**Reported by:** Backend team (merchant integration)
**Date:** 8 October 2026
**Component:** Inbound webhook signature verification — `POST /webhooks/payments`
**Event:** `payrequest.success`

---

## TL;DR

Every `payrequest.success` webhook sent by the OneKhusa sandbox gateway is rejected
with `HTTP 401` because the `X-OneKhusa-Webhook-Signature` value does not match
`HMAC-SHA512(rawBody, ONEKHUSA_WEBHOOK_SECRET)`.

We have proven, at byte level, that our receiving side is correct: the body we hash is
**byte-for-byte identical** to the body the gateway transmitted, our calculation is
independently reproduced by a second implementation, and our environment/secret loading
is clean. The mismatch therefore reduces to one of two things:

1. The `ONEKHUSA_WEBHOOK_SECRET` we were issued is not the key the gateway signs with, **or**
2. The gateway's signing input is not the raw request body in the form we receive it.

We cannot inspect the sender-side implementation, so **we are not asserting a gateway
defect.** We need OneKhusa to confirm the exact signing input and the active secret.

---

## Summary for the client

Plain-language status for the customer:

- **What you're seeing:** payments are made and the gateway confirms them as successful,
  but the purchase never completes on our side.
- **Why:** every confirmation the gateway sends us is rejected because its security
  signature doesn't match. We will not complete a payment from a confirmation we
  cannot authenticate — that protection stays on.
- **Where it stands:** we've verified our receiving system is correct down to the exact
  byte, and we've asked the payment provider to confirm which signing key they're using.
  We'll re-drive the affected transactions as soon as their signature validates.
- **No money is lost:** funds are captured by the gateway; the transactions are stuck in
  a pending state and will be reconciled, not silently dropped.

---

## 1. Client impact

- The end client is seeing transactions that **never complete** — payment is initiated,
  the gateway reports success (`transactionStatusCode: "S"`, `responseCode: "S100"`),
  but the order is never finalised in our system.
- Our integration **fails closed by design**: an unverified callback is rejected and the
  transaction is never marked successful. This is intentional — we will not finalise a
  payment from an unauthenticated payload.
- **38 consecutive callbacks** were rejected between **14:31 and 15:35 (CAT)** on
  8 October 2026 (at time of writing, and still climbing), **100% `401 Unauthorized`**.
  The gateway retried at a steady rate of one attempt every ~90–120 seconds across the
  full 64-minute window, and every retry failed identically.

**Net effect:** every payment in this window is stuck in a non-finalised state and must
be either re-driven or reconciled once the signature is resolved.

---

## 2. Environment

| Item | Value |
|---|---|
| Merchant sandbox | OneKhusa sandbox |
| Public callback URL | `https://zena-unjudgeable-renita.ngrok-free.dev/webhooks/payments` |
| Received `Content-Type` | `application/json` |
| Verification algorithm | `HMAC-SHA512`, lowercase hex, 128 chars |
| Signature header | `X-OneKhusa-Webhook-Signature` |
| Event header (as sent) | `X-Onekhusa-Webhook-Event: payrequest.success` |
| Secret length | 67 characters |
| Transport | HTTPS via ngrok tunnel → local Express |

---

## 3. Reproduction

```bash
# Live verification against the most recent gateway callback:
NGROK_API=http://127.0.0.1:40410/api/requests/http \
  node webhook-debug/calculate-hmac.js --ngrok latest
```

Exit code `2` = signatures do not match; `0` = match.

A saved copy of a real gateway body is retained at
`webhook-debug/captures/gateway-body.bin` (**not committed to Git**).

---

## 4. Evidence that our receiving side is correct

### 4.1 The body is not modified in transit or by our middleware

We replayed the **exact bytes the gateway sent** (captured at the tunnel) through our
Express pipeline with raw-body capture enabled, then compared fingerprints at both ends:

| Stage | Byte length | SHA-256 |
|---|---:|---|
| **Stage 1** — as received from the gateway (ngrok) | 627 | `8539c0e8c137dd84e4851e0765318118308156328b90fec24df536b6cbaac300` |
| **Stage 2** — as delivered to the verifier (`express.raw()`) | 627 | `8539c0e8c137dd84e4851e0765318118308156328b90fec24df536b6cbaac300` |

- Byte-for-byte identical: **YES**
- `Content-Length` header matches actual bytes: **627 = 627**
- Body delivered as a `Buffer`, not a re-serialised object: **YES**

**Conclusion:** `express.raw()` is configured correctly and no middleware alters the
payload before verification. *(This eliminates middleware misconfiguration and body
mutation as causes.)*

### 4.2 The payload is clean

```
bytes                 : 627
leading byte          : 123  ('{' — no UTF-8 BOM)
contains CR / LF / tab: false / false / false
contains 2+ spaces    : false   (compact JSON, single line)
UTF-8 round-trip equal: true
```

There is no whitespace, BOM, line ending, or encoding anomaly that could explain a
fingerprint difference.

### 4.3 Our verification is correct and independently reproduced

We built a second implementation (`webhook-debug/calculate-hmac.js`) that uses only
`node:crypto` and **does not import our production verifier**. Both reach the same
verdict:

```
app verifier result  : false
independent result   : false
verdicts agree       : YES
```

*(This eliminates a bug in our verification code as a cause.)*

### 4.4 Environment and secret loading are clean

```
env var                      : ONEKHUSA_WEBHOOK_SECRET
loaded                       : yes
length                       : 67
source                       : loaded from .env by dotenv
override detected            : no          <- no shell/CI variable is shadowing .env
definitions in dotenv files  : 1           <- no duplicate keys
```

We also scanned all source and build artifacts: the secret is **not hardcoded, not
logged, and not present in any file** except `.env` (which is git-ignored).

*(This eliminates an environment-variable override or duplicate definition as a cause.)*

### 4.5 The signature is a deterministic HMAC over the body

Across retries of the *same* payload the gateway returned a byte-identical signature.
Verified twice: `distinctSigs = 1` over successive retry batches of 14, 9 and 16, and
again on 8 Oct 2026 with **1 distinct signature across a fresh sample of 10 retries**.
Combined with §4.1, this means the gateway is performing a plain HMAC over the body as
transmitted — so a stable key and stable input must yield a stable, matching output.
They do not.

---

## 5. What we tested and ruled out

| Hypothesis | Result |
|---|---|
| Incorrect `express.raw()` configuration | **Ruled out** — byte-level proof (§4.1) |
| Request body modified before hashing | **Ruled out** — identical SHA-256 both ends |
| Incorrect signature header extraction | **Ruled out** — 128-hex value read from the correct header |
| Bug in our verifier | **Ruled out** — independent implementation agrees |
| Environment-variable override / duplicate `.env` key | **Ruled out** — clean single-source load |
| Wrong hash algorithm | Tested: `sha512`, `sha384`, `sha256` — no match |
| Secret transformed before use | Tested: hex-decoded, base64-decoded — no match |
| Non-raw signing input | Tested: `event + body`, `body + event`, `event:body`, `event\nbody` — no match |
| Different JSON serialisation | Tested: sorted-key, compact, pretty-printed — no match |
| Different byte encoding | Tested: UTF-16LE, Latin-1 — no match |
| Unkeyed hash of the body | Tested — no match |
| Wrong credential used as key | Tested: API secret, API key, org ID, merchant number, 11 guessed sandbox keys — no match |
| **Incorrect webhook secret (in `.env`)** | **Remaining hypothesis** |
| **Gateway signing input differs from received body** | **Remaining hypothesis** |

---

## 6. Signature comparison — fresh samples

Two distinct callbacks, both rejected.

**On where the mismatch appears:** the digests diverge at **byte 0** and share no prefix.
This is *not* diagnostic of which hypothesis is correct — HMAC-SHA512 is a pseudorandom
function, so **any** change to the key, or **any** change to the input bytes, produces a
completely uncorrelated digest. A differing first byte therefore only confirms that the
two sides hashed something different; it does not by itself distinguish a wrong key from
a wrong input. That distinction has to come from the controlled tests in §5.

### Sample A — 627 bytes

```
sha256 (body)        : 8539c0e8c137dd84e4851e0765318118308156328b90fec24df536b6cbaac300
received  (gateway)  : 9bf9900a733c151a59a14673250bbcfedc2c3074c6c8f6398bdb6d8baf8e21e2
                       5069010315c9408af39b2280ed0ea6f00a8bcaffccbe774c830c147e0c425f6f
calculated (ours)    : 4351143068669031fae7575f0397baccf8889d52d46ea36b20cc3aeed1207647
                       df10b559097c76b4619f9c1e1f0f8928122de22153582cc8737e74c7a21089c9
first differing byte : byte 0 (received 9b vs calculated 43)
```

### Sample B — 624 bytes

```
sha256 (body)        : 0547b1e5d8abc93d4dbe5e248f09da551789092d252a3b229efd78581bcad2d4
received  (gateway)  : a84429cf9ae4cd8f8546cad0c5beebfe4387f1526b7ebf89b54f707abf95c179
                       2155e18f494d111e0b60519ac9513dd56f912806935191ce83986123ccf3aaf9
calculated (ours)    : 814e427216319b37358a28ef5f888a5a22687bf484aded907a4fcf85e6d5e697
                       e05966e76b9a047d473fbae2bbd08c0d8fd58e6a27efedd46b8e8675ddfcf1aa
first differing byte : byte 0
```

Both bodies are compact single-line JSON, 128-hex signatures, valid JSON payloads.

---

## 7. Payload structure (sensitive values masked)

```jsonc
{
  "connectorId": 221300,                       // number
  "sourceAccountNumber": "***0160",
  "sourceAccountName": "***********LENI",
  "sourceInstitution": "National Bank of Malawi",
  "sourceReferenceNumber": "********8R6Y",     // merchant reference
  "beneficiaryAccountNumber": "****8287",
  "transactionReferenceNumber": "**********QL8S",
  "transactionDescription": "Fake Request To Pay Transaction",
  "transactionAmount": 2000,                   // number
  "transactionFee": 20,                        // number
  "transactionDate": "2026-10-08T14:31:09.7565526+02:00",
  "transactionStatusCode": "S",                // SUCCESS
  "transactionCode": "BAM",
  "responseCode": "S100",                      // SUCCESS
  "metaData": {
    "TimedAccountNumber": "****4771",
    "ReferenceNumber": "***********H8RS",
    "SourceDescription": "Airtime",
    "AdditionalInfo": ""
  }
}
```

Note: there is **no `eventType` field** in the body — the event name arrives only in the
header. Also worth flagging: the live gateway sends the event header as
`X-Onekhusa-Webhook-Event` (with the `X-` prefix), whereas published documentation
refers to `OneKhusa-Webhook-Event`. We accept both spellings, but this is a
documentation/implementation discrepancy worth confirming.

---

## 8. What we need from OneKhusa

1. **Confirm the active webhook signing secret** for this merchant in the sandbox — in
   particular, whether it is the value shown in portal → webhook settings, and whether it
   has been rotated since it was first issued to us.
2. **Confirm the exact signing input**, precisely:
   - Is it the raw body bytes exactly as transmitted?
   - Is there a prefix, suffix, or delimiter (event name, timestamp, nonce, URL)?
   - Which hash and encoding (`HMAC-SHA512`, lowercase hex)?
3. **Confirm the header name** actually sent for both the signature and the event.
4. **Provide a known-good test vector** if one is available: a sample body, the secret
   used, and the resulting signature. This would resolve the issue in a single step.
5. **Confirm whether the secret is per-organisation or per-endpoint**, and whether the
   portal value differs from the value used by the sending service.

If a test vector is impractical, the fastest path is for OneKhusa to log, on their side,
the exact byte sequence and key ID used to produce the signature for one of the callbacks
above (timestamped 8 Oct 14:31–15:35 CAT), so we can compare it against
`sha256 8539c0e8…`.

---

## 9. Internal action items

> **Internal only** — remove this section before sending the report to OneKhusa.

- [ ] Rotate `ONEKHUSA_WEBHOOK_SECRET`. The current value was pasted in plaintext during
      troubleshooting and must be treated as compromised until rotated.
- [ ] Obtain the correct secret from OneKhusa, then confirm with
      `node webhook-debug/calculate-hmac.js --ngrok latest` → exit code `0`.
- [ ] Re-drive the stuck transactions from the impact window (38+ callbacks as of
      14:31–15:35 CAT) once verification passes.
- [ ] Remove the temporary diagnostic logging block from
      `src/middleware/verifyWebhookSignature.js`.
- [ ] Decide on an interim acknowledgement strategy if callbacks will keep failing for an
      extended period (must remain off by default and must never auto-finalise).

---

## 10. Reproduction artifacts

| Artifact | Purpose |
|---|---|
| `webhook-debug/calculate-hmac.js` | Independent HMAC-SHA512 calculator (does not import our verifier) |
| `webhook-debug/capture-webhook.js` | Raw-body capture middleware, opt-in via `WEBHOOK_CAPTURE_ENABLED` |
| `webhook-debug/captures/gateway-body.bin` | Real 627-byte gateway payload (git-ignored) |
| `webhook-debug/README.md` | Full instructions and interpretation matrix |
| `npm test` | 40 automated tests — valid signatures, wrong secrets, tampered payloads, byte preservation |

**Captured payloads contain account numbers and transaction references. They are
git-ignored and must not be shared outside the parties resolving this issue.**

---

### Note on attribution

We have eliminated every variable on our side except the key material and the gateway's
signing input. We are **not** claiming the gateway is at fault — we cannot inspect its
implementation, and an unknown signing input remains possible. This report is intended to
give OneKhusa enough concrete, reproducible evidence (exact fingerprints, byte lengths,
and timestamps) to confirm or rule out the issue quickly on their side.
