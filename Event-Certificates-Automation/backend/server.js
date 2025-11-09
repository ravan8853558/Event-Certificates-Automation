// backend/server.js
// ===============================
// UEM Event Certificates - Backend (FINAL WORKING BUILD with QR verify + nice public form + mail)
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

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "cheakstar_secure_secret";
const ADMIN_USER = process.env.ADMIN_USER || "admin@uem.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "UEM@12345";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ====== PATHS ======
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATES_DIR = path.join(UPLOAD_DIR, "templates");
const CERTS_DIR = path.join(UPLOAD_DIR, "certs");
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ====== HELPERS ======
const clamp = (v, min, max) => Math.max(min, Math.min(max, parseFloat(v || 0)));
const escapeXml = (unsafe = "") =>
  String(unsafe).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );

// ====== MULTER for uploads ======
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TEMPLATES_DIR),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ====== SQLITE DB init ======
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

// ====== EXPRESS APP ======
const app = express();
app.use(
  cors({
    origin: "*",
    allowedHeaders: ["Content-Type", "Authorization", "authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// Support JSON + urlencoded (for public form submits)
app.use(bodyParser.json({ limit: "25mb" }));
app.use(bodyParser.urlencoded({ extended: true, limit: "25mb" }));

// serve uploads
app.use("/uploads", express.static(UPLOAD_DIR));

// ====== AUTH HELPERS ======
function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: "12h" });
}
function authMiddleware(req, res, next) {
  const token =
    req.headers.authorization?.split(" ")[1] ||
    req.query.token ||
    req.body.token;
  if (!token) {
    console.log("Auth failed: no token provided");
    return res.status(401).json({ error: "Unauthorized - No token" });
  }
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    console.log("Auth failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ====== ROUTES ======

// Admin login -> returns JWT
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: generateToken() });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

// Health
app.get("/api/test", (_, res) => res.json({ success: true, message: "Backend OK" }));

// Upload template
app.post("/api/upload-template", upload.single("template"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const meta = await sharp(req.file.path).metadata();
    return res.json({
      success: true,
      path: `/uploads/templates/${req.file.filename}`,
      width: meta.width,
      height: meta.height,
    });
  } catch (err) {
    console.error("Upload Error:", err);
    return res.status(500).json({ error: "Upload failed", details: String(err.message) });
  }
});

// Create event (admin)
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
      clamp(p.nameX, 0, 1),
      clamp(p.nameY, 0, 1),
      clamp(p.nameW, 0, 1),
      clamp(p.nameH, 0, 1),
      p.nameFontFamily || "Poppins",
      clamp(p.nameFontSize, 8, 200),
      p.nameFontColor || "#0ea5e9",
      p.nameAlign || "center",
      clamp(p.qrX, 0, 1),
      clamp(p.qrY, 0, 1),
      clamp(p.qrSize, 0.01, 1)
    );

    return res.json({
      success: true,
      eventId: stmt.lastID,
      formLink: `${BASE_URL}/form/${stmt.lastID}`,
    });
  } catch (err) {
    console.error("Create Event Error:", err);
    return res.status(500).json({ error: "Failed to create event", details: String(err.message) });
  }
});

// List events (admin)
app.get("/api/events", authMiddleware, async (_, res) => {
  try {
    const rows = await db.all("SELECT * FROM events ORDER BY id DESC");
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Events Fetch Error:", err);
    return res.status(500).json({ error: "Failed to fetch events", details: String(err.message) });
  }
});

