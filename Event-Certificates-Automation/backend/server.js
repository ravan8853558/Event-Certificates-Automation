// ===============================
// UEM Event Certificates - Final Stable Backend (Render Ready)
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

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret";
const ADMIN_USER = process.env.ADMIN_USER || "admin@uem.com";
const ADMIN_PASS = process.env.ADMIN_PASS || "UEM@12345";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// ========== Folder setup ==========
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATES_DIR = path.join(UPLOAD_DIR, "templates");
const CERTS_DIR = path.join(UPLOAD_DIR, "certs");
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ========== Multer ==========
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".png";
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  },
});
const upload = multer({ storage });

// ========== DB setup ==========
let db;
(async () => {
  db = await open({
    filename: path.join(__dirname, "data.db"),
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      date TEXT,
      venue TEXT,
      orgBy TEXT,
      templatePath TEXT,
      nameX INTEGER,
      nameY INTEGER,
      nameFontSize INTEGER,
      qrX INTEGER,
      qrY INTEGER,
      qrSize INTEGER
    );

    CREATE TABLE IF NOT EXISTS participants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId INTEGER,
      name TEXT,
      email TEXT,
      mobile TEXT,
      dept TEXT,
      year TEXT,
      enroll TEXT,
      certPath TEXT,
      emailStatus TEXT,
      emailError TEXT
    );
  `);
  console.log("✅ Database connected.");
})();

// ========== App Setup ==========
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.static(path.join(__dirname, "public")));

// ========== Auth ==========
function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: "12h" });
}
function authMiddleware(req, res, next) {
  const token =
    req.headers.authorization?.split(" ")[1] || req.query.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: generateToken() });
  }
  return res.status(401).json({ error: "Invalid credentials" });
});

// ========== Upload Template ==========
app.post("/api/upload-template", upload.single("template"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    const filepath = req.file.path;
    const meta = await sharp(filepath).metadata();
    return res.json({
      success: true,
      path: `/uploads/templates/${path.basename(filepath)}`,
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
    if (!p.templatePath) return res.status(400).json({ error: "Template required" });

    const stmt = await db.run(
      `INSERT INTO events (name, date, venue, orgBy, templatePath, nameX, nameY, nameFontSize, qrX, qrY, qrSize)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.name, p.date, p.venue, p.orgBy, p.templatePath,
      p.nameX || 100, p.nameY || 100, p.nameFontSize || 20,
      p.qrX || 500, p.qrY || 500, p.qrSize || 100
    );

    const id = stmt.lastID;
    res.json({ success: true, eventId: id, formLink: `${BASE_URL}/form/${id}` });
  } catch (err) {
    console.error("❌ Error creating event:", err);
    res.status(500).json({ error: "Failed to create event", details: err.message });
  }
});

// ========== View Events ==========
app.get("/api/events", authMiddleware, async (req, res) => {
  try {
    const events = await db.all("SELECT * FROM events ORDER BY id DESC");
    res.json({ success: true, data: events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error fetching events" });
  }
});

// ========== Submit Form & Generate Certificate ==========
app.post("/api/submit/:eventId", async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId);
    const ev = await db.get("SELECT * FROM events WHERE id = ?", eId);
    if (!ev) return res.status(404).json({ error: "Event not found" });

    const { name, email, mobile, dept, year, enroll } = req.body;
    if (!name || !email) return res.status(400).json({ error: "Missing name/email" });

    const qrText = `${name} - participated in ${ev.name} (${ev.orgBy})`;

    const templateFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
    const qrBuffer = await QRCode.toBuffer(qrText, { type: "png", width: ev.qrSize });
    const svg = `
      <svg width="1000" height="700" xmlns="http://www.w3.org/2000/svg">
        <style>.t{font-family:Arial;font-size:${ev.nameFontSize}px;fill:#0ea5e9;font-weight:bold;}</style>
        <text x="${ev.nameX}" y="${ev.nameY}" class="t">${name}</text>
      </svg>`;
    const svgBuf = Buffer.from(svg);

    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);
    await sharp(templateFull)
      .composite([
        { input: svgBuf, top: 0, left: 0 },
        { input: qrBuffer, top: ev.qrY, left: ev.qrX },
      ])
      .png()
      .toFile(certFull);

    const certRel = `/uploads/certs/${certFile}`;
    await db.run(
      `INSERT INTO participants (eventId, name, email, mobile, dept, year, enroll, certPath, emailStatus)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eId, name, email, mobile, dept, year, enroll, certRel, "pending"
    );

    res.json({ success: true, certPath: certRel });
  } catch (err) {
    console.error("❌ Error generating certificate:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ========== Simple Public Form ==========
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT * FROM events WHERE id=?", id);
  if (!ev) return res.status(404).send("Event not found");
  res.send(`
  <html><head><meta charset="utf-8"/><title>${ev.name}</title></head>
  <body style="font-family:sans-serif;text-align:center;">
    <h2>${ev.name}</h2>
    <form method="POST" action="/api/submit/${id}">
      <input name="name" placeholder="Name" required /><br/>
      <input name="email" placeholder="Email" required /><br/>
      <input name="mobile" placeholder="Mobile" /><br/>
      <input name="dept" placeholder="Department" /><br/>
      <input name="year" placeholder="Year" /><br/>
      <input name="enroll" placeholder="Enrollment No." /><br/>
      <button type="submit">Submit</button>
    </form>
  </body></html>`);
});

// ========== Health Check ==========
app.get("/api/test", (_, res) => res.json({ success: true, message: "Backend running fine!" }));

// ========== Start Server ==========
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
