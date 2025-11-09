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

// ========= PUBLIC FORM =========
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT * FROM events WHERE id=?", id);
  if (!ev) return res.status(404).send("Event not found");

  res.send(`
  <!doctype html>
  <html><head><meta charset="utf-8"><title>${ev.name}</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"></head>
  <body class="bg-light"><div class="container py-5">
  <div class="card shadow-lg p-4 mx-auto" style="max-width:700px">
  <h3>${ev.name}</h3><p class="text-muted">${ev.orgBy} • ${ev.date}</p>
  <form method="POST" action="/api/submit/${ev.id}">
    <input name="name" placeholder="Full Name" required class="form-control mb-2">
    <input name="email" type="email" placeholder="Email" required class="form-control mb-2">
    <input name="mobile" placeholder="Mobile" class="form-control mb-2">
    <input name="dept" placeholder="Department" class="form-control mb-2">
    <input name="year" placeholder="Year" class="form-control mb-2">
    <input name="enroll" placeholder="Enrollment No" class="form-control mb-3">
    <button class="btn btn-primary w-100">Generate Certificate</button>
  </form></div></div></body></html>`);
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
  const nbw = ev.nameBoxW * tplW * 1.2;
  const nbh = ev.nameBoxH * tplH;

  // --- Expand text box slightly to avoid clipping ---
  const safeW = nbw * 2.4;
  const safeH = nbh * 2.0;

  // --- Font scaling logic (adaptive font size) ---
const baseFont = Math.max(10, ev.nameFontSize || 36);
let scaledFont = baseFont;

if (name.length > 12) scaledFont = baseFont * 0.9;
if (name.length > 18) scaledFont = baseFont * 0.8;
if (name.length > 25) scaledFont = baseFont * 0.7;
if (name.length > 35) scaledFont = baseFont * 0.6;

scaledFont = Math.round(scaledFont);

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
  
  let qrSizePx = Math.round((ev.qrSize || 0.18) * tplW);
  qrSizePx = Math.min(Math.max(qrSizePx, 100), tplW * 0.12);
  const qrBuffer = await QRCode.toBuffer(
    `${BASE_URL}/verify?name=${encodeURIComponent(name)}&event=${ev.id}`,
    {
    width: qrSizePx,
    errorCorrectionLevel: "Q", // ↑ better redundancy
    margin: 4,                 // ↑ better edge spacing
    color: {
      dark: "#000000",         // pure black for strong contrast
      light: "#FFFFFF"         // pure white background
     }
    }
  );

  const qrX = Math.round(ev.qrX * tplW - qrSizePx * 0.1);
  const qrY = Math.round(ev.qrY * tplH - qrSizePx * 0.1);

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

// ========= VERIFY CERTIFICATE =========
app.get("/verify", async (req, res) => {
  const { name, event } = req.query;
  if (!name || !event)
    return res.status(400).send("Missing parameters");

  const ev = await db.get("SELECT * FROM events WHERE id=?", event);
  const rec = await db.get("SELECT * FROM responses WHERE event_id=? AND name=?", event, name);

  if (!ev || !rec)
    return res.status(404).send(`<h3>Not Found</h3><p>No record for ${escapeXml(name)}</p>`);

  res.send(`
    <div style="font-family:sans-serif; text-align:center; margin-top:40px;">
      <h2>✅ Verified Certificate</h2>
      <p><b>${escapeXml(rec.name)}</b> participated in <b>${escapeXml(ev.name)}</b></p>
      <p>Organized by: <b>${escapeXml(ev.orgBy)}</b> on <b>${escapeXml(ev.date)}</b></p>
      <p><a href="${rec.cert_path}" target="_blank">View Certificate</a></p>
    </div>
  `);
});

// ========= DOWNLOAD DATA =========
app.get("/api/download-data/:id", authMiddleware, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const responses = await db.all("SELECT * FROM responses WHERE event_id = ?", eventId);
    if (!responses.length) return res.status(404).json({ error: "No data found" });

    const zipName = `event_${eventId}_${Date.now()}.zip`;
    const zipPath = path.join(__dirname, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      res.download(zipPath, zipName, () => fs.unlinkSync(zipPath));
    });
    archive.pipe(output);

    // CSV data
    archive.append(
      "Name,Email,Mobile,Dept,Year,Enroll,CertPath\n" +
        responses.map(r =>
          `"${r.name}","${r.email}","${r.mobile}","${r.dept}","${r.year}","${r.enroll}","${r.cert_path}"`
        ).join("\n"),
      { name: "data.csv" }
    );

    // Certificates
    for (const r of responses) {
      const certPath = path.join(__dirname, r.cert_path.replace(/^\//, ""));
      if (fs.existsSync(certPath))
        archive.file(certPath, { name: `certificates/${r.name.replace(/[^\w]/g, "_")}.png` });
    }

    await archive.finalize();
  } catch (err) {
    console.error("Download Error:", err);
    res.status(500).json({ error: "Download failed", details: err.message });
  }
});

// ====== START SERVER ======
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running at ${BASE_URL}`));












