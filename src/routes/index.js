const { Router } = require('express');
const config = require('../config');
const verifyWebhookSignature = require('../middleware/verifyWebhookSignature');
const { OneKhusaError, OneKhusaService } = require('../services/onekhusa.service');
const statusCache = require('../utils/statusCache');

const router = Router();
const onekhusa = new OneKhusaService();

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

router.get('/api/Tickets/status/:reference', (req, res) => {
  const status = statusCache.get(`status_${req.params.reference}`, 'NotFound');
  res.json({ status });
});

router.post('/webhooks/payments', verifyWebhookSignature, (req, res) => {
  const { payload, event: headerEvent, signature } = req.webhook;
  console.log(
    `OneKhusa webhook verified (${headerEvent || 'unknown event'}) [${signature.slice(0, 12)}…]:`,
    JSON.stringify(payload),
  );

  const myRef = resolveReference(payload);
  if (!myRef) {
    console.warn('Webhook without resolvable reference:', JSON.stringify(payload));
    return res.status(200).send('acknowledged');
  }

  const event = resolveEvent(payload, headerEvent);
  const newStatus = isSuccess(payload, event) ? 'Paid' : 'Failed';
  statusCache.put(`status_${myRef}`, newStatus, config.statusTtl);
  console.log(`OneKhusa: status updated to ${newStatus.toUpperCase()} for ${myRef}`);

  return res.status(200).send('acknowledged');
});

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

function resolveEvent(payload, headerEvent = '') {
  return String(
    payload.eventType || payload.event || payload.type || payload.eventName ||
      payload.notificationType || headerEvent || '',
  ).toLowerCase();
}

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
