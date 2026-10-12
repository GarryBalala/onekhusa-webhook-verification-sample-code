#!/usr/bin/env node
/**
 * Independent OneKhusa webhook HMAC-SHA512 calculator (debug only).
 *
 * This script deliberately does NOT import src/utils/webhookSecurity.js or
 * src/middleware/verifyWebhookSignature.js to produce its result. The digest
 * is computed here, inline, with node:crypto only, so that a bug in the
 * application's verifier cannot be reproduced silently by the tool meant to
 * catch it.
 *
 * The application's verifier IS consulted in a separate, clearly marked
 * section purely to compare verdicts (requirement 7). It never contributes
 * bytes or digests to the independent calculation.
 *
 * The webhook secret is never printed. Only its length, source, and
 * (optionally, behind --fingerprint) a non-reversible SHA-256 tag are shown.
 *
 * Usage:
 *   node webhook-debug/calculate-hmac.js --capture webhook-debug/captures/<id>.json
 *   node webhook-debug/calculate-hmac.js --body body.bin --signature <hex>
 *   node webhook-debug/calculate-hmac.js --ngrok latest
 *   node webhook-debug/calculate-hmac.js --capture <file> --json
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const NGROK_API = process.env.NGROK_API || 'http://127.0.0.1:4040/api/requests/http';

// ---------------------------------------------------------------------------
// Secret resolution — accounts for environment-variable overrides
// ---------------------------------------------------------------------------

/**
 * dotenv does not overwrite variables that are already present in
 * process.env, so a shell-level export silently beats .env. Detect that.
 *
 * @returns {{value: string, name: string, source: string, overridden: boolean, duplicates: number}}
 */
function resolveSecret() {
  const name = 'ONEKHUSA_WEBHOOK_SECRET';

  // Snapshot before dotenv so we can tell pre-existing values apart.
  const hadPreexisting = Object.prototype.hasOwnProperty.call(process.env, name);
  const preexisting = process.env[name] || '';

  require('dotenv').config();

  const afterDotenv = process.env[name] || '';

  const duplicates = countDuplicates();

  let source;
  if (hadPreexisting && preexisting === afterDotenv) {
    source = preexisting
      ? 'process.env (set before this script ran — shell/CI/system override)'
      : 'process.env is empty (flagged in terminal, CI secret, or service env)';
  } else if (afterDotenv) {
    source = 'loaded from .env by dotenv';
  } else {
    source = 'NOT LOADED';
  }

  return {
    name,
    value: afterDotenv,
    source,
    overridden: hadPreexisting && preexisting !== afterDotenv,
    preexisting,
    duplicates,
  };
}

/**
 * Count repeated definitions of the webhook secret across dotenv files.
 *
 * @returns {number}
 */
function countDuplicates() {
  const files = ['.env', '.env.local', '.env.development'];
  let count = 0;

  for (const file of files) {
    const full = path.resolve(process.cwd(), file);
    if (!fs.existsSync(full)) continue;

    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    count += lines.filter((l) => /^\s*ONEKHUSA_WEBHOOK_SECRET\s*=/.test(l)).length;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Independent HMAC calculation — node:crypto only, no application imports
// ---------------------------------------------------------------------------

/**
 * Compute the HMAC-SHA512 of a raw body.
 *
 * @param {Buffer} rawBody Exact received bytes.
 * @param {string} secret Merchant webhook secret.
 * @returns {string} Lowercase hex digest.
 */
function independentHmacSha512(rawBody, secret) {
  if (!Buffer.isBuffer(rawBody)) {
    throw new TypeError('independentHmacSha512 expects a Buffer');
  }
  if (!secret) {
    throw new Error('OneKhusa webhook secret is not available');
  }
  return crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { json: false, fingerprint: false, source: null };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--fingerprint') args.fingerprint = true;
    else if (a === '--capture') args.source = { type: 'capture', ref: argv[(i += 1)] };
    else if (a === '--body') args.source = { type: 'body', ref: argv[(i += 1)] };
    else if (a === '--ngrok') args.source = { type: 'ngrok', ref: argv[(i += 1)] || 'latest' };
    else if (a === '--signature') args.signature = argv[(i += 1)];
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      // Bare positional argument: treat as a capture file.
      if (!args.source && !a.startsWith('-')) args.source = { type: 'capture', ref: a };
    }
  }

  return args;
}

