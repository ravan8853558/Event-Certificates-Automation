// ===============================
// UEM Event Certificates - Frontend (FINAL STABLE SYNCED BUILD)
// ===============================

// ===== Backend URL =====
const BACKEND_URL = "https://event-certificates-automation.onrender.com";
function api(p) { return `${BACKEND_URL}${p}`; }

// ---- Canvas Setup ----
const canvas = document.getElementById("canvasPreview");
const ctx = canvas.getContext("2d");
const CANVAS_W = 1100, CANVAS_H = 850;

// ---- Elements ----
const eventNameEl = document.getElementById("eventName");
const eventDateEl = document.getElementById("eventDate");
const venueEl = document.getElementById("venue");
const orgByEl = document.getElementById("orgBy");
const templateFileEl = document.getElementById("templateFile");
const uploadTemplateBtn = document.getElementById("uploadTemplate");
const createEventBtn = document.getElementById("createEvent");
const fontFamilyEl = document.getElementById("fontFamily");
const fontSizeInput = document.getElementById("fontSizeInput");
const fontColorEl = document.getElementById("fontColor");
const textAlignEl = document.getElementById("textAlign");
const boxWidthInput = document.getElementById("boxWidthInput");
const boxHeightInput = document.getElementById("boxHeightInput");
const clearMarkersBtn = document.getElementById("clearMarkers");
const namePreviewInput = document.getElementById("namePreviewInput");
const viewEventsBtn = document.getElementById("viewEvents");
const downloadDataBtn = document.getElementById("downloadData");
const eventListDiv = document.getElementById("eventList");
const sendTestBtn = document.getElementById("sendTest");
const adminLoginBtn = document.getElementById("adminLoginBtn");

// New elements
const formLinkDisplay = document.getElementById("formLinkDisplay");
const formLinkText = document.getElementById("formLinkText");
const copyFormLink = document.getElementById("copyFormLink");
const bulkFileInput = document.getElementById("bulkFile");
const bulkUploadBtn = document.getElementById("bulkUploadBtn");

// ---- State ----
let templateImg = null;
let templatePathOnServer = null;
let uploadedTemplateWidth = null;
let uploadedTemplateHeight = null;
let fit = null;
let adminToken = localStorage.getItem("adminToken") || null;
let selectedEventId = null;
let eventId = localStorage.getItem("lastEventId") || null;

// ---- Editable Name Box ----
let nameMarker = { x: 400, y: 400, w: 300, h: 80 };
const qrMarker = { x: 0.87 * CANVAS_W, y: 0.78 * CANVAS_H, size: 120 };
let dragging = null;

// ==========================
// UTIL FUNCTIONS
// ==========================
function calcFit(imgW, imgH, outW, outH) {
  const r = imgW / imgH, R = outW / outH;
  if (r > R) return { drawW: outW, drawH: outW / r, offsetX: 0, offsetY: (outH - outW / r) / 2 };
  return { drawH: outH, drawW: outH * r, offsetX: (outW - outH * r) / 2, offsetY: 0 };
}

function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function clearStorageAndReload() {
  localStorage.clear();
  alert("Local storage cleared. Reloading...");
  location.reload();
}

