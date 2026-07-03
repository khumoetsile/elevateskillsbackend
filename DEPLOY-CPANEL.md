# Deploy backend to cPanel (elevateskills.online/backend)

Frontend: https://elevateskills.online/  
Backend API base: https://elevateskills.online/backend

## 1. Upload files

In **File Manager**, create a folder for the Node app (not inside `public_html`):

```
/home/YOUR_USER/backend
```

Upload everything from `talentlms-proxy/` **except**:

- `node_modules/`
- `.env` (use cPanel environment variables instead)

Required files: `server.js`, `package.json`, `package-lock.json`

## 2. Setup Node.js App (cPanel)

| Field | Value |
| ----- | ----- |
| **Node.js version** | **18.x or 20.x** (do not use 10.x) |
| **Application mode** | **Production** |
| **Application root** | `backend` (full path shown by cPanel, e.g. `/home/elevate/backend`) |
| **Application URL** | Domain: `elevateskills.online` → path: **`backend`** |
| **Application startup file** | **`server.js`** |

Click **CREATE**, then **Run NPM Install**, then **Restart**.

## 3. Environment variables

In the Node.js app screen, click **ADD VARIABLE** for each:

| Name | Value |
| ---- | ----- |
| `TALENTLMS_DOMAIN` | `elevateskillsadmin.talentlms.com` |
| `TALENTLMS_API_KEY` | your TalentLMS API key |
| `PUBLIC_LMS_URL` | `https://elevateskillsadmin.talentlms.com` |
| `ALLOWED_ORIGINS` | `https://elevateskills.online` |
| `BASE_PATH` | `/backend` |
| `NODE_ENV` | `production` |
| `CACHE_TTL_MS` | `300000` |

Restart the app after saving variables.

## 4. Verify backend

Open in a browser:

- https://elevateskills.online/backend/health  
  → should return `{"ok":true,...}`

- https://elevateskills.online/backend/api/talentlms/courses  
  → should return a JSON array of courses

If `/backend/health` works but `/health` does not, that is expected.

## 5. Redeploy frontend

Production Angular must call `/backend/api/talentlms/*`. Rebuild and upload:

```bash
cd elevate-skills-web
npm run build
```

Upload contents of `dist/elevate-skills-web/browser/` to your site `public_html` (or wherever the live site is served from).

## Troubleshooting

| Problem | Fix |
| ------- | --- |
| **npm install error: content type text/plain → text/html** | Usually a **false alarm** — npm often still installed. Fix the `/backend` routing conflict below, then click **Restart**. |
| **`/backend` shows the Angular homepage** | **Delete `public_html/backend/`** if you created it manually. Only `/home/elevates/backend/` should hold Node files. cPanel creates the public `/backend` URL automatically. |
| **503 / empty courses** | Check `TALENTLMS_DOMAIN` and `TALENTLMS_API_KEY` in env vars |
| **CORS error in browser** | Set `ALLOWED_ORIGINS=https://elevateskills.online` |
| **404 on `/backend/...`** | Confirm Application URL path is `backend` and app is **Restart**ed |
| **App won't start** | Use Node 18+, run **NPM Install**, check cPanel error log |
| **Courses work in browser URL but not on site** | Rebuild frontend after `environment.prod.ts` change |

### Critical: two different `backend` folders

```
/home/elevates/backend/          ← Node app files go HERE (server.js, package.json)
/home/elevates/public_html/      ← Angular site only (index.html, chunks)
```

**Never** upload Node files into `public_html/backend/`. That blocks the real Node app and causes the npm install content-type warning.
