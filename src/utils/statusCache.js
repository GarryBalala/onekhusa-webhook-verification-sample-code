/**
 * A tiny TTL-backed status cache.
 *
 * Mirrors status_cache.py (Python) and Laravel's Cache::put() — keeps the
 * demo dependency-free while matching the "cache-backed status polling" design.
 * A Map with expiry timestamps is sufficient for a single-process demo.
 */

class StatusCache {
  constructor() {
    /** @type {Map<string, string>} */
    this._store = new Map();
    /** @type {Map<string, number>} */
    this._expires = new Map();
  }

  /**
   * Store a value with a TTL (in seconds).
   * @param {string} key
   * @param {string} value
   * @param {number} ttl - Time-to-live in seconds (default 1800).
   */
  put(key, value, ttl = 1800) {
    this._store.set(key, value);
    this._expires.set(key, Date.now() + ttl * 1000);
  }

  /**
   * Retrieve a value, returning `defaultValue` if expired or missing.
   * @param {string} key
   * @param {string} [defaultValue=null]
   * @returns {string|null}
   */
  get(key, defaultValue = null) {
    const expiresAt = this._expires.get(key);
    if (expiresAt === undefined || Date.now() > expiresAt) {
      this._store.delete(key);
      this._expires.delete(key);
      return defaultValue;
    }
    return this._store.get(key) ?? defaultValue;
  }
}

// Shared instance used by routes and webhooks.
module.exports = new StatusCache();
