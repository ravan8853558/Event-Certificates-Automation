// ===============================
// UEM Event Certificates - Final Backend (SVG Fit & Mail Ready)
// ===============================

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const sharp = require('sharp');
const QRCode = require('qrcode');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin@uem.com';
const ADMIN_PASS = process.env.ADMIN_PASS || 'UEM@12345';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMPLATES_DIR = path.join(UPLOAD_DIR, 'templates');
const CERTS_DIR = path.join(UPLOAD_DIR, 'certs');
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Utility: clamp integer
const clampInt = (v, min, max) => Math.max(min, Math.min(max, parseInt(v || 0)));

// Multer for uploads
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, TEMPLATES_DIR),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// DB setup
let db;
(async () => {
  db = await open({ filename: path.join(__dirname, 'data.db'), driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, date TEXT, venue TEXT, orgBy TEXT,
      templatePath TEXT,
      nameBoxX INTEGER, nameBoxY INTEGER, nameBoxW INTEGER, nameBoxH INTEGER,
      nameFontFamily TEXT, nameFontSize INTEGER, nameFontColor TEXT, nameAlign TEXT,
      qrX INTEGER, qrY INTEGER, qrSize INTEGER
    );

    CREATE TABLE IF NOT EXISTS responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER, name TEXT, email TEXT, mobile TEXT,
      dept TEXT, year TEXT, enroll TEXT, cert_path TEXT,
      email_status TEXT, email_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  console.log('✅ Database connected.');
})();

// App setup
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '12mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// JWT Auth
function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: '12h' });
}
function authMiddleware(req, res, next) {
  let token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Admin login
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS)
    return res.json({ token: generateToken() });
  res.status(401).json({ error: 'Invalid credentials' });
});

