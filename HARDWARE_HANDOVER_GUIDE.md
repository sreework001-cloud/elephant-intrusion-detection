# ⚡ ESP32 Hardware Integration & Teammate Handover Guide

> **Project**: Elephant Intrusion Early Warning System (EIEWS)  
> **Repository**: [https://github.com/sreework001-cloud/elephant-intrusion-detection](https://github.com/sreework001-cloud/elephant-intrusion-detection)  
> **Live Website**: [https://elephant-intrusion-detection.onrender.com](https://elephant-intrusion-detection.onrender.com)

---

## 📌 Summary for Hardware Teammate

Hey! If you are handling the **ESP32-WROOM-32D hardware, signal conditioning board, and geophone testing**, this guide explains exactly how the hardware communicates with the web dashboard, what code you need, and how to flash your board.

The web backend and dashboard are fully deployed and listening for your physical ESP32 data over **MQTT**. As soon as your ESP32 powers on and connects to Wi-Fi, the dashboard will automatically detect your physical node and switch `NODE_01` to display **`⚡ ESP32 HARDWARE`** with your live geophone readings ($V_x, V_y, V_z$).

---

## 🛠️ 1. What Has Been Implemented on the Web System

1. **Hardware Telemetry Discrimination (`backend/mqtt_client.py`)**:
   * The backend subscribes to the MQTT topic `elephant/nodes/#` on `broker.hivemq.com:1883`.
   * When your ESP32 publishes a JSON packet to `elephant/nodes/NODE_01`, the system flags `NODE_01` as active physical hardware.

2. **Simulator Isolation (`backend/simulator.py`)**:
   * The background software simulator automatically **stops overwriting `NODE_01`** whenever your ESP32 is actively transmitting.
   * `NODE_02` and `NODE_03` will continue simulating background baseline readings until their physical hardware is ready.

3. **Live Hardware Indicator on Dashboard (`static/js/app.js`)**:
   * `NODE_01` card badge dynamically updates to **`⚡ ESP32 HARDWARE`** (cyan glowing badge) to clearly distinguish your live ESP32 telemetry from simulated nodes.

---

## 🔌 2. ESP32 Setup Instructions (For Hardware Teammate)

### Step 1: Open the Firmware File
In your repository, locate the pre-written Arduino sketch:
👉 **[`esp32_firmware/esp32_geophone/esp32_geophone.ino`](file:///a:/WNA/Dashboard/esp32_firmware/esp32_geophone/esp32_geophone.ino)**

### Step 2: Install Required Arduino Libraries
Open **Arduino IDE** on your computer and install these libraries via **Tools $\rightarrow$ Manage Libraries**:
1. `PubSubClient` (by Nick O'Leary) - for MQTT.
2. `ArduinoJson` (by Benoit Blanchon) - for formatting JSON payloads.

### Step 3: Hardware Pin Connections
Connect your Signal Conditioning / ADC board output pins to your ESP32-WROOM-32D:

| Geophone Signal Line | ESP32-WROOM-32D Pin | Pin Function |
| :--- | :--- | :--- |
| **Geophone X (Horizontal E-W)** | **Pin 36 (`VP`)** | ADC1 Channel 0 |
| **Geophone Y (Horizontal N-S)** | **Pin 39 (`VN`)** | ADC1 Channel 3 |
| **Geophone Z (Vertical Ground)** | **Pin 34** | ADC1 Channel 6 |
| **GND** | **GND** | Common Ground |
| **VCC (3.3V / 5V)** | **3.3V / VIN** | Power |

### Step 4: Configure Wi-Fi & Upload
1. Edit lines 16 & 17 in `esp32_geophone.ino` with **your Wi-Fi network name and password**:
   ```cpp
   const char* ssid = "YOUR_WIFI_NAME";
   const char* password = "YOUR_WIFI_PASSWORD";
   ```
2. Select Board: **ESP32 Dev Module** in Arduino IDE.
3. Select your ESP32 COM Port.
4. Click **Upload** (➡️).

---

## 📦 3. JSON Payload Format Transmitted by ESP32

Your ESP32 automatically formats and publishes the following JSON payload to `elephant/nodes/NODE_01`:

```json
{
  "node_id": "NODE_01",
  "is_hardware": true,
  "vib_x": 0.45,            // Real Horizontal X ground velocity (mm/s)
  "vib_y": 0.32,            // Real Horizontal Y ground velocity (mm/s)
  "vib_z": 0.58,            // Real Vertical Z ground velocity (mm/s)
  "vibration_val": 0.80,    // Composite Vector Magnitude |V| = sqrt(x^2 + y^2 + z^2)
  "f_dom": 18.5,            // Dominant Frequency in Hz (Temporary / Test)
  "rms": 0.56,              // RMS amplitude
  "confidence": 85,         // Confidence %
  "battery": 96.5,          // Battery percentage
  "rssi": -62,              // Wi-Fi / LoRa RSSI signal strength
  "snr": 11.5,              // SNR ratio
  "status": "ONLINE"        // "ONLINE" or "ALERT"
}
```

---

## 🧪 4. How to Test Without ESP32 (Testing from Computer)

If you want to test the hardware isolation before plugging in the ESP32, run this Python script on any computer:

```python
import json
import time
import paho.mqtt.client as mqtt

client = mqtt.Client(client_id="Test_ESP32_Publisher")
client.connect("broker.hivemq.com", 1883, 60)

test_packet = {
    "node_id": "NODE_01",
    "is_hardware": True,
    "vib_x": 1.85,
    "vib_y": 1.20,
    "vib_z": 2.45,
    "f_dom": 18.5,
    "rms": 2.31,
    "confidence": 95,
    "battery": 98.0,
    "rssi": -55,
    "snr": 12.5,
    "status": "ONLINE"
}

print("Publishing test ESP32 packet...")
client.publish("elephant/nodes/NODE_01", json.dumps(test_packet))
```

**Result on Dashboard (`https://elephant-intrusion-detection.onrender.com`)**:
* `NODE_01` badge turns to **`⚡ ESP32 HARDWARE`**.
* Triaxial values update to `Vx: 1.85`, `Vy: 1.20`, `Vz: 2.45`.
* Simulator stops modifying `NODE_01`.
