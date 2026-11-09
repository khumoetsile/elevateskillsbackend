'use strict';

/**
 * Payment-provider adapters.
 *
 * Card data never touches this application. DPO receives it on its hosted
 * payment page, while this server creates and verifies transaction tokens.
 */

const axios = require('axios');
const crypto = require('crypto');

const DPO_DEFAULT_API_URL = 'https://secure.3gdirectpay.com/API/v6/';
const DPO_DEFAULT_PAYMENT_URL = 'https://secure.3gdirectpay.com/payv3.php';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DPO_TOKEN_RE = /^[A-Za-z0-9-]{10,128}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;

class PaymentProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PaymentProviderError';
    this.code = code;
  }
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(parseInt(digits, 10)))
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function xmlValue(xml, tag) {
  const escapedTag = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml).match(
    new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'i')
  );
  return match ? decodeXml(match[1].trim()) : '';
}

function parseDpoResponse(xml) {
  const source = String(xml || '');
  if (!source || source.length > 256 * 1024 || !/<API3G(?:\s[^>]*)?>/i.test(source)) {
    throw new PaymentProviderError('DPO_INVALID_RESPONSE', 'DPO returned an invalid response.');
  }

  return {
    result: xmlValue(source, 'Result') || xmlValue(source, 'Code'),
    explanation: xmlValue(source, 'ResultExplanation') || xmlValue(source, 'Explanation'),
    transaction_token: xmlValue(source, 'TransToken'),
    transaction_reference:
      xmlValue(source, 'TransRef') || xmlValue(source, 'TransactionRef'),
    transaction_amount: xmlValue(source, 'TransactionAmount'),
    transaction_currency: xmlValue(source, 'TransactionCurrency').toUpperCase(),
    final_amount: xmlValue(source, 'TransactionFinalAmount'),
    final_currency: xmlValue(source, 'TransactionFinalCurrency').toUpperCase(),
    approval: xmlValue(source, 'TransactionApproval') || xmlValue(source, 'ApprovalNumber'),
    fraud_alert: xmlValue(source, 'FraudAlert') || xmlValue(source, 'TransactionFraudAlert')
  };
}

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function formatDpoDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    '/',
    pad(date.getUTCMonth() + 1),
    '/',
    pad(date.getUTCDate()),
    ' ',
    pad(date.getUTCHours()),
    ':',
    pad(date.getUTCMinutes())
  ].join('');
}

function normalizeMoney(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PaymentProviderError('DPO_INVALID_AMOUNT', 'The payment amount is invalid.');
  }
  return amount.toFixed(2);
}

function validatePublicUrl(raw, name, { production, allowLocalHttp = false } = {}) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    throw new PaymentProviderError('DPO_CONFIG_ERROR', `${name} must be a valid absolute URL.`);
  }

  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.hash) {
    throw new PaymentProviderError('DPO_CONFIG_ERROR', `${name} contains unsupported URL parts.`);
  }
  if (parsed.protocol !== 'https:' && (production || !allowLocalHttp || !local)) {
    throw new PaymentProviderError('DPO_CONFIG_ERROR', `${name} must use HTTPS.`);
  }
  return parsed;
}

