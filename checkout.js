'use strict';

/**
 * Checkout, payment, and order routes.
 *
 * Flow: create order (price fetched server-side from TalentLMS, never trusted
 * from the client) -> buyer pays via provider (mock gateway page for now) ->
 * provider confirmation verified -> TalentLMS fulfilment -> emails.
 */

const express = require('express');
const axios = require('axios');
const visibility = require('./course-visibility');
const crypto = require('crypto');
const store = require('./store');
const { getProvider } = require('./payments');
const { fulfilOrder, findUserByEmail, getUserCourseEnrolment } = require('./fulfilment');
const { sendPurchaseEmails } = require('./mail');

const TALENTLMS_DOMAIN = (process.env.TALENTLMS_DOMAIN || '').trim();
const TALENTLMS_API_KEY = (process.env.TALENTLMS_API_KEY || '').trim();
const CHECKOUT_CURRENCY = (process.env.CHECKOUT_CURRENCY || 'BWP').trim();
const ADMIN_API_KEY = (process.env.ADMIN_API_KEY || '').trim();
// Dev/demo only: lets checkout proceed with catalog-provided course details
// when the TalentLMS API is unreachable (e.g. API disabled on the portal).
// NEVER enable in production once real payments are live.
const ALLOW_UNVERIFIED_COURSES = process.env.ALLOW_UNVERIFIED_COURSES === 'true';
const PUBLIC_LMS_URL =
  (process.env.PUBLIC_LMS_URL || '').trim() ||
  (TALENTLMS_DOMAIN ? `https://${TALENTLMS_DOMAIN}` : '');

const lms = axios.create({
  baseURL: TALENTLMS_DOMAIN ? `https://${TALENTLMS_DOMAIN}/api/v1` : undefined,
  timeout: 15000,
  auth: { username: TALENTLMS_API_KEY, password: '' },
  headers: { Accept: 'application/json' }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PAID_STATES = new Set(['paid', 'enrolling', 'completed', 'enrolment_failed']);

function safeTokenEqual(actual, expected) {
  if (!actual || !expected) return false;
  const a = Buffer.from(String(actual));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createRateLimiter({ limit, windowMs }) {
  const clients = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const current = clients.get(key);
    const entry = !current || now >= current.resetAt
      ? { count: 0, resetAt: now + windowMs }
      : current;
    entry.count += 1;
    clients.set(key, entry);

    if (clients.size > 5000) {
      for (const [client, value] of clients) {
        if (now >= value.resetAt) clients.delete(client);
      }
    }

    if (entry.count > limit) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({
        ok: false,
        message: 'Too many payment requests. Please wait a moment and try again.'
      });
    }
    return next();
  };
}

const checkoutCreateLimiter = createRateLimiter({ limit: 20, windowMs: 10 * 60 * 1000 });
const paymentVerifyLimiter = createRateLimiter({ limit: 60, windowMs: 10 * 60 * 1000 });

function decodeEntities(value) {
  let out = String(value || '');
  // Twice so double-encoded values like `&amp;#36;` become `$`.
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
        String.fromCharCode(parseInt(hex, 16))
      )
      .replace(/&dollar;/gi, '$')
      .replace(/&nbsp;/g, ' ');
  }
  return out;
}

function parseAmount(rawPrice) {
  // TalentLMS returns HTML-encoded prices like "&#36;14.68" — decode before
  // extracting digits, otherwise the entity's digits corrupt the amount.
  const numeric = decodeEntities(rawPrice).replace(/[^0-9.]/g, '');
  const amount = parseFloat(numeric);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
}

/** Public view of an order — no access token or internal event log. */
function orderView(order) {
  return {
    id: order.id,
    order_number: order.order_number,
    status: order.status,
    course: {
      id: order.course.id,
      name: order.course.name,
      amount: order.course.amount,
      currency: order.course.currency,
      price_display: decodeEntities(order.course.price_raw) || `${order.course.currency} ${Number(order.course.amount).toFixed(2)}`
    },
    buyer: {
      first_name: order.buyer.first_name,
      last_name: order.buyer.last_name,
      email: order.buyer.email
    },
    payment: {
      status: order.payment.status,
      paid_at: order.payment.paid_at,
      failure_reason: order.payment.failure_reason
    },
    enrolment: {
      status: order.enrolment.status,
      user_created: order.enrolment.user_created,
      enrolled_at: order.enrolment.enrolled_at
    },
    lms_access:
      order.enrolment.status === 'success'
        ? {
            portal_url: PUBLIC_LMS_URL,
            login: order.enrolment.lms_login,
            // Temp password only exists for accounts we just created; shown
            // once on the result page because M365 SMTP may not be enabled yet.
            temp_password: order.enrolment.lms_temp_password
          }
        : null,
    created_at: order.created_at
  };
}

