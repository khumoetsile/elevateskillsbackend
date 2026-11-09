# Deploy to cPanel (elevateskills.online)

Frontend: https://elevateskills.online/  
Backend API: https://elevateskills.online/backend

Ready-to-upload packages (after local build):

| Package | Upload to |
| ------- | --------- |
| `deploy/frontend-public_html.zip` | Extract into `public_html/` |
| `deploy/backend-cpanel.zip` | Extract into `/home/YOUR_USER/backend/` (NOT inside `public_html`) |

## 1. Upload frontend

1. In cPanel **File Manager**, open `public_html`.
2. Optional: back up the current site (download a zip of `public_html`).
3. Upload `frontend-public_html.zip` and **Extract**.
4. Confirm `index.html`, `main-*.js`, `.htaccess` are in `public_html` (not a nested subfolder).
5. **Delete** `public_html/backend/` if it exists as a static folder — it blocks the Node app.

## 2. Upload backend

1. Create `/home/YOUR_USER/backend` if needed (sibling of `public_html`, not inside it).
2. Upload `backend-cpanel.zip` and extract there.
3. Required files include: `server.js`, `package.json`, `package-lock.json`, `auth.js`, `session.js`, `security.js`, `store.js`, `checkout.js`, `fulfilment.js`, `mail.js`, `payments.js`, `schema.sql`.
4. Do **not** upload local `.env` — use cPanel environment variables below.

## 3. Setup Node.js App (cPanel)

| Field | Value |
| ----- | ----- |
| **Node.js version** | **18.x or 20.x** |
| **Application mode** | **Production** |
| **Application root** | `backend` |
| **Application URL** | Domain `elevateskills.online` → path **`backend`** |
| **Application startup file** | **`server.js`** |

Then: **CREATE** → **Run NPM Install** → **Restart**.

## 4. Environment variables

In the Node.js app screen, set:

| Name | Value |
| ---- | ----- |
| `NODE_ENV` | `production` |
| `BASE_PATH` | `/backend` |
| `TALENTLMS_DOMAIN` | `lms.elevateskills.online` |
| `TALENTLMS_API_KEY` | *(your TalentLMS API key)* |
| `PUBLIC_LMS_URL` | `https://lms.elevateskills.online` |
| `ALLOWED_ORIGINS` | `https://elevateskills.online` |
| `SITE_URL` | `https://elevateskills.online` |
| `PUBLIC_API_URL` | `https://elevateskills.online/backend` |
| `TRUST_PROXY` | `1` |
| `SESSION_SECRET` | *(long random string)* |
| `COOKIE_SECURE` | `true` |
| `CACHE_TTL_MS` | `300000` |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `3306` |
| `DB_USER` | *(cPanel MySQL user)* |
| `DB_PASSWORD` | *(cPanel MySQL password)* |
| `DB_NAME` | *(cPanel MySQL database)* |
| `PAYMENT_PROVIDER` | `dpo` *(use `mock` only for local development)* |
| `CHECKOUT_CURRENCY` | `BWP` |
| `DPO_API_URL` | `https://secure.3gdirectpay.com/API/v6/` |
| `DPO_PAYMENT_URL` | `https://secure.3gdirectpay.com/payv3.php` |
| `DPO_ALLOWED_HOSTS` | `secure.3gdirectpay.com` |
| `DPO_COMPANY_TOKEN` | *(DPO-issued production Company Token — set directly in cPanel, never commit it)* |
| `DPO_SERVICE_TYPE` | `113853` *(Educational Services — confirmed production value)* |
| `DPO_DEFAULT_PAYMENT` | `CC` |
| `DPO_PAYMENT_TTL_MINUTES` | `30` |
| `DPO_TIMEOUT_MS` | `15000` |
| `DPO_RETURN_SECRET` | *(a separate random secret of at least 32 bytes)* |
| `DATA_ENCRYPTION_KEY` | *(exactly 32 random bytes, base64 encoded)* |
| `ADMIN_API_KEY` | *(strong random key for /admin/enquiries)* |
| `CONTACT_EMAIL_TO` | `help@elevateskills.online` |
| `SALES_EMAIL_TO` | `sales@elevateskills.online` |
| `INTEREST_EMAIL_TO` | *(your sales/ops inbox)* |
| `SMTP_HOST` | *(e.g. smtp.office365.com)* |
| `SMTP_PORT` | `587` |
| `SMTP_SECURE` | `false` |
| `SMTP_USER` | *(mailbox)* |
| `SMTP_PASS` | *(mailbox password / app password)* |
| `EMAIL_FROM` | `Elevate Skills <noreply@elevateskills.online>` |

Restart the app after saving variables.

