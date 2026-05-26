/* ═══════════════════════════════════════════════════
   TreadGuard CV — app.js
   Pure vanilla JS | No build step | No frameworks
   ─────────────────────────────────────────────────
   Sections:
   1. Configuration & Constants
   2. State Management
   3. API Integration (Roboflow)
   4. Dummy Data Fallback Engine
   5. DOM Update Functions
   6. Canvas HUD Renderer
   7. Z-Axis Sensor (DeviceMotion)
   8. Roughness Waveform Graph
   9. Skid Gauge (Canvas)
   10. Quality Ring (Canvas)
   11. Upload Handler
   12. UI Controls & Clock
   13. Initializer
═══════════════════════════════════════════════════ */

'use strict';

/* ─────────────────────────────────────────────────
   1. CONFIGURATION & CONSTANTS
   ─────────────────────────────────────────────────
   !! REPLACE THESE PLACEHOLDERS BEFORE GOING LIVE !!
───────────────────────────────────────────────── */
const CONFIG = {
  // ╔══════════════════════════════════════════════╗
  // ║   YOUR_ROBOFLOW_MODEL_ENDPOINT               ║
  // ║   Example: https://detect.roboflow.com/      ║
  // ║           pothole-detection-model/3          ║
  // ╚══════════════════════════════════════════════╝
  // Correct Roboflow Workflow REST endpoint:
  // POST https://serverless.roboflow.com/infer/workflows/{workspace}/{workflow_id}
  ROBOFLOW_ENDPOINT: '/api/analyze',   // Proxied via server.js → Roboflow (avoids CORS),

  // ── API key lives in server.js (ROBOFLOW_API_KEY) ──────────────────────
  // Do NOT put it here — app.js is public; server.js is private/server-side.

  COST_PER_POTHOLE: 2500,           // INR
  ABRASION_MODERATE_THRESHOLD: 5,
  ABRASION_CRITICAL_THRESHOLD: 12,

  DUMMY_UPDATE_INTERVAL_MS: 2000,   // How fast demo data refreshes
  GRAPH_HISTORY_POINTS: 60,         // Points in waveform graph
  ZBAR_COUNT: 28,                   // Bars in Z-axis visualizer
  MAX_COST_BAR: 50000,              // Max value for cost bar (100%)
};

/* ─────────────────────────────────────────────────
   POTHOLE POSITIONS  (model-space: 640 × 360)
   These fixed coords match the potholes drawn by
   drawRoadScene() so detection boxes land on them.
───────────────────────────────────────────────── */
const POTHOLE_POSITIONS = [
  { x: 155, y: 190, width: 82,  height: 52 },  // left lane, shallow
  { x: 460, y: 258, width: 96,  height: 62 },  // right lane, mid-depth
  { x: 215, y: 315, width: 72,  height: 46 },  // left lane, lower frame
  { x: 528, y: 162, width: 66,  height: 44 },  // right lane, far
  { x: 385, y: 305, width: 90,  height: 56 },  // center-right, lower
];

/* ─────────────────────────────────────────────────
   2. STATE MANAGEMENT
───────────────────────────────────────────────── */
const State = {
  isDemoMode: false,          // Start in demo mode (safe fallback)
  potholeCount: 0,
  sessionTotal: 0,
  framesAnalyzed: 0,
  detections: [],            // Raw detection boxes from API/demo
  sparklineHistory: [],      // Last N pothole counts for sparkline

  zAxis: {
    current: 0,
    peak: 0,
    history: [],
    events: 0,             // Significant bump events (>0.5G)
    readings: [],          // For average calc
  },

  roughnessHistory: new Array(CONFIG.GRAPH_HISTORY_POINTS).fill(0),

  sessionStartTime: Date.now(),
  demoInterval: null,
  apiConnected: false,

  scanProgress: 0,
};

/* ─────────────────────────────────────────────────
   3. API INTEGRATION — Roboflow
───────────────────────────────────────────────── */

/**
 * Captures the current video frame into a Base64 image
 * and sends it to the Roboflow inference API.
 * Returns the parsed JSON response or throws on failure.
 */
