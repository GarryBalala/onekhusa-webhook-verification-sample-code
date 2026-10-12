/**
 * Automated tests for the webhook debug tooling.
 *
 * Covers: valid signatures, incorrect secrets, modified payloads, raw-body
 * preservation, capture-off-by-default, and secret handling.
 *
 * Runs on the built-in Node test runner (no extra dependencies).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// --- Environment setup, before anything reads config ------------------------
const TEST_SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyzABCDEF';
process.env.ONEKHUSA_WEBHOOK_SECRET = TEST_SECRET;
delete process.env.WEBHOOK_CAPTURE_ENABLED; // capture off by default

// Isolate capture output so a test run never writes into, or deletes from,
// the directory holding real gateway payloads.
const os = require('node:os');
const TEST_CAPTURE_DIR = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-capture-test-')),
  'captures',
);
process.env.WEBHOOK_CAPTURE_DIR = TEST_CAPTURE_DIR;

const app = require('../src/app');
const config = require('../src/config');
const { WebhookSecurity } = require('../src/utils/webhookSecurity');
const verifyWebhookSignature = require('../src/middleware/verifyWebhookSignature');
const {
  captureWebhook,
  isCaptureEnabled,
  writeCapture,
  CAPTURE_DIR,
  FLAG,
} = require('./capture-webhook');
const { independentHmacSha512, resolveSecret } = require('./calculate-hmac');

const WEBHOOK_URL = '/webhooks/payments';

const sign = (body, secret = TEST_SECRET) =>
  crypto.createHmac('sha512', secret).update(body, 'utf8').digest('hex');

/** Start the real app on an ephemeral port. */
async function withServer(fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Start an ad-hoc app that runs express.raw() + the capture middleware. */
async function withCapturingApp(fn) {
  const local = express();
  local.use(express.raw({ type: '*/*', limit: '1mb' }));
  local.use(captureWebhook);
  local.post(WEBHOOK_URL, (req, res) => {
    res.json({ captured: req.webhookCaptureFile || null });
  });

  const server = await new Promise((resolve) => {
    const s = local.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * List capture files WITHOUT deleting anything.
 *
 * Deliberately non-destructive: captures/ holds real gateway payloads that are
 * valuable diagnostic evidence. Tests assert on before/after counts instead of
 * wiping the directory, so running the suite can never destroy live captures.
 *
 * @returns {string[]} Filenames only.
 */
function listCaptures() {
  if (!fs.existsSync(CAPTURE_DIR)) return [];
  return fs.readdirSync(CAPTURE_DIR).filter((f) => f.endsWith('.json'));
}

// ---------------------------------------------------------------------------
// 1. Independent calculation agrees with the application verifier
// ---------------------------------------------------------------------------

test('independent HMAC-SHA512 matches the application verifier on a valid signature', () => {
  const body = Buffer.from(JSON.stringify({ eventType: 'payrequest.success', n: 1 }));

  const independent = independentHmacSha512(body, TEST_SECRET);
  const viaApp = WebhookSecurity.computeSignature(body, TEST_SECRET);

  assert.equal(independent, viaApp);
  assert.equal(WebhookSecurity.verifySignature(body, TEST_SECRET, independent), true);
});

test('independent calculation rejects an incorrect secret', () => {
  const body = Buffer.from('{"a":1}');

  assert.notEqual(
    independentHmacSha512(body, TEST_SECRET),
    independentHmacSha512(body, 'a-wrong-secret'),
  );
  assert.equal(
    WebhookSecurity.verifySignature(body, 'a-wrong-secret', independentHmacSha512(body, TEST_SECRET)),
    false,
  );
});

test('independent calculation rejects a modified payload', () => {
  const original = Buffer.from('{"amount":100}');
  const modified = Buffer.from('{"amount":999999}');

  assert.notEqual(
    independentHmacSha512(original, TEST_SECRET),
    independentHmacSha512(modified, TEST_SECRET),
  );
  assert.equal(
    WebhookSecurity.verifySignature(modified, TEST_SECRET, independentHmacSha512(original, TEST_SECRET)),
    false,
  );
});

test('independent calculation refuses a missing secret', () => {
  // The calculator is an instrument: it computes a digest for whatever bytes
  // it is given, including an empty Buffer. Rejection of empty bodies is a
  // policy of the APPLICATION verifier, not of the measurement tool — the
  // divergence is reported deliberately by the comparison section.
  assert.doesNotThrow(() => independentHmacSha512(Buffer.alloc(0), TEST_SECRET));
  assert.equal(independentHmacSha512(Buffer.alloc(0), TEST_SECRET).length, 128);

  // The application, by contrast, refuses to authenticate an empty body.
  assert.equal(
    WebhookSecurity.verifySignature(Buffer.alloc(0), TEST_SECRET, independentHmacSha512(Buffer.alloc(0), TEST_SECRET)),
    false,
  );

  assert.throws(() => independentHmacSha512(Buffer.from('x'), ''), /secret/i);
  assert.throws(() => independentHmacSha512('not a buffer', TEST_SECRET), TypeError);
});

// ---------------------------------------------------------------------------
// 2. Configuration / environment handling
// ---------------------------------------------------------------------------

test('config exposes the secret verbatim, with no transformation', () => {
  assert.equal(config.webhookSecret, process.env.ONEKHUSA_WEBHOOK_SECRET);
  assert.equal(config.webhookSecret, TEST_SECRET);
  assert.equal(config.webhookSecret.length, TEST_SECRET.length);
  // Must differ from the API secret, or the wrong credential would be used.
  assert.notEqual(config.webhookSecret, config.apiSecret);
});

test('resolveSecret reports the loaded secret and never exposes it', () => {
  const resolved = resolveSecret();
  assert.equal(resolved.name, 'ONEKHUSA_WEBHOOK_SECRET');
  assert.equal(resolved.value, TEST_SECRET);
  assert.notEqual(resolved.source, 'NOT LOADED');
});

test('a shell-provided secret wins over .env (dotenv does not override)', () => {
  // resolveSecret must report the pre-existing process.env value, because
  // dotenv will not replace it. This is the common CI/shell override trap.
  const resolved = resolveSecret();
  assert.equal(resolved.value, process.env.ONEKHUSA_WEBHOOK_SECRET);
  assert.match(resolved.source, /process\.env|dotenv/);
});

test('config header lists accept both gateway spellings', () => {
  assert.deepEqual(config.webhookSignatureHeaders, [
    'X-OneKhusa-Webhook-Signature',
    'OneKhusa-Webhook-Signature',
  ]);
  assert.deepEqual(config.webhookEventHeaders, [
    'X-Onekhusa-Webhook-Event',
    'OneKhusa-Webhook-Event',
  ]);
});

// ---------------------------------------------------------------------------
// 3. Capture is disabled by default
// ---------------------------------------------------------------------------

test('capture is disabled by default', () => {
  delete process.env.WEBHOOK_CAPTURE_ENABLED;
  assert.equal(isCaptureEnabled(), false);
});

test('capture flag honours falsy values and is off for anything unset', () => {
  const original = process.env.WEBHOOK_CAPTURE_ENABLED;
  try {
    for (const value of ['', '0', 'false', 'off', 'no', 'FALSE']) {
      process.env.WEBHOOK_CAPTURE_ENABLED = value;
      assert.equal(isCaptureEnabled(), false, `"${value}" should disable capture`);
    }
    for (const value of ['1', 'true', 'yes', 'on']) {
      process.env.WEBHOOK_CAPTURE_ENABLED = value;
      assert.equal(isCaptureEnabled(), true, `"${value}" should enable capture`);
    }
  } finally {
    if (original === undefined) delete process.env.WEBHOOK_CAPTURE_ENABLED;
    else process.env.WEBHOOK_CAPTURE_ENABLED = original;
  }
});

test('the real app accepts webhooks with capture disabled and writes no files', async () => {
  // Count before/after rather than wiping captures/ — real gateway payloads
  // must survive a test run.
  const before = listCaptures().length;

  await withServer(async (port) => {
    const body = JSON.stringify({
      eventType: 'payrequest.success',
      metaData: { ReferenceNumber: 'CAPTURE-OFF-1' },
    });

    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OneKhusa-Webhook-Signature': sign(body) },
      body,
    });

    assert.equal(res.status, 200);
  });

  assert.equal(
    listCaptures().length,
    before,
    'capture must write no files when WEBHOOK_CAPTURE_ENABLED is unset',
  );
});

// ---------------------------------------------------------------------------
// 4. Raw-body preservation
// ---------------------------------------------------------------------------

test('capture preserves the exact raw bytes, including BOM, unicode and whitespace', async () => {
  process.env.WEBHOOK_CAPTURE_ENABLED = 'true';

  // Deliberately awkward payload: BOM, non-ASCII, unusual whitespace, and a
  // key order that a JSON round-trip would not reproduce.
  const text = '﻿{"zeta":"éèê","nested":{"b":1,   "a":2}}  ';
  const sent = Buffer.from(text, 'utf8');

  let captureFile = null;
  await withCapturingApp(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: sent,
    });
    assert.equal(res.status, 200);
    captureFile = (await res.json()).captured;
  });

  delete process.env.WEBHOOK_CAPTURE_ENABLED;
  assert.ok(captureFile, 'capture file should have been written');

  const record = JSON.parse(fs.readFileSync(captureFile, 'utf8'));
  const decoded = Buffer.from(record.body.base64, 'base64');

  assert.equal(record.body.isBuffer, true);
  assert.equal(record.body.byteLength, sent.length);
  assert.equal(decoded.length, sent.length);
  assert.ok(decoded.equals(sent), 'captured bytes must be byte-for-byte identical');
  assert.equal(
    record.body.sha256,
    crypto.createHash('sha256').update(sent).digest('hex'),
  );

  // A re-serialisation would have lost the BOM and reordered the keys.
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(text.replace(/^﻿/, ''))), 'utf8');
  assert.equal(decoded.equals(reserialised), false);
  assert.notEqual(
    independentHmacSha512(decoded, TEST_SECRET),
    independentHmacSha512(reserialised, TEST_SECRET),
  );
});

