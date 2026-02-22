// ===============================
// UEM Event Certificates - Enterprise Production Build 🔥
// ===============================

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const sharp = require("sharp");
const QRCode = require("qrcode");
const archiver = require("archiver");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const sqlite3 = require("sqlite3").verbose();
const { open } = require("sqlite");

// ================= ENV =================
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS_HASH = process.env.ADMIN_PASS;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ================= PATHS =================
const UPLOAD_DIR = path.join(__dirname, "uploads");
const TEMPLATE_DIR = path.join(UPLOAD_DIR, "templates");
const CERT_DIR = path.join(UPLOAD_DIR, "certs");
const TEMP_DIR = path.join(__dirname, "temp");

[UPLOAD_DIR, TEMPLATE_DIR, CERT_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ================= EXPRESS =================
const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(UPLOAD_DIR));

// ================= RATE LIMIT =================
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
const submitLimiter = rateLimit({ windowMs: 60 * 1000, max: 5 });

// ================= DATABASE =================
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

// ================= AUTH =================
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
        UEM Certificate Automation System
      </div>
    </div>
  </body>
  </html>
  `);
});

// ================= CERTIFICATE GENERATION =================
  async function generateCertificate(ev, data) {
  const { name, email, mobile, dept, year, enroll } = data;

  const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ""));
  const meta = await sharp(tplFull).metadata();
  const tplW = meta.width;
  const tplH = meta.height;

  const centerX = ev.nameBoxX * tplW;
  const centerY = ev.nameBoxY * tplH;
  const boxW = ev.nameBoxW * tplW;
  const boxH = ev.nameBoxH * tplH;

  // ================= SAFE TEXT HANDLING =================
  const safeName = String(name).trim();

  // Proper adaptive font scaling (not stupid length based)
  let fontSize = ev.nameFontSize;

  const approxTextWidth = safeName.length * (fontSize * 0.6);

  if (approxTextWidth > boxW) {
    fontSize = Math.floor((boxW / approxTextWidth) * fontSize * 0.95);
  }

  fontSize = Math.max(fontSize, 18); // never too small

  // ================= SVG TEXT =================
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg"
       width="${boxW}"
       height="${boxH}"
       viewBox="0 0 ${boxW} ${boxH}">
    <text
      x="${boxW / 2}"
      y="${boxH / 2}"
      font-family="${ev.nameFontFamily}"
      font-size="${fontSize}"
      fill="${ev.nameFontColor}"
      font-weight="600"
      text-anchor="middle"
      dominant-baseline="middle">
      ${safeName}
    </text>
  </svg>`;

  // ================= QR CODE =================

  const qrToken = jwt.sign(
    { event: ev.id, name: safeName },
    JWT_SECRET,
    { expiresIn: "30d" }
  );

  // Better QR sizing logic
  let qrSizePx = Math.round(ev.qrSize * tplW);

  qrSizePx = Math.max(qrSizePx, 180);  // minimum
  qrSizePx = Math.min(qrSizePx, tplW * 0.25); // maximum 25% width

  const padding = Math.round(tplW * 0.04);

  const qrLeft = tplW - qrSizePx - padding;
  const qrTop = tplH - qrSizePx - padding;

  const qrBuffer = await QRCode.toBuffer(
    `${BASE_URL}/verify/${qrToken}`,
    {
      width: qrSizePx,
      errorCorrectionLevel: "H",
      margin: 6,
      color: {
        dark: "#000000",
        light: "#FFFFFF"
      }
    }
  );

  // ================= CERT SAVE =================

  const certFile = `${Date.now()}-${uuidv4()}.png`;
  const certFull = path.join(CERT_DIR, certFile);

  await sharp(tplFull)
    .composite([
      {
        input: Buffer.from(svg),
        left: Math.round(centerX - boxW / 2),
        top: Math.round(centerY - boxH / 2)
      },
      {
        input: qrBuffer,
        left: Math.round(qrLeft),
        top: Math.round(qrTop)
      }
    ])
    .png({ quality: 100 })
    .toFile(certFull);

  const certRel = `/uploads/certs/${certFile}`;

  await db.run(
    `INSERT INTO responses 
     (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ev.id,
    safeName,
    email,
    mobile || "",
    dept || "",
    year || "",
    enroll || "",
    certRel,
    "generated"
  );

  return certRel;
}

// ================= SUBMIT =================
app.post("/api/submit/:eventId", submitLimiter, async (req, res) => {
  const ev = await db.get("SELECT * FROM events WHERE id=?", req.params.eventId);
  if (!ev) return res.status(404).send("Event not found");

  const cert = await generateCertificate(ev, req.body);

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Certificate Generated</title>

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
  max-width:500px;
  box-shadow:0 20px 40px rgba(0,0,0,0.4);
}

h2 {
  margin-bottom:20px;
}

a {
  display:inline-block;
  padding:12px 20px;
  background:linear-gradient(135deg,#38bdf8,#0ea5e9);
  border-radius:10px;
  color:white;
  text-decoration:none;
  font-weight:600;
  margin-top:10px;
}

a:hover {
  transform:translateY(-2px);
}
</style>
</head>

<body>
  <div class="card">
    <h2>🎉 Certificate Generated Successfully!</h2>
    <p>Your certificate is ready.</p>
    <a href="${cert}" target="_blank">Download Certificate</a>
  </div>
</body>
</html>
`);
});

// ================= VERIFY =================
app.get("/verify/:token", async (req, res) => {
  try {
    const data = jwt.verify(req.params.token, JWT_SECRET);

    const ev = await db.get(
      "SELECT * FROM events WHERE id=?",
      data.event
    );

    const rec = await db.get(
      "SELECT * FROM responses WHERE event_id=? AND name=?",
      data.event,
      data.name
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

// ===== SEND EMAIL =====
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
        <p>Your certificate is attached below.</p>
        <br/>
        <p>Regards,<br/><b>${ev.orgBy}</b></p>
      `,
      attachments: [{
        filename: `${safeName.replace(/[^\w]/g,"_")}.png`,
        content: certBuffer.toString("base64"),
        encoding: "base64"
      }]
    })
  });

  if (response.ok) {
    await db.run(
      "UPDATE responses SET email_status=? WHERE cert_path=?",
      "sent",
      certRel
    );
  } else {
    const errText = await response.text();
    await db.run(
      "UPDATE responses SET email_status=?, email_error=? WHERE cert_path=?",
      "failed",
      errText,
      certRel
    );
  }

} catch (err) {
  await db.run(
    "UPDATE responses SET email_status=?, email_error=? WHERE cert_path=?",
    "failed",
    err.message,
    certRel
  );
}

// ================= START =================
app.listen(PORT, () => console.log("Server Running"));