async function analyzeFrame() {
  const video = document.getElementById('roadVideo');

  // 1. Capture frame to canvas
  const offscreen = document.createElement('canvas');
  offscreen.width  = video.videoWidth  || 640;
  offscreen.height = video.videoHeight || 360;
  const ctx = offscreen.getContext('2d');
  
  // Draw the video
  ctx.drawImage(video, 0, 0, offscreen.width, offscreen.height);

  // Convert to Base64 JPEG
  const base64Image = offscreen.toDataURL('image/jpeg', 0.8).split(',')[1];

  // 2. Roboflow WORKFLOW REST API Call
  // Spec: POST /infer/workflows/{workspace}/{workflow_id}
  // POST to our local proxy server — it forwards to Roboflow server-side
  // (direct browser → serverless.roboflow.com is blocked by CORS)
  const response = await fetch(CONFIG.ROBOFLOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: base64Image })
  });

  if (!response.ok) {
    throw new Error(`Roboflow Workflow error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Wrapper that tries the live API and falls back to dummy data.
 * Updates State.apiConnected accordingly.
 */
async function runAnalysis() {
  setScanBusy(true);

  try {
    // Guard: only attempt live API when demo is off AND a real API key is set
    // Guard: only call API when not in demo mode AND a real key is present
    if (!State.isDemoMode) {  // Key lives in server.js — no guard needed here
      const data = await analyzeFrame();

      // ─── detect-count-and-visualize workflow actual response shape ──────────
      // { outputs: [{ count_objects: N, output_image: { type:'base64', value:'...' } }] }
      //   count_objects → number of potholes detected
      //   output_image  → annotated frame with boxes already drawn by Roboflow
      // ─────────────────────────────────────────────────────────────────────
      let count = 0;
      let predictions = [];

      console.log('[TreadGuard] Raw response keys:', Object.keys(data));

      if (data.outputs && Array.isArray(data.outputs)) {
        for (const output of data.outputs) {

          // ── Primary path: detect-count-and-visualize keys ──
          if (typeof output.count_objects === 'number') {
            count = output.count_objects;
            // Read real bounding boxes if present (avoids needing annotated image)
            if (output.predictions?.predictions && Array.isArray(output.predictions.predictions)) {
              predictions = output.predictions.predictions;
            } else if (Array.isArray(output.predictions)) {
              predictions = output.predictions;
            }
            console.log(`[TreadGuard] ✓ count_objects=${count}, predictions=${predictions.length}`);
            break;
          }

          // ── Fallback: { predictions: { predictions:[...] } } ──
          if (output.predictions?.predictions && Array.isArray(output.predictions.predictions)) {
            predictions = output.predictions.predictions;
            count = predictions.length;
            break;
          }
          // ── Fallback: { predictions:[...] } ──
          if (Array.isArray(output.predictions)) {
            predictions = output.predictions;
            count = predictions.length;
            break;
          }
          // ── Fallback: bare count field ──
          if (typeof output.count === 'number') {
            count = output.count;
          }
        }
      } else if (data.predictions) {
        predictions = Array.isArray(data.predictions) ? data.predictions : [];
        count = predictions.length;
      }

      // Synthesise placeholder boxes for counter/sparkline when we have count but no coords
      if (count > 0 && predictions.length === 0) {
        const cols = Math.ceil(Math.sqrt(count));
        predictions = Array.from({ length: count }, (_, i) => ({
          x: 80  + (i % cols) * 110,
          y: 180 + Math.floor(i / cols) * 90,
          width: 85, height: 55,
          confidence: 0.88, class: 'pothole', id: i,
        }));
      }

      console.log(`[TreadGuard] ✓ Final count=${count}, boxes=${predictions.length}`);

      processDetectionData(count, predictions);
      State.apiConnected = true;
      State.framesAnalyzed++;
      updateFooterLights(true);
    } else {
      // Demo / fallback mode
      injectDummyData();
    }
  } catch (err) {
    // Log the full error so you can debug API issues in the browser console
    console.error('[TreadGuard] API call failed — details below:');
    console.error('  Endpoint :', CONFIG.ROBOFLOW_ENDPOINT);
    console.error('  Error    :', err.message || err);
    console.warn('[TreadGuard] Falling back to demo data for this frame.');
    State.apiConnected = false;
    updateFooterLights(false);
    injectDummyData();
  }

  setScanBusy(false);
  document.getElementById('frameCounter').textContent = State.framesAnalyzed;
}

/* ─────────────────────────────────────────────────
   4. DUMMY DATA FALLBACK ENGINE
───────────────────────────────────────────────── */

/**
 * Generates realistic dummy detection data and feeds it
 * into the same processing pipeline as real API data.
 * This runs every 2s in demo mode to keep the UI alive.
 */
function injectDummyData() {
  // Each pothole gets a fresh confidence score every tick.
  // Some will be below the 50 % threshold (noise / trees) and won't be counted.
  const fakeDetections = POTHOLE_POSITIONS.map((pos, i) => ({
    x:          pos.x + (Math.random() - 0.5) * 8,
    y:          pos.y + (Math.random() - 0.5) * 6,
    width:      pos.width  + (Math.random() - 0.5) * 10,
    height:     pos.height + (Math.random() - 0.5) * 8,
    confidence: 0.36 + Math.random() * 0.62,  // 0.36 – 0.98 (may dip below 0.50)
    class: 'pothole',
    id: i,
  }));

  processDetectionData(fakeDetections.length, fakeDetections);
  State.framesAnalyzed++;
}

/**
 * Starts the repeating dummy data interval.
 */
function startDemoMode() {
  clearInterval(State.demoInterval);
  State.demoInterval = setInterval(() => {
    if (State.isDemoMode) injectDummyData();
  }, CONFIG.DUMMY_UPDATE_INTERVAL_MS);
}

/**
 * Stops the demo interval (when switching to live mode).
 */
function stopDemoMode() {
  clearInterval(State.demoInterval);
}

/* ─────────────────────────────────────────────────
   5. DETECTION DATA PROCESSOR & DOM UPDATERS
───────────────────────────────────────────────── */

/**
 * Central function: receives count + detections,
 * updates all derived state, then refreshes every widget.
 */
function processDetectionData(count, detections) {
  // 1. Bulletproof Confidence Filter
  const filtered = detections.filter(d => {
    const conf = d.confidence ?? 1;
    // If the API returns 80 instead of 0.80, convert it to a decimal
    const normalizedConf = conf > 1 ? conf / 100 : conf;
    return normalizedConf >= 0.50; // Strict 50% cutoff
  });
  const currentVisibleCount = filtered.length;

  // 2. The Tripwire Accumulator 
  // (Assuming model space is 360px high. Bottom 30% is y > 250)
  let newPotholesCrossedLine = 0;
  
  filtered.forEach(det => {
    // If the pothole's Y coordinate is at the bottom of the screen
    if (det.y > 250 && det.y < 300) {
      newPotholesCrossedLine++;
    }
  });

  // 3. Update the global state
  const prev = State.potholeCount;
  State.potholeCount = currentVisibleCount; 
  State.sessionTotal += newPotholesCrossedLine; // Actually accumulates now!
  State.detections = filtered;

  // 4. Update the Sparkline history
  State.sparklineHistory.push(currentVisibleCount);
  if (State.sparklineHistory.length > 10) State.sparklineHistory.shift();

  animateScanProgress();
  driftCoordinates();

  // 5. Update UI Widgets
  updatePotholeCounter(currentVisibleCount, prev);
  updateRepairCost(State.sessionTotal); // Cost is now based on TOTAL potholes driven over
  updateAbrasionIndex(currentVisibleCount);
  updateSkidRisk(currentVisibleCount);
  updateQualityScore(currentVisibleCount);
  updateHUD(currentVisibleCount);
  updateSparkline();
  renderDetectionBoxes(filtered);
}

/* ── Pothole Counter ── */
function updatePotholeCounter(count, prevCount) {
  const el = document.getElementById('potholeCount');
  const trend = document.getElementById('potholeTrend');
  const session = document.getElementById('sessionTotal');

  // Animate number
  animateNumber(el, prevCount, count, 400);

  // Trend indicator
  const diff = count - prevCount;
  if (diff > 0) {
    trend.textContent = `↑ +${diff}`;
    trend.style.color = 'var(--red)';
  } else if (diff < 0) {
    trend.textContent = `↓ ${diff}`;
    trend.style.color = 'var(--accent)';
  } else {
    trend.textContent = '— stable';
    trend.style.color = 'var(--text-muted)';
  }

  session.textContent = State.sessionTotal;
  flashCard('cardPotholes');
}

/* ── Repair Cost ── */
function updateRepairCost(count) {
  const cost = count * CONFIG.COST_PER_POTHOLE;
  const el = document.getElementById('repairCost');
  const fill = document.getElementById('costFill');
  const scale = document.getElementById('costScale');

  animateNumber(el, parseInt(el.textContent.replace(/,/g, '') || '0'), cost, 600, true);

  const pct = Math.min(100, (cost / CONFIG.MAX_COST_BAR) * 100);
  fill.style.width = `${pct}%`;
  scale.textContent = `₹0 — ₹${CONFIG.MAX_COST_BAR.toLocaleString('en-IN')}`;
}

/* ── Tire Abrasion Index ── */
function updateAbrasionIndex(count) {
  const badge  = document.getElementById('abrasionBadge');
  const text   = document.getElementById('abrasionText');
  const detail = document.getElementById('abrasionDetail');
  const seg0   = document.getElementById('seg0');
  const seg1   = document.getElementById('seg1');
  const seg2   = document.getElementById('seg2');

  // Reset segments
  [seg0, seg1, seg2].forEach(s => s.classList.remove('active'));

  if (count > CONFIG.ABRASION_CRITICAL_THRESHOLD) {
    badge.setAttribute('data-level', 'critical');
    text.textContent = 'CRITICAL';
    detail.textContent = 'DANGER: Severe microplastic shedding detected. Tire structural integrity compromised. Immediate inspection advised.';
    seg0.classList.add('active');
    seg1.classList.add('active');
    seg2.classList.add('active');
  } else if (count > CONFIG.ABRASION_MODERATE_THRESHOLD) {
    badge.setAttribute('data-level', 'moderate');
    text.textContent = 'MODERATE';
    detail.textContent = 'Elevated abrasion rate. Microplastic emission above safe threshold. Monitor tire tread depth.';
    seg0.classList.add('active');
    seg1.classList.add('active');
  } else {
    badge.setAttribute('data-level', 'low');
    text.textContent = 'LOW';
    detail.textContent = 'Microplastic emission risk is minimal. Road surface is within acceptable tolerance.';
    seg0.classList.add('active');
  }
}

/* ── Skid Risk ── */
function updateSkidRisk(count) {
  const badge = document.getElementById('skidBadge');
  const text  = document.getElementById('skidText');

  let level, label;
  if (count > CONFIG.ABRASION_CRITICAL_THRESHOLD) {
    level = 'hazardous'; label = 'HAZARDOUS';
  } else if (count > CONFIG.ABRASION_MODERATE_THRESHOLD) {
    level = 'caution'; label = 'CAUTION';
  } else {
    level = 'safe'; label = 'SAFE';
  }

  badge.setAttribute('data-level', level);
  text.textContent = label;
  drawSkidGauge(count);
}

/* ── Quality Score ── */
function updateQualityScore(count) {
  // Score = 100 - (count * 5), clamped to 0-100
  const score = Math.max(0, 100 - count * 5);
  const el    = document.getElementById('qualityScore');
  const grade = document.getElementById('qualityGrade');

  animateNumber(el, parseInt(el.textContent || '100'), score, 600);

  if (score >= 90)      { grade.textContent = 'A+'; grade.style.color = 'var(--accent)'; }
  else if (score >= 75) { grade.textContent = 'A';  grade.style.color = 'var(--accent)'; }
  else if (score >= 60) { grade.textContent = 'B';  grade.style.color = '#4ade80'; }
  else if (score >= 45) { grade.textContent = 'C';  grade.style.color = 'var(--amber)'; }
  else                  { grade.textContent = 'D';  grade.style.color = 'var(--red)'; }

  drawQualityRing(score);
}

/* ── HUD overlay data ── */
function updateHUD(count) {
  document.getElementById('hudDetCount').textContent = count;
  document.getElementById('hudDetectionBadge').style.borderColor =
    count > 12 ? 'rgba(239,68,68,0.5)' :
    count > 5  ? 'rgba(245,158,11,0.5)' :
                 'rgba(0,229,160,0.25)';

  document.getElementById('hudDetCount').style.color =
    count > 12 ? 'var(--red)' :
    count > 5  ? 'var(--amber)' :
                 'var(--accent)';

  // FPS counter (simulated)
  document.getElementById('hudFPS').textContent = `${22 + Math.floor(Math.random() * 8)} FPS`;

  // HUD timestamp
  document.getElementById('hudTimestamp').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
}

/* ── Sparkline ── */
function updateSparkline() {
  const container = document.getElementById('sparkline');
  const history   = State.sparklineHistory;
  const max       = Math.max(...history, 1);

  // Generate bars (first render creates, subsequent runs update)
  if (container.children.length !== 10) {
    container.innerHTML = '';
    for (let i = 0; i < 10; i++) {
      const bar = document.createElement('div');
      bar.className = 'sparkline-bar';
      container.appendChild(bar);
    }
  }

  Array.from(container.children).forEach((bar, i) => {
    const val = history[i] ?? 0;
    const pct = (val / max) * 100;
    bar.style.height = `${Math.max(4, pct)}%`;
    bar.classList.toggle('active', i === history.length - 1);
  });
}

/* ─────────────────────────────────────────────────
   5b. ROAD BACKGROUND RENDERER
   Draws a realistic asphalt scene with potholes
   onto the background canvas so demo mode shows
   an actual road rather than a blank placeholder.
───────────────────────────────────────────────── */
function drawRoadScene() {
  const canvas    = document.getElementById('roadBgCanvas');
  const container = document.getElementById('mediaContainer');
  if (!canvas || !container) return;

  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');

  /* ── Asphalt base ── */
  const roadGrad = ctx.createLinearGradient(0, 0, 0, H);
  roadGrad.addColorStop(0,   '#191919');
  roadGrad.addColorStop(0.45,'#222222');
  roadGrad.addColorStop(1,   '#1a1a1a');
  ctx.fillStyle = roadGrad;
  ctx.fillRect(0, 0, W, H);

  /* ── Asphalt texture — fine noise ── */
  for (let i = 0; i < 4000; i++) {
    const tx = Math.random() * W;
    const ty = Math.random() * H;
    const b  = 18 + Math.floor(Math.random() * 22);
    ctx.fillStyle = `rgba(${b},${b},${b},0.55)`;
    ctx.fillRect(tx, ty, 1, 1);
  }

  /* ── Aggregate pebble hints ── */
  for (let i = 0; i < 500; i++) {
    const tx = Math.random() * W;
    const ty = Math.random() * H;
    const r  = 1 + Math.random() * 1.8;
    const b  = 30 + Math.floor(Math.random() * 15);
    ctx.beginPath();
    ctx.arc(tx, ty, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${b},${b},${b},0.35)`;
    ctx.fill();
  }

  /* ── Yellow edge markings ── */
  const eW = Math.max(2.5, W * 0.006);
  const eX = W * 0.042;
  ctx.strokeStyle = '#d4aa20';
  ctx.lineWidth   = eW;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(eX, 0);       ctx.lineTo(eX, H);
  ctx.moveTo(W - eX, 0);   ctx.lineTo(W - eX, H);
  ctx.stroke();

  /* ── White dashed centre line ── */
  const dashH = H * 0.09;
  const gapH  = H * 0.07;
  ctx.strokeStyle = 'rgba(255,255,255,0.88)';
  ctx.lineWidth   = Math.max(2, W * 0.004);
  ctx.setLineDash([dashH, gapH]);
  ctx.lineDashOffset = 0;
  ctx.beginPath();
  ctx.moveTo(W / 2, -dashH);
  ctx.lineTo(W / 2, H + dashH);
  ctx.stroke();
  ctx.setLineDash([]);

  /* ── Faint secondary lane marks (¼ and ¾) ── */
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth   = Math.max(1, W * 0.002);
  ctx.setLineDash([dashH * 0.55, gapH * 1.8]);
  [W * 0.25, W * 0.75].forEach(lx => {
    ctx.beginPath();
    ctx.moveTo(lx, 0); ctx.lineTo(lx, H);
    ctx.stroke();
  });
  ctx.setLineDash([]);

  /* ── Potholes ── */
  const scaleX = W / 640;
  const scaleY = H / 360;

  POTHOLE_POSITIONS.forEach(p => {
    const cx = p.x * scaleX;
    const cy = p.y * scaleY;
    const rx = (p.width  / 2) * scaleX;
    const ry = (p.height / 2) * scaleY;

    // Drop-shadow for depth
    ctx.save();
    ctx.shadowColor   = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur    = 14;
    ctx.shadowOffsetY = 5;

    // Deep pit fill
    const pitGrad = ctx.createRadialGradient(
      cx - rx * 0.22, cy - ry * 0.22, 0,
      cx, cy, Math.max(rx, ry) * 1.05
    );
    pitGrad.addColorStop(0,    '#060606');
    pitGrad.addColorStop(0.55, '#0d0d0d');
    pitGrad.addColorStop(0.82, '#161616');
    pitGrad.addColorStop(1,    '#242424');
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = pitGrad;
    ctx.fill();
    ctx.restore();

    // Broken rim
    ctx.strokeStyle = '#3a3a3a';
    ctx.lineWidth   = Math.max(1.5, W * 0.003);
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx + 1.5, ry + 1.5, 0, 0, Math.PI * 2);
    ctx.stroke();

    // Top-rim light catch
    ctx.strokeStyle = 'rgba(110,110,110,0.35)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy - ry * 0.12, rx * 0.65, ry * 0.28, -0.3, Math.PI, Math.PI * 1.85);
    ctx.stroke();

    // Radiating crack lines
    const crackCount = 4 + Math.floor(cx * 0.003 + cy * 0.005) % 3; // deterministic variety
    for (let c = 0; c < crackCount; c++) {
      const baseAngle = (c / crackCount) * Math.PI * 2 + 0.25;
      const jitter    = (((cx * 7 + cy * 13 + c * 31) % 100) / 100 - 0.5) * 0.5;
      const angle     = baseAngle + jitter;
      const startR    = Math.max(rx, ry) * 0.88;
      const endR      = Math.max(rx, ry) * (1.25 + ((cx + c * 17) % 40) / 100);

      const x1 = cx + Math.cos(angle) * startR;
      const y1 = cy + Math.sin(angle) * startR * (ry / rx);
      const x2 = cx + Math.cos(angle + jitter * 0.4) * endR;
      const y2 = cy + Math.sin(angle + jitter * 0.4) * endR * (ry / rx);

      ctx.strokeStyle = 'rgba(55,55,55,0.75)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([2, 1.5]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Subtle waterlogging sheen inside pit
    const shineGrad = ctx.createLinearGradient(cx - rx * 0.5, cy - ry * 0.5, cx + rx * 0.3, cy + ry * 0.3);
    shineGrad.addColorStop(0, 'rgba(25,45,65,0.45)');
    shineGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.ellipse(cx - rx * 0.18, cy - ry * 0.18, rx * 0.48, ry * 0.38, -0.25, 0, Math.PI * 2);
    ctx.fillStyle = shineGrad;
    ctx.fill();
  });
}

