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
- **Pull cards for an order**: mark cards as pulled as you find them. The
  app keeps a pull log.
- **Commit the pull**: write the updated quantities back to the live
  inventory, so every machine sees the change.
- **Append a scan batch**: upload a new scanned CSV. The app assigns it a
  box number (today's date, plus -1, -2 for multiple scans the same day)
  and adds it to the inventory.

## Architecture (short version)

- **Front end**: `/index.html` - a single-page app, vanilla JavaScript,
  PapaParse for CSV, SheetJS for Excel imports.
- **Back end**: a Cloudflare Worker (`/worker/src/index.js`) backed by
  Cloudflare D1 (SQLite). It's a thin HTTP API in front of one database.
- **Storage**: one live inventory, shared across all machines and locations.

Full details in `/ARCHITECTURE.md`. Deployment in `/DEPLOY.md`.

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

1. Open the app.
2. Search for a card in the search box or Quick Lookup.
3. When you find it, mark it as pulled.
4. Click **Save to server** to commit your pulls to the live inventory.

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