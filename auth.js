'use strict';

/**
 * Learner auth for the Elevate Skills marketing site.
 * - Register creates a TalentLMS user
 * - Login verifies credentials via TalentLMS /userlogin and sets an ES session cookie
 * - Portal link mints a fresh TalentLMS login_key for SSO into the LMS
 */

const express = require('express');
const store = require('./store');
const {
  findUserByEmail,
  createUser,
  loginUser,
  getAutologinUrl,
  getUserCourseEnrolment,
  getCourseGotoUrl
} = require('./fulfilment');
const { sendRegistrationWelcomeEmail } = require('./mail');
const {
  createSessionToken,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
  publicUser
} = require('./session');

const PUBLIC_LMS_URL =
  (process.env.PUBLIC_LMS_URL || '').trim() ||
  ((process.env.TALENTLMS_DOMAIN || '').trim()
    ? `https://${(process.env.TALENTLMS_DOMAIN || '').trim()}`
    : '');
const TALENTLMS_DOMAIN = (process.env.TALENTLMS_DOMAIN || '').trim();
const TALENTLMS_API_KEY = (process.env.TALENTLMS_API_KEY || '').trim();
const SITE_URL = (process.env.SITE_URL || 'http://localhost:4200').trim().replace(/\/$/, '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const router = express.Router();

function lmsConfigured(res) {
  if (!TALENTLMS_DOMAIN || !TALENTLMS_API_KEY) {
    res.status(503).json({
      ok: false,
      message: 'Authentication is temporarily unavailable. Please try again later.'
    });
    return false;
  }
  return true;
}

function establishSession(res, user) {
  const token = createSessionToken(user);
  setSessionCookie(res, token);
  return publicUser(user);
}

router.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) {
    return res.status(401).json({ ok: false, authenticated: false, user: null });
  }
  return res.json({ ok: true, authenticated: true, user: publicUser(user) });
});

router.post('/api/auth/login', async (req, res) => {
  if (!lmsConfigured(res)) return;

  const body = req.body || {};
  const loginOrEmail = String(body.login || body.email || '').trim();
  const password = String(body.password || '');

  if (!loginOrEmail || !password) {
    return res.status(400).json({
      ok: false,
      message: 'Email/username and password are required.'
    });
  }

  try {
    const logoutRedirect = Buffer.from(`${SITE_URL}/`).toString('base64');
    const result = await loginUser({
      loginOrEmail,
      password,
      logoutRedirect
    });

    if (!result.user?.id) {
      return res.status(502).json({
        ok: false,
        message: 'Login succeeded but user profile could not be loaded.'
      });
    }

    const user = establishSession(res, result.user);
    return res.json({
      ok: true,
      message: 'Logged in successfully.',
      user,
      portal_login_url: result.login_key || null
    });
  } catch (err) {
    console.error('[auth/login] failed:', err.message);
    if (err.code === 'invalid_credentials') {
      return res.status(401).json({ ok: false, message: err.message });
    }
    return res.status(502).json({
      ok: false,
      message: 'Unable to log in right now. Please try again shortly.'
    });
  }
});

router.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  return res.json({ ok: true, message: 'Logged out.' });
});

router.get('/api/auth/portal-link', async (req, res) => {
  if (!lmsConfigured(res)) return;
  const session = getSessionUser(req);
  if (!session) {
    return res.status(401).json({ ok: false, message: 'Please log in first.' });
  }
  try {
    const portalUrl = await getAutologinUrl(session.id);
    return res.json({ ok: true, portal_url: portalUrl });
  } catch (err) {
    console.error('[auth/portal-link] failed:', err.message);
    return res.status(502).json({
      ok: false,
      message: 'Unable to open the learner portal right now.',
      portal_url: PUBLIC_LMS_URL || null
    });
  }
});

