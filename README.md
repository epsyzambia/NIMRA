# NIMRA on Cloudflare (GitHub Pages + Workers + TiDB Cloud Serverless)

```
 yourdomain.com / app.yourdomain.com      api.yourdomain.com
 yourdomain.com / app.yourdomain.com      api.yourdomain.com
 ┌──────────────────────────┐   fetch     ┌────────────────────────┐  HTTPS  ┌──────────────────┐
 │ GitHub Pages: site/      │ ──────────▶ │ Cloudflare Worker      │ ──────▶ │ TiDB Cloud       │
 │ Bootstrap 5 + plain JS   │  (cookie)   │ worker/src/index.js    │         │ Serverless (MySQL│
 └──────────────────────────┘             └────────────────────────┘         │ compatible, free)│
                                                                             └──────────────────┘
```
GitHub Pages can only host static files, so all logic (sign-in, rules, database, files) runs in the Worker.

## What is in this first version (core)
Sign-in with phone + PIN and roles **Admin / Institution / Supplier** · accounts (admin) · notify a procurement · supplier records items (cost, price, **barcode optional**) · **institution supplier-margin limit** (blocks prices above it) · admin **reviews, approves or returns with comments** · reference prices (always per single item) with **PDF research stored in the database** · institution is told **NIMRA is researching** after the supplier adds items · notifications · **wastage page with waste and margin per supplier and a year filter that rolls over by itself** · audit log.

Not yet moved from the ASP.NET version: wallet and ledger, invoice discounting, surveillance, newsletter, help desk, cartels/blacklist, auctions, agents, training. They are planned as the next rounds, in this same Worker.

## Deploy, step by step
You need: a domain on Cloudflare DNS (Free plan is fine, no card), a GitHub repo, Node 18+, and a **TiDB Cloud Starter** cluster (free, no card). No Hyperdrive and no R2 are used, so nothing here needs billing.

1. **Put this folder in a GitHub repo** (`main` branch).
2. **Create the tables.** In TiDB Cloud open *SQL Editor* and run `CREATE DATABASE nimra; USE nimra;` then paste and run all of `worker/migrations/0001_init.sql`. `SHOW TABLES;` should list 13 tables.
3. **Give the Worker the database address.** In TiDB Cloud click *Connect → General*, generate a password, and open the cluster's network settings so connections are allowed (the driver talks HTTPS from Cloudflare's servers). Then, in `worker/`:
   ```
   npm install
   npx wrangler login
   npx wrangler secret put DATABASE_URL
   ```
   Paste: `mysql://USER:PASSWORD@HOST/nimra` (USER looks like `abc123xyz.root`; no port; encode special characters in the password, e.g. `@` = `%40`). In the Cloudflare dashboard the same thing is *Worker → Settings → Variables and Secrets → Add → Secret*.
   Then edit `worker/wrangler.toml`: `ALLOWED_ORIGINS` = `https://app.yourdomain.com`, `COOKIE_DOMAIN` = `.yourdomain.com`, and the `routes` pattern `api.yourdomain.com`.
4. **Secret for the first admin**: `npx wrangler secret put SETUP_TOKEN` (any long random text), then `npx wrangler deploy`. (A Worker made in the dashboard works too: paste `worker/src/*.js` is not enough because of the driver, so deploy with wrangler or the GitHub workflow.)
5. **Create the first admin** (works once, only while there are no users):
   ```
   curl -X POST https://api.yourdomain.com/api/setup -H 'content-type: application/json' \
     -d '{"token":"YOUR_SETUP_TOKEN","name":"Your name","phone":"0971234567","pin":"123456"}'
   ```
   Then remove the secret: `npx wrangler secret delete SETUP_TOKEN`.
6. **Publish the site**: repo *Settings → Pages → Source: GitHub Actions*; *Settings → Secrets and variables → Actions → Variables*: `API_URL = https://api.yourdomain.com`. Push to `main` (workflow `.github/workflows/pages.yml`). In *Settings → Pages* set the custom domain `app.yourdomain.com`, tick *Enforce HTTPS*, and add the DNS record `app` CNAME → `<your-github-user>.github.io` (grey cloud / DNS only).
7. *(optional)* Auto-deploy the API from GitHub: add secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (workflow `worker.yml`).

The site and the API must share the same parent domain (`app.` and `api.` of `yourdomain.com`): the sign-in cookie is `HttpOnly; Secure; SameSite=Lax; Domain=.yourdomain.com`.

## Try it on your computer first (no Cloudflare account needed)
```
cd worker
npm run test     # 33 checks of the real API code. A fake database connection (SQLite underneath) stands in for TiDB
npm run demo     # site http://localhost:8080  (admin 0971000000/1234, institution 0972000001/2222, supplier 0973000001/3333)
```
(Needs Node 22+ for the `node:sqlite` stand-in. Deployed Workers do not need it. **This does not test TiDB itself**: the first real run is when you sign in to the deployed site. If a query fails, `npx wrangler tail` shows the database error.)

## How the old rules were carried over
| Rule | Here |
|---|---|
| Barcodes not mandatory | optional; if given, 8 to 14 digits |
| Institution supplier margin limit | `institution_settings.margin_limit_percent`, falls back to global `MarkupMaxPercent` (30). Items priced over `cost × (1 + limit)` are refused with the item named |
| Admin returns with comments | `POST /api/notices/:id/return`; supplier and institution notified; supplier edits and resubmits |
| Reference price is for ONE item | stated on every price form and table; stored as `unit_price` |
| PDF with research | multipart upload, PDF only, 2 MB, stored in the `price_files` table as hex over HTTP (no file-storage service, no card needed), downloaded through the API (sign-in required; unpublished files are admin-only) |
| Waste and margin | waste = (price − market price) × qty when above market; margin = (price − cost) × qty. Market price = average of published reference prices with the same item name |
| Year filter | defaults to the current year computed per request, so it rolls over on 1 January; other years via chips |
| Lock-out | 5 wrong PINs lock a phone for 15 minutes |

## Assumptions
- Money is `DECIMAL(18,2)`, quantities `DECIMAL(18,3)`; times are stored in UTC. Item-name matching is case-insensitive because the tables use `utf8mb4_unicode_ci`. Multi-step changes (items, approve, return, complete, cancel) run in a real transaction.
- A procurement has one supplier chosen by the institution (as before); the supplier's recorded items replace the old price-request step.
- The market price for a line matches by item name (case-insensitive). Barcode matching can be added when barcodes are common.
- Phone numbers are normalised to Zambian format (`0971…` = `260971…`).
- Files are never public: even published PDFs need a signed-in user.
- Existing data from SQL Server is not migrated; start fresh or ask for an export script.

## Cost note
Workers Free and TiDB Cloud Starter need no card and cover a pilot (check current limits); GitHub Pages is free for public repos (private repos need a paid GitHub plan). Check current Cloudflare pricing before launch.