function getDpoConfig(env) {
  const production = env.NODE_ENV === 'production';
  const companyToken = String(env.DPO_COMPANY_TOKEN || '').trim();
  const serviceType = String(env.DPO_SERVICE_TYPE || '').trim();
  const returnSecret = String(env.DPO_RETURN_SECRET || '').trim();
  const basePath = String(env.BASE_PATH || '').trim().replace(/\/$/, '');
  const siteUrlRaw = String(env.SITE_URL || '').trim();
  const publicApiUrlRaw =
    String(env.PUBLIC_API_URL || '').trim() || `${siteUrlRaw.replace(/\/$/, '')}${basePath}`;

  if (!UUID_RE.test(companyToken)) {
    throw new PaymentProviderError('DPO_CONFIG_ERROR', 'DPO_COMPANY_TOKEN is not configured.');
  }
  if (!/^\d{1,10}$/.test(serviceType)) {
    throw new PaymentProviderError('DPO_CONFIG_ERROR', 'DPO_SERVICE_TYPE is not configured.');
  }
  if (Buffer.byteLength(returnSecret, 'utf8') < 32) {
    throw new PaymentProviderError(
      'DPO_CONFIG_ERROR',
      'DPO_RETURN_SECRET must contain at least 32 bytes of random data.'
    );
  }

  // During local development the final browser destination may be localhost,
  // but DPO itself rejects localhost return URLs. PUBLIC_API_URL must therefore
  // always be a public HTTPS URL (typically a temporary development tunnel).
  const siteUrl = validatePublicUrl(siteUrlRaw, 'SITE_URL', {
    production,
    allowLocalHttp: !production
  });
  const publicApiUrl = validatePublicUrl(publicApiUrlRaw, 'PUBLIC_API_URL', {
    production: true
  });
  const apiUrl = validatePublicUrl(
    env.DPO_API_URL || DPO_DEFAULT_API_URL,
    'DPO_API_URL',
    { production: true }
  );
  const paymentUrl = validatePublicUrl(
    env.DPO_PAYMENT_URL || DPO_DEFAULT_PAYMENT_URL,
    'DPO_PAYMENT_URL',
    { production: true }
  );

  const allowedHosts = new Set(
    String(env.DPO_ALLOWED_HOSTS || 'secure.3gdirectpay.com')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );
  if (
    !allowedHosts.has(apiUrl.hostname.toLowerCase()) ||
    !allowedHosts.has(paymentUrl.hostname.toLowerCase())
  ) {
    throw new PaymentProviderError('DPO_CONFIG_ERROR', 'A DPO URL uses an unapproved host.');
  }

  const ttl = Math.min(Math.max(parseInt(env.DPO_PAYMENT_TTL_MINUTES, 10) || 30, 5), 1440);
  const timeout = Math.min(Math.max(parseInt(env.DPO_TIMEOUT_MS, 10) || 15000, 3000), 30000);
  const defaultPayment = String(env.DPO_DEFAULT_PAYMENT || 'CC').trim().toUpperCase();
  if (!['CC', 'MO', 'BT'].includes(defaultPayment)) {
    throw new PaymentProviderError('DPO_CONFIG_ERROR', 'DPO_DEFAULT_PAYMENT is invalid.');
  }

  return {
    apiUrl: apiUrl.href,
    companyToken,
    defaultPayment,
    paymentUrl,
    publicApiUrl: publicApiUrl.href.replace(/\/$/, ''),
    returnSecret,
    serviceType,
    siteUrl: siteUrl.href.replace(/\/$/, ''),
    timeout,
    ttl
  };
}

function createReturnState(orderId, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(`dpo-return:v1:${String(orderId)}`)
    .digest('base64url');
}

