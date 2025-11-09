// ===============================
// UEM Event Certificates - Backend (FINAL STABLE BUILD ✅)
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
const xlsx = require("xlsx");
const csv = require("csv-parser");

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "cheakstar_secure_secret";
const ADMIN_USER = process.env.ADMIN_USER || "admin@uem.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "UEM@12345";
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ====== PATHS ======
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATES_DIR = path.join(UPLOAD_DIR, "templates");
const CERTS_DIR = path.join(UPLOAD_DIR, "certs");
const TEMP_DIR = path.join(__dirname, "temp");
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR, TEMP_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ====== HELPERS ======
const clamp = (v, min, max) => Math.max(min, Math.min(max, parseFloat(v || 0)));
const escapeXml = (unsafe = "") =>
  String(unsafe).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );

// ====== MULTER ======
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TEMP_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ====== SQLITE ======
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
      nameFontFamily TEXT, nameFontSize INTEGER, nameFontColor TEXT, nameAlign TEXT,
      qrX REAL, qrY REAL, qrSize REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER, name TEXT, email TEXT, mobile TEXT,
      dept TEXT, year TEXT, enroll TEXT, cert_path TEXT,
      email_status TEXT, email_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );
  `);
  console.log("✅ Database initialized");
})();

// ====== EXPRESS ======
const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.use(bodyParser.json({ limit: "25mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "25mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

// Root route check
app.get("/", (_, res) => res.json({ success: true, message: "Server Root OK" }));

// ====== AUTH ======
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
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ====== ROUTES ======
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS)
    return res.json({ token: generateToken() });
  res.status(401).json({ error: "Invalid credentials" });
});

app.get("/api/test", (_, res) => res.json({ success: true, message: "Backend OK" }));

// ========= UPLOAD TEMPLATE =========
app.post("/api/upload-template", upload.single("template"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const dest = path.join(TEMPLATES_DIR, req.file.filename);
    fs.renameSync(req.file.path, dest);
    const meta = await sharp(dest).metadata();
    res.json({
      success: true,
      path: `/uploads/templates/${req.file.filename}`,
      width: meta.width,
      height: meta.height,
    });
  } catch (err) {
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// ========= CREATE EVENT =========
app.post("/api/events", authMiddleware, async (req, res) => {
  try {
    const p = req.body;
    const stmt = await db.run(
      `INSERT INTO events 
       (name,date,venue,orgBy,templatePath,nameBoxX,nameBoxY,nameBoxW,nameBoxH,
        nameFontFamily,nameFontSize,nameFontColor,nameAlign,qrX,qrY,qrSize)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.name, p.date, p.venue, p.orgBy, p.templatePath,
      clamp(p.nameX,0,1), clamp(p.nameY,0,1), clamp(p.nameW,0,1), clamp(p.nameH,0,1),
      p.nameFontFamily || "Poppins", clamp(p.nameFontSize,8,200),
      p.nameFontColor || "#0ea5e9", p.nameAlign || "center",
      clamp(p.qrX,0,1), clamp(p.qrY,0,1), clamp(p.qrSize,0.01,1)
    );
    res.json({ success: true, eventId: stmt.lastID, formLink: `${BASE_URL}/form/${stmt.lastID}` });
  } catch (err) {
    res.status(500).json({ error: "Failed to create event", details: err.message });
  }
});

// ========= GET EVENTS =========
app.get("/api/events", authMiddleware, async (_, res) => {
  try {
    const rows = await db.all("SELECT * FROM events ORDER BY id DESC");
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// ========= PUBLIC FORM SUBMIT =========
app.post("/api/submit/:eventId", bodyParser.urlencoded({ extended: true }), async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId);
    const ev = await db.get("SELECT * FROM events WHERE id=?", eId);
    if (!ev) return res.status(404).send("Event not found");

    // Certificate generation
    const certPath = await generateCertificate(ev, req.body);

    res.send(`
      <div style="text-align:center; padding:40px; font-family:sans-serif;">
        <h2>✅ Certificate Generated Successfully!</h2>
        <p><a href="${certPath}" target="_blank" style="color:blue;">Click here to view certificate</a></p>
      </div>
    `);
  } catch (err) {
    console.error("Form Submit Error:", err);
    res.status(500).send("Error generating certificate: " + err.message);
  }
});

// ========= GENERATE CERTIFICATE =========
async function generateCertificate(ev, data) {
  const { name, email, mobile, dept, year, enroll } = data;

  // --- Template image path ---
  const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
  const meta = await sharp(tplFull).metadata();
  const tplW = meta.width, tplH = meta.height;

  // --- Name box positioning ---
  const nbx = ev.nameBoxX * tplW;
  const nby = ev.nameBoxY * tplH;
  const nbw = ev.nameBoxW * tplW;
  const nbh = ev.nameBoxH * tplH;

  // --- Expand text box slightly to avoid clipping ---
  const safeW = nbw * 1.8;
  const safeH = nbh * 2.0;

  // --- Font scaling logic (adaptive font size) ---
  const baseFont = Math.max(10, ev.nameFontSize || 48);
  const scaledFont =
    name.length > 32 ? Math.floor(baseFont * (26 / name.length)) :
    name.length > 20 ? Math.floor(baseFont * (30 / name.length)) :
    baseFont;

  // --- SVG for participant name (perfectly centered) ---
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${safeW}" height="${safeH}">
    <style>
      .t {
        font-family: '${ev.nameFontFamily}', sans-serif;
        font-size: ${scaledFont}px;
        fill: ${ev.nameFontColor};
        font-weight: 600;
      }
    </style>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" class="t">
      ${escapeXml(name)}
    </text>
  </svg>`;
  const svgBuf = Buffer.from(svg);

  // --- Bigger and cleaner QR (easy to scan) ---
  const qrSizePx = Math.max(140, Math.round((ev.qrSize || 0.14) * tplW)); // increase clarity
  const qrBuffer = await QRCode.toBuffer(
    `${BASE_URL}/verify?name=${encodeURIComponent(name)}&event=${ev.id}`,
    { width: qrSizePx, errorCorrectionLevel: "M", margin: 3 }
  );

  const qrX = Math.round(ev.qrX * tplW);
  const qrY = Math.round(ev.qrY * tplH);

  // --- Adjust SVG centering relative to name box ---
  const svgLeft = Math.round(nbx - (safeW - nbw) / 2);
  const svgTop = Math.round(nby - (safeH - nbh) / 2);

  // --- Generate final certificate ---
  const certFile = `${Date.now()}-${uuidv4()}.png`;
  const certFull = path.join(CERTS_DIR, certFile);

  await sharp(tplFull)
    .composite([
      { input: svgBuf, left: svgLeft, top: svgTop },
      { input: qrBuffer, left: qrX, top: qrY }
    ])
    .png()
    .toFile(certFull);

  const certRel = `/uploads/certs/${certFile}`;

  // --- Save to DB ---
  await db.run(
    `INSERT INTO responses (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ev.id, name, email, mobile || "", dept || "", year || "", enroll || "", certRel, "generated"
  );

  return certRel;
}

// ====== START SERVER ======
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running at ${BASE_URL}`));