/* ─────────────────────────────────────────────────
   5c. ANNOTATED FRAME RENDERER
   Draws Roboflow's pre-annotated output_image directly
   onto the HUD canvas, replacing manual bbox drawing.
───────────────────────────────────────────────── */
function drawAnnotatedFrame(base64) {
  const canvas    = document.getElementById('hudCanvas');
  const container = document.getElementById('mediaContainer');
  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw the annotated frame scaled to fill the HUD canvas
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = 'data:image/jpeg;base64,' + base64;
}

/* ─────────────────────────────────────────────────
   5c. ANNOTATED FRAME RENDERER
   Displays Roboflow's pre-annotated output_image
   (bounding boxes already drawn by the workflow)
   directly on the HUD canvas.
───────────────────────────────────────────────── */
function drawAnnotatedFrame(base64) {
  const canvas    = document.getElementById('hudCanvas');
  const container = document.getElementById('mediaContainer');
  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  };
  img.src = 'data:image/jpeg;base64,' + base64;
}

/* ─────────────────────────────────────────────────
   6. CANVAS HUD — BOUNDING BOX RENDERER
───────────────────────────────────────────────── */
function renderDetectionBoxes(detections) {
  const canvas    = document.getElementById('hudCanvas');
  const container = document.getElementById('mediaContainer');
  const ctx       = canvas.getContext('2d');

  // Sync canvas size to container
  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!detections || detections.length === 0) return;

  // Scale from "model space" (640x360 assumed) to actual canvas size
  const scaleX = canvas.width  / 640;
  const scaleY = canvas.height / 360;

  detections.forEach((det, i) => {
    const x = (det.x - det.width / 2)  * scaleX;
    const y = (det.y - det.height / 2) * scaleY;
    const w = det.width  * scaleX;
    const h = det.height * scaleY;

    const conf = det.confidence ?? 0.85;

    // Choose color by confidence
    const color = conf > 0.85 ? '#ef4444' :
                  conf > 0.70 ? '#f59e0b' : '#00e5a0';

    ctx.save();

    // Glow shadow
    ctx.shadowColor  = color;
    ctx.shadowBlur   = 10;

    // Box
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(x, y, w, h);

    // Corner accents
    const cSize = 8;
    ctx.lineWidth = 2.5;
    [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy], ci) => {
      ctx.beginPath();
      const dx = ci % 2 === 0 ? 1 : -1;
      const dy = ci < 2  ? 1 : -1;
      ctx.moveTo(cx + dx * cSize, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * cSize);
      ctx.stroke();
    });

    // Label background
    ctx.shadowBlur = 0;
    const label = `#${i+1} ${(conf * 100).toFixed(0)}%`;
    ctx.font = '600 9px "Space Mono", monospace';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = color + 'cc';
    ctx.fillRect(x, y - 16, tw + 10, 16);

    // Label text
    ctx.fillStyle = '#000';
    ctx.fillText(label, x + 5, y - 4);

    ctx.restore();
  });
}

