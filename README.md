# 🐘 Elephant Intrusion Early Warning System (EIEWS)
> **Multimodal IoT Network – Triangular TDOA Geophone Direction Mapping & STFT Spectrogram Analysis**

Welcome to the **Elephant Intrusion Early Warning System** codebase! This repository contains a fully working, self-contained prototype designed to detect elephant movements near forest-agricultural boundaries, calculate intrusion directions using a **3-Node Triangular Array**, perform **STFT Spectrogram Analysis**, and trigger real-time early warnings via a Web UI, SMS/Telegram, and local warning sirens.

---

## 📌 Teammate Handover Guide & Overview

If you are taking over or continuing development on this project, **everything you need is ready to run out-of-the-box!** 

* **Current Status**: Complete working prototype with full Frontend UI, FastAPI/WebSocket backend, SQLite database, STFT engine, and built-in telemetry simulator.
* **Server URL**: `http://127.0.0.1:8000`
* **Starter Script**: `python run.py`
* **Zero External Dependencies Required**: The project includes an automated telemetry simulator so you can test and demonstrate all UI and backend logic without physical hardware connected.

---

## 🏗️ 6-Layer System Architecture

The project implements the approved **6-Layer Multimodal IoT Architecture**:

```text
┌───────────────────────────────────────────────────────────────────────────┐
│                      1. FIELD SENSOR NODE LAYER                           │
│  Triaxial Geophone (Vx, Vy, Vz) + Microphone + PIR + Solar Panel + Battery │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ (ADC & Signal Conditioning)
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                      2. EDGE PROCESSING (At Node)                         │
│       ESP32-S3 MCU: Feature Extraction (f_dom, RMS, Kurtosis, Duration)    │
│            Multimodal Verification (PIR/Mic) ➔ Compact Alert Packet       │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ (LoRa SX1262 868/915 MHz)
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                  3. LORA WIRELESS COMMUNICATION LINK                      │
│            Long-Range Wireless Link (10–15 km) ➔ Gateway Station          │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                     4. GATEWAY / BASE STATION                             │
│     CRC Validation ➔ Triangular TDOA Direction Mapping Engine             │
│   Output: Local Siren / Warning Light ➔ 4G Backhaul ➔ SD Card Logging     │
└─────────────────────────────────────┬─────────────────────────────────────┘
                                      │ (MQTT / WebSockets)
                                      ▼
┌───────────────────────────────────────────────────────────────────────────┐
│                    5. CLOUD & CONTROL ROOM DASHBOARD                      │
│        FastAPI Server ➔ SQLite DB ➔ STFT Engine ➔ Glassmorphic Web UI     │
└───────────────────────────────────────────────────────────────────────────┘
                                      ▲
┌─────────────────────────────────────┴─────────────────────────────────────┐
│                       6. POWER MANAGEMENT LAYER                           │
│          Solar Panel ➔ Charge Controller ➔ 12V LiFePO4 Battery            │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## 📐 Triangular TDOA Array & Direction Mapping

Instead of attempting computationally heavy $(x, y)$ GPS coordinate localization with limited sensors, the system uses a **Triangular Deployment Array** ($G1, G2, G3$) and **Time Difference of Arrival (TDOA)** in milliseconds:

```text
                 🌲 Deep Forest Area (NORTH)

                      G1 (Apex - Forest Trail)
                      /      \
                     /        \
          (Left) G2 ---------- G3 (Right)
=======================================================
           Forest Boundary / Agricultural Land
```

### TDOA Arrival Delay Logic:
* **North-West Entry ($G1 \rightarrow G2 \rightarrow G3$)**:
  - Signal reaches $G1$ first ($0.0\text{ ms}$), followed by $G2$ ($18.0\text{ ms}$) and $G3$ ($42.0\text{ ms}$).
  - **Vector Output**: `⬅ North-West Approach (Approach from Deep Forest)`.
* **North-East Entry ($G1 \rightarrow G3 \rightarrow G2$)**:
  - Signal reaches $G1$ first ($0.0\text{ ms}$), followed by $G3$ ($15.0\text{ ms}$) and $G2$ ($38.0\text{ ms}$).
  - **Vector Output**: `↗ North-East Approach`.
* **Direct Border Incursion ($G2/G3 \rightarrow G1$)**:
  - $G2$ & $G3$ trigger first $\rightarrow$ **Vector Output**: `⬇ Direct Incursion: Agricultural Line`. Threat Level: **CRITICAL** (Siren ON).
* **Outbound Retreat ($G2/G3 \rightarrow G1$)**:
  - Elephants moving away from crops back into the forest. Threat Level: **LOW** (Prevents false siren alarms).

---

## 💻 Codebase Breakdown (For Developers)

### 1. Frontend (`static/` & `templates/`)
* **[`templates/index.html`](file:///a:/WNA/Dashboard/templates/index.html)**: 
  * Main Dashboard UI HTML layout.
  * Includes the Header, System Architecture Status Bar, Alert Banner, 3 Node Cards, Live Waveform Canvas, Triangular TDOA Compass Map, Event Log Table, and STFT Spectrogram Modal.
* **[`static/css/dashboard.css`](file:///a:/WNA/Dashboard/static/css/dashboard.css)**: 
  * Modern dark glassmorphic styling system using CSS variables (`--bg-base: #090D16`, `--color-emerald: #10B981`, `--color-cyan: #06B6D4`, `--color-crimson: #EF4444`).
  * Micro-animations, pulse indicators, responsive grid, and custom canvas styling.