function verifyReturnState(orderId, state, secret) {
  if (!orderId || !state) return false;
  const expected = Buffer.from(createReturnState(orderId, secret));
  const actual = Buffer.from(String(state));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function buildReturnUrl(config, orderId, source) {
  const url = new URL(`${config.publicApiUrl}/api/payments/dpo/return`);
  url.searchParams.set('order_id', String(orderId));
  url.searchParams.set('state', createReturnState(orderId, config.returnSecret));
  url.searchParams.set('source', source);
  return url.href;
}

function buildResultUrl(config, order) {
  const url = new URL(
    `${config.siteUrl}/checkout/result/${encodeURIComponent(String(order.id))}`
  );
  url.hash = new URLSearchParams({ token: String(order.access_token) }).toString();
  return url.href;
}

function buildCreateTokenXml(config, order) {
  const currency = String(order.course.currency || '').trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) {
    throw new PaymentProviderError('DPO_INVALID_CURRENCY', 'The payment currency is invalid.');
  }

  const phone = String(order.buyer.phone || '').replace(/\D/g, '').slice(0, 20);
  const customerPhone = phone ? `\n      <customerPhone>${xmlEscape(phone)}</customerPhone>` : '';
  const serviceDescription = cleanText(order.course.name || 'Online course enrolment', 200);

  return `<?xml version="1.0" encoding="utf-8"?>
<API3G>
  <CompanyToken>${xmlEscape(config.companyToken)}</CompanyToken>
  <Request>createToken</Request>
  <Transaction>
    <PaymentAmount>${normalizeMoney(order.course.amount)}</PaymentAmount>
    <PaymentCurrency>${xmlEscape(currency)}</PaymentCurrency>
    <CompanyRef>${xmlEscape(order.order_number)}</CompanyRef>
    <RedirectURL>${xmlEscape(buildReturnUrl(config, order.id, 'redirect'))}</RedirectURL>
    <BackURL>${xmlEscape(buildReturnUrl(config, order.id, 'back'))}</BackURL>
    <CompanyRefUnique>1</CompanyRefUnique>
    <PTL>${config.ttl}</PTL>
    <PTLtype>minutes</PTLtype>
    <customerFirstName>${xmlEscape(cleanText(order.buyer.first_name, 100))}</customerFirstName>
    <customerLastName>${xmlEscape(cleanText(order.buyer.last_name, 100))}</customerLastName>
    <customerEmail>${xmlEscape(cleanText(order.buyer.email, 254))}</customerEmail>${customerPhone}
    <customerCountry>BW</customerCountry>
    <DefaultPayment>${config.defaultPayment}</DefaultPayment>
    <TransactionSource>Website</TransactionSource>
  </Transaction>
  <Services>
    <Service>
      <ServiceType>${xmlEscape(config.serviceType)}</ServiceType>
      <ServiceDescription>${xmlEscape(serviceDescription)}</ServiceDescription>
      <ServiceDate>${formatDpoDate()}</ServiceDate>
    </Service>
  </Services>
</API3G>`;
}

