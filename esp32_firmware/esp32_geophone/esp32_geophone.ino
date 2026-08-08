/*
  ===============================================================================
  🐘 ELEPHANT INTRUSION EARLY WARNING SYSTEM - DUAL-PATH ESP32 FIRMWARE 🐘
  ===============================================================================
  Hardware: ESP32-WROOM-32D + DS3231 RTC + SPI SD Card + Signal Conditioning ADC
  Sampling: 200 Hz (5ms period) Non-blocking Timed Sampling (micros())
  
  Dual-Path Execution:
    Path 1: 200 Hz Raw Triaxial ADC Samples (X,Y,Z) -> SD Card (/geophone_log.csv)
    Path 2: 1 Hz Aggregated Telemetry -> Wi-Fi -> MQTT (elephant/nodes/NODE_01)
    
  GPIO Mapping:
    - Geophone X (Horizontal E-W): GPIO 33 (ADC1 CH5)
    - Geophone Y (Horizontal N-S): GPIO 35 (ADC1 CH7)
    - Geophone Z (Vertical Ground): GPIO 34 (ADC1 CH6)
    - I2C RTC (DS3231/DS1307): SDA -> GPIO 21, SCL -> GPIO 22
    - SPI SD Card CS: GPIO 5 (SCK: 18, MISO: 19, MOSI: 23)
  ===============================================================================
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <RTClib.h>
#include <SPI.h>
#include <SD.h>

// --- 1. Network & Broker Configuration ---
const char* ssid = "YOUR_WIFI_SSID";          // <-- Replace with Wi-Fi SSID
const char* password = "YOUR_WIFI_PASSWORD";  // <-- Replace with Wi-Fi Password

const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;
const char* mqtt_topic = "elephant/nodes/NODE_01";
const char* node_id = "NODE_01";

// --- 2. Hardware Pin Definitions ---
const int PIN_GEO_X = 33;
const int PIN_GEO_Y = 35;
const int PIN_GEO_Z = 34;
const int SD_CS_PIN = 5;

// --- 3. Sampling & Timing Parameters ---
const unsigned long SAMPLE_INTERVAL_MICROS = 5000; // 200 Hz = 1 sample every 5000 µs (5ms)
const unsigned long MQTT_PUBLISH_INTERVAL_MS = 1000; // 1 Hz summary telemetry packet

// --- 4. Uncalibrated ADC & Sensitivity Scale Placeholders ---
const int ADC_BASELINE = 2048; // 12-bit ADC midpoint (3.3V / 2)
const float ADC_TO_VOLTS = 3.3 / 4095.0;
const float VOLTS_TO_MMS = 15.0; // Preliminary scale factor (pending calibration)

// --- 5. Global Driver Objects & State ---
RTC_DS3231 rtc;
WiFiClient espClient;
PubSubClient client(espClient);

bool sdOK = false;
bool rtcOK = false;
bool mqttOK = false;

File logFile;
const char* logFilename = "/geophone_log.csv";

unsigned long sampleCounter = 0;
unsigned long samplesThisSecond = 0;

unsigned long lastSampleMicros = 0;
unsigned long lastMqttPublishMs = 0;
unsigned long lastSerialPrintMs = 0;

// Peak / Aggregated window variables for 1Hz MQTT packet
int maxRawX = 0, maxRawY = 0, maxRawZ = 0;
float peakVibX = 0.0, peakVibY = 0.0, peakVibZ = 0.0;
double sumVmagSquared = 0.0;

// Helper to get formatted RTC timestamp
String getRTCTimestamp() {
  if (rtcOK) {
    DateTime now = rtc.now();
    char buf[25];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d", 
             now.year(), now.month(), now.day(), 
             now.hour(), now.minute(), now.second());
    return String(buf);
  }
  return "1970-01-01 00:00:00"; // Fallback if RTC uninitialized
}

void setupWiFi() {
  Serial.print("[Wi-Fi] Connecting to ");
  Serial.print(ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  unsigned long startAttempt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startAttempt < 8000) {
    delay(400);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println(" [CONNECTED]");
    Serial.print("[Wi-Fi] ESP32 IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println(" [OFFLINE - Non-blocking mode active]");
  }
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;

  if (!client.connected()) {
    String clientId = "ESP32_Geophone_Node01_";
    clientId += String(random(0xffff), HEX);
    
    if (client.connect(clientId.c_str())) {
      mqttOK = true;
    } else {
      mqttOK = false;
    }
  } else {
    mqttOK = true;
  }
}

void initSDCard() {
  Serial.print("[SD Card] Initializing SPI SD Card (CS Pin ");
  Serial.print(SD_CS_PIN);
  Serial.print(")... ");

  if (SD.begin(SD_CS_PIN)) {
    sdOK = true;
    Serial.println("[OK]");
    Serial.print("[SD Card] Target Log File: ");
    Serial.println(logFilename);

    // Create CSV header if file doesn't exist
    if (!SD.exists(logFilename)) {
      logFile = SD.open(logFilename, FILE_WRITE);
      if (logFile) {
        logFile.println("Timestamp,Sample_Number,Raw_X,Raw_Y,Raw_Z");
        logFile.close();
        Serial.println("[SD Card] Created new CSV log file with header.");
      }
    }
  } else {
    sdOK = false;
    Serial.println("[FAILED - Continuing sensor acquisition without SD logging]");
  }
}

void initRTC() {
  Serial.print("[RTC] Initializing I2C DS3231 Real-Time Clock... ");
  Wire.begin(21, 22); // SDA = GPIO 21, SCL = GPIO 22

  if (rtc.begin()) {
    rtcOK = true;
    Serial.println("[OK]");
    if (rtc.lostPower()) {
      Serial.println("[RTC] Warning: RTC lost power, setting compile time.");
      rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
    }
    Serial.print("[RTC] Current Date/Time: ");
    Serial.println(getRTCTimestamp());
  } else {
    rtcOK = false;
    Serial.println("[FAILED - Defaulting to fallback timestamp]");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n==========================================================");
  Serial.println("🐘 ELEPHANT INTRUSION WARNING SYSTEM - ESP32 FIRMWARE 🐘");
  Serial.println("==========================================================");

  // 1. Configure ADC Pins
  pinMode(PIN_GEO_X, INPUT);
  pinMode(PIN_GEO_Y, INPUT);
  pinMode(PIN_GEO_Z, INPUT);
  analogReadResolution(12); // 12-bit resolution (0 to 4095)

  // 2. Initialize Hardware Components
  initRTC();
  initSDCard();
  setupWiFi();

  // 3. Configure MQTT
  client.setServer(mqtt_server, mqtt_port);
  reconnectMQTT();

  Serial.println("----------------------------------------------------------");
  Serial.println("Target Sensor Sampling Rate : 200 Hz (5000 µs interval)");
  Serial.println("SD Card Logging Rate        : 200 Hz (every sample)");
  Serial.println("MQTT Telemetry Rate         : 1 Hz (aggregated summary)");
  Serial.println("==========================================================\n");

  lastSampleMicros = micros();
  lastMqttPublishMs = millis();
  lastSerialPrintMs = millis();
}

void loop() {
  unsigned long currentMicros = micros();

  // --- PATH 1: 200 Hz Non-Blocking Timed Sensor Acquisition & SD Logging ---
  if (currentMicros - lastSampleMicros >= SAMPLE_INTERVAL_MICROS) {
    lastSampleMicros += SAMPLE_INTERVAL_MICROS;
    sampleCounter++;
    samplesThisSecond++;

    // Synchronous Triaxial ADC Read
    int rawX = analogRead(PIN_GEO_X);
    int rawY = analogRead(PIN_GEO_Y);
    int rawZ = analogRead(PIN_GEO_Z);

    // Calculate uncalibrated ground velocity (mm/s)
    float vx = abs(rawX - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;
    float vy = abs(rawY - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;
    float vz = abs(rawZ - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;
    float vMag = sqrt(vx * vx + vy * vy + vz * vz);

    // Accumulate metrics for 1Hz MQTT summary
    if (vx > peakVibX) peakVibX = vx;
    if (vy > peakVibY) peakVibY = vy;
    if (vz > peakVibZ) peakVibZ = vz;
    sumVmagSquared += (vMag * vMag);

    // Path 1 Log: Store 200 Hz raw sample to SD card
    if (sdOK) {
      logFile = SD.open(logFilename, FILE_APPEND);
      if (logFile) {
        logFile.print(getRTCTimestamp());
        logFile.print(",");
        logFile.print(sampleCounter);
        logFile.print(",");
        logFile.print(rawX);
        logFile.print(",");
        logFile.print(rawY);
        logFile.print(",");
        logFile.println(rawZ);
        logFile.close();
      } else {
        sdOK = false; // Mark error without stopping acquisition
      }
    }
  }

  // --- PATH 2: 1 Hz Aggregated Telemetry via MQTT to Dashboard ---
  unsigned long currentMs = millis();

  // Keep MQTT connection alive (non-blocking)
  if (WiFi.status() == WL_CONNECTED) {
    if (!client.connected()) {
      reconnectMQTT();
    }
    client.loop();
  }

  if (currentMs - lastMqttPublishMs >= MQTT_PUBLISH_INTERVAL_MS) {
    lastMqttPublishMs = currentMs;

    // Compute aggregated 1-second RMS & peak magnitude
    float meanSquare = (samplesThisSecond > 0) ? (sumVmagSquared / samplesThisSecond) : 0.0;
    float rmsVal = sqrt(meanSquare);
    float totalPeakMag = sqrt(peakVibX * peakVibX + peakVibY * peakVibY + peakVibZ * peakVibZ);

    String statusStr = (totalPeakMag >= 4.0) ? "ALERT" : "ONLINE";
    float fDomTest = (totalPeakMag >= 4.0) ? 18.5 : 3.2; // Preliminary test placeholder
    int confidence = (totalPeakMag >= 4.0) ? 94 : 85;
    int rssiVal = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : -99;
    String currentRtcTime = getRTCTimestamp();

    // Create JSON Payload
    StaticJsonDocument<350> doc;
    doc["node_id"] = node_id;
    doc["is_hardware"] = true;
    doc["rtc_timestamp"] = currentRtcTime;
    doc["vib_x"] = round(peakVibX * 100.0) / 100.0;
    doc["vib_y"] = round(peakVibY * 100.0) / 100.0;
    doc["vib_z"] = round(peakVibZ * 100.0) / 100.0;
    doc["vibration_val"] = round(totalPeakMag * 100.0) / 100.0;
    doc["f_dom"] = fDomTest;
    doc["rms"] = round(rmsVal * 100.0) / 100.0;
    doc["confidence"] = confidence;
    doc["battery"] = 96.5;
    doc["rssi"] = rssiVal;
    doc["snr"] = 11.2;
    doc["status"] = statusStr;

    char jsonBuffer[380];
    serializeJson(doc, jsonBuffer);

    if (WiFi.status() == WL_CONNECTED && client.connected()) {
      mqttOK = client.publish(mqtt_topic, jsonBuffer);
    } else {
      mqttOK = false;
    }

    // Reset aggregation window
    peakVibX = 0.0; peakVibY = 0.0; peakVibZ = 0.0;
    sumVmagSquared = 0.0;
  }

  // --- Operational Summary (1 Hz Diagnostic Print to Serial) ---
  if (currentMs - lastSerialPrintMs >= 1000) {
    lastSerialPrintMs = currentMs;

    Serial.print("Samples: ");
    Serial.print(samplesThisSecond);
    Serial.print(" Hz | SD: ");
    Serial.print(sdOK ? "OK" : "ERR");
    Serial.print(" | MQTT: ");
    Serial.print(mqttOK ? "OK" : "DISC");
    Serial.print(" | RTC: ");
    Serial.print(getRTCTimestamp());
    Serial.print(" | Total Samples: ");
    Serial.println(sampleCounter);

    samplesThisSecond = 0; // Reset rate counter
  }
}
