// ===============================
// UEM Event Certificates - Final Frontend (QR Fully Auto + Editable Name Box)
// ===============================

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
const generateCertBtn = document.getElementById("generateCert");
const viewEventsBtn = document.getElementById("viewEvents");
const downloadDataBtn = document.getElementById("downloadData");
const eventListDiv = document.getElementById("eventList");
const sendTestBtn = document.getElementById("sendTest");

const pName = document.getElementById("pName");
const pEmail = document.getElementById("pEmail");
const pMobile = document.getElementById("pMobile");
const pDept = document.getElementById("pDept");
const pYear = document.getElementById("pYear");
const pEnroll = document.getElementById("pEnroll");

// ---- State ----
let templateImg = null,
  templatePathOnServer = null,
  uploadedTemplateWidth = null,
  uploadedTemplateHeight = null,
  fit = null,
  eventId = null,
  adminToken = localStorage.getItem("adminToken") || null,
  selectedEventId = null;

// Editable name box only
let nameMarker = { x: 400, y: 400, w: 300, h: 80 };

// QR fixed at bottom-right (no user control)
const qrMarker = { x: 0.87 * CANVAS_W, y: 0.78 * CANVAS_H, size: 120 };

let dragging = null;

// ---- Helpers ----
function calcFit(imgW, imgH, outW, outH) {
  const r = imgW / imgH, R = outW / outH;
  if (r > R)
    return { drawW: outW, drawH: outW / r, offsetX: 0, offsetY: (outH - outW / r) / 2 };
  else
    return { drawH: outH, drawW: outH * r, offsetX: (outW - outH * r) / 2, offsetY: 0 };
}

function getCanvasPos(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = CANVAS_W / rect.width;
  const scaleY = CANVAS_H / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

// ---------- Test Connection ----------
sendTestBtn.addEventListener("click", async () => {
  try {
    const res = await fetch(api("/api/test"));
    const j = await res.json();
    alert(j.success ? "✅ Backend Connected!" : "❌ Backend issue detected.");
  } catch {
    alert("❌ Failed to connect to backend.");
  }
});

// ---------- Admin Login ----------
async function ensureAdminLogin() {
  if (adminToken) return true;
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
      alert("Invalid credentials.");
      return false;
    }
  } catch {
    alert("Login request failed.");
    return false;
  }
}

// ---------- Upload Template ----------
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
    } else alert("Upload failed: " + (j.error || "unknown"));
  } catch (err) {
    console.error(err);
    alert("Upload error.");
  }
});

// ---------- Render ----------
function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (templateImg && fit) {
    ctx.drawImage(
      templateImg,
      0,
      0,
      templateImg.width,
      templateImg.height,
      fit.offsetX,
      fit.offsetY,
      fit.drawW,
      fit.drawH
    );
  } else {
    ctx.fillStyle = "#888";
    ctx.font = "20px sans-serif";
    ctx.fillText("Upload certificate template to preview", 40, 60);
  }

  const name = namePreviewInput?.value || "Participant Name";
  const fontSize = parseInt(fontSizeInput?.value || 36);
  const fontColor = fontColorEl?.value || "#0ea5e9";
  const fontFamily = fontFamilyEl?.value || "Inter";
  const align = textAlignEl?.value || "center";

  ctx.font = `${fontSize}px "${fontFamily}", sans-serif`;
  ctx.fillStyle = fontColor;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";

  const textX =
    align === "left"
      ? nameMarker.x + 10
      : align === "right"
      ? nameMarker.x + nameMarker.w - 10
      : nameMarker.x + nameMarker.w / 2;

  ctx.fillText(name, textX, nameMarker.y + nameMarker.h / 2);

  // Editable name box border
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2;
  ctx.strokeRect(nameMarker.x, nameMarker.y, nameMarker.w, nameMarker.h);
}

// ---------- Dragging ----------
canvas.addEventListener("mousedown", (e) => {
  const p = getCanvasPos(e.clientX, e.clientY);
  if (
    p.x > nameMarker.x &&
    p.x < nameMarker.x + nameMarker.w &&
    p.y > nameMarker.y &&
    p.y < nameMarker.y + nameMarker.h
  )
    dragging = "name";
});

canvas.addEventListener("mousemove", (e) => {
  if (dragging !== "name") return;
  const p = getCanvasPos(e.clientX, e.clientY);
  nameMarker.x = p.x - nameMarker.w / 2;
  nameMarker.y = p.y - nameMarker.h / 2;
  render();
});

