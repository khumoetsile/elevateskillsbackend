'use strict';

const axios = require('axios');

class VisibilityUnavailable extends Error {
  constructor() {
    super('Unable to verify public course visibility. Please try again later.');
    this.code = 'course_visibility_unavailable';
  }
}

function validId(value) {
  return /^(0|[1-9]\d*)$/.test(String(value ?? ''));
}

function createVisibility({ client, ttl, now = Date.now }) {
  let snapshot;
  let pending;

  async function refresh() {
    const at = now();
    const { data: branches } = await client.get('/branches');
    if (!Array.isArray(branches)) throw new VisibilityUnavailable();
    const privateIds = new Set();
    // Sequential requests avoid an unbounded burst against the v1 rate limit.
    for (const branch of branches) {
      if (!validId(branch?.id)) throw new VisibilityUnavailable();
      const { data } = await client.get(`/branches/id:${branch.id}`);
      if (String(data?.id) !== String(branch.id) || !Array.isArray(data?.courses)) {
        throw new VisibilityUnavailable();
      }
      for (const course of data.courses) {
        if (!validId(course?.id)) throw new VisibilityUnavailable();
        privateIds.add(String(course.id));
      }
    }
    // Publish only a complete snapshot; never extend its age by the refresh duration.
    if (now() - at >= ttl) throw new VisibilityUnavailable();
    snapshot = { at, privateIds };
    return snapshot;
  }

  async function getPrivateIds() {
    if (snapshot && now() - snapshot.at < ttl) return snapshot.privateIds;
    if (!pending) {
      pending = refresh().catch(() => { throw new VisibilityUnavailable(); })
        .finally(() => { pending = undefined; });
    }
    return (await pending).privateIds;
  }

  function isPublic(course, privateIds) {
    return validId(course?.id) && !privateIds.has(String(course.id)) &&
      (course.status ?? 'active') === 'active' &&
      !['1', 1, true].includes(course.hide_from_catalog);
  }

  return { getPrivateIds, isPublic };
}

const visibility = createVisibility({
  client: axios.create({
    baseURL: `https://${(process.env.TALENTLMS_DOMAIN || '').trim()}/api/v1`,
    timeout: 15000,
    auth: { username: (process.env.TALENTLMS_API_KEY || '').trim(), password: '' },
    headers: { Accept: 'application/json' }
  }),
  ttl: parseInt(process.env.CACHE_TTL_MS, 10) || 5 * 60 * 1000
});

module.exports = { ...visibility, createVisibility };
