-- NIMRA on MySQL 8 (also works on MariaDB 10.5+). Reached from the Worker through Cloudflare Hyperdrive.
-- Run once:   mysql -h HOST -u USER -p nimra < migrations/0001_init.sql
-- utf8mb4_unicode_ci is case-insensitive, so "A4 Paper" and "a4 paper" are the same item name.
-- No FOREIGN KEY constraints (TiDB-friendly); the Worker checks every link itself.
-- Times are stored in UTC (the Worker sets the session time zone to +00:00).

CREATE TABLE IF NOT EXISTS organisations(
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  kind VARCHAR(12) NOT NULL,
  code VARCHAR(30) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_org_code (code),
  CONSTRAINT ck_org_kind CHECK (kind IN ('Admin','Institution','Supplier'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users(
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  pin_hash VARCHAR(128) NOT NULL,
  pin_salt VARCHAR(64) NOT NULL,
  role VARCHAR(12) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY ux_users_phone (phone),
  KEY ix_users_org (org_id),
  CONSTRAINT ck_users_role CHECK (role IN ('Admin','Institution','Supplier'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sessions(
  token_hash CHAR(64) NOT NULL PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  KEY ix_sessions_user (user_id),
  KEY ix_sessions_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts(
  phone VARCHAR(20) NOT NULL PRIMARY KEY,
  fails INT NOT NULL DEFAULT 0,
  locked_until DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings(
  k VARCHAR(60) NOT NULL PRIMARY KEY,
  v VARCHAR(200) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT IGNORE INTO settings(k,v) VALUES ('MarkupMaxPercent','30'),('WastageThresholdPercent','10');

-- each institution can set its own limits; NULL = use the global setting
CREATE TABLE IF NOT EXISTS institution_settings(
  org_id INT UNSIGNED NOT NULL PRIMARY KEY,
  wastage_threshold_percent DECIMAL(9,2) NULL,
  margin_limit_percent DECIMAL(9,2) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notices(
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  institution_id INT UNSIGNED NOT NULL,
  supplier_id INT UNSIGNED NOT NULL,
  title VARCHAR(300) NOT NULL,
  quantity DECIMAL(18,3) NOT NULL,
  unit VARCHAR(30) NOT NULL,
  needed_by DATE NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'NOTIFIED',
  quote_version INT NOT NULL DEFAULT 0,
  cancel_reason VARCHAR(500) NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  items_recorded_at DATETIME NULL,
  approved_at DATETIME NULL,
  completed_at DATETIME NULL,
  KEY ix_notices_inst (institution_id, status),
  KEY ix_notices_supp (supplier_id, status),
  CONSTRAINT ck_notices_qty CHECK (quantity > 0),
  CONSTRAINT ck_notices_status CHECK (status IN ('NOTIFIED','ITEMS_RECORDED','RETURNED','APPROVED','COMPLETED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- the items a supplier records for a notice: what it costs the supplier and what it charges
CREATE TABLE IF NOT EXISTS quote_lines(
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notice_id INT UNSIGNED NOT NULL,
  description VARCHAR(300) NOT NULL,
  quantity DECIMAL(18,3) NOT NULL,
  unit_cost DECIMAL(18,2) NOT NULL,
  unit_price DECIMAL(18,2) NOT NULL,
  barcode VARCHAR(14) NULL,                -- optional: the supplier may not have bought the goods yet
  KEY ix_lines_notice (notice_id),
  CONSTRAINT ck_lines_qty CHECK (quantity > 0),
  CONSTRAINT ck_lines_cost CHECK (unit_cost >= 0),
  CONSTRAINT ck_lines_price CHECK (unit_price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notice_events(
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notice_id INT UNSIGNED NOT NULL,
  kind VARCHAR(30) NOT NULL,
  comment VARCHAR(1000) NULL,
  user_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_events_notice (notice_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- reference prices: always the price of ONE single item. The optional PDF is in price_files.
CREATE TABLE IF NOT EXISTS reference_prices(
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  notice_id INT UNSIGNED NULL,
  item_name VARCHAR(300) NOT NULL,
  unit VARCHAR(30) NULL,
  unit_price DECIMAL(18,2) NOT NULL,
  source_name VARCHAR(200) NOT NULL,
  source_link VARCHAR(500) NULL,
  source_contact VARCHAR(200) NULL,
  notes VARCHAR(500) NULL,
  published TINYINT(1) NOT NULL DEFAULT 0,
  file_name VARCHAR(120) NULL,
  added_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_prices_name (item_name(100), published),
  KEY ix_prices_notice (notice_id),
  CONSTRAINT ck_prices_price CHECK (unit_price >= 0),
  CONSTRAINT ck_prices_source CHECK (source_link IS NOT NULL OR source_contact IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications(
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  kind VARCHAR(30) NOT NULL,
  message VARCHAR(1500) NOT NULL,
  link VARCHAR(200) NULL,
  read_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_notif_user (user_id, read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log(
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  action VARCHAR(40) NOT NULL,
  entity VARCHAR(40) NULL,
  entity_id INT UNSIGNED NULL,
  detail VARCHAR(1000) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- research PDFs (max 5 MB each, checked by the Worker). Needs max_allowed_packet of at least 8 MB on the server (MySQL 8 default is 64 MB).
CREATE TABLE IF NOT EXISTS price_files(
  price_id INT UNSIGNED NOT NULL PRIMARY KEY,
  data LONGBLOB NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
