// ===============================
// UEM Event Certificates - Final Backend (Stable + Email + Export)
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

// ====== Folders ======
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATES_DIR = path.join(UPLOAD_DIR, "templates");
const CERTS_DIR = path.join(UPLOAD_DIR, "certs");
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR].forEach((d) => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const clampNum = (v, min, max) => Math.max(min, Math.min(max, parseFloat(v || 0)));

// ====== Multer ======
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TEMPLATES_DIR),
  filename: (_, file, cb) =>
    cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`),
});
const upload = multer({ storage });

// ====== Database ======
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

// ====== Express Setup ======
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "15mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));

// ====== Auth ======
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

// ====== Upload Template ======
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

// ====== Create Event ======
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

// ====== Generate Certificate ======
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

    const PREVIEW_W = 1100, PREVIEW_H = 850;
    const scaleY = tplH / PREVIEW_H;

    const nbx = ev.nameBoxX * tplW;
    const nby = ev.nameBoxY * tplH;
    const nbw = ev.nameBoxW * tplW;
    const nbh = ev.nameBoxH * tplH;

    const expandedW = nbw * 1.8;
    const expandedH = nbh * 2.0;

    const baseFont = Math.max(10, Math.round((ev.nameFontSize || 48) * scaleY));
    const maxChars = 28;
    const scaledFontSize = name.length > maxChars ? baseFont * (maxChars / name.length) : baseFont;

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

    // ---- QR bottom-right ----
    const qrSize = 50, qrMargin = 30;
    const qrBuffer = await QRCode.toBuffer(
      `${name} participated in ${ev.name} organized by ${ev.orgBy} on ${ev.date}.`,
      { type: "png", width: qrSize }
    );
    const qrX = tplW - qrSize - qrMargin;
    const qrY = tplH - qrSize - qrMargin;

    // ---- Center expanded SVG properly ----
    const svgLeft = nbx - (expandedW - nbw) / 2;
    const svgTop = nby - (expandedH - nbh) / 2;

    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);

    await sharp(tplFull)
      .composite([
        { input: svgBuf, left: Math.round(svgLeft), top: Math.round(svgTop) },
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

    // ---- Send Email ----
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    try {
      await transporter.sendMail({
        from: process.env.FROM_EMAIL,
        to: email,
        subject: `Your Certificate - ${ev.name}`,
        text: `Hello ${name},\n\nAttached is your participation certificate for "${ev.name}" held on ${ev.date}.`,
        attachments: [{ filename: "certificate.png", path: certFull }],
      });

      await db.run(
        "UPDATE responses SET email_status = 'sent' WHERE event_id = ? AND email = ?",
        eId,
        email
      );
    } catch (errMail) {
      await db.run(
        "UPDATE responses SET email_status = 'failed', email_error = ? WHERE event_id = ? AND email = ?",
        errMail.message,
        eId,
        email
      );
      console.error("Email failed:", errMail.message);
    }

    res.json({ success: true, certPath: certRel });
  } catch (err) {
    console.error("Generation Error:", err);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ====== Download Data (CSV + ZIP) ======
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
        archive.file(certPath, { name: `certificates/${r.name.replace(/[^\w]/g, "_")}.png` });
    });

    await archive.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to build zip", details: err.message });
  }
});

// ====== Misc ======
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );
}

app.get("/api/test", (_, res) =>
  res.json({ success: true, message: "Backend is running fine!" })
);

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
