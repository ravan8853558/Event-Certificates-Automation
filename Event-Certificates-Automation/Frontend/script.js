/* ================= CONFIG ================= */

const BACKEND_URL = "https://event-certificates-automation.onrender.com";

/* ================= TOKEN HELPERS ================= */

const getToken = () => localStorage.getItem("adminToken");
const setToken = (token) => localStorage.setItem("adminToken", token);

const logout = () => {

  const overlay = document.createElement("div");
  overlay.className = "logout-overlay";

  overlay.innerHTML = `
    <div class="logout-box">
      <div class="logout-spinner"></div>
      <p>Logging out... Please wait</p>
    </div>
  `;

  document.body.appendChild(overlay);

  setTimeout(() => {
    localStorage.removeItem("adminToken");
    window.location.href = "index.html";
  }, 900);

};

const requireAuth = () => {
  if (!getToken()) window.location.href = "index.html";
};

/* ================= SAFE FETCH ================= */

async function authFetch(url, options = {}) {
  const token = getToken();
  options.headers = options.headers || {};

  if (token) {
    options.headers["Authorization"] = "Bearer " + token;
  }

  try {
    const res = await fetch(url, options);

    if (res.status === 401) {
      logout();
      return null;
    }

    return res;
  } catch (err) {
    console.error("Fetch Error:", err);
    return null;
  }
}

/* ================= INIT ================= */

window.addEventListener("load", () => {

  const themeBtn = document.querySelector(".theme-toggle");

  if (themeBtn) {

    const root = document.documentElement;

    const savedTheme = localStorage.getItem("theme");

    if (savedTheme) {
      root.setAttribute("data-theme", savedTheme);
    }
    const label = document.getElementById("themeLabel");

    if (label) {
      const current = root.getAttribute("data-theme") || "dark";
      label.textContent = current === "dark" ? "Light" : "Dark";
    }

    themeBtn.addEventListener("click", () => {

      const current = root.getAttribute("data-theme");
      const next = current === "dark" ? "light" : "dark";

      root.setAttribute("data-theme", next);
      localStorage.setItem("theme", next);

      const label = themeBtn.querySelector("#themeLabel");

      if (label) {
        label.textContent = next === "dark" ? "Light" : "Dark";
      }

    });

  }

  const menuToggle = document.getElementById("menuToggle");
  const navLinks = document.getElementById("navLinks");

  if (menuToggle && navLinks) {

    menuToggle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      navLinks.classList.toggle("active");
    });
    document.addEventListener("click", (e) => {

      if (!navLinks.classList.contains("active")) return;

      if (!navLinks.contains(e.target) && !menuToggle.contains(e.target)) {
        navLinks.classList.remove("active");
      }

    });

  }

