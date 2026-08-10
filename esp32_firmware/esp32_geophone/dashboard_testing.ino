#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ===============================
// Wi-Fi
// ===============================
const char* ssid = "SRE";
const char* password = "12345678";

// ===============================
// MQTT
// ===============================
const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;

const char* mqtt_topic = "elephant/nodes/NODE_01";

WiFiClient espClient;
PubSubClient mqttClient(espClient);

unsigned long lastPublish = 0;


// ===============================
// Connect Wi-Fi
// ===============================
void connectWiFi()
{
  Serial.println();
  Serial.print("Connecting to Wi-Fi: ");
  Serial.println(ssid);

  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED)
  {
    delay(500);
    Serial.print(".");
  }

  Serial.println();
  Serial.println("Wi-Fi CONNECTED!");

  Serial.print("ESP32 IP Address: ");
  Serial.println(WiFi.localIP());

  Serial.print("Wi-Fi RSSI: ");
  Serial.print(WiFi.RSSI());
  Serial.println(" dBm");
}


// ===============================
// Connect MQTT
// ===============================
void connectMQTT()
{
  while (!mqttClient.connected())
  {
    Serial.println();
    Serial.print("Connecting to MQTT broker... ");

    String clientID = "ESP32_NODE_01_";
    clientID += String((uint32_t)ESP.getEfuseMac(), HEX);

    if (mqttClient.connect(clientID.c_str()))
    {
      Serial.println("MQTT CONNECTED!");
      Serial.print("Topic: ");
      Serial.println(mqtt_topic);
    }
    else
    {
      Serial.print("FAILED, state = ");
      Serial.println(mqttClient.state());

      Serial.println("Retrying in 3 seconds...");
      delay(3000);
    }
  }
}


// ===============================
// Publish test data
// ===============================
void publishTestData()
{
  StaticJsonDocument<512> doc;

  // Node identification
  doc["node_id"] = "NODE_01";
  doc["is_hardware"] = true;

  // FAKE GEOPHONE VALUES
  // These are only for connection testing.
  doc["vib_x"] = 0.45;
  doc["vib_y"] = 0.32;
  doc["vib_z"] = 0.58;

  // Magnitude
  doc["vibration_val"] = 0.80;

  // Temporary values
  doc["f_dom"] = 18.5;
  doc["rms"] = 0.56;
  doc["confidence"] = 85;

  // Temporary battery value
  doc["battery"] = 96.5;

  // Actual Wi-Fi RSSI
  doc["rssi"] = WiFi.RSSI();

  // Temporary SNR
  doc["snr"] = 11.5;

  // Node status
  doc["status"] = "ONLINE";

  char buffer[512];

  serializeJson(doc, buffer);

  Serial.println();
  Serial.println("Publishing data...");
  Serial.println(buffer);

  if (mqttClient.publish(mqtt_topic, buffer))
  {
    Serial.println("MQTT PUBLISH SUCCESS!");
  }
  else
  {
    Serial.println("MQTT PUBLISH FAILED!");
  }
}


// ===============================
// SETUP
// ===============================
void setup()
{
  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println("==============================");
  Serial.println(" ELEPHANT NODE 01 TEST");
  Serial.println("==============================");

  connectWiFi();

  mqttClient.setServer(mqtt_server, mqtt_port);

  connectMQTT();
}


// ===============================
// LOOP
// ===============================
void loop()
{
  // Check Wi-Fi
  if (WiFi.status() != WL_CONNECTED)
  {
    Serial.println("Wi-Fi disconnected!");
    connectWiFi();
  }

  // Check MQTT
  if (!mqttClient.connected())
  {
    connectMQTT();
  }

  mqttClient.loop();

  // Publish every 2 seconds
  if (millis() - lastPublish >= 2000)
  {
    lastPublish = millis();

    publishTestData();
  }
}