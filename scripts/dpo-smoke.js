'use strict';

require('dotenv').config();

const crypto = require('crypto');
const { createDpoProvider } = require('../payments');

async function main() {
  if (process.env.DPO_SMOKE_TEST !== 'true') {
    throw new Error('Set DPO_SMOKE_TEST=true to acknowledge creation of a sandbox transaction.');
  }

  const now = Date.now();
  const order = {
    id: crypto.randomUUID(),
    order_number: `ES-UAT-${String(now).slice(-10)}`,
    access_token: crypto.randomBytes(24).toString('hex'),
    buyer: {
      first_name: 'DPO',
      last_name: 'Sandbox Test',
      email: 'payments-test@elevateskills.online',
      phone: '26771000000'
    },
    course: {
      id: 'uat-test',
      name: 'Elevate Skills DPO integration test',
      amount: Number(process.env.DPO_SMOKE_AMOUNT || '1.00'),
      currency: String(process.env.CHECKOUT_CURRENCY || 'BWP').toUpperCase()
    }
  };

  const provider = createDpoProvider();
  const payment = await provider.createPayment(order);
  order.provider_ref = payment.provider_ref;
  const verification = await provider.verifyPayment(order);
  if (verification.paid || !verification.pending) {
    throw new Error('A newly created unpaid sandbox transaction returned an unexpected status.');
  }
  const paymentUrl = new URL(payment.payment_url);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      provider: provider.name,
      company_ref: order.order_number,
      amount: order.course.amount.toFixed(2),
      currency: order.course.currency,
      payment_host: paymentUrl.hostname,
      transaction_token_received: Boolean(payment.provider_ref),
      initial_verification: verification.status,
      initial_provider_code: verification.provider_code
    })}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`DPO sandbox smoke test failed (${err.code || 'ERROR'}): ${err.message}\n`);
  process.exitCode = 1;
});
