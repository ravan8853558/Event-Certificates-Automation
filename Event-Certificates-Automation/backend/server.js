// ===============================
// UEM Event Certificates - Hardened Production Build 🚀
// ===============================

const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));
require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const QRCode = require("qrcode");
const archiver = require("archiver");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS_HASH = process.env.ADMIN_PASS; // store HASH here
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ===== PATHS =====
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATES_DIR = path.join(UPLOAD_DIR, "templates");
const CERTS_DIR = path.join(UPLOAD_DIR, "certs");
const TEMP_DIR = path.join(__dirname, "temp");
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ===== EXPRESS =====
const app = express();

app.use(cors({
  origin: process.env.FRONTEND_URL || "*"
}));

app.use(bodyParser.json({ limit: "25mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "25mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

// ===== RATE LIMIT =====
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: "Too many submissions. Try again later."
});

// ===== SQLITE =====
let db;
(async () => {
  db = await open({
    filename: path.join(__dirname, "data.db"),
    driver: sqlite3.Database,
  });
  await db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, date TEXT, venue TEXT, orgBy TEXT,
      templatePath TEXT,
      nameBoxX REAL, nameBoxY REAL, nameBoxW REAL, nameBoxH REAL,
      nameFontFamily TEXT, nameFontSize INTEGER, nameFontColor TEXT,
      qrSize REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER,
      name TEXT, email TEXT,
      cert_path TEXT,
      email_status TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );
  `);
})();

// ===== AUTH =====
function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: "12h" });
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ===== LOGIN =====
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USER)
    return res.status(401).json({ error: "Invalid credentials" });

  const match = await bcrypt.compare(password, ADMIN_PASS_HASH);
  if (!match)
    return res.status(401).json({ error: "Invalid credentials" });

  res.json({ token: generateToken() });
});

// ===== TEMPLATE UPLOAD =====
const upload = multer({ dest: TEMP_DIR });

app.post("/api/upload-template", authMiddleware, upload.single("template"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  if (!req.file.mimetype.startsWith("image/"))
    return res.status(400).json({ error: "Invalid file type" });

  const dest = path.join(TEMPLATES_DIR, req.file.filename + ".png");
  fs.renameSync(req.file.path, dest);
  const meta = await sharp(dest).metadata();

  res.json({
    success: true,
    path: `/uploads/templates/${path.basename(dest)}`,
    width: meta.width,
    height: meta.height
  });
});

// ===== CREATE EVENT =====
app.post("/api/events", authMiddleware, async (req, res) => {
  const p = req.body;
  const stmt = await db.run(
    `INSERT INTO events
    (name,date,venue,orgBy,templatePath,nameBoxX,nameBoxY,nameBoxW,nameBoxH,nameFontFamily,nameFontSize,nameFontColor,qrSize)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    p.name, p.date, p.venue, p.orgBy, p.templatePath,
    p.nameX, p.nameY, p.nameW, p.nameH,
    p.nameFontFamily, p.nameFontSize, p.nameFontColor,
    p.qrSize
  );
  res.json({ success: true, eventId: stmt.lastID, formLink: `${BASE_URL}/form/${stmt.lastID}` });
});

// ===== FORM SUBMIT =====
app.post("/api/submit/:eventId", submitLimiter, async (req, res) => {
  const eId = parseInt(req.params.eventId);
  const { name, email } = req.body;

  const existing = await db.get(
    "SELECT id FROM responses WHERE event_id=? AND email=?",
    eId, email
  );
  if (existing)
    return res.send("Certificate already generated for this email.");

  const ev = await db.get("SELECT * FROM events WHERE id=?", eId);
  if (!ev) return res.status(404).send("Event not found");

  const certPath = await generateCertificate(ev, name, email);

  res.send(`<h2>Certificate Generated</h2><a href="${certPath}">Download</a>`);
});


