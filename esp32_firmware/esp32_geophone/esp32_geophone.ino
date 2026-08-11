/*
  ============================================================================
  ELEPHANT INTRUSION EARLY WARNING SYSTEM
  ESP32-WROOM-32D
  200 Hz Triaxial Geophone + RTC + SD + MQTT Full Waveform
  ============================================================================
  Combines the previously supplied:
    - hardware-timed 200 Hz buffered geophone logger
    - RTC + SD logging
    - Wi-Fi + MQTT dashboard telemetry

  IMPORTANT:
    * Every ADC sample is acquired at 200 Hz.
    * Every completed 1-second block contains exactly 200 X/Y/Z samples.
    * SD logging receives every sample from every completed block.
    * MQTT sends every sample in the completed block (not an averaged waveform).
    * The existing dashboard/backend must be changed to forward/plot the
      wave_x/wave_y/wave_z arrays. ESP32 firmware alone cannot make the
      current 60-point frontend waveform show 200 samples/sec.
*/

#include <Arduino.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <RTClib.h>
#include <SPI.h>
#include <SD.h>

// -------------------- USER CONFIG --------------------
const char* WIFI_SSID     = "SRE";
const char* WIFI_PASSWORD = "12345678";

const char* MQTT_SERVER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;
const char* MQTT_TOPIC  = "elephant/nodes/NODE_01";
const char* NODE_ID     = "NODE_01";

// -------------------- PINS ---------------------------
#define GEO_X 33
#define GEO_Y 35
#define GEO_Z 34

#define SDA_PIN 21
#define SCL_PIN 22

const int SD_CS_CANDIDATES[] = {5, 15, 13, 4, 2};
const size_t SD_CS_COUNT =
  sizeof(SD_CS_CANDIDATES) / sizeof(SD_CS_CANDIDATES[0]);

// -------------------- SAMPLING -----------------------
constexpr uint32_t SAMPLE_RATE_HZ = 200;
constexpr uint32_t SAMPLE_INTERVAL_US = 5000UL;
constexpr uint16_t BLOCK_SIZE = 200;
constexpr uint8_t NUM_BLOCKS = 8;   // ~8 seconds of buffering

// -------------------- ADC CONVERSION -----------------
// Same preliminary conversion used by the current dashboard firmware.
// This is NOT final sensor calibration.
constexpr int ADC_BASELINE = 2048;
constexpr float ADC_TO_VOLTS = 3.3f / 4095.0f;
constexpr float VOLTS_TO_MMS = 15.0f;

// -------------------- HARDWARE OBJECTS ---------------
RTC_DS3231 rtc;
bool rtcOK = false;

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);

File logFile;
bool sdOK = false;
int activeSDCS = -1;

const char* LOG_FILE = "/geophone_log.csv";

// -------------------- SAMPLE STORAGE -----------------
struct Sample {
  uint32_t number;
  uint32_t timestampUS;
  uint32_t intervalUS;
  uint16_t x;
  uint16_t y;
  uint16_t z;
};

// 8 one-second blocks.
// Each block = 200 samples × X/Y/Z.
Sample sampleBuffer[NUM_BLOCKS][BLOCK_SIZE];

// One producer (200 Hz) and two consumers (SD + MQTT).
volatile uint8_t writeBlock = 0;
volatile uint16_t writeIndex = 0;

// A completed block remains protected until BOTH consumers finish.
volatile bool pendingSD[NUM_BLOCKS] = {false};
volatile bool pendingMQTT[NUM_BLOCKS] = {false};

SemaphoreHandle_t bufferMutex = nullptr;
TaskHandle_t samplingTaskHandle = nullptr;
TaskHandle_t sdTaskHandle = nullptr;

// -------------------- STATISTICS ---------------------
volatile uint32_t totalSamples = 0;
volatile uint32_t missedTimerTicks = 0;
volatile uint32_t bufferOverflowCount = 0;
volatile uint32_t timingWarningCount = 0;
volatile uint32_t mqttBlocksPublished = 0;
volatile uint32_t mqttPublishFailures = 0;
volatile uint32_t sdBlocksWritten = 0;

unsigned long lastStatusMs = 0;
unsigned long lastMqttRetryMs = 0;
constexpr uint32_t MQTT_RETRY_MS = 2000;

