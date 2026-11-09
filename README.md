# TalentLMS Proxy (Elevate Skills)

A tiny Node + Express service that sits between the Elevate Skills frontend and TalentLMS.
Its only job is to keep the TalentLMS API key off the browser, expose a clean JSON shape
for courses & categories, and short-circuit a small in-memory cache so we don't hammer
TalentLMS on every page view.

> Auth (login / register / progress / certificates) is handled entirely by TalentLMS.
> The proxy only exposes course/category data and LMS URL config for the frontend.

## Endpoints

- `GET /health` – sanity check (does not call TalentLMS)
- `GET /api/talentlms/config` – public LMS URLs (login, register, catalog pattern)
- `GET /api/talentlms/categories` – flattened category list with slugs
- `GET /api/talentlms/courses` – active, catalog-visible courses, normalized
- `GET /api/talentlms/courses/:id` – single course by TalentLMS course id

Each course is returned as:

```json
{
  "id": "12",
  "name": "Intro to TalentLMS",
  "code": "",
  "description": "A short introduction to TalentLMS",
  "price": "$0",
  "status": "active",
  "level": "1",
  "image": "https://.../big_avatar.png",
  "category_id": "3",
  "category_slug": "samples",
  "shared": false,
  "shared_url": "",
  "hide_from_catalog": false,
  "certification": "Classic",
  "certification_duration": "Forever",
  "creation_date": "15/01/2013, 12:46:30",
  "lms_url": "https://lms.elevateskills.online/catalog/info/id:12"
}
```

## Setup

```bash
cd talentlms-proxy
cp .env.example .env       # then fill in TALENTLMS_DOMAIN + TALENTLMS_API_KEY
npm install
npm run dev
```

Server listens on `http://localhost:4000` by default.

### Required env

| Variable             | Description                                                      |
| -------------------- | ---------------------------------------------------------------- |
| `TALENTLMS_DOMAIN`   | Your LMS hostname without protocol (e.g. `lms.elevateskills.online`) |
| `TALENTLMS_API_KEY`  | API key from TalentLMS → Account & Settings → Basic settings → API |
| `PUBLIC_LMS_URL`     | Learner portal URL for login/register/course links (e.g. `https://lms.elevateskills.online`) |
| `ALLOWED_ORIGINS`    | Comma-separated origins allowed to call the proxy                |
| `CACHE_TTL_MS`       | TalentLMS response cache TTL in ms (default 300000 = 5 min)      |
| `PORT`               | Proxy port (default 4000)                                        |

## Production notes

### Corporate course visibility

All courses assigned to **any** TalentLMS branch are private on this website.
There is no existing public-branch configuration and no branch IDs or names are
hardcoded. Branch status, course categories, sharing and catalog settings cannot
override this restriction. Courses must also pass the existing active and
catalog-visible checks. No TalentLMS course or learner assignments are changed.

The backend reads `GET /api/v1/branches`, then
`GET /api/v1/branches/id:{branchId}` for each branch, and unions the course IDs
from each detail response's `courses` array. See the
[TalentLMS v1 reference](https://market.talentlms.com/pages/docs/TalentLMS-API-Documentation.pdf).
The entire snapshot is cached atomically using `CACHE_TTL_MS` (default 300000).
Concurrent refreshes share one request sequence. Branch details are fetched
sequentially to avoid an unbounded request burst.

Listings (including lists used for client-side category filtering) exclude these
IDs. Direct requests for private, inactive or catalog-hidden courses return 404.
Public checkout rejects private IDs before account lookup and rechecks visibility
after course lookup. Corporate learners' authenticated TalentLMS access and
existing order fulfilment are unchanged. Categories retain their existing array
contract, including categories with no public courses; they contain no course data.

Failed, malformed or incomplete branch responses never become an empty allow-all
snapshot. A previously verified snapshot can be used only while it is still within
the TTL. After expiry, catalog/detail/checkout requests return 503 with
`course_visibility_unavailable` if verification fails. No stale fallback is used.
Catalog endpoints send `Cache-Control: no-store` to prevent additional HTTP caching.

Production requires `TALENTLMS_DOMAIN`, `TALENTLMS_API_KEY` with access to both
branch endpoints and all branches, and the existing `CACHE_TTL_MS`. No new secrets,
packages, database changes or branch environment variables are needed. Newly
assigned/removed branch memberships can take up to the TTL to become visible to
the backend; restart the Node app to clear its in-memory caches when an immediate
change is needed. Already loaded browser pages can retain their existing data.
Large branch inventories or rate limits may prevent a full refresh within the
TTL; requests then fail closed. Choose a TTL appropriate to the inventory and
acceptable propagation delay.

Run `npm test` for mocked policy and HTTP tests; no live TalentLMS, database,
payments or Docker are needed. Live API credentials/permissions and production
branch payloads have not been verified by these tests.

Frontend limitation outside this repository: the inspected Angular
`course.service.ts` substitutes `MOCK_COURSES` when the backend returns an error
or an empty catalog, and can fall back to the loaded list for a failed direct
lookup. The backend never returns private course data, but that separate frontend
should remove those fallbacks for strict public-site fail-closed behavior.
Its `shareReplay` cache also requires a page reload to fetch updated visibility.

- Run behind HTTPS only.
- Set `ALLOWED_ORIGINS` to your real frontend origin (no wildcard).
- The TalentLMS API is rate-limited (200 req / 5s, 2k–10k / hour depending on plan).
  The cache here keeps us comfortably under that for normal traffic.
- TalentLMS requires HTTPS; this proxy already enforces that for upstream calls.

## DPO Pay checkout

Set `PAYMENT_PROVIDER=dpo` to enable the DPO Pay v6 hosted checkout. The backend
creates a transaction with `createToken`, redirects the learner to DPO, and calls
`verifyToken` server-to-server before enrolment. Browser return parameters are
never accepted as proof of payment.

Required server-side settings are `SITE_URL`, `PUBLIC_API_URL`,
`DPO_COMPANY_TOKEN`, `DPO_SERVICE_TYPE`, `DPO_RETURN_SECRET`, and
`DATA_ENCRYPTION_KEY`. See `env.cpanel.template` for the complete list. The DPO
Company Token and encryption keys must never be added to Angular environment files.

Run `npm test` before deployment. The tests cover signed return URLs, XML escaping,
strict amount/currency verification, pending-payment handling, HTTPS enforcement,
and authenticated encryption.

After entering sandbox environment variables, run `DPO_SMOKE_TEST=true npm run
test:dpo` to create one BWP 1.00 sandbox transaction without printing the returned
transaction token. This smoke test never submits card data.

### Testing DPO from a local machine

The frontend may run at `http://localhost:4200`, but DPO rejects localhost
`RedirectURL` and `BackURL` values. Expose the local backend through a temporary
public HTTPS tunnel and set `PUBLIC_API_URL` to that tunnel URL. Keep `SITE_URL`
as `http://localhost:4200`; after DPO returns through the tunnel, the backend
redirects the same browser to the local Angular result page. Never expose MySQL,
the `.env` file, or any admin endpoint through the tunnel.

## How the frontend talks to it

In dev, the Angular app uses `proxy.conf.json` to forward `/api/talentlms/*`
to `http://localhost:4000`. In production, deploy this proxy somewhere
reachable from the frontend and set the same path on your CDN / reverse proxy
(e.g. Nginx, Cloudflare Worker, Vercel rewrite) so the frontend keeps calling
`/api/talentlms/*` as a same-origin request.
