'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { sendInterestEmail, sendContactEmail } = require('./mail');

const PORT = parseInt(process.env.PORT, 10) || 4000;
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const TALENTLMS_DOMAIN = (process.env.TALENTLMS_DOMAIN || '').trim();
const TALENTLMS_API_KEY = (process.env.TALENTLMS_API_KEY || '').trim();
const PUBLIC_LMS_URL =
  (process.env.PUBLIC_LMS_URL || '').trim() ||
  (TALENTLMS_DOMAIN ? `https://${TALENTLMS_DOMAIN}` : '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS, 10) || 5 * 60 * 1000;

if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
  console.warn(
    '[talentlms-proxy] TALENTLMS_DOMAIN and TALENTLMS_API_KEY must be set before the server can call TalentLMS.'
  );
}

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(
  cors({
    origin: ALLOWED_ORIGINS.length === 0 ? true : ALLOWED_ORIGINS,
    credentials: false
  })
);

const lms = axios.create({
  baseURL: TALENTLMS_DOMAIN ? `https://${TALENTLMS_DOMAIN}/api/v1` : undefined,
  timeout: 15000,
  auth: { username: TALENTLMS_API_KEY, password: '' },
  headers: { Accept: 'application/json' }
});

const cache = new Map();

async function cachedGet(key, fetcher) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return hit.value;
  }
  const value = await fetcher();
  cache.set(key, { at: now, value });
  return value;
}

function lmsBaseUrl() {
  return (PUBLIC_LMS_URL || '').replace(/\/$/, '');
}

function buildCourseLmsUrl(courseId, sharedUrl) {
  if (sharedUrl && typeof sharedUrl === 'string' && sharedUrl.length > 0) {
    return sharedUrl;
  }
  const base = lmsBaseUrl();
  if (!base) return '';
  return `${base}/catalog/info/id:${courseId}`;
}

function buildLmsConfig() {
  const base = lmsBaseUrl();
  return {
    public_lms_url: base,
    login_url: base ? `${base}/` : '',
    register_url: base ? `${base}/index/signup` : '',
    catalog_url_pattern: base ? `${base}/catalog/info/id:{id}` : ''
  };
}

function mapCourse(raw, categoryMap) {
  const id = String(raw.id ?? '');
  const categoryId = raw.category_id ? String(raw.category_id) : '';
  const categorySlug = categoryMap.get(categoryId) ?? 'general';
  return {
    id,
    name: raw.name ?? '',
    code: raw.code ?? '',
    description: raw.description ?? '',
    price: raw.price ?? '',
    status: raw.status ?? '',
    level: raw.level ?? '',
    image: raw.big_avatar || raw.avatar || '',
    category_id: categoryId,
    category_slug: categorySlug,
    shared: raw.shared === '1' || raw.shared === 1,
    shared_url: raw.shared_url ?? '',
    hide_from_catalog: raw.hide_from_catalog === '1' || raw.hide_from_catalog === 1,
    certification: raw.certification ?? '',
    certification_duration: raw.certification_duration ?? '',
    creation_date: raw.creation_date ?? '',
    lms_url: buildCourseLmsUrl(id, raw.shared_url)
  };
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildCategoryMap(categories) {
  const map = new Map();
  for (const cat of categories) {
    map.set(String(cat.id), slugify(cat.name) || `cat-${cat.id}`);
  }
  return map;
}

function handleLmsError(res, err, fallback) {
  const status = err?.response?.status ?? 502;
  const body = err?.response?.data;
  console.error('[talentlms-proxy] LMS error', status, body || err.message);
  if (fallback !== undefined) {
    return res.status(200).json(fallback);
  }
  return res.status(status).json({
    error: 'talentlms_request_failed',
    status,
    message: err.message || 'TalentLMS request failed'
  });
}

const routes = express.Router();

routes.get('/', (_req, res) => {
  res.type('text/plain').send(`Elevate Skills API\nNode ${process.version}\nHealth: ${BASE_PATH || ''}/health`);
});

routes.get('/health', (_req, res) => {
  res.json({
    ok: true,
    base_path: BASE_PATH || '/',
    domain_configured: Boolean(TALENTLMS_DOMAIN),
    api_key_configured: Boolean(TALENTLMS_API_KEY),
    public_lms_url: PUBLIC_LMS_URL || null
  });
});

routes.get('/api/talentlms/config', (_req, res) => {
  res.json(buildLmsConfig());
});

routes.get('/api/talentlms/categories', async (_req, res) => {
  if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
    return res
      .status(503)
      .json({ error: 'proxy_not_configured', message: 'TalentLMS credentials are missing.' });
  }
  try {
    const data = await cachedGet('categories', async () => {
      const r = await lms.get('/categories');
      return Array.isArray(r.data) ? r.data : [];
    });
    res.json(
      data.map((c) => ({
        id: String(c.id),
        name: c.name ?? '',
        slug: slugify(c.name) || `cat-${c.id}`,
        parent_category_id: c.parent_category_id ? String(c.parent_category_id) : null,
        price: c.price ?? ''
      }))
    );
  } catch (err) {
    return handleLmsError(res, err);
  }
});

