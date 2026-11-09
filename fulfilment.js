'use strict';

/**
 * TalentLMS fulfilment: after a verified payment, make sure the buyer has a
 * learner account and is enrolled in the purchased course.
 */

const axios = require('axios');
const crypto = require('crypto');
const { addEvent } = require('./store');

const TALENTLMS_DOMAIN = (process.env.TALENTLMS_DOMAIN || '').trim();
const TALENTLMS_API_KEY = (process.env.TALENTLMS_API_KEY || '').trim();

const lms = axios.create({
  baseURL: TALENTLMS_DOMAIN ? `https://${TALENTLMS_DOMAIN}/api/v1` : undefined,
  timeout: 20000,
  auth: { username: TALENTLMS_API_KEY, password: '' },
  headers: { Accept: 'application/json' }
});

function lmsErrorMessage(err) {
  return (
    err?.response?.data?.error?.message ||
    err?.response?.data?.error ||
    err.message ||
    'TalentLMS request failed'
  );
}

async function findUserByEmail(email) {
  const normalised = String(email || '').trim().toLowerCase();
  if (!normalised) return null;

  // TalentLMS expects the raw email in the path — encoding @ as %40 returns 404
  // even when the user exists (verified against lms.elevateskills.online).
  const attempts = [
    () => lms.get(`/users/email:${normalised}`),
    () => lms.get('/users', { params: { email: normalised } })
  ];

  for (const attempt of attempts) {
    try {
      const r = await attempt();
      const data = r.data;
      const user = Array.isArray(data) ? data[0] : data;
      if (user && user.id) return user;
    } catch (err) {
      const status = err?.response?.status;
      const message = lmsErrorMessage(err);
      if (status === 404 || /does not exist|not found/i.test(message)) {
        continue;
      }
      throw new Error(`user lookup failed: ${message}`);
    }
  }

  return null;
}