function buildVerifyTokenXml(config, order) {
  if (!DPO_TOKEN_RE.test(String(order.provider_ref || ''))) {
    throw new PaymentProviderError('DPO_MISSING_REFERENCE', 'The DPO transaction reference is missing.');
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<API3G>
  <Request>verifyToken</Request>
  <CompanyToken>${xmlEscape(config.companyToken)}</CompanyToken>
  <TransactionToken>${xmlEscape(order.provider_ref)}</TransactionToken>
  <CompanyRef>${xmlEscape(order.order_number)}</CompanyRef>
  <VerifyTransaction>1</VerifyTransaction>
</API3G>`;
}

async function postXml(config, xml, request) {
  try {
    const response = await request(config.apiUrl, xml, {
      headers: {
        Accept: 'application/xml',
        'Content-Type': 'application/xml; charset=utf-8'
      },
      maxBodyLength: 64 * 1024,
      maxContentLength: 256 * 1024,
      maxRedirects: 0,
      responseType: 'text',
      timeout: config.timeout,
      transformResponse: [(value) => value],
      validateStatus: (status) => status >= 200 && status < 300
    });
    return parseDpoResponse(response.data);
  } catch (err) {
    if (err instanceof PaymentProviderError) throw err;
    if (err?.response?.status) {
      throw new PaymentProviderError(
        'DPO_HTTP_ERROR',
        `DPO returned HTTP ${Number(err.response.status)}.`
      );
    }
    throw new PaymentProviderError(
      'DPO_UNAVAILABLE',
      'The secure payment provider is temporarily unavailable.'
    );
  }
}

function amountMatches(expected, received) {
  const expectedMinor = Math.round(Number(expected) * 100);
  const receivedMinor = Math.round(Number(received) * 100);
  return (
    Number.isFinite(expectedMinor) &&
    Number.isFinite(receivedMinor) &&
    expectedMinor === receivedMinor
  );
}

function createDpoProvider({ env = process.env, request = axios.post.bind(axios) } = {}) {
  const config = getDpoConfig(env);

  return {
    name: 'dpo',

    async createPayment(order) {
      const response = await postXml(config, buildCreateTokenXml(config, order), request);
      if (response.result !== '000' || !DPO_TOKEN_RE.test(response.transaction_token)) {
        throw new PaymentProviderError(
          'DPO_CREATE_REJECTED',
          `DPO could not create the payment session (code ${response.result || 'unknown'}).`
        );
      }

      const paymentUrl = new URL(config.paymentUrl);
      paymentUrl.searchParams.set('ID', response.transaction_token);
      return {
        provider_ref: response.transaction_token,
        payment_url: paymentUrl.href
      };
    },

    async verifyPayment(order) {
      const response = await postXml(config, buildVerifyTokenXml(config, order), request);
      const code = response.result;
      if (!/^\d{3,4}$/.test(code)) {
        throw new PaymentProviderError('DPO_INVALID_RESPONSE', 'DPO returned no result code.');
      }

      if (code === '000') {
        const receivedAmount = response.transaction_amount || response.final_amount;
        const receivedCurrency = response.transaction_currency || response.final_currency;
        if (
          !amountMatches(order.course.amount, receivedAmount) ||
          String(order.course.currency).toUpperCase() !== receivedCurrency
        ) {
          return {
            verified: true,
            paid: false,
            status: 'verification_failed',
            failure_reason: 'amount_or_currency_mismatch',
            provider_code: code
          };
        }

        if (['002', '004', '006'].includes(response.fraud_alert)) {
          return {
            verified: true,
            paid: false,
            status: 'verification_failed',
            failure_reason: `fraud_alert_${response.fraud_alert}`,
            provider_code: code
          };
        }

        return {
          verified: true,
          paid: true,
          status: 'paid',
          failure_reason: null,
          provider_code: code,
          approval: cleanText(response.approval, 64)
        };
      }

      if (['001', '003', '005', '007', '900'].includes(code)) {
        return {
          verified: true,
          paid: false,
          pending: true,
          status: 'pending',
          failure_reason: null,
          provider_code: code
        };
      }

      const failures = {
        '002': 'amount_mismatch',
        '901': 'declined',
        '903': 'expired',
        '904': 'cancelled'
      };
      if (failures[code]) {
        return {
          verified: true,
          paid: false,
          status: code === '904' ? 'cancelled' : 'failed',
          failure_reason: failures[code],
          provider_code: code
        };
      }

      throw new PaymentProviderError(
        'DPO_VERIFICATION_REJECTED',
        `DPO could not verify the payment (code ${code}).`
      );
    },

    verifyReturnState(orderId, state) {
      return verifyReturnState(orderId, state, config.returnSecret);
    },

    resultUrl(order) {
      return buildResultUrl(config, order);
    }
  };
}

const mockProvider = {
  name: 'mock',

  createPayment(order) {
    return {
      provider_ref: `MOCK-${crypto.randomBytes(6).toString('hex').toUpperCase()}`,
      payment_url: `/pay/${order.id}?token=${order.access_token}`
    };
  },

  verifyPayment(order, payload) {
    if (!payload || payload.token !== order.access_token) {
      return { verified: false, paid: false, failure_reason: 'invalid_token' };
    }
    if (payload.outcome === 'success') {
      return { verified: true, paid: true, status: 'paid', failure_reason: null };
    }
    return {
      verified: true,
      paid: false,
      status: 'failed',
      failure_reason: 'declined_by_user'
    };
  }
};

function getProvider(providerName) {
  const name = String(providerName || process.env.PAYMENT_PROVIDER || 'mock')
    .trim()
    .toLowerCase();
  if (name === 'mock') return mockProvider;
  if (name === 'dpo') return createDpoProvider();
  throw new Error(`Unknown PAYMENT_PROVIDER "${name}". Available: mock, dpo`);
}

module.exports = {
  PaymentProviderError,
  buildCreateTokenXml,
  buildVerifyTokenXml,
  createDpoProvider,
  getProvider,
  parseDpoResponse,
  verifyReturnState,
  xmlEscape
};
