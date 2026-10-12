/**
 * Webhook signature verification tests.
 *
 * Runs on the built-in Node test runner (`npm test`) — no extra dependencies.
 *
 * The secret is injected before `src/config` is required; dotenv never
 * overwrites variables that are already set, so this stays deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const SECRET = 'test-webhook-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

process.env.ONEKHUSA_WEBHOOK_SECRET = SECRET;

const app = require('../src/app');
const config = require('../src/config');
const { WebhookSecurity } = require('../src/utils/webhookSecurity');
const statusCache = require('../src/utils/statusCache');

const WEBHOOK_URL = '/webhooks/payments';

/**
 * Sign a raw body the same way OneKhusa does.
 *
 * @param {string} rawBody
 * @param {string} [secret]
 * @returns {string}
 */
function sign(rawBody, secret = SECRET) {
  return crypto.createHmac('sha512', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * POST a webhook to the app.
 *
 * @param {string} rawBody Exact bytes to send.
 * @param {object} [options]
 * @returns {Promise<Response>}
 */
function post(rawBody, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-OneKhusa-Webhook-Signature': options.signature ?? sign(rawBody, options.secret),
    ...(options.event ? { 'X-Onekhusa-Webhook-Event': options.event } : {}),
  };
  if (options.omitSignature) delete headers['X-OneKhusa-Webhook-Signature'];

  return fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

/** @type {number} */
let port;
/** @type {import('node:http').Server} */
let server;

test.before(async () => {
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  port = server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// Unit: WebhookSecurity
// ---------------------------------------------------------------------------

test('computeSignature matches HMAC-SHA512 hex digest', () => {
  const expected = crypto
    .createHmac('sha512', SECRET)
    .update('{"a":1}', 'utf8')
    .digest('hex');
  assert.equal(WebhookSecurity.computeSignature('{"a":1}', SECRET), expected);
  assert.equal(WebhookSecurity.computeSignature('{"a":1}', SECRET).length, 128);
});

test('verifySignature accepts a correct signature', () => {
  assert.equal(WebhookSecurity.verifySignature('{"a":1}', SECRET, sign('{"a":1}')), true);
});

test('verifySignature accepts an uppercase signature header', () => {
  assert.equal(
    WebhookSecurity.verifySignature('{"a":1}', SECRET, sign('{"a":1}').toUpperCase()),
    true,
  );
});

test('verifySignature rejects a signature from the wrong secret', () => {
  assert.equal(
    WebhookSecurity.verifySignature('{"a":1}', SECRET, sign('{"a":1}', 'other-secret')),
    false,
  );
});

test('verifySignature rejects a tampered body', () => {
  assert.equal(
    WebhookSecurity.verifySignature('{"a":2}', SECRET, sign('{"a":1}')),
    false,
  );
});

test('verifySignature rejects missing inputs', () => {
  assert.equal(WebhookSecurity.verifySignature('{"a":1}', SECRET, ''), false);
  assert.equal(WebhookSecurity.verifySignature('{"a":1}', SECRET, null), false);
  assert.equal(WebhookSecurity.verifySignature('{"a":1}', '', sign('{"a":1}')), false);
  assert.equal(WebhookSecurity.verifySignature('', SECRET, sign('')), false);
  assert.equal(WebhookSecurity.verifySignature(null, SECRET, sign('')), false);
});

test('verifySignature rejects a wrong-length signature without throwing', () => {
  assert.equal(WebhookSecurity.verifySignature('{"a":1}', SECRET, 'deadbeef'), false);
});

test('re-serialised JSON does not match the original signature', () => {
  // Pretty-printing is what breaks a re-serialised digest: whitespace changes.
  const original = JSON.stringify({ a: 1, b: 2 }, null, 2);
  const reserialized = JSON.stringify(JSON.parse(original));
  assert.notEqual(reserialized, original);
  assert.equal(
    WebhookSecurity.verifySignature(reserialized, SECRET, sign(original)),
    false,
  );
});

test('verifySignature accepts a Buffer payload', () => {
  const body = Buffer.from('{"a":1}', 'utf8');
  assert.equal(WebhookSecurity.verifySignature(body, SECRET, sign('{"a":1}')), true);
  assert.equal(WebhookSecurity.verifySignature(Buffer.alloc(0), SECRET, 'abc'), false);
});

// ---------------------------------------------------------------------------
// Integration: POST /webhooks/payments
// ---------------------------------------------------------------------------

test('accepts a correctly signed webhook and finalises the payment', async () => {
  const reference = 'OT-NJ-VERIFY-OK';
  const body = JSON.stringify({
    eventType: 'payrequest.success',
    metaData: { ReferenceNumber: reference },
    responseCode: 'S100',
  });

  const res = await post(body, { event: 'payrequest.success' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'acknowledged');
  assert.equal(statusCache.get(`status_${reference}`), 'Paid');
});

test('rejects a webhook signed with the wrong secret', async () => {
  const reference = 'OT-NJ-VERIFY-BADSECRET';
  const body = JSON.stringify({
    eventType: 'payrequest.success',
    metaData: { ReferenceNumber: reference },
  });

  const res = await post(body, { secret: 'not-the-onekhusa-secret' });
  assert.equal(res.status, 401);
  assert.equal(statusCache.get(`status_${reference}`, 'NotFound'), 'NotFound');
});

test('rejects a webhook with no signature header', async () => {
  const reference = 'OT-NJ-VERIFY-NOSIG';
  const body = JSON.stringify({ metaData: { ReferenceNumber: reference } });

  const res = await post(body, { omitSignature: true });
  assert.equal(res.status, 401);
  assert.equal(statusCache.get(`status_${reference}`, 'NotFound'), 'NotFound');
});

test('rejects a body mutated after it was signed', async () => {
  const signedBody = JSON.stringify({
    eventType: 'payrequest.success',
    metaData: { ReferenceNumber: 'OT-NJ-VERIFY-TAMPER' },
  });
  const tamperedBody = signedBody.replace('OT-NJ-VERIFY-TAMPER', 'OT-NJ-VERIFY-STOLEN');

  const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OneKhusa-Webhook-Signature': sign(signedBody),
    },
    body: tamperedBody,
  });

  assert.equal(res.status, 401);
  assert.equal(statusCache.get('status_OT-NJ-VERIFY-STOLEN', 'NotFound'), 'NotFound');
});

test('signature survives gateway-style pretty printing', async () => {
  // Real gateways sometimes re-indent the body before signing it.
  const reference = 'OT-NJ-VERIFY-PRETTY';
  const body = JSON.stringify(
    { eventType: 'payrequest.success', metaData: { ReferenceNumber: reference } },
    null,
    2,
  );

  const res = await post(body, { event: 'payrequest.success' });
  assert.equal(res.status, 200);
  assert.equal(statusCache.get(`status_${reference}`), 'Paid');
});

test('uses the event header when the payload has no event field', async () => {
  const reference = 'OT-NJ-VERIFY-EVENTHDR';
  const body = JSON.stringify({ metaData: { ReferenceNumber: reference } });

  const res = await post(body, { event: 'payrequest.failed' });
  assert.equal(res.status, 200);
  assert.equal(statusCache.get(`status_${reference}`), 'Failed');
});

test('rejects an empty signed body', async () => {
  const res = await post('');
  assert.equal(res.status, 401);
});

test('accepts a BOM-prefixed body and still verifies the signature', async () => {
  // The BOM is part of the signed bytes, so the HMAC must include it — but it
  // must be stripped before JSON.parse, which rejects it outright.
  const reference = 'OT-NJ-VERIFY-BOM';
  const body = `\uFEFF${JSON.stringify({
    eventType: 'payrequest.success',
    metaData: { ReferenceNumber: reference },
  })}`;

  const res = await post(body, { event: 'payrequest.success' });
  assert.equal(res.status, 200);
  assert.equal(statusCache.get(`status_${reference}`), 'Paid');
});

test('signed non-JSON body is rejected as an invalid payload', async () => {
  const res = await post('not-json', { omitSignature: true });
  assert.equal(res.status, 401);

  const signed = await post('not-json');
  assert.equal(signed.status, 400);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('config exposes the documented header names and the injected secret', () => {
  assert.deepEqual(config.webhookSignatureHeaders, [
    'X-OneKhusa-Webhook-Signature',
    'OneKhusa-Webhook-Signature',
  ]);
  assert.deepEqual(config.webhookEventHeaders, [
    'X-Onekhusa-Webhook-Event',
    'OneKhusa-Webhook-Event',
  ]);
  assert.equal(config.webhookSecret, SECRET);
});

test('accepts either spelling of the event header', async () => {
  // The live gateway sends X-Onekhusa-Webhook-Event; the guide omits the X-.
  for (const [index, header] of ['OneKhusa-Webhook-Event', 'X-Onekhusa-Webhook-Event'].entries()) {
    const reference = `OT-NJ-VERIFY-HDR-${index}`;
    const body = JSON.stringify({ metaData: { ReferenceNumber: reference } });

    const res = await fetch(`http://127.0.0.1:${port}${WEBHOOK_URL}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OneKhusa-Webhook-Signature': sign(body),
        [header]: 'payrequest.success',
      },
      body,
    });

    assert.equal(res.status, 200, `${header} should be accepted`);
    assert.equal(statusCache.get(`status_${reference}`), 'Paid');
  }
});