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

const DB_HOST = (process.env.DB_HOST || 'localhost').trim();
const DB_PORT = parseInt(process.env.DB_PORT, 10) || 3306;
const DB_USER = (process.env.DB_USER || 'root').trim();
const DB_PASSWORD = process.env.DB_PASSWORD ?? '';
const DB_NAME = (process.env.DB_NAME || 'elevatekills').trim();

let pool = null;
let initPromise = null;

const SCHEMA = `
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
        await pool.query(SCHEMA);
      } catch (err) {
        console.error(
          `[store] failed to create/open tables on ${DB_HOST}/${DB_NAME}:`,
          err.code || '',
          err.message
        );
        throw err;
      }

      console.log(`[store] MySQL ready (${DB_HOST}/${DB_NAME}) — orders table OK`);
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

function rowToOrder(row) {
  const order = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return order;
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
      buyer.email,
      course.id,
      provider,
      course.amount,
      course.currency,
      JSON.stringify(order)
    ]
  );

  order.order_number = `ES-${new Date().getFullYear()}-${String(result.insertId).padStart(6, '0')}`;
  await pool.execute(
    `UPDATE orders SET order_number = ?, data = ? WHERE id = ?`,
    [order.order_number, JSON.stringify(order), order.id]
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
      [order.status, order.provider_ref, JSON.stringify(order), id]
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

module.exports = { init, ping, createOrder, getOrder, updateOrder, addEvent, listOrders };