// -------------------- HARDWARE TIMER -----------------
hw_timer_t* sampleTimer = nullptr;

void IRAM_ATTR onSampleTimer() {
  BaseType_t higherPriorityTaskWoken = pdFALSE;

  if (samplingTaskHandle) {
    vTaskNotifyGiveFromISR(
      samplingTaskHandle,
      &higherPriorityTaskWoken
    );
  }

  if (higherPriorityTaskWoken) {
    portYIELD_FROM_ISR();
  }
}

// -------------------- HELPERS ------------------------
float adcToMMS(uint16_t raw) {
  return fabsf((float)raw - (float)ADC_BASELINE) *
         ADC_TO_VOLTS * VOLTS_TO_MMS;
}

String getRTCTimestamp() {
  if (!rtcOK) return "1970-01-01 00:00:00";

  DateTime now = rtc.now();
  char buf[25];

  snprintf(
    buf, sizeof(buf),
    "%04d-%02d-%02d %02d:%02d:%02d",
    now.year(), now.month(), now.day(),
    now.hour(), now.minute(), now.second()
  );

  return String(buf);
}

// -------------------- RTC ----------------------------
void initRTC() {
  Wire.begin(SDA_PIN, SCL_PIN);

  Serial.print("[RTC] Initializing... ");

  if (!rtc.begin()) {
    Serial.println("FAILED");
    rtcOK = false;
    return;
  }

  rtcOK = true;
  Serial.println("OK");

  if (rtc.lostPower()) {
    Serial.println("[RTC] Lost power - setting compile time");
    rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  }

  Serial.print("[RTC] ");
  Serial.println(getRTCTimestamp());
}

// -------------------- SD -----------------------------
void initSDCard() {
  Serial.println("[SD] Scanning CS pins...");

  sdOK = false;

  for (size_t i = 0; i < SD_CS_COUNT; ++i) {
    int cs = SD_CS_CANDIDATES[i];

    Serial.print("[SD] Testing CS GPIO ");
    Serial.print(cs);
    Serial.print("... ");

    if (SD.begin(cs)) {
      activeSDCS = cs;
      sdOK = true;
      Serial.println("SUCCESS");
      break;
    }

    Serial.println("NO RESPONSE");
  }

  if (!sdOK) {
    Serial.println("[SD] FAILED - continuing without SD.");
    return;
  }

  if (!SD.exists("/geophone")) {
    SD.mkdir("/geophone");
  }

  logFile = SD.open(LOG_FILE, FILE_APPEND);

  if (!logFile) {
    Serial.println("[SD] Could not open log file.");
    sdOK = false;
    return;
  }

  if (logFile.size() == 0) {
    logFile.println(
      "RTC_Time,Sample_Number,Interval_us,Raw_X,Raw_Y,Raw_Z"
    );
    logFile.flush();
  }

  Serial.print("[SD] Logging to ");
  Serial.println(LOG_FILE);
}

// Write all 200 samples from one completed block.
// This does NOT skip or average samples.
void writeBlockToSD(uint8_t blockIndex) {
  if (!sdOK || !logFile) return;

  DateTime blockStart = rtcOK
                       ? rtc.now()
                       : DateTime(2000, 1, 1, 0, 0, 0);

  for (uint16_t i = 0; i < BLOCK_SIZE; ++i) {
    const Sample& s = sampleBuffer[blockIndex][i];

    uint32_t ms = i * 5UL;
    DateTime t = blockStart + TimeSpan(ms / 1000UL);

    char timeBuf[32];

    snprintf(
      timeBuf, sizeof(timeBuf),
      "%04d-%02d-%02d %02d:%02d:%02d.%03lu",
      t.year(), t.month(), t.day(),
      t.hour(), t.minute(), t.second(),
      (unsigned long)(ms % 1000UL)
    );

    logFile.print(timeBuf);
    logFile.print(",");
    logFile.print(s.number);
    logFile.print(",");
    logFile.print(s.intervalUS);
    logFile.print(",");
    logFile.print(s.x);
    logFile.print(",");
    logFile.print(s.y);
    logFile.print(",");
    logFile.println(s.z);
  }

  logFile.flush();
}