async function requireOrderWithToken(req, res) {
  const order = await store.getOrder(req.params.id);
  if (!order) {
    res.status(404).json({ ok: false, message: 'Order not found.' });
    return null;
  }
  const token = req.query.token || req.body?.token;
  if (!safeTokenEqual(token, order.access_token)) {
    res.status(403).json({ ok: false, message: 'Invalid order token.' });
    return null;
  }
  return order;
}

function requireAdmin(req, res) {
  if (!ADMIN_API_KEY) {
    res.status(503).json({ ok: false, message: 'ADMIN_API_KEY is not configured.' });
    return false;
  }
  if (req.get('x-admin-key') !== ADMIN_API_KEY) {
    res.status(401).json({ ok: false, message: 'Unauthorized.' });
    return false;
  }
  return true;
}

const router = express.Router();

router.use('/api/checkout', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
router.use('/api/payments', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

async function settleVerifiedPayment(orderId, provider, payload) {
  const snapshot = await store.getOrder(orderId);
  if (!snapshot) return { order: null, duplicate: false };
  if (PAID_STATES.has(snapshot.status)) {
    return { order: snapshot, duplicate: true };
  }

  const verification = await provider.verifyPayment(snapshot, payload);
  if (!verification?.verified) {
    const err = new Error('Payment verification failed.');
    err.code = 'PAYMENT_NOT_VERIFIED';
    throw err;
  }

  let shouldFulfil = false;
  let duplicate = false;
  await store.updateOrder(orderId, (order) => {
    if (PAID_STATES.has(order.status)) {
      duplicate = true;
      return;
    }

    order.payment.last_verified_at = new Date().toISOString();
    order.payment.provider_code = verification.provider_code || null;

    if (verification.paid) {
      shouldFulfil = true;
      order.status = 'paid';
      order.payment.status = 'paid';
      order.payment.paid_at = order.payment.paid_at || new Date().toISOString();
      order.payment.failure_reason = null;
      if (verification.approval) order.payment.approval = verification.approval;
      store.addEvent(order, 'payment_confirmed', `verified via ${provider.name}`);
      return;
    }

    if (verification.pending) {
      order.status = 'pending_payment';
      order.payment.status = 'pending';
      order.payment.failure_reason = null;
      store.addEvent(
        order,
        'payment_pending',
        verification.provider_code ? `provider code ${verification.provider_code}` : ''
      );
      return;
    }

    order.status = verification.status === 'cancelled' ? 'cancelled' : 'payment_failed';
    order.payment.status = verification.status || 'failed';
    order.payment.failure_reason = verification.failure_reason || 'payment_not_completed';
    store.addEvent(order, 'payment_failed', order.payment.failure_reason);
  });

  if (shouldFulfil) {
    try {
      await fulfilOrder(orderId, store);
    } catch (err) {
      console.error('[checkout] fulfilment failed for paid order', orderId, err.message);
    }

    const finalOrder = await store.getOrder(orderId);
    sendPurchaseEmails(finalOrder).catch((err) =>
      console.error('[checkout] purchase emails failed:', err.message)
    );
    return { order: finalOrder, duplicate };
  }

  return { order: await store.getOrder(orderId), duplicate };
}

// ---------------------------------------------------------------------------
// POST /api/checkout/lookup-account — verify whether a learner email exists
// ---------------------------------------------------------------------------
router.post('/api/checkout/lookup-account', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, message: 'A valid email address is required.' });
  }
  if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
    return res.status(503).json({ ok: false, message: 'LMS is not configured.' });
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      return res.json({
        ok: true,
        exists: false,
        message: 'No learner account was found for this email.'
      });
    }
    return res.json({
      ok: true,
      exists: true,
      account: {
        email,
        first_name: user.first_name || '',
        last_name: user.last_name || '',
        login: user.login || null
      }
    });
  } catch (err) {
    console.error('[checkout] account lookup failed:', err.message);
    return res.status(502).json({
      ok: false,
      message: 'Unable to verify this email right now. Please try again shortly.'
    });
  }
});