`DATA_ENCRYPTION_KEY` encrypts order access tokens, DPO transaction references,
learner identity fields, and temporary LMS credentials using AES-256-GCM. Back it
up in the organisation's password manager before accepting payments. Losing or
changing this key makes existing encrypted orders unreadable.

The sandbox Company Token must be replaced with DPO-issued production credentials
after UAT. Never add either token to the frontend, a public repository, screenshots,
or browser-side configuration.

### Production cutover checklist (DPO)

DPO v6 uses the same API/payment host for sandbox and production — only the
Company Token, service type, and return-signing secret change:

1. In cPanel → **Setup Node.js App** → your app → **Environment variables**,
   update (do **not** edit `env.cpanel.template` or any git-tracked file with
   real secrets):
   - `DPO_COMPANY_TOKEN` → the production Company Token DPO issued.
   - `DPO_SERVICE_TYPE` → `113853` (Educational Services).
   - `DPO_RETURN_SECRET` → a freshly generated random secret (≥32 bytes),
     different from the sandbox one, so old sandbox-signed return links can't
     be replayed.
2. Leave `DATA_ENCRYPTION_KEY` **unchanged** — rotating it makes every
   already-encrypted order (including past sandbox ones) unreadable.
3. Leave `DPO_API_URL`, `DPO_PAYMENT_URL`, and `DPO_ALLOWED_HOSTS` as-is;
   DPO does not use separate production endpoints.
4. **Restart** the Node app.
5. Verify `/backend/health` still reports `"dpo_configured":true`, then run
   one real low-value production transaction end-to-end before announcing
   go-live.

## 5. MySQL

If the DB is new, ensure the user has privileges, then start the app once so tables are created (`store.js` / `schema.sql`), or import `schema.sql` via phpMyAdmin.

## 6. Verify

- https://elevateskills.online/backend/health → `{"ok":true,...}`
- Confirm health reports `"payment_provider":"dpo"`,
  `"payment_encryption_configured":true`, and `"dpo_configured":true`.
- https://elevateskills.online/backend/api/talentlms/courses → JSON courses
- https://elevateskills.online/ → site loads
- https://elevateskills.online/policies → policies hub
- https://elevateskills.online/login → site login works (cookie session)

## LMS custom domain migration

Set `TALENTLMS_DOMAIN=lms.elevateskills.online` and
`PUBLIC_LMS_URL=https://lms.elevateskills.online` in the existing cPanel Node.js
app environment (these override uploaded `.env` values), then restart the app.
Upload the rebuilt frontend so login, registration and course links use the new
portal. Existing API keys and payment secrets must be preserved.

DPO checkout still runs through the website backend:
`SITE_URL=https://elevateskills.online` and
`PUBLIC_API_URL=https://elevateskills.online/backend`. Its signed RedirectURL and
BackURL use `https://elevateskills.online/backend/api/payments/dpo/return` with
per-order query parameters. Do not point these at the hosted LMS: it does not
run the payment verification route. DPO's API/payment hosts, company token and
service type are unchanged by the LMS domain migration. Paid-course enrolment
uses the new `TALENTLMS_DOMAIN`; enrolment emails use `PUBLIC_LMS_URL`.

After deployment, check `/backend/health` reports the new `public_lms_url`, check
site login and course links, and complete a low-value payment to verify DPO
return, payment verification, enrolment and the email's LMS link.

## Troubleshooting

| Problem | Fix |
| ------- | --- |
| `/backend` shows Angular homepage | Delete `public_html/backend/` |
| CORS / login cookie fails | `ALLOWED_ORIGINS=https://elevateskills.online`, `COOKIE_SECURE=true`, `SITE_URL=https://elevateskills.online` |
| 503 / empty courses | Check TalentLMS domain + API key |
| App won't start | Node 18+, NPM Install, check error log |
| Nested extract folder | Move files up so `index.html` / `server.js` are not inside an extra zip folder |

### Folder layout

Corporate-course filtering also requires uploading `course-visibility.js` beside
`server.js` and `checkout.js`. Keep Node 18+ and the existing startup file and
`BASE_PATH=/backend`. The existing `TALENTLMS_API_KEY` must be able to read
`/api/v1/branches` and every `/api/v1/branches/id:{branchId}` including its courses.
All branch-assigned courses are private; no branch IDs/names need configuring.
`CACHE_TTL_MS=300000` also controls branch visibility freshness. Restart the Node
app after an approved deployment/configuration change to clear in-memory caches.
If branch verification fails after expiry, course requests return 503 rather than
exposing unverified courses. Verify root and `/backend` listings, public/private
direct IDs and category views after deployment. No production deployment was
performed as part of this change. See README for cache and frontend limitations.

```
/home/YOUR_USER/backend/          ← Node app (server.js, package.json)
/home/YOUR_USER/public_html/      ← Angular only (index.html, chunks, .htaccess)
```