// SD writer task: waits for completed blocks and writes ALL samples.
void sdWriterTask(void* parameter) {
  while (true) {
    int blockToWrite = -1;

    if (xSemaphoreTake(bufferMutex, pdMS_TO_TICKS(20))) {
      for (uint8_t i = 0; i < NUM_BLOCKS; ++i) {
        if (pendingSD[i]) {
          blockToWrite = i;
          pendingSD[i] = false;
          break;
        }
      }

      xSemaphoreGive(bufferMutex);
    }

    if (blockToWrite >= 0) {
      writeBlockToSD((uint8_t)blockToWrite);
      sdBlocksWritten++;
      continue;
    }

    vTaskDelay(pdMS_TO_TICKS(1));
  }
}

// -------------------- WIFI ---------------------------
void setupWiFi() {
  Serial.print("[Wi-Fi] Connecting to ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void serviceWiFi() {
  static unsigned long lastRetry = 0;

  if (WiFi.status() == WL_CONNECTED) return;

  if (millis() - lastRetry >= 5000) {
    lastRetry = millis();

    Serial.println("[Wi-Fi] Reconnecting...");
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

// -------------------- MQTT ---------------------------
void reconnectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqtt.connected()) return;

  unsigned long now = millis();

  if (now - lastMqttRetryMs < MQTT_RETRY_MS) return;

  lastMqttRetryMs = now;

  String clientId = "ESP32_Geophone_NODE01_";
  clientId += String((uint32_t)ESP.getEfuseMac(), HEX);

  Serial.print("[MQTT] Connecting... ");

  if (mqtt.connect(clientId.c_str())) {
    Serial.println("CONNECTED");

    const char* testMsg =
      "{\"node_id\":\"NODE_01\",\"is_hardware\":true,"
      "\"status\":\"ONLINE\",\"test\":true}";

    if (mqtt.publish(MQTT_TOPIC, testMsg)) {
      Serial.println("[MQTT] Startup test publish SUCCESS");
    } else {
      Serial.println("[MQTT] Startup test publish FAILED");
    }
  } else {
    Serial.print("FAILED, state=");
    Serial.println(mqtt.state());
  }
}

// Find a completed block waiting for MQTT.
int findMQTTBlock() {
  int block = -1;

  if (xSemaphoreTake(bufferMutex, pdMS_TO_TICKS(5))) {
    for (uint8_t i = 0; i < NUM_BLOCKS; ++i) {
      if (pendingMQTT[i]) {
        block = i;
        pendingMQTT[i] = false;
        break;
      }
    }

    xSemaphoreGive(bufferMutex);
  }

  return block;
}

// Publish every one of the 200 samples in a block.
// The dashboard receives arrays wave_x/wave_y/wave_z.
bool publishWaveformBlock(uint8_t blockIndex) {
  if (!mqtt.connected()) return false;

  // Large JSON because it contains 600 waveform values.
  DynamicJsonDocument doc(18000);

  doc["node_id"] = NODE_ID;
  doc["is_hardware"] = true;
  doc["rtc_timestamp"] = getRTCTimestamp();

  doc["sample_rate_hz"] = SAMPLE_RATE_HZ;
  doc["sample_count"] = BLOCK_SIZE;
  doc["sample_interval_us"] = SAMPLE_INTERVAL_US;

  uint32_t firstSample = sampleBuffer[blockIndex][0].number;
  uint32_t lastSample =
    sampleBuffer[blockIndex][BLOCK_SIZE - 1].number;

  doc["first_sample"] = firstSample;
  doc["last_sample"] = lastSample;

  float peakX = 0.0f;
  float peakY = 0.0f;
  float peakZ = 0.0f;
  double sumMagSquared = 0.0;

  JsonArray ax = doc.createNestedArray("wave_x");
  JsonArray ay = doc.createNestedArray("wave_y");
  JsonArray az = doc.createNestedArray("wave_z");

  for (uint16_t i = 0; i < BLOCK_SIZE; ++i) {
    uint16_t rx = sampleBuffer[blockIndex][i].x;
    uint16_t ry = sampleBuffer[blockIndex][i].y;
    uint16_t rz = sampleBuffer[blockIndex][i].z;

    float vx = adcToMMS(rx);
    float vy = adcToMMS(ry);
    float vz = adcToMMS(rz);

    float mag = sqrtf(vx * vx + vy * vy + vz * vz);

    if (vx > peakX) peakX = vx;
    if (vy > peakY) peakY = vy;
    if (vz > peakZ) peakZ = vz;

    sumMagSquared += (double)mag * (double)mag;

    ax.add(roundf(vx * 100.0f) / 100.0f);
    ay.add(roundf(vy * 100.0f) / 100.0f);
    az.add(roundf(vz * 100.0f) / 100.0f);
  }

  float vMag = sqrtf(
    peakX * peakX +
    peakY * peakY +
    peakZ * peakZ
  );

  float rms = sqrtf((float)(sumMagSquared / BLOCK_SIZE));

  doc["vib_x"] = roundf(peakX * 100.0f) / 100.0f;
  doc["vib_y"] = roundf(peakY * 100.0f) / 100.0f;
  doc["vib_z"] = roundf(peakZ * 100.0f) / 100.0f;
  doc["vibration_val"] = roundf(vMag * 100.0f) / 100.0f;
  doc["rms"] = roundf(rms * 100.0f) / 100.0f;

  // Temporary feature values retained from your current dashboard firmware.
  doc["f_dom"] = (vMag >= 4.0f) ? 18.5f : 3.2f;
  doc["confidence"] = (vMag >= 4.0f) ? 94 : 85;
  doc["battery"] = 96.5f;
  doc["rssi"] = WiFi.RSSI();
  doc["snr"] = 11.2f;
  doc["status"] = (vMag >= 4.0f) ? "ALERT" : "ONLINE";

  // Mic/PIR are not connected yet.
  doc["mic_val"] = 0.0f;
  doc["mic_verified"] = false;
  doc["pir_active"] = false;

  char payload[16384];

  size_t len = serializeJson(doc, payload, sizeof(payload));

  if (len == 0 || len >= sizeof(payload)) {
    Serial.println(
      "[MQTT] ERROR: waveform JSON did not fit in buffer."
    );
    return false;
  }

  Serial.print("[MQTT] Publishing waveform block ");
  Serial.print(firstSample);
  Serial.print("-");
  Serial.print(lastSample);
  Serial.print(" | ");
  Serial.print(len);
  Serial.println(" bytes");

  bool ok = mqtt.publish(
    MQTT_TOPIC,
    (uint8_t*)payload,
    len
  );

  if (ok) {
    Serial.println(
      "[MQTT] FULL 200-SAMPLE WAVEFORM PUBLISH SUCCESS"
    );
    mqttBlocksPublished++;
  } else {
    Serial.println(
      "[MQTT] FULL 200-SAMPLE WAVEFORM PUBLISH FAILED"
    );
    mqttPublishFailures++;
  }

  return ok;
}

// -------------------- 200 Hz SAMPLING ----------------
void samplingTask(void* parameter) {
  uint32_t previousTime = 0;

  while (true) {
    uint32_t notifications =
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    if (notifications > 1) {
      missedTimerTicks += notifications - 1;
    }

    uint32_t sampleTime = micros();

    uint32_t intervalUS = 0;

    if (previousTime != 0) {
      intervalUS = sampleTime - previousTime;

      long error =
        (long)intervalUS - (long)SAMPLE_INTERVAL_US;

      if (error < 0) error = -error;

      if (error > 1000) {
        timingWarningCount++;
      }
    }

    previousTime = sampleTime;

    uint16_t x = analogRead(GEO_X);
    uint16_t y = analogRead(GEO_Y);
    uint16_t z = analogRead(GEO_Z);

    if (!xSemaphoreTake(bufferMutex, 0)) {
      bufferOverflowCount++;
      continue;
    }

    // Do not overwrite a block until both SD and MQTT have consumed it.
    if (pendingSD[writeBlock] ||
        pendingMQTT[writeBlock]) {

      bufferOverflowCount++;

      xSemaphoreGive(bufferMutex);
      continue;
    }

    Sample& s = sampleBuffer[writeBlock][writeIndex];

    s.number = totalSamples + 1;
    s.timestampUS = sampleTime;
    s.intervalUS = intervalUS;
    s.x = x;
    s.y = y;
    s.z = z;

    writeIndex++;
    totalSamples++;

    if (writeIndex >= BLOCK_SIZE) {
      pendingSD[writeBlock] = true;
      pendingMQTT[writeBlock] = true;

      writeBlock++;

      if (writeBlock >= NUM_BLOCKS) {
        writeBlock = 0;
      }

      writeIndex = 0;
    }

    xSemaphoreGive(bufferMutex);
  }
}

// -------------------- SETUP --------------------------
void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println();
  Serial.println("==================================================");
  Serial.println("ELEPHANT INTRUSION - ESP32 GEOPHONE NODE");
  Serial.println("200 Hz | ALL-SAMPLE SD | FULL WAVEFORM MQTT");
  Serial.println("==================================================");

  pinMode(GEO_X, INPUT);
  pinMode(GEO_Y, INPUT);
  pinMode(GEO_Z, INPUT);

  analogReadResolution(12);

  initRTC();
  initSDCard();
  setupWiFi();

  mqtt.setServer(MQTT_SERVER, MQTT_PORT);

  // Must be larger than the largest waveform JSON packet.
  mqtt.setBufferSize(16384);
  mqtt.setKeepAlive(30);
  mqtt.setSocketTimeout(5);

  bufferMutex = xSemaphoreCreateMutex();

  if (!bufferMutex) {
    Serial.println("[ERROR] Could not create buffer mutex.");
    while (true) delay(1000);
  }

  xTaskCreatePinnedToCore(
    samplingTask,
    "SamplingTask",
    4096,
    nullptr,
    3,
    &samplingTaskHandle,
    1
  );

  xTaskCreatePinnedToCore(
    sdWriterTask,
    "SDWriterTask",
    8192,
    nullptr,
    1,
    &sdTaskHandle,
    0
  );

  // ESP32 timer: divider 80 => 1 MHz timer clock.
  // 5000 ticks => 5 ms => 200 Hz.
  sampleTimer = timerBegin(0, 80, true);

  timerAttachInterrupt(
    sampleTimer,
    &onSampleTimer,
    true
  );

  timerAlarmWrite(
    sampleTimer,
    SAMPLE_INTERVAL_US,
    true
  );

  timerAlarmEnable(sampleTimer);

  lastStatusMs = millis();

  Serial.println(
    "[Sampling] Hardware timer started: 200 Hz"
  );
  Serial.println(
    "[Sampling] One MQTT waveform packet = 200 samples/axis"
  );
}

