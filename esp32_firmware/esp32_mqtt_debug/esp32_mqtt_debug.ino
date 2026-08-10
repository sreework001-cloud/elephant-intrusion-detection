/*
  ===============================================================================
  🐘 ESP32 MQTT DIAGNOSTIC & TCP PORT REACHABILITY TESTER 🐘
  ===============================================================================
  Target: Test HiveMQ TCP reachability and print exact MQTT client state code.
  Hotspot: SSID="SRE", Password="12345678"
  Broker: broker.hivemq.com:1883
  Topic: elephant/nodes/NODE_01
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
  if (!client.connected()) {
    Serial.println();
    Serial.println("[MQTT] Connecting...");
    Serial.print("[MQTT] Broker: ");
    Serial.println(mqtt_server);
    Serial.print("[MQTT] Port: ");
    Serial.println(mqtt_port);

    String clientId = "ESP32_NODE_01_";
    clientId += String(random(0xffff), HEX);

    if (client.connect(clientId.c_str())) {
      Serial.println("[MQTT] CONNECTED SUCCESSFUL!");
      
      // Test publish
      const char* testMsg = "{\"node_id\":\"NODE_01\",\"is_hardware\":true,\"status\":\"ONLINE\",\"test\":true}";
      if (client.publish(mqtt_topic, testMsg)) {
        Serial.println("[MQTT] Published test packet: SUCCESS!");
      } else {
        Serial.println("[MQTT] Publish test packet: FAILED!");
      }
    } else {
      Serial.print("[MQTT] FAILED. State code = ");
      Serial.println(client.state());
      
      // Print state code meaning
      int st = client.state();
      switch(st) {
        case -4: Serial.println("[MQTT State Meaning] -4: MQTT_CONNECTION_TIMEOUT"); break;
        case -3: Serial.println("[MQTT State Meaning] -3: MQTT_CONNECTION_LOST"); break;
        case -2: Serial.println("[MQTT State Meaning] -2: MQTT_CONNECT_FAILED (Socket failed to connect)"); break;
        case -1: Serial.println("[MQTT State Meaning] -1: MQTT_DISCONNECTED"); break;
        case 1:  Serial.println("[MQTT State Meaning] 1: MQTT_CONNECT_BAD_PROTOCOL"); break;
        case 2:  Serial.println("[MQTT State Meaning] 2: MQTT_CONNECT_BAD_CLIENT_ID"); break;
        case 3:  Serial.println("[MQTT State Meaning] 3: MQTT_CONNECT_UNAVAILABLE"); break;
        case 4:  Serial.println("[MQTT State Meaning] 4: MQTT_CONNECT_BAD_CREDENTIALS"); break;
        case 5:  Serial.println("[MQTT State Meaning] 5: MQTT_CONNECT_UNAUTHORIZED"); break;
        default: Serial.println("[MQTT State Meaning] Unknown error state"); break;
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==========================================================");
  Serial.println("🐘 ESP32 MQTT DIAGNOSTIC & PORT 1883 REACHABILITY SKETCH 🐘");
  Serial.println("==========================================================");

  Serial.print("[Wi-Fi] Connecting to Personal Hotspot: ");
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

  // Run TCP Reachability test
  testTCPPortReachability();

  // Configure MQTT
  client.setServer(mqtt_server, mqtt_port);
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!client.connected()) {
      reconnectMQTT();
      delay(3000);
    } else {
      client.loop();
      delay(1000);
    }
  }
}
