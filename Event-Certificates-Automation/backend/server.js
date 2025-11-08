// ===============================
// UEM Event Certificates - Final Backend (Render Ready)
// ===============================

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const sharp = require('sharp');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');
const bodyParser = require('body-parser');
const cors = require('cors');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const ADMIN_USER = process.env.ADMIN_USER || 'admin@uem.com';
const ADMIN_PASS = process.env.ADMIN_PASS || 'UEM@12345';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TEMPLATES_DIR = path.join(UPLOAD_DIR, 'templates');
const CERTS_DIR = path.join(UPLOAD_DIR, 'certs');
const LOGS_DIR = path.join(__dirname, 'logs');

// ensure folders exist
[UPLOAD_DIR, TEMPLATES_DIR, CERTS_DIR, LOGS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMPLATES_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}-${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage });

// DB setup
let db;
(async () => {
  db = new sqlite3.Database(path.join(__dirname, 'data.db'), (err) => {
  if (err) {
    console.error('Database connection error:', err);
  } else {
    console.log('Database connected.');
  }
});
  await db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      date TEXT,
      venue TEXT,
      org_by TEXT,
      template_path TEXT,
      template_w INTEGER,
      template_h INTEGER,
      name_x INTEGER,
      name_y INTEGER,
      name_fontsize INTEGER,
      qr_x INTEGER,
      qr_y INTEGER,
      qr_size INTEGER,
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
})();

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// ========== Auth ==========
function generateToken() {
  return jwt.sign({ user: ADMIN_USER }, JWT_SECRET, { expiresIn: '12h' });
}

function authMiddleware(req, res, next) {
  const token =
    req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ token: generateToken() });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

