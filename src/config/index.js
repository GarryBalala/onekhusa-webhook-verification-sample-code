/**
 * Centralized OneKhusa configuration.
 *
 * Mirrors config/onekhusa.php (Laravel) and config.py (Python):
 * all credentials and endpoints are resolved from environment variables.
 * No hardcoded values in application code.
 */

require('dotenv').config();

const config = {
  /** Merchant credentials */
  apiKey: process.env.ONEKHUSA_API_KEY || '',
  apiSecret: process.env.ONEKHUSA_API_SECRET || '',
  organisationId: process.env.ONEKHUSA_ORG_ID || '',
  merchantAccountNumber: parseInt(process.env.ONEKHUSA_MERCHANT_NUMBER, 10) || 0,

  /** Public callback URL (e.g. ngrok tunnel) */
  publicCallbackUrl: process.env.PUBLIC_CALLBACK_URL || '',

  /** API endpoints */
  endpoints: {
    getAccessToken:
      process.env.ONEKHUSA_TOKEN_URL ||
      'https://api.onekhusa.com/sandbox/v1/account/getAccessToken',
    checkoutInitiate:
      process.env.ONEKHUSA_CHECKOUT_URL ||
      'https://api.onekhusa.com/sandbox/v1/checkout/rtp/initiate',
    checkoutRedirect:
      process.env.ONEKHUSA_CHECKOUT_REDIRECT_URL ||
      'https://checkout.onekhusa.com/requestToPay/initiate',
  },

  /** Server port */
  port: parseInt(process.env.PORT, 10) || 3000,

  /** Defaults for the demo */
  defaultAmount: 2500,
  defaultDescription: 'OneTicket Node.js Purchase',
  statusTtl: 1800, // seconds
};

module.exports = config;
