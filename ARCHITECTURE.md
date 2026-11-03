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

### Event trail

The `events` table records **what happened to a card over time**. It's the
difference between "where is this card now" and "where has it been and why."

Columns:

- `tcgplayer_id` (the card's stable id, including synthetic `local:` ids)
- `kind` — `'pull'`, `'move'`, or `'add'`
- `box_from` — the box it was in (for pull and move; null for add)
- `box_to` — the box it went to (for move and add; null for pull)
- `order_token` — the order it was pulled for, if known (from the pull sheet)
- `quantity` — how many
- `source` — `'live'` (written by the app), `'backfill'` (loaded from old sheets), `'manual'` (future)
- `metadata` — free-form JSON (e.g. `{"reason": "bulk"}`)
- `created_at` — when

Queries:

    GET /api/events                                # recent events
    GET /api/events?tcgplayer_id=X                 # one card's history
    GET /api/events?order=TOKEN                    # one order's history

Events are written **in the same D1 batch** as the state change they
describe, so the trail and the inventory never disagree. When you pull a
card, the quantity update and the `pull` event land together. When you move
a card, the box update and the `move` event land together.

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

## Search model

There are **two search modes**, and they serve different purposes.

### Quick lookup (name-driven)

For "here are the cards I need to pull, give me their locations." The user
pastes a list of card names (one per line, optionally `Name | Set | Number |
Condition`), clicks **Find Locations**, and the engine returns one result
per *card name*, with all locations for that card. This is the pull-sheet
flow. It hits the Worker only when saving.

### Advanced search (row-driven)

For "show me everything that matches these filters." Six fields (Name, Set,
Box, Condition, Number, Quantity) combined with AND; empty fields are
ignored. It runs **live**, debounced ~200ms on input. It returns one result
per *inventory row*, not per card name — so `Set = "Rise of the Eldrazi"`
returns every row in that set, which is what makes bulk operations possible.

**Advanced search is entirely front-end.** It calls `engine.advancedQuery()`,
which iterates the already-loaded inventory. No Worker request. No D1 query.
Live filtering costs zero traffic.

### Two result filters, not one

- **Advanced search** (always-visible form above the results table) *generates*
  results from the inventory.
- **Filter box** (the existing input in the results toolbar) *narrows* an
  existing result set: search text, status filter, quantity filter.

Both compose: `Set = X` gives 200 rows; the filter box narrows to "foil";
the status filter narrows to "in stock." Different tools, same pipeline.

## Moves and bulk operations

A **move** is the action "this card is now in a different box." It updates
`cards.box` and writes an event in the same D1 batch. Three ways to trigger
it:

1. **`↔️` next to a location badge** in a search result — the current box is
   known, so the inline picker pre-fills it.
2. **`🤔` next to a location badge** — the same picker, but with the framing
   "I went to this box and it wasn't there." Same code path; different
   reason string in the event metadata (`not in expected box`).
3. **Bulk move** — checkboxes on each in-stock row, a floating action bar
   that appears when ≥1 is checked, and a "Move all to..." button. Every
   selected row's `from_box` is its own current box, so a batch can span
   different source boxes.

The move picker is an **inline popover**, not a native `prompt()`. It shows
a text input plus a filtered list of box codes from the current inventory
(minus the current box), so the common case is one click.

## Appending scans

A **scan** is what the CardCastle scanner produces: TCGplayer-style columns,
but no `Where is it?` column, because the physical box isn't known until
the human assigns it. This is a third format, separate from the TCGplayer
export and the CardCastle-native export.

### Format detection

`detectFormat(header)` returns one of:

- `'cardcastle'` — has `Title` and `_1/_2/_3` (native CardCastle export)
- `'tcgplayer'` — has `Where is it?` (standard export)
- `'scan'` — has `Product Name`, `Set Name`, and `Number`, but no
  `Where is it?` and no `_1/_3` (raw scan output)
- `'unknown'` — anything else, rejected

The `'scan'` format uses the same column mapping as `'tcgplayer'`, except
`box` is empty and is filled in by the caller's `boxOverride`.

### The append flow

1. User clicks **Append scan batch** in the **Inventory actions** card
   (visible in live mode only). The card was added so the button isn't
   hidden inside the pull log, which is only shown after a pull.
2. `openAppendPicker()` shows the box picker (reuses the move picker
   markup) with a text input and suggestions from the current inventory.
3. User types or picks a box code and confirms. `runAppendWithBox(box)`
   opens a file picker.
4. User picks a scan CSV. The front end reads it and POSTs to
   `/api/append?box=<box>` with the CSV as the body.
5. `handleAppend` passes `{ boxOverride: box }` to `parseImport`, which
   sets `canon.box = box` for every row before validation.
6. `scan_batches` records the chosen box and the row count.

**No auto-assignment.** The box is user-chosen, and may be anything
(`081826-2`, `LOTR`, `new-pile`). It is not parsed, not validated, not
inferred from a date.

### Endpoints

- `PATCH /api/cards/move` — single move, `{tcgplayer_id, from_box, to_box}`.
  Returns `404` if the row isn't where the caller expected (stale cache,
  concurrent move), so the caller can re-fetch.
- `PATCH /api/cards/move-bulk` — array of moves, **best-effort**. One bad
  move doesn't abort the batch. Returns `{moved, skipped: [{id, reason}]}`.

### Re-render discipline

After a move (single or bulk), the app updates the in-memory result rows
(`Locations[0].location` and `Location Display`) and calls `render()`
**directly**. It does not call `findLocations()` — that was the old behavior,
and it broke the advanced-search flow (quick lookup would ignore the
advanced form). If you ever add another action that changes a row's state,
follow the same pattern: update the in-memory result, then `render()`.

