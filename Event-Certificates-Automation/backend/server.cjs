require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/* ================= ENV ================= */

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS_HASH = process.env.ADMIN_PASS;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

/* ================= PATHS ================= */

const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATE_DIR = path.join(UPLOAD_DIR, "templates");
const CERT_DIR = path.join(UPLOAD_DIR, "certs");
const TEMP_DIR = path.join(__dirname, "temp");

[UPLOAD_DIR, TEMPLATE_DIR, CERT_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* ================= EXPRESS ================= */

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const submitLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

/* ================= DATABASE ================= */

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

/* ================= AUTH ================= */

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

/* ================= LOGIN ================= */

app.post("/api/admin/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USER)
    return res.status(401).json({ error: "Invalid credentials" });

  const match = await bcrypt.compare(password, ADMIN_PASS_HASH);
  if (!match)
    return res.status(401).json({ error: "Invalid credentials" });

  res.json({ token: generateToken() });
});

/* ================= CERTIFICATE GENERATION ================= */

async function generateCertificate(ev, data) {
  const { name, email } = data;

  const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
  const meta = await sharp(tplFull).metadata();
  const tplW = meta.width;
  const tplH = meta.height;

  const boxW = ev.nameBoxW * tplW;
  const boxH = ev.nameBoxH * tplH;

  const safeName = String(name).trim();
  let fontSize = ev.nameFontSize;

  const approxWidth = safeName.length * (fontSize * 0.6);
  if (approxWidth > boxW) {
    fontSize = Math.floor((boxW / approxWidth) * fontSize * 0.95);
  }
  fontSize = Math.max(fontSize, 18);

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${boxW}" height="${boxH}">
    <text x="${boxW/2}" y="${boxH/2}"
      font-family="${ev.nameFontFamily}"
      font-size="${fontSize}"
      fill="${ev.nameFontColor}"
      text-anchor="middle"
      dominant-baseline="middle">
      ${safeName}
    </text>
  </svg>`;

  const qrToken = jwt.sign({ event: ev.id, name: safeName }, JWT_SECRET, { expiresIn: "30d" });

  let qrSizePx = Math.round(ev.qrSize * tplW);
  qrSizePx = Math.max(qrSizePx, 180);
  qrSizePx = Math.min(qrSizePx, tplW * 0.25);

  const padding = Math.round(tplW * 0.04);

  const qrBuffer = await QRCode.toBuffer(
    `${BASE_URL}/verify/${qrToken}`,
    { width: qrSizePx, errorCorrectionLevel: "H", margin: 6 }
  );

  const certFile = `${Date.now()}-${uuidv4()}.png`;
  const certFull = path.join(CERT_DIR, certFile);

  await sharp(tplFull)
    .composite([
      {
        input: Buffer.from(svg),
        left: Math.round(ev.nameBoxX * tplW - boxW / 2),
        top: Math.round(ev.nameBoxY * tplH - boxH / 2)
      },
      {
        input: qrBuffer,
        left: tplW - qrSizePx - padding,
        top: tplH - qrSizePx - padding
      }
    ])
    .png({ quality: 100 })
    .toFile(certFull);

  const certRel = `/uploads/certs/${certFile}`;

  await db.run(
    `INSERT INTO responses (event_id,name,email,cert_path,email_status)
     VALUES (?,?,?,?,?)`,
    ev.id,
    safeName,
    email,
    certRel,
    "generated"
  );

  /* ===== SEND EMAIL ===== */
  try {
    const certBuffer = fs.readFileSync(certFull);

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.FROM_EMAIL,
        to: email,
        subject: `🎓 Certificate - ${ev.name}`,
        html: `<p>Dear ${safeName},</p>
               <p>You successfully participated in ${ev.name}.</p>`,
        attachments: [{
          filename: `${safeName.replace(/[^\w]/g,"_")}.png`,
          content: certBuffer.toString("base64")
        }]
      })
    });

    if (response.ok) {
      await db.run(`UPDATE responses SET email_status=? WHERE cert_path=?`,
        "sent", certRel);
    }
  } catch (err) {
    await db.run(`UPDATE responses SET email_status=?, email_error=? WHERE cert_path=?`,
      "failed", err.message, certRel);
  }

  return certRel;
}

/* ================= START ================= */

app.listen(PORT, () => console.log("Server Running on", PORT));
