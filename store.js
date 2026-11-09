'use strict';

/**
 * MySQL-backed order store (cPanel-friendly, uses mysql2 pool).
 *
 * Orders are stored as a JSON document in `data`, with key fields mirrored
 * into indexed columns for querying. The exported API is small so the
 * calling code never touches SQL directly.
 *
 * Env: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
 */

const mysql = require('mysql2/promise');
const crypto = require('crypto');
const { blindIndex, protect, unprotect } = require('./security');

const DB_HOST = (process.env.DB_HOST || 'localhost').trim();
const DB_PORT = parseInt(process.env.DB_PORT, 10) || 3306;
const DB_USER = (process.env.DB_USER || 'root').trim();
const DB_PASSWORD = process.env.DB_PASSWORD ?? '';
const DB_NAME = (process.env.DB_NAME || 'elevatekills').trim();

let pool = null;
let initPromise = null;

const ORDERS_SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  seq INT AUTO_INCREMENT PRIMARY KEY,
  id CHAR(36) NOT NULL UNIQUE,
  order_number VARCHAR(20) NULL UNIQUE,
  status VARCHAR(32) NOT NULL,
  buyer_email VARCHAR(255) NOT NULL,
  course_id VARCHAR(32) NOT NULL,
  provider VARCHAR(16) NOT NULL,
  provider_ref VARCHAR(64) NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'BWP',
  data JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_orders_status (status),
  INDEX idx_orders_buyer_email (buyer_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const ENQUIRIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS enquiries (
  seq INT AUTO_INCREMENT PRIMARY KEY,
  id CHAR(36) NOT NULL UNIQUE,
  type VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(64) NULL,
  company VARCHAR(255) NULL,
  subject VARCHAR(255) NULL,
  message TEXT NOT NULL,
  consent TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'new',
  data JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_enquiries_type (type),
  INDEX idx_enquiries_status (status),
  INDEX idx_enquiries_email (email),
  INDEX idx_enquiries_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function init() {
  if (pool) return pool;
  if (!initPromise) {
    initPromise = (async () => {
      if (!DB_USER || !DB_NAME) {
        throw new Error(
          'MySQL is not configured. Set DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME in .env (create the database in cPanel → MySQL Databases first).'
        );
      }

      console.log(
        `[store] connecting to MySQL ${DB_HOST}:${DB_PORT} as ${DB_USER} / ${DB_NAME}`
      );

      // Best effort: create the database when running locally as root.
      // On cPanel this typically fails (no CREATE privilege) — the database
      // is created in the cPanel UI instead, so the error is ignored.
      try {
        const bootstrap = await mysql.createConnection({
          host: DB_HOST,
          port: DB_PORT,
          user: DB_USER,
          password: DB_PASSWORD
        });
        await bootstrap.query(
          `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
        );
        await bootstrap.end();
      } catch (err) {
        console.warn('[store] could not auto-create database (ok on cPanel):', err.message);
      }

      pool = mysql.createPool({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 5,
        namedPlaceholders: true
      });

      try {
        await pool.query(ORDERS_SCHEMA);
        await pool.query(ENQUIRIES_SCHEMA);
      } catch (err) {
        console.error(
          `[store] failed to create/open tables on ${DB_HOST}/${DB_NAME}:`,
          err.code || '',
          err.message
        );
        throw err;
      }

      console.log(`[store] MySQL ready (${DB_HOST}/${DB_NAME}) — orders & enquiries tables OK`);
      return pool;
    })().catch((err) => {
      initPromise = null;
      pool = null;
      throw err;
    });
  }
  return initPromise;
}

/** Lightweight readiness check for /health. */
async function ping() {
  try {
    await init();
    await pool.query('SELECT 1');
    return { ok: true, host: DB_HOST, database: DB_NAME };
  } catch (err) {
    return {
      ok: false,
      host: DB_HOST,
      database: DB_NAME,
      user: DB_USER,
      error: err.message
    };
  }
}

function transformSensitiveOrderFields(order, transform) {
  const copy = JSON.parse(JSON.stringify(order));
  const id = String(copy.id || 'unknown');
  const apply = (target, field, label) => {
    if (target && target[field] != null && target[field] !== '') {
      target[field] = transform(target[field], `order:${id}:${label}`);
    }
  };

  apply(copy, 'access_token', 'access-token');
  apply(copy, 'provider_ref', 'provider-reference');
  apply(copy.buyer, 'first_name', 'buyer-first-name');
  apply(copy.buyer, 'last_name', 'buyer-last-name');
  apply(copy.buyer, 'email', 'buyer-email');
  apply(copy.buyer, 'phone', 'buyer-phone');
  apply(copy.payment, 'approval', 'payment-approval');
  apply(copy.enrolment, 'lms_login', 'lms-login');
  apply(copy.enrolment, 'lms_temp_password', 'lms-temporary-password');
  return copy;
}

function orderForStorage(order) {
  return transformSensitiveOrderFields(order, protect);
}

function rowToOrder(row) {
  const stored = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return transformSensitiveOrderFields(stored, unprotect);
}

async function createOrder({ buyer, course, provider }) {
  await init();
  const now = new Date().toISOString();
  const order = {
    id: crypto.randomUUID(),
    order_number: null, // assigned from auto-increment below
    status: 'pending_payment',
    access_token: crypto.randomBytes(24).toString('hex'),
    buyer,
    course,
    provider,
    provider_ref: null,
    payment: { status: 'initiated', paid_at: null, failure_reason: null },
    enrolment: {
      status: 'pending',
      talentlms_user_id: null,
      user_created: false,
      lms_login: null,
      lms_temp_password: null,
      attempts: 0,
      last_error: null,
      enrolled_at: null
    },
    events: [{ at: now, type: 'order_created', detail: `Order for course ${course.id}` }],
    created_at: now,
    updated_at: now
  };

  const [result] = await pool.execute(
    `INSERT INTO orders (id, order_number, status, buyer_email, course_id, provider, provider_ref, amount, currency, data)
     VALUES (?, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      order.id,
      order.status,
      blindIndex(buyer.email, 'order-buyer-email'),
      course.id,
      provider,
      course.amount,
      course.currency,
      JSON.stringify(orderForStorage(order))
    ]
  );

  order.order_number = `ES-${new Date().getFullYear()}-${String(result.insertId).padStart(6, '0')}`;
  await pool.execute(
    `UPDATE orders SET order_number = ?, data = ? WHERE id = ?`,
    [order.order_number, JSON.stringify(orderForStorage(order)), order.id]
  );

  return order;
}

async function getOrder(id) {
  await init();
  const [rows] = await pool.execute(`SELECT data FROM orders WHERE id = ?`, [id]);
  return rows.length ? rowToOrder(rows[0]) : null;
}

/**
 * Read-modify-write inside a transaction with a row lock, so concurrent
 * webhook retries / duplicate confirms cannot interleave updates.
 */
async function updateOrder(id, mutate) {
  await init();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(`SELECT data FROM orders WHERE id = ? FOR UPDATE`, [id]);
    if (!rows.length) {
      await conn.rollback();
      return null;
    }
    const order = rowToOrder(rows[0]);
    mutate(order);
    order.updated_at = new Date().toISOString();
    await conn.execute(
      `UPDATE orders
         SET status = ?, provider_ref = ?, data = ?
       WHERE id = ?`,
      [
        order.status,
        blindIndex(order.provider_ref, 'order-provider-reference'),
        JSON.stringify(orderForStorage(order)),
        id
      ]
    );
    await conn.commit();
    return order;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

function addEvent(order, type, detail) {
  order.events.push({ at: new Date().toISOString(), type, detail: detail || '' });
}

async function listOrders() {
  await init();
  const [rows] = await pool.query(`SELECT data FROM orders ORDER BY seq DESC LIMIT 500`);
  return rows.map(rowToOrder);
}

function rowToEnquiry(row) {
  const extra = row.data
    ? typeof row.data === 'string'
      ? JSON.parse(row.data)
      : row.data
    : {};
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    email: row.email,
    phone: row.phone || null,
    company: row.company || null,
    subject: row.subject || null,
    message: row.message,
    consent: Boolean(row.consent),
    status: row.status,
    data: extra,
    created_at:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updated_at:
      row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
  };
}

async function createEnquiry({
  type,
  name,
  email,
  phone,
  company,
  subject,
  message,
  consent,
  data
}) {
  await init();
  const id = crypto.randomUUID();
  const payload = data && typeof data === 'object' ? data : {};
  await pool.execute(
    `INSERT INTO enquiries (id, type, name, email, phone, company, subject, message, consent, status, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`,
    [
      id,
      String(type || 'general').trim(),
      String(name || '').trim(),
      String(email || '').trim().toLowerCase(),
      phone ? String(phone).trim() : null,
      company ? String(company).trim() : null,
      subject ? String(subject).trim() : null,
      String(message || '').trim(),
      consent ? 1 : 0,
      JSON.stringify(payload)
    ]
  );
  return getEnquiry(id);
}

async function getEnquiry(id) {
  await init();
  const [rows] = await pool.execute(`SELECT * FROM enquiries WHERE id = ?`, [id]);
  return rows.length ? rowToEnquiry(rows[0]) : null;
}

async function listEnquiries({ type, status, limit } = {}) {
  await init();
  const max = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const clauses = [];
  const params = [];
  if (type) {
    clauses.push('type = ?');
    params.push(String(type).trim());
  }
  if (status) {
    clauses.push('status = ?');
    params.push(String(status).trim());
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows] = await pool.query(
    `SELECT * FROM enquiries ${where} ORDER BY seq DESC LIMIT ${max}`,
    params
  );
  return rows.map(rowToEnquiry);
}

async function updateEnquiryStatus(id, status) {
  await init();
  const next = String(status || '').trim();
  if (!next) return null;
  await pool.execute(`UPDATE enquiries SET status = ? WHERE id = ?`, [next, id]);
  return getEnquiry(id);
}

module.exports = {
  init,
  ping,
  createOrder,
  getOrder,
  updateOrder,
  addEvent,
  listOrders,
  createEnquiry,
  getEnquiry,
  listEnquiries,
  updateEnquiryStatus
};
