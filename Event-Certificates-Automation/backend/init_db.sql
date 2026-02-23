PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  date TEXT,
  venue TEXT,
  orgBy TEXT,
  templatePath TEXT NOT NULL,
  nameBoxX REAL NOT NULL,
  nameBoxY REAL NOT NULL,
  nameBoxW REAL NOT NULL,
  nameBoxH REAL NOT NULL,
  nameFontFamily TEXT,
  nameFontSize INTEGER,
  nameFontColor TEXT,
  qrSize REAL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  mobile TEXT,
  dept TEXT,
  year TEXT,
  enroll TEXT,
  cert_path TEXT NOT NULL,
  email_status TEXT DEFAULT 'generated',
  email_error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bulk_jobs (
  id TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL,
  total INTEGER NOT NULL,
  completed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'processing',
  zip_name TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);
