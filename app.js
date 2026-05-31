/* TreadGuard CV — app.js
   Pure vanilla JS · No build step · No frameworks

   1. Configuration & Constants     7. Roughness Waveform Graph
   2. State Management               8. Skid Gauge (Canvas)
   3. API Integration (Roboflow)     9. Quality Ring (Canvas)
   4. Detection Data Processor      10. Upload Handler
   5. Canvas HUD Renderer           11. UI Controls & Clock
   6. Z-Axis Sensor (DeviceMotion)  12. Initializer
*/

'use strict';

/* ─────────────────────────────────────────────────
   1. CONFIGURATION & CONSTANTS
   ─────────────────────────────────────────────────
   !! REPLACE THESE PLACEHOLDERS BEFORE GOING LIVE !!
───────────────────────────────────────────────── */
const CONFIG = {
  ROBOFLOW_ENDPOINT: '/api/analyze',  // Proxied via server.js → Roboflow (no CORS issue)

  // API key lives in server.js — do NOT put it here.

  ROAD_WIDTH_METRES: 4.5,  // IRC:86 standard lane; user can override via UI

  // PWD Schedule of Rates (₹/m²)
  REPAIR_RATE_SMALL:  900,    // < 0.1 m²  (micro patch)
  REPAIR_RATE_MEDIUM: 700,    // 0.1–0.5 m² (standard patch)
  REPAIR_RATE_LARGE:  573,    // > 0.5 m²  (PWD base rate)
  REPAIR_MOBILIZATION: 500,   // ₹ flat call-out per pothole (labour fixed cost)

  COST_PER_POTHOLE: 2500,           // fallback only
  ABRASION_MODERATE_THRESHOLD: 5,
  ABRASION_CRITICAL_THRESHOLD: 12,

  GRAPH_HISTORY_POINTS: 60,         // Points in waveform graph
  ZBAR_COUNT: 28,                   // Bars in Z-axis visualizer
  MAX_COST_BAR: 50000,              // Max value for cost bar (100%)
};


/* ─────────────────────────────────────────────────
   2. STATE MANAGEMENT
───────────────────────────────────────────────── */
const State = {
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
  apiConnected: false,

  scanProgress: 0,
  rollingCounts: [],        // Last 5 frame counts for smoothed skid/quality
  rollingAreaSeverity: [],  // Last 5 frame area-severity scores (replaces count for scoring)
  cumulativeAreaSeverity: 0,
  totalFramesWithSeverity: 0,
  severityHistory: [],
  lastAnalyzedVideoTime: -1, // video.currentTime at last API call — prevents duplicate frames

  gps: { lat: 18.5204, lng: 73.8567, simulated: true }, // Pune fallback until real GPS arrives
  detectionLog: [],   // { timestamp, lat, lng, count, repairCost } — capped at 50
  hasZAxisData: true,
  isLiveSensorActive: false,
  csvZData: [],
  
  validationFrames: [],
  validatedPotholesCount: 0,
  validatedRepairCost: 0,
  
  currentTWP: 0,
  currentFrameW: 640,
  currentFrameH: 360,
  lastProcessingTime: 0,
  currentFPS: 0,
};

function captureCurrentFrame() {
  const video = document.getElementById('roadVideo');
  const offscreen = document.createElement('canvas');
  
  const origW = video.videoWidth || 640;
  const origH = video.videoHeight || 360;
  
  // Force downscale to 640px to prevent AI hallucinations & speed up API
  const targetW = 640;
  const targetH = Math.round((origH / origW) * targetW);

  offscreen.width = targetW;
  offscreen.height = targetH;
  const ctx = offscreen.getContext('2d');
  ctx.drawImage(video, 0, 0, targetW, targetH);
  
  return {
    base64: offscreen.toDataURL('image/jpeg', 0.8).split(',')[1],
    width: targetW,
    height: targetH
  };
}

/* ─────────────────────────────────────────────────
   3. API INTEGRATION — Roboflow
───────────────────────────────────────────────── */

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