document.addEventListener("click", (e) => {

  if (e.target.closest(".btn-logout")) {

    const overlay = document.createElement("div");
    overlay.className = "logout-overlay";

    overlay.innerHTML = `
      <div class="logout-box">
        <div class="logout-spinner"></div>
        <p>Logging out... Please wait</p>
      </div>
    `;

    document.body.appendChild(overlay);

    setTimeout(() => {
      localStorage.removeItem("adminToken");
      window.location.href = "index.html";
    }, 900);

  }

});

  /* ================= LOGIN PAGE ================= */

  const loginForm = document.getElementById("loginForm");

  if (loginForm) {

    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();

      const email = document.getElementById("loginEmail").value.trim();
      const password = document.getElementById("loginPassword").value.trim();

      const errorBox = document.getElementById("loginError");

      errorBox.innerText = "";

      try {
        const res = await fetch(`${BACKEND_URL}/api/admin/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: email, password })
        });

        const data = await res.json();

        if (res.ok && data.token) {

          setToken(data.token);

          // 🔥 SUCCESS ANIMATION RESTORED
          const overlay = document.createElement("div");
          overlay.className = "success-overlay";
          overlay.innerHTML = `<div class="success-circle">✓</div>`;
          document.body.appendChild(overlay);

          setTimeout(() => {
            window.location.href = "dashboard.html";
          }, 900);

        } else {
          errorBox.innerText = data.error || "Invalid credentials";
        }

      } catch {
        errorBox.innerText = "Server not reachable";
      }
    });

    return;
  }

  /* ================= DASHBOARD ================= */

  const canvas = document.getElementById("templateCanvas");
  const bulkFileInput = document.getElementById("bulkFile");

  if (canvas || bulkFileInput || document.getElementById("eventList")) {
    requireAuth();
  }

  if (canvas) {

  const ctx = canvas.getContext("2d");
  const uploadBtn = document.getElementById("uploadBtn");
  const fileInput = document.getElementById("templateFile");
  const createBtn = document.getElementById("createEventBtn");
  const statusDiv = document.getElementById("uploadStatus");
  const designerWrapper = document.getElementById("designerWrapper");

  const previewNameInput = document.getElementById("previewName");
  const fontSizeInput = document.getElementById("fontSize");
  const fontColorInput = document.getElementById("fontColor");

  let templateImage = null;
  let uploadedTemplatePath = null;

  let nameX = canvas.width / 2;
  let nameY = canvas.height / 2;

  let nameBoxWidth = 350;
  let nameBoxHeight = 90;

  let dragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  let qrOffsetX = 0;
  let qrOffsetY = 0;
// ================= QR DESIGNER =================

  let qrX = canvas.width - 150;
  let qrY = canvas.height - 150;

  let qrSize = 140;

  let qrDragging = false;
  let qrResizing = false;

  const showStatus = (msg, type = "") => {
    statusDiv.innerText = msg;
    statusDiv.className = "status " + type;
  };

  /* ================= DRAW ================= */

  function drawCanvas() {

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (templateImage) {
      ctx.drawImage(templateImage, 0, 0, canvas.width, canvas.height);
    }

    ctx.font = `${parseInt(fontSizeInput.value || 36)}px Poppins`;
    ctx.fillStyle = fontColorInput.value || "#000";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const text = (previewNameInput.value || "Participant Name").slice(0, 40);
    ctx.fillText(text, nameX, nameY);

    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 2;
    ctx.strokeRect(
      nameX - nameBoxWidth / 2,
      nameY - nameBoxHeight / 2,
      nameBoxWidth,
      nameBoxHeight
    );

// QR preview box

  ctx.strokeStyle = "red";
  ctx.lineWidth = 2;
  ctx.strokeRect(qrX, qrY, qrSize, qrSize);

// resize handle
  ctx.fillStyle = "red";
  ctx.fillRect(qrX + qrSize - 10, qrY + qrSize - 10, 20, 20);
  }

  /* ================= TEMPLATE UPLOAD ================= */

  uploadBtn.addEventListener("click", async () => {

    if (!fileInput.files.length) {
      showStatus("Select template first.", "error");
      return;
    }

    const file = fileInput.files[0];

    if (!file.type.startsWith("image/")) {
      showStatus("Only image files allowed.", "error");
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showStatus("Max 5MB allowed.", "error");
      return;
    }

    const formData = new FormData();
    formData.append("template", file);

    uploadBtn.disabled = true;
    uploadBtn.innerText = "Uploading...";

    const res = await authFetch(`${BACKEND_URL}/api/upload-template`, {
      method: "POST",
      body: formData
    });

    if (!res) {
      showStatus("Upload failed.", "error");
      uploadBtn.disabled = false;
      uploadBtn.innerText = "Upload Template";
      return;
    }

    const data = await res.json();

    if (res.ok && data.success) {

      uploadedTemplatePath = data.path;

      templateImage = new Image();
      templateImage.crossOrigin = "anonymous";

      templateImage.onload = () => {

        // 🔥 IMPORTANT FIX
        canvas.width = templateImage.width;
        canvas.height = templateImage.height;

        // reset default positions
        nameX = canvas.width / 2;
        nameY = canvas.height / 2;

        qrX = canvas.width - 150;
        qrY = canvas.height - 150;

        designerWrapper.classList.remove("hidden");
        drawCanvas();
      };

      templateImage.onerror = () => {
        showStatus("Failed to load template image.", "error");
      };

      templateImage.src = BACKEND_URL + data.path;


      showStatus("Template uploaded successfully!", "success");

    } else {
      showStatus(data.error || "Upload failed.", "error");
    }

    uploadBtn.disabled = false;
    uploadBtn.innerText = "Upload Template";
  });


/* ================= DRAG (PRO VERSION) ================= */

function isInsideNameBox(x, y) {
  return (
    x >= nameX - nameBoxWidth / 2 &&
    x <= nameX + nameBoxWidth / 2 &&
    y >= nameY - nameBoxHeight / 2 &&
    y <= nameY + nameBoxHeight / 2
  );
}

function getPointerPos(e) {

  const rect = canvas.getBoundingClientRect();

  const x = (e.clientX - rect.left) * (canvas.width / rect.width);
  const y = (e.clientY - rect.top) * (canvas.height / rect.height);

  return { x, y };

}

function isInsideQR(x, y) {
  return (
    x >= qrX &&
    x <= qrX + qrSize &&
    y >= qrY &&
    y <= qrY + qrSize
  );
}

function isQRResizeHandle(x, y) {
  return (
    x >= qrX + qrSize - 20 &&
    x <= qrX + qrSize + 20 &&
    y >= qrY + qrSize - 20 &&
    y <= qrY + qrSize + 20
  );
}

canvas.addEventListener("pointerdown", (e) => {

  const {x, y} = getPointerPos(e);

  if (isQRResizeHandle(x, y)) {
    qrResizing = true;
    return;
  }

  if (isInsideQR(x, y)) {

    qrDragging = true;

    qrOffsetX = x - qrX;
    qrOffsetY = y - qrY;

    return;
  }

  if (isInsideNameBox(x, y)) {

    dragging = true;

    dragOffsetX = x - nameX;
    dragOffsetY = y - nameY;

  }

});


canvas.addEventListener("pointermove", (e) => {

  const {x, y} = getPointerPos(e);

  if (qrDragging) {

    qrX = Math.max(0, Math.min(canvas.width - qrSize, x - qrOffsetX));
    qrY = Math.max(0, Math.min(canvas.height - qrSize, y - qrOffsetY));

    drawCanvas();
    return;

  }

  if (qrResizing) {

    qrSize = Math.max(80, Math.min(300, x - qrX));

    drawCanvas();
    return;

  }

  if (dragging) {

    nameX = Math.max(nameBoxWidth/2, Math.min(canvas.width - nameBoxWidth/2, x - dragOffsetX));
    nameY = Math.max(nameBoxHeight/2, Math.min(canvas.height - nameBoxHeight/2, y - dragOffsetY));

    drawCanvas();

  }

});


canvas.addEventListener("pointerup", () => {

  dragging = false;
  qrDragging = false;
  qrResizing = false;

});


canvas.addEventListener("pointerleave", () => {

  dragging = false;
  qrDragging = false;
  qrResizing = false;

});

/* Re-render when controls change */
[previewNameInput, fontSizeInput, fontColorInput]
  .forEach(el => el.addEventListener("input", drawCanvas));

  /* ================= CREATE EVENT ================= */

  createBtn.addEventListener("click", async () => {

    if (createBtn.disabled) return;

    if (!uploadedTemplatePath) {
      showStatus("Upload template first.", "error");
      return;
    }

    const eventName = document.getElementById("eventName").value.trim();
    const eventDate = document.getElementById("eventDate").value;
    const venue = document.getElementById("venue").value.trim();
    const orgBy = document.getElementById("orgBy").value.trim();

    if (!eventName || !eventDate) {
      showStatus("Event name & date required.", "error");
      return;
    }

    createBtn.disabled = true;
    showStatus("Creating event...");

    const res = await authFetch(`${BACKEND_URL}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: eventName,
        date: eventDate,
        venue,
        orgBy,
        templatePath: uploadedTemplatePath,
        nameX: nameX / canvas.width,
        nameY: nameY / canvas.height,
        nameW: nameBoxWidth / canvas.width,
        nameH: nameBoxHeight / canvas.height,
        nameFontFamily: "Poppins",
        nameFontSize: parseInt(fontSizeInput.value || 36),
        nameFontColor: fontColorInput.value || "#000",
        nameAlign: document.getElementById("textAlign").value,
        qrX: qrX / canvas.width,
	qrY: qrY / canvas.height,
	qrSize: qrSize / canvas.width
      })
    });

    if (!res) {
      showStatus("Server error.", "error");
      createBtn.disabled = false;
      return;
    }

    const data = await res.json();

    if (res.ok && data.success) {

      showStatus("Event created successfully!", "success");

      showModal(
        "Event Created Successfully 🎉",
        "Your event has been created.\nForm link copied to clipboard."
      );

      try {
        await navigator.clipboard.writeText(data.formLink);
      } catch {
        showModal("Notice", "Event created, but clipboard copy failed.");
      }

    } else {
      showStatus(data.error || "Creation failed.", "error");
    }

    createBtn.disabled = false;
   });
}
function showModal(title, message, onConfirm = null) {
  const modal = document.getElementById("customModal");
  const modalTitle = document.getElementById("modalTitle");
  const modalMessage = document.getElementById("modalMessage");
  const confirmBtn = document.getElementById("modalConfirm");
  const cancelBtn = document.getElementById("modalCancel");

  modalTitle.innerText = title;
  modalMessage.innerText = message;

  if (onConfirm) {
    cancelBtn.style.display = "inline-block";
    confirmBtn.innerText = "Confirm";
  } else {
    cancelBtn.style.display = "none";
    confirmBtn.innerText = "OK";
  }

  modal.classList.remove("hidden");

  confirmBtn.onclick = () => {
    modal.classList.add("hidden");
    if (onConfirm) onConfirm();
  };

  cancelBtn.onclick = () => {
    modal.classList.add("hidden");
  };
}