// ==========================
// LOGIN + SESSION
// ==========================
async function ensureAdminLogin(force = false) {
  if (force || !adminToken) {
    const username = prompt("Admin Email:");
    const password = prompt("Admin Password:");
    if (!username || !password) return false;

    try {
      const res = await fetch(api("/api/admin/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const j = await res.json();
      if (j.token) {
        adminToken = j.token;
        localStorage.setItem("adminToken", j.token);
        alert("✅ Admin Login Successful.");
        return true;
      } else {
        alert("❌ Invalid credentials.");
        return false;
      }
    } catch {
      alert("❌ Login failed — server unreachable.");
      return false;
    }
  }
  return true;
}

if (adminLoginBtn) {
  adminLoginBtn.addEventListener("click", async () => {
    localStorage.removeItem("adminToken");
    adminToken = null;
    await ensureAdminLogin(true);
    location.reload();
  });
}

// ==========================
// TEST BACKEND CONNECTION
// ==========================
if (sendTestBtn) {
  sendTestBtn.addEventListener("click", async () => {
    try {
      const res = await fetch(api("/api/test"));
      const j = await res.json();
      alert(j.success ? "✅ Backend Connected!" : "❌ Backend not responding.");
    } catch {
      alert("❌ Cannot connect to backend.");
    }
  });
}

// ==========================
// TEMPLATE UPLOAD
// ==========================
uploadTemplateBtn.addEventListener("click", async () => {
  const file = templateFileEl.files[0];
  if (!file) return alert("Please select a certificate template first!");
  const form = new FormData();
  form.append("template", file);

  try {
    const res = await fetch(api("/api/upload-template"), { method: "POST", body: form });
    const j = await res.json();
    if (j.success) {
      templatePathOnServer = j.path;
      uploadedTemplateWidth = j.width;
      uploadedTemplateHeight = j.height;
      templateImg = new Image();
      templateImg.onload = () => {
        fit = calcFit(templateImg.width, templateImg.height, CANVAS_W, CANVAS_H);
        render();
      };
      templateImg.src = BACKEND_URL + j.path;
      alert("✅ Template uploaded successfully!");
    } else {
      alert("❌ Upload failed: " + (j.error || "unknown"));
    }
  } catch {
    alert("❌ Error uploading template.");
  }
});

// ==========================
// CANVAS PREVIEW
// ==========================
function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (templateImg && fit) {
    ctx.drawImage(templateImg, 0, 0, templateImg.width, templateImg.height,
      fit.offsetX, fit.offsetY, fit.drawW, fit.drawH);
  } else {
    ctx.fillStyle = "#999";
    ctx.font = "20px sans-serif";
    ctx.fillText("Upload a certificate template", 30, 50);
  }

  const name = namePreviewInput.value || "Participant Name";
  const fontSize = parseInt(fontSizeInput.value || 36);
  const fontColor = fontColorEl.value || "#0ea5e9";
  const fontFamily = fontFamilyEl.value || "Inter";
  const align = textAlignEl.value || "center";

  ctx.font = `${fontSize}px "${fontFamily}", sans-serif`;
  ctx.fillStyle = fontColor;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  const textX = align === "left" ? nameMarker.x + 10 :
                align === "right" ? nameMarker.x + nameMarker.w - 10 :
                nameMarker.x + nameMarker.w / 2;
  ctx.fillText(name, textX, nameMarker.y + nameMarker.h / 2);
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2;
  ctx.strokeRect(nameMarker.x, nameMarker.y, nameMarker.w, nameMarker.h);
}

// ==========================
// DRAGGING BOX
// ==========================
canvas.addEventListener("mousedown", (e) => {
  const p = getCanvasPos(e.clientX, e.clientY);
  if (p.x > nameMarker.x && p.x < nameMarker.x + nameMarker.w && p.y > nameMarker.y && p.y < nameMarker.y + nameMarker.h)
    dragging = "name";
});
canvas.addEventListener("mousemove", (e) => {
  if (dragging !== "name") return;
  const p = getCanvasPos(e.clientX, e.clientY);
  nameMarker.x = p.x - nameMarker.w / 2;
  nameMarker.y = p.y - nameMarker.h / 2;
  render();
});
window.addEventListener("mouseup", () => dragging = null);

// ==========================
// CREATE EVENT
// ==========================
createEventBtn.addEventListener("click", async () => {
  const ok = await ensureAdminLogin();
  if (!ok) return;
  if (!templatePathOnServer) return alert("Upload a template first!");

  const payload = {
    name: eventNameEl.value,
    date: eventDateEl.value,
    venue: venueEl.value,
    orgBy: orgByEl.value,
    templatePath: templatePathOnServer,
    nameFontSize: parseInt(fontSizeInput.value),
    nameFontColor: fontColorEl.value,
    nameFontFamily: fontFamilyEl.value,
    nameAlign: textAlignEl.value,
    nameX: nameMarker.x / CANVAS_W,
    nameY: nameMarker.y / CANVAS_H,
    nameW: nameMarker.w / CANVAS_W,
    nameH: nameMarker.h / CANVAS_H,
    qrX: qrMarker.x / CANVAS_W,
    qrY: qrMarker.y / CANVAS_H,
    qrSize: qrMarker.size / CANVAS_W,
  };

  try {
    const res = await fetch(api("/api/events"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + adminToken },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (j.success) {
      eventId = j.eventId;
      localStorage.setItem("lastEventId", eventId);
      formLinkDisplay.style.display = "block";
      formLinkText.textContent = j.formLink;
      navigator.clipboard.writeText(j.formLink);
      alert(`✅ Event Created Successfully!\nForm Link copied to clipboard.`);
    } else {
      alert("❌ Failed: " + (j.error || "Unknown error"));
    }
  } catch {
    alert("❌ Error creating event.");
  }
});

if (copyFormLink) {
  copyFormLink.addEventListener("click", () => {
    navigator.clipboard.writeText(formLinkText.textContent);
    alert("✅ Form link copied!");
  });
}

// ==========================
// BULK UPLOAD
// ==========================
bulkUploadBtn.addEventListener("click", async () => {
  const ok = await ensureAdminLogin();
  if (!ok) return;
  const file = bulkFileInput.files[0];
  if (!file) return alert("Select a CSV or Excel file first.");
  const eventTarget = selectedEventId || eventId;
  if (!eventTarget) return alert("Please select or create an event.");

  const form = new FormData();
  form.append("file", file);

  try {
    const res = await fetch(api(`/api/bulk-upload/${eventTarget}`), {
      method: "POST",
      headers: { Authorization: "Bearer " + adminToken },
      body: form,
    });
    const j = await res.json();
    if (j.success) alert(`✅ ${j.message}`);
    else alert(`❌ Failed: ${j.error || "Unknown error"}`);
  } catch {
    alert("❌ Bulk upload failed.");
  }
});

// ==========================
// EVENT LIST + DOWNLOAD
// ==========================
async function fetchEvents() {
  try {
    const res = await fetch(api("/api/events"), {
      headers: { Authorization: "Bearer " + adminToken },
    });
    const j = await res.json();
    if (!j.success) return alert("❌ Failed to fetch events.");
    if (!j.data.length) return (eventListDiv.innerHTML = "<p>No events yet.</p>");
    eventListDiv.innerHTML = "<h4>Events</h4>";
    j.data.forEach((ev) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = `
        <input type="radio" name="eventSelect" id="ev-${ev.id}" value="${ev.id}">
        <label for="ev-${ev.id}">${ev.name} (${ev.date})</label>`;
      eventListDiv.appendChild(wrap);
      wrap.querySelector("input").addEventListener("change", (e) => {
        selectedEventId = e.target.value;
        eventId = selectedEventId;
        localStorage.setItem("lastEventId", eventId);
      });
    });
  } catch {
    alert("❌ Error loading events.");
  }
}

viewEventsBtn.addEventListener("click", async () => {
  const ok = await ensureAdminLogin();
  if (ok) await fetchEvents();
});

downloadDataBtn.addEventListener("click", async () => {
  const ok = await ensureAdminLogin();
  if (!ok) return;
  if (!selectedEventId) return alert("Select an event first.");
  window.open(`${BACKEND_URL}/api/download-data/${selectedEventId}?token=${adminToken}`, "_blank");
});

// ==========================
// SHORTCUTS + AUTOLOAD
// ==========================
clearMarkersBtn.addEventListener("click", () => {
  nameMarker = { x: 400, y: 400, w: 300, h: 80 };
  render();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "L" && e.altKey) clearStorageAndReload();
});

window.addEventListener("load", async () => {
  render();
  if (adminToken) await fetchEvents();
});