async function runAnalysis() {
  // Skip if video hasn't moved ≥0.8s — prevents duplicate frame analysis.
  const video = document.getElementById('roadVideo');
  if (video && video.readyState >= 2) {
    const isLiveStream = !!video.srcObject; // Check if we are using Live Cam
    const timeSinceLast = video.currentTime - State.lastAnalyzedVideoTime;
    
    // Only enforce the 0.8s delay on uploaded videos, NOT live streams
    if (!isLiveStream && timeSinceLast < 0.8) {
      console.log(`[TreadGuard] ⏭ Skipping — video only moved ${timeSinceLast.toFixed(2)}s`);
      return;
    }
    State.lastAnalyzedVideoTime = video.currentTime;
  }

  setScanBusy(true);

  try {
    const result = await analyzeFrame();
      const data = result.data;
      const base64Image = result.frameObj.base64;
      const imgW = result.frameObj.width;
      const imgH = result.frameObj.height;

      let count = 0;
      let predictions = [];

      console.log('[TreadGuard] Raw response keys:', Object.keys(data));

      if (data.outputs && Array.isArray(data.outputs)) {
        for (const output of data.outputs) {

          if (typeof output.count_objects === 'number') {
            count = output.count_objects;
            if (output.predictions?.predictions && Array.isArray(output.predictions.predictions)) {
              predictions = output.predictions.predictions;
            } else if (Array.isArray(output.predictions)) {
              predictions = output.predictions;
            }
            console.log(`[TreadGuard] ✓ count_objects=${count}, predictions=${predictions.length}`);
            break;
          }

          if (output.predictions?.predictions && Array.isArray(output.predictions.predictions)) {
            predictions = output.predictions.predictions;
            count = predictions.length;
            break;
          }
          if (Array.isArray(output.predictions)) {
            predictions = output.predictions;
            count = predictions.length;
            break;
          }
          if (typeof output.count === 'number') {
            count = output.count;
          }
        }
      } else if (data.predictions) {
        predictions = Array.isArray(data.predictions) ? data.predictions : [];
        count = predictions.length;
      }

      // Synthesise placeholder boxes when count > 0 but no coordinates returned
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

      // Sync CSV telemetry to current video position
      if (State.csvZData.length > 0) {
        const vid = document.getElementById('roadVideo');
        if (vid && vid.duration) {
          const progress = vid.currentTime / vid.duration;
          const index = Math.min(Math.floor(progress * State.csvZData.length), State.csvZData.length - 1);
          processZAxisReading(State.csvZData[index]);
        }
      }

    } catch (err) {
    console.error('[TreadGuard] API call failed:', CONFIG.ROBOFLOW_ENDPOINT, err.message || err);
    State.apiConnected = false;
    updateFooterLights(false);
  }

  setScanBusy(false);
  document.getElementById('frameCounter').textContent = State.framesAnalyzed;
}

/* ─────────────────────────────────────────────────
   4. DETECTION DATA PROCESSOR & DOM UPDATERS
───────────────────────────────────────────────── */

