'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PaymentProviderError,
  createDpoProvider,
  parseDpoResponse,
  xmlEscape
} = require('../payments');

const COMPANY_TOKEN = '123e4567-e89b-42d3-a456-426614174000';
const TRANSACTION_TOKEN = '72983CAC-5DB1-4C7F-BD88-352066B71592';

function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    SITE_URL: 'https://elevate.test',
    PUBLIC_API_URL: 'https://api.elevate.test/backend',
    DPO_API_URL: 'https://dpo.test/API/v6/',
    DPO_PAYMENT_URL: 'https://dpo.test/payv3.php',
    DPO_ALLOWED_HOSTS: 'dpo.test',
    DPO_COMPANY_TOKEN: COMPANY_TOKEN,
    DPO_SERVICE_TYPE: '54842',
    DPO_RETURN_SECRET: 'test-return-secret-that-is-longer-than-32-bytes',
    DPO_PAYMENT_TTL_MINUTES: '30',
    ...overrides
  };
}

function order(overrides = {}) {
  return {
    id: 'a4447b27-0db7-467f-9db4-5579b62811d7',
    order_number: 'ES-2026-000001',
    access_token: 'access-token-for-test-only',
    provider_ref: TRANSACTION_TOKEN,
    buyer: {
      first_name: 'Kago & Co',
      last_name: 'Molefe <Learner>',
      email: 'kago@example.com',
      phone: '+267 71 234 567'
    },
    course: {
      id: '42',
      name: 'Records & Information Management',
      amount: 499.5,
      currency: 'BWP'
    },
    ...overrides
  };
}

test('createToken uses escaped server-owned order data and a signed return state', async () => {
  let requestBody = '';
  const provider = createDpoProvider({
    env: testEnv(),
    request: async (_url, body) => {
      requestBody = body;
      return {
        data: `<API3G><Result>000</Result><ResultExplanation>Transaction created</ResultExplanation><TransToken>${TRANSACTION_TOKEN}</TransToken><TransRef>R1</TransRef></API3G>`
      };
    }
  });

  const payment = await provider.createPayment(order());
  assert.equal(payment.provider_ref, TRANSACTION_TOKEN);
  assert.equal(payment.payment_url, `https://dpo.test/payv3.php?ID=${TRANSACTION_TOKEN}`);
  assert.match(requestBody, /<PaymentAmount>499\.50<\/PaymentAmount>/);
  assert.match(requestBody, /<PaymentCurrency>BWP<\/PaymentCurrency>/);
  assert.match(requestBody, /Kago &amp; Co/);
  assert.match(requestBody, /Molefe &lt;Learner&gt;/);
  assert.doesNotMatch(requestBody, /access-token-for-test-only/);

  const redirectEncoded = requestBody.match(/<RedirectURL>(.*?)<\/RedirectURL>/s)?.[1] || '';
  const redirect = redirectEncoded.replace(/&amp;/g, '&');
  const returnUrl = new URL(redirect);
  assert.equal(returnUrl.hostname, 'api.elevate.test');
  assert.equal(returnUrl.searchParams.get('order_id'), order().id);
  assert.equal(
    provider.verifyReturnState(order().id, returnUrl.searchParams.get('state')),
    true
  );
  assert.equal(provider.verifyReturnState(order().id, 'tampered'), false);
});

test('custom LMS deployment keeps DPO returns on the website backend', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const config = require('dotenv').parse(
    fs.readFileSync(path.join(__dirname, '../env.cpanel.template'))
  );
  assert.equal(config.TALENTLMS_DOMAIN, 'lms.elevateskills.online');
  assert.equal(config.PUBLIC_LMS_URL, 'https://lms.elevateskills.online');
  let requestBody;
  const provider = createDpoProvider({
    env: { ...testEnv(), ...config, DPO_COMPANY_TOKEN: COMPANY_TOKEN,
      DPO_RETURN_SECRET: 'test-return-secret-that-is-longer-than-32-bytes' },
    request: async (_url, body) => {
      requestBody = body;
      return { data: `<API3G><Result>000</Result><TransToken>${TRANSACTION_TOKEN}</TransToken></API3G>` };
    }
  });
  await provider.createPayment(order());
  for (const tag of ['RedirectURL', 'BackURL']) {
    const raw = requestBody.match(new RegExp(`<${tag}>(.*?)</${tag}>`))[1];
    const url = new URL(raw.replace(/&amp;/g, '&'));
    assert.equal(url.origin, 'https://elevateskills.online');
    assert.equal(url.pathname, '/backend/api/payments/dpo/return');
    assert.equal(provider.verifyReturnState(order().id, url.searchParams.get('state')), true);
  }
});

