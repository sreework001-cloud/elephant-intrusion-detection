#include <Arduino.h>
#include <SPI.h>
#include <SD.h>
#include <Wire.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include "RTClib.h"

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char* MQTT_SERVER = "broker.hivemq.com";
const int MQTT_PORT = 1883;
const char* MQTT_TOPIC = "elephant/nodes/NODE_01";
const char* NODE_ID = "NODE_01";

#define SD_CS 5
#define X_AXIS 33
#define Y_AXIS 35
#define Z_AXIS 34
#define SDA_PIN 21
#define SCL_PIN 22

#define SAMPLE_RATE_HZ 200
#define SAMPLE_INTERVAL_US 5000UL

#define SD_BLOCK_SIZE 200
#define SD_NUM_BLOCKS 8

#define MQTT_BLOCK_SIZE 200
#define MQTT_NUM_BLOCKS 2

#define ADC_BASELINE 2048
#define ADC_TO_VOLTS (3.3f / 4095.0f)
#define VOLTS_TO_MMS 15.0f

#define SERIAL_PLOTTER_MODE 1
#define PLOTTER_INTERVAL_MS 20

struct Sample {
  uint32_t sampleNumber;
  uint32_t timestampUS;
  uint32_t intervalUS;
  uint16_t x;
  uint16_t y;
  uint16_t z;
  float vx;
  float vy;
  float vz;
};

struct MQTTBlock {
  uint32_t firstSample;
  uint32_t lastSample;
  uint16_t count;
  float x[MQTT_BLOCK_SIZE];
  float y[MQTT_BLOCK_SIZE];
  float z[MQTT_BLOCK_SIZE];
};

Sample sdBuffer[SD_NUM_BLOCKS][SD_BLOCK_SIZE];
MQTTBlock mqttBuffer[MQTT_NUM_BLOCKS];

volatile uint8_t sdWriteBlock = 0;
volatile uint8_t sdReadBlock = 0;
volatile uint16_t sdWriteIndex = 0;
volatile uint8_t sdReadyBlocks = 0;

volatile uint8_t mqttWriteBlock = 0;
volatile uint8_t mqttReadBlock = 0;
volatile uint8_t mqttWriteIndex = 0;
volatile uint8_t mqttReadyBlocks = 0;

TaskHandle_t samplingTaskHandle = NULL;
TaskHandle_t sdTaskHandle = NULL;
TaskHandle_t mqttTaskHandle = NULL;
TaskHandle_t wifiTaskHandle = NULL;
TaskHandle_t monitorTaskHandle = NULL;
TaskHandle_t plotterTaskHandle = NULL;

SemaphoreHandle_t sdMutex;
SemaphoreHandle_t mqttMutex;

hw_timer_t* sampleTimer = NULL;

RTC_DS3231 rtc;
File dataFile;

DateTime fileStartTime;
uint32_t fileStartMicros = 0;
char fileName[80];

WiFiClient espClient;
PubSubClient mqttClient(espClient);

volatile uint32_t totalSamples = 0;
volatile uint32_t missedTimerTicks = 0;
volatile uint32_t sdBufferOverflow = 0;
volatile uint32_t mqttBufferOverflow = 0;
volatile uint32_t timingWarnings = 0;
volatile uint32_t mqttBlocksSent = 0;
volatile uint32_t mqttBlocksDropped = 0;
volatile uint32_t mqttPublishFailures = 0;

volatile uint16_t latestRawX = 0;
volatile uint16_t latestRawY = 0;
volatile uint16_t latestRawZ = 0;

volatile float latestVX = 0.0f;
volatile float latestVY = 0.0f;
volatile float latestVZ = 0.0f;

volatile uint32_t latestSampleNumber = 0;
volatile uint32_t latestIntervalUS = 0;

bool previousWiFiState = false;
bool previousMQTTState = false;

