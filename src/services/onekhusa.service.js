/**
 * Thin wrapper around the OneKhusa Payment Gateway API.
 *
 * Mirrors app/Services/OneKhusaService.php (Laravel) and
 * services/onekhusa_service.py (Python).
 *
 * Supports the Hosted Checkout flow:
 *  - Obtain a short-lived access token (JWT) via /account/getAccessToken
 *  - Initiate a payment (/checkout/rtp/initiate), which returns a
 *    paymentTransactionId used to redirect the customer to the managed
 *    checkout page.
 */

const axios = require('axios');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
const config = require('../config');

/** Access tokens live for 5 minutes; cache them for 4 to stay safe. */
const TOKEN_CACHE_TTL_MS = 240 * 1000;

class OneKhusaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OneKhusaError';
  }
}

class OneKhusaService {
  constructor() {
    /** @type {string|null} */
    this._token = null;
    /** @type {number} */
    this._tokenExpiresAt = 0;
  }

  // ------------------------------------------------------------------
  // Access token
  // ------------------------------------------------------------------

  /**
   * Return a valid access token (JWT) used as `Authorization: Bearer`.
   * Caches the token for 4 minutes to avoid unnecessary requests.
   */
  async getAccessToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpiresAt) {
      return this._token;
    }

    if (!config.apiKey || !config.apiSecret || !config.organisationId || !config.merchantAccountNumber) {
      throw new OneKhusaError(
        'OneKhusa API configuration is incomplete. Set ONEKHUSA_API_KEY, ONEKHUSA_API_SECRET, ONEKHUSA_ORG_ID, and ONEKHUSA_MERCHANT_NUMBER.',
      );
    }

    try {
      const response = await axios.post(
        config.endpoints.getAccessToken,
        {
          apiKey: config.apiKey,
          apiSecret: config.apiSecret,
          organisationId: config.organisationId,
          merchantAccountNumber: config.merchantAccountNumber,
        },
        { headers: { 'Accept-Language': 'en' }, timeout: 30_000 },
      );

      this._throwIfFailed(response, 'token');

      const token = response.data?.accessToken;
      if (!token) {
        throw new OneKhusaError('OneKhusa token error: no accessToken returned.');
      }

      this._token = token;
      this._tokenExpiresAt = now + TOKEN_CACHE_TTL_MS;
      return token;
    } catch (error) {
      if (error instanceof OneKhusaError) {
        throw error;
      }

      throw new OneKhusaError(`OneKhusa token error: ${error.message}`);
    }
  }

  // ------------------------------------------------------------------
  // Hosted checkout
  // ------------------------------------------------------------------

  /**
   * Initiate a hosted checkout payment.
   *
   * POST /checkout/rtp/initiate
   * Returns the initiation response containing `paymentTransactionId`,
   * used to redirect the customer to the hosted checkout page.
   *
   * @param {number} amount
   * @param {string} reference
   * @param {string} [description]
   * @returns {Promise<object>}
   */
  async initiateCheckout(amount, reference, description) {
    const callbackBase = config.publicCallbackUrl;

    const payload = {
      authentication: this._authentication(),
      merchant: this._merchant(),
      payment: {
        sourceReferenceNumber: reference,
        description: description || config.defaultDescription,
        amount,
      },
      route: {
        successRedirectionUrl: `${callbackBase}/success.html?ref=${reference}`,
        failureRedirectionUrl: `${callbackBase}/error.html?ref=${reference}`,
        callbackApiUrl: `${callbackBase}/webhooks/payments`,
      },
    };

    return this._post(config.endpoints.checkoutInitiate, payload, 'checkout');
  }

  /**
   * Build the redirect URL for a given payment transaction.
   *
   * @param {string} paymentTransactionId
   * @returns {string}
   */
  checkoutRedirectUrl(paymentTransactionId) {
    const params = new URLSearchParams({ ptid: paymentTransactionId });
    return `${config.endpoints.checkoutRedirect}?${params.toString()}`;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** @returns {{ apiKey: string, apiSecret: string }} */
  _authentication() {
    return { apiKey: config.apiKey, apiSecret: config.apiSecret };
  }

  /** @returns {{ organisationId: string, merchantAccountNumber: number }} */
  _merchant() {
    return {
      organisationId: config.organisationId,
      merchantAccountNumber: config.merchantAccountNumber,
    };
  }

  /**
   * Send an authenticated POST request and return the decoded JSON payload.
   *
   * @param {string} url
   * @param {object} payload
   * @param {string} context - Label for idempotency key and error messages.
   * @returns {Promise<object>}
   */
  async _post(url, payload, context) {
    const token = await this.getAccessToken();
    const idempotencyKey = `NODE-${context}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      const response = await axios.post(url, payload, {
        headers: {
          Authorization: 'Bearer ' + token,
          'Accept-Language': 'en',
          'Content-Type': 'application/json',
          'X-Idempotency-Key': idempotencyKey,
        },
        timeout: 30_000,
      });

      this._throwIfFailed(response, context);

      return response.data || {};
    } catch (error) {
      if (error instanceof OneKhusaError) {
        throw error;
      }

      if (error.response) {
        throw new OneKhusaError(
          `OneKhusa ${context} error: ${JSON.stringify(error.response.data)}`,
        );
      }

      throw new OneKhusaError(`OneKhusa ${context} error: ${error.message}`);
    }
  }

  /**
   * Throw a descriptive error when an API request returns a non-2xx status.
   *
   * @param {import('axios').AxiosResponse} response
   * @param {string} context
   */
  _throwIfFailed(response, context) {
    if (response.status < 200 || response.status >= 300) {
      throw new OneKhusaError(
        `OneKhusa ${context} error (${response.status}): ${JSON.stringify(response.data)}`,
      );
    }
  }
}

module.exports = { OneKhusaService, OneKhusaError };
