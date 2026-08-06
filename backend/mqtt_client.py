import json
import time
import math
import asyncio
import logging
from typing import Callable, Optional
import paho.mqtt.client as mqtt

from backend.database import update_node_status, log_telemetry, log_alert
from backend.fusion_engine import fusion_engine

logger = logging.getLogger("MQTT_Gateway")

class MQTTGatewayHandler:
    def __init__(self, broker_host: str = "broker.hivemq.com", broker_port: int = 1883, topic: str = "elephant/nodes/#"):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.topic = topic
        self.client = mqtt.Client(client_id="Elephant_Dashboard_Gateway_Receiver")
        self.broadcast_callback: Optional[Callable] = None
        self.is_connected = False
        
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

    def set_broadcast_callback(self, callback: Callable):
        self.broadcast_callback = callback

    def start(self):
        try:
            logger.info(f"Attempting connection to MQTT Broker {self.broker_host}:{self.broker_port}...")
            self.client.connect_async(self.broker_host, self.broker_port, keepalive=60)
            self.client.loop_start()
        except Exception as e:
            logger.warning(f"MQTT Broker connection failed: {e}. Running in simulation/fallback mode.")

    def stop(self):
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self.is_connected = True
            logger.info(f"Connected to MQTT Broker. Subscribing to topic: {self.topic}")
            client.subscribe(self.topic)
        else:
            logger.warning(f"MQTT Connection failed with response code: {rc}")

    def _on_disconnect(self, client, userdata, rc):
        self.is_connected = False
        logger.info("Disconnected from MQTT Broker.")

    def _on_message(self, client, userdata, msg):
        try:
            payload_str = msg.payload.decode("utf-8")
            data = json.loads(payload_str)
            self.process_node_packet(data)
        except Exception as e:
            logger.error(f"Error decoding MQTT packet on {msg.topic}: {e}")

    def process_node_packet(self, data: dict):
        """
        Processes node payload according to the 6-Layer System Architecture diagram.
        Extracts Triaxial Geophone (X, Y, Z) and Edge Features (f_dom, RMS, Kurtosis, Duration, PIR/Mic).
        """
        node_id = data.get("node_id", "NODE_01")
        
        # Triaxial Geophone Inputs (X, Y, Z)
        if "vib_x" in data and "vib_y" in data and "vib_z" in data:
            vib_x = float(data["vib_x"])
            vib_y = float(data["vib_y"])
            vib_z = float(data["vib_z"])
            vibration_val = math.sqrt(vib_x**2 + vib_y**2 + vib_z**2)
        else:
            vibration_val = float(data.get("vibration_val", 0.3))
            vib_x = round(vibration_val * 0.58, 2)
            vib_y = round(vibration_val * 0.52, 2)
            vib_z = round(vibration_val * 0.63, 2)

        # Edge Processing Features
        f_dom = float(data.get("f_dom", 18.5 if vibration_val > 2.0 else 3.2))
        rms = float(data.get("rms", round(vibration_val * 0.707, 2)))
        kurtosis = float(data.get("kurtosis", 5.8 if vibration_val > 4.0 else 2.8))
        duration = float(data.get("duration", 2.4 if vibration_val > 4.0 else 0.4))
        
        mic_val = float(data.get("mic_val", 0.0))
        mic_verified = bool(data.get("mic_verified", False))
        pir_active = bool(data.get("pir_active", False))
        confidence = int(data.get("confidence", 50))
        battery = float(data.get("battery", 90.0))
        rssi = int(data.get("rssi", -68))
        snr = float(data.get("snr", 9.8))
        status = data.get("status", "ONLINE")

        # 1. Update Database
        update_node_status(node_id, status, battery, rssi, snr)
        log_telemetry(node_id, vib_x, vib_y, vib_z, vibration_val, f_dom, rms, kurtosis, duration, mic_val, pir_active, battery, rssi)

        alert_data = None
        siren_activated = False
        
        # 2. Check if intrusion threshold is breached (Gateway Decision Engine)
        if vibration_val >= 4.0 or status == "ALERT" or (mic_verified and pir_active):
            eval_result = fusion_engine.register_node_trigger(node_id, vibration_val, mic_verified, confidence)
            if eval_result:
                siren_activated = (eval_result["threat_level"] == "CRITICAL")
                alert_id = log_alert(
                    trigger_nodes=eval_result["trigger_nodes"],
                    direction=eval_result["direction"],
                    threat_level=eval_result["threat_level"],
                    confidence=eval_result["confidence"],
                    mic_verified=eval_result["mic_verified"],
                    pir_verified=pir_active,
                    siren_activated=siren_activated,
                    details=f"{eval_result['details']} Edge Features: f_dom={f_dom}Hz, RMS={rms}, Kurtosis={kurtosis}."
                )
                eval_result["alert_id"] = alert_id
                eval_result["siren_activated"] = siren_activated
                alert_data = eval_result

        # 3. Broadcast packet to WebSockets
        if self.broadcast_callback:
            event_packet = {
                "type": "TELEMETRY_UPDATE",
                "data": {
                    "node_id": node_id,
                    "vib_x": vib_x,
                    "vib_y": vib_y,
                    "vib_z": vib_z,
                    "vibration_val": round(vibration_val, 2),
                    "f_dom": f_dom,
                    "rms": rms,
                    "kurtosis": kurtosis,
                    "duration": duration,
                    "mic_val": mic_val,
                    "mic_verified": mic_verified,
                    "pir_active": pir_active,
                    "confidence": confidence,
                    "battery": battery,
                    "rssi": rssi,
                    "snr": snr,
                    "status": status,
                    "timestamp": time.time()
                },
                "alert": alert_data
            }
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    loop.create_task(self.broadcast_callback(event_packet))
            except Exception:
                pass

# Global Singleton
mqtt_gateway = MQTTGatewayHandler()