/* ─────────────────────────────────────────────────
   7. Z-AXIS SENSOR — DeviceMotion API
───────────────────────────────────────────────── */
function initZAxisSensor() {
  const zValueEl   = document.getElementById('zAxisValue');
  const zSignEl    = document.getElementById('zAxisSign');
  const zPeakEl    = document.getElementById('zPeak');
  const zAvgEl     = document.getElementById('zAvg');
  const zEventsEl  = document.getElementById('zEvents');
  const sensorDot  = document.querySelector('.sensor-dot');
  const sensorText = document.getElementById('sensorStatusText');
  const flSensor   = document.getElementById('flSensor');

  // iOS 13+ requires permission
  const requestPermission = () => {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission()
        .then(resp => {
          if (resp === 'granted') attachListener();
          else setSensorError('Permission denied by user.');
        })
        .catch(() => setSensorError('Permission request failed.'));
    } else {
      attachListener();
    }
  };

  function attachListener() {
    window.addEventListener('devicemotion', (event) => {
      const z = event.accelerationIncludingGravity?.z;
      if (z === null || z === undefined) {
        setSensorError('Sensor data unavailable on this device.');
        return;
      }

      const gz = parseFloat((z / 9.81).toFixed(3)); // Convert m/s² → G

      // Update state
      State.zAxis.current = gz;
      State.zAxis.history.push(gz);
      if (State.zAxis.history.length > CONFIG.ZBAR_COUNT) State.zAxis.history.shift();

      State.zAxis.readings.push(Math.abs(gz));
      if (State.zAxis.readings.length > 60) State.zAxis.readings.shift();

      if (Math.abs(gz) > Math.abs(State.zAxis.peak)) State.zAxis.peak = gz;
      if (Math.abs(gz) > 0.5) State.zAxis.events++;

      // Update roughness history for graph
      State.roughnessHistory.push(Math.abs(gz));
      if (State.roughnessHistory.length > CONFIG.GRAPH_HISTORY_POINTS) {
        State.roughnessHistory.shift();
      }

      // DOM updates
      const absGz = Math.abs(gz);
      zValueEl.textContent = absGz.toFixed(2);
      zSignEl.textContent  = gz >= 0 ? '+' : '−';

      // Color coding
      if (absGz > 0.8) {
        zValueEl.style.color = 'var(--red)';
        zValueEl.style.textShadow = '0 0 20px rgba(239,68,68,0.6)';
      } else if (absGz > 0.4) {
        zValueEl.style.color = 'var(--amber)';
        zValueEl.style.textShadow = '0 0 20px rgba(245,158,11,0.5)';
      } else {
        zValueEl.style.color = 'var(--accent)';
        zValueEl.style.textShadow = '0 0 20px var(--accent-glow)';
      }

      // Stats
      const avg = State.zAxis.readings.reduce((a,b) => a + b, 0) / State.zAxis.readings.length;
      zPeakEl.textContent   = `${Math.abs(State.zAxis.peak).toFixed(2)}G`;
      zAvgEl.textContent    = `${avg.toFixed(2)}G`;
      zEventsEl.textContent = State.zAxis.events;

      // Update bar visualizer
      updateZAxisBars(State.zAxis.history);

      // Update waveform graph
      drawRoughnessGraph(State.roughnessHistory);

      // Sensor status
      sensorDot.className = 'sensor-dot sensor-dot--active';
      sensorText.textContent = 'Accelerometer active — live readings';
      flSensor.style.background = 'var(--accent)';
    }, { passive: true });

    sensorDot.className = 'sensor-dot sensor-dot--warn';
    sensorText.textContent = 'Waiting for motion event…';
  }

  function setSensorError(msg) {
    sensorDot.className = 'sensor-dot sensor-dot--error';
    sensorText.textContent = msg;
    flSensor.style.background = 'var(--red)';
    // Fall back to simulated Z data in demo mode
    startSimulatedZAxis();
  }

  // Kick off permission request
  requestPermission();

  // On desktop/no sensor: always start simulation too as backup after 2s
  setTimeout(() => {
    if (State.zAxis.readings.length === 0) {
      sensorText.textContent = 'No sensor detected — simulating roughness data';
      startSimulatedZAxis();
    }
  }, 2000);
}