void IRAM_ATTR onSampleTimer() {
  BaseType_t higherPriorityTaskWoken = pdFALSE;

  if (samplingTaskHandle != NULL) {
    vTaskNotifyGiveFromISR(
      samplingTaskHandle,
      &higherPriorityTaskWoken
    );
  }

  if (higherPriorityTaskWoken) {
    portYIELD_FROM_ISR();
  }
}

void createFileName(DateTime now) {
  sprintf(
    fileName,
    "/geophone/%04d-%02d-%02d_%02d-%02d-%02d.jsonl",
    now.year(),
    now.month(),
    now.day(),
    now.hour(),
    now.minute(),
    now.second()
  );
}

void startNewFile() {
  fileStartTime = rtc.now();
  createFileName(fileStartTime);

  dataFile = SD.open(fileName, FILE_WRITE);

  if (!dataFile) {
    Serial.println("ERROR: Cannot open SD file!");
    return;
  }

  dataFile.print("{\"type\":\"metadata\"");
  dataFile.print(",\"device\":\"ESP32-WROOM-32D\"");
  dataFile.print(",\"sensor\":\"3-axis Geophone\"");
  dataFile.print(",\"sample_rate_hz\":200");
  dataFile.print(",\"sample_interval_us\":5000");
  dataFile.print(",\"sd_buffer_blocks\":8");
  dataFile.print(",\"sd_block_size\":200");
  dataFile.print(",\"mqtt_topic\":\"elephant/nodes/NODE_01\"");
  dataFile.println("}");
  dataFile.flush();

  fileStartMicros = micros();
}

void writeSampleToSD(const Sample& s) {
  uint32_t elapsedUS = s.timestampUS - fileStartMicros;
  uint32_t elapsedMS = elapsedUS / 1000UL;
  uint32_t elapsedSeconds = elapsedMS / 1000UL;
  uint16_t milliseconds = elapsedMS % 1000UL;

  DateTime t = fileStartTime + TimeSpan(elapsedSeconds);

  dataFile.print("{\"sample\":");
  dataFile.print(s.sampleNumber);
  dataFile.print(",\"time\":\"");

  dataFile.printf(
    "%02d:%02d:%02d.%03d",
    t.hour(),
    t.minute(),
    t.second(),
    milliseconds
  );

  dataFile.print("\"");
  dataFile.print(",\"interval_us\":");
  dataFile.print(s.intervalUS);
  dataFile.print(",\"x\":");
  dataFile.print(s.x);
  dataFile.print(",\"y\":");
  dataFile.print(s.y);
  dataFile.print(",\"z\":");
  dataFile.print(s.z);
  dataFile.print(",\"vx\":");
  dataFile.print(s.vx, 4);
  dataFile.print(",\"vy\":");
  dataFile.print(s.vy, 4);
  dataFile.print(",\"vz\":");
  dataFile.print(s.vz, 4);
  dataFile.println("}");
}

void sdWriterTask(void* parameter) {
  while (true) {
    if (sdReadyBlocks == 0) {
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }

    uint8_t block;

    if (xSemaphoreTake(sdMutex, portMAX_DELAY)) {
      block = sdReadBlock;
      sdReadBlock++;

      if (sdReadBlock >= SD_NUM_BLOCKS) {
        sdReadBlock = 0;
      }

      sdReadyBlocks--;
      xSemaphoreGive(sdMutex);
    }

    for (uint16_t i = 0; i < SD_BLOCK_SIZE; i++) {
      writeSampleToSD(sdBuffer[block][i]);
    }

    dataFile.flush();
  }
}

