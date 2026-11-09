'use strict';

process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'mock';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

const test = require('node:test');
const assert = require('node:assert/strict');
const { blindIndex, isEncryptionConfigured, protect, unprotect } = require('../security');

test('sensitive values use authenticated AES-256-GCM encryption', () => {
  const encrypted = protect('dpo-transaction-token', 'order:1:provider-reference');
  assert.equal(isEncryptionConfigured(), true);
  assert.match(encrypted, /^esenc:v1:/);
  assert.equal(encrypted.includes('dpo-transaction-token'), false);
  assert.equal(
    unprotect(encrypted, 'order:1:provider-reference'),
    'dpo-transaction-token'
  );
  assert.throws(() => unprotect(encrypted, 'order:2:provider-reference'));
});

test('blind indexes are stable without exposing their input', () => {
  const first = blindIndex('Learner@Example.com', 'order-buyer-email');
  const second = blindIndex('learner@example.com', 'order-buyer-email');
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.equal(first.includes('learner'), false);
});
