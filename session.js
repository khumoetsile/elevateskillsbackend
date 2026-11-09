'use strict';

/**
 * Signed httpOnly session cookie for Elevate Skills marketing-site login.
 * Learning content still lives on TalentLMS; we mint fresh autologin URLs on demand.
 */

const crypto = require('crypto');

const COOKIE_NAME = 'es_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_SECRET = (
  process.env.SESSION_SECRET ||
  process.env.ADMIN_API_KEY ||
  'elevate-skills-dev-session-secret'
).trim();

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromB64url(value) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64').toString('utf8');
}

function sign(data) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

function createSessionToken(user) {
  const payload = {
    sub: String(user.id),
    email: String(user.email || '').toLowerCase(),
    login: String(user.login || ''),
    first_name: String(user.first_name || ''),
    last_name: String(user.last_name || ''),
    exp: Date.now() + MAX_AGE_MS
  };
  const data = b64url(JSON.stringify(payload));
  return `${data}.${sign(data)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = sign(data);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(fromB64url(data));
    if (!payload?.exp || Date.now() > Number(payload.exp)) return null;
    if (!payload.sub || !payload.email || !payload.login) return null;
    return {
      id: String(payload.sub),
      email: String(payload.email).toLowerCase(),
      login: String(payload.login),
      first_name: String(payload.first_name || ''),
      last_name: String(payload.last_name || '')
    };
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function cookieOptions({ clear = false } = {}) {
  const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
  const parts = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (secure) parts.push('Secure');
  if (clear) {
    parts[0] = `${COOKIE_NAME}=`;
    parts.push('Max-Age=0');
  } else {
    // placeholder — caller sets value
  }
  return { secure, maxAgeSec: Math.floor(MAX_AGE_MS / 1000) };
}

function setSessionCookie(res, token) {
  const { secure, maxAgeSec } = cookieOptions();
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`
  ];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const { secure } = cookieOptions({ clear: true });
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function getSessionUser(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: String(user.id),
    email: user.email,
    login: user.login,
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    display_name: [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.login
  };
}

module.exports = {
  COOKIE_NAME,
  createSessionToken,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  publicUser
};