// ========== Upload Template ==========
app.post('/api/upload-template', upload.single('template'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filepath = req.file.path;
    const meta = await sharp(filepath).metadata();
    return res.json({
      success: true,
      path: `/uploads/templates/${path.basename(filepath)}`,
      width: meta.width,
      height: meta.height
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// ========== Create Event ==========
app.post('/api/events', authMiddleware, async (req, res) => {
  try {
    const p = req.body;
    if (!p.templatePath) return res.status(400).json({ error: 'Template required' });
    const meta = await sharp(path.join(__dirname, p.templatePath.replace(/^\//, ''))).metadata();
    const stmt = await db.run(
      `INSERT INTO events (name,date,venue,org_by,template_path,template_w,template_h,name_x,name_y,name_fontsize,qr_x,qr_y,qr_size)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      p.name, p.date, p.venue, p.orgBy, p.templatePath,
      meta.width, meta.height, p.nameX, p.nameY, p.nameFontSize,
      p.qrX, p.qrY, p.qrSize
    );
    const id = stmt.lastID;
    res.json({ success: true, eventId: id, formLink: `${BASE_URL}/form/${id}` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create event', details: err.message });
  }
});

// ========== Submit Participant & Generate Certificate ==========
app.post('/api/submit/:eventId', async (req, res) => {
  try {
    const eId = parseInt(req.params.eventId, 10);
    const ev = await db.get('SELECT * FROM events WHERE id = ?', eId);
    if (!ev) return res.status(404).json({ error: 'Event not found' });

    const { name, email, mobile, dept, year, enroll } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Missing name/email' });

    const qrText = `${name} has successfully participated in ${ev.name} organized by ${ev.org_by} on ${ev.date}.`;

    const templateFull = path.join(__dirname, ev.template_path.replace(/^\//, ''));
    const meta = await sharp(templateFull).metadata();
    const tplW = meta.width, tplH = meta.height;

    const CANVAS_W = 1000, CANVAS_H = 700;
    function calcFit(imgW, imgH, outW, outH) {
      const imgR = imgW / imgH, outR = outW / outH;
      if (imgR > outR)
        return { drawW: outW, drawH: outW / imgR, offsetX: 0, offsetY: (outH - outW / imgR) / 2 };
      else
        return { drawH: outH, drawW: outH * imgR, offsetX: (outW - outH * imgR) / 2, offsetY: 0 };
    }
    const fit = calcFit(tplW, tplH, CANVAS_W, CANVAS_H);
    const map = (x, y) => ({
      x: Math.round((x - fit.offsetX) * (tplW / fit.drawW)),
      y: Math.round((y - fit.offsetY) * (tplH / fit.drawH))
    });

    const nPos = map(ev.name_x, ev.name_y);
    const qPos = map(ev.qr_x, ev.qr_y);
    const qrSizeTpl = Math.round((ev.qr_size / fit.drawW) * tplW);
    const fontScale = tplW / fit.drawW;
    const fontPx = Math.max(12, Math.round(ev.name_fontsize * fontScale));

    const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', width: qrSizeTpl });
    const svg = `
      <svg width="${tplW}" height="${tplH}" xmlns="http://www.w3.org/2000/svg">
        <style>.t{font-family:Inter,sans-serif;font-size:${fontPx}px;fill:#0ea5e9;font-weight:600;}</style>
        <text x="${nPos.x}" y="${nPos.y}" class="t">${name}</text>
      </svg>`;
    const svgBuf = Buffer.from(svg);

    const certFile = `${Date.now()}-${uuidv4()}.png`;
    const certFull = path.join(CERTS_DIR, certFile);
    await sharp(templateFull)
      .composite([{ input: svgBuf, top: 0, left: 0 }, { input: qrBuffer, top: qPos.y, left: qPos.x }])
      .png().toFile(certFull);

    const certRel = `/uploads/certs/${certFile}`;
    const insert = await db.run(
      `INSERT INTO responses (event_id,name,email,mobile,dept,year,enroll,cert_path,email_status)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      eId, name, email, mobile, dept, year, enroll, certRel, 'pending'
    );
    const rid = insert.lastID;

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const mail = {
      from: process.env.FROM_EMAIL,
      to: email,
      subject: `Your Certificate for ${ev.name}`,
      text: `Hello ${name},\n\nAttached is your certificate for ${ev.name}.\n\nRegards,\n${ev.org_by}`,
      attachments: [{ filename: `certificate-${ev.id}.png`, path: certFull }]
    };

    try {
      const info = await transporter.sendMail(mail);
      await db.run(
        `UPDATE responses SET email_status='sent', email_error=? WHERE id=?`,
        info.messageId || '', rid
      );
      res.json({ success: true, certPath: certRel });
    } catch (e) {
      await db.run(
        `UPDATE responses SET email_status='failed', email_error=? WHERE id=?`,
        String(e.message), rid
      );
      res.json({ success: false, error: 'Email failed', certPath: certRel });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ========== Download Event Data ==========
app.get('/api/download-data/:id', authMiddleware, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const ev = await db.get('SELECT * FROM events WHERE id=?', id);
    if (!ev) return res.status(404).json({ error: 'Event not found' });
    const rows = await db.all('SELECT * FROM responses WHERE event_id=?', id);

    const csvHead = ['id','name','email','mobile','dept','year','enroll','cert_path','email_status','email_error','created_at'];
    const csvLines = [csvHead.join(',')];
    rows.forEach(r => csvLines.push([
      r.id, `"${r.name}"`, r.email, r.mobile, r.dept, r.year,
      r.enroll, r.cert_path, r.email_status, `"${r.email_error}"`, r.created_at
    ].join(',')));
    const csv = Buffer.from(csvLines.join('\n'), 'utf8');

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename=event-${id}-data.zip`);
    const zip = archiver('zip', { zlib: { level: 9 } });
    zip.pipe(res);
    zip.append(csv, { name: `event-${id}-data.csv` });
    rows.forEach(r => {
      if (r.cert_path) {
        const f = path.join(__dirname, r.cert_path.replace(/^\//, ''));
        if (fs.existsSync(f)) zip.file(f, { name: `certs/${path.basename(f)}` });
      }
    });
    await zip.finalize();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to download', details: err.message });
  }
});

// ========== Simple Form Route ==========
app.get('/form/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const ev = await db.get('SELECT * FROM events WHERE id=?', id);
  if (!ev) return res.status(404).send('Event not found');
  res.send(`
  <html><head><meta charset="utf-8"/><title>${ev.name}</title></head>
  <body>
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
app.get('/health', (_, res) => res.json({ ok: true }));

// ========== Start ==========
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));


