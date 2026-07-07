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
const store = require('./store');
const { getProvider } = require('./payments');
const { fulfilOrder } = require('./fulfilment');
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

function decodeEntities(value) {
  return String(value || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ');
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
  if (!token || token !== order.access_token) {
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

// ---------------------------------------------------------------------------
// POST /api/checkout/create — start a purchase
// ---------------------------------------------------------------------------
router.post('/api/checkout/create', async (req, res) => {
  const body = req.body || {};
  const courseId = String(body.courseId || '').trim();
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const consent = body.consent === true;

  if (!courseId || !firstName || !lastName || !email) {
    return res
      .status(400)
      .json({ ok: false, message: 'Course, first name, last name, and email are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, message: 'Invalid email address.' });
  }
  if (!consent) {
    return res.status(400).json({ ok: false, message: 'Consent is required.' });
  }
  if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
    return res.status(503).json({ ok: false, message: 'LMS is not configured.' });
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

  if ((courseRaw.status ?? 'active') !== 'active') {
    return res.status(409).json({ ok: false, message: 'This course is not available for purchase.' });
  }

  const provider = getProvider();
  let order;
  try {
    order = await store.createOrder({
      buyer: { first_name: firstName, last_name: lastName, email, phone },
      course: {
        id: String(courseRaw.id),
        name: courseRaw.name || 'Course',
        price_raw: courseRaw.price || '',
        amount: parseAmount(courseRaw.price),
        currency: CHECKOUT_CURRENCY,
        unverified
      },
      provider: provider.name
    });
  } catch (err) {
    console.error('[checkout] order creation failed:', err.message);
    return res.status(503).json({ ok: false, message: 'Checkout is temporarily unavailable.' });
  }

  const { provider_ref, payment_url } = provider.createPayment(order);
  await store.updateOrder(order.id, (o) => {
    o.provider_ref = provider_ref;
    store.addEvent(o, 'payment_created', `${provider.name} ref ${provider_ref}`);
  });

  return res.json({
    ok: true,
    order_id: order.id,
    order_number: order.order_number,
    token: order.access_token,
    payment_url,
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
// POST /api/payments/mock/confirm — simulated gateway callback (mock webhook).
// The real DPO webhook handler will replace the body of this route but keep
// the same verify -> mark paid -> fulfil pipeline.
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

  // Idempotency: repeated callbacks for a settled order are acknowledged, not reprocessed.
  if (['completed', 'enrolling', 'paid', 'enrolment_failed', 'payment_failed'].includes(order.status)) {
    return res.json({ ok: true, order: orderView(order), duplicate: true });
  }

  const provider = getProvider();
  const verification = provider.verifyPayment(order, {
    token: body.token,
    outcome: body.outcome
  });

  if (!verification.verified) {
    return res.status(403).json({ ok: false, message: 'Payment verification failed.' });
  }

  if (!verification.paid) {
    const updated = await store.updateOrder(order.id, (o) => {
      o.status = 'payment_failed';
      o.payment.status = 'failed';
      o.payment.failure_reason = verification.failure_reason;
      store.addEvent(o, 'payment_failed', verification.failure_reason);
    });
    return res.json({ ok: true, order: orderView(updated) });
  }

  await store.updateOrder(order.id, (o) => {
    o.status = 'paid';
    o.payment.status = 'paid';
    o.payment.paid_at = new Date().toISOString();
    store.addEvent(o, 'payment_confirmed', `verified via ${provider.name}`);
  });

  try {
    await fulfilOrder(order.id, store);
  } catch (err) {
    console.error('[checkout] fulfilment failed for order', order.order_number, err.message);
    // Payment stays recorded; order is in enrolment_failed for admin retry.
  }

  const finalOrder = await store.getOrder(order.id);
  sendPurchaseEmails(finalOrder).catch((err) =>
    console.error('[checkout] purchase emails failed:', err.message)
  );

  return res.json({ ok: true, order: orderView(finalOrder) });
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
        provider_ref: o.provider_ref,
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
  if (order.payment.status !== 'paid') {
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
