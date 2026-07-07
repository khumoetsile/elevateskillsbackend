'use strict';

/**
 * Payment provider adapter.
 *
 * The checkout routes only talk to the interface returned by getProvider(),
 * so switching from the mock gateway to real DPO Pay means adding a
 * DpoPaymentProvider with the same three methods and setting
 * PAYMENT_PROVIDER=dpo.
 *
 * Interface:
 *   name                          - provider id stored on the order
 *   createPayment(order)          - returns { provider_ref, payment_url }
 *   verifyPayment(order, payload) - returns { verified, paid, failure_reason }
 */

const crypto = require('crypto');

/**
 * Simulates a hosted-checkout gateway (like DPO's payment page).
 * createPayment points the buyer at the Angular /pay/:orderId page.
 * verifyPayment trusts the simulated outcome only when the caller holds the
 * order's access token — standing in for DPO's webhook signature check.
 */
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
      return { verified: true, paid: true, failure_reason: null };
    }
    return { verified: true, paid: false, failure_reason: 'declined_by_user' };
  }
};

const providers = { mock: mockProvider };

function getProvider() {
  const name = (process.env.PAYMENT_PROVIDER || 'mock').trim().toLowerCase();
  const provider = providers[name];
  if (!provider) {
    throw new Error(`Unknown PAYMENT_PROVIDER "${name}". Available: ${Object.keys(providers).join(', ')}`);
  }
  return provider;
}

module.exports = { getProvider };
