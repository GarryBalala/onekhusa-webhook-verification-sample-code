const config = require('../config');
const { WebhookSecurity } = require('../utils/webhookSecurity');

function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  if (Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  // If Express has already parsed the body into an object/string,
  // we can no longer guarantee the original bytes.
  return null;
}

function stripBom(bodyText) {
  return bodyText.charCodeAt(0) === 0xfeff
    ? bodyText.slice(1)
    : bodyText;
}

function readHeader(req, names) {
  for (const name of names) {
    const value = req.get(name);

    if (value) {
      return value.trim();
    }
  }

  return '';
}

function describeRejection(req, rawBody, reason) {
  const signature = readHeader(
    req,
    config.webhookSignatureHeaders,
  );

  const event = readHeader(
    req,
    config.webhookEventHeaders,
  );

  const parts = [
    `Webhook rejected: ${reason}`,
    `event=${event || '-'}`,
    `signature=${
      signature
        ? `${signature.length} chars`
        : 'HEADER ABSENT'
    }`,
    `content-type=${req.get('content-type') || '-'}`,
    `body=${
      rawBody === null
        ? 'unavailable'
        : `${rawBody.length} bytes`
    }`,
    `user-agent=${(req.get('user-agent') || '-').slice(0, 60)}`,
  ];

  return parts.join(' | ');
}

function verifyWebhookSignature(req, res, next) {
  const secret = config.webhookSecret;

  if (!secret) {
    console.error(
      'Webhook rejected: ONEKHUSA_WEBHOOK_SECRET is not configured. ' +
        'Copy the webhook secret from the OneKhusa portal into your .env file.',
    );

    return res
      .status(500)
      .send('webhook verification unavailable');
  }

  const signature = readHeader(
    req,
    config.webhookSignatureHeaders,
  );

  const event = readHeader(
    req,
    config.webhookEventHeaders,
  );

  const rawBody = readRawBody(req);

  if (rawBody === null) {
    console.warn(
      describeRejection(
        req,
        rawBody,
        'raw body unavailable',
      ),
    );

    return res.status(400).send('invalid payload');
  }

  if (!signature) {
    console.warn(
      describeRejection(
        req,
        rawBody,
        'no signature header present',
      ),
    );

    return res.status(401).send('invalid signature');
  }

  const validSignature = WebhookSecurity.verifySignature(
    rawBody,
    secret,
    signature,
  );

  if (!validSignature) {
    console.warn(
      describeRejection(
        req,
        rawBody,
        'signature MISMATCH - calculated HMAC does not match ' +
          'X-OneKhusa-Webhook-Signature',
      ),
    );

    return res.status(401).send('invalid signature');
  }

  const bodyText = rawBody.toString('utf8');

  let payload;

  try {
    payload = bodyText.length
      ? JSON.parse(stripBom(bodyText))
      : {};
  } catch (error) {
    console.warn(
      `Webhook rejected: signed body is not valid JSON (${error.message}).`,
    );

    return res.status(400).send('invalid payload');
  }

  // -----------------------------------------------------------------------
  // 9. Expose verified webhook information to route
  // -----------------------------------------------------------------------

  req.webhook = {
    rawBody,
    bodyText,
    signature,
    event,
    payload,
  };

  return next();
}

module.exports = verifyWebhookSignature;