function loadFromCapture(file) {
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record.body || !record.body.base64) {
    throw new Error(`capture ${file} contains no raw body`);
  }
  return {
    rawBody: Buffer.from(record.body.base64, 'base64'),
    received: record.signature ? record.signature.value : '',
    event: record.event ? record.event.value : '',
    origin: `capture file ${path.basename(file)} (capturedAt=${record.capturedAt || 'unknown'})`,
    app: record.app || null,
  };
}

function loadFromBodyFile(file) {
  return {
    rawBody: fs.readFileSync(file),
    received: '',
    event: '',
    origin: `raw body file ${path.basename(file)}`,
    app: null,
  };
}

async function loadFromNgrok(ref) {
  const list = await (await fetch(`${NGROK_API}?limit=100`)).json();
  const hooks = (list.requests || []).filter((r) =>
    (r.request?.uri || '').includes('/webhooks/payments'),
  );

  if (!hooks.length) throw new Error('ngrok has captured no webhook requests');

  const chosen = ref === 'latest' ? hooks[0] : hooks.find((h) => h.id === ref);
  if (!chosen) throw new Error(`ngrok request ${ref} not found`);

  const full = await (await fetch(`${NGROK_API}/${chosen.id}`)).json();
  const raw = Buffer.from(full.request.raw, 'base64');
  const split = raw.indexOf('\r\n\r\n');
  const body = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);

  const headers = {};
  for (const [k, v] of Object.entries(full.request.headers || {})) {
    headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v ?? '');
  }

  return {
    rawBody: body,
    received: (headers['x-onekhusa-webhook-signature'] || '').trim(),
    event: headers['x-onekhusa-webhook-event'] || '',
    origin: `ngrok request ${chosen.id} (start=${full.start}, http=${full.response?.status})`,
    app: null,
  };
}

// ---------------------------------------------------------------------------
// Application comparison (requirement 7) — never used for the calculation
// ---------------------------------------------------------------------------

/**
 * Query the application's own verifier for comparison only.
 *
 * @param {Buffer} rawBody
 * @param {string} received
 * @returns {{result: boolean, error: string|null, exists: boolean}}
 */