// ===== PUBLIC FORM =====
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);

  const ev = await db.get("SELECT * FROM events WHERE id=?", id);
  if (!ev) return res.status(404).send("Event not found");

  res.send(`
  <!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${ev.name} - Certificate</title>
    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">

    <style>
      * {
        box-sizing: border-box;
        font-family: 'Poppins', sans-serif;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: linear-gradient(135deg, #0f172a, #1e293b);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }

      .card {
        background: rgba(255,255,255,0.08);
        backdrop-filter: blur(18px);
        border-radius: 20px;
        padding: 40px;
        width: 100%;
        max-width: 520px;
        box-shadow: 0 20px 40px rgba(0,0,0,0.35);
        color: white;
      }

      .title {
        font-size: 26px;
        font-weight: 600;
        margin-bottom: 6px;
      }

      .subtitle {
        font-size: 14px;
        opacity: 0.8;
        margin-bottom: 30px;
      }

      .form-group {
        margin-bottom: 18px;
      }

      input {
        width: 100%;
        padding: 14px 16px;
        border-radius: 10px;
        border: none;
        outline: none;
        font-size: 15px;
      }

      input:focus {
        box-shadow: 0 0 0 2px #38bdf8;
      }

      button {
        width: 100%;
        padding: 14px;
        border-radius: 10px;
        border: none;
        background: linear-gradient(135deg, #38bdf8, #0ea5e9);
        color: white;
        font-size: 16px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.25s ease;
      }

      button:hover {
        transform: translateY(-2px);
        box-shadow: 0 8px 20px rgba(56,189,248,0.4);
      }

      .footer {
        text-align: center;
        margin-top: 18px;
        font-size: 12px;
        opacity: 0.7;
      }

      @media(max-width: 480px) {
        .card {
          padding: 28px;
        }
      }
    </style>
  </head>

  <body>

    <div class="card">
      <div class="title">${ev.name}</div>
      <div class="subtitle">
        Organized by ${ev.orgBy} • ${ev.date}
      </div>

      <form method="POST" action="/api/submit/${ev.id}">
        <div class="form-group">
          <input name="name" placeholder="Full Name" required>
        </div>

        <div class="form-group">
          <input name="email" type="email" placeholder="Email Address" required>
        </div>

        <button type="submit">Generate Certificate</button>
      </form>

      <div class="footer">
        UEM Certificate Automation System
      </div>
    </div>

  </body>
  </html>
  `);
});
// ===== GENERATE CERTIFICATE =====
async function generateCertificate(ev, name, email) {
  const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
  const meta = await sharp(tplFull).metadata();
  const tplW = meta.width;
  const tplH = meta.height;

  const centerX = ev.nameBoxX * tplW;
  const centerY = ev.nameBoxY * tplH;
  const boxW = ev.nameBoxW * tplW;
  const boxH = ev.nameBoxH * tplH;

  const svg = `
  <svg width="${boxW}" height="${boxH}">
    <text x="50%" y="50%"
      font-family="${ev.nameFontFamily}"
      font-size="${ev.nameFontSize}"
      fill="${ev.nameFontColor}"
      text-anchor="middle"
      dominant-baseline="middle"
      font-weight="600">
      ${name}
    </text>
  </svg>`;

  const certFile = `${Date.now()}-${uuidv4()}.png`;
  const certFull = path.join(CERTS_DIR, certFile);

  await sharp(tplFull)
    .composite([
      {
        input: Buffer.from(svg),
        left: Math.round(centerX - boxW / 2),
        top: Math.round(centerY - boxH / 2)
      }
    ])
    .png()
    .toFile(certFull);

  const certRel = `/uploads/certs/${certFile}`;

  const stmt = await db.run(
    `INSERT INTO responses (event_id,name,email,cert_path,email_status)
     VALUES (?,?,?,?,?)`,
    ev.id, name, email, certRel, "generated"
  );

  // Async email
  setImmediate(async () => {
    try {
      const certBuffer = fs.readFileSync(certFull);
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.FROM_EMAIL,
          to: email,
          subject: `Certificate - ${ev.name}`,
          attachments: [{
            filename: `${name}.png`,
            content: certBuffer.toString("base64"),
            encoding: "base64"
          }]
        })
      });
      await db.run("UPDATE responses SET email_status='sent' WHERE id=?", stmt.lastID);
    } catch {}
  });

  return certRel;
}

// ===== START =====
app.listen(PORT, () => console.log("Server running"));


