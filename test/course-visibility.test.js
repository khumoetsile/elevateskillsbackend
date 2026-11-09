'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
process.env.NODE_ENV = 'test';
process.env.TALENTLMS_DOMAIN = 'lms.example.test';
process.env.TALENTLMS_API_KEY = 'mock-key';
process.env.BASE_PATH = '/backend';
process.env.CACHE_TTL_MS = '1000';
process.env.PAYMENT_PROVIDER = 'mock';
const { createVisibility } = require('../course-visibility');

function fixture() {
  let clock = 0;
  let fail = false;
  let branches = [{ id: 1 }, { id: '2' }];
  let details = { 1: { id: '1', courses: [{ id: 7 }] }, 2: { id: 2, courses: [{ id: '7' }, { id: 8 }] } };
  const calls = [];
  const client = { async get(path) {
    calls.push(path);
    if (fail) throw new Error('upstream unavailable');
    return { data: path === '/branches' ? branches : details[path.split(':')[1]] };
  } };
  return { policy: createVisibility({ client, ttl: 100, now: () => clock }), calls,
    tick: (value) => { clock = value; }, fail: () => { fail = true; },
    set: (list, values) => { branches = list; details = values; } };
}

test('branch courses stay private across status, category, sharing and catalog changes', async () => {
  const f = fixture();
  const ids = await f.policy.getPrivateIds();
  assert.deepEqual([...ids], ['7', '8']);
  for (const id of [7, '7', 8]) {
    for (const category_id of [undefined, '', '1', 'new-category']) {
      for (const status of ['active', 'inactive']) {
        assert.equal(f.policy.isPublic({ id, status, category_id, shared: '1', hide_from_catalog: '0' }, ids), false);
      }
    }
  }
  assert.equal(f.policy.isPublic({ id: 9, status: 'active' }, ids), true);
  assert.equal(f.policy.isPublic({ id: 9, status: 'inactive' }, ids), false);
  for (const hide_from_catalog of ['1', 1, true]) {
    assert.equal(f.policy.isPublic({ id: 9, hide_from_catalog }, ids), false);
  }
  assert.equal(f.policy.isPublic({}, ids), false);
});

test('valid cache works during outage; expired cache fails closed and refresh recovers', async () => {
  const f = fixture();
  await Promise.all([f.policy.getPrivateIds(), f.policy.getPrivateIds()]);
  assert.equal(f.calls.length, 3);
  f.fail();
  f.tick(99);
  assert.equal((await f.policy.getPrivateIds()).has('7'), true);
  f.tick(100);
  await assert.rejects(f.policy.getPrivateIds(), { code: 'course_visibility_unavailable' });
  await assert.rejects(f.policy.getPrivateIds(), { code: 'course_visibility_unavailable' });
});

test('membership changes take effect on expiry; empty branches are valid', async () => {
  const f = fixture();
  await f.policy.getPrivateIds();
  f.set([{ id: 3 }], { 3: { id: 3, courses: [{ id: 9 }] } });
  f.tick(100);
  assert.deepEqual([...(await f.policy.getPrivateIds())], ['9']);
  f.set([], {});
  f.tick(200);
  assert.equal((await f.policy.getPrivateIds()).size, 0);
});

test('malformed and partial branch responses fail closed without publishing a snapshot', async () => {
  for (const [list, details] of [
    [{ error: 'denied' }, {}], [[{}], {}],
    [[{ id: 1 }], { 1: { id: 1 } }],
    [[{ id: 1 }], { 1: { id: 2, courses: [] } }],
    [[{ id: 1 }], { 1: { id: 1, courses: [{}] } }],
    [[{ id: 1 }, { id: 2 }], { 1: { id: 1, courses: [{ id: 7 }] } }]
  ]) {
    const f = fixture();
    f.set(list, details);
    await assert.rejects(f.policy.getPrivateIds(), { code: 'course_visibility_unavailable' });
    f.set([], {});
    assert.equal((await f.policy.getPrivateIds()).size, 0);
  }
});

test('refresh taking the entire TTL is rejected', async () => {
  let clock = 0;
  const policy = createVisibility({ ttl: 100, now: () => clock,
    client: { async get() { clock = 100; return { data: [] }; } } });
  await assert.rejects(policy.getPrivateIds(), { code: 'course_visibility_unavailable' });
});

test('HTTP listings, categories, direct IDs and checkout enforce privacy at root and cPanel paths', async (t) => {
  const originalCreate = axios.create;
  const calls = [];
  const courses = [
    { id: '7', name: 'Private', status: 'active', category_id: '1' },
    { id: '9', name: 'Public', status: 'active', category_id: '1', price: '&#36;10' },
    { id: '10', status: 'inactive' }, { id: '11', hide_from_catalog: '1' }
  ];
  axios.create = () => ({ async get(path) {
    calls.push(path);
    if (path === '/branches') return { data: [{ id: 1 }] };
    if (path === '/branches/id:1') return { data: { id: 1, courses: [{ id: 7 }] } };
    if (path === '/categories') return { data: [{ id: 1, name: 'Shared Category' }] };
    if (path === '/courses') return { data: courses };
    return { data: courses.find((c) => c.id === path.split(':')[1]) };
  } });
  delete require.cache[require.resolve('../course-visibility')];
  const app = require('../server');
  axios.create = originalCreate;
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const prefix of ['', '/backend']) {
    const response = await fetch(`${base}${prefix}/api/talentlms/courses?category=shared-category`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const list = await response.json();
    assert.deepEqual(list.map((c) => c.id), ['9']);
    assert.equal(list[0].category_slug, 'shared-category');
    assert.equal(list[0].price, '$10');
    assert.equal((await fetch(`${base}${prefix}/api/talentlms/categories`)).status, 200);
    for (const id of ['7', '10', '11']) {
      assert.equal((await fetch(`${base}${prefix}/api/talentlms/courses/${id}`)).status, 404);
    }
    assert.equal((await fetch(`${base}${prefix}/api/talentlms/courses/9`)).status, 200);
  }
  const purchase = await fetch(`${base}/api/checkout/create`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId: '7', firstName: 'Test', lastName: 'Learner', email: 'test@example.com', consent: true }) });
  assert.equal(purchase.status, 404);
  assert.equal(calls.filter((path) => path === '/branches').length, 1);
  // Force visibility failure independently of cached catalog/detail responses.
  const visibility = require('../course-visibility');
  visibility.getPrivateIds = async () => { const error = new Error('Unavailable'); error.code = 'course_visibility_unavailable'; throw error; };
  for (const path of ['/api/talentlms/courses', '/backend/api/talentlms/courses/9']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'course_visibility_unavailable');
  }
});
