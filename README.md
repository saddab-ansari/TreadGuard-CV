# 🛣️ TreadGuard CV

**Predictive Road Audits & Tire Abrasion Analytics Platform**

[![JavaScript](https://img.shields.io/badge/Vanilla-JS-F7DF1E?style=flat-square&logo=javascript&logoColor=black)]()
[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?style=flat-square&logo=node.js&logoColor=white)]()
[![Roboflow](https://img.shields.io/badge/Roboflow-AI_Vision-6706CE?style=flat-square&logo=roboflow&logoColor=white)]()

TreadGuard CV is a real-time, browser-based infrastructure intelligence platform. It transforms a standard smartphone into a road auditing tool by fusing computer vision with live hardware telemetry (Z-axis G-force).

By identifying potholes, tracking physical bump severity, and predicting environmental microplastic emissions, TreadGuard CV bridges the gap between public infrastructure auditing and environmental conservation — and keeps a human in the loop on every detection before it becomes a certified report.

---

## 🚀 Live Deployment (Try It Now)
The system is fully deployed and ready for instant testing — no setup required:

👉 **[Live App — treadguard-cv.onrender.com](https://treadguard-cv.onrender.com)**

*First load may take ~1 minute (free-tier cold start). It's instant after that.*

---

## ✨ Core Features

* **Real-Time Computer Vision** — Processes video feeds (live camera or uploaded MP4) through a Roboflow detection workflow, drawing precision bounding boxes around road defects.

* **Hardware Telemetry Fusion** — Integrates with the browser's `DeviceMotion` API to capture live Z-axis accelerometer data, measuring the physical G-force impact of every bump. Also accepts CSV-recorded accelerometer data, synced to video playback.

* **Human-in-the-Loop Validation** — A manual auditing dashboard where operators review every AI detection and certify or reject it before it counts toward a cost estimate. The AI flags candidates; the human makes the call.

* **Automated Financial Mapping** — Calculates the real-world area (m²) of each road defect via pixel-to-metre calibration, then applies tiered Public Works Department (PWD) rates (₹573–₹900/m²) to generate instant, defensible repair cost estimates.

* **Predictive Microplastic Emission Modeling** — Estimates tire wear particle (TWP) emissions in real time based on vehicle mass, passenger load, and live road roughness.

* **One-Click Certified Reporting** — Exports three distinct PDF reports: a raw AI audit, a human-certified manual audit, and a TWP environmental report — each timestamped and ready to share.

---

## 🔬 Predictive Microplastic Emission Engine

Degraded roads accelerate the shedding of Tire Wear Particles (TWP) into the environment — a source of microplastic pollution that's measurable but rarely tracked. TreadGuard CV estimates these emissions in real time using a formula grounded in published TRWP research (see the technical manual for full derivation and citations).

The model calculates estimated emission ($E_{twp}$) in mg/km as:

$E_{twp} = [W_{veh} + (N \times 68)] \times \beta \times [1 + (G_{avg} \times 1.5)] \times [1 + (E_{bump} \times 0.02)]$

**Parameters:**
* **$W_{veh}$** — Base vehicle kerb weight (kg)
* **$N$** — Passenger count (avg. 68 kg/person)
* **$\beta$** — Base friction constant (0.067 mg/km/kg)
* **$G_{avg}$** — Rolling Z-axis roughness (live hardware data)
* **$E_{bump}$** — Significant hardware impact events (>0.5G)

Full derivation, coefficient sourcing, and academic references are in `ARCHITECTURE.md`.

---

## 🧩 Setting Up Your Own Roboflow Workflow

TreadGuard CV doesn't ship with its own trained model — it calls a **Roboflow Workflow** for pothole detection. If you want to run this project with your own API key (rather than just using the live demo above), you'll need to set up a Workflow on Roboflow first.

1. **Create a free Roboflow account** at [roboflow.com](https://roboflow.com).
2. **Find or build a pothole detection model.** The fastest route is Roboflow Universe — search ["pothole detection"](https://universe.roboflow.com/) and clone an existing public model into your own workspace. Alternatively, train your own using a labeled pothole dataset.
3. **Build a Workflow around your model.** In the Roboflow dashboard, go to **Workflows → Create Workflow**, add your model as a detection block, and deploy it. A Workflow (rather than a raw model endpoint) is what TreadGuard CV expects — it's what handles the inference call structure used in this project.
4. **Grab your credentials** — your **Workspace name**, **Workflow ID**, and **API key**, all visible on your Workflow's deployment page.
5. **Plug them into *.env* file** (see the Environment Variables setup below).

> 📌 **The exact Workflow used in the original build:** *[Roboflow Workflow link here](https://app.roboflow.com/saddabs-workspace/solutions/chat?workflowUrl=pothole-detection)*

This project will work with any Roboflow object-detection Workflow that returns bounding boxes for road defects — you aren't locked into the exact model used during development. Swapping in a better-trained or region-specific model is one of the easiest ways to improve detection accuracy.

---

## ⚙️ Running This Locally

The live deployment above is the easiest way to try TreadGuard CV. If you'd like to run it yourself with your own Roboflow credentials:

1. **Clone the repository** and open a terminal in the root directory.
2. **Install dependencies:**
   ```bash
   npm install
   ```
   (installs `express`, `cors`, `dotenv`, `axios`)
3. **Create a `.env` file** in the root directory (see `.env.example` for the format).
4. **Add your Roboflow credentials** to `.env`:
   ```
   ROBOFLOW_API_KEY=your_api_key_here
   ROBOFLOW_WORKSPACE=your_workspace_name
   ROBOFLOW_WORKFLOW_ID=your_workflow_id
   ```
5. **Start the server:**
   ```bash
   node server.js
   ```
6. **Open `http://localhost:3000`** in your browser.

The API key is kept server-side on purpose — `server.js` acts as a secure proxy so the key never reaches the browser or gets committed to the repo. Don't put your key directly in `app.js` or any client-side file.

---

## 🛠️ Architecture & Tech Stack

* **Frontend** — Vanilla JavaScript, HTML5, and CSS3. No frameworks, no build step.
* **Backend / Proxy** — Node.js & Express, used solely to keep the Roboflow API key server-side.
* **AI Inference** — Roboflow Workflow API.
* **Sensors** — Web `Geolocation` API (GPS) and `DeviceMotionEvent` API (accelerometer).
* **Reporting** — Client-side HTML-to-PDF generation via the browser's print dialog.

No heavy frameworks — by design. This keeps the app lightweight, dependency-free, and usable even on low-end mobile devices in the field, which matters for a tool meant to be used during an actual road survey.

---

## 📂 Trial Material

Sample videos, accelerometer CSVs, and generated reports from real test drives in Pune (29 May 2026) are available here:

**[Google Drive — Trial Material](https://drive.google.com/drive/folders/1-8eQ4iDYx9ZRCtG_KEnP3ZtqFNQ5dION?usp=sharing)**

---

## 📖 Full Technical Manual

For calibration methodology, the full TWP formula derivation with academic citations, PWD rate basis, dashboard component reference, and known limitations — see `ARCHITECTURE.md` in this repo.

---

## 🏆 Origin

TreadGuard CV originated as a hackathon submission for the IIT Madras Road Safety 2026 event (Track: RoadWatch) under the team name Impactious. It is now maintained here as an independent, open-source technical portfolio project.

---

## 👤 Author & System Designer

**Saddab Sabir Ansari**  
IT Engineering | MMCOE

*Built during IIT Madras Road Safety Hackathon 2026. 
System architecture, domain research, and deployment by Saddab Ansari. 
Frontend implementation via AI-assisted development.*

📫 **Connect with me:**
* **LinkedIn:** [in/saddab-ansari](https://www.linkedin.com/in/saddab-ansari/)
* **Email:** [saddabansari254@gmail.com](mailto:saddabansari254@gmail.com)