window.addEventListener("mouseup", () => (dragging = null));

// ---------- Create Event ----------
createEventBtn.addEventListener("click", async () => {
  const ok = await ensureAdminLogin();
  if (!ok) return;
  if (!templatePathOnServer) return alert("Upload template first!");

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
    templateW: uploadedTemplateWidth,
    templateH: uploadedTemplateHeight,

    // Normalized name box
    nameX: nameMarker.x / CANVAS_W,
    nameY: nameMarker.y / CANVAS_H,
    nameW: nameMarker.w / CANVAS_W,
    nameH: nameMarker.h / CANVAS_H,

    // Fixed QR parameters (no editing)
    qrX: qrMarker.x / CANVAS_W,
    qrY: qrMarker.y / CANVAS_H,
    qrSize: qrMarker.size / CANVAS_W,
  };

  try {
    const res = await fetch(api("/api/events"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + adminToken,
      },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    if (j.success) {
      eventId = j.eventId;
      alert(`✅ Event created!\nForm Link: ${j.formLink}`);
    } else alert("Failed: " + (j.error || "unknown"));
  } catch (err) {
    console.error(err);
    alert("Server error creating event.");
  }
});

// ---------- Generate Test Certificate ----------
generateCertBtn.addEventListener("click", async () => {
  if (!eventId) return alert("Create an event first.");
  const payload = {
    name: pName.value,
    email: pEmail.value,
    mobile: pMobile.value,
    dept: pDept.value,
    year: pYear.value,
    enroll: pEnroll.value,
  };
  try {
    const res = await fetch(api(`/api/submit/${parseInt(eventId)}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const j = await res.json();
    alert(
      j.success
        ? `✅ Certificate generated!\n${BACKEND_URL}${j.certPath}`
        : "❌ " + (j.error || j.details)
    );
  } catch (err) {
    console.error(err);
    alert("Certificate generation failed.");
  }
});

// ---------- View All Events ----------
viewEventsBtn.addEventListener("click", async () => {
  const ok = await ensureAdminLogin();
  if (!ok) return;
  try {
    const res = await fetch(api("/api/events"), {
      headers: { Authorization: "Bearer " + adminToken },
    });
    const j = await res.json();
    if (j.success && j.data && j.data.length) {
      eventListDiv.innerHTML = "<h3>Existing Events</h3>";
      j.data.forEach((ev) => {
        const wrap = document.createElement("div");
        wrap.style.margin = ".4rem 0";
        wrap.innerHTML = `
          <input type="checkbox" name="evCheck" value="${ev.id}" id="ev-${ev.id}">
          <label for="ev-${ev.id}"> <b>${ev.name}</b> (${ev.date})</label>
          &nbsp; <a href="${BACKEND_URL}/form/${ev.id}" target="_blank">Open Form</a>
        `;
        eventListDiv.appendChild(wrap);
        wrap.querySelector("input").addEventListener("click", function () {
          document.querySelectorAll("input[name='evCheck']").forEach((c) => {
            if (c !== this) c.checked = false;
          });
          selectedEventId = this.checked ? this.value : null;
          if (selectedEventId) eventId = selectedEventId;
        });
      });
    } else eventListDiv.innerHTML = "<p>No events found.</p>";
  } catch (err) {
    console.error(err);
    alert("Failed to load events.");
  }
});

// ---------- Download Event Data ----------
downloadDataBtn.addEventListener("click", async () => {
  const ok = await ensureAdminLogin();
  if (!ok) return;
  if (!selectedEventId)
    return alert("Select an event first (checkbox).");
  window.open(
    `${BACKEND_URL}/api/download-data/${selectedEventId}?token=${adminToken}`,
    "_blank"
  );
});

// ---------- Reset + Live Update ----------
clearMarkersBtn.addEventListener("click", () => {
  nameMarker = { x: 400, y: 400, w: 300, h: 80 };
  render();
});

[
  fontFamilyEl,
  fontSizeInput,
  fontColorEl,
  textAlignEl,
  boxWidthInput,
  boxHeightInput,
  namePreviewInput,
].forEach((el) =>
  el.addEventListener("input", () => {
    nameMarker.w = parseInt(boxWidthInput.value || 300);
    nameMarker.h = parseInt(boxHeightInput.value || 80);
    render();
  })
);

// ---------- Initial Render ----------
render();
