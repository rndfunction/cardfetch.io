# cardfetch.io

A card locator for a singles program that doesn't sort its cards.

## What it is

When you scan a batch of cards, they go into a physical box. You don't sort
them alphabetically or by set - you just box them, label the box with the
scan date, and record the mapping. This app tells you which box a card is in,
so you can find it when a customer orders it.

## What it does

- **Look up a card**: search by name, set, and number. The app tells you
  which box it's in and how many copies you have.
- **Advanced search**: an always-visible form with separate fields for Name,
  Set, Box, Condition, Number, and quantity. Filters combine, and results
  update live as you type. Search "Rise of the Eldrazi" in the Set field and
  see every card in that set, in one keystroke.
- **Pull by order**: load a pull sheet with many orders, then check the
  1-3 orders you're ready to work on. The results table filters to just
  those orders' cards, and **Print** prints only that subset. Staff can
  commit each batch as they finish it, without losing the rest.
- **Pull cards**: mark cards as pulled as you find them. The pull log
  groups by order, so you can commit a subset at a time.
- **Commit**: write the updated quantities back to the live inventory,
  only for the orders you're actually shipping.
- **Move a card**: found a card in a different box than expected? Click
  `↔️` and record the move. The trail keeps a record.
- **Report a missing card**: went to the box and it wasn't there? Click
  `🤔`, add an optional note ("checked twice"), and the card is flagged.
  It stays in inventory (unchanged) and appears in the audit's Missing
  report, with the box where it was *supposed* to be. When you find it,
  click "Clear (verified)" to unflag it.
- **Bulk move**: check the boxes on multiple cards (or "select all visible"),
  and move them all to a new box in one step. Great for "the whole set is in
  the wrong box."
- **Ghost hints**: search results show "👻 last pulled from X on Y." Useful
  when a card isn't where the inventory says it should be.
- **History**: click `📜` on any row to see every pull and move for that card,
  with timestamps and sources.
- **Color-sorted picking lists**: cards sort by their printed color
  (W > U > B > R > G > multicolor > colorless > land), including cards
  that aren't in inventory yet, so you can pick a Devoid card by its
  printed color, not its rules-text "colorless."
- **Audit dashboard** (`/audit.html`): reports for stale cards (not
  touched in 90+ days), suspicious quantities (10+ of the same card in
  the same box, boxes over 800 units), structurally broken rows,
  unknown scan dates, soft-deleted cards (restorable), and recently
  verified cards.
- **Sort by box or order**: the results table groups cards by physical
  box, or by the order they belong to (with box sub-groups). Whatever
  you sort by on screen is what prints.
- **Paper worksheet**: the printed picking list has a pre-printed
  checkbox and a blank notes line per card, so staff can check off
  cards and write "condition issue" or "moved to box X" and hand the
  sheet back at the end of a shift.
- **Soft-delete**: cards removed from the inventory aren't destroyed;
  they're marked deleted and hidden. They appear in an audit report
  ("Deleted cards") where they can be restored with one click.
- **Append a scan batch**: upload a new scanned CSV and assign it to a box.
  The box is chosen by the user (e.g. `081826-2`, `LOTR`), not auto-assigned.
- **Add a single card**: manually enter one card (name, set, number,
  condition, quantity, box) without needing a scan. Great for cards from a
  collection, or for correcting an omitted scan.

## Architecture (short version)

- **Front end**: `/index.html` - a single-page app, vanilla JavaScript,
  PapaParse for CSV, SheetJS for Excel imports.
- **Back end**: a Cloudflare Worker (`/worker/src/index.js`) backed by
  Cloudflare D1 (SQLite). It's a thin HTTP API in front of one database.
- **Storage**: one live inventory, shared across all machines and locations.

Full details in `/ARCHITECTURE.md`. Deployment in `/DEPLOY.md`.

## Audit page

The audit page lives at **`/audit.html`** (linked from the admin page).
It's for maintaining trust in the current data: "I know some cards might
be gone or misplaced, but I don't know which."

Eight reports:

1. **Stale cards** (90+ days): cards with a known scan date that haven't
   been pulled, moved, added, or verified in 90+ days. Filterable by box,
   by set, and by name. Supports "Show all cards" to see every card in a
   filter, not just the stale ones.
2. **High-count duplicates**: the same card in the same box with quantity
   10 or more. Usually means a miscount or a ghost.
3. **Box totals**: cards and units per box. Over 800 units is flagged
   (typical box capacity). Includes a **stock check** tool: pick a box,
   get 10 random cards to verify physically, click ✓ Verify to record.
4. **Structurally broken rows**: missing name, set, number, condition,
   or box.
5. **Unknown scan date**: cards whose box code didn't parse as a date
   (e.g. `LOTR`, `NCC1701`). They can't be judged for staleness.
6. **Deleted cards** (soft-delete): cards that have been marked deleted
   but not purged. They can be restored, individually or in bulk.
7. **Recently verified**: cards you've physically checked recently, with
   a time window (7 / 30 / 90 / 365 days). Useful for confirming coverage
   before a pull day.
8. **Missing cards**: cards that were flagged as "not there" during a
   pull. Shows the card, the **intended** box (where it was supposed to
   be), the current box, any note, and days since flagged. A "Clear
   (verified)" button writes a verify event, which clears the flag.

Each row in Report A has **Verify**, **Move**, **Edit**, and **Delete**
actions, and each report supports **bulk actions** on checked rows.