// ---------------------------------------------------------------------------
// POST /api/checkout/create — start a purchase
// ---------------------------------------------------------------------------
router.post('/api/checkout/create', checkoutCreateLimiter, async (req, res) => {
  const body = req.body || {};
  const courseId = String(body.courseId || '').trim();
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const consent = body.consent === true;
  const accountMode = String(body.accountMode || 'new').trim().toLowerCase() === 'existing'
    ? 'existing'
    : 'new';

  if (!courseId || !firstName || !lastName || !email) {
    return res
      .status(400)
      .json({ ok: false, message: 'Course, first name, last name, and email are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, message: 'Invalid email address.' });
  }
  if (
    courseId.length > 32 ||
    firstName.length > 100 ||
    lastName.length > 100 ||
    email.length > 254 ||
    phone.length > 32
  ) {
    return res.status(400).json({ ok: false, message: 'One or more checkout fields are too long.' });
  }
  if (!consent) {
    return res.status(400).json({ ok: false, message: 'Consent is required.' });
  }
  if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
    return res.status(503).json({ ok: false, message: 'LMS is not configured.' });
  }

  let existingUser = null;
  try {
    const privateIds = await visibility.getPrivateIds();
    if (privateIds.has(courseId)) {
      return res.status(404).json({ ok: false, message: 'Course not found.' });
    }
  } catch (err) {
    return res.status(503).json({ ok: false, error: err.code, message: err.message });
  }
  try {
    existingUser = await findUserByEmail(email);
  } catch (err) {
    console.error('[checkout] account check failed:', err.message);
    return res.status(502).json({
      ok: false,
      message: 'Unable to verify your account right now. Please try again shortly.'
    });
  }

  if (accountMode === 'existing' && !existingUser) {
    return res.status(404).json({
      ok: false,
      code: 'account_not_found',
      message:
        'No learner account was found for this email. Switch to “I’m new here” to create an account, or check the email and try again.'
    });
  }

  if (accountMode === 'new' && existingUser) {
    return res.status(409).json({
      ok: false,
      code: 'account_exists',
      message:
        'An account already exists for this email. Switch to “I already have an account” to enrol this course into that account.'
    });
  }

  if (existingUser?.id) {
    try {
      const enrolment = await getUserCourseEnrolment(existingUser.id, courseId);
      if (enrolment.enrolled) {
        return res.status(409).json({
          ok: false,
          code: 'already_enrolled',
          message:
            'You are already enrolled in this course. Open My learning to continue studying.'
        });
      }
    } catch (enrolErr) {
      console.warn('[checkout] enrolment check failed:', enrolErr.message);
    }
  }

  let courseRaw;
  let unverified = false;
  try {
    const r = await lms.get(`/courses/id:${encodeURIComponent(courseId)}`);
    courseRaw = r.data;
  } catch (err) {
    console.error('[checkout] course lookup failed', err?.response?.status, err.message);
    if (!ALLOW_UNVERIFIED_COURSES) {
      return res.status(404).json({ ok: false, message: 'Course not found.' });
    }
    unverified = true;
    courseRaw = {
      id: courseId,
      name: String(body.courseName || 'Course').slice(0, 200),
      price: String(body.coursePrice || ''),
      status: 'active'
    };
    console.warn('[checkout] proceeding with UNVERIFIED course details (dev fallback):', courseId);
  }

  // Recheck after account/course calls, which may outlive the visibility TTL.
  try {
    const privateIds = await visibility.getPrivateIds();
    if (String(courseRaw?.id) !== courseId || !visibility.isPublic(courseRaw, privateIds)) {
      return res.status(404).json({ ok: false, message: 'Course not found.' });
    }
  } catch (err) {
    return res.status(503).json({ ok: false, error: err.code, message: err.message });
  }

  if ((courseRaw.status ?? 'active') !== 'active') {
    return res.status(409).json({ ok: false, message: 'This course is not available for purchase.' });
  }

  const priceText = decodeEntities(courseRaw.price || '').trim();
  const amount = parseAmount(courseRaw.price);
  const freeCourse =
    !unverified &&
    amount === 0 &&
    (!priceText || /(?:^|[^\d])0(?:\.0{1,2})?(?:[^\d]|$)/.test(priceText));
  if (amount <= 0 && !freeCourse) {
    return res.status(409).json({
      ok: false,
      message: 'This course does not have a valid payable price. Please contact support.'
    });
  }
  let provider;
  try {
    provider = freeCourse ? { name: 'free' } : getProvider();
  } catch (err) {
    console.error('[checkout] payment provider configuration failed:', err.code || '', err.message);
    return res.status(503).json({
      ok: false,
      message: 'Secure payment is temporarily unavailable.'
    });
  }
  let order;
  try {
    order = await store.createOrder({
      buyer: {
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        account_mode: accountMode,
        existing_account: Boolean(existingUser)
      },
      course: {
        id: String(courseRaw.id),
        name: courseRaw.name || 'Course',
        price_raw: courseRaw.price || '',
        amount,
        currency: CHECKOUT_CURRENCY.toUpperCase(),
        unverified
      },
      provider: provider.name
    });
  } catch (err) {
    console.error('[checkout] order creation failed:', err.code || '', err.message);
    return res.status(503).json({
      ok: false,
      message: 'Checkout is temporarily unavailable.',
      detail:
        process.env.NODE_ENV === 'production'
          ? 'Database connection failed. Check DB_* env vars and cPanel MySQL setup.'
          : err.message
    });
  }

  if (freeCourse) {
    await store.updateOrder(order.id, (o) => {
      o.status = 'paid';
      o.payment.status = 'waived';
      o.payment.paid_at = new Date().toISOString();
      store.addEvent(o, 'payment_waived', 'server-verified free course');
    });
    try {
      await fulfilOrder(order.id, store);
    } catch (err) {
      console.error('[checkout] free-course fulfilment failed:', order.id, err.message);
    }
    const finalOrder = await store.getOrder(order.id);
    sendPurchaseEmails(finalOrder).catch((err) =>
      console.error('[checkout] purchase emails failed:', err.message)
    );
    return res.json({
      ok: true,
      order_id: order.id,
      order_number: order.order_number,
      payment_url: `/checkout/result/${encodeURIComponent(order.id)}#token=${encodeURIComponent(order.access_token)}`,
      amount: order.course.amount,
      currency: order.course.currency,
      course_name: order.course.name
    });
  }

  let providerRef;
  let paymentUrl;
  try {
    const payment = await provider.createPayment(order);
    providerRef = payment.provider_ref;
    paymentUrl = payment.payment_url;
    await store.updateOrder(order.id, (o) => {
      o.provider_ref = providerRef;
      o.payment.status = 'pending';
      store.addEvent(o, 'payment_created', `${provider.name} payment session created`);
    });
  } catch (err) {
    console.error('[checkout] payment session creation failed:', err.code || '', err.message);
    await store.updateOrder(order.id, (o) => {
      o.status = 'payment_failed';
      o.payment.status = 'initialization_failed';
      o.payment.failure_reason = err.code || 'provider_unavailable';
      store.addEvent(o, 'payment_initialization_failed', err.code || 'provider_unavailable');
    }).catch(() => {});
    return res.status(err.code === 'DPO_CONFIG_ERROR' ? 503 : 502).json({
      ok: false,
      message: 'Unable to start the secure payment. Please try again shortly.'
    });
  }

  return res.json({
    ok: true,
    order_id: order.id,
    order_number: order.order_number,
    token: provider.name === 'mock' ? order.access_token : undefined,
    payment_url: paymentUrl,
    amount: order.course.amount,
    currency: order.course.currency,
    course_name: order.course.name
  });
});

// ---------------------------------------------------------------------------
// GET /api/checkout/orders/:id?token= — order status (polled by result page)
// ---------------------------------------------------------------------------
router.get('/api/checkout/orders/:id', async (req, res) => {
  try {
    const order = await requireOrderWithToken(req, res);
    if (!order) return;
    res.json({ ok: true, order: orderView(order) });
  } catch (err) {
    console.error('[checkout] order fetch failed:', err.message);
    res.status(503).json({ ok: false, message: 'Order lookup is temporarily unavailable.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/payments/mock/confirm — simulated gateway confirmation for dev.
// ---------------------------------------------------------------------------
router.post('/api/payments/mock/confirm', async (req, res) => {
  const body = req.body || {};
  let order;
  try {
    order = await store.getOrder(String(body.order_id || ''));
  } catch (err) {
    console.error('[checkout] order fetch failed:', err.message);
    return res.status(503).json({ ok: false, message: 'Payments are temporarily unavailable.' });
  }
  if (!order) {
    return res.status(404).json({ ok: false, message: 'Order not found.' });
  }
  if (order.provider !== 'mock' || !safeTokenEqual(body.token, order.access_token)) {
    return res.status(403).json({ ok: false, message: 'Payment verification failed.' });
  }

  try {
    const result = await settleVerifiedPayment(order.id, getProvider('mock'), {
      token: body.token,
      outcome: body.outcome
    });
    return res.json({
      ok: true,
      order: orderView(result.order),
      duplicate: result.duplicate
    });
  } catch (err) {
    console.error('[checkout] mock verification failed:', err.code || '', err.message);
    return res.status(403).json({ ok: false, message: 'Payment verification failed.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/payments/dpo/return — signed browser return from DPO hosted checkout.
// DPO query parameters are never trusted as proof of payment; verifyToken is
// always called from this server using the stored transaction reference.
// ---------------------------------------------------------------------------
router.get('/api/payments/dpo/return', paymentVerifyLimiter, async (req, res) => {
  const orderId = String(req.query.order_id || '');
  const state = String(req.query.state || '');
  let order;
  let provider;

  try {
    order = await store.getOrder(orderId);
    provider = getProvider('dpo');
  } catch (err) {
    console.error('[checkout] DPO return setup failed:', err.code || '', err.message);
    return res.status(503).type('text/plain').send('Payment verification is temporarily unavailable.');
  }

  if (!order || order.provider !== 'dpo') {
    return res.status(404).type('text/plain').send('Order not found.');
  }
  if (!provider.verifyReturnState(order.id, state)) {
    return res.status(403).type('text/plain').send('Invalid payment return.');
  }

  try {
    const result = await settleVerifiedPayment(order.id, provider, {
      source: String(req.query.source || '')
    });
    order = result.order || order;
  } catch (err) {
    // A network outage must not turn an unverified payment into a failure.
    // The result page and admin reconciliation endpoint can safely retry.
    console.error('[checkout] DPO return verification deferred:', err.code || '', err.message);
    order = (await store.getOrder(order.id).catch(() => null)) || order;
  }

  res.set('Referrer-Policy', 'no-referrer');
  return res.redirect(303, provider.resultUrl(order));
});

// Browser-triggered reconciliation. The order access token authorizes the
// request, but payment truth still comes only from DPO verifyToken.
router.post(
  '/api/checkout/orders/:id/verify-payment',
  paymentVerifyLimiter,
  async (req, res) => {
    try {
      const order = await requireOrderWithToken(req, res);
      if (!order) return;
      if (order.provider !== 'dpo') {
        return res.status(409).json({ ok: false, message: 'This order does not use DPO Pay.' });
      }
      const result = await settleVerifiedPayment(order.id, getProvider('dpo'));
      return res.json({ ok: true, order: orderView(result.order), duplicate: result.duplicate });
    } catch (err) {
      console.error('[checkout] DPO reconciliation failed:', err.code || '', err.message);
      return res.status(502).json({
        ok: false,
        message: 'Payment confirmation is taking longer than expected. We will keep checking.'
      });
    }
  }
);

// Admin-triggered reconciliation for paid customers who closed the DPO page
// before its browser return reached this application.
router.post('/api/admin/orders/:id/verify-payment', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const order = await store.getOrder(req.params.id).catch(() => null);
  if (!order) {
    return res.status(404).json({ ok: false, message: 'Order not found.' });
  }
  if (order.provider !== 'dpo') {
    return res.status(409).json({ ok: false, message: 'This order does not use DPO Pay.' });
  }
  try {
    const result = await settleVerifiedPayment(order.id, getProvider('dpo'));
    return res.json({ ok: true, order: orderView(result.order), duplicate: result.duplicate });
  } catch (err) {
    console.error('[checkout] admin DPO reconciliation failed:', err.code || '', err.message);
    return res.status(502).json({ ok: false, message: 'DPO verification failed.' });
  }
});

// ---------------------------------------------------------------------------
// Admin: list orders / retry failed enrolment
// ---------------------------------------------------------------------------
router.get('/api/admin/orders', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const orders = await store.listOrders();
    res.json({
      ok: true,
      orders: orders.map((o) => ({
        ...orderView(o),
        provider: o.provider,
        provider_reference_set: Boolean(o.provider_ref),
        enrolment_error: o.enrolment.last_error,
        enrolment_attempts: o.enrolment.attempts,
        events: o.events
      }))
    });
  } catch (err) {
    console.error('[checkout] admin list failed:', err.message);
    res.status(503).json({ ok: false, message: 'Order listing is temporarily unavailable.' });
  }
});

router.post('/api/admin/orders/:id/retry-enrolment', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const order = await store.getOrder(req.params.id).catch(() => null);
  if (!order) {
    return res.status(404).json({ ok: false, message: 'Order not found.' });
  }
  if (!['paid', 'waived'].includes(order.payment.status)) {
    return res.status(409).json({ ok: false, message: 'Order has not been paid.' });
  }
  try {
    const updated = await fulfilOrder(order.id, store);
    sendPurchaseEmails(updated).catch((err) =>
      console.error('[checkout] purchase emails failed:', err.message)
    );
    return res.json({ ok: true, order: orderView(updated) });
  } catch (err) {
    return res.status(502).json({ ok: false, message: `Enrolment retry failed: ${err.message}` });
  }
});

module.exports = router;
