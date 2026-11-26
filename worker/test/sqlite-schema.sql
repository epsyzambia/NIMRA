-- TEST-ONLY SQLite copy of the schema (the real one is migrations/0001_init.sql for MySQL). Names are NOCASE like the MySQL collation.

CREATE TABLE organisations(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('Admin','Institution','Supplier')),
  code TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES organisations(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  pin_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('Admin','Institution','Supplier')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions(
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE INDEX ix_sessions_user ON sessions(user_id);

CREATE TABLE login_attempts(
  phone TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT
);

CREATE TABLE settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO settings(k,v) VALUES ('MarkupMaxPercent','30'),('WastageThresholdPercent','10');

-- each institution can set its own limits; empty = use the global setting
CREATE TABLE institution_settings(
  org_id INTEGER PRIMARY KEY REFERENCES organisations(id),
  wastage_threshold_percent REAL,
  margin_limit_percent REAL
);

CREATE TABLE notices(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  institution_id INTEGER NOT NULL REFERENCES organisations(id),
  supplier_id INTEGER NOT NULL REFERENCES organisations(id),
  title TEXT NOT NULL,
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit TEXT NOT NULL,
  needed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NOTIFIED'
    CHECK(status IN ('NOTIFIED','ITEMS_RECORDED','RETURNED','APPROVED','COMPLETED','CANCELLED')),
  quote_version INTEGER NOT NULL DEFAULT 0,
  cancel_reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  items_recorded_at TEXT,
  approved_at TEXT,
  completed_at TEXT
);
CREATE INDEX ix_notices_inst ON notices(institution_id, status);
CREATE INDEX ix_notices_supp ON notices(supplier_id, status);

-- the items a supplier records for a notice: what it costs the supplier and what it charges
CREATE TABLE quote_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  description TEXT NOT NULL COLLATE NOCASE,
  quantity REAL NOT NULL CHECK(quantity > 0),
  unit_cost REAL NOT NULL CHECK(unit_cost >= 0),
  unit_price REAL NOT NULL CHECK(unit_price >= 0),
  barcode TEXT            -- optional: the supplier may not have bought the goods yet
);
CREATE INDEX ix_lines_notice ON quote_lines(notice_id);

CREATE TABLE notice_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER NOT NULL REFERENCES notices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  comment TEXT,
  user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_events_notice ON notice_events(notice_id);

-- reference prices: always the price of ONE single item. Optional PDF in price_files.
CREATE TABLE reference_prices(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notice_id INTEGER REFERENCES notices(id),
  item_name TEXT NOT NULL COLLATE NOCASE,
  unit TEXT,
  unit_price REAL NOT NULL CHECK(unit_price >= 0),
  source_name TEXT NOT NULL,
  source_link TEXT,
  source_contact TEXT,
  notes TEXT,
  published INTEGER NOT NULL DEFAULT 0,
  file_name TEXT,
  added_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(source_link IS NOT NULL OR source_contact IS NOT NULL)
);
CREATE INDEX ix_prices_name ON reference_prices(item_name, published);
CREATE INDEX ix_prices_notice ON reference_prices(notice_id);

CREATE TABLE notifications(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  link TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_notif_user ON notifications(user_id, read_at);

CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE price_files(price_id INTEGER PRIMARY KEY REFERENCES reference_prices(id), data BLOB NOT NULL);
