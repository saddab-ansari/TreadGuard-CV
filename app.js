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

  // ── Road width for pixel→metre calibration ─────────────────────────────
  // Standard Indian single lane = 3.5m (IRC:86). User can override via UI.
  ROAD_WIDTH_METRES: 4.5,

  // ── PWD-based repair rates (₹/m²) ───────────────────────────────────────
  // Source: PWD Schedule of Rates — ₹573.33/m² base (materials+labour+royalty)
  // Small patches cost more per m² due to fixed mobilization overhead.
  REPAIR_RATE_SMALL:  900,    // < 0.1 m²  (micro patch)
  REPAIR_RATE_MEDIUM: 700,    // 0.1–0.5 m² (standard patch)
  REPAIR_RATE_LARGE:  573,    // > 0.5 m²  (PWD base rate)
  REPAIR_MOBILIZATION: 500,   // ₹ flat call-out per pothole (labour fixed cost)

  COST_PER_POTHOLE: 2500,           // INR (kept as fallback only)
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
  totalRepairCost: 0,         // Cumulative area-based repair cost (₹)
  framesAnalyzed: 0,
  detections: [],            // Raw detection boxes from API/demo
  sparklineHistory: [],      // Last N pothole counts for sparkline
  roadWidthMetres: 3.5,      // Calibration: real road width (default 1 lane = 3.5m)

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
  rollingCounts: [],        // Last 5 frame counts for smoothed skid/quality
  rollingAreaSeverity: [],  // Last 5 frame area-severity scores (replaces count for scoring)
  // NEW: Cumulative trackers for the overall PDF report
  cumulativeAreaSeverity: 0, 
  totalFramesWithSeverity: 0,
  severityHistory: [], // Stores every frame's severity for the report graph
  lastAnalyzedVideoTime: -1, // video.currentTime at last API call — prevents duplicate frames

// ── GPS & Detection Log ──────────────────────────────────────────────────
  gps: { lat: 12.9716, lng: 77.5946, simulated: true }, // Bangalore fallback until real GPS arrives
  detectionLog: [],   // { timestamp, lat, lng, count, repairCost } — capped at 50 entries
  
  // ── Telemetry / CSV Data ─────────────────────────────────────────────────
  hasZAxisData: true,
  isLiveSensorActive: false,
  csvZData: [],
  
  // ── Manual Validation ────────────────────────────────────────────────────
  validationFrames: [],
  validatedPotholesCount: 0,
  validatedRepairCost: 0,
  
  // ── Tire Wear Predictive Data ──
  currentTWP: 0,
};

function captureCurrentFrame() {
  const video = document.getElementById('roadVideo');
  const offscreen = document.createElement('canvas');
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 360;
  offscreen.width = w;
  offscreen.height = h;
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  
  return {
    base64: offscreen.toDataURL('image/jpeg', 0.8).split(',')[1],
    width: w,
    height: h
  };
}

/* ─────────────────────────────────────────────────
   3. API INTEGRATION — Roboflow
───────────────────────────────────────────────── */

/**
 * Captures the current video frame into a Base64 image
 * and sends it to the Roboflow inference API.
 * Returns the parsed JSON response or throws on failure.
 */

