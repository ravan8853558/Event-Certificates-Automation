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
const escapeXml = (unsafe) =>
  unsafe.replace(/[<>&'"]/g, (c) =>
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
      qrX REAL, qrY REAL, qrSize REAL
    );

    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER, name TEXT, email TEXT, mobile TEXT,
      dept TEXT, year TEXT, enroll TEXT, cert_path TEXT,
      email_status TEXT, email_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log("✅ Database initialized");
})();

// ====== EXPRESS ======
const app = express();
app.use(
  cors({
    origin: "*",
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "authorization",
      "Origin",
      "Accept",
    ],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.use(bodyParser.json({ limit: "25mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

// ====== AUTH ======
function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: "12h" });
}

function authMiddleware(req, res, next) {
  const token =
    req.headers.authorization?.split(" ")[1] ||
    req.query.token ||
    req.body.token;
  if (!token) return res.status(401).json({ error: "Unauthorized - No token" });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS)
    return res.json({ token: generateToken() });
  return res.status(401).json({ error: "Invalid credentials" });
});

// ====== TEST ROUTE ======
app.get("/api/test", (_, res) =>
  res.json({ success: true, message: "Backend OK" })
);

// ====== UPLOAD TEMPLATE ======
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
    console.error("Upload Error:", err.message);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// ====== CREATE EVENT ======
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
    console.error("Create Event Error:", err.message);
    return res.status(500).json({ error: "Failed to create event" });
  }
});

// ====== GET EVENTS ======
app.get("/api/events", authMiddleware, async (_, res) => {
  try {
    const rows = await db.all("SELECT * FROM events ORDER BY id DESC");
    return res.json({ success: true, data: rows });
  } catch (err) {
    console.error("Events Fetch Error:", err.message);
    return res.status(500).json({ error: "Failed to fetch events" });
  }
});

// ====== GENERATE CERTIFICATE ======
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
    const tplW = meta.width,
      tplH = meta.height;

    // Text box calculations
    const nbx = ev.nameBoxX * tplW;
    const nby = ev.nameBoxY * tplH;
    const nbw = ev.nameBoxW * tplW;
    const nbh = ev.nameBoxH * tplH;

    const fontSize = ev.nameFontSize || 48;
    const alignMap = { left: "start", center: "middle", right: "end" };
    const textAnchor = alignMap[ev.nameAlign] || "middle";

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${nbw}" height="${nbh}">
        <style>
          .t {
            font-family: '${ev.nameFontFamily}', sans-serif;
            font-size: ${fontSize}px;
            fill: ${ev.nameFontColor};
            font-weight: 600;
          }
        </style>
        <text x="50%" y="50%" text-anchor="${textAnchor}" dominant-baseline="middle" class="t">
          ${escapeXml(name)}
        </text>
      </svg>`;
    const svgBuf = Buffer.from(svg);

    // QR bottom-right
    const qrSize = ev.qrSize * tplW;
    const qrBuffer = await QRCode.toBuffer(
      `${name} - ${ev.name} - ${ev.orgBy} (${ev.date})`,
      { type: "png", width: Math.max(40, Math.round(qrSize)) }
    );
    const qrX = ev.qrX * tplW;
    const qrY = ev.qrY * tplH;

    // Composite
    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);

    await sharp(tplFull)
      .composite([
        { input: svgBuf, left: Math.round(nbx), top: Math.round(nby) },
        { input: qrBuffer, left: Math.round(qrX), top: Math.round(qrY) },
      ])
      .png()
      .toFile(certFull);

    const certRel = `/uploads/certs/${certFile}`;
    await db.run(
      `INSERT INTO responses (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      eId,
      name,
      email,
      mobile,
      dept,
      year,
      enroll,
      certRel,
      "generated"
    );

    res.json({ success: true, certPath: certRel });
  } catch (err) {
    console.error("Cert Generation Error:", err.message);
    res.status(500).json({ error: "Failed to generate certificate" });
  }
});

// ====== DOWNLOAD DATA ======
app.get("/api/download-data/:id", authMiddleware, async (req, res) => {
  try {
    const eventId = parseInt(req.params.id);
    const responses = await db.all("SELECT * FROM responses WHERE event_id = ?", eventId);
    if (!responses.length)
      return res.status(404).json({ error: "No data found" });

    const zipName = `event_${eventId}_${Date.now()}.zip`;
    const zipPath = path.join(__dirname, zipName);
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => {
      res.download(zipPath, zipName, () => fs.unlinkSync(zipPath));
    });

    archive.pipe(output);
    archive.append(
      "Name,Email,Mobile,Dept,Year,Enroll,CertPath\n" +
        responses
          .map(
            (r) =>
              `"${r.name}","${r.email}","${r.mobile}","${r.dept}","${r.year}","${r.enroll}","${r.cert_path}"`
          )
          .join("\n"),
      { name: "data.csv" }
    );

    responses.forEach((r) => {
      const certPath = path.join(__dirname, r.cert_path.replace(/^\//, ""));
      if (fs.existsSync(certPath))
        archive.file(certPath, {
          name: `certificates/${r.name.replace(/[^\w]/g, "_")}.png`,
        });
    });

    await archive.finalize();
  } catch (err) {
    console.error("ZIP Error:", err.message);
    res.status(500).json({ error: "Failed to export data" });
  }
});

// ====== START SERVER ======
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

