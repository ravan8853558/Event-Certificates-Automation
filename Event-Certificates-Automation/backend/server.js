// ===============================
// UEM Event Certificates - Final Production Build 🚀
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
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS_HASH = process.env.ADMIN_PASS;
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

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
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

app.post("/api/upload-template", upload.single("template"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

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
app.post("/api/events", async (req, res) => {
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

  res.json({
    success: true,
    eventId: stmt.lastID,
    formLink: `${BASE_URL}/form/${stmt.lastID}`
  });
});

// ===== PUBLIC FORM =====
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT * FROM events WHERE id=?", id);
  if (!ev) return res.status(404).send("Event not found");

  res.send(`
  <html>
  <body style="font-family:sans-serif;text-align:center;padding:50px">
    <h2>${ev.name}</h2>
    <p>${ev.orgBy} • ${ev.date}</p>
    <form method="POST" action="/api/submit/${ev.id}">
      <input name="name" placeholder="Full Name" required><br><br>
      <input name="email" type="email" placeholder="Email" required><br><br>
      <button>Generate Certificate</button>
    </form>
  </body>
  </html>
  `);
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
    return res.send("Certificate already generated.");

  const ev = await db.get("SELECT * FROM events WHERE id=?", eId);
  if (!ev) return res.status(404).send("Event not found");

  const certPath = await generateCertificate(ev, name);

  res.send(`
  <html>
  <body style="text-align:center;padding:50px;font-family:sans-serif">
    <h2 style="color:green">✓ Certificate Generated</h2>
    <a href="${certPath}" target="_blank">View Certificate</a>
  </body>
  </html>
  `);
});

// ===== GENERATE CERTIFICATE =====
async function generateCertificate(ev, name) {

  const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
  const meta = await sharp(tplFull).metadata();
  const tplW = meta.width;
  const tplH = meta.height;

  const centerX = ev.nameBoxX * tplW;
  const centerY = ev.nameBoxY * tplH;
  const boxW = ev.nameBoxW * tplW;
  const boxH = ev.nameBoxH * tplH;

  // Dynamic font scaling
  let fontSize = ev.nameFontSize;

  if (name.length > 20) fontSize *= 0.8;
  if (name.length > 30) fontSize *= 0.7;
  if (name.length > 40) fontSize *= 0.6;

  const svg = `
  <svg width="${boxW}" height="${boxH}">
    <text x="50%" y="50%"
      font-family="${ev.nameFontFamily}"
      font-size="${fontSize}"
      fill="${ev.nameFontColor}"
      text-anchor="middle"
      dominant-baseline="middle"
      font-weight="600">
      ${name}
    </text>
  </svg>`;

  // QR
  const qrSize = Math.round(tplW * 0.12);
  const qrBuffer = await QRCode.toBuffer(
    \`\${BASE_URL}/verify?name=\${encodeURIComponent(name)}&event=\${ev.id}\`,
    { width: qrSize }
  );

  const certFile = \`\${Date.now()}-\${uuidv4()}.png\`;
  const certFull = path.join(CERTS_DIR, certFile);

  await sharp(tplFull)
    .composite([
      {
        input: Buffer.from(svg),
        left: Math.round(centerX - boxW / 2),
        top: Math.round(centerY - boxH / 2)
      },
      {
        input: qrBuffer,
        left: tplW - qrSize - 40,
        top: tplH - qrSize - 40
      }
    ])
    .png()
    .toFile(certFull);

  return \`/uploads/certs/\${certFile}\`;
}

app.listen(PORT, () => console.log("Server running 🚀"));