void copyCompletedBlockToMQTT(uint8_t completedBlock) {
  if (WiFi.status() != WL_CONNECTED) {
    mqttBlocksDropped++;
    return;
  }

  if (!xSemaphoreTake(mqttMutex, 0)) {
    mqttBlocksDropped++;
    return;
  }

  if (mqttReadyBlocks >= MQTT_NUM_BLOCKS) {
    mqttBufferOverflow++;
    mqttBlocksDropped++;
    xSemaphoreGive(mqttMutex);
    return;
  }

  uint8_t destination = mqttWriteBlock;
  MQTTBlock& m = mqttBuffer[destination];

  m.firstSample = sdBuffer[completedBlock][0].sampleNumber;
  m.lastSample = sdBuffer[completedBlock][SD_BLOCK_SIZE - 1].sampleNumber;
  m.count = SD_BLOCK_SIZE;

  for (uint16_t i = 0; i < SD_BLOCK_SIZE; i++) {
    m.x[i] = sdBuffer[completedBlock][i].vx;
    m.y[i] = sdBuffer[completedBlock][i].vy;
    m.z[i] = sdBuffer[completedBlock][i].vz;
  }

  mqttWriteBlock++;

  if (mqttWriteBlock >= MQTT_NUM_BLOCKS) {
    mqttWriteBlock = 0;
  }

  mqttReadyBlocks++;
  xSemaphoreGive(mqttMutex);
}

void samplingTask(void* parameter) {
  uint32_t previousTime = 0;
  uint32_t sampleNumber = 0;

  while (true) {
    uint32_t notifications =
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);

    if (notifications > 1) {
      missedTimerTicks += notifications - 1;
    }

    uint32_t now = micros();
    uint32_t interval = 0;

    if (previousTime != 0) {
      interval = now - previousTime;
    }

    previousTime = now;

    uint16_t rawX = analogRead(X_AXIS);
    uint16_t rawY = analogRead(Y_AXIS);
    uint16_t rawZ = analogRead(Z_AXIS);

    float vx =
      ((int)rawX - ADC_BASELINE) *
      ADC_TO_VOLTS *
      VOLTS_TO_MMS;

    float vy =
      ((int)rawY - ADC_BASELINE) *
      ADC_TO_VOLTS *
      VOLTS_TO_MMS;

    float vz =
      ((int)rawZ - ADC_BASELINE) *
      ADC_TO_VOLTS *
      VOLTS_TO_MMS;

    latestRawX = rawX;
    latestRawY = rawY;
    latestRawZ = rawZ;

    latestVX = vx;
    latestVY = vy;
    latestVZ = vz;

    latestSampleNumber = sampleNumber + 1;
    latestIntervalUS = interval;

    if (interval != 0) {
      long error =
        (long)interval -
        (long)SAMPLE_INTERVAL_US;

      if (error < 0) {
        error = -error;
      }

      if (error > 1000) {
        timingWarnings++;
      }
    }

    if (xSemaphoreTake(sdMutex, 0)) {
      if (sdReadyBlocks < SD_NUM_BLOCKS) {
        uint8_t block = sdWriteBlock;

        Sample& s =
          sdBuffer[block][sdWriteIndex];

        s.sampleNumber = sampleNumber + 1;
        s.timestampUS = now;
        s.intervalUS = interval;
        s.x = rawX;
        s.y = rawY;
        s.z = rawZ;
        s.vx = vx;
        s.vy = vy;
        s.vz = vz;

        sdWriteIndex++;
        sampleNumber++;
        totalSamples++;

        if (sdWriteIndex >= SD_BLOCK_SIZE) {
          uint8_t completedBlock = sdWriteBlock;

          sdWriteIndex = 0;
          sdWriteBlock++;

          if (sdWriteBlock >= SD_NUM_BLOCKS) {
            sdWriteBlock = 0;
          }

          sdReadyBlocks++;

          xSemaphoreGive(sdMutex);
          copyCompletedBlockToMQTT(completedBlock);
          continue;
        }
      } else {
        sdBufferOverflow++;
      }

      xSemaphoreGive(sdMutex);
    }
  }
}

bool connectMQTT() {
  if (WiFi.status() != WL_CONNECTED) {
    return false;
  }

  if (mqttClient.connected()) {
    return true;
  }

  String clientID = "ESP32_Geophone_NODE01_";
  clientID += String((uint32_t)ESP.getEfuseMac(), HEX);

  bool result =
    mqttClient.connect(clientID.c_str());

  if (result) {
    previousMQTTState = true;
    return true;
  }

  previousMQTTState = false;
  return false;
}

