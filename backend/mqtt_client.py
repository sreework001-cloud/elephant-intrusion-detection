import json
import time
import math
import asyncio
import logging
from typing import Callable, Optional, Dict
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
        
        # Track active hardware nodes and their last-seen timestamp
        self.hardware_active_nodes: Dict[str, float] = {}

        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect

    def set_broadcast_callback(self, callback: Callable):
        self.broadcast_callback = callback

    def is_hardware_active(self, node_id: str, timeout_seconds: float = 30.0) -> bool:
        """
        Returns True if real physical ESP32 hardware sent telemetry for node_id recently.
        """
        last_seen = self.hardware_active_nodes.get(node_id, 0.0)
        return (time.time() - last_seen) < timeout_seconds

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
            # Mark as hardware packet if received via MQTT from external ESP32 or explicitly flagged
            data["is_hardware"] = True
            self.process_node_packet(data)
        except Exception as e:
            logger.error(f"Error decoding MQTT packet on {msg.topic}: {e}")

    def process_node_packet(self, data: dict):
        """
        Processes node payload from Gateway, ESP32 hardware, or Simulator.
        """
        node_id = data.get("node_id", "NODE_01")
        is_hardware = bool(data.get("is_hardware", False))
        
        if is_hardware:
            self.hardware_active_nodes[node_id] = time.time()
            logger.info(f"⚡ Real ESP32 Hardware packet received for {node_id}")

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

        # Edge Features (Actual or Temporary fallback for phase 1 hardware testing)
        f_dom = float(data.get("f_dom", 18.5 if vibration_val > 2.0 else 3.2))
        rms = float(data.get("rms", round(vibration_val * 0.707, 2)))
        kurtosis = float(data.get("kurtosis", 5.8 if vibration_val > 4.0 else 2.8))
        duration = float(data.get("duration", 2.4 if vibration_val > 4.0 else 0.4))
        
        mic_val = float(data.get("mic_val", 0.0))
        mic_verified = bool(data.get("mic_verified", False))
        pir_active = bool(data.get("pir_active", False))
        confidence = int(data.get("confidence", 85 if is_hardware else 50))
        battery = float(data.get("battery", 95.0 if is_hardware else 90.0))
        rssi = int(data.get("rssi", -62 if is_hardware else -68))
        snr = float(data.get("snr", 11.5 if is_hardware else 9.8))
        status = data.get("status", "ONLINE")

        # 1. Update Database
        update_node_status(node_id, status, battery, rssi, snr)
        log_telemetry(node_id, vib_x, vib_y, vib_z, vibration_val, f_dom, rms, kurtosis, duration, mic_val, pir_active, battery, rssi)

        alert_data = None
        siren_activated = False
        
        # 2. Check if threshold is breached
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
                    details=f"{'ESP32 Live Hardware Alert' if is_hardware else 'Simulation Alert'}. {eval_result['details']}"
                )
                eval_result["alert_id"] = alert_id
                eval_result["siren_activated"] = siren_activated
                alert_data = eval_result

        # 3. Broadcast to WebSockets
        if self.broadcast_callback:
            event_packet = {
                "type": "TELEMETRY_UPDATE",
                "data": {
                    "node_id": node_id,
                    "is_hardware": is_hardware,
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
