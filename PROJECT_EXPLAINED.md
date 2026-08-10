# 🐘 Your Elephant Detection Project — Everything Explained Simply

> This document explains every single technical term and concept in your project in **plain, simple language** — no CS background needed!

---

## 🌍 The Big Picture — What Are We Building?

Imagine elephants walking near a farm at night. Farmers can't see them, and by the time they know, the elephants have already destroyed the crops.

**Your project solves this problem.**

You are building a **warning system** that:
1. **Feels the elephant's footsteps** through the ground (using sensors).
2. **Sends that information** through the internet to a computer screen.
3. **Shows a live map/dashboard** so someone sitting in a control room can see: *"An elephant is coming from the North-West direction!"*
4. **Triggers an alarm** if the elephant is too close to the farm.

That's it! Everything else is just the **tools and technology** used to make this happen.

---

## 🔧 The Hardware — Physical Things You Can Touch

### What is a **Geophone**?
A geophone is a small sensor that you **bury in the ground**. When an elephant walks nearby, its heavy footsteps create tiny vibrations in the soil (like mini-earthquakes). The geophone converts these vibrations into **electrical signals** (small voltages).

Your geophone measures vibrations in **3 directions**:
- **X-axis**: Left ↔ Right (Horizontal East-West)
- **Y-axis**: Forward ↔ Backward (Horizontal North-South)
- **Z-axis**: Up ↔ Down (Vertical)

This is why we call it a **Triaxial Geophone** (tri = three, axial = axes/directions).

---

### What is the **Signal Conditioning Board / ADC Board**?
The raw electrical signal from the geophone is very tiny and noisy. The **signal conditioning board** (your green PCB board) does two things:
1. **Amplifies** the signal (makes it stronger/bigger).
2. **Converts** the analog voltage into a digital number (0 to 4095) that the ESP32 computer chip can understand. This conversion is called **ADC (Analog-to-Digital Conversion)**.

---

### What is an **ESP32-WROOM-32D**?
Think of it as a **tiny computer chip** (smaller than a coin) that can:
- Read sensor values (from the geophone via ADC pins).
- Store data on an SD card.
- Connect to Wi-Fi (like your phone connects to Wi-Fi).
- Send data over the internet.

It is the **brain** of your field sensor node. It runs the Arduino code that we wrote.

---

### What is an **RTC (Real-Time Clock)?**
RTC stands for **Real-Time Clock**. It is a small chip (DS3231) with a tiny battery that keeps track of the **actual date and time** — even when the ESP32 is powered off!

Without an RTC, the ESP32 would lose track of time every time you unplug it. With an RTC, every geophone reading is stamped with the **real date and time** (e.g., `2026-08-10 17:25:30`), so you know exactly **when** each vibration happened.

---

### What is an **SD Card** in this project?
The MicroSD card inserted into your PCB board acts as a **local backup hard drive**. Every single geophone reading (200 times per second!) is saved as a row in a CSV file on the SD card.

**Why do we need it?** If the internet or Wi-Fi disconnects temporarily, the SD card keeps recording. No data is lost! You can also pull out the SD card later and open the CSV file in Excel to analyze the data.

---

### What are **GPIO Pins**?
GPIO stands for **General Purpose Input/Output**. These are the numbered metal pins on the ESP32 chip where you connect wires.

In your project:
- **GPIO 33** → Connected to Geophone X signal
- **GPIO 35** → Connected to Geophone Y signal
- **GPIO 34** → Connected to Geophone Z signal
- **GPIO 21, 22** → Connected to RTC clock chip (I2C communication)
- **GPIO 5** (or auto-detected) → Connected to SD Card chip select

---

## 🌐 The Internet Journey — How Data Travels from Forest to Screen

Here is the complete journey of one geophone reading, from the ground to your screen:

```
Step 1: Elephant walks → Ground vibrates

Step 2: Geophone sensor converts vibration → Electrical voltage

Step 3: Signal Conditioning Board amplifies & digitizes → Number (0-4095)

Step 4: ESP32 reads the number from GPIO pins

Step 5: ESP32 saves raw number to SD Card (backup)
         ↓ (simultaneously)
Step 6: ESP32 connects to your Phone Hotspot via Wi-Fi

Step 7: ESP32 sends a summary message via MQTT to the internet

Step 8: The MQTT Broker (HiveMQ server) receives the message

Step 9: Your Dashboard Backend (Python server on Render) is subscribed 
        to the broker and receives the message

Step 10: Backend pushes the data via WebSocket to your browser

Step 11: Your browser (Chrome/Firefox) displays the live values 
         on the Dashboard UI
```

