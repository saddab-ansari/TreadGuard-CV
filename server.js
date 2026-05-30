/**
 * TreadGuard CV — Local Proxy Server
 * ────────────────────────────────────
 * Why this exists:
 *   Roboflow's serverless.roboflow.com does NOT send CORS headers,
 *   so direct browser → Roboflow calls are blocked.
 *   This server sits in the middle:
 *     Browser  →  POST /api/analyze  →  THIS SERVER  →  Roboflow  →  back
 *
 * Usage:
 *   npm install          (first time only)
 *   node server.js       (then open http://localhost:3000)
 */
require('dotenv').config();
const express  = require('express');
const fetch    = require('node-fetch');
const path     = require('path');

const app  = express();
const PORT = 3000;

// ── Roboflow config ────────────────────────────────────────────────────────
const ROBOFLOW_API_KEY  = process.env.ROBOFLOW_API_KEY; // key
const ROBOFLOW_ENDPOINT =
  'https://serverless.roboflow.com/infer/workflows/saddabs-workspace/detect-count-and-visualize';

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));   // large base64 images need room
app.use(express.static(path.join(__dirname))); // serve index.html / app.js / styles.css

// ── Proxy route ────────────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const { image } = req.body;   // base64 string, no data-URI prefix

    if (!image) {
      return res.status(400).json({ error: 'No image provided' });
    }

    const rfResponse = await fetch(ROBOFLOW_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: ROBOFLOW_API_KEY,
        inputs: {
          image: { type: 'base64', value: image }
        },
        use_cache: true
      })
    });

    if (!rfResponse.ok) {
      const errText = await rfResponse.text();
      console.error('[Proxy] Roboflow error:', rfResponse.status, errText);
      return res.status(rfResponse.status).json({
        error: `Roboflow returned ${rfResponse.status}`,
        detail: errText
      });
    }

    const data = await rfResponse.json();

    // Log a summary (not the whole base64 blob) for easy debugging
    console.log('[Proxy] Roboflow response keys:', Object.keys(data));
    if (data.outputs) {
      console.log('[Proxy] outputs[0] keys:', Object.keys(data.outputs[0] || {}));
    }

    res.json(data);

  } catch (err) {
    console.error('[Proxy] Unexpected error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  TreadGuard CV running at → http://localhost:${PORT}\n`);
});