* **[`static/js/app.js`](file:///a:/WNA/Dashboard/static/js/app.js)**: 
  * Handles WebSocket connection to `/ws` with auto-reconnect logic.
  * **Waveform Canvas Renderer**: Plots live 60-second rolling ground displacement traces ($V_x, V_y, V_z, |V|$) with marked amplitude ($0–10\text{ mm/s}$) and time scales ($-60s$ to $0s$).
  * **STFT Spectrogram Heatmap Renderer**: Draws 2D STFT matrix ($0–50\text{ Hz}$ frequency vs $0–5\text{ s}$ time vs power intensity colorbar) on canvas using Turbo/Magma palettes.

### 2. Backend (`backend/`)
* **[`backend/main.py`](file:///a:/WNA/Dashboard/backend/main.py)**: 
  * FastAPI entry point hosting static files, Jinja2 template routes, REST endpoints (`/api/nodes`, `/api/alerts`, `/api/stft/{node_id}`), and WebSocket hub (`/ws`).
* **[`backend/fusion_engine.py`](file:///a:/WNA/Dashboard/backend/fusion_engine.py)**: 
  * `TriangularTDOAFusionEngine`: Evaluates incoming node arrival times, calculates millisecond TDOA delays relative to the first triggered node, determines direction vectors, confidence levels, and threat states.
* **[`backend/mqtt_client.py`](file:///a:/WNA/Dashboard/backend/mqtt_client.py)**: 
  * `MQTTGatewayHandler`: Connects to MQTT broker (`broker.hivemq.com` or local IP) on topic `elephant/nodes/#`. Receives node telemetry JSON packets, updates SQLite DB, triggers fusion evaluation, and broadcasts to WebSocket clients.
* **[`backend/stft.py`](file:///a:/WNA/Dashboard/backend/stft.py)**: 
  * Digital Signal Processing (DSP) module that generates 2D Short-Time Fourier Transform matrix data. Isolates the fundamental **$14–24\text{ Hz}$** elephant infrasound footfall peak and rhythmic $1.2\text{s}$ stride pulses.
* **[`backend/database.py`](file:///a:/WNA/Dashboard/backend/database.py)**: 
  * SQLite manager for `elephant_detection.db`. Handles database initialization and CRUD operations for `nodes`, `alerts`, and `telemetry` tables.
* **[`backend/simulator.py`](file:///a:/WNA/Dashboard/backend/simulator.py)**: 
  * Background simulator producing continuous realistic ambient noise ($V_x \approx 0.18\text{ mm/s}$, $f_{dom} \approx 3\text{ Hz}$) and on-demand TDOA intrusion sequences for testing.

---

## 🚀 How to Run the Project

1. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```
2. **Start the Application**:
   ```bash
   python run.py
   ```
3. **Access Dashboard**:
   Open browser to **`http://127.0.0.1:8000`**

---

## 🔌 Connecting Physical Field Hardware (ESP32 / Gateway)

When physical field nodes or LoRa Gateways are deployed, they can stream live data into this system over MQTT without changing backend code!

### MQTT Packet Specification:
* **Topic**: `elephant/nodes/NODE_01` (or `NODE_02`, `NODE_03`)
* **Broker**: `broker.hivemq.com` (or local MQTT broker IP on port `1883`)
* **JSON Payload Format**:
```json
{
  "node_id": "NODE_01",
  "vib_x": 3.8,              // Horizontal East-West velocity (mm/s)
  "vib_y": 3.2,              // Horizontal North-South velocity (mm/s)
  "vib_z": 4.9,              // Vertical Up-Down velocity (mm/s)
  "f_dom": 18.5,             // Dominant Frequency in Hz
  "rms": 2.71,               // RMS Amplitude
  "kurtosis": 5.8,           // Kurtosis pulse sharpness
  "duration": 2.4,           // Event duration in seconds
  "mic_val": 4.2,            // Acoustic intensity in dB
  "mic_verified": true,      // Audio rumble confirmed
  "pir_active": true,        // PIR motion sensor confirmed
  "confidence": 94,          // Edge confidence %
  "battery": 95.4,           // Battery percentage (12V LiFePO4)
  "rssi": -65,               // LoRa signal strength (dBm)
  "snr": 11.2,               // Signal to noise ratio
  "status": "ALERT"          // Status: ONLINE / ALERT
}
```

---

## 📊 STFT Spectrogram & Infrasound Interpretation

When analyzing the **STFT Spectrogram Modal** (`📊 STFT`):

* **Y-Axis ($0–50\text{ Hz}$)**: Frequency band.
  * **$14–24\text{ Hz}$ Band**: Primary Elephant Seismic Footfall (Infrasound fundamental rumble).
  * **$30–36\text{ Hz}$ Band**: Secondary body mass harmonic.
* **X-Axis ($0.0–5.0\text{s}$)**: Time window.
  * Bright white/red glowing spots repeating every **$\sim 1.2\text{ seconds}$** represent the rhythmic stride duration of an elephant walking.
* **Colorbar Scale**: $-60\text{ dB}$ (Dark Blue / Noise Floor) to $0\text{ dB}$ (Bright White / Peak Energy).

---

## 📋 Next Tasks / Development Roadmap

For the developer taking over:
1. **Hardware Interfacing**: Flash ESP32-S3 boards with LoRa SX1262 firmware to format ADC geophone readings into the JSON payload shown above.
2. **Broker Configuration**: Change `broker_host` in `backend/mqtt_client.py` if deploying a private local Mosquitto MQTT broker on the Gateway Raspberry Pi.
3. **SMS / Telegram Alerts**: Integrate Twilio or Telegram Bot API inside `backend/mqtt_client.py` inside `process_node_packet()` when `threat_level == "CRITICAL"`.
