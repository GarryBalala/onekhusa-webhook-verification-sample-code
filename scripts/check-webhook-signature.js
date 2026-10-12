/**
 * Diagnose OneKhusa webhook signature verification against live traffic.
 *
 * Pulls requests that ngrok has already captured from its local API, then
 * recomputes the HMAC for each distinct body using ONEKHUSA_WEBHOOK_SECRET.
 * Use it when webhooks are returning 401 to find out whether the configured
 * secret is the one the gateway is actually signing with.
 *
 * Usage:
 *   npm start                      # in one terminal
 *   ngrok http 8080                # in another
 *   npm run check:webhook          # then trigger a payment
 *
 * Override the secret without editing .env:
 *   $env:ONEKHUSA_WEBHOOK_SECRET='candidate'; npm run check:webhook
 *
 * The secret is never printed.
 */

const crypto = require('node:crypto');
require('dotenv').config();

const NGROK_API = process.env.NGROK_API || 'http://127.0.0.1:4040/api/requests/http';
const WEBHOOK_PATH = '/webhooks/payments';

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/**
 * Pull one sample per distinct signature out of ngrok's request buffer.
 *
 * @returns {Promise<Array<{ref: string, sig: string, event: string, body: Buffer, status: number}>>}
 */
async function collectSamples() {
  const list = await getJson(`${NGROK_API}?limit=100`);
  const ids = (list.requests || [])
    .filter((r) => (r.request?.uri || '').includes(WEBHOOK_PATH))
    .map((r) => r.id);

  const samples = [];
  const seen = new Set();

  for (const id of ids) {
    const full = await getJson(`${NGROK_API}/${id}`);

    const headers = {};
    for (const [k, v] of Object.entries(full.request.headers || {})) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : String(v ?? '');
    }
    const signature = (headers['x-onekhusa-webhook-signature'] || '').trim().toLowerCase();
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);

    const raw = Buffer.from(full.request.raw, 'base64');
    const split = raw.indexOf('\r\n\r\n');
    const body = split < 0 ? Buffer.alloc(0) : raw.subarray(split + 4);

    let ref = '(unparseable)';
    try {
      const parsed = JSON.parse(body.toString('utf8'));
      ref = parsed.sourceReferenceNumber || parsed.transactionReferenceNumber || '(no ref)';
    } catch { /* leave as-is */ }

    samples.push({
      ref,
      sig: signature,
      event: headers['x-onekhusa-webhook-event'] || '-',
      body,
      status: full.response?.status ?? 0,
    });
  }

  return samples;
}

(async () => {
  const secret = process.env.ONEKHUSA_WEBHOOK_SECRET || '';

  if (!secret) {
    console.error('ONEKHUSA_WEBHOOK_SECRET is not set - nothing to compare against.');
    process.exit(1);
  }

  let samples;
  try {
    samples = await collectSamples();
  } catch (error) {
    console.error(`Could not read ngrok at ${NGROK_API}`);
    console.error(`  ${error.message}`);
    console.error('Is ngrok running? Try: ngrok http 8080');
    process.exit(1);
  }

  if (!samples.length) {
    console.log(`No ${WEBHOOK_PATH} requests captured by ngrok yet.`);
    console.log('Trigger a payment, then run this again.');
    process.exit(0);
  }

  console.log(`OneKhusa webhook signature check (secret length ${secret.length})\n`);

  let matched = 0;
  for (const s of samples) {
    const computed = crypto.createHmac('sha512', secret).update(s.body).digest('hex');
    const ok = computed === s.sig;
    if (ok) matched++;

    console.log(`${ok ? 'MATCH   ' : 'MISMATCH'} ref=${s.ref}  http=${s.status}`);
    console.log(`         body=${s.body.length} bytes  event=${s.event}`);
    if (!ok) {
      console.log(`         theirs : ${s.sig}`);
      console.log(`         computed: ${computed}`);
    }
  }

  console.log(`\n${matched}/${samples.length} distinct bodies verified.`);
  if (matched === 0) {
    console.log('\nNone matched. The configured secret is not the one OneKhusa signs with.');
    console.log('Check that ONEKHUSA_WEBHOOK_SECRET is the webhook secret for THIS');
    console.log('environment (sandbox vs production) and has not been rotated.');
  }
})();