PRAGMA foreign_keys = ON;

-- ================= EVENTS TABLE =================
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  date TEXT,
  venue TEXT,
  orgBy TEXT,
  templatePath TEXT NOT NULL,

  nameBoxX REAL NOT NULL CHECK(nameBoxX >= 0 AND nameBoxX <= 1),
  nameBoxY REAL NOT NULL CHECK(nameBoxY >= 0 AND nameBoxY <= 1),
  nameBoxW REAL NOT NULL CHECK(nameBoxW >= 0 AND nameBoxW <= 1),
  nameBoxH REAL NOT NULL CHECK(nameBoxH >= 0 AND nameBoxH <= 1),

  nameFontFamily TEXT,
  nameFontSize INTEGER CHECK(nameFontSize >= 10 AND nameFontSize <= 300),
  nameFontColor TEXT CHECK(nameFontColor LIKE '#______'),

  nameAlign TEXT DEFAULT 'center'
    CHECK(nameAlign IN ('left','center','right')),

  qrSize REAL CHECK(qrSize >= 0 AND qrSize <= 1),

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- ================= RESPONSES TABLE =================
CREATE TABLE IF NOT EXISTS responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,

  name TEXT NOT NULL,              -- normalized lowercase name
  email TEXT,
  mobile TEXT,
  dept TEXT,
  year TEXT,
  enroll TEXT,

  cert_path TEXT NOT NULL,

  email_status TEXT DEFAULT 'generated'
    CHECK(email_status IN ('generated','sent','failed')),

  email_error TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (event_id)
    REFERENCES events(id)
    ON DELETE CASCADE,

  UNIQUE(event_id, name)           -- duplicate protection
);

CREATE INDEX IF NOT EXISTS idx_responses_event
ON responses(event_id);

CREATE INDEX IF NOT EXISTS idx_responses_created
ON responses(created_at);


-- ================= BULK JOBS TABLE =================
CREATE TABLE IF NOT EXISTS bulk_jobs (
  id TEXT PRIMARY KEY,
  event_id INTEGER NOT NULL,

  total INTEGER NOT NULL CHECK(total >= 0),
  completed INTEGER DEFAULT 0 CHECK(completed >= 0),

  status TEXT DEFAULT 'processing'
    CHECK(status IN ('processing','completed','failed')),

  zip_name TEXT,

  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (event_id)
    REFERENCES events(id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bulk_jobs_status
ON bulk_jobs(status);

