# ⚡ ESP32 Dual-Path Hardware Integration & Teammate Handover Guide

> **Project**: Elephant Intrusion Early Warning System (EIEWS)  
> **Repository**: [https://github.com/sreework001-cloud/elephant-intrusion-detection](https://github.com/sreework001-cloud/elephant-intrusion-detection)  
> **Live Website**: [https://elephant-intrusion-detection.onrender.com](https://elephant-intrusion-detection.onrender.com)

---

## 📌 Summary for Hardware Teammate

Hey! The ESP32 firmware has been updated to meet your exact **Dual-Path Data Flow & Hardware Reliability Specification**:

```text
                           Geophone Triaxial Sensor
                                      │
                                      ▼
                         Signal Conditioning / ADC
                                      │
                                      ▼
                              ESP32-WROOM-32D
                                      │
                ┌─────────────────────┴─────────────────────┐
                ▼                                           ▼
      [ Path 1: Local SD Card ]                 [ Path 2: Live Dashboard ]
   200 Hz Raw Triaxial ADC Samples           1 Hz Summary Telemetry Packet
   /geophone_log.csv + RTC Timestamp         Wi-Fi ➔ MQTT ➔ Dashboard UI
```

---

## 🛠️ 1. Key Firmware Features Implemented

1. **Non-Blocking 200 Hz Geophone Sampling**:
   * Uses `micros()` timed sampling ($5000\mu s$ interval = $200.0\text{ Hz}$) to sample X, Y, Z simultaneously without `delay()` jitter.
   * `GPIO 33` (X-axis), `GPIO 35` (Y-axis), `GPIO 34` (Z-axis).

2. **DS3231 I2C RTC Timestamping**:
   * Synchronizes timestamps (`YYYY-MM-DD HH:MM:SS`) on `I2C SDA: GPIO 21`, `SCL: GPIO 22`.
   * Logs RTC date/time on **every SD card sample** and includes `"rtc_timestamp"` in the 1 Hz MQTT packet for 1-to-1 correlation!

3. **200 Hz SD Card Local Logging (`/geophone_log.csv`)**:
   * Uses SPI CS Pin `GPIO 5`.
   * Automatically creates CSV header: `Timestamp,Sample_Number,Raw_X,Raw_Y,Raw_Z`.
   * Non-blocking write error handling: **SD errors or missing cards will NOT halt sensor sampling or MQTT!**

4. **1 Hz Aggregated MQTT Summary Stream**:
   * Sends 1 summary packet per second to `broker.hivemq.com:1883` on `elephant/nodes/NODE_01`.
   * Aggregates peak velocity, RMS, and RTC timestamp. Prevents network bandwidth saturation.

5. **Simulator Isolation**:
   * The web backend automatically detects `NODE_01` live hardware packets and **freezes software simulation on NODE_01**, rendering your true live ESP32 readings with the **`⚡ ESP32 HARDWARE`** badge!

---

## 🔌 2. Hardware Wiring Reference

| Hardware Component | ESP32-WROOM-32D Pin | Notes / Function |
| :--- | :--- | :--- |
| **Geophone X (Horizontal E-W)** | **GPIO 33** | ADC1 CH5 |
| **Geophone Y (Horizontal N-S)** | **GPIO 35** | ADC1 CH7 |
| **Geophone Z (Vertical Ground)** | **GPIO 34** | ADC1 CH6 |
| **I2C RTC (DS3231) SDA** | **GPIO 21** | Real-Time Clock Data |
| **I2C RTC (DS3231) SCL** | **GPIO 22** | Real-Time Clock Clock |
| **SPI SD Card CS** | **GPIO 5** | Chip Select |
| **SPI SD Card SCK / MISO / MOSI** | **GPIO 18 / 19 / 23** | Standard SPI bus |

---

## 📖 3. Complete Step-by-Step ESP32 Setup & Flashing Guide

### **A. Does the ESP32 "ask" for anything on screen?**
**NO.** The ESP32 does not have a pop-up window or keyboard to ask questions while running.  

Instead, it reads the **Wi-Fi Name and Password that you type into the code BEFORE uploading**. As soon as you give it power (via USB cable or battery), it runs automatically on its own!

---

### **B. How the Wi-Fi Connection Works**

Before uploading the code, open [`esp32_geophone.ino`](https://github.com/sreework001-cloud/elephant-intrusion-detection/blob/main/esp32_firmware/esp32_geophone/esp32_geophone.ino) in Arduino IDE and change **lines 21 & 22**:

```cpp
// Lines 21 & 22 in esp32_geophone.ino:
const char* ssid = "My_Home_WiFi";       // <-- Replace with your Wi-Fi or Mobile Hotspot Name
const char* password = "My_Password123";  // <-- Replace with your Wi-Fi Password
```

💡 **Tip (Mobile Hotspot)**: You can also type your **Mobile Phone Hotspot Name & Password**! Turn on your phone's hotspot, and the ESP32 will connect to your phone automatically.

---

### **C. What You Should Do Step-by-Step**

#### **Step 1: Plug in the ESP32**
1. Connect the ESP32 to your computer/laptop using a **USB Micro-USB cable**.

#### **Step 2: Open Arduino IDE**
1. Double-click `esp32_geophone.ino`.
2. Go to **Tools $\rightarrow$ Board** $\rightarrow$ select **ESP32 Dev Module**.
3. Go to **Tools $\rightarrow$ Port** $\rightarrow$ select your ESP32 COM port (e.g. `COM3` or `COM4`).

#### **Step 3: Upload the Code**
1. Click the **Upload** button (➡️ top left right arrow button).
2. Arduino IDE will compile the code and flash it to the ESP32 board.

---

### **D. How to See What the ESP32 is Doing Live (Serial Monitor)**

After uploading, you can watch the ESP32 start up and connect to Wi-Fi live on your computer screen:

1. In Arduino IDE, click **Tools $\rightarrow$ Serial Monitor** (or press `Ctrl` + `Shift` + `M`).
2. Set the speed in the bottom right corner to **`115200 baud`**.

You will see this printout live:
```text
==========================================================
🐘 ELEPHANT INTRUSION WARNING SYSTEM - ESP32 FIRMWARE 🐘
==========================================================
[RTC] Initializing I2C DS3231 Real-Time Clock... [OK]
[RTC] Current Date/Time: 2026-08-08 18:47:59
[SD Card] Initializing SPI SD Card (CS Pin 5)... [OK]
[SD Card] Target Log File: /geophone_log.csv
[Wi-Fi] Connecting to My_Home_WiFi... [CONNECTED]
[Wi-Fi] ESP32 IP Address: 192.168.1.105
----------------------------------------------------------
Target Sensor Sampling Rate : 200 Hz (5000 µs interval)
SD Card Logging Rate        : 200 Hz (every sample)
MQTT Telemetry Rate         : 1 Hz (aggregated summary)
==========================================================

Samples: 200 Hz | SD: OK | MQTT: OK | RTC: 2026-08-08 18:48:00
Samples: 200 Hz | SD: OK | MQTT: OK | RTC: 2026-08-08 18:48:01
```

As soon as you see `[Wi-Fi] [CONNECTED]`, check your live website (`https://elephant-intrusion-detection.onrender.com/`), and `NODE_01` will immediately show **`⚡ ESP32 HARDWARE`** with your live geophone readings!

---

## 📦 4. MQTT Packet JSON Format (Sent at 1 Hz)

```json
{
  "node_id": "NODE_01",
  "is_hardware": true,
  "rtc_timestamp": "2026-08-08 18:35:00",
  "vib_x": 1.45,
  "vib_y": 0.82,
  "vib_z": 2.10,
  "vibration_val": 2.68,
  "f_dom": 18.5,
  "rms": 1.90,
  "confidence": 85,
  "battery": 96.5,
  "rssi": -62,
  "snr": 11.2,
  "status": "ONLINE"
}
```

---

## ❓ 5. Frequently Asked Questions (FAQ) & Troubleshooting

### **Q1: Does the ESP32 ask for any inputs or prompts on screen when running?**
**No.** Microcontrollers execute code automatically on power-up. You must enter your Wi-Fi Name & Password in lines 21–22 of `esp32_geophone.ino` **before uploading** to the ESP32.

### **Q2: How does the Wi-Fi connection work & can I use a Mobile Hotspot?**
**Yes.** Change lines 21–22 in `esp32_geophone.ino`:
```cpp
const char* ssid = "My_Mobile_Hotspot";   // <-- Wi-Fi / Hotspot Name
const char* password = "My_Password123";  // <-- Password
```
When powered on, the ESP32 automatically connects to this network and starts streaming data over MQTT.

### **Q3: How do I view live diagnostic logs from the ESP32?**
1. Connect ESP32 to your computer via USB.
2. Open **Arduino IDE** $\rightarrow$ click **Tools $\rightarrow$ Serial Monitor** (`Ctrl + Shift + M`).
3. Set speed to **`115200 baud`**. You will see live 1 Hz diagnostic summaries.

### **Q4: What happens if Wi-Fi, MQTT, or SD Card fails?**
The system is built for **fault tolerance**:
* If SD card write fails $\rightarrow$ sensor sampling at 200 Hz and MQTT stream continue.
* If Wi-Fi drops $\rightarrow$ 200 Hz sensor acquisition and SD CSV logging continue without stopping. Non-blocking MQTT reconnect attempts run in the background until Wi-Fi returns.