test('captured bytes reproduce the same HMAC as the bytes actually sent', async () => {
  process.env.WEBHOOK_CAPTURE_ENABLED = '1';

  const body = '{"sourceReferenceNumber":"FP-1","transactionAmount":100}';
  const sent = Buffer.from(body, 'utf8');
  const expected = sign(sent);

  let record;
  await withCapturingApp(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OneKhusa-Webhook-Signature': expected },
      body: sent,
    });
    const payload = await res.json();
    record = JSON.parse(fs.readFileSync(payload.captured, 'utf8'));
  });

  delete process.env.WEBHOOK_CAPTURE_ENABLED;

  const decoded = Buffer.from(record.body.base64, 'base64');
  assert.equal(independentHmacSha512(decoded, TEST_SECRET), expected);
  assert.equal(record.app.calculatedSignature, expected);
  assert.equal(record.app.matchesReceived, true);
  assert.equal(record.signature.value, expected);
});

test('capture file never contains the webhook secret', () => {
  process.env.WEBHOOK_CAPTURE_ENABLED = 'true';

  const written = writeCapture({
    method: 'POST',
    url: WEBHOOK_URL,
    originalUrl: WEBHOOK_URL,
    httpVersion: '1.1',
    headers: { 'content-type': 'application/json', authorization: 'Bearer super-secret-token' },
    body: Buffer.from('{"secret":"should-not-matter"}'),
    get(name) {
      const v = this.headers[name.toLowerCase()];
      return typeof v === 'string' ? v : undefined;
    },
  });

  delete process.env.WEBHOOK_CAPTURE_ENABLED;

  assert.ok(written);
  const raw = fs.readFileSync(written.file, 'utf8');
  assert.equal(raw.includes(TEST_SECRET), false, 'secret must not be in capture');
  assert.equal(raw.includes('Bearer'), false, 'authorization header must not be captured');
  assert.equal(written.record.signature.secretLength, TEST_SECRET.length);
  assert.equal(written.record.signature.secretSet, true);
});

