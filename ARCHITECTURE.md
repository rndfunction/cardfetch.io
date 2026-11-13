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

### Scan dates

Cards have a `scanned_on` date. It's set:

- Automatically on `POST /api/append`, to the date of the append.
- Automatically on `POST /api/cards/add`, to the date of the add.
- From the box code on `POST /api/cards/backfill-scan-dates`, which parses
  `MMDDYY` (5 or 6 digits, optionally `-N`-suffixed) and fills `scanned_on`
  for rows where it's null. Boxes with non-numeric codes (`LOTR`,
  `NCC1701`, etc.) stay null.
- Manually on edit, if the user changes the box to a date-like value? No;
  `scanned_on` is set once, and not editable through the edit form.

The audit uses `scanned_on` to distinguish "stale because scanned long ago"
from "stale but we don't know when." Cards with `scanned_on IS NULL` go
in a separate report (Report E).

### Soft-delete

Cards have a `deleted_at` column. Delete is **soft**:

- `POST /api/cards/delete` sets `deleted_at = datetime('now')` and writes
  a `delete` event. The row is not removed.
- Every read endpoint filters `WHERE deleted_at IS NULL`, so soft-deleted
  cards disappear from the inventory, the audit, and the pulling UI.
- `POST /api/cards/restore` clears `deleted_at` and writes a `restore`
  event.

This is a deliberate design choice. Hard deletes are one click away from
permanent data loss, and we've had that bug: a test delete removed 13
cards that had to be reconstructed from the source CSV. The 13 were
recoverable, but only because we had `inventory.csv`. Soft-delete makes
that recovery a one-click operation instead of a forensic exercise.

Hard-purge is not currently exposed. If rows need to be truly removed
(e.g. to reclaim space after a bad import), that's a separate operation
with its own confirmation.

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
- `kind` — `'pull'`, `'move'`, `'add'`, `'edit'`, `'delete'`, `'restore'`,
  `'verify'`, or `'missing'`
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

## Missing cards

A `missing` event is a record of "I went to the box and the card wasn't
there." It's different from a move, and it's different from a delete:

- A **move** says "the card is now in box B."
- A **delete** says "remove this card from inventory."
- A **missing** says "I couldn't find it where the app said it would be.
  It might be there, it might be somewhere else, or it might be gone.
  Please flag it for review."

The `missing` event carries:

- `tcgplayer_id` — the card.
- `box_from` — **where it was supposed to be**. This is the most important
  field. When someone re-checks, they know which box to look in.