routes.get('/api/talentlms/courses', async (_req, res) => {
  if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
    return res
      .status(503)
      .json({ error: 'proxy_not_configured', message: 'TalentLMS credentials are missing.' });
  }
  try {
    const [categories, courses] = await Promise.all([
      cachedGet('categories', async () => {
        const r = await lms.get('/categories');
        return Array.isArray(r.data) ? r.data : [];
      }),
      cachedGet('courses', async () => {
        const r = await lms.get('/courses');
        return Array.isArray(r.data) ? r.data : [];
      })
    ]);

    const categoryMap = buildCategoryMap(categories);
    const visible = courses
      .filter((c) => (c.status ?? 'active') === 'active')
      .filter((c) => !(c.hide_from_catalog === '1' || c.hide_from_catalog === 1))
      .map((c) => mapCourse(c, categoryMap));

    res.json(visible);
  } catch (err) {
    return handleLmsError(res, err);
  }
});

routes.get('/api/talentlms/courses/:id', async (req, res) => {
  if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
    return res
      .status(503)
      .json({ error: 'proxy_not_configured', message: 'TalentLMS credentials are missing.' });
  }
  try {
    const id = encodeURIComponent(req.params.id);
    const [categories, course] = await Promise.all([
      cachedGet('categories', async () => {
        const r = await lms.get('/categories');
        return Array.isArray(r.data) ? r.data : [];
      }),
      cachedGet(`course:${id}`, async () => {
        const r = await lms.get(`/courses/id:${id}`);
        return r.data;
      })
    ]);
    res.json(mapCourse(course, buildCategoryMap(categories)));
  } catch (err) {
    return handleLmsError(res, err);
  }
});

routes.post('/api/register-interest', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const friendPhone = String(body.friendPhone || '').trim();
  const course = String(body.course || '').trim();
  const otherCourse = String(body.otherCourse || '').trim();
  const message = String(body.message || '').trim();
  const intent = String(body.intent || '').trim();
  const consent = body.consent === true;
  const selectedCourses = Array.isArray(body.selectedCourses)
    ? body.selectedCourses.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (!name || !email || !phone) {
    return res.status(400).json({ ok: false, message: 'Name, email, and contact number are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, message: 'Invalid email address.' });
  }
  if (!consent) {
    return res.status(400).json({ ok: false, message: 'Consent is required.' });
  }
  if (!course && !otherCourse && selectedCourses.length === 0) {
    return res.status(400).json({ ok: false, message: 'Please select at least one course or category.' });
  }

  try {
    const result = await sendInterestEmail({
      name,
      email,
      phone,
      friendPhone: friendPhone || undefined,
      course: course || undefined,
      selectedCourses,
      otherCourse: otherCourse || undefined,
      message: message || undefined,
      intent: intent || undefined,
      consent
    });
    return res.json({
      ok: true,
      message: result.delivered
        ? 'Your interest has been sent.'
        : 'Your interest has been recorded.'
    });
  } catch (err) {
    console.error('[register-interest] send failed', err.message);
    return res.status(502).json({
      ok: false,
      message: 'Unable to send email. Please contact help@elevateskills.online directly.'
    });
  }
});

routes.post('/api/contact', async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const phone = String(body.phone || '').trim();
  const message = String(body.message || '').trim();
  const type = String(body.type || 'general').trim();

  if (!name || !email || !message) {
    return res.status(400).json({ ok: false, message: 'Name, email, and message are required.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, message: 'Invalid email address.' });
  }

  try {
    const result = await sendContactEmail({ name, email, phone: phone || undefined, message, type });
    return res.json({
      ok: true,
      message: result.delivered
        ? 'Your message has been sent.'
        : 'Your message has been recorded.'
    });
  } catch (err) {
    console.error('[contact] send failed', err.message);
    return res.status(502).json({
      ok: false,
      message: 'Unable to send your message. Please email help@elevateskills.online directly.'
    });
  }
});

// Mount at BASE_PATH for cPanel subfolder URLs (e.g. /backend) and at / for local dev.
if (BASE_PATH) {
  app.use(BASE_PATH, routes);
}
app.use('/', routes);

function startServer() {
  app.listen(PORT, () => {
    const lmsConfig = buildLmsConfig();
    const prefix = BASE_PATH || '';
    console.log(`[talentlms-proxy] listening on port ${PORT}`);
    console.log(`[talentlms-proxy] base path: ${prefix || '(root)'}`);
    console.log(`[talentlms-proxy] health: ${prefix}/health`);
    console.log(`[talentlms-proxy] LMS portal: ${lmsConfig.public_lms_url || '(not set)'}`);
  });
}

module.exports = app;

if (require.main === module) {
  startServer();
}