// -------------------- LOOP ---------------------------
void loop() {
  serviceWiFi();

  if (WiFi.status() == WL_CONNECTED) {
    reconnectMQTT();

    if (mqtt.connected()) {
      mqtt.loop();

      // Publish one completed block at a time.
      int block = findMQTTBlock();

      if (block >= 0) {
        bool ok = publishWaveformBlock(
          (uint8_t)block
        );

        if (!ok) {
          // Put it back. No samples are discarded because of a
          // temporary MQTT failure.
          if (xSemaphoreTake(
                bufferMutex,
                pdMS_TO_TICKS(5)
              )) {

            pendingMQTT[block] = true;

            xSemaphoreGive(bufferMutex);
          }
        }
      }
    }
  }

  // Operational status once per second.
  if (millis() - lastStatusMs >= 1000) {
    lastStatusMs += 1000;

    uint8_t pendingSDCount = 0;
    uint8_t pendingMQTTCount = 0;

    if (xSemaphoreTake(
          bufferMutex,
          pdMS_TO_TICKS(5)
        )) {

      for (uint8_t i = 0; i < NUM_BLOCKS; ++i) {
        if (pendingSD[i]) pendingSDCount++;
        if (pendingMQTT[i]) pendingMQTTCount++;
      }

      xSemaphoreGive(bufferMutex);
    }

    Serial.print("Samples: ");
    Serial.print(SAMPLE_RATE_HZ);
    Serial.print(" Hz | Total: ");
    Serial.print(totalSamples);
    Serial.print(" | SD: ");
    Serial.print(sdOK ? "OK" : "ERR");
    Serial.print(" | MQTT: ");
    Serial.print(mqtt.connected() ? "OK" : "DISC");
    Serial.print(" | SD Pending: ");
    Serial.print(pendingSDCount);
    Serial.print(" | MQTT Pending: ");
    Serial.print(pendingMQTTCount);
    Serial.print(" | MQTT Blocks: ");
    Serial.print(mqttBlocksPublished);
    Serial.print(" | MQTT Fail: ");
    Serial.print(mqttPublishFailures);
    Serial.print(" | Buffer Overflow: ");
    Serial.println(bufferOverflowCount);
  }
}