function processDetectionData(count, detections, base64Image = null, imgW = 640, imgH = 360) {
  State.currentFrameW = imgW;
  State.currentFrameH = imgH;

  // Filter: ≥65% confidence, not oversized, AND within Region of Interest (ROI)
  const filtered = detections.filter(d => {
    const conf = d.confidence ?? 1;
    const normalizedConf = conf > 1 ? conf / 100 : conf;
    
    // Use dynamic frame sizes from our previous fix
    const isTooWide = d.width > (imgW * 0.60);
    const isTooTall = d.height > (imgH * 0.60);
    
    // ROI MASK: Ignore the top 40% of the frame (sky, horizon, distant cars)
    const isBelowHorizon = d.y > (imgH * 0.40);

    return normalizedConf >= 0.65 && !isTooWide && !isTooTall && isBelowHorizon;
  });

  if (filtered.length > 0 && base64Image) {
    State.validationFrames.push({
      id: Date.now() + Math.random(),
      image: base64Image,
      width: imgW,
      height: imgH,
      predictions: JSON.parse(JSON.stringify(filtered))
    });
    if (State.validationFrames.length > 30) State.validationFrames.shift();
  }

  const currentVisibleCount = filtered.length;

  // Tripwire accumulator — bottom-half zone (y > 180) with 1.2s cooldown to prevent double-counting
  let newPotholesCrossedLine = 0;
  const now = Date.now();

  if (now - (State.lastTripwireTime || 0) > 1200) {
    const potholesInZone = filtered.filter(det => det.y > 180);
    if (potholesInZone.length > 0) {
      newPotholesCrossedLine = potholesInZone.length;
      State.lastTripwireTime = now;
    }
  }

  const prev = State.potholeCount;
  State.potholeCount = currentVisibleCount;
  State.sessionTotal += newPotholesCrossedLine;
  State.detections = filtered;

  State.sparklineHistory.push(currentVisibleCount);
  if (State.sparklineHistory.length > 10) State.sparklineHistory.shift();

  State.rollingCounts.push(currentVisibleCount);
  if (State.rollingCounts.length > 5) State.rollingCounts.shift();
  const rollingAvg = Math.round(
    State.rollingCounts.reduce((a, b) => a + b, 0) / State.rollingCounts.length
  );

  animateScanProgress();
  driftCoordinates();

  // Area-based repair cost (PWD tiered rates)
  const frameCost = calculateFrameCost(filtered);
  State.totalRepairCost += newPotholesCrossedLine > 0
    ? frameCost * (newPotholesCrossedLine / Math.max(1, filtered.length))
    : 0;

  // Area-severity = total pothole area (m²) × 20; used for abrasion/skid/quality scoring
  const frameAreaSqM = filtered.reduce((sum, d) => sum + (d._metrics?.areaSqM ?? 0), 0);
  const frameAreaSeverity = frameAreaSqM * 20;

  State.severityHistory.push(frameAreaSeverity);
  State.rollingAreaSeverity.push(frameAreaSeverity);
  if (State.rollingAreaSeverity.length > 3) State.rollingAreaSeverity.shift();
  const rollingSeverity = State.rollingAreaSeverity.reduce((a, b) => a + b, 0) / State.rollingAreaSeverity.length;

  State.cumulativeAreaSeverity += frameAreaSeverity;
  State.totalFramesWithSeverity++;

  const displaySeverity = currentVisibleCount === 0 ? 0 : rollingSeverity;

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

  updatePotholeCounter(currentVisibleCount, prev);
  updateRepairCost(Math.round(State.totalRepairCost));
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

function calcPotholeMetrics(det) {
  // 640px model width = roadWidthMetres in real world
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

  animateNumber(el, prevCount, count, 400);

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
  // score = 100 - (severity × 7); severity = rolling avg of (total m² × 20)
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

  // --- REAL FPS CALCULATOR ---
  const now = Date.now();
  if (State.lastProcessingTime) {
    const dt = now - State.lastProcessingTime;
    if (dt > 0) {
      const rawFps = Math.round(1000 / dt);
      // 70/30 Moving Average to prevent aggressive text flickering
      State.currentFPS = Math.round((State.currentFPS * 0.7) + (rawFps * 0.3)); 
    }
  }
  State.lastProcessingTime = now;

  document.getElementById('hudFPS').textContent = `${State.currentFPS || 0} FPS`;
  // ---------------------------
  document.getElementById('hudTimestamp').textContent = new Date().toLocaleTimeString('en-IN', { hour12: false });
}

/* ── Sparkline ── */
function updateSparkline() {
  const container = document.getElementById('sparkline');
  const history   = State.sparklineHistory;
  const max       = Math.max(...history, 1);

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

/* ── Annotated Frame Renderer ── */
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

  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (!detections || detections.length === 0) return;

  // Dynamically scale based on what was actually sent to the AI
  const fw = State.currentFrameW || 640;
  const fh = State.currentFrameH || 360;

  const scaleX = canvas.width  / fw;
  const scaleY = canvas.height / fh;

  detections.forEach((det, i) => {
    const x = (det.x - det.width / 2)  * scaleX;
    const y = (det.y - det.height / 2) * scaleY;
    const w = det.width  * scaleX;
    const h = det.height * scaleY;

    const conf = det.confidence ?? 0.85;

    const color = conf > 0.85 ? '#ef4444' :
                  conf > 0.70 ? '#f59e0b' : '#00e5a0';

    ctx.save();

    ctx.shadowColor  = color;
    ctx.shadowBlur   = 10;

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

/* ── Hardware Debounce Fix ── */
  if (absGz > 0.5) {
    const now = Date.now();
    // Only count a new event if 600ms have passed since the last one
    if (!State.zAxis.lastEventTime || (now - State.zAxis.lastEventTime > 600)) {
      State.zAxis.events++;
      State.zAxis.lastEventTime = now;
    }
  }

  State.roughnessHistory.push(absGz);
  if (State.roughnessHistory.length > CONFIG.GRAPH_HISTORY_POINTS) {
    State.roughnessHistory.shift();
  }

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

  const avgG = State.zAxis.readings.length > 0 
    ? State.zAxis.readings.reduce((a, b) => a + b, 0) / State.zAxis.readings.length 
    : 0;
  const events = State.zAxis.events;

  const baseFriction = 0.067; // mg/km per kg of mass
  const roughnessMultiplier = 1 + (avgG * 1.5);
  const impactMultiplier = 1 + (events * 0.02);
  
  const rawEmission = totalMass * baseFriction * roughnessMultiplier * impactMultiplier;
  State.currentTWP = parseFloat(rawEmission.toFixed(2));

  valEl.textContent = State.currentTWP.toFixed(2);
  
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
      // 1. Try to get pure acceleration (Earth's gravity automatically removed by hardware)
      let z = event.acceleration?.z;

      // 2. Fallback for older phones: use raw sensor but mathematically subtract Earth's 9.81m/s² gravity
      if (z === null || z === undefined) {
        z = event.accelerationIncludingGravity?.z;
        if (z !== null && z !== undefined) {
          z = z - 9.81; 
        }
      }

      if (z === null || z === undefined) {
        setSensorError('Sensor data unavailable on this device.');
        return;
      }
      State.isLiveSensorActive = true;
      State.hasZAxisData = true;
      
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

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(0, 210, 106, 0.65)'); // Much stronger top color
  grad.addColorStop(1, 'rgba(0, 210, 106, 0.05)'); // Leaves a subtle base tint

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

  ctx.beginPath();
  ctx.strokeStyle = 'var(--accent)';
  ctx.lineWidth   = 2.5;
  ctx.shadowColor = 'var(--accent)';
  ctx.shadowBlur  = 12;
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

  ctx.beginPath();
  ctx.arc(cx, cy, r, startAngle, endAngle);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = 10;
  ctx.lineCap     = 'round';
  ctx.stroke();

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

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = lw;
  ctx.stroke();

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

/** Smoothly animate a number in a DOM element; currency=true uses Indian locale */
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

/** Flash card background on data update */
function flashCard(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('card-flash');
  void el.offsetWidth; // force reflow
  el.classList.add('card-flash');
}

function animateScanProgress() {
  const fill = document.getElementById('scanProgress');
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

/** Slightly drift GPS coordinates */
function driftCoordinates() {
  const latBase = 18.5204, lngBase = 73.8567;
  const lat = (latBase + (Math.random() - 0.5) * 0.002).toFixed(4);
  const lng = (lngBase + (Math.random() - 0.5) * 0.002).toFixed(4);
  document.getElementById('hudLat').textContent = `LAT ${lat}°N`;
  document.getElementById('hudLng').textContent  = `LNG ${lng}°E`;
}

function setScanBusy(busy) {
  const el = document.getElementById('scanStatusText');
  el.textContent = busy ? 'SCANNING FRAME…' : 'FRAME PROCESSED ✓';
  if (!busy) setTimeout(() => { el.textContent = 'SCANNING FRAME…'; }, 800);
}

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

  if (confirm) {
    confirm.addEventListener('click', (ev) => {
      modal.hidden = true;
      const analyzeBtnEl = document.getElementById('analyzeBtn');
      if (analyzeBtnEl) {
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

    // Stop scanner and reset state on new upload
    const analyzeBtn = document.getElementById('analyzeBtn');
    if (analyzeBtn && analyzeBtn.innerText.includes('Stop')) analyzeBtn.click();

    const resetBtn = document.getElementById('resetBtn');
    if (resetBtn) resetBtn.click();

    

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
      
      // Skip metadata comment lines, find header row
      let headerIdx = 0;
      while (headerIdx < lines.length && lines[headerIdx].trim().startsWith('#')) {
        headerIdx++;
      }

      if (headerIdx < lines.length) {
        const headers = lines[headerIdx].toLowerCase().split(',');
        let isTotalG = false;

        // Prefer TgF (Total G-Force) column, fall back to Z-axis
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
        
        for (let i = headerIdx + 1; i < lines.length; i++) {
          const cols = lines[i].split(',');
          if (cols.length > zIndex) {
            let val = parseFloat(cols[zIndex]);
            if (!isNaN(val)) {
              if (isTotalG) val = val - 1.0; // subtract baseline gravity
              State.csvZData.push(val);
            }
          }
        }
      }
      
      State.zAxis.peak = 0;
      descText += `\nTelemetry CSV synced (${State.csvZData.length} records).`;
      State.hasZAxisData = true;
      document.getElementById('sensorStatusText').textContent = 'Telemetry synced from CSV.';
      document.getElementById('flSensor').style.background = 'var(--accent)';
      document.querySelector('.sensor-dot').className = 'sensor-dot sensor-dot--active';
    } else if (mediaFile) {
      State.csvZData = [];
      if (!State.isLiveSensorActive) {
        State.hasZAxisData = false;
        setZAxisNoData();
      }
    }

    desc.textContent = descText || "Ready for analysis.";
    modal.hidden = false;
    e.target.value = '';
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

  const maxBars = 150; // subsample to avoid squished bars on long sessions
  const step = Math.max(1, Math.floor(State.severityHistory.length / maxBars));
  const sampledHistory = State.severityHistory.filter((_, i) => i % step === 0);
  const maxSev = Math.max(...sampledHistory, 15); // Baseline scale
  
  const graphHtml = `
    <h3 style="margin-top: 30px;">Route Severity Timeline</h3>
    <div style="display: flex; align-items: flex-end; height: 120px; gap: 2px; border-bottom: 2px solid #ddd; padding-bottom: 5px; margin-bottom: 30px;">
      ${sampledHistory.map(sev => {
        const heightPct = Math.max(2, Math.min(100, (sev / maxSev) * 100));
        const color = sev > CONFIG.ABRASION_CRITICAL_THRESHOLD ? '#ef4444' : 
                     (sev > CONFIG.ABRASION_MODERATE_THRESHOLD ? '#f59e0b' : '#00e5a0');
        return `<div style="flex: 1; background-color: ${color}; height: ${heightPct}%; border-radius: 2px 2px 0 0;"></div>`;
      }).join('')}
    </div>
  `;

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
    </body>
    </html>
  `;

  openHtmlForPrint(html, 'TreadGuard_Manual_Report.html');
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

  let manualEvents = [];
  let manualSeverityTimeline = [];

  State.validationFrames.forEach(frame => {
    const validPreds = frame.predictions.filter(p => p._status === 'validated');
    
    const frameAreaSqM = validPreds.reduce((sum, p) => sum + (p._metrics?.areaSqM ?? 0), 0);
    const frameSeverity = frameAreaSqM * 20;
    manualSeverityTimeline.push(frameSeverity);

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
    </body>
    </html>
  `;

  openHtmlForPrint(html, 'TreadGuard_TWP_Report.html');
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
    </body>
    </html>
  `;

  openHtmlForPrint(html, 'TreadGuard_Report.html');
}

function openHtmlForPrint(html, filename = 'report.html') {
  try {
    let finalHtml = html.replace('<head>', '<head>\n      <meta charset="UTF-8">');

    const printScript = `<script>window.onload = () => { setTimeout(() => window.print(), 500); };</script></body>`;
    finalHtml = finalHtml.replace('</body>', printScript);

    const blob = new Blob([finalHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    const win = window.open(url, '_blank');

    if (!win) {
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }

    setTimeout(() => URL.revokeObjectURL(url), 60000); // release blob memory after 1min

  } catch (err) {
    console.error('[TreadGuard] openHtmlForPrint failed', err);
  }
}
/* ─────────────────────────────────────────────────
   12. UI CONTROLS & CLOCK
───────────────────────────────────────────────── */
function initControls() {
  let scanInterval = null;
  let isScanning = false;
  const analyzeBtn = document.getElementById('analyzeBtn');
  const video = document.getElementById('roadVideo');

  function getVehicleSpeedKmph() {
    const el = document.getElementById('vehicleSpeedKmph');
    if (!el) return 30;
    const v = parseFloat(el.value || '0');
    if (isNaN(v) || v <= 0) return 5; // walking pace fallback
    return Math.min(200, Math.max(1, v));
  }

  function getRoadWidthMetres() {
    const el = document.getElementById('roadWidthMetres');
    if (!el) return State.roadWidthMetres || 3.5;
    const v = parseFloat(el.value);
    if (isNaN(v) || v <= 0) return State.roadWidthMetres || 3.5;
    // clamp to a reasonable 1–12m range
    return Math.min(12, Math.max(1, v));
  }

  // Adaptive delay: estimates time until nearest pothole reaches the tripwire,
  // then schedules the next capture just before that moment.
  function computeAdaptiveDelay(speedKmph, detections = []) {
    const minMs = 300;
    const maxMs = 2500;
    const defaultMs = 500;

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
        bestMs = Math.min(bestMs, 900);
        continue;
      }

      const distanceM = distancePx * mPerPx;
      const timeS = distanceM / speedMps; // seconds until it crosses tripwire

      const desiredMs = Math.round(timeS * 1000 * 0.6); // sample at ~60% of approach time
      if (desiredMs > 0) bestMs = Math.min(bestMs, desiredMs);
    }

    bestMs = Math.min(maxMs, Math.max(minMs, bestMs));
    return bestMs;
  }


  function stopScanning() {
    isScanning = false;
    clearInterval(scanInterval);
    clearTimeout(scanInterval);
    scanInterval = null;
    analyzeBtn.innerHTML = 'Start Auto-Scan';
    analyzeBtn.style.background = 'var(--bg-card)';
    analyzeBtn.style.color = 'var(--text-secondary)';
  }

  (function initRoadWidthInput() {
    const el = document.getElementById('roadWidthMetres');
    if (!el) return;
    el.value = State.roadWidthMetres || 3.5;
    el.addEventListener('change', () => {
      const w = getRoadWidthMetres();
      State.roadWidthMetres = w;
      console.log(`[TreadGuard] Road width calibrated to ${w} m`);
    });
  })();

  const vehInput = document.getElementById('twVehicleType');
  const paxInput = document.getElementById('twPax');
  if (vehInput) vehInput.addEventListener('change', updateTireWearModel);
  if (paxInput) paxInput.addEventListener('input', updateTireWearModel);

  video.addEventListener('ended', () => {
    if (isScanning) {
      stopScanning();
      document.getElementById('scanStatusText').textContent = 'AWAITING HUMAN AUDIT ✓';
      document.getElementById('scanStatusText').style.color = '#3b82f6';
      console.log('[TreadGuard] AI scan complete.');

      const validationDashboard = document.getElementById('validationDashboard');
      if (validationDashboard && State.validationFrames.length > 0) {
        validationDashboard.style.display = 'block';
        renderValidationFrames();
        
        setTimeout(() => {
          validationDashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
          validationDashboard.style.transition = 'box-shadow 0.6s ease-out';
          validationDashboard.style.boxShadow = '0 0 40px rgba(59, 130, 246, 0.4)';
          setTimeout(() => { validationDashboard.style.boxShadow = 'none'; }, 1500);
        }, 300);
      }
    }
  });

  analyzeBtn.addEventListener('click', (e) => {
    // --- iOS SENSOR PERMISSION ---
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      DeviceMotionEvent.requestPermission().catch(() => console.log('Sensor permission pending'));
    }
      // -----------------------------

    isScanning = !isScanning;


    if (isScanning) {
      e.target.innerHTML = 'Stop Scanning';
      e.target.style.background = 'var(--red)';
      e.target.style.color = '#fff';

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

      let prevDelay = 500;

      async function scheduleNext() {
        const speed = getVehicleSpeedKmph();
        const delay = computeAdaptiveDelay(speed, State.detections) || 500;
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

  /* ── Live Camera Button ── */
  const liveCamBtn = document.getElementById('liveCamBtn');
  if (liveCamBtn) {
    liveCamBtn.addEventListener('click', async () => {
      try {
        // Request the rear-facing camera
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false
        });
        
        // Feed the live stream into the video element
        video.src = ''; // Clear any uploaded file
        video.srcObject = stream;
        
        // Wait for it to load, then play
        video.onloadedmetadata = () => {
          video.play();
          console.log('[TreadGuard] Live camera active.');
          
          // Optional: Force stop scanner if it was running on an old video
          if (isScanning) analyzeBtn.click();
        };

      } catch (err) {
        console.error('[TreadGuard] Camera access failed:', err);
        alert('Could not access the camera. Please make sure camera permissions are allowed in your browser settings.');
      }
    });
  }

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
        // Confidence badge (e.g. "88%") shown on every bbox
        const confBadge = document.createElement('div');
        confBadge.className = 'vd-confidence';
        const pct = Math.round((det.confidence ?? 1) * 100);
        confBadge.textContent = `${pct}%`;
        bbox.appendChild(confBadge);

        const actions = document.createElement('div');
        actions.className = `vd-actions ${det._status !== 'pending' ? 'hidden' : ''}`;
        
        // --- ADD THESE 6 LINES BACK IN ---
        const tickBtn = document.createElement('button');
        tickBtn.className = 'vd-btn vd-btn-tick';
        tickBtn.textContent = '✓';
        
        const crossBtn = document.createElement('button');
        crossBtn.className = 'vd-btn vd-btn-cross';
        crossBtn.textContent = '✕';
        
        // Operator confirmed Pothole
        tickBtn.onclick = () => {
          if (det._status === 'validated') return; // Ignore if already validated
          
          // If previously rejected, clear the red border
          if (det._status === 'rejected') {
            bbox.classList.remove('rejected'); 
          }
          
          det._status = 'validated';
          bbox.classList.add('validated');
          // Removed the 'hidden' action so buttons stay visible!
          
          State.validatedPotholesCount++;
          if (!det._metrics) det._metrics = calcPotholeMetrics(det);
          State.validatedRepairCost += det._metrics.cost;
          
          updateValidationCounters();
        };

        // Operator rejected false positive
        crossBtn.onclick = () => {
          if (det._status === 'rejected') return; // Ignore if already rejected
          
          // UNDO THE MATH if user is changing mind from Validated -> Rejected
          if (det._status === 'validated') {
            bbox.classList.remove('validated');
            State.validatedPotholesCount--;
            State.validatedRepairCost -= (det._metrics?.cost || 0);
            updateValidationCounters();
          }

          det._status = 'rejected';
          bbox.classList.add('rejected');
          // Removed the 'hidden' action so buttons stay visible!
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
 * On deny / unsupported: falls back to Pune and logs a warning.
 */
function initGPS() {
  if (!navigator.geolocation) {
    console.warn('[TreadGuard] Geolocation not supported — using Pune fallback.');
    State.gps = { lat: 18.5204, lng: 73.8567, simulated: true };
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
      console.warn('[TreadGuard] GPS denied — using Pune fallback.', err.message);
      State.gps = { lat: 18.5204, lng: 73.8567, simulated: true };
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

  ctx.fillStyle = '#080c10';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(0,229,160,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 30) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 30) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

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

  const lats   = log.map(e => e.lat);
  const lngs   = log.map(e => e.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  // guard against all-same coords (simulated GPS)
  const latRange = maxLat - minLat || 0.001;
  const lngRange = maxLng - minLng || 0.001;

  const PAD  = 22;
  const mapW = W - PAD * 2;
  const mapH = H - PAD * 2 - 18; // reserve bottom 18px for legend

  ctx.strokeStyle = 'rgba(0,229,160,0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  log.forEach((e, i) => {
    const x = PAD + ((e.lng - minLng) / lngRange) * mapW;
    const y = PAD + (1 - (e.lat - minLat) / latRange) * mapH;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();

  log.forEach((e, i) => {
    const x = PAD + ((e.lng - minLng) / lngRange) * mapW;
    const y = PAD + (1 - (e.lat - minLat) / latRange) * mapH;

    const color = e.count > 7  ? '#ef4444'
                : e.count >= 3 ? '#f59e0b'
                :                '#00e5a0';

    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = color + '22';
    ctx.fill();

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
   14. INITIALIZER
───────────────────────────────────────────────── */
function drawPlaceholder() {
  const canvas    = document.getElementById('roadBgCanvas');
  const container = document.getElementById('mediaContainer');
  if (!canvas || !container) return;

  canvas.width  = container.offsetWidth;
  canvas.height = container.offsetHeight;
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(0,229,160,0.04)';
  ctx.lineWidth = 1;
  const step = 40;
  for (let x = 0; x < W; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0; y < H; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  const cx = W / 2, cy = H / 2 - 18;
  const r = 36;
  ctx.strokeStyle = 'rgba(0,229,160,0.25)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(0,229,160,0.55)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy + 14); ctx.lineTo(cx, cy - 14);          // stem
  ctx.moveTo(cx - 10, cy - 4); ctx.lineTo(cx, cy - 14);      // left wing
  ctx.moveTo(cx + 10, cy - 4); ctx.lineTo(cx, cy - 14);      // right wing
  ctx.stroke();

  ctx.font = '600 11px "Space Mono", monospace';
  ctx.fillStyle = 'rgba(0,229,160,0.35)';
  ctx.textAlign = 'center';
  ctx.fillText('UPLOAD FOOTAGE TO BEGIN', cx, cy + r + 22);

  ctx.textAlign = 'left';
}

function init() {
  console.log('%c[TreadGuard CV] Initializing…', 'color:#00e5a0; font-weight:bold;');

  drawPlaceholder();

  buildZAxisBars();

  drawQualityRing(100);
  drawSkidGauge(0);
  drawRoughnessGraph(State.roughnessHistory);

  initUploadHandler();

  initControls();

  startSessionClock();

  initGPS();

  initZAxisSensor();

  window.addEventListener('resize', () => {
    const vid = document.getElementById('roadVideo');
    const hasVideo = vid.src && vid.readyState >= 1;
    if (!hasVideo) drawPlaceholder();
    renderDetectionBoxes(State.detections);
    drawRoughnessGraph(State.roughnessHistory);
  });

  drawMiniMap();

  processDetectionData(0, []);

  console.log('%c[TreadGuard CV] Ready ✓', 'color:#00e5a0; font-weight:bold;');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