async function analyzeFrame() {
  const frameObj = captureCurrentFrame();

  const response = await fetch(CONFIG.ROBOFLOW_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: frameObj.base64 })
  });

  if (!response.ok) {
    throw new Error(`Roboflow Workflow error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return { data, frameObj };
}

/**
 * Wrapper that tries the live API and falls back to dummy data.
 * Updates State.apiConnected accordingly.
 */
async function runAnalysis() {
  // ── Timestamp-based skip: only analyze if video has moved ≥0.8s since last scan ──
  // Prevents the same frozen / slow frame from being counted twice in a row.
  const video = document.getElementById('roadVideo');
  if (video && video.readyState >= 2) {
    const timeSinceLast = video.currentTime - State.lastAnalyzedVideoTime;
    if (timeSinceLast < 0.8) {
      console.log(`[TreadGuard] ⏭ Skipping — video only moved ${timeSinceLast.toFixed(2)}s (need ≥0.8s)`);
      return;  // not enough new footage yet
    }
    State.lastAnalyzedVideoTime = video.currentTime;
  }

  setScanBusy(true);

  try {
    if (!State.isDemoMode) {
      const result = await analyzeFrame();
      const data = result.data;
      const base64Image = result.frameObj.base64;
      const imgW = result.frameObj.width;
      const imgH = result.frameObj.height;

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

      processDetectionData(count, predictions, base64Image, imgW, imgH);
      State.apiConnected = true;
      State.framesAnalyzed++;
      updateFooterLights(true);

      // ── Sync CSV Data with Video Playback ──
      // Pulls the correct G-Force reading based on exactly how far along the video is!
      if (State.csvZData.length > 0) {
        const vid = document.getElementById('roadVideo');
        if (vid && vid.duration) {
          const progress = vid.currentTime / vid.duration;
          const index = Math.min(Math.floor(progress * State.csvZData.length), State.csvZData.length - 1);
          processZAxisReading(State.csvZData[index]);
        }
      }

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
  
  const frameObj = captureCurrentFrame();
  processDetectionData(fakeDetections.length, fakeDetections, frameObj.base64, frameObj.width, frameObj.height);
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

function processDetectionData(count, detections, base64Image = null, imgW = 640, imgH = 360) {
  // 1. Bulletproof Confidence & Size Filter
  const filtered = detections.filter(d => {
    const conf = d.confidence ?? 1;
    const normalizedConf = conf > 1 ? conf / 100 : conf;
    
    // Model space is 640px wide by 360px tall.
    // If a bounding box covers more than 60% of the width or height, it's a false positive.
    const isTooWide = d.width > (640 * 0.60);
    const isTooTall = d.height > (360 * 0.60);

    // Strict threshold: > 65% confidence AND box must be a realistic size
    return normalizedConf >= 0.65 && !isTooWide && !isTooTall; 
  });

  // NEW: Save frame for human validation (capped at 30 to save RAM)
  if (filtered.length > 0 && base64Image) {
    State.validationFrames.push({
      id: Date.now() + Math.random(),
      image: base64Image,
      width: imgW,
      height: imgH,
      predictions: JSON.parse(JSON.stringify(filtered)) // Deep copy
    });
    if (State.validationFrames.length > 30) State.validationFrames.shift();
  }

  const currentVisibleCount = filtered.length;

  // 2. The Tripwire Accumulator 
// 2. The Dynamic Physics Tripwire (with Cooldown)
  // Expands the zone to the entire bottom half (y > 180) so fast potholes aren't skipped.
  // Uses a 1200ms cooldown to prevent double-counting the same pothole across frames.
  let newPotholesCrossedLine = 0;
  const now = Date.now();

  if (now - (State.lastTripwireTime || 0) > 1200) {
    const potholesInZone = filtered.filter(det => det.y > 180);
    if (potholesInZone.length > 0) {
      newPotholesCrossedLine = potholesInZone.length;
      State.lastTripwireTime = now;
    }
  }

  // 3. Update the global state
  const prev = State.potholeCount;
  State.potholeCount = currentVisibleCount; 
  State.sessionTotal += newPotholesCrossedLine; // Actually accumulates now!
  State.detections = filtered;

  // 4. Update Sparkline + rolling average (last 5 frames)
  State.sparklineHistory.push(currentVisibleCount);
  if (State.sparklineHistory.length > 10) State.sparklineHistory.shift();

  State.rollingCounts.push(currentVisibleCount);
  if (State.rollingCounts.length > 5) State.rollingCounts.shift();
  const rollingAvg = Math.round(
    State.rollingCounts.reduce((a, b) => a + b, 0) / State.rollingCounts.length
  );

  animateScanProgress();
  driftCoordinates();

  // 5. Calculate area-based repair cost for this frame's detections
  //    calculateFrameCost() enriches each det with ._metrics (areaSqM, sizeLabel, cost)
  const frameCost = calculateFrameCost(filtered);
  // Accumulate cost only when new potholes cross the tripwire line
  State.totalRepairCost += newPotholesCrossedLine > 0
    ? frameCost * (newPotholesCrossedLine / Math.max(1, filtered.length))
    : 0;

  // 5b. Area-severity score for THIS frame
  const frameAreaSqM = filtered.reduce((sum, d) => sum + (d._metrics?.areaSqM ?? 0), 0);
  const frameAreaSeverity = frameAreaSqM * 20;

  // Track every frame for the PDF timeline graph
  State.severityHistory.push(frameAreaSeverity);

  // A. REAL-TIME DASHBOARD MATH (Fast 3-Frame Rolling Average)
  State.rollingAreaSeverity.push(frameAreaSeverity);
  if (State.rollingAreaSeverity.length > 3) State.rollingAreaSeverity.shift(); // Tightened to 3 frames
  const rollingSeverity = State.rollingAreaSeverity.reduce((a, b) => a + b, 0) / State.rollingAreaSeverity.length;
  
  // B. OVERALL SESSION MATH (Cumulative for PDF Report)
  State.cumulativeAreaSeverity += frameAreaSeverity;
  State.totalFramesWithSeverity++;

  // 🛑 THE GHOSTING FIX (For the dashboard UI only)
  const displaySeverity = currentVisibleCount === 0 ? 0 : rollingSeverity;

// 6. Log detection with current GPS for mini-map AND Report Table
  // ONLY log if the pothole officially crossed the tripwire and was billed!
  if (newPotholesCrossedLine > 0) {
    State.detectionLog.push({
      timestamp:  Date.now(),
      lat:        State.gps.lat,
      lng:        State.gps.lng,
      count:      newPotholesCrossedLine,
      repairCost: Math.round(frameCost * (newPotholesCrossedLine / Math.max(1, filtered.length))),
    });
    if (State.detectionLog.length > 50) State.detectionLog.shift();
  }

  // 7. Update UI Widgets
  updatePotholeCounter(currentVisibleCount, prev);
  updateRepairCost(Math.round(State.totalRepairCost));
  // Skid, abrasion, quality now driven by area-severity (not raw count)
  // so a single huge pothole scores worse than three tiny ones
  updateAbrasionIndex(rollingSeverity);
  updateSkidRisk(rollingSeverity);
  updateQualityScore(rollingSeverity);
  updateHUD(currentVisibleCount);
  updateSparkline();
  renderDetectionBoxes(filtered);
  drawMiniMap();
}

/* ─────────────────────────────────────────────────
   AREA-BASED COST ENGINE
   Converts pixel bboxes → real m² → PWD repair cost
───────────────────────────────────────────────── */

/**
 * For a single detection bbox (in Roboflow model space, 640px wide),
 * returns { areaSqM, sizeLabel, rate, cost } using PWD tiered rates.
 */
function calcPotholeMetrics(det) {
  // Model space is 640 units wide = roadWidthMetres in real world
  const mPerPx = State.roadWidthMetres / 640;

  const widthM  = det.width  * mPerPx;
  const heightM = det.height * mPerPx;
  const areaSqM = widthM * heightM;

  let rate, sizeLabel;
  if (areaSqM < 0.10) {
    rate = CONFIG.REPAIR_RATE_SMALL;  sizeLabel = 'S';
  } else if (areaSqM < 0.50) {
    rate = CONFIG.REPAIR_RATE_MEDIUM; sizeLabel = 'M';
  } else {
    rate = CONFIG.REPAIR_RATE_LARGE;  sizeLabel = 'L';
  }

  const cost = Math.round(areaSqM * rate + CONFIG.REPAIR_MOBILIZATION);
  return { areaSqM, widthM, heightM, sizeLabel, rate, cost };
}

/**
 * Sums repair cost across all detections in the current frame.
 * Returns total ₹ for this frame and enriches each det with .metrics.
 */
function calculateFrameCost(detections) {
  let frameCost = 0;
  detections.forEach(det => {
    det._metrics = calcPotholeMetrics(det);
    frameCost += det._metrics.cost;
  });
  return frameCost;
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

/* ── Repair Cost (area-based, PWD rates) ── */
function updateRepairCost(cost) {
  const el    = document.getElementById('repairCost');
  const fill  = document.getElementById('costFill');
  const scale = document.getElementById('costScale');

  animateNumber(el, parseInt(el.textContent.replace(/,/g, '') || '0'), cost, 600, true);

  const pct = Math.min(100, (cost / CONFIG.MAX_COST_BAR) * 100);
  fill.style.width = `${pct}%`;

  // Show per-m² context in the scale label
  const rateNote = `₹573–900/m² · PWD rate`;
  scale.textContent = `₹0 — ₹${CONFIG.MAX_COST_BAR.toLocaleString('en-IN')}  |  ${rateNote}`;
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
function updateQualityScore(severity) {
  // Score = 100 - (severity * 7), clamped 0–100
  // severity = rolling avg of (total pothole area m² × 20)
  // severity 0→100(A+),  ~2→86(A),  ~5→65(B),  ~8→44(C),  ~12→16(D),  ≥14→0(F)
  // One L-pothole (0.56m²) → severity≈11 → D/F range — correct for a destroyed road
  const score = Math.max(0, 100 - severity * 7);
  const el    = document.getElementById('qualityScore');
  const grade = document.getElementById('qualityGrade');

  animateNumber(el, parseInt(el.textContent || '100'), score, 600);

  if      (score >= 90) { grade.textContent = 'A+'; grade.style.color = 'var(--accent)'; }
  else if (score >= 75) { grade.textContent = 'A';  grade.style.color = 'var(--accent)'; }
  else if (score >= 60) { grade.textContent = 'B';  grade.style.color = '#4ade80'; }
  else if (score >= 40) { grade.textContent = 'C';  grade.style.color = 'var(--amber)'; }
  else if (score >= 20) { grade.textContent = 'D';  grade.style.color = 'var(--red)'; }
  else                  { grade.textContent = 'F';  grade.style.color = 'var(--red)'; }

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

    // Label: show size category, area, cost
    ctx.shadowBlur = 0;
    const m = det._metrics || calcPotholeMetrics(det);
    const label = `#${i+1} [${m.sizeLabel}] ${m.areaSqM.toFixed(2)}m² ₹${m.cost.toLocaleString('en-IN')}`;
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
   7. Z-AXIS SENSOR & DATA PROCESSING
───────────────────────────────────────────────── */
function processZAxisReading(gz) {
  const absGz = Math.abs(gz);
  
  State.zAxis.current = gz;
  State.zAxis.history.push(gz);
  if (State.zAxis.history.length > CONFIG.ZBAR_COUNT) State.zAxis.history.shift();

  State.zAxis.readings.push(absGz);
  if (State.zAxis.readings.length > 60) State.zAxis.readings.shift();

  if (absGz > Math.abs(State.zAxis.peak)) State.zAxis.peak = gz;
  if (absGz > 0.5) State.zAxis.events++;

  State.roughnessHistory.push(absGz);
  if (State.roughnessHistory.length > CONFIG.GRAPH_HISTORY_POINTS) {
    State.roughnessHistory.shift();
  }

  // DOM updates
  const zValueEl   = document.getElementById('zAxisValue');
  const zSignEl    = document.getElementById('zAxisSign');
  if (!zValueEl) return;

  zValueEl.textContent = absGz.toFixed(2);
  zSignEl.textContent  = gz >= 0 ? '+' : '−';

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

  const avg = State.zAxis.readings.reduce((a,b) => a + b, 0) / Math.max(1, State.zAxis.readings.length);
  document.getElementById('zPeak').textContent   = `${Math.abs(State.zAxis.peak).toFixed(2)}G`;
  document.getElementById('zAvg').textContent    = `${avg.toFixed(2)}G`;
  document.getElementById('zEvents').textContent = State.zAxis.events;

  updateZAxisBars(State.zAxis.history);
  drawRoughnessGraph(State.roughnessHistory);
  document.getElementById('zEvents').textContent = State.zAxis.events;

  updateZAxisBars(State.zAxis.history);
  drawRoughnessGraph(State.roughnessHistory);
  
  // NEW: Update Tire Wear Prediction using latest Z-Axis data
  updateTireWearModel();

}
/* ── Tire Wear Particle (TWP) Predictive Engine ── */
function updateTireWearModel() {
  const vehEl = document.getElementById('twVehicleType');
  const paxEl = document.getElementById('twPax');
  const valEl = document.getElementById('twEmissionValue');
  if (!vehEl || !paxEl || !valEl) return;

  const baseWeight = parseFloat(vehEl.value) || 1400;
  const paxCount = parseInt(paxEl.value) || 1;
  const totalMass = baseWeight + (paxCount * 68); // 68kg avg human weight

  // Grab active telemetry
  const avgG = State.zAxis.readings.length > 0 
    ? State.zAxis.readings.reduce((a, b) => a + b, 0) / State.zAxis.readings.length 
    : 0;
  const events = State.zAxis.events;

  // TWP Formula
  const baseFriction = 0.067; // mg/km per kg of mass
  const roughnessMultiplier = 1 + (avgG * 1.5);
  const impactMultiplier = 1 + (events * 0.02);
  
  const rawEmission = totalMass * baseFriction * roughnessMultiplier * impactMultiplier;
  State.currentTWP = parseFloat(rawEmission.toFixed(2));

  // Update UI and color code
  valEl.textContent = State.currentTWP.toFixed(2);
  
  // Thresholds based on vehicle type to keep colors accurate
  const isHeavy = baseWeight > 2000;
  const critLimit = isHeavy ? 600 : 250;
  const warnLimit = isHeavy ? 450 : 150;

  if (State.currentTWP > critLimit) {
    valEl.style.color = 'var(--red)';
    valEl.style.textShadow = '0 0 15px rgba(239,68,68,0.5)';
  } else if (State.currentTWP > warnLimit) {
    valEl.style.color = 'var(--amber)';
    valEl.style.textShadow = '0 0 15px rgba(245,158,11,0.5)';
  } else {
    valEl.style.color = 'var(--accent)';
    valEl.style.textShadow = '0 0 15px var(--accent-glow)';
  }
}

function setZAxisNoData() {
  document.getElementById('zAxisValue').textContent = '--';
  document.getElementById('zAxisSign').textContent = '';
  document.getElementById('zAxisValue').style.color = 'var(--text-muted)';
  document.getElementById('zAxisValue').style.textShadow = 'none';
  document.getElementById('zPeak').textContent = 'No Data';
  document.getElementById('zAvg').textContent = 'No Data';
  document.getElementById('zEvents').textContent = '-';
  document.getElementById('sensorStatusText').textContent = 'No G-meter values found. Upload a CSV.';
  document.getElementById('flSensor').style.background = 'var(--text-muted)';
  document.querySelector('.sensor-dot').className = 'sensor-dot';
  
  const container = document.getElementById('zAxisBars');
  if (container) container.innerHTML = '<div style="color:var(--text-muted); font-size:9px; padding-top:20px; font-family:var(--font-mono);">NO TELEMETRY DATA</div>';
  
  const canvas = document.getElementById('roughnessGraph');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.font = '10px "Space Mono", monospace';
    ctx.fillText('NO G-FORCE DATA UPLOADED', 10, 20);
  }
}

function initZAxisSensor() {
  const sensorDot  = document.querySelector('.sensor-dot');
  const sensorText = document.getElementById('sensorStatusText');
  const flSensor   = document.getElementById('flSensor');

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
      State.isLiveSensorActive = true;
      State.hasZAxisData = true;
      
      clearInterval(State.simulatorInterval); // Stop desktop demo
      
      const gz = parseFloat((z / 9.81).toFixed(3));
      processZAxisReading(gz);

      sensorDot.className = 'sensor-dot sensor-dot--active';
      sensorText.textContent = 'Accelerometer active — live readings';
      flSensor.style.background = 'var(--accent)';
    }, { passive: true });
  }

  function setSensorError(msg) {
    sensorDot.className = 'sensor-dot sensor-dot--error';
    sensorText.textContent = msg;
    flSensor.style.background = 'var(--red)';
  }

  requestPermission();

  // Desktop demo fallback: Start simulator initially for the live preview, 
  // it shuts down automatically if user uploads video without a CSV.
  State.simulatorInterval = setInterval(() => {
    if (!State.isLiveSensorActive && State.hasZAxisData && State.csvZData.length === 0) {
      const t = Date.now() / 150;
      const gz = parseFloat((Math.sin(t * 0.15) * 0.08 + (Math.random() < 0.08 ? (Math.random() * 1.2 - 0.3) : 0) + (Math.random() - 0.5) * 0.05).toFixed(3));
      processZAxisReading(gz);
      if(sensorText) sensorText.textContent = 'Simulated sensor data (desktop mode)';
    }
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
  grad.addColorStop(0, 'rgba(0, 210, 106, 0.65)'); // Much stronger top color
  grad.addColorStop(1, 'rgba(0, 210, 106, 0.05)'); // Leaves a subtle base tint

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
  ctx.lineWidth   = 2.5; // Thicker, bolder line
  ctx.shadowColor = 'var(--accent)';
  ctx.shadowBlur  = 12;  // Increased neon glow effect
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

  // Active needle value (count mapped 0-12 → 0-1, 12+ potholes = full hazard)
  const value   = Math.min(1, count / 12);
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

function initUploadHandler() {
  const input   = document.getElementById('footageUpload');
  const video   = document.getElementById('roadVideo');
  const modal   = document.getElementById('uploadModal');
  const desc    = document.getElementById('modalDesc');
  const confirm = document.getElementById('modalConfirm');
  const close   = document.getElementById('modalClose');

  // Wire modal actions: confirm begins analysis, close hides modal
  if (confirm) {
    confirm.addEventListener('click', (ev) => {
      modal.hidden = true;
      // Prefer toggling the main Analyze button so the UI reflects auto-scan state
      const analyzeBtnEl = document.getElementById('analyzeBtn');
      if (analyzeBtnEl) {
        // If the button shows "Start", click it to start auto-scan; otherwise run a single analysis
        if (/Start/i.test(analyzeBtnEl.innerText)) analyzeBtnEl.click();
        else runAnalysis();
      } else {
        runAnalysis();
      }
    });
  }
  if (close) {
    close.addEventListener('click', () => { modal.hidden = true; });
  }

  input.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    // Separate media from CSV
    const mediaFile = files.find(f => f.type.startsWith('video/') || f.type.startsWith('image/'));
    const csvFile   = files.find(f => f.name.endsWith('.csv') || f.type === 'text/csv');

    let descText = "";

    if (mediaFile) {
      const url = URL.createObjectURL(mediaFile);
      if (mediaFile.type.startsWith('video/')) {
        video.src = url;
        video.load();
        video.pause();
      } else {
        video.poster = url;
        video.src = '';
      }
      descText += `"${mediaFile.name}" loaded. `;
    }

    if (csvFile) {
      const text = await csvFile.text();
      const lines = text.trim().split('\n');
      State.csvZData = [];
      let zIndex = -1;
      
      // Auto-find Z column header, fallback to last column
      // 1. Skip metadata comments (like "# Target Sample Rate: 200 Hz")
      let headerIdx = 0;
      while (headerIdx < lines.length && lines[headerIdx].trim().startsWith('#')) {
        headerIdx++;
      }

      if (headerIdx < lines.length) {
        const headers = lines[headerIdx].toLowerCase().split(',');
        let isTotalG = false;

        // 2. Look for "TgF" (Total G-Force) first, then fallback to Z-axis
        for (let i = 0; i < headers.length; i++) {
          if (headers[i].includes('tgf') || headers[i].includes('total')) {
            zIndex = i;
            isTotalG = true;
            break;
          }
        }
        if (zIndex === -1) {
          for (let i = 0; i < headers.length; i++) {
            if (headers[i].includes('z')) { zIndex = i; break; }
          }
        }
        if (zIndex === -1) zIndex = headers.length - 1; 
        
        // 3. Parse Data and Calibrate Gravity
        for (let i = headerIdx + 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length > zIndex) {
            let val = parseFloat(cols[zIndex]);
            if (!isNaN(val)) {
              // If we use Total G, subtract 1G (baseline gravity) so flat roads = 0.00G
              if (isTotalG) val = val - 1.0;
              State.csvZData.push(val);
            }
          }
        }
      }
      
      // Reset peak when a new CSV is loaded
      State.zAxis.peak = 0;
      descText += `\nTelemetry CSV synced (${State.csvZData.length} records).`;
      State.hasZAxisData = true;
      document.getElementById('sensorStatusText').textContent = 'Telemetry synced from CSV.';
      document.getElementById('flSensor').style.background = 'var(--accent)';
      document.querySelector('.sensor-dot').className = 'sensor-dot sensor-dot--active';
    } else if (mediaFile) {
      // User uploaded video but NO CSV. Safely kill the simulator!
      State.csvZData = [];
      if (!State.isLiveSensorActive) {
        State.hasZAxisData = false;
        setZAxisNoData();
      }
    }

    desc.textContent = descText || "Ready for analysis.";
    modal.hidden = false;
  });

}