/**
 * Simulates Z-axis data for desktop/demo environments
 * where DeviceMotion is not available.
 */
function startSimulatedZAxis() {
  const sensorDot  = document.querySelector('.sensor-dot');
  const sensorText = document.getElementById('sensorStatusText');

  sensorDot.className = 'sensor-dot sensor-dot--warn';
  sensorText.textContent = 'Simulated sensor data (desktop mode)';

  let t = 0;
  setInterval(() => {
    // Composite wave: smooth road with occasional bumps
    const base    = Math.sin(t * 0.15) * 0.08;
    const bump    = Math.random() < 0.08 ? (Math.random() * 1.2 - 0.3) : 0;
    const noise   = (Math.random() - 0.5) * 0.05;
    const gz      = parseFloat((base + bump + noise).toFixed(3));

    const absGz   = Math.abs(gz);
    State.zAxis.current = gz;
    State.zAxis.history.push(gz);
    if (State.zAxis.history.length > CONFIG.ZBAR_COUNT) State.zAxis.history.shift();

    State.zAxis.readings.push(absGz);
    if (State.zAxis.readings.length > 60) State.zAxis.readings.shift();
    if (absGz > Math.abs(State.zAxis.peak)) State.zAxis.peak = gz;
    if (absGz > 0.5) State.zAxis.events++;

    State.roughnessHistory.push(absGz);
    if (State.roughnessHistory.length > CONFIG.GRAPH_HISTORY_POINTS) State.roughnessHistory.shift();

    // DOM
    document.getElementById('zAxisValue').textContent = absGz.toFixed(2);
    document.getElementById('zAxisSign').textContent  = gz >= 0 ? '+' : '−';

    const zEl = document.getElementById('zAxisValue');
    if (absGz > 0.8) {
      zEl.style.color = 'var(--red)';
      zEl.style.textShadow = '0 0 20px rgba(239,68,68,0.6)';
    } else if (absGz > 0.4) {
      zEl.style.color = 'var(--amber)';
      zEl.style.textShadow = '0 0 20px rgba(245,158,11,0.5)';
    } else {
      zEl.style.color = 'var(--accent)';
      zEl.style.textShadow = '0 0 20px var(--accent-glow)';
    }

    const avg = State.zAxis.readings.reduce((a,b)=>a+b,0) / State.zAxis.readings.length;
    document.getElementById('zPeak').textContent   = `${Math.abs(State.zAxis.peak).toFixed(2)}G`;
    document.getElementById('zAvg').textContent    = `${avg.toFixed(2)}G`;
    document.getElementById('zEvents').textContent = State.zAxis.events;

    updateZAxisBars(State.zAxis.history);
    drawRoughnessGraph(State.roughnessHistory);

    t++;
  }, 120);
}