Cards can be sorted by color (WUBRG) with a **Fetch colors** button. The
color cache is per-browser and shared with the main app.

## Soft-delete

Deleting a card from the audit page (or from any future UI) does **not**
remove the row. It sets `cards.deleted_at` to a timestamp. Every read
endpoint filters `deleted_at IS NULL`, so the card disappears from the
inventory and from the audit reports — but the row is still in the
database, and a `restore` event brings it back.

The `delete` and `restore` events are both written to the trail, so the
card's history shows "deleted at X" and "restored at Y."

## Admin page

The rare-use admin controls live at **`/admin.html`** (there's no link to it
from the main app - type the URL directly). It has:

- **Seed server from CSV** - replace the entire inventory from a file. Use
  only for initial setup or restore from a backup.
- **Reset write key** - clear the stored write key so you're prompted again.
- **Scan batches** - view the list of scan batches created by "Append scan
  batch."

Pullers and other day-to-day users shouldn't need to touch this page.

## Operating modes

The app has two modes, controlled by `API_BASE` in `/index.html`:

- **Live mode** (`API_BASE` set): the app loads inventory from the server
  and saves changes back to it. This is the normal mode.
- **Static mode** (`API_BASE = null`): the app loads `inventory.csv` from
  the same folder and writes changes as local downloads. This is the
  fallback for offline use and for running without a server.

## Usage

### Two ways to search

**Quick lookup** (for pulling an order): paste card names into the Quick
Lookup field in the setup panel, one per line, and click **Find Locations**.
The app finds each card and shows every box it's in.

**Advanced search** (for browsing or bulk operations): use the always-visible
form above the results. Fill in any combination of Name, Set, Box, Condition,
Number, and quantity. Empty fields are ignored; results update live as you
type. Great for "show me everything in this set" or "what's in box 80326?"

### Pulling a batch of orders

1. Upload a pull sheet in the setup panel and click **Find Locations**.
2. An **order picker** appears above the results, listing every order in
   the sheet with its card and unit counts.
3. **Check** the 1-3 orders you want to work on. The results table filters
   live to those orders' cards. (Leave all unchecked to see everything.)
4. Click **🖨️ Print** to print the picking list for just those orders.
5. Staff pulls the cards they find. The pull log groups them by order.
6. Click **☁️ Commit Selected** to commit only the pulled orders. The rest
   stay loaded and ready for the next shift.
7. Uncheck the finished batch, check the next one, repeat.

### Pulling and moving a single card

1. Search for a card using either mode above.
2. Mark it as pulled (or use the `+`/`-` buttons to adjust quantity pulled).
3. Click **☁️ Commit Selected** to commit the pull.

If a card isn't where the inventory says it is, click `↔️` (or `🤔` if the
box is empty) to record the move. The event trail keeps a history.

For bulk operations, check the boxes on multiple rows (or use "select all
visible"), then click "Move all to..." in the floating bar.

### Sorting and printing

Two sort modes:

- **Sort by box** (default): cards grouped by physical box, sorted by name
  within each box. This matches the natural walk: box A, then box B.
- **Sort by order**: cards grouped by order token, with a box sub-group
  inside each order. This matches the workflow "pick this order, then
  that one."

You pick the mode from the dropdown in the results toolbar. **Whatever you
sort by on screen is what prints.** If box mode is on, the paper worksheet
has one header per box. If order mode is on, it has order headers, then
box sub-headers.

The worksheet has:
- A **checkbox** at the left of each row, so staff can check off cards
  with a pen.
- A **blank notes line** at the right, for "condition issue," "moved to
  box X," or anything else that matters.
- **Stock count** (plain text, colored) on each row.

At the bottom of a shift, the staff member hands the sheet back with the
checkmarks and notes filled in. That's the report.

### Adding a single card

1. In the **📦 Inventory actions** card, click **📝 Add single card**.
2. Fill in the form. `Product Name`, `Set Name`, `Number`, `Condition`, and
   `Where is it?` are required.
3. `TCGplayer Id` is optional. If left blank, the app generates a synthetic
   ID like `local:<set>:<number>:<condition>`.
4. Click **Add**. The card appears in inventory and its history gets an
   `add` event.

If the card already exists in that box, the quantity is summed.

### Adding a new batch of scanned cards

To add a new batch of scanned cards:

1. Click **Seed server from CSV** (first time) to load your initial inventory.
2. Or click **Append scan batch** to add a new scan on top of the existing
   inventory. The app assigns the box number automatically.

## Data format

The app speaks two CSV formats, and converts between them:

- **TCGplayer export** (23 columns) - the default format, from CardCastle's
  scanner.
- **CardCastle native** (21 columns) - with a stray `Title` column and
  `_1/_2/_3` trailing fields.

The app's own canonical format is 9 columns:

    TCGplayer Id, Product Line, Set Name, Product Name, Number, Rarity,
    Condition, Total Quantity, Where is it?

All imports are normalized to this shape.

## Special cases handled

- **Cards with no TCGplayer Id**: cards the scanner couldn't confidently
  match. They get a synthetic ID like `local:set:number:condition` so
  they can live in the inventory and be found physically.
- **Duplicate scans**: if the same card is scanned into the same box
  twice, the quantities are summed, not dropped.
- **Embedded header rows**: sometimes the CSV has a `TCGplayer Id` row
  inside the data as a file separator. These are stripped on import.

## Credit

Built for the singles program at the local game store.