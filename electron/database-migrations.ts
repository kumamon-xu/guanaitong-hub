/** Append migrations; never change a released migration. All scripts run in one transaction. */
export const DATABASE_MIGRATIONS = [
  { version: 1, name: 'core-data', sql: `
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL) STRICT;
    CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    CREATE TABLE cards (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
      balance REAL CHECK(balance IS NULL OR balance >= 0),
      archived INTEGER NOT NULL CHECK(archived IN (0,1)),
      payload BLOB NOT NULL, credential BLOB NOT NULL
    ) STRICT;
    CREATE TABLE products (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
      favorite INTEGER NOT NULL CHECK(favorite IN (0,1)), payload BLOB NOT NULL
    ) STRICT;
    CREATE TABLE offers (
      card_id TEXT NOT NULL REFERENCES cards(id), source_id TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id), position INTEGER NOT NULL,
      price REAL CHECK(price IS NULL OR price >= 0),
      stock INTEGER CHECK(stock IS NULL OR stock >= 0), payload BLOB NOT NULL,
      PRIMARY KEY(card_id, source_id), UNIQUE(product_id, position)
    ) STRICT;
    CREATE INDEX offers_product ON offers(product_id);
    CREATE INDEX offers_price ON offers(price);
    CREATE TABLE orders (
      id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id), source_id TEXT NOT NULL,
      position INTEGER NOT NULL UNIQUE, amount REAL CHECK(amount IS NULL OR amount >= 0),
      payload BLOB NOT NULL, UNIQUE(card_id, source_id)
    ) STRICT;
    CREATE INDEX orders_card ON orders(card_id);
    -- Stale cart quotes survive a sync, so the cart references cards/products, not a live offer.
    CREATE TABLE cart (
      id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id),
      product_id TEXT NOT NULL REFERENCES products(id), source_id TEXT NOT NULL,
      position INTEGER NOT NULL UNIQUE, quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99),
      UNIQUE(card_id, source_id)
    ) STRICT;
    CREATE TABLE activities (
      id TEXT PRIMARY KEY, card_id TEXT REFERENCES cards(id), position INTEGER NOT NULL UNIQUE,
      payload BLOB NOT NULL
    ) STRICT;
    CREATE TABLE manual_merges (
      position INTEGER PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), payload BLOB NOT NULL
    ) STRICT;
    CREATE TABLE addresses (
      id TEXT PRIMARY KEY, position INTEGER NOT NULL UNIQUE,
      is_default INTEGER NOT NULL CHECK(is_default IN (0,1)), payload BLOB NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX addresses_one_default ON addresses(is_default) WHERE is_default=1;
    CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL) STRICT;
  ` },
  { version: 2, name: 'encrypted-sessions', sql: `
    CREATE TABLE sessions (
      card_id TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
      payload BLOB NOT NULL
    ) STRICT;
  ` },
  { version: 3, name: 'management-and-sync', sql: `
    CREATE TABLE price_history (
      id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL, at TEXT NOT NULL, payload BLOB NOT NULL
    ) STRICT;
    CREATE INDEX price_history_source ON price_history(card_id, source_id, at);
    CREATE TABLE sync_tasks (
      id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      at TEXT NOT NULL, payload BLOB NOT NULL
    ) STRICT;
    CREATE INDEX sync_tasks_time ON sync_tasks(at DESC);
    CREATE INDEX products_favorite ON products(favorite, position);
    CREATE INDEX cart_card ON cart(card_id);
  ` },
] as const;
export const DATABASE_VERSION = DATABASE_MIGRATIONS.at(-1)!.version;
