PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  date TEXT,
  venue TEXT,
  orgBy TEXT,
  templatePath TEXT,
  nameBoxX REAL,
  nameBoxY REAL,
  nameBoxW REAL,
  nameBoxH REAL,
  nameFontFamily TEXT,
  nameFontSize INTEGER,
  nameFontColor TEXT,
  qrSize REAL,
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

CREATE TABLE IF NOT EXISTS bulk_jobs (
  id TEXT PRIMARY KEY,
  event_id INTEGER,
  total INTEGER,
  completed INTEGER,
  status TEXT,
  zip_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