bool publishMQTTBlock(MQTTBlock& block) {
  if (!mqttClient.connected()) {
    return false;
  }

  float peakX = 0.0f;
  float peakY = 0.0f;
  float peakZ = 0.0f;
  double sumSq = 0.0;

  for (uint16_t i = 0; i < block.count; i++) {
    float ax = fabs(block.x[i]);
    float ay = fabs(block.y[i]);
    float az = fabs(block.z[i]);

    if (ax > peakX) peakX = ax;
    if (ay > peakY) peakY = ay;
    if (az > peakZ) peakZ = az;

    float magnitude =
      sqrt(
        block.x[i] * block.x[i] +
        block.y[i] * block.y[i] +
        block.z[i] * block.z[i]
      );

    sumSq += magnitude * magnitude;
  }

  float rms =
    sqrt(sumSq / block.count);

  float vibrationValue =
    sqrt(
      peakX * peakX +
      peakY * peakY +
      peakZ * peakZ
    );

  DynamicJsonDocument doc(16000);

  doc["node_id"] = NODE_ID;
  doc["is_hardware"] = true;
  doc["sample_rate_hz"] = 200;
  doc["sample_count"] = block.count;
  doc["first_sample"] = block.firstSample;
  doc["last_sample"] = block.lastSample;

  DateTime now = rtc.now();

  char rtcTime[25];

  snprintf(
    rtcTime,
    sizeof(rtcTime),
    "%04d-%02d-%02d %02d:%02d:%02d",
    now.year(),
    now.month(),
    now.day(),
    now.hour(),
    now.minute(),
    now.second()
  );

  doc["rtc_timestamp"] = rtcTime;

  JsonArray waveX =
    doc.createNestedArray("wave_x");

  JsonArray waveY =
    doc.createNestedArray("wave_y");

  JsonArray waveZ =
    doc.createNestedArray("wave_z");

  for (uint16_t i = 0; i < block.count; i++) {
    waveX.add(
      round(block.x[i] * 100.0f) / 100.0f
    );

    waveY.add(
      round(block.y[i] * 100.0f) / 100.0f
    );

    waveZ.add(
      round(block.z[i] * 100.0f) / 100.0f
    );
  }

  doc["vib_x"] =
    round(peakX * 100.0f) / 100.0f;

  doc["vib_y"] =
    round(peakY * 100.0f) / 100.0f;

  doc["vib_z"] =
    round(peakZ * 100.0f) / 100.0f;

  doc["vibration_val"] =
    round(vibrationValue * 100.0f) / 100.0f;

  doc["rms"] =
    round(rms * 100.0f) / 100.0f;

  doc["f_dom"] = 0.0;
  doc["kurtosis"] = 0.0;
  doc["duration"] = 1.0;
  doc["mic_val"] = 0.0;
  doc["mic_verified"] = false;
  doc["pir_active"] = false;
  doc["confidence"] = 85;
  doc["battery"] = 100.0;
  doc["rssi"] = WiFi.RSSI();
  doc["snr"] = 0.0;
  doc["status"] = "ONLINE";

  String json;
  json.reserve(15000);

  serializeJson(doc, json);

  bool result =
    mqttClient.publish(
      MQTT_TOPIC,
      json.c_str()
    );

  if (result) {
    mqttBlocksSent++;
    return true;
  }

  mqttPublishFailures++;
  return false;
}

