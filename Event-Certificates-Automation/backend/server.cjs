require("dotenv").config();
const ExcelJS = require("exceljs");
const archiver = require("archiver");
const { parse } = require("csv-parse/sync");
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

const BULK_DIR = path.join(__dirname, "bulk_uploads");

if (!fs.existsSync(BULK_DIR)) {
  fs.mkdirSync(BULK_DIR, { recursive: true });
}

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

// ================= ROOT =================
app.get("/", (_, res) => res.json({ status: "OK" }));

// ================= LOGIN =================
app.post("/api/admin/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;

  if (username !== ADMIN_USER)
    return res.status(401).json({ error: "Invalid credentials" });

  const match = await bcrypt.compare(password, ADMIN_PASS_HASH);
  if (!match)
    return res.status(401).json({ error: "Invalid credentials" });

  res.json({ token: generateToken() });
});

// ================= TEMPLATE UPLOAD =================
const upload = multer({ dest: TEMP_DIR });

app.post("/api/upload-template", authMiddleware, upload.single("template"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  if (!req.file.mimetype.startsWith("image/"))
    return res.status(400).json({ error: "Invalid file type" });

  const dest = path.join(TEMPLATE_DIR, req.file.filename + ".png");
  fs.renameSync(req.file.path, dest);

  const meta = await sharp(dest).metadata();

  res.json({
    success: true,
    path: `/uploads/templates/${path.basename(dest)}`,
    width: meta.width,
    height: meta.height
  });
});