/* ─────────────────────────────────────────────────
   12. UI CONTROLS, SESSION CLOCK, DEMO TOGGLE
───────────────────────────────────────────────── */

/* ─────────────────────────────────────────────────
   REPORT GENERATOR (Cumulative Overall Version)
───────────────────────────────────────────────── */
function generateReport() {
  const now = new Date().toLocaleString('en-IN');
  const elapsed = Math.floor((Date.now() - State.sessionStartTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');
  
  // 1. Calculate OVERALL Route Scores (ignoring real-time dashboard state)
  const overallSeverity = State.totalFramesWithSeverity > 0 
    ? (State.cumulativeAreaSeverity / State.totalFramesWithSeverity) : 0;
    
  const overallScore = Math.max(0, Math.round(100 - overallSeverity * 7));
  
  let overallGrade = 'F';
  if (overallScore >= 90) overallGrade = 'A+';
  else if (overallScore >= 75) overallGrade = 'A';
  else if (overallScore >= 60) overallGrade = 'B';
  else if (overallScore >= 40) overallGrade = 'C';
  else if (overallScore >= 20) overallGrade = 'D';

  let overallAbrasion = 'LOW';
  if (overallSeverity > CONFIG.ABRASION_CRITICAL_THRESHOLD) overallAbrasion = 'CRITICAL';
  else if (overallSeverity > CONFIG.ABRASION_MODERATE_THRESHOLD) overallAbrasion = 'MODERATE';
  
  // 2. Generate Top Events Table
  const topEvents = [...State.detectionLog].sort((a, b) => b.repairCost - a.repairCost).slice(0, 5);
  let tableHtml = '';
  if (topEvents.length > 0) {
    tableHtml = `
      <h3>Top 5 High-Cost Detection Events</h3>
      <table>
        <thead><tr><th>Time</th><th>Lat</th><th>Lng</th><th>Count</th><th>Est. Cost (₹)</th></tr></thead>
        <tbody>
          ${topEvents.map(e => `
            <tr>
              <td>${new Date(e.timestamp).toLocaleTimeString('en-IN')}</td>
              <td>${e.lat.toFixed(4)}</td><td>${e.lng.toFixed(4)}</td>
              <td>${e.count}</td><td>${e.repairCost.toLocaleString('en-IN')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } else {
    tableHtml = '<p>No defect events logged during this session.</p>';
  }

  // 3. Generate Timeline Graph (Sub-sampled for clean rendering)
  const maxBars = 150; // Keep the graph from getting too squished on long drives
  const step = Math.max(1, Math.floor(State.severityHistory.length / maxBars));
  const sampledHistory = State.severityHistory.filter((_, i) => i % step === 0);
  const maxSev = Math.max(...sampledHistory, 15); // Baseline scale
  
  const graphHtml = `
    <h3 style="margin-top: 30px;">Route Severity Timeline</h3>
    <div style="display: flex; align-items: flex-end; height: 120px; gap: 2px; border-bottom: 2px solid #ddd; padding-bottom: 5px; margin-bottom: 30px;">
      ${sampledHistory.map(sev => {
        const heightPct = Math.max(2, Math.min(100, (sev / maxSev) * 100)); // Minimum 2% height for flat roads
        const color = sev > CONFIG.ABRASION_CRITICAL_THRESHOLD ? '#ef4444' : 
                     (sev > CONFIG.ABRASION_MODERATE_THRESHOLD ? '#f59e0b' : '#00e5a0');
        return `<div style="flex: 1; background-color: ${color}; height: ${heightPct}%; border-radius: 2px 2px 0 0;"></div>`;
      }).join('')}
    </div>
  `;

  // 4. Build the HTML Document
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>TreadGuard CV Report</title>
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #222; padding: 40px; max-width: 800px; margin: 0 auto; }
        h1 { color: #111; border-bottom: 2px solid #00e5a0; padding-bottom: 10px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 30px 0; }
        .metric { background: #f9f9f9; padding: 15px; border-left: 4px solid #00e5a0; }
        .metric-label { font-size: 11px; text-transform: uppercase; color: #777; font-weight: bold; }
        .metric-value { font-size: 22px; font-weight: bold; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background-color: #f5f5f5; font-size: 12px; text-transform: uppercase; }
        .footer { margin-top: 50px; font-size: 11px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
      </style>
    </head>
    <body>
      <h1>TreadGuard CV — Road Audit Report</h1>
      <p><strong>Export Date:</strong> ${now}<br><strong>Session Duration:</strong> ${h}:${m}:${s}</p>
      
      <div class="grid">
        <div class="metric"><div class="metric-label">Total Potholes Detected</div><div class="metric-value">${State.sessionTotal}</div></div>
        <div class="metric"><div class="metric-label">Est. Repair Cost</div><div class="metric-value">₹${Math.round(State.totalRepairCost).toLocaleString('en-IN')}</div></div>
        <div class="metric"><div class="metric-label">Overall Road Quality</div><div class="metric-value">${overallScore} (Grade ${overallGrade})</div></div>
        <div class="metric"><div class="metric-label">Overall Abrasion Index</div><div class="metric-value">${overallAbrasion}</div></div>
        <div class="metric"><div class="metric-label">Z-Axis Peak G-Force</div><div class="metric-value" ${!State.hasZAxisData ? 'style="color:#888;"' : ''}>${State.hasZAxisData ? Math.abs(State.zAxis.peak).toFixed(2) + 'G' : 'No Data'}</div></div>
        <div class="metric"><div class="metric-label">Significant Bump Events</div><div class="metric-value" ${!State.hasZAxisData ? 'style="color:#888;"' : ''}>${State.hasZAxisData ? State.zAxis.events : 'No Data'}</div></div>
      </div>
      
      ${graphHtml}
      ${tableHtml}
      
      <div class="footer">Generated by TreadGuard CV · Roboflow pothole detection model · PWD repair rate basis</div>
      <script>window.onload = () => { window.print(); };</script>
    </body>
    </html>
  `;

const printWindow = window.open('', '_blank');
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/* ─────────────────────────────────────────────────
   MANUAL REPORT GENERATOR (Human-Certified)
───────────────────────────────────────────────── */
function generateManualReport() {
  const now = new Date().toLocaleString('en-IN');
  const elapsed = Math.floor((Date.now() - State.sessionStartTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
  const s = String(elapsed % 60).padStart(2, '0');

  // 1. Extract Validated Data for Table & Graph
  let manualEvents = [];
  let manualSeverityTimeline = [];

  State.validationFrames.forEach(frame => {
    // Filter to ONLY include the boxes the human ticked "✓"
    const validPreds = frame.predictions.filter(p => p._status === 'validated');
    
    // Graph Severity Math (Based only on certified area)
    const frameAreaSqM = validPreds.reduce((sum, p) => sum + (p._metrics?.areaSqM ?? 0), 0);
    const frameSeverity = frameAreaSqM * 20;
    manualSeverityTimeline.push(frameSeverity);

    // Table Event Math (Log the location if potholes were certified)
    if (validPreds.length > 0) {
      const frameCost = validPreds.reduce((sum, p) => sum + (p._metrics?.cost ?? 0), 0);
      manualEvents.push({
        timestamp: frame.timestamp || Date.now(),
        lat: frame.lat || State.gps.lat,
        lng: frame.lng || State.gps.lng,
        count: validPreds.length,
        repairCost: frameCost
      });
    }
  });

  // 2. Build the Certified Graph
  if (manualSeverityTimeline.length === 0) manualSeverityTimeline = [0, 0, 0, 0, 0];
  const maxBars = 150;
  const step = Math.max(1, Math.floor(manualSeverityTimeline.length / maxBars));
  const sampledHistory = manualSeverityTimeline.filter((_, i) => i % step === 0);
  const maxSev = Math.max(...sampledHistory, 15);

  const graphHtml = `
    <h3 style="margin-top: 30px;">Route Severity Timeline (Auto-Telemetry)</h3>
    <div style="display: flex; align-items: flex-end; height: 120px; gap: 2px; border-bottom: 2px solid #ddd; padding-bottom: 5px; margin-bottom: 30px;">
      ${sampledHistory.map(sev => {
        const heightPct = Math.max(2, Math.min(100, (sev / maxSev) * 100));
        const color = sev > CONFIG.ABRASION_CRITICAL_THRESHOLD ? '#ef4444' : 
                     (sev > CONFIG.ABRASION_MODERATE_THRESHOLD ? '#f59e0b' : '#00e5a0');
        return `<div style="flex: 1; background-color: ${color}; height: ${heightPct}%; border-radius: 2px 2px 0 0;"></div>`;
      }).join('')}
    </div>
  `;

  // 3. Build the Certified Table
  const topEvents = [...manualEvents].sort((a, b) => b.repairCost - a.repairCost).slice(0, 5);
  let tableHtml = '';
  if (topEvents.length > 0) {
    tableHtml = `
      <h3>Top 5 Certified Pothole Locations</h3>
      <table>
        <thead><tr><th>Time</th><th>Lat</th><th>Lng</th><th>Count</th><th>Est. Cost (₹)</th></tr></thead>
        <tbody>
          ${topEvents.map(e => `
            <tr>
              <td>${new Date(e.timestamp).toLocaleTimeString('en-IN')}</td>
              <td>${e.lat.toFixed(4)}</td><td>${e.lng.toFixed(4)}</td>
              <td>${e.count}</td><td>${e.repairCost.toLocaleString('en-IN')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  } else {
    tableHtml = '<p style="margin-top:20px;">No defects manually certified during this session.</p>';
  }

  // 4. Render HTML
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>TreadGuard CV - Certified Manual Report</title>
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #222; padding: 40px; max-width: 800px; margin: 0 auto; }
        h1 { color: #111; border-bottom: 2px solid #3b82f6; padding-bottom: 10px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 30px 0; }
        .metric { background: #f9f9f9; padding: 15px; border-left: 4px solid #3b82f6; }
        .metric-label { font-size: 11px; text-transform: uppercase; color: #777; font-weight: bold; }
        .metric-value { font-size: 22px; font-weight: bold; margin-top: 4px; color: #111;}
        .cert-badge { background: #3b82f6; color: white; padding: 2px 6px; border-radius: 4px; font-size: 9px; vertical-align: middle; margin-left: 6px; letter-spacing: 0.5px;}
        table { width: 100%; border-collapse: collapse; margin-top: 15px; }
        th, td { border: 1px solid #ddd; padding: 12px; text-align: left; }
        th { background-color: #f5f5f5; font-size: 12px; text-transform: uppercase; }
        .footer { margin-top: 50px; font-size: 11px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
      </style>
    </head>
    <body>
      <h1>TreadGuard CV — Certified Manual Audit Report</h1>
      <p><strong>Export Date:</strong> ${now}<br><strong>Session Duration:</strong> ${h}:${m}:${s}<br><strong>Verification Status:</strong> Human Audited & Certified ✓</p>
      
      <div class="grid">
        <div class="metric">
          <div class="metric-label">Certified Potholes <span class="cert-badge">MANUAL</span></div>
          <div class="metric-value">${State.validatedPotholesCount}</div>
        </div>
        <div class="metric">
          <div class="metric-label">Certified Repair Cost <span class="cert-badge">MANUAL</span></div>
          <div class="metric-value">₹${State.validatedRepairCost.toLocaleString('en-IN')}</div>
        </div>
        <div class="metric"><div class="metric-label">Z-Axis Peak G-Force (Hardware)</div><div class="metric-value" ${!State.hasZAxisData ? 'style="color:#888;"' : ''}>${State.hasZAxisData ? Math.abs(State.zAxis.peak).toFixed(2) + 'G' : 'No Data'}</div></div>
        <div class="metric"><div class="metric-label">Significant Bump Events</div><div class="metric-value" ${!State.hasZAxisData ? 'style="color:#888;"' : ''}>${State.hasZAxisData ? State.zAxis.events : 'No Data'}</div></div>
      </div>
      
      ${graphHtml}
      ${tableHtml}
      
      <div class="footer">Generated by TreadGuard CV · Human-in-the-Loop Certified · PWD repair rate basis</div>
      <script>window.onload = () => { window.print(); };</script>
    </body>
    </html>
  `;

const printWindow = window.open('', '_blank');
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/* ─────────────────────────────────────────────────
   TIRE ABRASION REPORT GENERATOR
───────────────────────────────────────────────── */
function generateAbrasionReport() {
  const now = new Date().toLocaleString('en-IN');
  const vehEl = document.getElementById('twVehicleType');
  const paxEl = document.getElementById('twPax');
  
  const baseWeight = parseFloat(vehEl.value) || 1400;
  const paxCount = parseInt(paxEl.value) || 1;
  const totalMass = baseWeight + (paxCount * 68);
  
  let vehName = '4-Wheeler';
  if (baseWeight === 150) vehName = '2-Wheeler';
  if (baseWeight === 4500) vehName = 'Heavy Duty Transit';

  const avgG = State.zAxis.readings.length > 0 
    ? State.zAxis.readings.reduce((a, b) => a + b, 0) / State.zAxis.readings.length 
    : 0;

  const isHeavy = baseWeight > 2000;
  const critLimit = isHeavy ? 600 : 250;
  const emissionColor = State.currentTWP > critLimit ? '#ef4444' : '#00e5a0';
  const statusLabel = State.currentTWP > critLimit ? 'CRITICAL EMISSION' : 'WITHIN LIMITS';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>TreadGuard CV - Tire Wear Report</title>
      <style>
        body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #222; padding: 40px; max-width: 800px; margin: 0 auto; }
        h1 { color: #111; border-bottom: 2px solid #f59e0b; padding-bottom: 10px; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin: 30px 0; }
        .metric { background: #f9f9f9; padding: 15px; border-left: 4px solid #f59e0b; }
        .metric-label { font-size: 11px; text-transform: uppercase; color: #777; font-weight: bold; }
        .metric-value { font-size: 22px; font-weight: bold; margin-top: 4px; color: #111;}
        .highlight-box { background: #111; color: white; padding: 25px; border-radius: 8px; text-align: center; margin: 30px 0; border-bottom: 5px solid ${emissionColor}; }
        .formula-box { background: #f1f5f9; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 12px; color: #334155; margin-bottom: 30px; }
        .footer { margin-top: 50px; font-size: 11px; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
      </style>
    </head>
    <body>
      <h1>TreadGuard CV — Predictive Microplastic Report</h1>
      <p><strong>Export Date:</strong> ${now}<br><strong>Audit Type:</strong> Environmental Tire Abrasion Telemetry</p>
      
      <div class="highlight-box">
        <div style="font-size: 12px; letter-spacing: 2px; color: #888; margin-bottom: 10px;">PREDICTED TIRE WEAR EMISSION</div>
        <div style="font-size: 48px; font-weight: bold; color: ${emissionColor}; line-height: 1;">${State.currentTWP.toFixed(2)} <span style="font-size: 20px;">mg/km</span></div>
        <div style="font-size: 14px; margin-top: 10px; font-weight: bold; color: ${emissionColor};">${statusLabel}</div>
      </div>

      <div class="grid">
        <div class="metric"><div class="metric-label">Vehicle Type</div><div class="metric-value">${vehName}</div></div>
        <div class="metric"><div class="metric-label">Total Moving Mass</div><div class="metric-value">${totalMass} kg</div></div>
        <div class="metric"><div class="metric-label">Passengers (Avg 68kg)</div><div class="metric-value">${paxCount}</div></div>
        <div class="metric"><div class="metric-label">Hardware Bump Events</div><div class="metric-value">${State.zAxis.events}</div></div>
      </div>
      
      <h3>Predictive Modeling Formula Applied</h3>
      <div class="formula-box">
        E_twp = (W_veh + (N × 68)) × β × (1 + (G_avg × 1.5)) × (1 + (E_bump × 0.02))<br><br>
        <strong>Parameters Used:</strong><br>
        Base Friction Constant (β) = 0.067 mg/km/kg<br>
        Average Roughness (G_avg) = ${avgG.toFixed(3)} G<br>
        Impact Event Count (E_bump) = ${State.zAxis.events}
      </div>

      <div class="footer">Generated by TreadGuard CV · Environmental Telemetry Engine</div>
      <script>window.onload = () => { window.print(); };</script>
    </body>
    </html>
  `;

  const printWindow = window.open('', '_blank');
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/* ─────────────────────────────────────────────────
   12. UI CONTROLS & CLOCK
───────────────────────────────────────────────── */
function initControls() {
  let scanInterval = null;
  let isScanning = false;
  const analyzeBtn = document.getElementById('analyzeBtn');
  const video = document.getElementById('roadVideo');

  // Helper: read vehicle speed (km/h) from UI and clamp to reasonable range
  function getVehicleSpeedKmph() {
    const el = document.getElementById('vehicleSpeedKmph');
    if (!el) return 30;
    const v = parseFloat(el.value || '0');
    if (isNaN(v) || v <= 0) return 5; // walking pace fallback
    return Math.min(200, Math.max(1, v));
  }

  // Helper: read road width (metres) from UI, validate and clamp, fallback to 3.5
  function getRoadWidthMetres() {
    const el = document.getElementById('roadWidthMetres');
    if (!el) return State.roadWidthMetres || 3.5;
    const v = parseFloat(el.value);
    if (isNaN(v) || v <= 0) return State.roadWidthMetres || 3.5;
    // clamp to a reasonable 1–12m range
    return Math.min(12, Math.max(1, v));
  }

  // Compute adaptive delay (ms) based on vehicle speed and detections' Y position.
  // Idea: estimate time until the nearest detected pothole reaches the tripwire (y=250),
  // then schedule the next capture to sample shortly before that moment. This avoids
  // repeated detections (ghosting) while not skipping approaching potholes.
  function computeAdaptiveDelay(speedKmph, detections = []) {
    const minMs = 300;
    const maxMs = 2500;
    const defaultMs = 500;

    // If no detections, scale delay modestly with speed (faster -> slightly more frequent sampling)
    if (!detections || detections.length === 0) {
      const scaled = Math.round(Math.max(minMs, defaultMs - (speedKmph * 4)));
      return Math.min(maxMs, Math.max(minMs, scaled));
    }

    const mPerPx = State.roadWidthMetres / 640; // metres per pixel in model space
    const speedMps = Math.max(0.1, speedKmph / 3.6);

    let bestMs = maxMs;
    for (const det of detections) {
      // Tripwire at y = 250px (see processDetectionData)
      const tripwireY = 250;
      const distancePx = tripwireY - (det.y ?? 0);

      if (distancePx <= 0) {
        // Already at or past tripwire — keep a short pause to avoid immediate repeats
        bestMs = Math.min(bestMs, 900);
        continue;
      }

      const distanceM = distancePx * mPerPx;
      const timeS = distanceM / speedMps; // seconds until it crosses tripwire

      // Sample at ~60% of the remaining time so we capture the approach without repeating
      const desiredMs = Math.round(timeS * 1000 * 0.6);
      if (desiredMs > 0) bestMs = Math.min(bestMs, desiredMs);
    }

    // Fallback clamp
    bestMs = Math.min(maxMs, Math.max(minMs, bestMs));
    return bestMs;
  }


  // ── Helper: cleanly stop the scan loop ───────────────────────────────
  function stopScanning() {
    isScanning = false;
    clearInterval(scanInterval);
    clearTimeout(scanInterval);
    scanInterval = null;
    analyzeBtn.innerHTML = 'Start Auto-Scan';
    analyzeBtn.style.background = 'var(--bg-card)';
    analyzeBtn.style.color = 'var(--text-secondary)';
  }

  // Initialize road width input and attach change handler
  (function initRoadWidthInput() {
    const el = document.getElementById('roadWidthMetres');
    if (!el) return;
    // Ensure UI shows current state on load
    el.value = State.roadWidthMetres || 3.5;
    el.addEventListener('change', () => {
      const w = getRoadWidthMetres();
      State.roadWidthMetres = w;
      console.log(`[TreadGuard] Road width calibrated to ${w} m`);
    });
  })();

  // ── NEW: Tire Wear Input Listeners ──
  const vehInput = document.getElementById('twVehicleType');
  const paxInput = document.getElementById('twPax');
  if (vehInput) vehInput.addEventListener('change', updateTireWearModel);
  if (paxInput) paxInput.addEventListener('input', updateTireWearModel);

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

      // Ensure the video plays when scanning starts
      try {
        if (video && video.src) {
          const playPromise = video.play();
          if (playPromise && typeof playPromise.then === 'function') {
            playPromise.catch(err => { console.warn('[TreadGuard] Video play prevented:', err); });
          }
        }
      } catch (err) {
        console.warn('[TreadGuard] Error attempting to play video:', err);
      }

      // Run once immediately, then schedule subsequent captures adaptively
      let prevDelay = 500;

      async function scheduleNext() {
        const speed = getVehicleSpeedKmph();
        const delay = computeAdaptiveDelay(speed, State.detections) || 500;
        // Smooth small jitter between delays
        const smoothed = Math.round(prevDelay * 0.6 + delay * 0.4);
        prevDelay = smoothed;

        scanInterval = setTimeout(async () => {
          await runAnalysis();
          if (isScanning) scheduleNext();
        }, smoothed);
      }

      runAnalysis();
      scheduleNext();
    } else {
      stopScanning();
    }
  });

  /* ── Reset Button ── */
  document.getElementById('resetBtn').addEventListener('click', () => {
    State.potholeCount        = 0;
    State.sessionTotal        = 0;
    State.totalRepairCost     = 0;
    State.rollingCounts       = [];
    State.rollingAreaSeverity = [];
    State.lastAnalyzedVideoTime = -1;
    State.framesAnalyzed      = 0;
    State.sparklineHistory    = [];
    State.zAxis.peak     = 0;
    State.zAxis.events   = 0;
    State.zAxis.readings = [];
    State.roughnessHistory = new Array(CONFIG.GRAPH_HISTORY_POINTS).fill(0);
    
    // Clear Validation Board
    State.validationFrames = [];
    State.validatedPotholesCount = 0;
    State.validatedRepairCost = 0;
    const valCountEl = document.getElementById('valCount');
    const valCostEl = document.getElementById('valCost');
    if (valCountEl) valCountEl.textContent = '0';
    if (valCostEl) valCostEl.textContent = '0';
    const grid = document.getElementById('vdGrid');
    if (grid) grid.innerHTML = '';

processDetectionData(0, []);
    document.getElementById('frameCounter').textContent = '0';
    document.getElementById('zPeak').textContent   = '0.00G';
    document.getElementById('zAvg').textContent    = '0.00G';
    document.getElementById('zEvents').textContent = '0';
  });

  /* ── Download Report Buttons ── */
  const downloadReportBtn = document.getElementById('downloadReportBtn');
  if (downloadReportBtn) {
    downloadReportBtn.addEventListener('click', generateReport);
  }

  const downloadManualReportBtn = document.getElementById('downloadManualReportBtn');
  if (downloadManualReportBtn) {
    downloadManualReportBtn.addEventListener('click', generateManualReport);
  }

  const downloadAbrasionReportBtn = document.getElementById('downloadAbrasionReportBtn');
  if (downloadAbrasionReportBtn) {
    downloadAbrasionReportBtn.addEventListener('click', generateAbrasionReport);
  }

  /* ── Validation Dashboard Initialization ── */
  const validateBtn = document.getElementById('validateBtn');
  const validationDashboard = document.getElementById('validationDashboard');

  if (validateBtn && validationDashboard) {
    validateBtn.addEventListener('click', () => {
      const isHidden = validationDashboard.style.display === 'none';
      validationDashboard.style.display = isHidden ? 'block' : 'none';
      
      if (isHidden) {
        // Auto-pause scanning so the user can focus
        if (isScanning) analyzeBtn.click(); 
        
        renderValidationFrames();
        setTimeout(() => validationDashboard.scrollIntoView({ behavior: 'smooth' }), 100);
      }
    });
  }

  function renderValidationFrames() {
    const grid = document.getElementById('vdGrid');
    grid.innerHTML = '';

    if (State.validationFrames.length === 0) {
      grid.innerHTML = '<p style="color: var(--text-muted); font-family: var(--font-mono); grid-column: 1/-1;">No frames with detections available yet. Run the scanner first.</p>';
      return;
    }

    // Display newest frames first
    [...State.validationFrames].reverse().forEach(frame => {
      const wrap = document.createElement('div');
      wrap.className = 'vd-frame-wrapper';

      const img = document.createElement('img');
      img.src = 'data:image/jpeg;base64,' + frame.image;
      img.className = 'vd-frame-img';
      wrap.appendChild(img);

      frame.predictions.forEach(det => {
        if (det._status === undefined) det._status = 'pending';

        // Dynamically calculate percentages based on the ACTUAL image resolution
        const frameW = frame.width || 640;
        const frameH = frame.height || 360;

        const leftPct   = ((det.x - det.width / 2) / frameW) * 100;
        const topPct    = ((det.y - det.height / 2) / frameH) * 100;
        const widthPct  = (det.width / frameW) * 100;
        const heightPct = (det.height / frameH) * 100;

        const bbox = document.createElement('div');
        bbox.className = `vd-bbox ${det._status !== 'pending' ? det._status : ''}`;
        bbox.style.left   = `${leftPct}%`;
        bbox.style.top    = `${topPct}%`;
        bbox.style.width  = `${widthPct}%`;
        bbox.style.height = `${heightPct}%`;

        const actions = document.createElement('div');
        actions.className = `vd-actions ${det._status !== 'pending' ? 'hidden' : ''}`;
        
        const tickBtn = document.createElement('button');
        tickBtn.className = 'vd-btn vd-btn-tick';
        tickBtn.textContent = '✓';
        
        const crossBtn = document.createElement('button');
        crossBtn.className = 'vd-btn vd-btn-cross';
        crossBtn.textContent = '✕';

        // Operator confirmed Pothole
        tickBtn.onclick = () => {
          det._status = 'validated';
          bbox.classList.add('validated');
          actions.classList.add('hidden');
          
          State.validatedPotholesCount++;
          if (!det._metrics) det._metrics = calcPotholeMetrics(det);
          State.validatedRepairCost += det._metrics.cost;
          
          updateValidationCounters();
        };

        // Operator rejected false positive
        crossBtn.onclick = () => {
          det._status = 'rejected';
          bbox.classList.add('rejected');
          actions.classList.add('hidden');
        };

        actions.appendChild(tickBtn);
        actions.appendChild(crossBtn);
        bbox.appendChild(actions);
        wrap.appendChild(bbox);
      });
      grid.appendChild(wrap);
    });
  }

  function updateValidationCounters() {
    document.getElementById('valCount').textContent = State.validatedPotholesCount;
    document.getElementById('valCost').textContent = State.validatedRepairCost.toLocaleString('en-IN');
  }

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
   13. GPS + MINI-MAP
───────────────────────────────────────────────── */

/**
 * Starts the GPS watchPosition loop.
 * On success: stores real coords in State.gps (simulated=false).
 * On deny / unsupported: falls back to Bangalore and logs a warning.
 */
function initGPS() {
  if (!navigator.geolocation) {
    console.warn('[TreadGuard] Geolocation not supported — using Bangalore fallback.');
    State.gps = { lat: 12.9716, lng: 77.5946, simulated: true };
    updateGPSLabel();
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      State.gps = {
        lat:      pos.coords.latitude,
        lng:      pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        simulated: false,
      };
      updateGPSLabel();
    },
    (err) => {
      console.warn('[TreadGuard] GPS denied — using Bangalore fallback.', err.message);
      State.gps = { lat: 12.9716, lng: 77.5946, simulated: true };
      updateGPSLabel();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

/**
 * Syncs the GPS status badge + HUD coordinate readout
 * to the current State.gps values.
 */
function updateGPSLabel() {
  const badge = document.getElementById('gpsStatusLabel');
  if (badge) {
    if (State.gps.simulated) {
      badge.textContent = 'GPS SIMULATED';
      badge.style.color = 'var(--amber)';
    } else {
      badge.textContent = 'GPS LIVE';
      badge.style.color = 'var(--accent)';
    }
  }
  // Update HUD lat/lng readout
  const lat = Math.abs(State.gps.lat).toFixed(4);
  const lng = Math.abs(State.gps.lng).toFixed(4);
  const latDir = State.gps.lat >= 0 ? 'N' : 'S';
  const lngDir = State.gps.lng >= 0 ? 'E' : 'W';
  const latEl = document.getElementById('hudLat');
  const lngEl = document.getElementById('hudLng');
  if (latEl) latEl.textContent = `LAT ${lat}°${latDir}`;
  if (lngEl) lngEl.textContent = `LNG ${lng}°${lngDir}`;
}

/**
 * Redraws the 400×200 mini-map canvas from State.detectionLog.
 * Each entry is a dot colour-coded by pothole count.
 * If fewer than 2 points exist, shows a "Drive to populate map" prompt.
 */
function drawMiniMap() {
  const canvas = document.getElementById('miniMapCanvas');
  if (!canvas) return;
  const W   = canvas.width;   // 400
  const H   = canvas.height;  // 200
  const ctx = canvas.getContext('2d');
  const log = State.detectionLog;

  // ── Background ──
  ctx.fillStyle = '#080c10';
  ctx.fillRect(0, 0, W, H);

  // ── Subtle grid ──
  ctx.strokeStyle = 'rgba(0,229,160,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // ── Empty state ──
  if (log.length < 2) {
    ctx.font = '600 10px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(0,229,160,0.28)';
    ctx.textAlign = 'center';
    ctx.fillText('DRIVE TO POPULATE MAP', W / 2, H / 2 - 8);
    ctx.font = '400 9px "Space Mono", monospace';
    ctx.fillStyle = 'rgba(0,229,160,0.15)';
    ctx.fillText('detection dots appear as potholes are found', W / 2, H / 2 + 10);
    ctx.textAlign = 'left';
    return;
  }

  // ── Compute bounding box ──
  const lats   = log.map(e => e.lat);
  const lngs   = log.map(e => e.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  // Guard against all-same coords (e.g. simulated GPS)
  const latRange = maxLat - minLat || 0.001;
  const lngRange = maxLng - minLng || 0.001;

  const PAD  = 22;
  const mapW = W - PAD * 2;
  const mapH = H - PAD * 2 - 18; // reserve bottom 18px for legend

  // ── Path connecting dots ──
  ctx.strokeStyle = 'rgba(0,229,160,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  log.forEach((e, i) => {
    const x = PAD + ((e.lng - minLng) / lngRange) * mapW;
    const y = PAD + (1 - (e.lat - minLat) / latRange) * mapH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  // ── Dots ──
  log.forEach((e, i) => {
    const x = PAD + ((e.lng - minLng) / lngRange) * mapW;
    const y = PAD + (1 - (e.lat - minLat) / latRange) * mapH;

    const color = e.count > 7  ? '#ef4444'
                : e.count >= 3 ? '#f59e0b'
                :                '#00e5a0';

    // Glow halo
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = color + '22';
    ctx.fill();

    // Core dot
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color + '99';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Most-recent dot gets an extra ring
    if (i === log.length - 1) {
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.strokeStyle = color + '55';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  });

  // ── Legend (bottom strip) ──
  const legendY = H - 7;
  ctx.font = '500 8px "Space Mono", monospace';
  ctx.textAlign = 'left';
  const legend = [
    { color: '#00e5a0', label: '< 3  potholes' },
    { color: '#f59e0b', label: '3–7  potholes' },
    { color: '#ef4444', label: '> 7  potholes' },
  ];
  legend.forEach((item, i) => {
    const lx = PAD + i * 118;
    ctx.beginPath();
    ctx.arc(lx + 4, legendY - 3, 3, 0, Math.PI * 2);
    ctx.fillStyle = item.color;
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillText(item.label, lx + 11, legendY);
  });
}

/* ─────────────────────────────────────────────────
   14. INITIALIZER (formerly 13)
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

  // Start GPS watcher (real or fallback)
  initGPS();

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

  // Warm-up: draw empty mini-map placeholder
  drawMiniMap();

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