## History and ghost hints

### Ghost hint (surface)

Search results show a small line under the location badges:

    👻 last pulled from 081826-2 on 2026-10-30 04:42:06

This is filled asynchronously by `refreshEventHints()`, which fetches the
most recent `pull` event for each visible card, caches it on `hintCache`, and
re-renders once if anything new arrived.

**Two subtleties:**

1. **Result rows don't carry a TCGplayer Id at the top level.** The id lives
   on `row.OriginalItem['TCGplayer Id']`, or, for NOT FOUND rows, on the
   `nameToId` lookup (a name→id index built from the full inventory on first
   use). `rowIdOf` resolves all three sources.
2. **The hint labels itself honestly.** When the row has an `OriginalItem`
   (i.e. this specific printing matched), it says "last pulled from X."
   When it doesn't (the row is "not found" and we resolved the id by name),
   it says "last pulled (any printing) from X." That difference matters:
   it's a feature, not a bug, and the label reflects it.

The hint is **never** authoritative. It's a hint. The full history is a
click away.

### History panel (depth)

A `📜` button on each row opens the history panel, which fetches
`GET /api/events?tcgplayer_id=X` and renders the events with:
- kind (`Pull`, `Move`, `Add`) and emoji
- detail (box_from, box_to, order, reason)
- timestamp
- a source badge, green for `live`, gray for `backfill`

The panel is an **inline popover**, not a modal, so you can see the row and
its history at the same time. Close button, Escape, and click-outside.

## Pull by order

The pull-sheet flow is order-aware. Each pull sheet CSV can contain many
orders, encoded in the `Order Quantity` column as `token:qty` pairs (pipe-
separated). A single card can belong to multiple orders.

### The workflow

1. Load the pull sheet (`engine.loadPullSheet`). Each row gets `__orders`,
   an array of `{ token, qty }`.
2. `engine.processPullSheet()` runs the match against inventory and builds
   `this.results`, one row per pull-sheet row. `__orders` is carried onto
   each result.
3. The **order picker** (rendered by `renderOrderPicker()`) lists every order
   in the pull sheet, with card and unit counts. Checkboxes control
   `ui.focusedOrders` (a Set of order tokens).
4. `render()` calls `getFocusedResults()`, which filters `this.results` by
   `focusedOrders`. Empty set = show everything.
5. `printPickingList()` also uses `getFocusedResults()`, so the picking list
   prints only the focused orders.
6. Pulls are allocated to orders by `setPullQuantity()` (fill orders in
   appearance order, then leftover to Unallocated). Each `pullLog` entry
   carries `orderToken`.
7. `updatePullLogUI()` groups the pull log by `orderToken`, with checkboxes
   in `ui.selectedOrders`.
8. `saveToServer()` filters `updates` and `events` by `selectedOrders`, so
   only the chosen orders commit.
9. On success, `removeCommittedPulls()` drops those entries from the local
   pull log and `loadDefaultInventory()` refreshes from the server.

### Key invariants

- `__orders` is the source of truth for "which order does this pull belong
  to," both before and after the pull. It is derived from the pull sheet
  once, at load time.
- `orderToken` on a `pullLog` entry is set at pull time, not re-derived
  later. This is what made the order-aware commit accurate.
- The commit filter is by *order token*, not by card or box. A row pulled
  for two orders produces two events, each tagged with its order.

### Known limitations

- Pull-sheet dates are not captured (the CSV doesn't have them).
- TCGplayer doesn't expose a public API for "look up the TCGplayer ID for
  this card name/set/number." So `TCGplayer Id` is read-only in the edit
  form and stays as the scanner's original guess even after corrections.

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

**Before every deploy, grep `/worker/src/index.js` for `.bind.apply`.** If any
hits appear, fix them. This bug was reintroduced *during* the events feature
after being written up, so grep is more reliable than memory. The
`dbSession` error does not point at this line; it looks like a platform
error. It is not.

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

### 5. `getRowId` is a WeakMap keyed on the object

`getRowId(row)` uses a `WeakMap` keyed on the *object reference*. Copies of a
row (e.g. `{...item}` in `getUpdatedInventory`) are **different objects**, so
`getRowId(copy)` returns `null`. If downstream code needs the row's id after
a copy, it must be carried along.

The fix used: `getUpdatedInventory` attaches `copy.__rowId = rowId`, and
downstream code reads `r.__rowId` first, falling back to `getRowId(r)`.
**Do not call `getRowId()` on copies.**

### 6. `this` doesn't propagate into nested `function` declarations

Inside an `async` method, a nested `function foo() {}` gets its own `this`
(usually `undefined` or `window`), **not** the method's `this`. Nested
`const foo = () => {}` arrow functions **do** capture `this`.

This caused a real bug: `refreshEventHints` had `function rowIdOf(r) { ... this.nameToId ... }`,
and `this` was `undefined` inside `rowIdOf`, so `this.nameToId` threw and the
whole hint fetch silently hung. Converting it to `const rowIdOf = (r) => {...}`
fixed it. **Prefer arrow functions for nested helpers that need `this`.**

### 7. Live search does not touch the Worker

Advanced search runs entirely in the browser over the already-loaded
inventory. `engine.advancedQuery()` iterates the in-memory array. Typing in
the advanced-search fields does not make any network request. This is what
keeps the free tier comfortable and the UI instant.

**Only these things hit the Worker:**
- Loading the inventory (once per page load)
- Saving a pull or a move (once per action)
- Opening the history panel (once per card inspected)

At a shop's realistic usage (a few hundred interactions a day), that's
well under 1% of the Cloudflare free tier limits.

### 8. `STOCK_QTY_COLUMNS` on the front end

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