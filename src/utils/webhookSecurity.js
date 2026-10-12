/**
 * OneKhusa webhook signature helpers.
 *
 * OneKhusa signs the exact bytes of the webhook request body using
 * HMAC-SHA512 with the merchant webhook secret.
 *
 * The resulting digest is sent as lowercase hexadecimal in:
 *
 * X-OneKhusa-Webhook-Signature
 *
 * Important:
 * 1. Always hash the exact raw request body.
 * 2. Never parse and re-serialize JSON before verification.
 * 3. Compare signatures using a constant-time comparison.
 */

const crypto = require('crypto');

/**
 * OneKhusa webhook HMAC algorithm.
 */
const DIGEST = 'sha512';

class WebhookSecurity {
  /**
   * Compute the HMAC-SHA512 signature for a webhook payload.
   *
   * @param {Buffer|string} payload Exact webhook request body.
   * @param {string} secret Merchant webhook secret.
   * @returns {string} Lowercase hexadecimal HMAC-SHA512 digest.
   */
  static computeSignature(payload, secret) {
    if (!secret) {
      throw new Error('Webhook secret is required.');
    }

    const bytes = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(String(payload), 'utf8');

    return crypto
      .createHmac(DIGEST, secret)
      .update(bytes)
      .digest('hex');
  }

  /**
   * Verify an incoming OneKhusa webhook signature.
   *
   * @param {Buffer|string} payload Exact webhook request body.
   * @param {string} secret Merchant webhook secret.
   * @param {string} headerSignature X-OneKhusa-Webhook-Signature value.
   * @returns {boolean}
   */
  static verifySignature(payload, secret, headerSignature) {
    if (!secret || !headerSignature) {
      return false;
    }

    if (payload === null || payload === undefined) {
      return false;
    }

    const bytes = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(String(payload), 'utf8');

    // Empty webhook bodies contain nothing useful to authenticate.
    if (bytes.length === 0) {
      return false;
    }

    const receivedHex = String(headerSignature)
      .trim()
      .toLowerCase();

    /**
     * SHA-512 produces 64 bytes.
     *
     * When represented as hexadecimal that becomes exactly
     * 128 hexadecimal characters.
     */
    if (!/^[0-9a-f]{128}$/.test(receivedHex)) {
      return false;
    }

    const expectedHex = this.computeSignature(
      bytes,
      secret,
    );

    /**
     * Decode both hexadecimal signatures into their actual
     * 64-byte values before comparing them.
     */
    const expected = Buffer.from(expectedHex, 'hex');
    const received = Buffer.from(receivedHex, 'hex');

    if (expected.length !== received.length) {
      return false;
    }

    return crypto.timingSafeEqual(
      expected,
      received,
    );
  }
}

module.exports = { WebhookSecurity };