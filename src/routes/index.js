/**
 * Express route handlers.
 *
 * Mirrors routes/web.php + routes/api.php (Laravel) and app.py (Python).
 *
 *   GET  /                                  — Dashboard (served by Express static)
 *   POST /api/Tickets/buy/:eventId          — Initiate hosted checkout
 *   GET  /api/Tickets/status/:reference     — Poll payment status
 *   POST /webhooks/payments                 — OneKhusa webhook callback
 */

const { Router } = require('express');
const config = require('../config');
const { OneKhusaError, OneKhusaService } = require('../services/onekhusa.service');
const statusCache = require('../utils/statusCache');

const router = Router();
const onekhusa = new OneKhusaService();

// ---------------------------------------------------------------------------
// POST /api/Tickets/buy/:eventId
// ---------------------------------------------------------------------------
router.post('/api/Tickets/buy/:eventId', async (req, res) => {
  const reference = req.body?.reference || `OT-NJ-${Date.now()}`;
  const description = req.body?.description || config.defaultDescription;

  let amount;
  try {
    amount = parseFloat(req.body?.amount ?? config.defaultAmount);
    if (Number.isNaN(amount)) throw new Error('Invalid amount');
  } catch {
    return res.status(400).json({ status: 'error', message: 'Invalid amount.' });
  }

  try {
    const result = await onekhusa.initiateCheckout(amount, reference, description);

    // Persist the pending status so the frontend can poll for the result.
    statusCache.put(`status_${reference}`, 'Pending', config.statusTtl);

    return res.json({
      status: 'success',
      reference,
      paymentTransactionId: result.paymentTransactionId,
      redirectUrl: onekhusa.checkoutRedirectUrl(result.paymentTransactionId),
    });
  } catch (error) {
    const message = error instanceof OneKhusaError ? error.message : String(error);
    console.error('Checkout initiation failed:', message);
    return res.status(500).json({ status: 'error', message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/Tickets/status/:reference
// ---------------------------------------------------------------------------
router.get('/api/Tickets/status/:reference', (req, res) => {
  const status = statusCache.get(`status_${req.params.reference}`, 'NotFound');
  res.json({ status });
});

// ---------------------------------------------------------------------------
// POST /webhooks/payments
// ---------------------------------------------------------------------------
router.post('/webhooks/payments', (req, res) => {
  const payload = req.body || {};
  console.log('OneKhusa webhook received:', JSON.stringify(payload));

  const myRef = resolveReference(payload);
  if (!myRef) {
    console.warn('Webhook without resolvable reference:', JSON.stringify(payload));
    return res.status(200).send('acknowledged');
  }

  const event = resolveEvent(payload);
  const newStatus = isSuccess(payload, event) ? 'Paid' : 'Failed';
  statusCache.put(`status_${myRef}`, newStatus, config.statusTtl);
  console.log(`OneKhusa: status updated to ${newStatus.toUpperCase()} for ${myRef}`);

  return res.status(200).send('acknowledged');
});

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

/**
 * Resolve our reference number from a webhook payload.
 * OneKhusa may nest it in `metaData` with TitleCase keys, or expose it at
 * the top level.
 *
 * @param {object} payload
 * @returns {string|null}
 */
function resolveReference(payload) {
  const metaData = payload.metaData || {};
  return (
    metaData.ReferenceNumber ||
    metaData.referenceNumber ||
    payload.sourceReferenceNumber ||
    payload.referenceNumber ||
    payload.payment?.sourceReferenceNumber ||
    null
  );
}

/**
 * Resolve the webhook event name from common payload fields.
 *
 * @param {object} payload
 * @returns {string}
 */
function resolveEvent(payload) {
  return String(
    payload.eventType || payload.event || payload.type || payload.eventName ||
      payload.notificationType || '',
  ).toLowerCase();
}

/**
 * Detect a successful payment payload (payrequest.success).
 *
 * @param {object} payload
 * @param {string} event
 * @returns {boolean}
 */
function isSuccess(payload, event = '') {
  const responseCode = String(payload.responseCode || '');
  const statusCode = String(payload.transactionStatusCode || '').toUpperCase();
  return (
    event.includes('success') ||
    responseCode === 'S100' ||
    statusCode === 'S' ||
    responseCode.startsWith('S')
  );
}

module.exports = router;