---

## 📡 Communication Terms — How Devices Talk to Each Other

### What is **Wi-Fi**?
You already know this! Wi-Fi is wireless internet. Your ESP32 connects to your phone's **Personal Hotspot** (SSID: `SRE`, Password: `12345678`) just like a laptop connects to Wi-Fi. Once connected, the ESP32 can send data over the internet.

---

### What is **MQTT**?
MQTT is a **messaging protocol** — think of it like **WhatsApp for machines**.

Instead of humans sending text messages, the ESP32 sends small data packets (JSON messages) to a central server. Other computers (like your dashboard) can "listen" for those messages.

MQTT has 3 key concepts:

1. **Publisher** (Sender): Your ESP32 is the publisher. It sends geophone data.
2. **Subscriber** (Listener): Your dashboard backend is the subscriber. It listens for data.
3. **Broker** (Post Office): The MQTT broker sits in the middle. The publisher sends messages TO the broker, and the broker delivers them to all subscribers.

```
ESP32 (Publisher) ──sends data──► MQTT Broker ──delivers──► Dashboard (Subscriber)
```

---

### What is **HiveMQ**?
HiveMQ is a **free public MQTT Broker** on the internet (`broker.hivemq.com`). Think of it as a **free post office** that anyone can use.

- Your ESP32 sends a letter (data packet) to HiveMQ.
- Your dashboard has told HiveMQ: *"Whenever a letter arrives for topic `elephant/nodes/NODE_01`, give it to me!"*
- HiveMQ delivers the letter to your dashboard.

**Port 1883** is like the door number of the post office — it's the standard MQTT door that all MQTT devices use.

---

### What is a **Topic**?
A topic is like an **address label** on the message. Your project uses:

```
elephant/nodes/NODE_01
```

This means: *"This message is about elephant detection, from sensor node number 1."*

When you add NODE_02 and NODE_03 later, they will use `elephant/nodes/NODE_02` and `elephant/nodes/NODE_03`.

---

### What is **JSON**?
JSON is a simple text format for organizing data. Instead of sending random numbers, the ESP32 sends a neatly organized package:

```json
{
  "node_id": "NODE_01",
  "vib_x": 1.45,
  "vib_y": 0.82,
  "vib_z": 2.10,
  "status": "ONLINE"
}
```

Both the ESP32 and the dashboard understand this format, so they can communicate clearly.

---

## 💻 The Website/Dashboard — What You See on Screen

### What is a **Frontend**?
The frontend is **everything you see on screen** when you open the website. It includes:
- The dark background with glowing cards.
- The 3 sensor node cards (G1, G2, G3) showing battery, signal strength, vibration values.
- The live waveform graph plotting X, Y, Z vibrations.
- The triangular compass map showing elephant direction.
- The alert banner and event log table.

**Files that make the frontend:**
- `templates/index.html` → The structure/layout (like the skeleton of a building).
- `static/css/dashboard.css` → The styling/colors/animations (like the paint and decoration).
- `static/js/app.js` → The interactive behavior (like the electrical wiring that makes things move).

---

### What is a **Backend**?
The backend is the **invisible brain** running behind the website. You never see it directly, but it does all the heavy work:
- Receives MQTT data from the ESP32.
- Stores data in the database.
- Calculates which direction the elephant is coming from (TDOA).
- Sends live updates to your browser screen.

**Files that make the backend:**
- `backend/main.py` → The main server program.
- `backend/mqtt_client.py` → Listens for ESP32 data from HiveMQ.
- `backend/fusion_engine.py` → Calculates elephant direction using TDOA.
- `backend/database.py` → Stores readings in a local database.
- `backend/simulator.py` → Generates fake test data when no real ESP32 is connected.
- `backend/stft.py` → Generates the frequency analysis heatmap.

---

### What is **FastAPI**?
FastAPI is a **Python framework** (a pre-built toolkit) that makes it easy to create web servers. Our backend uses FastAPI to:
- Serve the dashboard webpage.
- Provide API endpoints (URLs that return data).
- Handle WebSocket connections.

---

### What is a **WebSocket**?
A normal website works like this: your browser asks the server for data, the server responds, and the connection closes. If you want new data, you have to ask again.

A **WebSocket** is different — it creates a **permanent open connection** between your browser and the server. Data flows continuously in real-time without asking. This is how your dashboard updates the waveform graph live without you refreshing the page!

