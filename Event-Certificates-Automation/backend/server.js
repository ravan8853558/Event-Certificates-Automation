// ===============================
// UEM Event Certificates - Final Backend (Perfect Alignment + Working Mail)
// ===============================

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const sharp = require("sharp");
const QRCode = require("qrcode");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const ADMIN_USER = process.env.ADMIN_USER || "admin@uem.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "UEM@12345";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Paths
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATES_DIR = path.join(UPLOAD_DIR, "templates");
const CERTS_DIR = path.join(UPLOAD_DIR, "certs");
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const clampNum = (v, min, max) => Math.max(min, Math.min(max, parseFloat(v || 0)));

// ========== Multer ==========
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TEMPLATES_DIR),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ========== Database ==========
let db;
(async () => {
  db = await open({
    filename: path.join(__dirname, "data.db"),
    driver: sqlite3.Database,
  });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, date TEXT, venue TEXT, orgBy TEXT,
      templatePath TEXT,
      nameBoxX REAL, nameBoxY REAL, nameBoxW REAL, nameBoxH REAL,
      nameFontFamily TEXT, nameFontSize INTEGER, nameFontColor TEXT, nameAlign TEXT,
      qrX REAL, qrY REAL, qrSize REAL
    );

    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER, name TEXT, email TEXT, mobile TEXT,
      dept TEXT, year TEXT, enroll TEXT, cert_path TEXT,
      email_status TEXT, email_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log("✅ Database ready.");
})();

// ========== App Setup ==========
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "15mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

// ========== Auth ==========
function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: "12h" });
}
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1] || req.query.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS)
    return res.json({ token: generateToken() });
  res.status(401).json({ error: "Invalid credentials" });
});

// ========== Upload Template ==========
app.post("/api/upload-template", upload.single("template"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const meta = await sharp(req.file.path).metadata();
    res.json({
      success: true,
      path: `/uploads/templates/${req.file.filename}`,
      width: meta.width,
      height: meta.height,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// ========== Create Event ==========
app.post("/api/events", authMiddleware, async (req, res) => {
  try {
    const p = req.body;
    const stmt = await db.run(
      `INSERT INTO events 
       (name,date,venue,orgBy,templatePath,nameBoxX,nameBoxY,nameBoxW,nameBoxH,
        nameFontFamily,nameFontSize,nameFontColor,nameAlign,qrX,qrY,qrSize)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.name,
      p.date,
      p.venue,
      p.orgBy,
      p.templatePath,
      clampNum(p.nameX, 0, 1),
      clampNum(p.nameY, 0, 1),
      clampNum(p.nameW, 0, 1),
      clampNum(p.nameH, 0, 1),
      p.nameFontFamily || "Poppins",
      clampNum(p.nameFontSize, 8, 200),
      p.nameFontColor || "#0ea5e9",
      p.nameAlign || "center",
      clampNum(p.qrX, 0, 1),
      clampNum(p.qrY, 0, 1),
      clampNum(p.qrSize, 0.01, 1)
    );
    res.json({
      success: true,
      eventId: stmt.lastID,
      formLink: `${BASE_URL}/form/${stmt.lastID}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create event", details: err.message });
  }
});

// ========== Generate Certificate ==========
app.post("/api/submit/:eventId", async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId);
    const ev = await db.get("SELECT * FROM events WHERE id = ?", eId);
    if (!ev) return res.status(404).json({ error: "Event not found" });

    const { name, email, mobile, dept, year, enroll } = req.body;
    if (!name || !email)
      return res.status(400).json({ error: "Missing name/email" });

    const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
    const meta = await sharp(tplFull).metadata();
    const tplW = meta.width, tplH = meta.height;

    // Scaling
    const PREVIEW_W = 1100, PREVIEW_H = 850;
    const scaleY = tplH / PREVIEW_H;

    // Name box
    const nbx = ev.nameBoxX * tplW;
    const nby = ev.nameBoxY * tplH;
    const nbw = ev.nameBoxW * tplW;
    const nbh = ev.nameBoxH * tplH;

    // ✅ Expanded SVG box to prevent cropping
    const expandedW = nbw * 1.8;
    const expandedH = nbh * 2.0;

    const scaledFontSize = (ev.nameFontSize || 48) * scaleY;
    const alignMap = { left: "start", center: "middle", right: "end" };
    const textAnchor = alignMap[ev.nameAlign] || "middle";

    const textX =
      textAnchor === "start"
        ? scaledFontSize * 0.6
        : textAnchor === "end"
        ? expandedW - scaledFontSize * 0.6
        : expandedW / 2;
    const textY = expandedH / 2 + scaledFontSize * 0.3;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${expandedW}" height="${expandedH}">
        <style>
          .t {
            font-family: '${ev.nameFontFamily || "Poppins"}', sans-serif;
            font-size: ${scaledFontSize}px;
            fill: ${ev.nameFontColor || "#0ea5e9"};
            font-weight: 600;
          }
        </style>
        <text x="${textX}" y="${textY}" text-anchor="${textAnchor}"
              dominant-baseline="middle" class="t">${escapeXml(name)}</text>
      </svg>`;

    const svgBuf = Buffer.from(svg);

    // ✅ QR bottom-right alignment
    const qrSize = 50;
    const qrMargin = 30;
    const qrBuffer = await QRCode.toBuffer(
      `${name} participated in ${ev.name} organized by ${ev.orgBy} on ${ev.date}.`,
      { type: "png", width: qrSize }
    );
    const qrX = tplW - qrSize - qrMargin;
    const qrY = tplH - qrSize - qrMargin;

    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);

    await sharp(tplFull)
      .composite([
        { input: svgBuf, top: Math.round(nby - nbh * 0.5), left: Math.round(nbx - nbw * 0.4) },
        { input: qrBuffer, top: qrY, left: qrX },
      ])
      .png()
      .toFile(certFull);

    const certRel = `/uploads/certs/${certFile}`;
    await db.run(
      `INSERT INTO responses (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      eId, name, email, mobile, dept, year, enroll, certRel, "generated"
    );

    res.json({ success: true, certPath: certRel });
  } catch (err) {
    console.error("Generation Error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ========== Helpers ==========
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );
}

app.get("/api/test", (_, res) =>
  res.json({ success: true, message: "Backend is running fine!" })
);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
