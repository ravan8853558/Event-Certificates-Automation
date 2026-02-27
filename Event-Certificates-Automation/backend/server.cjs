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
sharp.cache(false);
sharp.concurrency(1);
sharp.simd(false);
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
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

if (!JWT_SECRET || !ADMIN_USER || !ADMIN_PASS_HASH) {
  console.error("Missing required environment variables");
  process.exit(1);
}
if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
  console.warn("⚠ Email service not fully configured");
}

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

const BULK_OUTPUT_DIR = path.join(__dirname, "bulk_outputs");

if (!fs.existsSync(BULK_OUTPUT_DIR)) {
  fs.mkdirSync(BULK_OUTPUT_DIR, { recursive: true });
}


/* ================= EXPRESS ================= */
const app = express();
app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.set("trust proxy", 1);   // 🔥 IMPORTANT for Render

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const submitLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

/* ================= DATABASE ================= */

let db;

async function initDB() {
  db = await open({
    filename: path.join(__dirname, "data.db"),
    driver: sqlite3.Database
  });

  await db.exec("PRAGMA foreign_keys = ON;");

  // Load schema file
  const schemaPath = path.join(__dirname, "init_db.sql");

  if (!fs.existsSync(schemaPath)) {
    throw new Error("init_db.sql file not found");
  }

  const schema = fs.readFileSync(schemaPath, "utf-8");

  // Execute full schema (tables + indexes + constraints)
  await db.exec(schema);

  console.log("Database initialized successfully");
}

let server;

initDB()
  .then(() => {
    server = app.listen(PORT, () => {
      console.log("Server Running on", PORT);
    });
  })
  .catch(err => {
    console.error("DB Init Failed:", err);
    process.exit(1);
  });

/* ================= AUTH ================= */

function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: "12h" });
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// ================= ROOT =================
app.get("/", (_, res) => res.json({ status: "OK" }));

// ================= BULK DOWNLOAD =================

app.get("/api/bulk/download/:file", (req, res) => {
  const file = req.params.file;
  const safePath = path.resolve(BULK_OUTPUT_DIR, file);

  if (!safePath.startsWith(path.resolve(BULK_OUTPUT_DIR))) {
    return res.status(400).json({ error: "Invalid file path" });
  }

  if (!fs.existsSync(safePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  res.download(safePath);
});

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
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/png", "image/jpeg"];
    const ext = path.extname(file.originalname).toLowerCase();

    if (
      !allowedTypes.includes(file.mimetype) ||
      ![".png", ".jpg", ".jpeg"].includes(ext)
    ) {
      return cb(new Error("Only PNG and JPG files are allowed"));
    }

    cb(null, true);
  }
});

app.post("/api/upload-template", authMiddleware, upload.single("template"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });

  const dest = path.join(TEMPLATE_DIR, req.file.filename + ".webp");

  await sharp(req.file.path)
    .resize({ width: 1400, withoutEnlargement: true })
    .webp({ quality: 90 })
    .toFile(dest);

  let metadata;

  try {
    metadata = await sharp(req.file.path).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error("Invalid image file");
    }

     await sharp(req.file.path)
       .resize({ width: 1400, withoutEnlargement: true })  // reduce width
    .webp({
      quality: 90
    })
        })
       .toFile(dest);

   } catch (err) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Invalid or corrupted image file" });
  };

  fs.unlinkSync(req.file.path);
  
  const meta = await sharp(dest).metadata();

  res.json({
    success: true,
    path: `/uploads/templates/${path.basename(dest)}`,
    width: meta.width,
    height: meta.height
  });
});

//------------Event Validate-------------------//

