/**
 * Webhook raw-body capture (debug only).
 *
 * Records the EXACT bytes received on the webhook endpoint so the HMAC can be
 * recomputed independently of the application's verifier.
 *
 * Design constraints:
 *  - Capture is gated behind WEBHOOK_CAPTURE_ENABLED and is OFF by default.
 *  - The raw body is preserved as a Buffer and serialised as base64. It is
 *    never parsed, re-serialised, or trimmed, so the bytes that were actually
 *    received survive the round-trip byte-for-byte.
 *  - The webhook secret is NEVER written to disk or printed. Only its length
 *    and whether it is set are recorded.
 *  - Capture never alters the request path: verification still runs, failures
 *    still return 401, and unverified payments are never marked successful.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');

/**
 * Capture output directory (gitignored).
 *
 * Overridable via WEBHOOK_CAPTURE_DIR so test runs can be isolated from the
 * directory holding real gateway payloads.
 */
const CAPTURE_DIR = process.env.WEBHOOK_CAPTURE_DIR
  ? path.resolve(process.env.WEBHOOK_CAPTURE_DIR)
  : path.join(__dirname, 'captures');

/** Environment flag that enables capture. Disabled unless explicitly truthy. */
const FLAG = 'WEBHOOK_CAPTURE_ENABLED';

/**
 * Header values that are safe to persist.
 *
 * Authorization/Cookie are deliberately excluded so no credential can leak
 * into a capture file on disk.
 */
const HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'accept',
  'accept-charset',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'user-agent',
  'traceparent',
  'x-onekhusa-webhook-signature',
  'x-onekhusa-webhook-event',
  'onekhusa-webhook-event',
];

const FLAG_VALUES_OFF = new Set(['', '0', 'false', 'off', 'no']);

/**
 * Is capture enabled for this process?
 *
 * @returns {boolean}
 */
function isCaptureEnabled() {
  const raw = (process.env[FLAG] || '').trim().toLowerCase();
  return raw !== '' && !FLAG_VALUES_OFF.has(raw);
}

/**
 * Recover the raw request bytes without re-encoding.
 *
 * @param {import('express').Request} req
 * @returns {Buffer|null}
 */
function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  return null;
}

/**
 * Pick the first present header from a list of candidate names.
 *
 * @param {import('express').Request} req
 * @param {string[]} names
 * @returns {{name: string, value: string}}
 */
function pickHeader(req, names) {
  for (const name of names) {
    const value = req.get(name);
    if (value) return { name, value };
  }
  return { name: null, value: '' };
}

/**
 * Serialise the request metadata and exact body bytes to a capture file.
 *
 * @param {import('express').Request} req
 * @returns {{file: string, id: string, record: object}|null}
 */
function writeCapture(req) {
  const rawBody = readRawBody(req);

  const signature = pickHeader(req, [
    'X-OneKhusa-Webhook-Signature',
    'OneKhusa-Webhook-Signature',
  ]);
  const event = pickHeader(req, [
    'X-Onekhusa-Webhook-Event',
    'OneKhusa-Webhook-Event',
  ]);

  const secret = config.webhookSecret;

  // Independent recomputation, recorded only as a comparison field. The
  // application's own verdict is recorded separately in calculate-hmac.js.
  let appCalculated = null;
  if (secret && rawBody) {
    try {
      appCalculated = crypto
        .createHmac('sha512', secret)
        .update(rawBody)
        .digest('hex');
    } catch {
      appCalculated = null;
    }
  }

  const headers = {};
  for (const name of HEADER_ALLOWLIST) {
    const value = req.get(name);
    if (value !== undefined) headers[name] = value;
  }

  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${
    process.pid
  }`;

  const record = {
    id,
    capturedAt: new Date().toISOString(),
    flag: FLAG,
    enabled: true,
    request: {
      method: req.method,
      originalUrl: req.originalUrl || req.url,
      httpVersion: req.httpVersion || null,
      // Names only for anything outside the allowlist.
      headerNames: Object.keys(req.headers || {}).sort(),
      headers,
    },
    body: rawBody
      ? {
          isBuffer: true,
          byteLength: rawBody.length,
          sha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
          // base64 preserves arbitrary bytes exactly, including a BOM or
          // non-UTF-8 sequences, so decoding restores the original Buffer.
          base64: rawBody.toString('base64'),
        }
      : {
          isBuffer: false,
          byteLength: 0,
          sha256: null,
          base64: null,
          note: 'raw body unavailable — express.raw() did not run first',
        },
    signature: {
      headerName: signature.name,
      value: signature.value,
      length: signature.value.length,
      // Length only. The secret itself is never recorded.
      secretLength: secret ? secret.length : 0,
      secretSet: Boolean(secret),
    },
    event: { headerName: event.name, value: event.value },
    app: {
      calculatedSignature: appCalculated,
      matchesReceived: Boolean(
        appCalculated &&
          signature.value &&
          appCalculated === signature.value.trim().toLowerCase(),
      ),
    },
    notes:
      'rawBody is the exact received Buffer. Secret value intentionally not recorded.',
  };

  fs.mkdirSync(CAPTURE_DIR, { recursive: true });

  const file = path.join(CAPTURE_DIR, `capture-${id}.json`);
  fs.writeFileSync(file, JSON.stringify(record, null, 2), 'utf8');

  return { file, id, record };
}

/**
 * Express middleware: record the raw webhook bytes when the flag is set.
 *
 * Runs after express.raw() and before the handler, so req.body is still the
 * untouched Buffer. When capture is disabled this is a no-op.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function captureWebhook(req, res, next) {
  if (!isCaptureEnabled()) {
    return next();
  }

  try {
    const written = writeCapture(req);
    if (written) {
      req.webhookCaptureFile = written.file;
      console.log(`[webhook-debug] captured -> ${path.relative(process.cwd(), written.file)}`);
    }
  } catch (error) {
    // Capture must never break webhook handling or change the response.
    console.error(`[webhook-debug] capture failed: ${error.message}`);
  }

  return next();
}

module.exports = {
  captureWebhook,
  isCaptureEnabled,
  writeCapture,
  readRawBody,
  CAPTURE_DIR,
  FLAG,
};