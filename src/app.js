/**
 * OneKhusa Hosted Checkout — Express entry point.
 *
 * Mirrors the Laravel and Python projects:
 *   routes/web.php   -> GET  "/"  (dashboard — served by Express static)
 *   routes/api.php   -> POST /api/Tickets/buy/:eventId  (initiate)
 *                     -> GET  /api/Tickets/status/:ref   (poll)
 *   WebhookController -> POST /webhooks/payments  (webhook)
 */

const express = require('express');
const path = require('path');
const config = require('./config');
const routes = require('./routes');

const app = express();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.use('/', routes);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(config.port, () => {
  console.log('-----------------------------------------------');
  console.log(`🚀  OneTicket Checkout: http://localhost:${config.port}`);
  console.log(`📡  Webhook Endpoint:  POST /webhooks/payments`);
  console.log('-----------------------------------------------');
});