function queryApplicationVerifier(rawBody, received) {
  let mod;
  try {
    // Lazy and isolated: loaded only after the independent digest exists.
    mod = require('../src/utils/webhookSecurity');
  } catch (error) {
    return { result: null, exists: false, error: error.message };
  }

  const config = require('../src/config');
  const secret = config.webhookSecret;

  try {
    return {
      exists: true,
      result: Boolean(
        mod.WebhookSecurity.verifySignature(rawBody, secret, received),
      ),
      error: null,
    };
  } catch (error) {
    return { exists: true, result: null, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printReport(report) {
  const line = (k, v) => console.log(`  ${k.padEnd(28)}: ${v}`);

  console.log('');
  console.log('=== OneKhusa independent HMAC-SHA512 report ===');

  console.log('\nInput');
  line('source', report.origin);
  line('event', report.event || '-');

  console.log('\nRaw body');
  line('byte length', report.byteLength);
  line('sha256 fingerprint', report.sha256);
  line('first 16 bytes (hex)', report.headHex);
  line('last 16 bytes (hex)', report.tailHex);
  line('is valid JSON', report.jsonValid ? 'yes' : 'no');

  console.log('\nSecret');
  line('env var', report.secret.name);
  line('loaded', report.secret.value ? 'yes' : 'NO');
  line('length', report.secret.value ? report.secret.value.length : 0);
  line('source', report.secret.source);
  line('override detected', report.secret.overridden ? 'YES' : 'no');
  line('definitions in dotenv files', report.secret.duplicates);
  if (report.secret.fingerprint) line('sha256 tag', report.secret.fingerprint);

  console.log('\nSignature');
  line('received length', report.received ? report.received.length : 0);
  line('received', report.received || '(header absent)');
  line('calculated (independent)', report.calculated);
  line('received is 128 hex', report.receivedFormatOk ? 'yes' : 'no');

  console.log('\nResult');
  line('SIGNATURES MATCH', report.match ? 'YES' : 'NO');
  if (!report.match && report.received) {
    line('first differing byte', report.firstDiff);
  }

  console.log('\nApplication comparison');
  line('app verifier available', report.app.exists ? 'yes' : 'no');
  line('app verifier result', String(report.app.result));
  line('independent result', String(report.match));
  line('verdicts agree', report.verdictsAgree ? 'YES' : 'NO');
  if (report.app.error) line('app verifier error', report.app.error);
  console.log('');
}

function firstDifferingByte(aHex, bHex) {
  for (let i = 0; i < Math.min(aHex.length, bHex.length); i += 2) {
    if (aHex.slice(i, i + 2) !== bHex.slice(i, i + 2)) {
      return `byte ${i / 2} (received ${aHex.slice(i, i + 2)} vs calculated ${bHex.slice(i, i + 2)})`;
    }
  }
  return 'identical';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.source) {
    console.log(`
Usage:
  node webhook-debug/calculate-hmac.js --capture <file.json>
  node webhook-debug/calculate-hmac.js --body <file.bin> --signature <hex>
  node webhook-debug/calculate-hmac.js --ngrok [latest|<requestId>]

Options:
  --json          Machine-readable output
  --fingerprint   Print a SHA-256 tag of the secret (for comparing across
                  sources without revealing it). Off by default.
  --signature     Received signature, when not sourced from a capture/ngrok
`);
    process.exit(args.help ? 0 : 1);
  }

  let input;
  if (args.source.type === 'capture') input = loadFromCapture(args.source.ref);
  else if (args.source.type === 'body') input = loadFromBodyFile(args.source.ref);
  else input = await loadFromNgrok(args.source.ref);

  if (args.signature) input.received = args.signature;

  const secret = resolveSecret();

  const rawBody = input.rawBody;
  const received = (input.received || '').trim();
  const calculated = independentHmacSha512(
    rawBody,
    secret.value,
  );

  const receivedNorm = received.toLowerCase();
  const match = receivedNorm !== '' && calculated === receivedNorm;

  const app = queryApplicationVerifier(rawBody, received);

  const report = {
    origin: input.origin,
    event: input.event,
    byteLength: rawBody.length,
    sha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
    headHex: rawBody.subarray(0, 16).toString('hex'),
    tailHex: rawBody.subarray(Math.max(0, rawBody.length - 16)).toString('hex'),
    jsonValid: isJson(rawBody),
    secret: {
      name: secret.name,
      value: secret.value,
      source: secret.source,
      overridden: secret.overridden,
      duplicates: secret.duplicates,
      fingerprint: args.fingerprint
        ? crypto.createHash('sha256').update(secret.value).digest('hex').slice(0, 8)
        : null,
    },
    received,
    receivedFormatOk: /^[0-9a-f]{128}$/.test(receivedNorm),
    calculated,
    match,
    firstDiff: firstDifferingByte(receivedNorm, calculated),
    app,
    verdictsAgree: app.result === match,
  };

  if (args.json) {
    // Secret value is never included in JSON output.
    const out = { ...report, secret: { ...report.secret, value: undefined } };
    console.log(JSON.stringify(out, null, 2));
  } else {
    printReport(report);
  }

  process.exit(match ? 0 : 2);
}

function isJson(buf) {
  try {
    JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  independentHmacSha512,
  resolveSecret,
  firstDifferingByte,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
}