/* ================= BULK PAGE ================= */

const bulkFile = document.getElementById("bulkFile");

if (bulkFile) {

  requireAuth();

  const eventSelect = document.getElementById("eventSelect");
  const bulkUploadBtn = document.getElementById("bulkUploadBtn");
  const bulkStatus = document.getElementById("bulkStatus");
  const columnMappingSection = document.getElementById("columnMappingSection");
  const nameColumnSelect = document.getElementById("nameColumnSelect");
  const generateBulkBtn = document.getElementById("generateBulkBtn");
  const downloadSection = document.getElementById("bulkDownloadSection");
  const downloadZipBtn = document.getElementById("downloadZipBtn");

  let uploadedTempFile = null;
  let interval = null;

  window.addEventListener("beforeunload", () => {
    if (interval) clearInterval(interval);
  });

  /* ================= LOAD EVENTS ================= */

async function loadEvents() {

  try {

    const res = await authFetch(`${BACKEND_URL}/api/events`);
    if (!res) return;

    const data = await res.json();

    if (!data.success || !Array.isArray(data.data)) {
      console.error("Invalid events response:", data);
      return;
    }

    eventSelect.innerHTML = "";

    data.data.forEach(ev => {
      const opt = document.createElement("option");
      opt.value = ev.id;
      opt.textContent = ev.name;
      eventSelect.appendChild(opt);
    });

  } catch (err) {

    console.error("Event load failed:", err);

  }

}
 loadEvents();
 /* ================= FILE UPLOAD ================= */

bulkUploadBtn.addEventListener("click", async () => {

  if (!eventSelect.value) {
    bulkStatus.innerText = "Select event first.";
    return;
  }

  if (bulkUploadBtn.disabled) return;
  bulkUploadBtn.disabled = true;

  try {

    if (!bulkFile.files.length) {
      bulkStatus.innerText = "Select file first.";
      return;
    }

    const formData = new FormData();
    formData.append("file", bulkFile.files[0]);
    formData.append("eventId", eventSelect.value);

    bulkStatus.innerText = "Uploading...";

    const res = await authFetch(`${BACKEND_URL}/api/bulk/upload`, {
      method: "POST",
      body: formData
    });

    if (!res) {
      bulkStatus.innerText = "Network error.";
      return;
    }

    let data;

    try {
      data = await res.json();
    } catch (err) {
      console.error("Invalid JSON response");
      bulkStatus.innerText = "Server response error.";
      return;
    }

    if (!res.ok) {
      bulkStatus.innerText = data.error || "Upload failed";
      return;
    }

    uploadedTempFile = data.tempFile;

    /* SAFE COLUMN POPULATION */

    nameColumnSelect.innerHTML = "";

    if (Array.isArray(data.columns)) {
      data.columns.forEach(col => {
        const opt = document.createElement("option");
        opt.value = col;
        opt.textContent = col;
        nameColumnSelect.appendChild(opt);
      });
    } else {
      bulkStatus.innerText = "Invalid column data.";
      return;
    }

    columnMappingSection.classList.remove("hidden");
    document.querySelectorAll(".step-item")[1]?.classList.add("done");
    document.querySelectorAll(".step-item")[2]?.classList.add("active");

    bulkStatus.innerText = `File uploaded successfully (${data.previewCount || 0} rows).`;
    document.querySelectorAll(".step-item")[0]?.classList.add("done");
    document.querySelectorAll(".step-item")[1]?.classList.add("active");

  } catch (err) {

    console.error("Upload error:", err);
    bulkStatus.innerText = "Upload error.";

  } finally {

    bulkUploadBtn.disabled = false;

  }

});


/* ================= GENERATE BULK ================= */

generateBulkBtn.addEventListener("click", async () => {

  if (generateBulkBtn.disabled) return;

  if (!uploadedTempFile) {
    bulkStatus.innerText = "Upload file first.";
    return;
  }

  generateBulkBtn.disabled = true;
  bulkStatus.innerText = "Starting bulk job...";

  try {

    const res = await authFetch(`${BACKEND_URL}/api/bulk/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId: eventSelect.value,
        nameColumn: nameColumnSelect.value,
        tempFile: uploadedTempFile
      })
    });

    if (!res) {
      bulkStatus.innerText = "Network error.";
      generateBulkBtn.disabled = false;
      return;
    }

    const data = await res.json();

    if (!res.ok) {
      bulkStatus.innerText = data.error || "Generation failed";
      generateBulkBtn.disabled = false;
      return;
    }

    const jobId = data.jobId;
    bulkStatus.innerText = "Processing...";

    let attempts = 0;
    const MAX_ATTEMPTS = 60;

    if (interval) clearInterval(interval);

    interval = setInterval(async () => {

      try {

        attempts++;

        if (attempts > MAX_ATTEMPTS) {
          clearInterval(interval);
          bulkStatus.innerText = "Processing timeout.";
          generateBulkBtn.disabled = false;
          return;
        }

        const progRes = await authFetch(`${BACKEND_URL}/api/bulk/progress/${jobId}`);

        if (!progRes) {
          clearInterval(interval);
          bulkStatus.innerText = "Network error.";
          generateBulkBtn.disabled = false;
          return;
        }

        const progData = await progRes.json();

        bulkStatus.innerText = `Progress: ${progData.percent}%`;

        const container = document.getElementById("progressContainer");
        if (container) container.classList.add("visible");

        if (progData.status === "completed") {
           
          const steps = document.querySelectorAll(".step-item");

          if (steps.length >= 4) {
            steps[2].classList.add("done");
            steps[3].classList.add("active");
          }

          clearInterval(interval);

          // FORCE PROGRESS 100
          bulkStatus.innerText = "Progress: 100%";

          const fill = document.getElementById("progressFill");
          const pct = document.getElementById("progressPct");

          if (fill) fill.style.width = "100%";
          if (pct) pct.innerText = "100%";
  
          downloadSection.classList.remove("hidden");
          downloadZipBtn.dataset.zip = progData.zipUrl;

          setTimeout(() => {
            bulkStatus.innerText = "Certificates generated successfully!";
          }, 500);

          generateBulkBtn.disabled = false;
        }

        if (progData.status === "failed") {
          clearInterval(interval);
          bulkStatus.innerText = "Bulk job failed.";
          generateBulkBtn.disabled = false;
        }

      } catch (err) {

        console.error("Polling error:", err);

        clearInterval(interval);
        bulkStatus.innerText = "Error checking progress.";
        generateBulkBtn.disabled = false;

      }

    }, 2000);

  } catch (err) {

    console.error("Generate error:", err);
    bulkStatus.innerText = "Bulk start failed.";
    generateBulkBtn.disabled = false;

  }

});


  /* ================= DOWNLOAD ZIP ================= */

  downloadZipBtn.addEventListener("click", () => {

    const zip = downloadZipBtn.dataset.zip;

    if (!zip) {
      bulkStatus.innerText = "ZIP file not ready.";
      return;
    }

    window.open(zip, "_blank", "noopener,noreferrer");
  });

}
/* ================= MANAGE EVENTS ================= */

const eventList = document.getElementById("eventList");

if (eventList) {

  async function loadEvents() {

    eventList.innerHTML = "Loading events...";

    const res = await authFetch(`${BACKEND_URL}/api/events`);
    if (!res) return;

    const data = await res.json();

    if (!data.success || !data.data.length) {
      eventList.innerHTML = "No events found.";
      return;
    }

    eventList.innerHTML = "";

    data.data.forEach(event => {

      const card = document.createElement("div");
      card.className = "event-card";

      card.innerHTML = `
        <h3>${event.name}</h3>
        <p>${event.orgBy} • ${event.date}</p>

        <div>
          <input type="checkbox" class="event-check" value="${event.id}">
        </div>

        <div class="event-actions">
          <button class="btn btn-copy">Copy Form Link</button>
          <button class="btn btn-excel">Download Excel</button>
          <button class="btn btn-delete">Delete</button>
        </div>
      `;

      // Copy form link
      card.querySelector(".btn-copy").addEventListener("click", async () => {
        const link = `${BACKEND_URL}/form/${event.id}`;
	try {
 	 await navigator.clipboard.writeText(link);
 	 showModal("Copied", "Form link copied to clipboard.");
	} catch {
 	 showModal("Error", "Clipboard permission denied.");
	}
      });

      // Proper Excel download (WITH AUTH HEADER)
      card.querySelector(".btn-excel").addEventListener("click", async () => {

        const res = await authFetch(
          `${BACKEND_URL}/api/download-excel/${event.id}`
        );

        if (!res) return;

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = `${event.name.replace(/[^\w]/g, "_")}.xlsx`;
        a.click();
      });

      card.querySelector(".btn-delete").addEventListener("click", () => {

        showModal(
          "Delete Event",
          "Are you sure you want to delete this event permanently?",
          async () => {
            const delRes = await authFetch(
              `${BACKEND_URL}/api/events/${event.id}`,
              { method: "DELETE" }
            );

            if (delRes && delRes.ok) {
              loadEvents();
            }
          }
        );

      });

      eventList.appendChild(card);
    });
  }

  // BULK DOWNLOAD
  window.downloadSelected = async function() {

    const selected = [...document.querySelectorAll(".event-check:checked")]
      .map(cb => cb.value);

    if (!selected.length) {
      showModal("No Selection", "Please select at least one event.");
      return;
    }

    const res = await authFetch(
      `${BACKEND_URL}/api/download-multiple-excel?ids=${selected.join(",")}`
    );

    if (!res) return;

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "multiple_events_data.zip";
    a.click();
  };

// BULK DELETE
window.deleteSelected = function() {

  const selected = [...document.querySelectorAll(".event-check:checked")]
    .map(cb => parseInt(cb.value));

  if (!selected.length) {
    showModal("No Selection", "Please select at least one event.");
    return;
  }

  showModal(
    "Delete Selected Events",
    "Are you sure you want to delete selected events permanently?",
    async () => {

      const res = await authFetch(
        `${BACKEND_URL}/api/delete-multiple-events`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids: selected })
        }
      );

      if (res && res.ok) {
        loadEvents();
      } else {
        showModal("Error", "Bulk delete failed.");
      }

    }
  );
};

// Attach bulk button listeners
    const bulkDownloadBtn = document.getElementById("bulkDownloadBtn");
    const bulkDeleteBtn = document.getElementById("bulkDeleteBtn");

    if (bulkDownloadBtn) {
      bulkDownloadBtn.addEventListener("click", downloadSelected);
    }

    if (bulkDeleteBtn) {
      bulkDeleteBtn.addEventListener("click", deleteSelected);
    }

  loadEvents();
}

});