# 🛣️ TreadGuard CV 

**Predictive Road Audits & Tire Abrasion Analytics Platform**  
*Built for the IIT Madras Road Safety Hackathon 2026 (Problem Statement: RoadWatch)*

[![JavaScript](https://img.shields.io/badge/Vanilla-JS-F7DF1E?style=flat-square&logo=javascript&logoColor=black)]()
[![Node.js](https://img.shields.io/badge/Node.js-Backend-339933?style=flat-square&logo=node.js&logoColor=white)]()
[![Roboflow](https://img.shields.io/badge/Roboflow-AI_Vision-6706CE?style=flat-square&logo=roboflow&logoColor=white)]()

TreadGuard CV is a real-time, browser-based infrastructure intelligence platform. It transforms a standard smartphone into an enterprise-grade road auditing tool by fusing custom computer vision with live hardware telemetry (Z-Axis G-force). 

By identifying potholes, tracking physical bump severity, and predicting environmental microplastic emissions, TreadGuard CV bridges the gap between public works infrastructure and environmental conservation.

---

## 🚀 Live Deployment (Recommended for Evaluation)
The system is fully deployed, secured, and ready for instant testing here:  
👉 **[Live Link using render.com](https://treadguard-cv.onrender.com)**
*If you are entering this link for the first time then it might take a 1 minute to load. then it starts instantly next time.*

---

## ⚠️ Local Testing Instructions (Important)
If you wish to run this codebase locally from this repository, please note:  
As per enterprise security best practices, the Roboflow API key has been securely excluded from the source code. The live deployment uses secure environment variables via a Node.js proxy.

To run this on your local machine, you must manually inject the API key:

1. Clone the repository and open your terminal in the root directory.
2. Run `npm install` to install dependencies (`express`, `cors`, `dotenv`, `axios`).
3. Create a file named exactly `.env` in the root directory (refer to `.env.example`).
4. Add the following line to the `.env` file *(Key provided in submission portal/documentation for evaluation purposes only)*:
   `ROBOFLOW_API_KEY=your_api_key_here`
5. Run `node server.js` to start the secure proxy.
6. Open `http://localhost:3000` in your web browser.

*Note: For the best and fastest experience, please use the live Render deployment linked at the top of this document.*

---

## ✨ Core Features

*   **Real-Time Computer Vision:** Processes video feeds (live camera or uploaded MP4) using a custom-trained Roboflow detection model to draw precision bounding boxes around road hazards.

*   **Hardware Telemetry Fusion:** Integrates with the browser's `DeviceMotion` API to track live Z-Axis accelerometer data, accurately measuring the physical G-force impact of every bump.

*   **Human-in-the-Loop Validation:** Features a manual auditing dashboard where operators can certify or reject AI detections, guaranteeing 100% accuracy and eliminating false positives.

*   **Automated Financial Mapping:** Calculates the physical $m^2$ area of road defects and automatically applies standard Public Works Department (PWD) tiered rates (₹573–₹900/m²) to generate instant repair cost estimates.

*   **One-Click Certified Reporting:** Generates and exports comprehensive, timestamped PDF reports featuring severity timelines and high-cost detection GPS events.

---

## 🔬 Predictive Microplastic Emission Engine
Degraded roads drastically accelerate the shedding of Tire Wear Particles (TWP) into the environment. TreadGuard CV utilizes a proprietary physics algorithm to predict these emissions in real-time.

The model calculates the estimated emission ($E_{twp}$) in mg/km using the following logic:

$E_{twp} = [W_{veh} + (N \times 68)] \times \beta \times [1 + (G_{avg} \times 1.5)] \times [1 + (E_{bump} \times 0.02)]$

**Parameters:**
*   **$W_{veh}$**: Base Vehicle Weight (kg)
*   **$N$**: Passenger Count (Assumed 68kg average)
*   **$\beta$**: Base Friction Constant (0.067 mg/km/kg)
*   **$G_{avg}$**: Rolling Z-Axis Roughness (Live hardware data)
*   **$E_{bump}$**: Significant Hardware Impact Events (>0.5G)

*(This model is grounded in current academic research regarding tire abrasion and microplastic pollution.)*

---

## Trial Material

Sample videos, accelerometer CSVs, and generated reports from test drives in Pune (29 May 2026)
are available here: **[Google Drive](https://drive.google.com/drive/folders/1-8eQ4iDYx9ZRCtG_KEnP3ZtqFNQ5dION?usp=sharing)**

## 🛠️ Architecture & Tech Stack

*   **Frontend:** Pure, lightweight Vanilla JavaScript, HTML5, and CSS3.
*   **Backend / Proxy:** Secure Node.js & Express server.
*   **AI Inference:** Roboflow Inference API.
*   **Sensors:** HTML5 `navigator.geolocation` and `DeviceMotionEvent` APIs.
*   *No heavy frameworks, ensuring zero-lag telemetry rendering and maximum compatibility on low-end mobile devices.*

---

## Docs

Full technical manual (calibration methodology, TWP formula derivation, PWD rate basis,
dashboard component reference): see `TreadGuard_CV_Manual.pdf` in this repo.

## 👤 Author & Developer
**Saddab Sabir Ansari**
IT Engineering | MMCOE

*Developed independently as part of a group hackathon submission — 
code, architecture, demo video, documentations and repository by Saddab Ansari.*