router.get('/api/auth/enrolment/:courseId', async (req, res) => {
  if (!lmsConfigured(res)) return;
  const session = getSessionUser(req);
  if (!session) {
    return res.status(401).json({ ok: false, authenticated: false, enrolled: false });
  }

  const courseId = String(req.params.courseId || '').trim();
  if (!courseId) {
    return res.status(400).json({ ok: false, message: 'Course id is required.' });
  }

  try {
    const status = await getUserCourseEnrolment(session.id, courseId);
    let continue_url = null;
    if (status.enrolled) {
      try {
        continue_url = await getCourseGotoUrl(session.id, courseId, `${SITE_URL}/`);
      } catch (gotoErr) {
        console.warn('[auth/enrolment] goto url failed:', gotoErr.message);
        try {
          continue_url = await getAutologinUrl(session.id);
        } catch {
          continue_url = PUBLIC_LMS_URL || null;
        }
      }
    }

    return res.json({
      ok: true,
      authenticated: true,
      enrolled: status.enrolled,
      course: status.course,
      continue_url
    });
  } catch (err) {
    console.error('[auth/enrolment] failed:', err.message);
    return res.status(502).json({
      ok: false,
      message: 'Unable to check enrolment status right now.'
    });
  }
});

router.post('/api/auth/register', async (req, res) => {
  if (!lmsConfigured(res)) return;

  const body = req.body || {};
  const firstName = String(body.firstName || '').trim();
  const lastName = String(body.lastName || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  const consent = body.consent === true;
  const autoLogin = body.autoLogin !== false;

  if (!firstName || !lastName || !email) {
    return res.status(400).json({
      ok: false,
      message: 'First name, last name, and email are required.'
    });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ ok: false, message: 'Invalid email address.' });
  }
  if (!consent) {
    return res.status(400).json({
      ok: false,
      message: 'You must agree to the Privacy Notice and Terms before creating an account.'
    });
  }

  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({
        ok: false,
        code: 'account_exists',
        message:
          'An account with this email already exists. Please log in, or enrol in a course using this email.'
      });
    }

    const result = await createUser({ firstName, lastName, email });

    try {
      await store.createEnquiry({
        type: 'registration',
        name: `${firstName} ${lastName}`.trim(),
        email,
        phone: phone || undefined,
        subject: 'Standalone learner registration',
        message: `Learner account created. LMS login: ${result.login}`,
        consent: true,
        data: {
          first_name: firstName,
          last_name: lastName,
          talentlms_user_id: String(result.user.id),
          lms_login: result.login
        }
      });
    } catch (persistErr) {
      console.error('[auth/register] enquiry persist failed:', persistErr.message);
    }

    sendRegistrationWelcomeEmail({
      firstName,
      email,
      login: result.login,
      password: result.password,
      portalUrl: PUBLIC_LMS_URL
    }).catch((err) => console.error('[auth/register] welcome email failed:', err.message));

    let portalLoginUrl = null;
    let sessionUser = null;
    if (autoLogin) {
      try {
        const logoutRedirect = Buffer.from(`${SITE_URL}/`).toString('base64');
        const loggedIn = await loginUser({
          loginOrEmail: result.login,
          password: result.password,
          logoutRedirect
        });
        sessionUser = establishSession(res, {
          id: String(result.user.id),
          login: result.login,
          email,
          first_name: firstName,
          last_name: lastName
        });
        portalLoginUrl = loggedIn.login_key || null;
      } catch (loginErr) {
        console.error('[auth/register] auto-login failed:', loginErr.message);
      }
    }

    return res.json({
      ok: true,
      message: 'Your learner account has been created.',
      account: {
        email,
        login: result.login,
        temp_password: result.password,
        portal_url: PUBLIC_LMS_URL || null
      },
      user: sessionUser,
      portal_login_url: portalLoginUrl
    });
  } catch (err) {
    console.error('[auth/register] failed:', err.message);
    if (/same email|already exists/i.test(err.message)) {
      return res.status(409).json({
        ok: false,
        code: 'account_exists',
        message:
          'An account with this email already exists. Please log in.'
      });
    }
    return res.status(502).json({
      ok: false,
      message:
        'Unable to create your account right now. Please try again or contact help@elevateskills.online.'
    });
  }
});

module.exports = router;