void mqttTask(void* parameter) {
  while (true) {
    if (WiFi.status() != WL_CONNECTED) {
      vTaskDelay(pdMS_TO_TICKS(100));
      continue;
    }

    if (!mqttClient.connected()) {
      connectMQTT();
      vTaskDelay(pdMS_TO_TICKS(1000));
      continue;
    }

    mqttClient.loop();

    if (mqttReadyBlocks == 0) {
      vTaskDelay(pdMS_TO_TICKS(1));
      continue;
    }

    uint8_t blockIndex;

    if (xSemaphoreTake(mqttMutex, portMAX_DELAY)) {
      blockIndex = mqttReadBlock;
      mqttReadBlock++;

      if (mqttReadBlock >= MQTT_NUM_BLOCKS) {
        mqttReadBlock = 0;
      }

      mqttReadyBlocks--;
      xSemaphoreGive(mqttMutex);
    }

    publishMQTTBlock(
      mqttBuffer[blockIndex]
    );
  }
}

void wifiTask(void* parameter) {
  while (true) {
    bool connected =
      WiFi.status() == WL_CONNECTED;

    if (!connected) {
      if (previousWiFiState) {
        Serial.println();
        Serial.println("WARNING: Wi-Fi CONNECTION LOST!");
        Serial.println("MQTT / DASHBOARD TRANSMISSION STOPPED.");
        Serial.println("SD CARD LOGGING CONTINUES.");
        Serial.println("200 Hz SAMPLING CONTINUES.");
      }

      previousWiFiState = false;

      WiFi.disconnect();
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    } else {
      if (!previousWiFiState) {
        Serial.println();
        Serial.println("Wi-Fi RECONNECTED!");
        Serial.print("IP Address: ");
        Serial.println(WiFi.localIP());
        Serial.println("MQTT transmission will resume.");
      }

      previousWiFiState = true;
    }

    vTaskDelay(pdMS_TO_TICKS(3000));
  }
}

void monitorTask(void* parameter) {
  uint32_t lastCount = 0;

  while (true) {
    vTaskDelay(pdMS_TO_TICKS(1000));

    uint32_t current = totalSamples;
    uint32_t samplesThisSecond =
      current - lastCount;

    lastCount = current;

    if (!SERIAL_PLOTTER_MODE) {
      Serial.println();
      Serial.println("---------- SAMPLE RATE ----------");

      Serial.print("Expected: ");
      Serial.print(SAMPLE_RATE_HZ);
      Serial.println(" samples/sec");

      Serial.print("Actual:   ");
      Serial.print(samplesThisSecond);
      Serial.println(" samples/sec");

      if (samplesThisSecond == 200) {
        Serial.println(
          "STATUS: 200 Hz acquisition OK"
        );
      } else {
        Serial.println(
          "WARNING: SAMPLE RATE IS NOT 200 Hz!"
        );
      }

      Serial.print("Ready blocks: ");
      Serial.print(sdReadyBlocks);
      Serial.print(" / ");
      Serial.println(SD_NUM_BLOCKS);

      Serial.print("Timer misses: ");
      Serial.println(missedTimerTicks);

      Serial.print("Buffer overflows: ");
      Serial.println(sdBufferOverflow);

      Serial.print("MQTT buffer overflows: ");
      Serial.println(mqttBufferOverflow);

      Serial.print("Timing warnings: ");
      Serial.println(timingWarnings);

      Serial.print("MQTT blocks sent: ");
      Serial.println(mqttBlocksSent);

      Serial.print("MQTT blocks dropped: ");
      Serial.println(mqttBlocksDropped);

      Serial.print("MQTT publish failures: ");
      Serial.println(mqttPublishFailures);

      Serial.print("Wi-Fi: ");

      if (WiFi.status() == WL_CONNECTED) {
        Serial.println("CONNECTED");
      } else {
        Serial.println(
          "DISCONNECTED - SD LOGGING CONTINUES"
        );
      }

      Serial.println("--------------------------------");
    }
  }
}

