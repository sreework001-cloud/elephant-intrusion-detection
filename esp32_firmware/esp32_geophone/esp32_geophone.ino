/*
  ===============================================================================
  🐘 ELEPHANT INTRUSION EARLY WARNING SYSTEM - ESP32 FIELD HARDWARE FIRMWARE 🐘
  ===============================================================================
  Hardware: ESP32-WROOM-32D
  Sensors: 1x Triaxial Geophone (Signal Conditioning / ADC Board)
  Communication: Wi-Fi -> MQTT (broker.hivemq.com:1883) -> FastAPI Dashboard
  Topic: elephant/nodes/NODE_01
  ===============================================================================
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// --- 1. Wi-Fi Credentials ---
const char* ssid = "YOUR_WIFI_SSID";          // <-- Replace with your Wi-Fi SSID
const char* password = "YOUR_WIFI_PASSWORD";  // <-- Replace with your Wi-Fi Password

// --- 2. MQTT Broker Credentials ---
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;
const char* mqtt_topic = "elephant/nodes/NODE_01";
const char* node_id = "NODE_01";

// --- 3. Pin Definitions (Signal Conditioning ADC Pins) ---
const int PIN_GEO_X = 36; // VP (Analog input for Horizontal X)
const int PIN_GEO_Y = 39; // VN (Analog input for Horizontal Y)
const int PIN_GEO_Z = 34; // Pin 34 (Analog input for Vertical Z)

// Calibration Offset (Baseline mid-point for 3.3V ADC: 4095/2 ≈ 2048)
const int ADC_BASELINE = 2048;
const float ADC_TO_VOLTS = 3.3 / 4095.0;
const float VOLTS_TO_MMS = 15.0; // Sensitivity scale factor (mV to mm/s)

WiFiClient espClient;
PubSubClient client(espClient);

unsigned long lastPublishTime = 0;
const long publishInterval = 500; // Publish every 500 ms (2 Hz stream)

void setupWiFi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("");
  Serial.println("Wi-Fi connected successfully!");
  Serial.print("ESP32 IP Address: ");
  Serial.println(WiFi.localIP());
}

void reconnectMQTT() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection to ");
    Serial.print(mqtt_server);
    Serial.print("... ");

    String clientId = "ESP32_Geophone_Node_01_";
    clientId += String(random(0xffff), HEX);

    if (client.connect(clientId.c_str())) {
      Serial.println("CONNECTED to MQTT!");
    } else {
      Serial.print("Failed, rc=");
      Serial.print(client.state());
      Serial.println(" - Retrying in 5 seconds...");
      delay(5000);
    }
  }
}

void setup() {
  Serial.begin(115200);
  
  // Configure ADC pins
  pinMode(PIN_GEO_X, INPUT);
  pinMode(PIN_GEO_Y, INPUT);
  pinMode(PIN_GEO_Z, INPUT);

  analogReadResolution(12); // 12-bit ADC (0 to 4095)

  setupWiFi();
  client.setServer(mqtt_server, mqtt_port);
}

void loop() {
  if (!client.connected()) {
    reconnectMQTT();
  }
  client.loop();

  unsigned long now = millis();
  if (now - lastPublishTime >= publishInterval) {
    lastPublishTime = now;

    // --- Read Raw ADC Values ---
    int rawX = analogRead(PIN_GEO_X);
    int rawY = analogRead(PIN_GEO_Y);
    int rawZ = analogRead(PIN_GEO_Z);

    // --- Convert ADC to Ground Motion Velocity (mm/s) ---
    float vibX = abs(rawX - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;
    float vibY = abs(rawY - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;
    float vibZ = abs(rawZ - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;

    // Calculate Composite Magnitude |V| = sqrt(x^2 + y^2 + z^2)
    float vMag = sqrt(vibX * vibX + vibY * vibY + vibZ * vibZ);
    float rms = vMag * 0.707;

    // Determine status & temporary features for phase 1 hardware testing
    String status = (vMag >= 4.0) ? "ALERT" : "ONLINE";
    float fDom = (vMag >= 4.0) ? 18.5 : 3.2; // Temporary f_dom until DSP FFT code added
    int confidence = (vMag >= 4.0) ? 92 : 85;
    int rssi = WiFi.RSSI();

    // --- Create JSON Payload ---
    StaticJsonDocument<300> doc;
    doc["node_id"] = node_id;
    doc["is_hardware"] = true; // Crucial flag for hardware telemetry
    doc["vib_x"] = round(vibX * 100.0) / 100.0;
    doc["vib_y"] = round(vibY * 100.0) / 100.0;
    doc["vib_z"] = round(vibZ * 100.0) / 100.0;
    doc["vibration_val"] = round(vMag * 100.0) / 100.0;
    doc["f_dom"] = fDom;
    doc["rms"] = round(rms * 100.0) / 100.0;
    doc["confidence"] = confidence;
    doc["battery"] = 96.5; // Battery reading placeholder
    doc["rssi"] = rssi;
    doc["snr"] = 11.5;
    doc["status"] = status;

    char jsonBuffer[350];
    serializeJson(doc, jsonBuffer);

    // --- Publish Payload via MQTT ---
    if (client.publish(mqtt_topic, jsonBuffer)) {
      Serial.print("Published ESP32 Telemetry: ");
      Serial.println(jsonBuffer);
    } else {
      Serial.println("MQTT Publish failed!");
    }
  }
}
