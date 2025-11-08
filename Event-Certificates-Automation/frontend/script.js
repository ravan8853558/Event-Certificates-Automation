// ===============================
//  UEM Event Certificates - Final Frontend (For Netlify)
// ===============================

// change this after backend deploy on Render
const BACKEND_URL = "https://uem-certificates-backend.onrender.com";

function api(path) {
  return `${BACKEND_URL}${path}`;
}

const canvas = document.getElementById('canvasPreview');
const ctx = canvas.getContext('2d');
const CANVAS_W = 1000, CANVAS_H = 700;

let templateImg = null;
let templatePathOnServer = null;
let eventId = null;
let nameMarker = { x: 200, y: 300 };
let qrMarker = { x: 700, y: 400 };
let dragging = null, dragOffset = { x: 0, y: 0 };

let adminToken = localStorage.getItem('adminToken') || null;

// ===== ADMIN LOGIN =====
async function ensureAdminLogin() {
  if (adminToken) return true;
  const username = prompt('Admin Email/Username:');
  const password = prompt('Admin Password:');
  if (!username || !password) {
    alert('Login cancelled.');
    return false;
  }

  try {
    const res = await fetch(api('/api/admin/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const j = await res.json();
    if (j.token) {
      adminToken = j.token;
      localStorage.setItem('adminToken', adminToken);
      alert('Admin login successful.');
      return true;
    } else {
      alert('Login failed: ' + (j.error || 'Invalid credentials'));
      return false;
    }
  } catch (err) {
    alert('Login request failed.');
    return false;
  }
}

// ===== Template Upload =====
document.getElementById('templateFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append('template', file);

  try {
    const res = await fetch(api('/api/upload-template'), { method: 'POST', body: form });
    const j = await res.json();
    if (j.success) {
      templatePathOnServer = j.path;
      templateImg = new Image();
      templateImg.onload = render;
      templateImg.src = BACKEND_URL + j.path;
    } else {
      alert('Upload failed.');
    }
  } catch {
    alert('Upload failed.');
  }
});

// ===== Utility for preview rendering =====
function calcFit(imgW, imgH, outW, outH) {
  const imgRatio = imgW / imgH, outRatio = outW / outH;
  let drawW, drawH, offsetX, offsetY;
  if (imgRatio > outRatio) { drawW = outW; drawH = outW / imgRatio; offsetX = 0; offsetY = (outH - drawH) / 2; }
  else { drawH = outH; drawW = outH * imgRatio; offsetX = (outW - drawW) / 2; offsetY = 0; }
  return { drawW, drawH, offsetX, offsetY };
}
function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  if (templateImg && templateImg.complete) {
    const fit = calcFit(templateImg.width, templateImg.height, CANVAS_W, CANVAS_H);
    ctx.drawImage(templateImg, 0, 0, templateImg.width, templateImg.height,
      fit.offsetX, fit.offsetY, fit.drawW, fit.drawH);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '20px sans-serif';
    ctx.fillText('Upload certificate template to preview here', 20, 40);
  }
  const fontSize = parseInt(document.getElementById('fontSize').value) || 36;
  const nameText = document.getElementById('namePreview').value || 'Participant Name';
  ctx.font = `${fontSize}px Inter, sans-serif`;
  ctx.fillStyle = '#0ea5e9';
  ctx.fillText(nameText, nameMarker.x, nameMarker.y);
  const qrSize = parseInt(document.getElementById('qrSize').value) || 80;
  ctx.strokeStyle = '#ef4444'; ctx.lineWidth = 3;
  ctx.strokeRect(qrMarker.x, qrMarker.y, qrSize, qrSize);
}

canvas.addEventListener('mousedown', e => {
  const pos = getCanvasPos(e.clientX, e.clientY);
  const qrSize = parseInt(document.getElementById('qrSize').value);
  if (pos.x > nameMarker.x && pos.x < nameMarker.x + 200 && pos.y > nameMarker.y - 40 && pos.y < nameMarker.y + 10) dragging = 'name';
  else if (pos.x > qrMarker.x && pos.x < qrMarker.x + qrSize && pos.y > qrMarker.y && pos.y < qrMarker.y + qrSize) dragging = 'qr';
});
canvas.addEventListener('mousemove', e => {
  if (!dragging) return;
  const pos = getCanvasPos(e.clientX, e.clientY);
  if (dragging === 'name') { nameMarker.x = pos.x; nameMarker.y = pos.y; }
  else { qrMarker.x = pos.x; qrMarker.y = pos.y; }
  render();
});
window.addEventListener('mouseup', () => dragging = null);

// ===== Event Creation =====
document.getElementById('generateForm').addEventListener('click', async () => {
  const ok = await ensureAdminLogin(); if (!ok) return;
  const payload = {
    name: document.getElementById('eventName').value,
    date: document.getElementById('eventDate').value,
    venue: document.getElementById('venue').value,
    orgBy: document.getElementById('orgBy').value,
    templatePath: templatePathOnServer,
    nameX: nameMarker.x, nameY: nameMarker.y,
    nameFontSize: parseInt(document.getElementById('fontSize').value),
    qrX: qrMarker.x, qrY: qrMarker.y,
    qrSize: parseInt(document.getElementById('qrSize').value)
  };
  const res = await fetch(api('/api/events'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken },
    body: JSON.stringify(payload)
  });
  const j = await res.json();
  if (j.eventId) { eventId = j.eventId; alert(`Event created!\nForm Link: ${j.formLink}`); }
  else alert('Failed: ' + (j.error || 'Unknown'));
});

// ===== Generate Certificate =====
document.getElementById('generateCert').addEventListener('click', async () => {
  if (!eventId) return alert('Create event first.');
  const payload = {
    name: document.getElementById('pName').value,
    email: document.getElementById('pEmail').value,
    mobile: document.getElementById('pMobile').value,
    dept: document.getElementById('pDept').value,
    year: document.getElementById('pYear').value,
    enroll: document.getElementById('pEnroll').value
  };
  const res = await fetch(api(`/api/submit/${eventId}`), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await res.json();
  alert(j.success ? `Certificate generated!\n${BACKEND_URL}${j.certPath}` : `Error: ${j.error}`);
});

// ===== Download Data =====
document.getElementById('downloadData').addEventListener('click', async () => {
  const ok = await ensureAdminLogin(); if (!ok) return;
  if (!eventId) return alert('No event.');
  window.open(`${BACKEND_URL}/api/download-data/${eventId}?token=${adminToken}`, '_blank');
});
const BACKEND_URL = "https://uem-certificates-backend.onrender.com";
// Live preview
document.getElementById('fontSize').addEventListener('input', render);
document.getElementById('namePreview').addEventListener('input', render);
document.getElementById('qrSize').addEventListener('input', render);
document.getElementById('clearMarkers').addEventListener('click', () => { nameMarker = {x:200,y:300}; qrMarker={x:700,y:400}; render(); });
render();
