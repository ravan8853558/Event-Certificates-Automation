// ===============================
// UEM Event Certificates - Backend (FINAL WORKING BUILD)
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

// ====== DIRECTORIES ======
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

// ====== MULTER ======
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TEMPLATES_DIR),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
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
app.use(
  cors({
    origin: "*",
    allowedHeaders: ["Content-Type", "Authorization", "authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);
app.use(bodyParser.json({ limit: "25mb" }));
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

// Admin login (returns JWT)
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: generateToken() });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

// Health check
app.get("/api/test", (_, res) => res.json({ success: true, message: "Backend OK" }));

// Upload certificate template
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

// Public form (simple HTML) for participants to submit — useful for testing and sharing
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT id, name FROM events WHERE id = ?", id);
  if (!ev) return res.status(404).send("Event not found");

  const html = `
    <!doctype html>
    <html>
      <head><meta charset="utf-8"><title>Register - ${ev.name}</title></head>
      <body>
        <h2>${ev.name} - Certificate Form</h2>
        <form method="POST" action="/api/submit/${ev.id}">
          <label>Full name: <input name="name" required /></label><br/>
          <label>Email: <input name="email" type="email" required /></label><br/>
          <label>Mobile: <input name="mobile" /></label><br/>
          <label>Dept: <input name="dept" /></label><br/>
          <label>Year: <input name="year" /></label><br/>
          <label>Enroll: <input name="enroll" /></label><br/>
          <button type="submit">Generate Certificate</button>
        </form>
      </body>
    </html>
  `;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
});

// Generate certificate (public)
app.post("/api/submit/:eventId", async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId);
    const ev = await db.get("SELECT * FROM events WHERE id = ?", eId);
    if (!ev) return res.status(404).json({ error: "Event not found" });

    const { name, email, mobile, dept, year, enroll } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Missing name/email" });

    const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
    if (!fs.existsSync(tplFull)) {
      console.error("Template missing:", tplFull);
      return res.status(500).json({ error: "Template file missing on server" });
    }

    const meta = await sharp(tplFull).metadata();
    const tplW = meta.width, tplH = meta.height;

    // Compute pixels from normalized coords
    const nbx = ev.nameBoxX * tplW;
    const nby = ev.nameBoxY * tplH;
    const nbw = ev.nameBoxW * tplW;
    const nbh = ev.nameBoxH * tplH;

    // Expanded svg area to avoid clipping
    const expandedW = Math.max(nbw * 1.6, nbw + 20);
    const expandedH = Math.max(nbh * 1.8, nbh + 20);

    const PREVIEW_H = 850; // same as frontend canvas height used for normalization
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
          .t {
            font-family: '${ev.nameFontFamily || "Poppins"}', sans-serif;
            font-size: ${scaledFont}px;
            fill: ${ev.nameFontColor || "#0ea5e9"};
            font-weight: 600;
          }
        </style>
        <text x="${textX}" y="${textY}" text-anchor="${textAnchor}"
              dominant-baseline="middle" class="t">${escapeXml(name)}</text>
      </svg>`;

    const svgBuf = Buffer.from(svg);

    // QR
    const qrSizePx = Math.max(40, Math.round((ev.qrSize || 0.05) * tplW));
    const qrBuffer = await QRCode.toBuffer(
      `${escapeXml(name)} participated in ${escapeXml(ev.name)} organized by ${escapeXml(ev.orgBy)} on (${escapeXml(ev.date)})`,
      { type: "png", width: qrSizePx }
    );
    const qrX = Math.round(ev.qrX * tplW);
    const qrY = Math.round(ev.qrY * tplH);

    // Position svg centered over name box
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
    await db.run(
      `INSERT INTO responses (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      eId, name, email, mobile, dept, year, enroll, certRel, "generated"
    );

    // Try sending email if SMTP configured
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
          text: `Hello ${name},\n\nAttached is your participation certificate for "${ev.name}" held on ${ev.date}.`,
          attachments: [{ filename: "certificate.png", path: certFull }],
        });
        await db.run("UPDATE responses SET email_status='sent' WHERE event_id=? AND email=?", eId, email);
      } catch (errMail) {
        console.error("Email failed:", errMail);
        await db.run("UPDATE responses SET email_status='failed', email_error=? WHERE event_id=? AND email=?", String(errMail.message), eId, email);
      }
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

    // CSV
    archive.append(
      "Name,Email,Mobile,Dept,Year,Enroll,CertPath\n" +
        responses.map(r => `"${r.name}","${r.email}","${r.mobile}","${r.dept}","${r.year}","${r.enroll}","${r.cert_path}"`).join("\n"),
      { name: "data.csv" }
    );

    // Attach files
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


