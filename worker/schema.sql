-- cardfetch.io D1 schema.
-- Columns mirror the TCGplayer export, lowercased, spaces -> underscores.
-- tcgplayer_id + box is the natural key for a card in a specific box.

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tcgplayer_id TEXT NOT NULL,
  product_line TEXT,
  set_name TEXT,
  product_name TEXT,
  number TEXT,
  rarity TEXT,
  condition TEXT,
  tcg_market_price REAL,
  tcg_direct_low REAL,
  tcg_low_price_with_shipping REAL,
  tcg_low_price REAL,
  total_quantity INTEGER DEFAULT 0,
  add_to_quantity INTEGER,
  tcg_marketplace_price REAL,
  my_totals REAL,
  my_store_price REAL,
  photo_url TEXT,
  sold_for TEXT,
  listed_where TEXT,
  sold_when TEXT,
  box TEXT,
  sold_for_2 REAL,
  profit REAL,
  raw TEXT,
  scanned_on TEXT,
  deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_id_box
  ON cards (tcgplayer_id, box);

CREATE TABLE IF NOT EXISTS scan_batches (
  box TEXT PRIMARY KEY,
  scanned_on TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pulls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tcgplayer_id TEXT NOT NULL,
  box TEXT,
  quantity INTEGER NOT NULL,
  pulled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Unified event trail: pulls, moves, and (future) adjustments.
-- 'kind' is a small string: 'pull', 'move', 'adjust'.
-- 'source' is 'live' (written by the app), 'backfill' (from old sheets),
-- or 'manual' (future hand-entered).
-- box_from / box_to are nullable: a pull has box_from (where it was), a move
-- has both, an adjust might have neither.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tcgplayer_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  box_from TEXT,
  box_to TEXT,
  order_token TEXT,
  quantity INTEGER,
  source TEXT NOT NULL DEFAULT 'live',
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_card_created
  ON events (tcgplayer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_order
  ON events (order_token) WHERE order_token IS NOT NULL;