# NIMRA on Cloudflare (GitHub Pages + Workers + Hyperdrive + MySQL)

```
 yourdomain.com / app.yourdomain.com      api.yourdomain.com
 ┌──────────────────────────┐   fetch     ┌────────────────────────┐   ┌─────────────┐
 │ GitHub Pages: site/      │ ──────────▶ │ Cloudflare Worker      │──▶│ Hyperdrive  │──▶ your MySQL 8
 │ plain HTML + JS          │  (cookie)   │ worker/src/index.js    │   └─────────────┘   (any host)
 └──────────────────────────┘             │                        │   (research PDFs too)
                                          └────────────────────────┘
```
GitHub Pages can only host static files, so all logic (sign-in, rules, database, files) runs in the Worker.

## What is in this first version (core)
Sign-in with phone + PIN and roles **Admin / Institution / Supplier** · accounts (admin) · notify a procurement · supplier records items (cost, price, **barcode optional**) · **institution supplier-margin limit** (blocks prices above it) · admin **reviews, approves or returns with comments** · reference prices (always per single item) with **PDF research stored in the database** · institution is told **NIMRA is researching** after the supplier adds items · notifications · **wastage page with waste and margin per supplier and a year filter that rolls over by itself** · audit log.

Not yet moved from the ASP.NET version: wallet and ledger, invoice discounting, surveillance, newsletter, help desk, cartels/blacklist, auctions, agents, training. They are planned as the next rounds, in this same Worker.

## Deploy, step by step
You need: a domain on Cloudflare DNS, a GitHub repo, Node 18+, and a **MySQL 8 (or MariaDB 10.5+) server the Worker can reach over the internet** (PlanetScale-style hosts, a VPS, a managed MySQL from any cloud). Hyperdrive supports MySQL and PostgreSQL, **not SQL Server**.

1. **Put this folder in a GitHub repo** (`main` branch).
2. **Create the database** on your MySQL server, make a user for the app, and load the tables:
   ```
   mysql -h HOST -u ADMINUSER -p -e "CREATE DATABASE nimra CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
     CREATE USER 'nimra'@'%' IDENTIFIED BY 'LONG-RANDOM-PASSWORD'; GRANT SELECT,INSERT,UPDATE,DELETE ON nimra.* TO 'nimra'@'%';"
   mysql -h HOST -u ADMINUSER -p nimra < worker/migrations/0001_init.sql
   ```
   The server must accept connections from the internet (use TLS; ideally allow only Cloudflare's addresses, or use a Cloudflare Tunnel with Hyperdrive if the server is private).
3. **Connect Hyperdrive**
   ```
   cd worker && npm install
   npx wrangler login
   npx wrangler hyperdrive create nimra --connection-string="mysql://nimra:LONG-RANDOM-PASSWORD@HOST:3306/nimra"
   ```
   Copy the Hyperdrive `id` into `wrangler.toml`. Then edit `ALLOWED_ORIGINS` = `https://app.yourdomain.com`, `COOKIE_DOMAIN` = `.yourdomain.com`, and the `routes` pattern `api.yourdomain.com`.
4. **Secret for the first admin**: `npx wrangler secret put SETUP_TOKEN` (any long random text), then `npx wrangler deploy`.
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
npm run test     # 33 checks of the real API code. A fake MySQL connection (SQLite underneath) stands in for MySQL
npm run demo     # site http://localhost:8080  (admin 0971000000/1234, institution 0972000001/2222, supplier 0973000001/3333)
```
(Needs Node 22+ for the `node:sqlite` stand-in. Deployed Workers do not need it. **This does not test MySQL itself**: the first real MySQL run is when you load `migrations/0001_init.sql` and sign in. If a query fails, the Worker log (`npx wrangler tail`) shows the MySQL error.)

## How the old rules were carried over
| Rule | Here |
|---|---|
| Barcodes not mandatory | optional; if given, 8 to 14 digits |
| Institution supplier margin limit | `institution_settings.margin_limit_percent`, falls back to global `MarkupMaxPercent` (30). Items priced over `cost × (1 + limit)` are refused with the item named |
| Admin returns with comments | `POST /api/notices/:id/return`; supplier and institution notified; supplier edits and resubmits |
| Reference price is for ONE item | stated on every price form and table; stored as `unit_price` |
| PDF with research | multipart upload, PDF only, 5 MB, stored in the `price_files` table (no file-storage service, no card needed), downloaded through the API (sign-in required; unpublished files are admin-only) |
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
Workers and Hyperdrive have free tiers that cover a pilot (no card is needed for Workers Free); your MySQL host is a separate cost; GitHub Pages is free for public repos (private repos need a paid GitHub plan). Check current Cloudflare pricing before launch.
