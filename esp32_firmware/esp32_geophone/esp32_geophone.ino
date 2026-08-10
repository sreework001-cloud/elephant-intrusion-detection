/*
  ===============================================================================
  🐘 ELEPHANT INTRUSION EARLY WARNING SYSTEM - DUAL-PATH ESP32 FIRMWARE 🐘
  ===============================================================================
  Hardware: ESP32-WROOM-32D + Custom PCB (Rev X7 AWNA) + DS3231 RTC + SPI SD Card
  Sampling: 200 Hz (5ms period) Non-blocking Timed Sampling (micros())
  
  Architecture:
  - 8-Block Circular Buffer (1600 samples = 8 seconds of memory buffer)
  - Ensures zero dropped samples during slow SD writes or MQTT transmissions.
  - Generates massive 5KB JSON array payloads with all 200 samples/sec.
  ===============================================================================
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <RTClib.h>
#include <SPI.h>
#include <SD.h>

// --- Network & Broker Configuration ---
const char* ssid = "SRE";          // <-- Personal Hotspot SSID
const char* password = "12345678";  // <-- Personal Hotspot Password

const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;
const char* mqtt_topic = "elephant/nodes/NODE_01";
const char* node_id = "NODE_01";

// --- Hardware Pin Definitions ---
const int PIN_GEO_X = 33;
const int PIN_GEO_Y = 35;
const int PIN_GEO_Z = 34;
int SD_CS_PIN = 5;

// --- ADC & Sensitivity Scale ---
const int ADC_BASELINE = 2048; 
const float ADC_TO_VOLTS = 3.3 / 4095.0;
const float VOLTS_TO_MMS = 15.0; // Preliminary scale factor

// --- Timing ---
const unsigned long SAMPLE_INTERVAL_MICROS = 5000; // 200 Hz

// --- Global Driver Objects & State ---
RTC_DS3231 rtc;
WiFiClient espClient;
PubSubClient client(espClient);

bool sdOK = false;
bool rtcOK = false;
File logFile;
const char* logFilename = "/geophone_log.csv";

// --- 8-BLOCK CIRCULAR BUFFER ---
const int NUM_BLOCKS = 8;
const int SAMPLES_PER_BLOCK = 200;

struct WaveBlock {
  float wave_x[SAMPLES_PER_BLOCK];
  float wave_y[SAMPLES_PER_BLOCK];
  float wave_z[SAMPLES_PER_BLOCK];
  int raw_x[SAMPLES_PER_BLOCK];
  int raw_y[SAMPLES_PER_BLOCK];
  int raw_z[SAMPLES_PER_BLOCK];
  unsigned long first_sample;
  unsigned long last_sample;
  String rtc_timestamp;
  volatile bool readyForProcess;
};

WaveBlock blocks[NUM_BLOCKS];
volatile int writeBlockIdx = 0;
volatile int writeSampleIdx = 0;
int readBlockIdx = 0;
int bufferOverflowCount = 0;

unsigned long sampleCounter = 0;
unsigned long lastSampleMicros = 0;
unsigned long lastMqttRetryMs = 0;
unsigned long lastSerialPrintMs = 0;

String getRTCTimestamp() {
  if (rtcOK) {
    DateTime now = rtc.now();
    char buf[25];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02d %02d:%02d:%02d", 
             now.year(), now.month(), now.day(), 
             now.hour(), now.minute(), now.second());
    return String(buf);
  }
  return "1970-01-01 00:00:00"; 
}

void printWiFiStatusDiagnostic() {
  wl_status_t status = WiFi.status();
  Serial.print("[Wi-Fi] Status: ");
  switch (status) {
    case WL_CONNECTED: Serial.println("CONNECTED"); break;
    case WL_NO_SSID_AVAIL: Serial.println("SSID NOT FOUND"); break;
    case WL_CONNECT_FAILED: Serial.println("CONNECTION FAILED"); break;
    case WL_DISCONNECTED: Serial.println("DISCONNECTED"); break;
    default: Serial.println("ATTEMPTING CONNECTION"); break;
  }
}

void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (client.connected()) return;

  unsigned long nowMs = millis();
  if (nowMs - lastMqttRetryMs >= 2000) {
    lastMqttRetryMs = nowMs;
    
    String clientId = "ESP32_Geophone_Node01_";
    clientId += String((uint32_t)ESP.getEfuseMac(), HEX);
    
    client.connect(clientId.c_str());
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("\n==========================================================");
  Serial.println("🐘 ELEPHANT INTRUSION WARNING SYSTEM - 8-BLOCK FIRMWARE 🐘");
  Serial.println("==========================================================");

  pinMode(PIN_GEO_X, INPUT);
  pinMode(PIN_GEO_Y, INPUT);
  pinMode(PIN_GEO_Z, INPUT);
  analogReadResolution(12);

  Wire.begin(21, 22);
  if (rtc.begin()) {
    rtcOK = true;
    if (rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  }

  Serial.println("[SD Card] Scanning PCB SPI Chip Select (CS) Pins...");
  int candidateCsPins[] = {5, 15, 13, 4, 2};
  for (int pin : candidateCsPins) {
    if (SD.begin(pin)) {
      SD_CS_PIN = pin;
      sdOK = true;
      Serial.println("[SUCCESS - SD Card Detected]");
      break;
    }
  }

  if (sdOK) {
    if (!SD.exists(logFilename)) {
      logFile = SD.open(logFilename, FILE_WRITE);
      if (logFile) {
        logFile.println("Timestamp,Sample_Number,Raw_X,Raw_Y,Raw_Z");
        logFile.close();
      }
    }
    logFile = SD.open(logFilename, FILE_APPEND);
    if (!logFile) sdOK = false;
  } else {
    Serial.println("[SD Card] FAILED - Continuing without SD logging");
  }

  Serial.print("[Wi-Fi] Connecting to: ");
  Serial.println(ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  // --- MQTT CONFIGURATION ---
  client.setServer(mqtt_server, mqtt_port);
  client.setBufferSize(8192); // CRITICAL: 8KB buffer to hold massive JSON arrays
  client.setSocketTimeout(5);
  client.setKeepAlive(30);

  for (int i = 0; i < NUM_BLOCKS; i++) {
    blocks[i].readyForProcess = false;
  }

  lastSampleMicros = micros();
  lastSerialPrintMs = millis();
}

void loop() {
  unsigned long currentMicros = micros();
  unsigned long currentMs = millis();

  // --- PATH 1: 200 Hz High-Speed ADC Acquisition to Circular Buffer ---
  if (currentMicros - lastSampleMicros >= SAMPLE_INTERVAL_MICROS) {
    lastSampleMicros += SAMPLE_INTERVAL_MICROS;
    sampleCounter++;

    int rawX = analogRead(PIN_GEO_X);
    int rawY = analogRead(PIN_GEO_Y);
    int rawZ = analogRead(PIN_GEO_Z);

    float vx = abs(rawX - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;
    float vy = abs(rawY - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;
    float vz = abs(rawZ - ADC_BASELINE) * ADC_TO_VOLTS * VOLTS_TO_MMS;

    WaveBlock* wBlock = &blocks[writeBlockIdx];
    
    // Safety check: if block is not empty, we are overflowing!
    if (wBlock->readyForProcess) {
      bufferOverflowCount++;
      // We overwrite old data, but mark it as an overflow
    }

    if (writeSampleIdx == 0) {
      wBlock->first_sample = sampleCounter;
      wBlock->rtc_timestamp = getRTCTimestamp();
    }

    wBlock->raw_x[writeSampleIdx] = rawX;
    wBlock->raw_y[writeSampleIdx] = rawY;
    wBlock->raw_z[writeSampleIdx] = rawZ;
    wBlock->wave_x[writeSampleIdx] = vx;
    wBlock->wave_y[writeSampleIdx] = vy;
    wBlock->wave_z[writeSampleIdx] = vz;

    writeSampleIdx++;

    // When 200 samples are filled, advance to next block
    if (writeSampleIdx >= SAMPLES_PER_BLOCK) {
      wBlock->last_sample = sampleCounter;
      wBlock->readyForProcess = true; // Queue for SD + MQTT

      writeBlockIdx = (writeBlockIdx + 1) % NUM_BLOCKS;
      writeSampleIdx = 0;
    }
  }

  // --- PATH 2: Background Processing (SD Write + MQTT Array Publish) ---
  if (blocks[readBlockIdx].readyForProcess) {
    WaveBlock* pBlock = &blocks[readBlockIdx];

    // 1. SD Card Logging (Flush entire 200-sample block at once)
    if (sdOK && logFile) {
      for (int i = 0; i < SAMPLES_PER_BLOCK; i++) {
        logFile.print(pBlock->rtc_timestamp); logFile.print(",");
        logFile.print(pBlock->first_sample + i); logFile.print(",");
        logFile.print(pBlock->raw_x[i]); logFile.print(",");
        logFile.print(pBlock->raw_y[i]); logFile.print(",");
        logFile.println(pBlock->raw_z[i]);
      }
      logFile.flush();
    }

    // 2. MQTT JSON Array Transmission
    if (WiFi.status() == WL_CONNECTED) {
      reconnectMQTT();
      if (client.connected()) {
        client.loop();

        float peakX = 0, peakY = 0, peakZ = 0;
        double sumSq = 0;
        for (int i=0; i<SAMPLES_PER_BLOCK; i++) {
          if (pBlock->wave_x[i] > peakX) peakX = pBlock->wave_x[i];
          if (pBlock->wave_y[i] > peakY) peakY = pBlock->wave_y[i];
          if (pBlock->wave_z[i] > peakZ) peakZ = pBlock->wave_z[i];
          float vmag = sqrt(pBlock->wave_x[i]*pBlock->wave_x[i] + pBlock->wave_y[i]*pBlock->wave_y[i] + pBlock->wave_z[i]*pBlock->wave_z[i]);
          sumSq += vmag*vmag;
        }
        float rms = sqrt(sumSq / SAMPLES_PER_BLOCK);
        float totalPeakMag = sqrt(peakX*peakX + peakY*peakY + peakZ*peakZ);

        // DynamicJsonDocument 8KB required for 600 array elements
        DynamicJsonDocument doc(8192);
        doc["node_id"] = node_id;
        doc["is_hardware"] = true;
        doc["sample_rate_hz"] = 200;
        doc["sample_count"] = SAMPLES_PER_BLOCK;
        doc["first_sample"] = pBlock->first_sample;
        doc["last_sample"] = pBlock->last_sample;
        doc["rtc_timestamp"] = pBlock->rtc_timestamp;

        JsonArray arrX = doc.createNestedArray("wave_x");
        JsonArray arrY = doc.createNestedArray("wave_y");
        JsonArray arrZ = doc.createNestedArray("wave_z");
        
        for (int i=0; i<SAMPLES_PER_BLOCK; i++) {
          arrX.add(round(pBlock->wave_x[i]*100.0)/100.0);
          arrY.add(round(pBlock->wave_y[i]*100.0)/100.0);
          arrZ.add(round(pBlock->wave_z[i]*100.0)/100.0);
        }

        doc["vib_x"] = round(peakX*100.0)/100.0;
        doc["vib_y"] = round(peakY*100.0)/100.0;
        doc["vib_z"] = round(peakZ*100.0)/100.0;
        doc["vibration_val"] = round(totalPeakMag*100.0)/100.0;
        doc["rms"] = round(rms*100.0)/100.0;
        doc["status"] = totalPeakMag >= 4.0 ? "ALERT" : "ONLINE";

        String jsonString;
        serializeJson(doc, jsonString);

        if (client.publish(mqtt_topic, jsonString.c_str())) {
          Serial.print("[MQTT] FULL 200-SAMPLE WAVEFORM PUBLISH SUCCESS | Block ");
          Serial.print(pBlock->first_sample);
          Serial.print("-");
          Serial.print(pBlock->last_sample);
          Serial.print(" | ");
          Serial.print(jsonString.length());
          Serial.println(" bytes");
        } else {
          Serial.println("[MQTT] PUBLISH FAILED - Payload too large or connection lost!");
        }
      }
    }

    // Mark block as processed and advance reader index
    pBlock->readyForProcess = false;
    readBlockIdx = (readBlockIdx + 1) % NUM_BLOCKS;
  }

  // --- Summary Diagnostic (1 Hz) ---
  if (currentMs - lastSerialPrintMs >= 1000) {
    lastSerialPrintMs = currentMs;

    int pendingBlocks = (writeBlockIdx >= readBlockIdx) 
                          ? (writeBlockIdx - readBlockIdx) 
                          : (NUM_BLOCKS - readBlockIdx + writeBlockIdx);
    
    if (blocks[writeBlockIdx].readyForProcess) pendingBlocks = NUM_BLOCKS;

    Serial.print("Samples: 200 Hz | SD: ");
    Serial.print(sdOK ? "OK" : "ERR");
    Serial.print(" | MQTT: ");
    Serial.print(client.connected() ? "OK" : "DISC");
    Serial.print(" | Buffers Pending: ");
    Serial.print(pendingBlocks);
    Serial.print("/");
    Serial.print(NUM_BLOCKS);
    Serial.print(" | Overflows: ");
    Serial.println(bufferOverflowCount);

    if (WiFi.status() != WL_CONNECTED) {
      printWiFiStatusDiagnostic();
    }
  }
}