function validateEventInput(p) {
  if (!p.name || typeof p.name !== "string") {
    return "Event name is required";
  }

  if (!p.templatePath || typeof p.templatePath !== "string") {
    return "Template path required";
  }

  const numericFields = [
    "nameX", "nameY", "nameW", "nameH", "qrSize"
  ];

  for (let field of numericFields) {
  p[field] = Number(p[field]);
  if (isNaN(p[field])) {
    return `${field} must be a valid number`;
  }
}

  // normalized coordinates must be between 0 and 1
  const normalized = ["nameX", "nameY", "nameW", "nameH", "qrSize"];

  for (let field of normalized) {
    if (p[field] < 0 || p[field] > 1) {
      return `${field} must be between 0 and 1`;
    }
  }

  if (p.nameFontSize && (p.nameFontSize < 10 || p.nameFontSize > 300)) {
    return "Invalid font size";
  }

  if (p.nameFontColor && !/^#[0-9A-Fa-f]{6}$/.test(p.nameFontColor)) {
    return "Font color must be valid hex (#RRGGBB)";
  }

  return null;
}

// ================= CREATE EVENT =================
app.post("/api/events", authMiddleware, async (req, res) => {
  const p = req.body;

  const error = validateEventInput(p);
  if (error) {
    return res.status(400).json({ error });
  }
  const templateFull = path.resolve(__dirname, p.templatePath.replace(/^\//, ""));

  if (!templateFull.startsWith(path.resolve(UPLOAD_DIR))) {
    return res.status(400).json({ error: "Invalid template path" });
  }

  if (!fs.existsSync(templateFull)) {
    return res.status(400).json({ error: "Template file not found" });
  }
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

const bulkUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, BULK_DIR);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, unique + ext);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

app.post("/api/bulk/upload", authMiddleware, bulkUpload.single("file"), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: "No file uploaded" });

    const filePath = req.file.path;
    const ext = path.extname(req.file.originalname).toLowerCase();

    let rows = [];

    // ================= PARSE CSV =================
    if (ext === ".csv") {
      const content = fs.readFileSync(filePath);
      rows = parse(content, {
        columns: true,
        skip_empty_lines: true,
        trim: true
      });
    }

    // ================= PARSE XLSX =================
    else if (ext === ".xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(filePath);

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
    }

    else {
      return res.status(400).json({ error: "Only CSV or XLSX allowed" });
    }

    // 🔒 Now validate rows AFTER parsing
    if (!rows.length)
      return res.status(400).json({ error: "No data found in file" });

    if (rows.length > 300)
      return res.status(400).json({ error: "Maximum 300 rows allowed per bulk" });

    const columns = Object.keys(rows[0]);

    res.json({
      success: true,
      columns,
      previewCount: rows.length,
      tempFile: filePath
    });

  } catch (err) {
    console.error("Bulk upload error:", err);
    res.status(500).json({ error: "Bulk upload failed" });
  }
});

// ================= PUBLIC FORM =================

app.get("/form/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get("SELECT * FROM events WHERE id=?", id);

  if (!ev) {
    return res.status(404).send("Event not found");
  }

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHTML(ev.name)} - Registration</title>

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
    <h2>${escapeHTML(ev.name)}</h2>
    <div class="subtitle">
      Organized by ${escapeHTML(ev.orgBy)} • ${escapeHTML(ev.date)}
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

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[m]);
}

