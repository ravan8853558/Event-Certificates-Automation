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

// ========== List Events ==========
app.get("/api/events", authMiddleware, async (_, res) => {
  try {
    const events = await db.all("SELECT * FROM events ORDER BY id DESC");
    res.json({ success: true, data: events });
  } catch (err) {
    res.status(500).json({ error: "Failed to load events" });
  }
});

// ========== Generate Certificate + Mail ==========
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

    // Proper scaling based on preview reference
    const PREVIEW_W = 1100, PREVIEW_H = 850;
    const scaleY = tplH / PREVIEW_H;

    // Name box in actual pixels
    const nbx = ev.nameBoxX * tplW;
    const nby = ev.nameBoxY * tplH;
    const nbw = ev.nameBoxW * tplW;
    const nbh = ev.nameBoxH * tplH;

    // ✅ Font fix: smaller scaling, perfect centering
    const scaledFontSize = (ev.nameFontSize || 48) * scaleY * 0.65;
    const alignMap = { left: "start", center: "middle", right: "end" };
    const textAnchor = alignMap[ev.nameAlign] || "middle";
    const textX = textAnchor === "start" ? 0 : textAnchor === "end" ? nbw : nbw / 2;
    const textY = nbh / 2 + scaledFontSize * 0.2;

    // ✅ QR perfect alignment bottom-right (fixed 50px)
    const qrSize = 50;
    const qrMargin = 30;
    const qrBuffer = await QRCode.toBuffer(
      `${name} participated in ${ev.name} organized by ${ev.orgBy} on ${ev.date}.`,
      { type: "png", width: qrSize }
    );
    const qrX = tplW - qrSize - qrMargin;
    const qrY = tplH - qrSize - qrMargin;

    // Create name SVG
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${nbw}" height="${nbh}">
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
    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);

    await sharp(tplFull)
      .composite([
        { input: svgBuf, top: Math.round(nby), left: Math.round(nbx) },
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

    // ✅ Send mail asynchronously
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      (async () => {
        try {
          const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || "587"),
            secure: false,
            auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
          });
          await transporter.sendMail({
            from: process.env.FROM_EMAIL || process.env.SMTP_USER,
            to: email,
            subject: `Your Certificate - ${ev.name}`,
            text: `Dear ${name},\n\nPlease find attached your certificate for ${ev.name}.\n\nRegards,\n${ev.orgBy}`,
            attachments: [{ filename: "certificate.png", path: certFull }],
          });
          await db.run(
            `UPDATE responses SET email_status='sent' WHERE email=? AND event_id=?`,
            email, eId
          );
          console.log(`✅ Mail sent to ${email}`);
        } catch (mailErr) {
          console.error("Mail Error:", mailErr.message);
          await db.run(
            `UPDATE responses SET email_status='failed', email_error=? WHERE email=? AND event_id=?`,
            mailErr.message, email, eId
          );
        }
      })();
    }

    res.json({ success: true, certPath: certRel });
  } catch (err) {
    console.error("Generation Error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ========== Download Event Data ==========
app.get("/api/download-data/:id", authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ev = await db.get("SELECT * FROM events WHERE id=?", id);
    if (!ev) return res.status(404).json({ error: "Event not found" });
    const rows = await db.all("SELECT * FROM responses WHERE event_id=?", id);

    const csvHead = [
      "id","name","email","mobile","dept","year","enroll",
      "cert_path","email_status","email_error","created_at"
    ];
    const csv = [csvHead.join(",")];
    rows.forEach((r) =>
      csv.push(
        [r.id, `"${r.name}"`, r.email, r.mobile, r.dept, r.year, r.enroll,
         r.cert_path, r.email_status, `"${r.email_error}"`, r.created_at].join(",")
      )
    );
    const csvBuf = Buffer.from(csv.join("\n"));

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename=event-${id}-data.zip`);
    const zip = archiver("zip", { zlib: { level: 9 } });
    zip.pipe(res);
    zip.append(csvBuf, { name: `event-${id}-data.csv` });
    rows.forEach((r) => {
      if (r.cert_path) {
        const f = path.join(__dirname, r.cert_path.replace(/^\//, ""));
        if (fs.existsSync(f)) zip.file(f, { name: `certs/${path.basename(f)}` });
      }
    });
    await zip.finalize();
  } catch (err) {
    res.status(500).json({ error: "Download failed", details: err.message });
  }
});

// ========== Public Form ==========
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT * FROM events WHERE id=?", id);
  if (!ev) return res.status(404).send("Event not found");
  res.send(`
  <html><body style="font-family:sans-serif;padding:2rem;">
    <h2>${ev.name}</h2>
    <form method="POST" action="/api/submit/${id}">
      <input name="name" placeholder="Name" required/><br/>
      <input name="email" placeholder="Email" required/><br/>
      <input name="mobile" placeholder="Mobile"/><br/>
      <input name="dept" placeholder="Department"/><br/>
      <input name="year" placeholder="Year"/><br/>
      <input name="enroll" placeholder="Enrollment"/><br/>
      <button type="submit">Submit</button>
    </form>
  </body></html>`);
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


