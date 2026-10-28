# cardfetch.io - Deploy

This guide describes deploying the Worker and D1 database **entirely through
the Cloudflare dashboard** - no local installation required. If you prefer
the CLI, the wrangler commands are noted at the bottom.

## Prerequisites

- A Cloudflare account (free tier is sufficient).
- Access to the `rndfunction` Cloudflare account (or your own).

## Step 1: Create the D1 database

1. In the Cloudflare dashboard, go to **Storage & Databases** -> **D1 SQL
   Database**.
2. Click **Create Database**, name it `cardfetch`, click Create.
3. Open the database. Go to the **Console** tab.
4. Paste the contents of `/worker/schema.sql` and click **Execute**.

This creates the `cards`, `scan_batches`, and `pulls` tables.

## Step 2: Create the Worker

1. Go to **Workers & Pages** -> **Overview**.
2. Click **Create application** -> **Create Worker**.
3. Name it `cardfetch-api`, click **Deploy**.
4. Note the URL: `https://cardfetch-api.<your-subdomain>.workers.dev`.

## Step 3: Bind D1 to the Worker

1. On the Worker's page, go to **Settings** -> **Bindings**.
2. Click **Add** -> **D1 database**.
3. Variable name: `DB` (exact case matters). Select the `cardfetch` database.
4. Save.

## Step 4: Paste the Worker code

1. On the Worker's page, click the code editor button (`</>`).
2. Select all, delete, and paste the **entire** contents of
   `/worker/src/index.js`.
3. Click **Deploy** (not just Save).

**Important**: If you change the Worker code and only click "Save", nothing
happens. You must click "Deploy". The dashboard distinguishes these and it
is easy to miss.

## Step 5: Add the write key

1. On the Worker's page, go to **Settings** -> **Variables and Secrets**.
2. Click **Add**.
3. Type: **Secret**. Name: `WRITE_KEY`. Value: a random string
   (20-40 characters, no spaces).
4. Deploy.

Save the key somewhere safe. You'll paste it into the app once per browser.

## Step 6: Point the front end at the Worker

1. Open `/index.html` in the repo.
2. Find `const API_BASE = null;` (or the current value).
3. Set it to your Worker URL:

       const API_BASE = 'https://cardfetch-api.<your-subdomain>.workers.dev';

4. Deploy the front end wherever you host it (GitHub Pages, Cloudflare Pages,
   wherever).

## Step 7: Seed the initial inventory

1. Open the app.
2. Click **Seed server from CSV**.
3. When prompted, enter the write key.
4. Confirm the replace-all prompt.
5. Pick your inventory CSV.

Watch the status bar. Expected: `Seeded server (N rows)` with the row count.
If it fails, the error message names the failure (parse, delete, bind, or
batch). Report that exact message.

**Important**: If your CSV has a header row embedded inside the data as a file
separator (a row where the first cell is `TCGplayer Id`), those are stripped
automatically. Duplicate `(tcgplayer_id, box)` pairs are summed. Rows with no
`TCGplayer Id` get a synthetic `local:...` ID. See `/ARCHITECTURE.md`.

## Rolling back

- **Worker**: in the Cloudflare dashboard, **Deployments** tab, select a
  previous version, Deploy.
- **Front end**: set `API_BASE = null` to return to static mode. The static
  `inventory.csv` remains as a fallback.

## The static fallback

Even in live mode, the app can still function offline:

- When `API_BASE` is null, the app loads `inventory.csv` from the same folder
  and writes updates as local downloads (📥 Download Updated Inventory and
  💾 Commit to inventory.csv buttons).
- When `API_BASE` is set, those buttons are hidden, and the server buttons
  (☁️ Save to server, ➕ Append scan batch) appear instead.

This is useful if the Cloudflare account is ever unreachable, or if you want
to test locally.

## CLI alternative (wrangler)

If you prefer the CLI:

    cd worker
    npm i -g wrangler
    wrangler login
    wrangler d1 create cardfetch
    # paste the resulting database_id into wrangler.toml
    wrangler d1 execute cardfetch --file=./schema.sql --remote
    wrangler secret put WRITE_KEY
    wrangler deploy

The seed step is still done through the app (or via `curl` with the
`X-Write-Key` header).

## Troubleshooting

- **Search finds nothing but the data is loaded**: check that
  `STOCK_QTY_COLUMNS` in `/index.html` includes `Total Quantity`. This is
  the bug that made every search return empty after the first seed.
- **Save fails with "Forbidden"**: the write key is wrong. Click "Reset
  write key" to clear it, then try again.
- **Seed fails with a duplicate list**: your CSV has duplicate
  `(tcgplayer_id, box)` pairs. Review them, or use `?strict=0` (the default)
  to sum them.
- **Seed fails at batch**: one of your rows probably has a schema problem.
  Check the exact error message.
- **Update doesn't take effect**: make sure you clicked **Deploy** (not
  just Save) after pasting the Worker code.