/*
  ===============================================================================
  🐘 ESP32 MQTT DIAGNOSTIC & TCP PORT REACHABILITY TESTER 🐘
  ===============================================================================
  Purpose: Isolate MQTT CONNECT/CONNACK handshake failure.
  
  Status:
    ✅ 200 Hz Sampling
    ✅ SD Card
    ✅ RTC
    ✅ Wi-Fi (Phone Hotspot)
    ✅ TCP to broker.hivemq.com:1883
    ❌ MQTT Handshake — THIS IS WHAT WE ARE DEBUGGING
  
  Hotspot: SSID="SRE", Password="12345678"
  Broker: broker.hivemq.com:1883
  Topic: elephant/nodes/NODE_01
  
  NOTE: PubSubClient defaults to MQTT_VERSION_3_1_1 internally.
        setProtocolVersion() is not a public method in PubSubClient;
        protocol version is controlled via the MQTT_VERSION define
        which already defaults to MQTT_VERSION_3_1_1.
  ===============================================================================
*/

#include <WiFi.h>
#include <PubSubClient.h>

const char* ssid = "SRE";
const char* password = "12345678";

const char* mqtt_server = "broker.hivemq.com";
const int mqtt_port = 1883;
const char* mqtt_topic = "elephant/nodes/NODE_01";

WiFiClient espClient;
PubSubClient client(espClient);

bool mqttOK = false;

void testTCPPortReachability() {
  Serial.println();
  Serial.println("[TEST 1] Testing TCP Port 1883 reachability to HiveMQ...");
  Serial.print("[TEST 1] Connecting to ");
  Serial.print(mqtt_server);
  Serial.print(" on port ");
  Serial.println(mqtt_port);

  WiFiClient testClient;
  if (testClient.connect(mqtt_server, mqtt_port)) {
    Serial.println("[TEST 1 SUCCESS] HiveMQ TCP CONNECTION SUCCESSFUL! Port 1883 is reachable.");
    testClient.stop();
  } else {
    Serial.println("[TEST 1 FAILED] HiveMQ TCP CONNECTION FAILED! Outbound port 1883 is blocked or unresolvable.");
  }
}

void reconnectMQTT() {

  if (client.connected()) {
    mqttOK = true;
    return;
  }

  Serial.println();
  Serial.println("[MQTT] Connecting...");

  String clientId = "ESP32_NODE_01_";
  clientId += String((uint32_t)ESP.getEfuseMac(), HEX);

  Serial.print("[MQTT] Client ID: ");
  Serial.println(clientId);

  unsigned long start = millis();

  bool connected = client.connect(clientId.c_str());

  unsigned long elapsed = millis() - start;

  Serial.print("[MQTT] Connection attempt took ");
  Serial.print(elapsed);
  Serial.println(" ms");

  if (connected) {

    mqttOK = true;

    Serial.println("[MQTT] CONNECTED SUCCESSFULLY!");
    Serial.print("[MQTT] Topic: ");
    Serial.println(mqtt_topic);

    // Immediately test publish
    const char* testMsg = "{\"node_id\":\"NODE_01\",\"is_hardware\":true,\"status\":\"ONLINE\",\"test\":true}";
    Serial.print("[MQTT] Publishing test packet to ");
    Serial.print(mqtt_topic);
    Serial.print("... ");
    if (client.publish(mqtt_topic, testMsg)) {
      Serial.println("SUCCESS!");
    } else {
      Serial.println("FAILED!");
    }

  } else {

    mqttOK = false;

    Serial.print("[MQTT] FAILED | State Code = ");
    int st = client.state();
    Serial.println(st);

    // Print state code meaning
    switch (st) {
      case -4: Serial.println("[MQTT State Meaning] -4: MQTT_CONNECTION_TIMEOUT — Broker did not respond to CONNECT packet within timeout window"); break;
      case -3: Serial.println("[MQTT State Meaning] -3: MQTT_CONNECTION_LOST — TCP connection dropped during handshake"); break;
      case -2: Serial.println("[MQTT State Meaning] -2: MQTT_CONNECT_FAILED — Socket/TCP failed to connect to broker"); break;
      case -1: Serial.println("[MQTT State Meaning] -1: MQTT_DISCONNECTED — Client is not connected"); break;
      case  0: Serial.println("[MQTT State Meaning]  0: MQTT_CONNECTED — (Should not appear here)"); break;
      case  1: Serial.println("[MQTT State Meaning]  1: MQTT_CONNECT_BAD_PROTOCOL — Broker rejected: unsupported protocol version"); break;
      case  2: Serial.println("[MQTT State Meaning]  2: MQTT_CONNECT_BAD_CLIENT_ID — Broker rejected: client ID not accepted"); break;
      case  3: Serial.println("[MQTT State Meaning]  3: MQTT_CONNECT_UNAVAILABLE — Broker rejected: server unavailable"); break;
      case  4: Serial.println("[MQTT State Meaning]  4: MQTT_CONNECT_BAD_CREDENTIALS — Broker rejected: bad username/password"); break;
      case  5: Serial.println("[MQTT State Meaning]  5: MQTT_CONNECT_UNAUTHORIZED — Broker rejected: not authorized"); break;
      default: Serial.print("[MQTT State Meaning] Unknown error state: "); Serial.println(st); break;
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==========================================================");
  Serial.println("🐘 ESP32 MQTT DIAGNOSTIC — CONNECT/CONNACK HANDSHAKE 🐘");
  Serial.println("==========================================================");
  Serial.println("Purpose: Isolate why MQTT handshake is not completing.");
  Serial.println("All other subsystems (ADC, SD, RTC) are NOT loaded.");
  Serial.println("==========================================================");

  // --- Wi-Fi Connection ---
  Serial.print("\n[Wi-Fi] Connecting to Personal Hotspot: ");
  Serial.println(ssid);
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.println("\n[Wi-Fi] CONNECTED!");
  Serial.print("[Wi-Fi] ESP32 IP Address: ");
  Serial.println(WiFi.localIP());
  Serial.print("[Wi-Fi] Gateway: ");
  Serial.println(WiFi.gatewayIP());
  Serial.print("[Wi-Fi] DNS: ");
  Serial.println(WiFi.dnsIP());
  Serial.print("[Wi-Fi] RSSI: ");
  Serial.print(WiFi.RSSI());
  Serial.println(" dBm");

  // --- TCP Reachability Test ---
  testTCPPortReachability();

  // --- Configure MQTT Client ---
  client.setServer(mqtt_server, mqtt_port);
  client.setSocketTimeout(5);   // 5-second socket timeout (faster failure detection)
  client.setKeepAlive(30);      // 30-second keepalive interval

  Serial.println("\n[MQTT Config] Broker: broker.hivemq.com");
  Serial.println("[MQTT Config] Port: 1883");
  Serial.println("[MQTT Config] Socket Timeout: 5 seconds");
  Serial.println("[MQTT Config] Keep Alive: 30 seconds");
  Serial.println("[MQTT Config] Protocol: MQTT 3.1.1 (PubSubClient default)");
  Serial.println("[MQTT Config] Topic: elephant/nodes/NODE_01");
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!client.connected()) {
      reconnectMQTT();
      delay(3000); // Wait 3s between retry attempts
    } else {
      client.loop();
      delay(1000);
    }
  } else {
    Serial.println("[Wi-Fi] Lost connection. Reconnecting...");
    WiFi.begin(ssid, password);
    delay(5000);
  }
}
