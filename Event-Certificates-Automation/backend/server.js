// ===============================
// UEM Event Certificates - Enterprise Production Build 🔥
// ===============================

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const QRCode = require("qrcode");
const archiver = require("archiver");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ================= ENV =================
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS_HASH = process.env.ADMIN_PASS;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ================= PATHS =================
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATE_DIR = path.join(UPLOAD_DIR, "templates");
const CERT_DIR = path.join(UPLOAD_DIR, "certs");
const TEMP_DIR = path.join(__dirname, "temp");

[UPLOAD_DIR, TEMPLATE_DIR, CERT_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ================= EXPRESS =================
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));

// ================= RATE LIMIT =================
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const submitLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

// ================= DATABASE =================
let db;
(async () => {
  db = await open({
    filename: path.join(__dirname, "data.db"),
    driver: sqlite3.Database
  });

  await db.exec(`
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
  `);

  console.log("Database Ready");
})();

// ================= AUTH =================
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
    res.status(401).json({ error: "Invalid token" });
  }
}

// ================= ROOT =================
app.get("/", (_, res) => res.json({ status: "OK" }));

// ================= LOGIN =================
app.post("/api/admin/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USER)
    return res.status(401).json({ error: "Invalid credentials" });

  const match = await bcrypt.compare(password, ADMIN_PASS_HASH);
  if (!match)
    return res.status(401).json({ error: "Invalid credentials" });

  res.json({ token: generateToken() });
});

// ================= TEMPLATE UPLOAD =================
const upload = multer({ dest: TEMP_DIR });

app.post("/api/upload-template", authMiddleware, upload.single("template"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  if (!req.file.mimetype.startsWith("image/"))
    return res.status(400).json({ error: "Invalid file type" });

  const dest = path.join(TEMPLATE_DIR, req.file.filename + ".png");
  fs.renameSync(req.file.path, dest);

  const meta = await sharp(dest).metadata();

  res.json({
    success: true,
    path: `/uploads/templates/${path.basename(dest)}`,
    width: meta.width,
    height: meta.height
  });
});

// ================= CREATE EVENT =================
app.post("/api/events", authMiddleware, async (req, res) => {
  const p = req.body;

  const stmt = await db.run(`
    INSERT INTO events
    (name,date,venue,orgBy,templatePath,nameBoxX,nameBoxY,nameBoxW,nameBoxH,
     nameFontFamily,nameFontSize,nameFontColor,qrSize)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
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

// ================= GET EVENTS =================
app.get("/api/events", authMiddleware, async (_, res) => {
  const rows = await db.all("SELECT * FROM events ORDER BY id DESC");
  res.json({ success: true, data: rows });
});

// ================= PUBLIC FORM =================
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT * FROM events WHERE id=?", id);
  if (!ev) return res.status(404).send("Event not found");

  res.send(`
    <html>
      <body style="font-family:sans-serif;text-align:center;padding:50px">
        <h2>${ev.name}</h2>
        <form method="POST" action="/api/submit/${ev.id}">
          <input name="name" placeholder="Full Name" required/><br/><br/>
          <input name="email" type="email" placeholder="Email" required/><br/><br/>
          <button>Generate Certificate</button>
        </form>
      </body>
    </html>
  `);
});

// ================= CERTIFICATE GENERATION =================
async function generateCertificate(ev, data) {
  const { name, email } = data;

  const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
  const meta = await sharp(tplFull).metadata();
  const tplW = meta.width;
  const tplH = meta.height;

  const centerX = ev.nameBoxX * tplW;
  const centerY = ev.nameBoxY * tplH;
  const boxW = ev.nameBoxW * tplW;
  const boxH = ev.nameBoxH * tplH;

  // Adaptive Font
  let fontSize = ev.nameFontSize;
  if (name.length > 18) fontSize *= 0.85;
  if (name.length > 28) fontSize *= 0.75;

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

  const qrToken = jwt.sign({ event: ev.id, name }, JWT_SECRET, { expiresIn: "30d" });

  const qrBuffer = await QRCode.toBuffer(`${BASE_URL}/verify/${qrToken}`, {
    width: Math.round(ev.qrSize * tplW),
    margin: 2
  });

  const certFile = `${Date.now()}-${uuidv4()}.png`;
  const certFull = path.join(CERT_DIR, certFile);

  await sharp(tplFull)
    .composite([
      { input: Buffer.from(svg), left: Math.round(centerX - boxW / 2), top: Math.round(centerY - boxH / 2) },
      { input: qrBuffer, left: tplW - 180, top: tplH - 180 }
    ])
    .png()
    .toFile(certFull);

  const certRel = `/uploads/certs/${certFile}`;

  await db.run(`
    INSERT INTO responses (event_id,name,email,cert_path,email_status)
    VALUES (?,?,?,?,?)
  `, ev.id, name, email, certRel, "generated");

  return certRel;
}

// ================= SUBMIT =================
app.post("/api/submit/:eventId", submitLimiter, async (req, res) => {
  const ev = await db.get("SELECT * FROM events WHERE id=?", req.params.eventId);
  if (!ev) return res.status(404).send("Event not found");

  const cert = await generateCertificate(ev, req.body);

  res.send(`<h2>Certificate Generated</h2><a href="${cert}">Download</a>`);
});

// ================= VERIFY =================
app.get("/verify/:token", async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);
    res.send(`<h2>Verified Certificate</h2><p>${data.name}</p>`);
  } catch {
    res.status(400).send("Invalid or expired verification link");
  }
});

// ================= START =================
app.listen(PORT, () => console.log("Server Running"));
