const express = require('express');
const path = require('path');
const config = require('./config');
const routes = require('./routes');

const app = express();

app.use('/webhooks', express.raw({ type: '*/*', limit: config.webhookBodyLimit }));

try {
  const { captureWebhook, isCaptureEnabled } = require('../webhook-debug/capture-webhook');

  if (isCaptureEnabled()) {
    app.use('/webhooks', captureWebhook);
    console.log(
      '🔍  Webhook raw-body capture ENABLED (WEBHOOK_CAPTURE_ENABLED) — debug only',
    );
  }
} catch (error) {
  console.warn(`Webhook capture unavailable: ${error.message}`);
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/', routes);

if (!config.webhookSecret) {
  console.warn(
    '⚠️   ONEKHUSA_WEBHOOK_SECRET is not set — webhooks will be rejected until it is.',
  );
}

if (require.main === module) {
  app.listen(config.port, () => {
    console.log('-----------------------------------------------');
    console.log(`🚀  OneTicket Checkout: http://localhost:${config.port}`);
    console.log('📡  Webhook Endpoint:  POST /webhooks/payments (HMAC-SHA512 verified)');
    console.log('-----------------------------------------------');
  });
}

module.exports = app;