void plotterTask(void* parameter) {
  while (true) {
    float x = latestVX;
    float y = latestVY;
    float z = latestVZ;

    Serial.print("X:");
    Serial.print(x, 3);

    Serial.print("\tY:");
    Serial.print(y, 3);

    Serial.print("\tZ:");
    Serial.println(z, 3);

    vTaskDelay(
      pdMS_TO_TICKS(
        PLOTTER_INTERVAL_MS
      )
    );
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  pinMode(X_AXIS, INPUT);
  pinMode(Y_AXIS, INPUT);
  pinMode(Z_AXIS, INPUT);

  analogReadResolution(12);

  Wire.begin(SDA_PIN, SCL_PIN);

  if (!rtc.begin()) {
    Serial.println("WARNING: RTC NOT FOUND!");
  } else {
    if (rtc.lostPower()) {
      rtc.adjust(
        DateTime(
          F(__DATE__),
          F(__TIME__)
        )
      );
    }
  }

  if (!SD.begin(SD_CS)) {
    Serial.println("SD CARD FAILED!");
    while (1);
  }

  if (!SD.exists("/geophone")) {
    SD.mkdir("/geophone");
  }

  startNewFile();

  sdMutex =
    xSemaphoreCreateMutex();

  mqttMutex =
    xSemaphoreCreateMutex();

  if (sdMutex == NULL || mqttMutex == NULL) {
    Serial.println("MUTEX CREATION FAILED!");
    while (1);
  }

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.println("Connecting Wi-Fi...");

  uint32_t wifiStart = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - wifiStart < 10000
  ) {
    delay(500);
    Serial.print(".");
  }

  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi CONNECTED!");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    previousWiFiState = true;
  } else {
    Serial.println("WARNING: Wi-Fi unavailable.");
    Serial.println("SD LOGGING WILL CONTINUE.");
    previousWiFiState = false;
  }

  mqttClient.setServer(
    MQTT_SERVER,
    MQTT_PORT
  );

  mqttClient.setBufferSize(16384);
  mqttClient.setKeepAlive(30);

  xTaskCreatePinnedToCore(
    samplingTask,
    "SamplingTask",
    8192,
    NULL,
    5,
    &samplingTaskHandle,
    1
  );

  xTaskCreatePinnedToCore(
    sdWriterTask,
    "SDWriterTask",
    8192,
    NULL,
    2,
    &sdTaskHandle,
    0
  );

  xTaskCreatePinnedToCore(
    mqttTask,
    "MQTTTask",
    16384,
    NULL,
    2,
    &mqttTaskHandle,
    0
  );

  xTaskCreatePinnedToCore(
    wifiTask,
    "WiFiTask",
    4096,
    NULL,
    1,
    &wifiTaskHandle,
    0
  );

  xTaskCreatePinnedToCore(
    monitorTask,
    "MonitorTask",
    4096,
    NULL,
    1,
    &monitorTaskHandle,
    0
  );

  xTaskCreatePinnedToCore(
    plotterTask,
    "PlotterTask",
    4096,
    NULL,
    1,
    &plotterTaskHandle,
    0
  );

#if ESP_ARDUINO_VERSION_MAJOR >= 3

  sampleTimer =
    timerBegin(1000000);

  timerAttachInterrupt(
    sampleTimer,
    &onSampleTimer
  );

  timerAlarm(
    sampleTimer,
    SAMPLE_INTERVAL_US,
    true,
    0
  );

#else

  sampleTimer =
    timerBegin(
      0,
      80,
      true
    );

  timerAttachInterrupt(
    sampleTimer,
    &onSampleTimer,
    false
  );

  timerAlarmWrite(
    sampleTimer,
    SAMPLE_INTERVAL_US,
    true
  );

  timerAlarmEnable(sampleTimer);

#endif

  Serial.println();
  Serial.println("SYSTEM READY");
  Serial.println("Sampling: 200 Hz");
  Serial.println("Sample interval: 5 ms");
  Serial.println("SD JSONL: ENABLED");
  Serial.println("MQTT: ENABLED");
  Serial.println("Dashboard waveform: ENABLED");
  Serial.println("Serial Plotter: ENABLED");
  Serial.print("MQTT topic: ");
  Serial.println(MQTT_TOPIC);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000));
}