// Upload certificate template
app.post('/api/upload-template', upload.single('template'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const meta = await sharp(req.file.path).metadata();
    res.json({
      success: true,
      path: `/uploads/templates/${req.file.filename}`,
      width: meta.width,
      height: meta.height
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Create event
app.post('/api/events', authMiddleware, async (req, res) => {
  try {
    const p = req.body;
    const stmt = await db.run(
      `INSERT INTO events 
       (name,date,venue,orgBy,templatePath,nameBoxX,nameBoxY,nameBoxW,nameBoxH,
        nameFontFamily,nameFontSize,nameFontColor,nameAlign,qrX,qrY,qrSize)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.name, p.date, p.venue, p.orgBy, p.templatePath,
      clampInt(p.nameBoxX, 0, 10000), clampInt(p.nameBoxY, 0, 10000),
      clampInt(p.nameBoxW, 10, 20000), clampInt(p.nameBoxH, 10, 20000),
      p.nameFontFamily || 'Poppins', clampInt(p.nameFontSize, 8, 200),
      p.nameFontColor || '#0ea5e9', p.nameAlign || 'center',
      clampInt(p.qrX, 0, 20000), clampInt(p.qrY, 0, 20000), clampInt(p.qrSize, 10, 2000)
    );
    res.json({ success: true, eventId: stmt.lastID, formLink: `${BASE_URL}/form/${stmt.lastID}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event', details: err.message });
  }
});

// List events
app.get('/api/events', authMiddleware, async (_, res) => {
  try {
    const events = await db.all('SELECT * FROM events ORDER BY id DESC');
    res.json({ success: true, data: events });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

// Test
app.get('/api/test', (_, res) => res.json({ success: true, message: "Backend is running fine!" }));

// Generate Certificate
app.post('/api/submit/:eventId', async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId);
    const ev = await db.get('SELECT * FROM events WHERE id = ?', eId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const { name, email, mobile, dept, year, enroll } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Missing name/email' });

    const tplFull = path.join(__dirname, ev.templatePath.replace(/^\//, ''));
    const meta = await sharp(tplFull).metadata();
    const tplW = meta.width, tplH = meta.height;

    // Ensure within bounds
    const nbx = clampInt(ev.nameBoxX, 0, tplW - 1);
    const nby = clampInt(ev.nameBoxY, 0, tplH - 1);
    const nbw = clampInt(ev.nameBoxW, 10, tplW - nbx);
    const nbh = clampInt(ev.nameBoxH, 10, tplH - nby);
    const qx = clampInt(ev.qrX, 0, tplW - 1);
    const qy = clampInt(ev.qrY, 0, tplH - 1);
    const qsize = clampInt(ev.qrSize, 10, Math.min(tplW, tplH));

    const qrText = `${name} has successfully participated in ${ev.name} organized by ${ev.orgBy} on ${ev.date}.`;
    const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', width: qsize });

    // SVG text (fit within box)
    const alignMap = { left: 'start', center: 'middle', right: 'end' };
    const textAnchor = alignMap[ev.nameAlign] || 'middle';
    const svgX = textAnchor === 'start' ? 0 : textAnchor === 'end' ? nbw : nbw / 2;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${nbw}" height="${nbh}">
        <style>
          .t {
            font-family: '${ev.nameFontFamily || 'Poppins'}', sans-serif;
            font-size: ${ev.nameFontSize || 36}px;
            fill: ${ev.nameFontColor || '#0ea5e9'};
            font-weight: 600;
          }
        </style>
        <text x="${svgX}" y="${nbh / 2}" text-anchor="${textAnchor}" dominant-baseline="middle"
          textLength="${nbw}" lengthAdjust="spacingAndGlyphs" class="t">${escapeXml(name)}</text>
      </svg>`;

    const svgBuf = Buffer.from(svg);
    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);

    await sharp(tplFull)
      .composite([
        { input: svgBuf, top: nby, left: nbx },
        { input: qrBuffer, top: qy, left: qx }
      ])
      .png()
      .toFile(certFull);

    const certRel = `/uploads/certs/${certFile}`;
    await db.run(
      `INSERT INTO responses (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      eId, name, email, mobile, dept, year, enroll, certRel, 'generated'
    );

    // Email (optional)
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
      await transporter.sendMail({
        from: process.env.FROM_EMAIL || process.env.SMTP_USER,
        to: email,
        subject: `Your Certificate for ${ev.name}`,
        text: `Dear ${name},\n\nPlease find attached your certificate for ${ev.name}.\n\nRegards,\n${ev.orgBy}`,
        attachments: [{ filename: 'certificate.png', path: certFull }]
      });
    }

    res.json({ success: true, certPath: certRel });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Download data
app.get('/api/download-data/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ev = await db.get('SELECT * FROM events WHERE id=?', id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const rows = await db.all('SELECT * FROM responses WHERE event_id=?', id);

    const csvHead = ['id','name','email','mobile','dept','year','enroll','cert_path','email_status','email_error','created_at'];
    const csv = [csvHead.join(',')];
    rows.forEach(r => csv.push([r.id, `"${r.name}"`, r.email, r.mobile, r.dept, r.year, r.enroll, r.cert_path, r.email_status, `"${r.email_error}"`, r.created_at].join(',')));
    const csvBuf = Buffer.from(csv.join('\n'));

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=event-${id}-data.zip`);
    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.pipe(res);
    zip.append(csvBuf, { name: `event-${id}-data.csv` });
    rows.forEach(r => {
      if (r.cert_path) {
        const f = path.join(__dirname, r.cert_path.replace(/^\//, ''));
        if (fs.existsSync(f)) zip.file(f, { name: `certs/${path.basename(f)}` });
      }
    });
    await zip.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Download failed', details: err.message });
  }
});

// Simple participant form
app.get('/form/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get('SELECT * FROM events WHERE id=?', id);
  if (!ev) return res.status(404).send('Event not found');
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

// Escape XML
function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, c => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;'
  }[c]));
}

// Health check
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