/* ── Z-Axis bar chart ── */
function buildZAxisBars() {
  const container = document.getElementById('zAxisBars');
  container.innerHTML = '';
  for (let i = 0; i < CONFIG.ZBAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'zbar';
    container.appendChild(bar);
  }
}

function updateZAxisBars(history) {
  const bars = document.querySelectorAll('.zbar');
  const max  = 1.2; // Max G for scaling
  bars.forEach((bar, i) => {
    const val    = Math.abs(history[i] ?? 0);
    const pct    = Math.min(100, (val / max) * 100);
    bar.style.height = `${Math.max(4, pct)}%`;

    bar.className = 'zbar';
    if (val > 0.8) bar.classList.add('critical-spike');
    else if (val > 0.4) bar.classList.add('high-spike');
    else if (val > 0.15) bar.classList.add('spike');
  });
}

/* ─────────────────────────────────────────────────
   8. ROUGHNESS WAVEFORM GRAPH (Canvas)
───────────────────────────────────────────────── */
function drawRoughnessGraph(data) {
  const canvas = document.getElementById('roughnessGraph');
  if (!canvas) return;

  const W   = canvas.offsetWidth;
  const H   = canvas.offsetHeight;
  canvas.width  = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.04)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = (i / 4) * H;
    ctx.beginPath();
    ctx.moveTo(0, y); ctx.lineTo(W, y);
    ctx.stroke();
  }

  if (data.length < 2) return;

  const max = 1.2;
  const stepX = W / (data.length - 1);

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0,229,160,0.3)');
  grad.addColorStop(1, 'rgba(0,229,160,0)');

  // Draw filled area
  ctx.beginPath();
  data.forEach((val, i) => {
    const x = i * stepX;
    const y = H - (Math.min(val, max) / max) * H * 0.92;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo((data.length - 1) * stepX, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  ctx.strokeStyle = 'var(--accent)';
  ctx.lineWidth   = 1.5;
  ctx.shadowColor = 'var(--accent)';
  ctx.shadowBlur  = 4;
  data.forEach((val, i) => {
    const x = i * stepX;
    const y = H - (Math.min(val, max) / max) * H * 0.92;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Threshold line at 0.5G
  const threshY = H - (0.5 / max) * H * 0.92;
  ctx.strokeStyle = 'rgba(245,158,11,0.3)';
  ctx.lineWidth   = 1;
  ctx.shadowBlur  = 0;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, threshY); ctx.lineTo(W, threshY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Threshold label
  ctx.font      = '7px "Space Mono", monospace';
  ctx.fillStyle = 'rgba(245,158,11,0.5)';
  ctx.fillText('0.5G THRESHOLD', 4, threshY - 3);
}

/* ─────────────────────────────────────────────────
   9. SKID GAUGE (Canvas arc)
───────────────────────────────────────────────── */
function drawSkidGauge(count) {
  const canvas = document.getElementById('skidGauge');
  if (!canvas) return;

  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H - 10;
  const r  = Math.min(W, H * 2) / 2 - 12;

  const startAngle = Math.PI;
  const endAngle   = 2 * Math.PI;
  const totalArc   = Math.PI;

  // Background track
  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = 10;
  ctx.lineCap     = 'round';
  ctx.stroke();

  // Color zones (safe, caution, hazard)
  const zones = [
    { from: 0,    to: 0.33, color: '#00e5a0' },
    { from: 0.33, to: 0.66, color: '#f59e0b' },
    { from: 0.66, to: 1.0,  color: '#ef4444' },
  ];
  zones.forEach(z => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, startAngle + z.from * totalArc, startAngle + z.to * totalArc);
    ctx.strokeStyle = z.color + '55';
    ctx.lineWidth   = 10;
    ctx.lineCap     = 'butt';
    ctx.stroke();
  });

  // Active needle value (count mapped 0-20 → 0-1)
  const value   = Math.min(1, count / 20);
  const fillEnd = startAngle + value * totalArc;

  const fillColor = value > 0.66 ? '#ef4444' :
                    value > 0.33 ? '#f59e0b' : '#00e5a0';

  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, fillEnd);
  ctx.strokeStyle = fillColor;
  ctx.lineWidth   = 10;
  ctx.lineCap     = 'round';
  ctx.shadowColor = fillColor;
  ctx.shadowBlur  = 10;
  ctx.stroke();
  ctx.shadowBlur  = 0;

  // Needle dot
  const needleAngle = startAngle + value * totalArc;
  const nx = cx + (r) * Math.cos(needleAngle);
  const ny = cy + (r) * Math.sin(needleAngle);
  ctx.beginPath();
  ctx.arc(nx, ny, 5, 0, Math.PI * 2);
  ctx.fillStyle   = fillColor;
  ctx.shadowColor = fillColor;
  ctx.shadowBlur  = 8;
  ctx.fill();
  ctx.shadowBlur  = 0;

  // Center label: percentage
  ctx.font      = 'bold 11px "Space Mono", monospace';
  ctx.fillStyle = fillColor;
  ctx.textAlign = 'center';
  ctx.fillText(`${Math.round(value * 100)}%`, cx, cy - 8);
  ctx.font      = '7px "Space Mono", monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText('RISK', cx, cy + 4);
}

/* ─────────────────────────────────────────────────
   10. QUALITY RING (Canvas donut)
───────────────────────────────────────────────── */
function drawQualityRing(score) {
  const canvas = document.getElementById('qualityRing');
  if (!canvas) return;

  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const cx = W / 2;
  const cy = H / 2;
  const r  = Math.min(W, H) / 2 - 8;
  const lw = 8;
  const pct = score / 100;

  // Background ring
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = lw;
  ctx.stroke();

  // Score arc
  const color = score >= 75 ? '#00e5a0' :
                score >= 45 ? '#f59e0b' : '#ef4444';

  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + pct * Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth   = lw;
  ctx.lineCap     = 'round';
  ctx.shadowColor = color;
  ctx.shadowBlur  = 10;
  ctx.stroke();
  ctx.shadowBlur  = 0;
}

/* ─────────────────────────────────────────────────
   HELPERS
───────────────────────────────────────────────── */

/**
 * Smoothly animates a numeric DOM element from `from` to `to`.
 * If `currency` is true, formats with Indian locale commas.
 */
function animateNumber(el, from, to, duration = 400, currency = false) {
  const start   = performance.now();
  const diff    = to - from;
  const easeOut = t => 1 - Math.pow(1 - t, 3);

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const current  = Math.round(from + diff * easeOut(progress));
    el.textContent = currency
      ? current.toLocaleString('en-IN')
      : String(current).padStart(2, '0');

    el.classList.add('count-animate');
    setTimeout(() => el.classList.remove('count-animate'), 250);

    if (progress < 1) requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

/** Flash a card's background briefly to indicate data update */
function flashCard(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('card-flash');
  void el.offsetWidth; // force reflow
  el.classList.add('card-flash');
}

/** Animate the scan progress bar */
function animateScanProgress() {
  const fill = document.getElementById('scanProgress');
  // Quick sweep: 0 → random 70-100% → back to 0
  fill.style.width = '0%';
  setTimeout(() => {
    fill.style.width = `${70 + Math.random() * 30}%`;
  }, 50);
  setTimeout(() => {
    fill.style.width = '100%';
  }, 600);
  setTimeout(() => {
    fill.style.width = '0%';
  }, 1000);
}

/** Slightly drift GPS coordinates for realism */
function driftCoordinates() {
  const latBase = 18.5204, lngBase = 73.8567;
  const lat = (latBase + (Math.random() - 0.5) * 0.002).toFixed(4);
  const lng = (lngBase + (Math.random() - 0.5) * 0.002).toFixed(4);
  document.getElementById('hudLat').textContent = `LAT ${lat}°N`;
  document.getElementById('hudLng').textContent  = `LNG ${lng}°E`;
}

/** Toggle the scan status indicator */
function setScanBusy(busy) {
  const el = document.getElementById('scanStatusText');
  el.textContent = busy ? 'SCANNING FRAME…' : 'FRAME PROCESSED ✓';
  if (!busy) setTimeout(() => { el.textContent = 'SCANNING FRAME…'; }, 800);
}

/** Update the footer indicator lights */
function updateFooterLights(apiOk) {
  const flApi = document.getElementById('flApi');
  flApi.style.background = apiOk ? 'var(--accent)' : 'var(--red)';
}

/* ─────────────────────────────────────────────────
   11. UPLOAD HANDLER
───────────────────────────────────────────────── */
function initUploadHandler() {
  const input   = document.getElementById('footageUpload');
  const video   = document.getElementById('roadVideo');
  const modal   = document.getElementById('uploadModal');
  const desc    = document.getElementById('modalDesc');
  const confirm = document.getElementById('modalConfirm');
  const close   = document.getElementById('modalClose');

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith('video/');

    if (isVideo) {
      video.src = url;
      video.load();
      video.pause();   // Stay paused — play only when user confirms the modal
    } else {
      // Image: use as poster
      video.poster = url;
      video.src    = '';
    }

    desc.textContent = `"${file.name}" loaded (${(file.size / 1e6).toFixed(1)} MB). Ready for analysis.`;
    modal.hidden = false;
  });

  confirm.addEventListener('click', () => {
    modal.hidden = true;

    const analyzeBtn = document.getElementById('analyzeBtn');
    const isVideoLoaded = video.src && video.src !== window.location.href && video.readyState >= 1;

    if (isVideoLoaded) {
      // Ensure the video is playing so frame capture works
      video.play().catch(() => {});
      // Give the video 300ms to start, then kick the scan loop
      setTimeout(() => analyzeBtn.click(), 300);
    } else {
      // Image or fallback: single analysis pass
      runAnalysis();
    }
  });

  close.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });
}

