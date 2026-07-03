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
  "lms_url": "https://elevateskillsadmin.talentlms.com/catalog/info/id:12"
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
| `TALENTLMS_DOMAIN`   | Your `*.talentlms.com` subdomain (e.g. `elevateskills.talentlms.com`) |
| `TALENTLMS_API_KEY`  | API key from TalentLMS → Account & Settings → Basic settings → API |
| `PUBLIC_LMS_URL`     | Learner portal URL for login/register/course links (e.g. `https://elevateskillsadmin.talentlms.com`) |
| `ALLOWED_ORIGINS`    | Comma-separated origins allowed to call the proxy                |
| `CACHE_TTL_MS`       | TalentLMS response cache TTL in ms (default 300000 = 5 min)      |
| `PORT`               | Proxy port (default 4000)                                        |

## Production notes

- Run behind HTTPS only.
- Set `ALLOWED_ORIGINS` to your real frontend origin (no wildcard).
- The TalentLMS API is rate-limited (200 req / 5s, 2k–10k / hour depending on plan).
  The cache here keeps us comfortably under that for normal traffic.
- TalentLMS requires HTTPS; this proxy already enforces that for upstream calls.

## How the frontend talks to it

In dev, the Angular app uses `proxy.conf.json` to forward `/api/talentlms/*`
to `http://localhost:4000`. In production, deploy this proxy somewhere
reachable from the frontend and set the same path on your CDN / reverse proxy
(e.g. Nginx, Cloudflare Worker, Vercel rewrite) so the frontend keeps calling
`/api/talentlms/*` as a same-origin request.