function generateLogin(email) {
  const local = String(email).split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${local || 'learner'}_${suffix}`;
}

function generatePassword() {
  // Mixed-case + digit + symbol to satisfy typical LMS password policies.
  return `Es!${crypto.randomBytes(6).toString('base64url')}9`;
}

async function createUser({ firstName, lastName, email }) {
  const login = generateLogin(email);
  const password = generatePassword();
  const form = new URLSearchParams({
    first_name: firstName,
    last_name: lastName,
    email,
    login,
    password
  });
  try {
    const r = await lms.post('/usersignup', form);
    return { user: r.data, login, password };
  } catch (err) {
    throw new Error(`user creation failed: ${lmsErrorMessage(err)}`);
  }
}

async function enrolUserToCourse(userId, courseId) {
  const form = new URLSearchParams({
    user_id: String(userId),
    course_id: String(courseId)
  });
  try {
    await lms.post('/addusertocourse', form);
  } catch (err) {
    const message = lmsErrorMessage(err);
    if (/already/i.test(message)) {
      return; // already enrolled — treat as success (idempotent fulfilment)
    }
    throw new Error(`enrolment failed: ${message}`);
  }
}

/**
 * Runs the whole fulfilment for a paid order and records progress on it.
 * Mutations happen through updateOrder so every step is persisted.
 */
async function fulfilOrder(orderId, { getOrder, updateOrder }) {
  const order = await getOrder(orderId);
  if (!order) throw new Error(`order ${orderId} not found`);
  if (order.enrolment.status === 'success') return order;

  await updateOrder(orderId, (o) => {
    o.status = 'enrolling';
    o.enrolment.attempts += 1;
    addEvent(o, 'fulfilment_started', `attempt ${o.enrolment.attempts}`);
  });

  try {
    let userId;
    let created = false;
    let lmsLogin = null;
    let lmsPassword = null;

    const existing = await findUserByEmail(order.buyer.email);
    if (existing) {
      userId = existing.id;
      lmsLogin = existing.login || null;
    } else {
      try {
        const result = await createUser({
          firstName: order.buyer.first_name,
          lastName: order.buyer.last_name,
          email: order.buyer.email
        });
        userId = result.user.id;
        created = true;
        lmsLogin = result.login;
        lmsPassword = result.password;
      } catch (createErr) {
        // Race or lookup miss — if LMS says email exists, find and reuse that account.
        if (/same email|already exists/i.test(createErr.message)) {
          const retry = await findUserByEmail(order.buyer.email);
          if (!retry) throw createErr;
          userId = retry.id;
          lmsLogin = retry.login || null;
        } else {
          throw createErr;
        }
      }
    }

    await enrolUserToCourse(userId, order.course.id);

    return await updateOrder(orderId, (o) => {
      o.status = 'completed';
      o.enrolment.status = 'success';
      o.enrolment.talentlms_user_id = String(userId);
      o.enrolment.user_created = created;
      o.enrolment.lms_login = lmsLogin;
      o.enrolment.lms_temp_password = lmsPassword;
      o.enrolment.enrolled_at = new Date().toISOString();
      o.enrolment.last_error = null;
      addEvent(o, 'enrolment_success', `user ${userId} enrolled in course ${o.course.id}`);
    });
  } catch (err) {
    await updateOrder(orderId, (o) => {
      o.status = 'enrolment_failed';
      o.enrolment.status = 'failed';
      o.enrolment.last_error = err.message;
      addEvent(o, 'enrolment_failed', err.message);
    });
    throw err;
  }
}

/**
 * Authenticate against TalentLMS via /userlogin.
 * Accepts TalentLMS username or email; returns profile + one-time login_key URL.
 */
async function loginUser({ loginOrEmail, password, logoutRedirect }) {
  const identifier = String(loginOrEmail || '').trim();
  const pwd = String(password || '');
  if (!identifier || !pwd) {
    const err = new Error('Login and password are required.');
    err.code = 'invalid_credentials';
    throw err;
  }

  let loginName = identifier;
  let profileHint = null;
  if (identifier.includes('@')) {
    profileHint = await findUserByEmail(identifier);
    if (!profileHint?.login) {
      const err = new Error('Invalid email or password.');
      err.code = 'invalid_credentials';
      throw err;
    }
    loginName = profileHint.login;
  }

  const form = new URLSearchParams({
    login: loginName,
    password: pwd
  });
  if (logoutRedirect) {
    form.set('logout_redirect', String(logoutRedirect));
  }

  try {
    const r = await lms.post('/userlogin', form);
    const data = r.data || {};
    const loginKey = data.login_key || null;
    const userId = data.user_id != null ? String(data.user_id) : null;

    let profile = profileHint;
    if (!profile && userId) {
      try {
        const u = await lms.get(`/users/id:${encodeURIComponent(userId)}`);
        profile = u.data;
      } catch {
        profile = null;
      }
    }
    if (!profile) {
      try {
        const u = await lms.get(`/users/username:${encodeURIComponent(loginName)}`);
        profile = u.data;
      } catch {
        profile = {
          id: userId,
          login: loginName,
          email: identifier.includes('@') ? identifier.toLowerCase() : '',
          first_name: '',
          last_name: ''
        };
      }
    }

    return {
      user: {
        id: String(profile.id || userId || ''),
        login: profile.login || loginName,
        email: String(profile.email || (identifier.includes('@') ? identifier : '')).toLowerCase(),
        first_name: profile.first_name || '',
        last_name: profile.last_name || ''
      },
      login_key: loginKey
    };
  } catch (err) {
    if (err.code === 'invalid_credentials') throw err;
    const message = lmsErrorMessage(err);
    if (
      /invalid|password|credentials|not found|incorrect|wrong/i.test(String(message)) ||
      err?.response?.status === 401 ||
      err?.response?.status === 403
    ) {
      const e = new Error('Invalid email/username or password.');
      e.code = 'invalid_credentials';
      throw e;
    }
    throw new Error(`login failed: ${message}`);
  }
}

/**
 * Fresh one-time TalentLMS autologin URL for a known user id (API returns login_key).
 */
async function getAutologinUrl(userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('user id is required');
  try {
    const r = await lms.get(`/users/id:${encodeURIComponent(id)}`);
    const key = r.data?.login_key;
    if (!key) throw new Error('TalentLMS did not return a login key for this user.');
    return String(key);
  } catch (err) {
    throw new Error(`autologin failed: ${lmsErrorMessage(err)}`);
  }
}

/**
 * Returns enrolment status for a TalentLMS user against a course id.
 */
async function getUserCourseEnrolment(userId, courseId) {
  const uid = String(userId || '').trim();
  const cid = String(courseId || '').trim();
  if (!uid || !cid) {
    return { enrolled: false, course: null };
  }

  const r = await lms.get(`/users/id:${encodeURIComponent(uid)}`);
  const courses = Array.isArray(r.data?.courses) ? r.data.courses : [];
  const match = courses.find((c) => String(c.id) === cid);
  if (!match) {
    return { enrolled: false, course: null };
  }

  return {
    enrolled: true,
    course: {
      id: String(match.id),
      name: match.name || '',
      role: match.role || 'learner',
      completion_status: match.completion_status || null,
      completion_percentage:
        match.completion_percentage != null ? String(match.completion_percentage) : null,
      enrolled_on: match.enrolled_on || null
    }
  };
}

/**
 * One-time TalentLMS URL that signs the user in and opens a specific course.
 */
async function getCourseGotoUrl(userId, courseId, logoutRedirect) {
  const uid = String(userId || '').trim();
  const cid = String(courseId || '').trim();
  if (!uid || !cid) throw new Error('user id and course id are required');

  const parts = [`user_id:${uid}`, `course_id:${cid}`];
  if (logoutRedirect) {
    parts.push(`logout_redirect:${Buffer.from(String(logoutRedirect)).toString('base64')}`);
  }

  try {
    const r = await lms.get(`/gotocourse/${parts.join(',')}`);
    const url = r.data?.goto_url;
    if (!url) throw new Error('TalentLMS did not return a course goto URL.');
    return String(url);
  } catch (err) {
    throw new Error(`goto course failed: ${lmsErrorMessage(err)}`);
  }
}

module.exports = {
  fulfilOrder,
  findUserByEmail,
  createUser,
  enrolUserToCourse,
  loginUser,
  getAutologinUrl,
  getUserCourseEnrolment,
  getCourseGotoUrl
};