// ================= CREATE EVENT =================
app.post("/api/events", authMiddleware, async (req, res) => {
  const p = req.body;

  const stmt = await db.run(`
    INSERT INTO events
    (name,date,venue,orgBy,templatePath,nameBoxX,nameBoxY,nameBoxW,nameBoxH,
     nameFontFamily,nameFontSize,nameFontColor,qrSize)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
    p.name, p.date, p.venue, p.orgBy, p.templatePath,
    p.nameX, p.nameY, p.nameW, p.nameH,
    p.nameFontFamily, p.nameFontSize, p.nameFontColor,
    p.qrSize
  );

  res.json({
    success: true,
    eventId: stmt.lastID,
    formLink: `${BASE_URL}/form/${stmt.lastID}`
  });
});

// ================= GET EVENTS =================
app.get("/api/events", authMiddleware, async (_, res) => {
  const rows = await db.all("SELECT * FROM events ORDER BY id DESC");
  res.json({ success: true, data: rows });
});

/* ================= BULK FILE UPLOAD ================= */

const bulkUpload = multer({ dest: BULK_DIR });

app.post("/api/bulk/upload", authMiddleware, bulkUpload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    let rows = [];

    if (ext === ".csv") {
      const content = fs.readFileSync(filePath);
      rows = parse(content, { columns: true, skip_empty_lines: true });
    } 
    else if (ext === ".xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);
      const sheet = workbook.worksheets[0];

      const headers = sheet.getRow(1).values.slice(1);

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        let obj = {};
        headers.forEach((h, i) => {
          obj[h] = row.getCell(i + 1).value;
        });

        rows.push(obj);
      });
    } 
    else {
      return res.status(400).json({ error: "Only CSV or XLSX allowed" });
    }

    const columns = Object.keys(rows[0] || {});

    res.json({
      success: true,
      columns,
      previewCount: rows.length,
      tempFile: filePath
    });

  } catch (err) {
    res.status(500).json({ error: "Bulk upload failed" });
  }
});

// ================= PUBLIC FORM =================
app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT * FROM events WHERE id=?", id);
  if (!ev) return res.status(404).send("Event not found");

  res.send(`
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${ev.name} - Registration</title>

    <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" rel="stylesheet">

    <style>
      * { box-sizing: border-box; font-family: 'Poppins', sans-serif; }

      body {
        margin:0;
        min-height:100vh;
        background: linear-gradient(135deg,#0f172a,#1e293b);
        display:flex;
        align-items:center;
        justify-content:center;
        padding:20px;
      }

      .card {
        background: rgba(255,255,255,0.08);
        backdrop-filter: blur(18px);
        border-radius:20px;
        padding:40px;
        width:100%;
        max-width:550px;
        box-shadow:0 20px 40px rgba(0,0,0,0.35);
        color:white;
      }

      h2 {
        margin-bottom:5px;
      }

      .subtitle {
        font-size:14px;
        opacity:0.8;
        margin-bottom:25px;
      }

      input {
        width:100%;
        padding:14px;
        margin-bottom:15px;
        border-radius:10px;
        border:none;
        font-size:14px;
        outline:none;
      }

      input:focus {
        box-shadow:0 0 0 2px #38bdf8;
      }

      button {
        width:100%;
        padding:14px;
        border-radius:10px;
        border:none;
        background: linear-gradient(135deg,#38bdf8,#0ea5e9);
        color:white;
        font-weight:600;
        cursor:pointer;
        transition:0.3s;
      }

      button:hover {
        transform:translateY(-2px);
        box-shadow:0 10px 20px rgba(56,189,248,0.4);
      }

      .footer {
        text-align:center;
        margin-top:15px;
        font-size:12px;
        opacity:0.7;
      }
    </style>
  </head>

  <body>
    <div class="card">
      <h2>${ev.name}</h2>
      <div class="subtitle">
        Organized by ${ev.orgBy} • ${ev.date}
      </div>

      <form method="POST" action="/api/submit/${ev.id}">
        <input name="name" placeholder="Full Name" required/>
        <input name="email" type="email" placeholder="Email Address" required/>
        <input name="mobile" placeholder="Mobile Number" required/>
        <input name="dept" placeholder="Department"/>
        <input name="year" placeholder="Year"/>
        <input name="enroll" placeholder="Enrollment No"/>
        <button type="submit">Generate Certificate</button>
      </form>

      <div class="footer">
        Certificate Automation System
      </div>
    </div>
  </body>
  </html>
  `);
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

  const qrToken = jwt.sign(
    { event: ev.id, name: safeName },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

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
        html: `
          <p>Dear <b>${safeName}</b>,</p>
          <p>You successfully participated in <b>${ev.name}</b>.</p>
          <p>Your certificate is attached.</p>
        `,
        attachments: [{
          filename: `${safeName.replace(/[^\w]/g,"_")}.png`,
          content: certBuffer.toString("base64")
        }]
      })
    });

    if (response.ok) {
      await db.run(
        `UPDATE responses SET email_status=? WHERE cert_path=?`,
        "sent",
        certRel
      );
    } else {
      await db.run(
        `UPDATE responses SET email_status=? WHERE cert_path=?`,
        "failed",
        certRel
      );
    }

  } catch (err) {
    await db.run(
      `UPDATE responses SET email_status=?, email_error=? WHERE cert_path=?`,
      "failed",
      err.message,
      certRel
    );
  }

  return certRel;
}

// ================= SUBMIT =================

app.post("/api/submit/:eventId", submitLimiter, async (req, res) => {
  const ev = await db.get(
    "SELECT * FROM events WHERE id=?",
    req.params.eventId
  );

  if (!ev) return res.status(404).send("Event not found");

  const cert = await generateCertificate(ev, req.body);

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>Certificate Generated</title>
</head>
<body style="font-family:sans-serif;text-align:center;padding:40px">
  <h2>🎉 Certificate Generated Successfully!</h2>
  <p>Your certificate is ready.</p>
  <a href="${cert}" target="_blank">Download Certificate</a>
</body>
</html>
`);
});

const csvParse = require("csv-parse/sync");

/* ================= BULK GENERATE ================= */

app.post("/api/bulk/generate", authMiddleware, async (req, res) => {
  try {
    const { eventId, nameColumn, tempFile } = req.body;

    if (!eventId || !nameColumn || !tempFile)
      return res.status(400).json({ error: "Missing required fields" });

    // 🔒 Security: prevent path traversal
    const safeTempPath = path.normalize(tempFile);
    if (!safeTempPath.startsWith(TEMP_DIR))
      return res.status(400).json({ error: "Invalid file path" });

    if (!fs.existsSync(safeTempPath))
      return res.status(400).json({ error: "Uploaded file not found" });

    const ev = await db.get(
      "SELECT * FROM events WHERE id=?",
      parseInt(eventId)
    );

    if (!ev)
      return res.status(404).json({ error: "Event not found" });

    const ext = path.extname(safeTempPath).toLowerCase();
    let rows = [];

    /* ================= PARSE CSV ================= */
    if (ext === ".csv") {

      const content = fs.readFileSync(safeTempPath);

      rows = csvParse.parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });

    }
    /* ================= PARSE XLSX ================= */
    else if (ext === ".xlsx") {

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(safeTempPath);

      const sheet = workbook.worksheets[0];

      if (!sheet)
        return res.status(400).json({ error: "Excel sheet empty" });

      const headers = sheet.getRow(1).values.slice(1);

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;

        let obj = {};
        headers.forEach((h, i) => {
          obj[h] = row.getCell(i + 1).value || "";
        });

        rows.push(obj);
      });

    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    if (!rows.length)
      return res.status(400).json({ error: "No data found in file" });

    if (!rows[0][nameColumn])
      return res.status(400).json({ error: "Invalid name column selected" });

    /* ================= CREATE ZIP ================= */

    res.attachment("bulk_certificates.zip");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    /* ================= CREATE EXCEL WITH LINKS ================= */

    const outputWorkbook = new ExcelJS.Workbook();
    const outputSheet = outputWorkbook.addWorksheet("Participants");

    const headers = Object.keys(rows[0]);

    outputSheet.columns = [
      ...headers.map(h => ({ header: h, key: h, width: 20 })),
      { header: "Certificate Link", key: "cert_link", width: 45 }
    ];

    /* ================= GENERATE CERTIFICATES ================= */

    for (let row of rows) {

      const name = String(row[nameColumn] || "").trim();
      if (!name) continue;

      const certRel = await generateCertificate(ev, {
        name,
        email: ""  // optional
      });

      const certFullPath = path.join(__dirname, certRel.replace(/^\//, ""));

      if (fs.existsSync(certFullPath)) {
        archive.file(certFullPath, {
          name: path.basename(certFullPath)
        });
      }

      outputSheet.addRow({
        ...row,
        cert_link: `${BASE_URL}${certRel}`
      });
    }

    /* ================= ADD EXCEL INTO ZIP ================= */

    const tempExcelPath = path.join(
      TEMP_DIR,
      `bulk-${Date.now()}.xlsx`
    );

    await outputWorkbook.xlsx.writeFile(tempExcelPath);

    archive.file(tempExcelPath, {
      name: "participants_with_links.xlsx"
    });

    await archive.finalize();

  } catch (err) {
    console.error("Bulk error:", err);
    res.status(500).json({ error: "Bulk generation failed" });
  }
});

// ================= VERIFY =================
app.get("/verify/:token", async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);

    const eventId = data.event;
    const participantName = String(data.name).trim();

    const ev = await db.get(
      "SELECT * FROM events WHERE id = ?",
      eventId
    );

    const rec = await db.get(
      "SELECT * FROM responses WHERE event_id = ? AND TRIM(name) = ?",
      eventId,
      participantName
    );

    if (!ev || !rec) {
      return res.status(404).send(`
        <h2 style="color:red;text-align:center;margin-top:40px;">
          ❌ Verification Failed
        </h2>
      `);
    }

    res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Certificate Verification</title>

<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&display=swap" rel="stylesheet">

<style>
* { box-sizing:border-box; font-family:'Poppins',sans-serif; }

body {
  margin:0;
  min-height:100vh;
  background:linear-gradient(135deg,#0f172a,#1e293b);
  display:flex;
  align-items:center;
  justify-content:center;
}

.card {
  background:rgba(255,255,255,0.08);
  backdrop-filter:blur(18px);
  padding:50px;
  border-radius:20px;
  text-align:center;
  color:white;
  max-width:600px;
  box-shadow:0 20px 40px rgba(0,0,0,0.4);
}

h2 {
  margin-bottom:15px;
  color:#22c55e;
}

p {
  margin:10px 0;
  line-height:1.6;
}

a {
  display:inline-block;
  padding:12px 22px;
  background:linear-gradient(135deg,#38bdf8,#0ea5e9);
  border-radius:10px;
  color:white;
  text-decoration:none;
  font-weight:600;
  margin-top:15px;
}

a:hover {
  transform:translateY(-2px);
}
</style>
</head>

<body>
  <div class="card">
    <h2>✅ Verification Successful</h2>

    <p>
      <b>${rec.name}</b> successfully participated in
      <b>${ev.name}</b>
    </p>

    <p>
      Organized by <b>${ev.orgBy}</b> on <b>${ev.date}</b>
    </p>

    <a href="${rec.cert_path}" target="_blank">
      Download Certificate
    </a>
  </div>
</body>
</html>
    `);

  } catch (err) {
    res.status(400).send(`
      <h2 style="color:red;text-align:center;margin-top:40px;">
        ❌ Invalid or Expired Verification Link
      </h2>
    `);
  }
});

/* ========= DOWNLOAD SINGLE EVENT EXCEL ========= */
app.get("/api/download-excel/:eventId", authMiddleware, async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId);

    const event = await db.get(
      "SELECT * FROM events WHERE id=?",
      eId
    );

    if (!event)
      return res.status(404).json({ error: "Event not found" });

    const responses = await db.all(
      `SELECT name, email, mobile, dept, year, enroll,
              cert_path, email_status, created_at
       FROM responses
       WHERE event_id=?
       ORDER BY created_at DESC`,
      eId
    );

    if (!responses.length)
      return res.status(404).json({ error: "No responses found" });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Event Data");

    worksheet.columns = [
      { header: "Name", key: "name", width: 25 },
      { header: "Email", key: "email", width: 30 },
      { header: "Mobile", key: "mobile", width: 15 },
      { header: "Department", key: "dept", width: 20 },
      { header: "Year", key: "year", width: 10 },
      { header: "Enrollment", key: "enroll", width: 20 },
      { header: "Certificate Link", key: "cert_link", width: 40 },
      { header: "Email Status", key: "email_status", width: 15 },
      { header: "Submitted At", key: "created_at", width: 20 }
    ];

    responses.forEach(r => {
      worksheet.addRow({
        name: r.name,
        email: r.email,
        mobile: r.mobile,
        dept: r.dept,
        year: r.year,
        enroll: r.enroll,
        cert_link: {
          text: "View Certificate",
          hyperlink: `${BASE_URL}${r.cert_path}`
        },
        email_status: r.email_status,
        created_at: r.created_at
      });
    });

    worksheet.getRow(1).font = { bold: true };

    const safeName = event.name.replace(/[^\w]/g, "_");

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${safeName}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("Excel download error:", err);
    res.status(500).json({ error: "Failed to generate Excel file" });
  }
});


/* ========= DELETE SINGLE EVENT ========= */
app.delete("/api/events/:id", authMiddleware, async (req, res) => {
  try {
    await db.run("DELETE FROM events WHERE id=?", req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});


/* ========= DELETE MULTIPLE EVENTS ========= */
app.post("/api/delete-multiple-events", authMiddleware, async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: "No IDs provided" });

    const placeholders = ids.map(() => "?").join(",");

    await db.run(
      `DELETE FROM events WHERE id IN (${placeholders})`,
      ids
    );

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({ error: "Bulk delete failed" });
  }
});


/* ========= DOWNLOAD MULTIPLE EVENTS (ZIP of CSVs) ========= */
app.get("/api/download-multiple-excel", authMiddleware, async (req, res) => {
  try {
    if (!req.query.ids)
      return res.status(400).json({ error: "No IDs provided" });

    const ids = req.query.ids.split(",");
    const archive = archiver("zip", { zlib: { level: 9 } });

    res.attachment("multiple_events_data.zip");
    archive.pipe(res);

    for (const id of ids) {
      const event = await db.get("SELECT * FROM events WHERE id=?", id);
      if (!event) continue;

      const responses = await db.all(
        "SELECT * FROM responses WHERE event_id=?",
        id
      );

      if (!responses.length) continue;

      let csv = "Name,Email,Mobile,Dept,Year,Enroll,Certificate\n";

      responses.forEach(r => {
        csv += `"${r.name}","${r.email}","${r.mobile}","${r.dept}",
"${r.year}","${r.enroll}","${BASE_URL}${r.cert_path}"\n`;
      });

      const safeName = event.name.replace(/[^\w]/g, "_");
      archive.append(csv, { name: `${safeName}.csv` });
    }

    await archive.finalize();

  } catch (err) {
    console.error("Multiple Excel download error:", err);
    res.status(500).json({ error: "Failed to generate ZIP file" });
  }
});

/* ================= START ================= */

app.listen(PORT, () => console.log("Server Running on", PORT));