function formatNameCase(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/* ================= CERTIFICATE GENERATION ================= */

async function generateCertificate(ev, data, sendEmail = true) {

  const { name, email } = data;

  const safeTplPath = path.resolve(
    __dirname,
    ev.templatePath.replace(/^\//, "")
  );

  const uploadsRoot = path.resolve(UPLOAD_DIR);

  if (!safeTplPath.startsWith(uploadsRoot)) {
    throw new Error("Invalid template path detected");
  }

  if (!fs.existsSync(safeTplPath)) {
    throw new Error("Template file not found");
  }

  const meta = await sharp(safeTplPath).metadata();
  const tplW = meta.width;
  const tplH = meta.height;

  /* ===== NAME PREP ===== */

  const formattedName = formatNameCase(name);
  const normalizedName = formattedName.toLowerCase();
  const safeName = formattedName.replace(/[<>]/g, "");

  const fontSize = ev.nameFontSize || 40;

  // Dynamic width (text shrink nahi hoga)
  const avgCharWidth = fontSize * 0.55;
  const dynamicBoxW = Math.ceil(
    safeName.length * avgCharWidth + fontSize * 2
  );
  
  const maxNameWidth = tplW * 0.8;
  const finalBoxW = Math.min(dynamicBoxW, maxNameWidth);

  const boxH = Math.ceil(fontSize * 1.6);

  /* ===== ALIGNMENT (textbox ke andar) ===== */

  const align = ev.nameAlign || "center";

  let textAnchor = "middle";
  let textX = finalBoxW / 2;

  if (align === "left") {
    textAnchor = "start";
    textX = fontSize * 0.5;
  }

  if (align === "right") {
    textAnchor = "end";
    textX = finalBoxW - fontSize * 0.5;
  }

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${finalBoxW}" height="${boxH}">
    <text
      x="${textX}"
      y="${boxH / 2}"
      font-family="${ev.nameFontFamily || 'Poppins'}"
      font-size="${fontSize}"
      fill="${ev.nameFontColor || '#000000'}"
      text-anchor="${textAnchor}"
      dominant-baseline="middle">
      ${safeName}
    </text>
  </svg>`;

/* ===== QR ===== */

const qrToken = jwt.sign(
  { event: ev.id, name: formattedName },
  JWT_SECRET,
  { expiresIn: "30d" }
);

// Better size calculation
let qrSizePx = Math.round((ev.qrSize || 0.20) * tplW);

// Safe minimum for long JWT
qrSizePx = Math.max(qrSizePx, 220);

// Never exceed 28% of template width
qrSizePx = Math.min(qrSizePx, Math.floor(tplW * 0.28));

const padding = Math.round(tplW * 0.04);

// Generate QR with proper quiet zone
const qrBuffer = await QRCode.toBuffer(
  `${BASE_URL}/verify/${qrToken}`,
  {
    width: qrSizePx,
    margin: 4,                 // REQUIRED for scanning
    errorCorrectionLevel: "H", // High reliability
    color: {
      dark: "#000000",
      light: "#FFFFFF"
    }
  }
);
  
/* ===== CERTIFICATE FILE ===== */

const certFile = `${Date.now()}-${uuidv4()}.webp`;
const certFull = path.join(CERT_DIR, certFile);
  
/* ===== SAFE POSITION CALCULATION ===== */

// Absolute hard limits
const safeBoxW = Math.min(finalBoxW, tplW);
const safeBoxH = Math.min(boxH, tplH);

// Ensure SVG never exceeds template
const safeSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${safeBoxW}" height="${safeBoxH}">
  <text
    x="${safeBoxW / 2}"
    y="${safeBoxH / 2}"
    font-family="${ev.nameFontFamily || 'Poppins'}"
    font-size="${fontSize}"
    fill="${ev.nameFontColor || '#000000'}"
    text-anchor="middle"
    dominant-baseline="middle">
    ${safeName}
  </text>
</svg>`;

// Position
let left = Math.round(ev.nameBoxX * tplW - safeBoxW / 2);
let top  = Math.round(ev.nameBoxY * tplH - safeBoxH / 2);

// Clamp inside template
left = Math.max(0, Math.min(left, tplW - safeBoxW));
top  = Math.max(0, Math.min(top, tplH - safeBoxH));

// Clamp QR size strictly
qrSizePx = Math.min(qrSizePx, tplW, tplH);

await sharp(safeTplPath)
  .composite([
    {
      input: Buffer.from(safeSvg),
      left,
      top
    },
    {
      input: qrBuffer,
      left: Math.max(0, Math.min(tplW - qrSizePx - padding, tplW - qrSizePx)),
      top: Math.max(0, Math.min(tplH - qrSizePx - padding, tplH - qrSizePx))
    }
  ])
  .webp({
    quality: 90
  })
  .toFile(certFull);
  
const certRel = `/uploads/certs/${certFile}`;
  
  /* ===== SAVE TO DB ===== */

  try {
    await db.run(
      `INSERT INTO responses 
       (event_id, name, email, mobile, dept, year, enroll, cert_path, email_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ev.id,
      normalizedName,
      email || "",
      data.mobile || "",
      data.dept || "",
      data.year || "",
      data.enroll || "",
      certRel,
      "generated"
    );
  } catch (err) {

    if (err.message.includes("UNIQUE")) {

      if (fs.existsSync(certFull)) {
        fs.unlinkSync(certFull);
      }

      throw new Error("Certificate already generated for this name");
    }

    throw err;
  }

  /* ===== EMAIL SECTION ===== */

  if (sendEmail && email) {
    try {

      if (!process.env.RESEND_API_KEY || !process.env.FROM_EMAIL) {
        throw new Error("Email service not configured");
      }

      const certBuffer = fs.readFileSync(certFull);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

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
          html: `<p>Dear <b>${safeName}</b>,</p>
                 <p>You successfully participated in <b>${ev.name}</b>.</p>`,
          attachments: [{
            filename: `${safeName.replace(/[^\w]/g,"_")}.png`,
            content: certBuffer.toString("base64")
          }]
        }),
        signal: controller.signal
      });

      clearTimeout(timeout);

      let responseData;
      try {
        responseData = await response.json();
      } catch {
        responseData = null;
      }

      if (!response.ok) {
        throw new Error(
          `Email API Error: ${response.status} - ${JSON.stringify(responseData)}`
        );
      }

      await db.run(
        `UPDATE responses SET email_status=? WHERE cert_path=?`,
        "sent",
        certRel
      );

    } catch (err) {

      await db.run(
        `UPDATE responses SET email_status=?, email_error=? WHERE cert_path=?`,
        "failed",
        err.message.slice(0, 500),
        certRel
      );
    }
  }

  return certRel;
}

// ================= SUBMIT =================
app.post("/api/submit/:eventId", submitLimiter, async (req, res) => {

  const { name, email } = req.body;

  if (!name || name.length > 100)
     return res.status(400).send("Invalid name");

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
     return res.status(400).send("Invalid email");

  const ev = await db.get(
    "SELECT * FROM events WHERE id=?",
    req.params.eventId
  );

  if (!ev)
    return res.status(404).send("Event not found");

  try {

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

  } catch (err) {

    if (err.message.includes("already generated")) {
      return res.status(400).send("Certificate already generated for this name");
    }

    console.error(err);
    return res.status(500).send("Certificate generation failed");
  }
});

/* ================= BULK GENERATE (ASYNC WITH PROGRESS) ================= */
const bulkLimiter = rateLimit({ windowMs: 60 * 1000, max: 2 });

app.post("/api/bulk/generate", authMiddleware, bulkLimiter, async (req, res) => {
  try {
    const { eventId, nameColumn, tempFile } = req.body;

    if (!eventId || !nameColumn || !tempFile)
      return res.status(400).json({ error: "Missing required fields" });

    const safeTempPath = path.resolve(tempFile);

    if (!safeTempPath.startsWith(path.resolve(BULK_DIR)))
      return res.status(400).json({ error: "Invalid file path" });

    if (!fs.existsSync(safeTempPath))
      return res.status(400).json({ error: "Uploaded file not found" });

    const ev = await db.get("SELECT * FROM events WHERE id=?", parseInt(eventId));
    if (!ev)
      return res.status(404).json({ error: "Event not found" });

    const ext = path.extname(safeTempPath).toLowerCase();
    let rows = [];

    if (ext === ".csv") {
      const content = fs.readFileSync(safeTempPath);
      rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    }
    else if (ext === ".xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(safeTempPath);
      const sheet = workbook.worksheets[0];
      const headers = sheet.getRow(1).values.slice(1);

      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        let obj = {};
        headers.forEach((h, i) => {
          obj[h] = row.getCell(i + 1).value || "";
        });
        rows.push(obj);
      });
    }
    else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    if (!rows.length)
      return res.status(400).json({ error: "No data found" });

    if (rows.length > 300)
      return res.status(400).json({ error: "Maximum 300 rows allowed" });

    if (!rows[0].hasOwnProperty(nameColumn)) {
      return res.status(400).json({ error: "Invalid name column selected" });
    }

    const jobId = uuidv4();
    
    await db.run(
      `INSERT INTO bulk_jobs (id, event_id, total)
       VALUES (?, ?, ?)`,
      jobId,
      eventId,
      rows.length
    );

    res.json({ success: true, jobId });

    /* ===== BACKGROUND PROCESS ===== */

(async () => {
  try {

    const zipName = `bulk-${Date.now()}.zip`;
    const zipPath = path.join(BULK_OUTPUT_DIR, zipName);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(output);

    const outputWorkbook = new ExcelJS.Workbook();
    const outputSheet = outputWorkbook.addWorksheet("Participants");

    const headers = Object.keys(rows[0]);

    outputSheet.columns = [
      ...headers.map(h => ({ header: h, key: h, width: 20 })),
      { header: "Certificate Link", key: "cert_link", width: 45 }
    ];

for (let row of rows) {

  const name = String(row[nameColumn] || "").trim();
  if (!name) continue;

  let certRel;

  try {
    certRel = await generateCertificate(
      ev,
      { name, email: "" },
      false
    );
  } catch (err) {

    if (err.message.includes("already generated")) {

      const existing = await db.get(
        "SELECT cert_path FROM responses WHERE event_id=? AND name=?",
        ev.id,
        formatNameCase(name).toLowerCase()
      );

      if (existing) {

        certRel = existing.cert_path;

        const certFullPath = path.join(
          __dirname,
          certRel.replace(/^\//, "")
        );

        if (fs.existsSync(certFullPath)) {
          archive.file(certFullPath, {
            name: path.basename(certFullPath)
          });
        }

        const safeRow = {};
        for (let key in row) {
          let val = String(row[key] || "");
          if (val.startsWith("=")) val = "'" + val;
          safeRow[key] = val;
        }

        outputSheet.addRow({
          ...safeRow,
          cert_link: `${BASE_URL}${certRel}`
        });

        await db.run(
          `UPDATE bulk_jobs SET completed = completed + 1 WHERE id = ?`,
          jobId
        );
      }

      continue;
    }

    throw err;
  }

  const certFullPath = path.join(
    __dirname,
    certRel.replace(/^\//, "")
  );

  if (fs.existsSync(certFullPath)) {
    archive.file(certFullPath, {
      name: path.basename(certFullPath)
    });
  }

  const safeRow = {};
  for (let key in row) {
    let val = String(row[key] || "");
    if (val.startsWith("=")) val = "'" + val;
    safeRow[key] = val;
  }

  outputSheet.addRow({
    ...safeRow,
    cert_link: `${BASE_URL}${certRel}`
  });

  await db.run(
    `UPDATE bulk_jobs SET completed = completed + 1 WHERE id = ?`,
    jobId
  );
}
    
    // Create Excel file
    const tempExcelPath = path.join(
      TEMP_DIR,
      `bulk-${Date.now()}.xlsx`
    );

    await outputWorkbook.xlsx.writeFile(tempExcelPath);

    archive.file(tempExcelPath, {
      name: "participants_with_links.xlsx"
    });

    // Finalize archive BEFORE waiting for close
    await archive.finalize();

    // Wait until zip stream fully closed
    await new Promise((resolve, reject) => {
      output.on("close", resolve);
      archive.on("error", reject);
    });

    // Mark job completed
    await db.run(
      `UPDATE bulk_jobs 
       SET status = 'completed', zip_name = ?
       WHERE id = ?`,
      zipName,
      jobId
    );

    // Cleanup temp files
    if (fs.existsSync(safeTempPath)) {
      fs.unlinkSync(safeTempPath);
    }

    if (fs.existsSync(tempExcelPath)) {
      fs.unlinkSync(tempExcelPath);
    }

  } catch (err) {

    console.error("Bulk background error:", err);

    await db.run(
      `UPDATE bulk_jobs 
       SET status = 'failed'
       WHERE id = ?`,
      jobId
    );
  }
})();
} catch (err) {
  console.error("Bulk error:", err);
  return res.status(500).json({ error: "Bulk generation failed" });
}
});

// ================= VERIFY =================
app.get("/verify/:token", async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);

    const eventId = data.event;
    const participantName = String(data.name).trim().toLowerCase();
    
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
      <b>${escapeHTML(formatNameCase(rec.name))}</b> successfully participated in
      <b>${escapeHTML(ev.name)}</b>
    </p>

    <p>
      Organized by <b>${escapeHTML(ev.orgBy)}</b> on <b>${escapeHTML(ev.date)}</b>
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
        name: formatNameCase(r.name),
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
    const eventId = req.params.id;

    const certs = await db.all(
      "SELECT cert_path FROM responses WHERE event_id=?",
      eventId
    );

    for (const c of certs) {
      const fullPath = path.join(__dirname, c.cert_path.replace(/^\//, ""));
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    }

    await db.run("DELETE FROM events WHERE id=?", eventId);

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

    for (const eventId of ids) {
      const certs = await db.all(
        "SELECT cert_path FROM responses WHERE event_id=?",
        eventId
      );

      for (const c of certs) {
        const fullPath = path.join(__dirname, c.cert_path.replace(/^\//, ""));
        if (fs.existsSync(fullPath)) {
          fs.unlinkSync(fullPath);
        }
      }
    }

    const placeholders = ids.map(() => "?").join(",");

    await db.run(
      `DELETE FROM events WHERE id IN (${placeholders})`,
      ids
    );

    res.json({ success: true });

  } catch (err) {
    console.error("Bulk delete error:", err);
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
    archive.on("error", (err) => {
      console.error("Archive error:", err);
      res.status(500).json({ error: "Zip creation failed" });
    });
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
        csv += `"${formatNameCase(r.name)}","${r.email}","${r.mobile}","${r.dept}","${r.year}","${r.enroll}","${BASE_URL}${r.cert_path}"\n`;
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

app.get("/api/bulk/progress/:jobId", authMiddleware, async (req, res) => {

  const job = await db.get(
    "SELECT * FROM bulk_jobs WHERE id=?",
    req.params.jobId
  );

  if (!job)
    return res.status(404).json({ error: "Job not found" });

  const percent = job.total > 0
    ? Math.floor((job.completed / job.total) * 100)
    : 0;

  res.json({
    status: job.status,
    percent,
    zipUrl: job.status === "completed"
      ? `${BASE_URL}/api/bulk/download/${job.zip_name}`
      : null
  });
});

/* ========= BULK HISTORY ========= */
app.get("/api/bulk/history", authMiddleware, async (req, res) => {
  try {
    const files = fs.readdirSync(BULK_OUTPUT_DIR)
      .filter(f => f.endsWith(".zip"))
      .map(f => ({
        name: f,
        url: `${BASE_URL}/api/bulk/download/${f}`  // ✅ FIXED
      }))
      .sort((a, b) => b.name.localeCompare(a.name));

    res.json({ success: true, files });

  } catch (err) {
    console.error("Bulk history error:", err);
    res.status(500).json({ error: "Failed to load history" });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("Shutting down gracefully...");

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      console.log("HTTP server closed");
    }

    if (db) {
      await db.close();
      console.log("Database connection closed");
    }

    process.exit(0);

  } catch (err) {
    console.error("Shutdown error:", err);
    process.exit(1);
  }
}
