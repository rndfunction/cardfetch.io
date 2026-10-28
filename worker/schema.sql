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
  raw TEXT
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