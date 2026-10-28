# cardfetch.io - Architecture

This document describes the system as it actually is, not as it was originally
planned. It includes the specific quirks and workarounds that were discovered
during implementation. Read this before touching the Worker.

## Big picture

- **Front end**: `/index.html`, a single-page vanilla-JS app. Parses CSV with
  PapaParse, imports Excel with SheetJS. No framework.
- **Backend**: `/worker/src/index.js`, a Cloudflare Worker (module syntax).
- **Storage**: Cloudflare D1 (SQLite), accessed via the `DB` binding.
- **Auth**: a shared write key, passed as the `X-Write-Key` header on writes.
  Reads are open. This is intentional - the inventory is not sensitive, and
  we didn't want to build a login system.
- **Static fallback**: when `API_BASE = null` in `/index.html`, the app
  operates entirely client-side, loading `inventory.csv` and downloading
  updates. This keeps the app usable offline and during initial setup.

## Data model

One row per physical card location. The canonical schema is 9 columns:

    TCGplayer Id, Product Line, Set Name, Product Name, Number, Rarity,
    Condition, Total Quantity, Where is it?

`Where is it?` is the box code (e.g. `081826-2` = Aug 18, 2026, second scan
that day). It is a free-form string.

The `(tcgplayer_id, box)` pair is unique. That is the natural identity of a
card in a specific box.

### Synthetic IDs

When the scanner can't confidently match a card to TCGplayer, the CSV comes
in with an empty `TCGplayer Id`. These are real physical cards, so we don't
drop them. Instead they get a synthetic ID: `local:<set>:<number>:<condition>`,
slugified. This makes them findable, stable, and obviously non-TCGplayer.

### Duplicate handling

If two rows share `(tcgplayer_id, box)`, they represent two physical copies
of the same card in the same box (typically scanned on different days). The
Worker sums their `total_quantity` via upsert:

    INSERT INTO cards (...) VALUES (...)
    ON CONFLICT (tcgplayer_id, box) DO UPDATE SET
      total_quantity = COALESCE(total_quantity, 0)
                     + COALESCE(excluded.total_quantity, 0)

The PUT endpoint reports `duplicatesSummed` so you can see when this happened.

### Quantity source

The CSV's quantity column is `Add to Quantity`, not `Total Quantity` (which is
usually blank in the export). The Worker reads `Add to Quantity` first, then
`Total Quantity` as a fallback.

On the front end, the `STOCK_QTY_COLUMNS` array must include BOTH column names
in priority order. It's how the app knows where the quantity lives in a row.

## API

Base path `/api`. All responses are JSON except `GET /api/inventory` (CSV).

- `GET /api/inventory` - full inventory as canonical CSV. No auth.
- `PUT /api/inventory` - replace inventory from posted CSV. Requires key.
  Accepts `?strict=1` to refuse on duplicates instead of summing.
- `POST /api/append` - append a scanned CSV. Assigns today's box number.
  Requires key.
- `PATCH /api/quantities` - update `total_quantity` for specific rows.
  Body: `{ updates: [{ tcgplayer_id, box, total_quantity }] }`. Requires key.
- `GET /api/batches` - scan batch list (`box`, `scanned_on`, `row_count`).
  No auth.

### CORS

Permissive (`Access-Control-Allow-Origin: *`). Tighten if the app ever moves
to a domain-restricted deployment.

## Critical implementation notes

These are the things that broke during development and are not obvious from
reading the code. Do not undo them without understanding why they exist.

### 1. Use `.bind(...params)`, not `.bind.apply(null, params)`

Early code used `.bind.apply(null, params)` to spread a parameter array.
This triggered a mysterious `Cannot read properties of null (reading
'dbSession')` error inside D1. Switching to spread syntax fixed it. The
mechanism is a Cloudflare internal (the Sessions API object), not our code.

**Do not revert to `.bind.apply`.**

### 2. Force the primary session for writes

The Worker uses `env.DB.withSession('first-primary')` on all write paths.
This bypasses the D1 Sessions API's replica routing, which was failing
with the same `dbSession` null error in some environments. Reads use plain
`env.DB.prepare(...)` and work fine.

### 3. Chunk large batches

`runBatched(db, statements)` sends at most 100 statements per `db.batch()`.
Large single batches (3,000+ statements) can fail or time out. The chunk
size is `BATCH_CHUNK`.

### 4. `raw` column is not written

The `cards` table has a `raw TEXT` column for future use (audit, buy offers,
etc.). It's currently not populated on import, because a 24-column INSERT
with the raw JSON string triggered the same `dbSession` bug. It will be
populated later via a separate write if needed.

### 5. `STOCK_QTY_COLUMNS` on the front end

The `findCardMatches` search logic filters to `getStockQty(item) > 0`. If
`STOCK_QTY_COLUMNS` doesn't include the column name that the loaded data
uses, every search returns nothing - which is what happened when the server
started sending `Total Quantity` (it wasn't in the list). The fix was to
include both `Total Quantity` and `Add to Quantity` in that array, in
priority order.

## Box numbering

Box codes are `MMDDYY` (e.g. `081826`). Multiple scans on the same day get
`-2`, `-3`, etc. The `scan_batches` table records each batch (box, date,
row count). The PUT endpoint does not create batches (it's a full replace);
only POST /api/append does.

## What's not here

- No user accounts, no per-user auditing. If that's ever needed, it's a
  separate exercise.
- No real-time sync. Two simultaneous writers would race; acceptable for now.
- No front-end build step. The app is a single HTML file on purpose.

## Deploy

See `/DEPLOY.md`. Summary: create the D1 database, apply `worker/schema.sql`,
set `WRITE_KEY` as a secret, deploy with `wrangler deploy` (or paste the
code into the Cloudflare dashboard), and set `API_BASE` in `/index.html` to
the Worker URL.

## Version history

- Initial: card locator only (static HTML).
- v2: Cloudflare Worker + D1, live inventory shared across machines.
- Current: synthetic IDs, quantity summing, strict mode, cleanup of
  diagnostics.

## Open questions

- Should box code normalization (081826 vs 81826) be applied to the data?
  Deferred. The app treats them as distinct strings.
- Should writes record a free-text "who" for auditing?
- Should `raw` be populated as a separate table, one row per card?