/* ─────────────────────────────────────────────────
   12. UI CONTROLS, SESSION CLOCK, DEMO TOGGLE
───────────────────────────────────────────────── */
function initControls() {
  /* ── Auto-Analyze Loop ── */
  let scanInterval = null;
  let isScanning = false;
  
  const analyzeBtn = document.getElementById('analyzeBtn');
  const video      = document.getElementById('roadVideo');

  // ── Helper: cleanly stop the scan loop ───────────────────────────────
  function stopScanning() {
    isScanning = false;
    clearInterval(scanInterval);
    scanInterval = null;
    analyzeBtn.innerHTML = 'Start Auto-Scan';
    analyzeBtn.style.background = 'var(--bg-card)';
    analyzeBtn.style.color = 'var(--text-secondary)';
  }

  // ── Auto-stop when the video finishes playing ─────────────────────────
  video.addEventListener('ended', () => {
    if (isScanning) {
      stopScanning();
      document.getElementById('scanStatusText').textContent = 'VIDEO ENDED ✓';
      console.log('[TreadGuard] Video ended — scan loop stopped automatically.');
    }
  });

  analyzeBtn.addEventListener('click', (e) => {
    isScanning = !isScanning;

    if (isScanning) {
      e.target.innerHTML = 'Stop Scanning';
      e.target.style.background = 'var(--red)';
      e.target.style.color = '#fff';

      // Run once immediately, then every 1 second
      runAnalysis();
      scanInterval = setInterval(() => {
        runAnalysis();
      }, 1000);
    } else {
      stopScanning();
    }
  });

  /* ── Reset Button ── */
  document.getElementById('resetBtn').addEventListener('click', () => {
    State.potholeCount   = 0;
    State.sessionTotal   = 0;
    State.framesAnalyzed = 0;
    State.sparklineHistory = [];
    State.zAxis.peak     = 0;
    State.zAxis.events   = 0;
    State.zAxis.readings = [];
    State.roughnessHistory = new Array(CONFIG.GRAPH_HISTORY_POINTS).fill(0);

    processDetectionData(0, []);
    document.getElementById('frameCounter').textContent = '0';
    document.getElementById('zPeak').textContent   = '0.00G';
    document.getElementById('zAvg').textContent    = '0.00G';
    document.getElementById('zEvents').textContent = '0';
  });

  /* ── Demo / Live Toggle ── */
  const demoToggle  = document.getElementById('demoToggle');
  const toggleThumb = document.getElementById('toggleThumb');
  const toggleTrack = demoToggle.querySelector('.toggle-track');
  const statusPill  = document.getElementById('statusPill');
  const statusLabel = document.getElementById('statusLabel');

  // Start in demo mode by default
  setDemoMode(false);

  demoToggle.addEventListener('click', () => {
    State.isDemoMode = !State.isDemoMode;
    setDemoMode(State.isDemoMode);
  });

  function setDemoMode(isDemo) {
    State.isDemoMode = isDemo;

    toggleThumb.classList.toggle('active', isDemo);
    toggleTrack.classList.toggle('active', isDemo);

    if (isDemo) {
      statusPill.setAttribute('data-mode', 'demo');
      statusLabel.textContent = 'Demo Mode';
      startDemoMode();
    } else {
      statusPill.removeAttribute('data-mode');
      statusLabel.textContent = 'API Live';
      stopDemoMode();
    }
  }
}