test('capture does not throw when the raw body is unavailable', () => {
  process.env.WEBHOOK_CAPTURE_ENABLED = 'true';

  const written = writeCapture({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: {},
    body: { alreadyParsed: true },
    get() { return undefined; },
  });

  delete process.env.WEBHOOK_CAPTURE_ENABLED;

  assert.equal(written.record.body.isBuffer, false);
  assert.equal(written.record.body.base64, null);
  assert.match(written.record.body.note, /express\.raw/);
});

// ---------------------------------------------------------------------------
// 5. Verification still enforced — no bypass, no false success
// ---------------------------------------------------------------------------

test('a valid signature is accepted', async () => {
  await withServer(async (port) => {
    const body = JSON.stringify({
      eventType: 'payrequest.success',
      metaData: { ReferenceNumber: 'VALID-OK' },
      responseCode: 'S100',
    });

    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OneKhusa-Webhook-Signature': sign(body) },
      body,
    });

    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'acknowledged');
  });
});

test('an incorrect secret still produces 401', async () => {
  await withServer(async (port) => {
    const body = JSON.stringify({ metaData: { ReferenceNumber: 'BAD-SECRET' } });

    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OneKhusa-Webhook-Signature': sign(body, 'wrong') },
      body,
    });

    assert.equal(res.status, 401);
  });
});

test('a payload modified after signing still produces 401', async () => {
  await withServer(async (port) => {
    const signed = JSON.stringify({
      eventType: 'payrequest.success',
      metaData: { ReferenceNumber: 'ORIGINAL-REF' },
    });
    const tampered = signed.replace('ORIGINAL-REF', 'ATTACKER-REF');

    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OneKhusa-Webhook-Signature': sign(signed) },
      body: tampered,
    });

    assert.equal(res.status, 401);
  });
});

test('a missing signature still produces 401', async () => {
  await withServer(async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ metaData: { ReferenceNumber: 'NO-SIG' } }),
    });

    assert.equal(res.status, 401);
  });
});

test('verification does not import the debug tooling (no debug dependency)', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'middleware', 'verifyWebhookSignature.js'),
    'utf8',
  );
  assert.equal(source.includes('webhook-debug'), false);
  assert.equal(source.includes("require('../utils/webhookSecurity')"), true);
});

// ---------------------------------------------------------------------------
// Teardown — remove the isolated capture directory created for this run
// ---------------------------------------------------------------------------

test.after(() => {
  try {
    fs.rmSync(path.dirname(TEST_CAPTURE_DIR), { recursive: true, force: true });
  } catch {
    // Best effort; a leftover temp dir is harmless.
  }
});