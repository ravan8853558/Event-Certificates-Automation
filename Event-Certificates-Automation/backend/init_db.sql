PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  date TEXT,
  venue TEXT,
  org_by TEXT,
  template_path TEXT,
  template_w INTEGER,
  template_h INTEGER,
  name_x INTEGER,
  name_y INTEGER,
  name_fontsize INTEGER,
  qr_x INTEGER,
  qr_y INTEGER,
  qr_size INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER,
  name TEXT,
  email TEXT,
  mobile TEXT,
  dept TEXT,
  year TEXT,
  enroll TEXT,
  cert_path TEXT,
  email_status TEXT,
  email_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