/** Session clock ticker */
function startSessionClock() {
  const el = document.getElementById('sessionClock');
  setInterval(() => {
    const elapsed = Math.floor((Date.now() - State.sessionStartTime) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    el.textContent = `${h}:${m}:${s}`;
  }, 1000);
}

/* ─────────────────────────────────────────────────
   13. INITIALIZER
───────────────────────────────────────────────── */

/**
 * Draws a clean dark placeholder on the road background canvas.
 * Shown before any footage is uploaded — replaces the fake road/lines.
 */
function drawPlaceholder() {
  const canvas    = document.getElementById('roadBgCanvas');
  const container = document.getElementById('mediaContainer');
  if (!canvas || !container) return;

  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');

  // Dark background
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);

  // Subtle grid
  ctx.strokeStyle = 'rgba(0,229,160,0.04)';
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < W; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Centre upload icon (arrow-up in a circle)
  const cx = W / 2, cy = H / 2 - 18;
  const r = 36;
  ctx.strokeStyle = 'rgba(0,229,160,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Arrow up
  ctx.strokeStyle = 'rgba(0,229,160,0.55)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy + 14); ctx.lineTo(cx, cy - 14);          // stem
  ctx.moveTo(cx - 10, cy - 4); ctx.lineTo(cx, cy - 14);      // left wing
  ctx.moveTo(cx + 10, cy - 4); ctx.lineTo(cx, cy - 14);      // right wing
  ctx.stroke();

  // Label
  ctx.font = '600 11px "Space Mono", monospace';
  ctx.fillStyle = 'rgba(0,229,160,0.35)';
  ctx.textAlign = 'center';
  ctx.fillText('UPLOAD FOOTAGE TO BEGIN', cx, cy + r + 22);

  ctx.textAlign = 'left'; // reset
}

function init() {
  console.log('%c[TreadGuard CV] Initializing…', 'color:#00e5a0; font-weight:bold;');

  // Draw placeholder until footage is uploaded
  drawPlaceholder();

  // Build Z-axis bar visualizer DOM
  buildZAxisBars();

  // Draw initial empty charts
  drawQualityRing(100);
  drawSkidGauge(0);
  drawRoughnessGraph(State.roughnessHistory);

  // Wire up upload handler
  initUploadHandler();

  // Wire up buttons + demo toggle
  initControls();

  // Start session clock
  startSessionClock();

  // Start Z-axis sensor (real or simulated)
  initZAxisSensor();

  // Resize canvas on window resize
  window.addEventListener('resize', () => {
    const vid = document.getElementById('roadVideo');
    const hasVideo = vid.src && vid.readyState >= 1;
    if (hasVideo) drawRoadScene(); else drawPlaceholder();
    renderDetectionBoxes(State.detections);
    drawRoughnessGraph(State.roughnessHistory);
  });

  // Warm-up animation: feed initial zero state
  processDetectionData(0, []);

  // Short boot delay then let demo run
  setTimeout(() => {
    if (State.isDemoMode) {
      injectDummyData(); // First tick immediately
    }
  }, 600);

  console.log('%c[TreadGuard CV] Ready ✓', 'color:#00e5a0; font-weight:bold;');
}

// Boot when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
