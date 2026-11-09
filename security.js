'use strict';

const crypto = require('crypto');

const ENCRYPTED_PREFIX = 'esenc:v1:';

function parseEncryptionKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;

  let key;
  if (/^[0-9a-f]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
      throw new Error(
        'DATA_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64 or 64 hexadecimal characters.'
      );
    }
    key = Buffer.from(value, 'base64');
  }

  if (key.length !== 32) {
    throw new Error(
      'DATA_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64 or 64 hexadecimal characters.'
    );
  }
  return key;
}

const DATA_ENCRYPTION_KEY = parseEncryptionKey(process.env.DATA_ENCRYPTION_KEY);
const ENCRYPTION_REQUIRED =
  process.env.NODE_ENV === 'production' ||
  String(process.env.PAYMENT_PROVIDER || '').trim().toLowerCase() === 'dpo';

if (ENCRYPTION_REQUIRED && !DATA_ENCRYPTION_KEY) {
  throw new Error(
    'DATA_ENCRYPTION_KEY is required in production and whenever PAYMENT_PROVIDER=dpo.'
  );
}

function protect(value, context) {
  if (value == null || value === '') return value;
  const plain = String(value);
  if (plain.startsWith(ENCRYPTED_PREFIX)) return plain;
  if (!DATA_ENCRYPTION_KEY) return plain;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', DATA_ENCRYPTION_KEY, iv);
  cipher.setAAD(Buffer.from(String(context), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENCRYPTED_PREFIX.slice(0, -1),
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url')
  ].join(':');
}

function unprotect(value, context) {
  if (value == null || value === '') return value;
  const encoded = String(value);
  if (!encoded.startsWith(ENCRYPTED_PREFIX)) return encoded;
  if (!DATA_ENCRYPTION_KEY) {
    throw new Error('Encrypted application data cannot be read without DATA_ENCRYPTION_KEY.');
  }

  const parts = encoded.split(':');
  if (parts.length !== 5 || parts[0] !== 'esenc' || parts[1] !== 'v1') {
    throw new Error('Encrypted application data has an invalid format.');
  }

  try {
    const iv = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    const ciphertext = Buffer.from(parts[4], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error('invalid encrypted value');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', DATA_ENCRYPTION_KEY, iv);
    decipher.setAAD(Buffer.from(String(context), 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Encrypted application data failed authentication.');
  }
}

function blindIndex(value, context) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!DATA_ENCRYPTION_KEY) {
    return crypto.createHash('sha256').update(`${context}:${normalized}`).digest('hex');
  }
  return crypto
    .createHmac('sha256', DATA_ENCRYPTION_KEY)
    .update(`${context}:${normalized}`)
    .digest('hex');
}

function isEncryptionConfigured() {
  return Boolean(DATA_ENCRYPTION_KEY);
}

module.exports = {
  blindIndex,
  isEncryptionConfigured,
  protect,
  unprotect
};