// Public pretty form (Bootstrap) - participants open this link to register
app.get("/form/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ev = await db.get("SELECT id, name, orgBy, date FROM events WHERE id = ?", id);
    if (!ev) return res.status(404).send("Event not found");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeXml(ev.name)} - Certificate Form</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
  <style>
    body { background: linear-gradient(180deg,#eef2ff 0%, #ffffff 100%); }
    .card { max-width:700px; margin:48px auto; border-radius:12px; box-shadow:0 10px 30px rgba(2,6,23,0.08); }
    .brand { color:#0ea5e9; font-weight:700; }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-body p-5">
      <div class="text-center mb-4">
        <h3 class="mb-1">${escapeXml(ev.name)}</h3>
        <div class="text-muted">${escapeXml(ev.orgBy)} • ${escapeXml(ev.date || "")}</div>
      </div>

      <form method="POST" action="/api/submit/${ev.id}" class="row g-3">
        <div class="col-12">
          <label class="form-label">Full name</label>
          <input name="name" class="form-control" required />
        </div>
        <div class="col-12">
          <label class="form-label">Email</label>
          <input name="email" type="email" class="form-control" required />
        </div>
        <div class="col-md-6">
          <label class="form-label">Mobile</label>
          <input name="mobile" class="form-control" />
        </div>
        <div class="col-md-6">
          <label class="form-label">Department</label>
          <input name="dept" class="form-control" />
        </div>
        <div class="col-md-6">
          <label class="form-label">Year</label>
          <input name="year" class="form-control" />
        </div>
        <div class="col-md-6">
          <label class="form-label">Enrollment No.</label>
          <input name="enroll" class="form-control" />
        </div>

        <div class="col-12">
          <button type="submit" class="btn btn-primary w-100">Generate Certificate</button>
        </div>
        <div class="col-12 text-center text-muted small mt-2">
          After submission you will receive the certificate by email (if provided).
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (err) {
    console.error("Form error:", err);
    return res.status(500).send("Server error");
  }
});

// Verification page for QR scans: /verify?name=...&event=...
app.get("/verify", async (req, res) => {
  try {
    const { name, event } = req.query;
    if (!name || !event) return res.status(400).send("Missing params");

    const ev = await db.get("SELECT id,name,orgBy,date,templatePath FROM events WHERE id = ?", event);
    if (!ev) return res.status(404).send("Event not found");

    const rec = await db.get("SELECT * FROM responses WHERE event_id = ? AND name = ?", event, name);
    if (!rec) {
      return res.status(404).send(`<h3>Not found</h3><p>No certificate record found for ${escapeXml(name)}.</p>`);
    }

    const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify - ${escapeXml(ev.name)}</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body style="background:#f7fafc">
  <div class="container py-5">
    <div class="card mx-auto" style="max-width:720px">
      <div class="card-body">
        <h4 class="mb-2">Certificate Verification</h4>
        <p class="text-muted">Record found</p>
        <dl class="row">
          <dt class="col-sm-4">Name</dt><dd class="col-sm-8">${escapeXml(rec.name)}</dd>
          <dt class="col-sm-4">Event</dt><dd class="col-sm-8">${escapeXml(ev.name)}</dd>
          <dt class="col-sm-4">Organized By</dt><dd class="col-sm-8">${escapeXml(ev.orgBy)}</dd>
          <dt class="col-sm-4">Date</dt><dd class="col-sm-8">${escapeXml(ev.date)}</dd>
          <dt class="col-sm-4">Certificate</dt><dd class="col-sm-8"><a href="${escapeXml(rec.cert_path)}" target="_blank">View Certificate</a></dd>
        </dl>
        <div class="alert alert-success">✅ Verified</div>
      </div>
    </div>
  </div>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  } catch (err) {
    console.error("Verify error:", err);
    return res.status(500).send("Server error");
  }
});

// Generate certificate (public POST) - handles JSON or form submits
app.post("/api/submit/:eventId", async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId);
    const ev = await db.get("SELECT * FROM events WHERE id = ?", eId);
    if (!ev) return res.status(404).json({ error: "Event not found" });

    const { name, email, mobile, dept, year, enroll } = req.body || {};
    if (!name || !email) return res.status(400).json({ error: "Missing name/email" });

    const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
    if (!fs.existsSync(tplFull)) {
      console.error("Template missing:", tplFull);
      return res.status(500).json({ error: "Template file missing on server" });
    }

    const meta = await sharp(tplFull).metadata();
    const tplW = meta.width, tplH = meta.height;

    // compute name box pixels
    const nbx = ev.nameBoxX * tplW;
    const nby = ev.nameBoxY * tplH;
    const nbw = ev.nameBoxW * tplW;
    const nbh = ev.nameBoxH * tplH;

    // expanded svg to prevent clipping
    const expandedW = Math.max(nbw * 1.6, nbw + 20);
    const expandedH = Math.max(nbh * 1.8, nbh + 20);

    const PREVIEW_H = 850;
    const scaleY = tplH / PREVIEW_H;
    const baseFont = Math.max(10, Math.round((ev.nameFontSize || 48) * scaleY));
    const maxChars = 28;
    const scaledFont = name.length > maxChars ? Math.floor(baseFont * (maxChars / name.length)) : baseFont;

    const alignMap = { left: "start", center: "middle", right: "end" };
    const textAnchor = alignMap[ev.nameAlign] || "middle";
    const textX = textAnchor === "start" ? scaledFont * 0.6 : textAnchor === "end" ? expandedW - scaledFont * 0.6 : expandedW / 2;
    const textY = expandedH / 2 + Math.round(scaledFont * 0.15);

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${expandedW}" height="${expandedH}">
        <style>
          .t { font-family: '${ev.nameFontFamily || "Poppins"}', sans-serif; font-size: ${scaledFont}px; fill: ${ev.nameFontColor || "#0ea5e9"}; font-weight:600; }
        </style>
        <text x="${textX}" y="${textY}" text-anchor="${textAnchor}" dominant-baseline="middle" class="t">${escapeXml(name)}</text>
      </svg>`;
    const svgBuf = Buffer.from(svg);

    // QR will point to verification URL
    const verifyUrl = `${BASE_URL.replace(/\/$/,"")}/verify?name=${encodeURIComponent(name)}&event=${encodeURIComponent(eId)}`;
    const qrSizePx = Math.max(40, Math.round((ev.qrSize || 0.05) * tplW));
    const qrBuffer = await QRCode.toBuffer(verifyUrl, { type: "png", width: qrSizePx });

    const qrX = Math.round(ev.qrX * tplW);
    const qrY = Math.round(ev.qrY * tplH);

    const svgLeft = Math.round(nbx - (expandedW - nbw) / 2);
    const svgTop = Math.round(nby - (expandedH - nbh) / 2);

    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);

    await sharp(tplFull)
      .composite([
        { input: svgBuf, left: svgLeft, top: svgTop },
        { input: qrBuffer, left: qrX, top: qrY },
      ])
      .png()
      .toFile(certFull);

    const certRel = `/uploads/certs/${certFile}`;
    const insert = await db.run(
      `INSERT INTO responses (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      eId, name, email, mobile || "", dept || "", year || "", enroll || "", certRel, "generated"
    );

    // Try send mail if SMTP configured
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });

      try {
        await transporter.sendMail({
          from: process.env.FROM_EMAIL || process.env.SMTP_USER,
          to: email,
          subject: `Your Certificate - ${ev.name}`,
          text: `Hello ${name},\n\nAttached is your participation certificate for "${ev.name}" held on ${ev.date}.\n\nVerification: ${verifyUrl}`,
          attachments: [{ filename: "certificate.png", path: certFull }],
        });
        await db.run("UPDATE responses SET email_status='sent' WHERE id = ?", insert.lastID);
      } catch (errMail) {
        console.error("Email failed:", errMail);
        await db.run("UPDATE responses SET email_status='failed', email_error=? WHERE id = ?", String(errMail.message), insert.lastID);
      }
    }

    // if request is from form POST (browser) redirect to a simple success page
    const accept = (req.headers.accept || "").toLowerCase();
    if (accept.includes("text/html")) {
      return res.send(`<html><body><h3>Certificate Generated</h3><p>Check your email: ${escapeXml(email)} (if provided). <a href="${certRel}" target="_blank">Open certificate</a></p></body></html>`);
    }

    return res.json({ success: true, certPath: certRel });
  } catch (err) {
    console.error("Cert Generation Error:", err);
    return res.status(500).json({ error: "Failed to generate certificate", details: String(err.message) });
  }
});

// Download CSV + ZIP (admin)
app.get("/api/download-data/:id", authMiddleware, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const responses = await db.all("SELECT * FROM responses WHERE event_id = ?", eventId);
    if (!responses.length) return res.status(404).json({ error: "No data found" });

    const zipName = `event_${eventId}_${Date.now()}.zip`;
    const zipPath = path.join(__dirname, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => res.download(zipPath, zipName, () => fs.unlinkSync(zipPath)));
    archive.pipe(output);

    archive.append(
      "Name,Email,Mobile,Dept,Year,Enroll,CertPath\n" +
        responses.map(r => `"${r.name}","${r.email}","${r.mobile}","${r.dept}","${r.year}","${r.enroll}","${r.cert_path}"`).join("\n"),
      { name: "data.csv" }
    );

    responses.forEach((r) => {
      const certPath = path.join(__dirname, r.cert_path.replace(/^\//, ""));
      if (fs.existsSync(certPath)) archive.file(certPath, { name: `certificates/${r.name.replace(/[^\w]/g, "_")}.png` });
    });

    await archive.finalize();
  } catch (err) {
    console.error("ZIP Error:", err);
    return res.status(500).json({ error: "Failed to export data", details: String(err.message) });
  }
});

// ====== START SERVER ======
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));