- `quantity` — null (we don't know).
- `metadata` — optional `{ note }` with a short human note.
- `source` — `live`.

**`cards.box` is not changed.** The card stays in its current box. The
event is *informational*, not a state change. This is deliberate: the
card is probably still in that box, just hidden behind another card, or
maybe it was actually moved and nobody recorded it. Either way, the
inventory shouldn't lie about what we know.

A `missing` event is **cleared** by any subsequent event of kind
`verify`, `move`, `edit`, `delete`, or `restore` for the same card.
That's the "somebody looked at it and resolved it" case. The simplest
resolution is a `verify`, which is what the audit's "Clear (verified)"
button does.

The **audit Report H** shows currently-missing cards: name, set, #,
intended box, current box, note, days since flagged, and a Clear button.

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

## Manual add

The "add a single card" flow is for cards that didn't come from a scan: a
card from a collection, a card the scanner missed, or a card you want to
insert by hand.

### Endpoint

- `POST /api/cards/add` — requires write key. Body is the canonical 9 fields
  in their human-readable names:

    TCGplayer Id (optional)
    Product Line
    Set Name
    Product Name
    Number
    Rarity
    Condition
    Total Quantity
    Where is it?

- If `TCGplayer Id` is omitted, the Worker generates
  `local:<set>:<number>:<condition>` via `synthId`. The ID is stable and
  searchable, and obviously a local ID (not a TCGplayer one).
- The insert is an **upsert**: if a row with the same `(tcgplayer_id, box)`
  already exists, its `total_quantity` is summed with the new quantity.
- An `add` event is written with `box_to` = the chosen box and `quantity`
  = the added quantity.

### Front end

- Button: **📝 Add single card** in the Inventory actions card (live mode only).
- Form: `openAddForm()`, `closeAddForm()`, `saveNewCard()` in `/index.html`.
- Same field set as the edit form, but empty, plus an optional TCGplayer Id.
- On success: `loadDefaultInventory()` refreshes the view.

### Why `add` instead of `pull` / `move`

A pull has `box_from` (where it was). A move has both `box_from` and
`box_to`. An add has only `box_to` — the card wasn't anywhere before. That
distinction matters if you ever reconstruct state from events: an add
*creates* a row; a pull *decrements* one; a move *relocates* one.

## Color sorting

The picking list sorts cards by color (W > U > B > R > G > multicolor >
colorless > land). Color info comes from two sources:

1. **Static cache**: `/card-colors.json` — 3,062 entries, built ahead of
   time. Fast, works offline, but incomplete (new sets, not-found cards).
2. **Browser-side Scryfall fetch**: when a pull sheet is loaded and some
   cards are missing from the static cache, `ensureColorsForCards()` calls
   Scryfall directly (via the browser's own network, CORS is open) and
   merges the result into localStorage. Subsequent loads are instant.

### Why the browser and not the Worker

Cloudflare Workers have egress restrictions that make some requests to
Scryfall fail (rate-limiting, IP blocks, or CORS). The browser runs from
the user's IP, which Scryfall accepts. This is the same reason the
initial `/card-colors.json` build was done offline.

### Why `color_identity` and not `colors`

Scryfall exposes two color fields:

- `colors` — the card's actual color, per the rules. **Devoid cards are
  colorless** (`[]`), even though they have a printed colored symbol.
- `color_identity` — the card's color identity. **Devoid cards have their
  printed color** (e.g. `["B"]` for Transgress the Mind).

For sorting by "what color would a human put this in?", we use
`color_identity`. The static cache was built with the wrong field (or an
older Scryfall), which is why some Devoid cards sorted as colorless. New
fetches correct this.

### Fallback behavior

If Scryfall is unreachable, the fetch fails silently, and cards not in the
static cache print as "Unsorted." This is no worse than before, and
strictly better for the common case.

## Sort and group

The results table and the printed picking list both use the **same
grouping** logic, so what you see is what you print.

`groupResultsForRender(rows)` returns a flat sequence of items: either a
header (`{ kind: 'order-header', label }` or `{ kind: 'group', label }`)
or a row (`{ kind: 'row', row }`). Two modes, controlled by the
`sortModeFilter` dropdown:

- **box** (default): one `group` per physical box, rows sorted by name
  within each box.
- **order**: one `order-header` per order token (or `No order` for
  unallocated cards), then one `group` per box within that order, then
  rows sorted by name.

The render loop in `render()` iterates the flat sequence and emits a
header row (`<tr class="group-header">`) or a normal row for each item.

`printPickingList()` iterates the same sequence, so the printed output
has the same headers in the same order. That's the "print mirrors
screen" invariant.

**Do not add grouping logic in two places.** If you need to change how
rows group (e.g. add a third mode), change `groupResultsForRender`, and
both the screen and the print will follow.

## Print worksheet

The printed picking list is a worksheet for a physical pull. Each card
row has three columns:

- A **pre-printed checkbox** (`&#9744;`). Staff check it off with a pen.
- The card details (name, set, number, condition, quantity, stock
  status). Stock status is plain text (`N in stock`, `0 in stock`,
  `Pulled`), no emoji.
- A **blank notes line**. Staff write "condition issue," "moved to box
  X," "couldn't find," etc.

At the bottom of a shift, the checked sheet with notes is the report.

The print CSS uses `display: grid` with `grid-template-columns: 24px
1fr 140px` on `.print-picking-item`, so the three columns line up
across rows even when card names vary in length.

## Audit page

`/audit.html` is the maintenance dashboard. It's separate from the main
app and the admin page, and it's linked from the admin page header.

Seven reports:

- **Report A: Stale.** Cards with a `scanned_on` date and no `pull`,
  `move`, `add`, or `verify` event in 90+ days. Has filters (box, set,
  name), a "Show all cards" toggle, a "Sort by color" toggle, and per-row
  Verify/Move/Edit/Delete with bulk actions.
- **Report B: High-count duplicates.** Cards with `total_quantity >= 10`
  in the same box. Usually means a miscount or a ghost.
- **Report C: Box totals.** Cards and units per box. Over 800 units is
  flagged. Has a **stock check** tool: pick a box, sample 10 random cards,
  verify each with a button. Also has a color-sorted toggle.
- **Report D: Structurally broken rows.** Missing name, set, number,
  condition, or box.
- **Report E: Unknown scan date.** `scanned_on IS NULL`. Typically boxes
  with custom names (`LOTR`, `NCC1701`) that the box-code parser can't
  date.
- **Report F: Deleted cards.** Soft-deleted cards (see "Soft-delete"
  below), with restore in bulk.
- **Report G: Recently verified.** Cards with a `verify` event within a
  time window (7 / 30 / 90 / 365 days). Shows when and in which box.

The audit page uses these endpoints:

- `GET /api/audit` — cards, per-card latest events, box totals.
- `POST /api/cards/verify` — writes a `verify` event.
- `POST /api/cards/delete` — soft-deletes one or more cards.
- `POST /api/cards/restore` — restores soft-deleted cards.
- `GET /api/cards/deleted` — lists soft-deleted cards.
- `PATCH /api/cards/edit` — edits one card's fields.
- `PATCH /api/cards/move` — moves one card.
- `PATCH /api/cards/move-bulk` — moves many cards at once.

The color cache used by "Sort by color" is shared with the main app via
`localStorage` (`forge-scryfall-colors-v1`). It's populated lazily by
the "Fetch colors" button (batched Scryfall calls) and by the main app's
`ensureColorsForCards()`.

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
- `GET /api/audit` - read-only audit data: cards, per-card latest event,
  box totals. Filters out soft-deleted cards. No auth.
- `POST /api/cards/verify` - writes a `verify` event. Requires key.
- `POST /api/cards/missing` - writes a `missing` event with `box_from`
  and optional `metadata.note`. Does not change `cards.box`. Requires key.
- `POST /api/cards/delete` - soft-deletes one or more cards. Requires key.
- `POST /api/cards/restore` - restores soft-deleted cards. Requires key.
- `GET /api/cards/deleted` - lists soft-deleted cards. No auth.
- `POST /api/cards/backfill-scan-dates` - one-time backfill of `scanned_on`
  from box codes. Requires key.

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

**Every bulk write path must go through `runBatched`.** In particular,
`handleQuantitiesPatch` (the pull-commit endpoint) does, because a pull day
can easily touch more than 100 rows. If you add a new endpoint that builds
a `statements` array, route it through `runBatched`; do not call
`db.batch(statements)` directly. The only place a raw `db.batch([a, b])`
is acceptable is the two-statement atomic pattern described in note 9.

### 9. Single-card writes must batch the state change with its event

`ARCHITECTURE.md` says "events are written in the same D1 batch as the
state change they describe, so the trail and the inventory never disagree."
That has to be true for **every** write path, not just bulk ones. In
particular:

- `handleMove` (single) — `UPDATE cards` + `INSERT events` in one
  `db.batch([updStmt, evtStmt])`.
- `handleEdit` — same pattern, after the diff is computed.
- `handleAdd` — row upsert + `add` event in one batch.

If you add a new single-card endpoint, do the same: prepare both statements,
pass them as a two-element array to `db.batch()`. A `.run()` followed by
another `.run()` is the wrong shape: if the second fails, the first is
already committed and the trail is missing a row.

D1 does not let a batch abort on an earlier statement's result, so in the
single-move case the event can still be written when the UPDATE matched
zero rows. That case returns a 404 and the front end re-fetches; the case
we care about is the inverse (state change with no trail), and the batch
eliminates it.

### 10. Do not use `INSERT OR IGNORE` on `cards`

`INSERT OR IGNORE` silently drops a row on a `(tcgplayer_id, box)`
conflict. That is the opposite of what this app wants. Duplicate scans are
**summed**, not dropped -- see "Duplicate handling" above -- and the same
rule applies to append, PUT, and add.

Use the upsert form everywhere a card row is inserted:

    INSERT INTO cards (...) VALUES (...)
    ON CONFLICT (tcgplayer_id, box) DO UPDATE SET
      total_quantity = COALESCE(total_quantity, 0)
                     + COALESCE(excluded.total_quantity, 0)

`handleAppend` used `INSERT OR IGNORE` until it was caught and fixed. Do
not reintroduce it. If you see it in a diff, that is a bug.

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
- v3: event trail, ghost hints, moves, bulk moves, edits, manual add,
  scan append with user-chosen box, pull by order.
- Current: audit dashboard, `scanned_on` (backfilled from box codes),
  soft-delete with restore, color-sort via Scryfall with `color_identity`
  (correct for Devoid cards).

## Open questions

- Should box code normalization (081826 vs 81826) be applied to the data?
  Deferred. The app treats them as distinct strings, but the audit's
  `scanned_on` backfill treats both as the same date.
- Should writes record a free-text "who" for auditing? Every action has
  a timestamp, but not an author.
- Should `raw` be populated as a separate table, one row per card? The
  column exists, but is currently unused; it was never populated for
  existing rows, and new imports don't fill it. A separate table would
  be cleaner than a wide column.
- Should hard-purge be exposed (vs. soft-delete)? Currently only soft-
  delete is exposed, and rows accumulate. A "trash" view with a
  "purge forever" action would close the loop.
- Should `scanned_on` be editable? Currently set once at import/add.
  If the box code changes (e.g. a card is moved to a new box with a new
  date), `scanned_on` stays the same, which is arguably correct
  ("when it entered inventory") but might confuse future audits.