test('verifyToken accepts only an exact paid amount and currency', async () => {
  const provider = createDpoProvider({
    env: testEnv(),
    request: async (_url, body) => {
      assert.match(body, new RegExp(`<TransactionToken>${TRANSACTION_TOKEN}</TransactionToken>`));
      assert.match(body, /<CompanyRef>ES-2026-000001<\/CompanyRef>/);
      return {
        data: '<API3G><Result>000</Result><ResultExplanation>Transaction Paid</ResultExplanation><TransactionCurrency>BWP</TransactionCurrency><TransactionAmount>499.50</TransactionAmount><FraudAlert>001</FraudAlert><TransactionApproval>APPROVED1</TransactionApproval></API3G>'
      };
    }
  });

  const result = await provider.verifyPayment(order());
  assert.deepEqual(result, {
    verified: true,
    paid: true,
    status: 'paid',
    failure_reason: null,
    provider_code: '000',
    approval: 'APPROVED1'
  });
});

test('verifyToken fails closed on amount or currency mismatch', async () => {
  const provider = createDpoProvider({
    env: testEnv(),
    request: async () => ({
      data: '<API3G><Result>000</Result><TransactionCurrency>BWP</TransactionCurrency><TransactionAmount>10.00</TransactionAmount><FraudAlert>001</FraudAlert></API3G>'
    })
  });

  const result = await provider.verifyPayment(order());
  assert.equal(result.paid, false);
  assert.equal(result.status, 'verification_failed');
  assert.equal(result.failure_reason, 'amount_or_currency_mismatch');
});

test('pending DPO responses never fulfil an order', async () => {
  const provider = createDpoProvider({
    env: testEnv(),
    request: async () => ({
      data: '<API3G><Result>900</Result><ResultExplanation>Transaction not paid yet</ResultExplanation></API3G>'
    })
  });

  const result = await provider.verifyPayment(order());
  assert.equal(result.verified, true);
  assert.equal(result.paid, false);
  assert.equal(result.pending, true);
});

test('DPO response parser is bounded and does not process arbitrary documents', () => {
  assert.equal(
    parseDpoResponse('<API3G><Result>000</Result><ResultExplanation>Paid &amp; verified</ResultExplanation></API3G>').explanation,
    'Paid & verified'
  );
  assert.throws(() => parseDpoResponse('<html>not DPO</html>'), PaymentProviderError);
  assert.equal(xmlEscape('<&>\"\''), '&lt;&amp;&gt;&quot;&apos;');
});

test('DPO configuration rejects non-HTTPS provider URLs', () => {
  assert.throws(
    () => createDpoProvider({ env: testEnv({ DPO_API_URL: 'http://dpo.test/API/v6/' }) }),
    PaymentProviderError
  );
});

test('local frontend is allowed only when DPO returns through public HTTPS', async () => {
  const provider = createDpoProvider({
    env: testEnv({ SITE_URL: 'http://localhost:4200' }),
    request: async () => ({
      data: `<API3G><Result>000</Result><TransToken>${TRANSACTION_TOKEN}</TransToken></API3G>`
    })
  });
  const payment = await provider.createPayment(order());
  assert.equal(payment.provider_ref, TRANSACTION_TOKEN);

  assert.throws(
    () =>
      createDpoProvider({
        env: testEnv({
          SITE_URL: 'http://localhost:4200',
          PUBLIC_API_URL: 'http://localhost:4000'
        })
      }),
    PaymentProviderError
  );
});