---

### What is **SQLite**?
SQLite is a simple **database** stored as a single file (`elephant_detection.db`) on the server. It stores:
- Node status history (online/alert).
- All telemetry readings (vibration values, battery levels).
- Alert events (when an elephant was detected).

Think of it as an Excel spreadsheet that the backend program reads and writes to automatically.

---

## ☁️ Hosting & Deployment — Making It Available Online

### What is **GitHub**?
GitHub is a website where programmers store and share their code. Your repository is at:
`https://github.com/sreework001-cloud/elephant-intrusion-detection`

It's like Google Drive, but specifically designed for code. It tracks every change ever made (version history), so you can always go back to an older version if something breaks.

---

### What is **Render**?
Render is a **free cloud hosting platform**. Instead of running `python run.py` on your laptop (which means the website dies when you close your laptop), Render runs your Python server on their computers **24/7 in the cloud**.

Your live website URL: `https://elephant-intrusion-detection.onrender.com`

Whenever you push code changes to GitHub, Render automatically picks up the changes and updates the live website!

---

### What is **Git**?
Git is a **version control system** — it tracks every change you make to your code. Commands like `git add`, `git commit`, `git push` are how you save and upload your code changes to GitHub.

---

## 🔬 Signal Processing Terms

### What is **TDOA (Time Difference of Arrival)**?
When an elephant walks, the vibration reaches the 3 geophones at **slightly different times** depending on where the elephant is.

If the vibration reaches G1 first, then G2, then G3 — the elephant is probably near G1 (coming from the forest). By comparing these tiny time differences (in milliseconds), we can estimate the **direction** the elephant is coming from.

We are NOT calculating exact GPS coordinates (that would need many more sensors). We are estimating **direction** — North-West, North-East, Direct South, etc.

---

### What is **STFT (Short-Time Fourier Transform)**?
Every vibration signal is made up of different **frequencies** (like music has bass and treble). STFT breaks the geophone signal into its frequency components over time.

Why is this useful? Elephant footsteps have a unique frequency signature: **14–24 Hz** (very low bass rumble). By looking at the STFT heatmap, you can visually confirm: *"Yes, this vibration is from an elephant, not a truck or rainfall."*

---

### What is **RMS (Root Mean Square)**?
RMS is a way to measure the **average strength** of a vibration signal. Instead of looking at individual peaks and valleys, RMS gives you one single number that represents the overall intensity.

Higher RMS = Stronger vibration = Elephant is closer or heavier.

---

### What is **f_dom (Dominant Frequency)**?
This is the **strongest frequency** in the vibration signal. For elephants, this is typically around **18.5 Hz**. For a passing truck, it might be 40+ Hz. This helps distinguish elephant footsteps from other vibration sources.

---

## 📊 Current Project Status Summary

| Component | Status | What It Does |
| :--- | :--- | :--- |
| Geophone + ADC Board | ✅ Working | Senses ground vibrations, converts to digital numbers |
| ESP32 + Arduino Code | ✅ Working | Reads sensors at 200 Hz, saves to SD, sends via Wi-Fi |
| SD Card Logging | ✅ Working | Backup storage of all raw readings at 200 Hz |
| RTC Timestamping | ✅ Working | Adds real date/time to every reading |
| Wi-Fi (Phone Hotspot) | ✅ Working | ESP32 connects to your phone's internet |
| MQTT to HiveMQ | 🔧 Debugging | ESP32 can reach HiveMQ but handshake is failing — waiting for State Code |
| Dashboard Frontend | ✅ Working | Beautiful live UI showing nodes, waveforms, compass map |
| Dashboard Backend | ✅ Working | Python server receiving MQTT data and pushing to browser |
| Render Cloud Hosting | ✅ Working | Website live at `elephant-intrusion-detection.onrender.com` |
| GitHub Repository | ✅ Working | All code stored and version-controlled |

### 🔧 Current Blocker:
The ESP32 successfully connects to Wi-Fi and can physically reach HiveMQ's server (TCP test passed), but the **MQTT handshake** (the "hello/handshake" between ESP32 and HiveMQ) is not completing. Your professor's diagnostic code will give us the exact error code to fix this.

Once MQTT shows `[MQTT] CONNECTED SUCCESSFULLY!`, the entire chain will work end-to-end:
```
Elephant Footstep → Geophone → ESP32 → Wi-Fi → MQTT → Dashboard → Your Screen! 🎉
```
