# OneKhusa Webhook Debug Toolkit

Independent tooling for diagnosing `HMAC-SHA512` signature mismatches on
`POST /webhooks/payments`.

The toolkit exists to answer one question: **are we hashing the same bytes with
the same key as the gateway?** It is deliberately separate from the application
verifier so that a bug in one cannot hide a bug in the other.

---

## Contents

| File | Purpose |
| ---- | ------- |
| `capture-webhook.js` | Express middleware that records the exact raw request bytes as a Buffer (base64) plus signature/event headers. Off by default. |
| `calculate-hmac.js` | Standalone HMAC-SHA512 calculator using `node:crypto` only. Never imports the application verifier for its calculation. |
| `webhook-debug.test.js` | Automated tests: valid signatures, wrong secrets, modified payloads, raw-byte preservation, capture-off-by-default. |
| `captures/` | Output directory for captures. **Gitignored.** |

---

## Quick start

### 1. Run the tests

```bash
npm test
```

40 tests, no extra dependencies (built-in Node test runner).

### 2. Capture a live webhook

Capture is **disabled by default**. Enable it explicitly for one session:

**PowerShell**
```powershell
$env:WEBHOOK_CAPTURE_ENABLED = '1'
npm run dev
```

**bash**
```bash
WEBHOOK_CAPTURE_ENABLED=1 npm run dev
```

Then trigger a payment and watch for:

```
🔍  Webhook raw-body capture ENABLED (WEBHOOK_CAPTURE_ENABLED) — debug only
[webhook-debug] captured -> webhook-debug\captures\2026-10-08T...json
```

Capture **never changes the response** — verification still runs, invalid
signatures still return `401`, and unverified payments are never marked
successful. Turn it off by restarting without the variable.

### 3. Calculate the HMAC independently

From a capture file:

```bash
node webhook-debug/calculate-hmac.js --capture webhook-debug/captures/<file>.json
```

Directly from live ngrok traffic (no capture needed):

```bash
node webhook-debug/calculate-hmac.js --ngrok latest
```

From a raw body file plus a signature you already have:

```bash
node webhook-debug/calculate-hmac.js --body body.bin --signature <128 hex chars>
```

Options:

| Flag | Effect |
| ---- | ------ |
| `--json` | Machine-readable output |
| `--fingerprint` | Print a SHA-256 **tag** of the secret so two sources can be compared without revealing it. Off by default. |
| `--signature` | Supply the received signature when it isn't in the source file |

Exit codes: `0` = signatures match, `2` = mismatch, `1` = tooling error.

---

## Reading the report

```
Input
  source                       : ngrok request airt_... (start=..., http=200)
  event                        : payrequest.success

Raw body
  byte length                  : 627
  sha256 fingerprint           : 9c1f...            <-- the receipt for these bytes
  first 16 bytes (hex)         : 7b22636f6e6e6563746f7249642232
  last 16 bytes (hex)          : ...
  is valid JSON                : yes

Secret
  env var                      : ONEKHUSA_WEBHOOK_SECRET
  loaded                       : yes
  length                       : 67
  source                       : loaded from .env by dotenv
  override detected            : no
  definitions in dotenv files  : 1

Signature
  received length              : 128
  received                     : 847fcedd...
  calculated (independent)     : 3735f07a...
  received is 128 hex          : yes

Result
  SIGNATURES MATCH             : NO
  first differing byte         : byte 0 (received 84 vs calculated 37)

Application comparison
  app verifier available       : yes
  app verifier result          : false
  independent result           : false
  verdicts agree               : YES
```

### Interpretation matrix

| Observation | Meaning | Action |
| --- | --- | --- |
| `verdicts agree = YES` and both `false` | The tool and the app agree the signature is wrong. The **algorithm is fine**; the key or the signed bytes differ. | Compare `sha256 fingerprint` against a capture from a *known-good* environment. Confirm the secret source/override. |
| `verdicts agree = NO` | The application verifier disagrees with the independent calculation. | **Bug in our verifier** — inspect `src/utils/webhookSecurity.js`. |
| `override detected = YES` | A shell/CI/service variable is beating `.env`. | Check which value is intended; `dotenv` never overwrites `process.env`. |
| `definitions in dotenv files > 1` | Duplicate keys — which wins depends on the file. | Keep exactly one definition. |
| `is valid JSON = NO` but gateway claims JSON | Bytes on the wire aren't the JSON you expect (proxy re-encoding, truncation, gzip). | Compare `byte length` to `Content-Length`. |
| `byte length` ≠ gateway `Content-Length` | Body was altered or truncated in transit. | Fix the proxy/middleware — see below. |
| All real gateway bodies mismatch with the *correct* secret | Our bytes or our key differ from what the gateway signed. | Escalate to OneKhusa with `sha256 fingerprint`, `byte length` and the received signature. |

---

## What this toolkit checks for you

1. **Incorrect webhook secret** — `Secret` block reports length, source, and
   override status without ever printing the value.
2. **Misconfigured `express.raw()`** — if `express.raw()` did not run, the
   capture records `isBuffer: false` with a note, because `req.body` will
   already be a parsed object.
3. **Modified request bytes** — `byte length` and `sha256 fingerprint` are
   taken from the Buffer the verifier actually hashes; compare against
   `Content-Length` to detect tampering.
4. **Signature extraction errors** — `received` is shown verbatim with its
   length and header name.
5. **Divergence between gateway input and received payload** — compare the
   fingerprint across two different sources (capture file vs `--ngrok`).

---

## Environment and secret handling

* Secret is read from `ONEKHUSA_WEBHOOK_SECRET` via `dotenv`.
* `dotenv` **never overwrites** an existing `process.env` value, so a shell or
  CI export silently wins over `.env`. `calculate-hmac.js` detects and reports
  this as `override detected`.
* The secret is **never** printed, logged, written to a capture file, or
  included in `--json` output. Only its length, its source, and (opt-in) an
  irreversible 8-character SHA-256 tag are shown.

---

## Git safety

`.gitignore` excludes:

```
.env
webhook-debug/captures/
*.bin
webhook-debug/*.local.json
```

Captured files contain full gateway payloads, account numbers and
transaction references. **Do not commit them.**

---

## Cleanup

When diagnosis is complete:

```bash
Remove-Item -Recurse webhook-debug\captures\*   # PowerShell
rm -rf webhook-debug/captures/*                 # bash
```

The `TEMPORARY DIAGNOSTIC` block in
`src/middleware/verifyWebhookSignature.js` also prints a diagnostic on every
webhook — remove it once the issue is resolved, since it logs signature values
on every request.