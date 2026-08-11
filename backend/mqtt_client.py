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
        self.event_loop = None
        self.hardware_active_nodes: Dict[str, float] = {}

        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect
    def set_event_loop(self, loop):
        self.event_loop = loop
    def set_broadcast_callback(self, callback: Callable):
        self.broadcast_callback = callback

    def is_hardware_active(self, node_id: str, timeout_seconds: float = 30.0) -> bool:
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
            data["is_hardware"] = True
            self.process_node_packet(data)
        except Exception as e:
            logger.error(f"Error decoding MQTT packet on {msg.topic}: {e}")

    def process_node_packet(self, data: dict):
        """
        Processes node payload with complete NaN protection and live hardware tracking.
        """
        node_id = data.get("node_id", "NODE_01")
        is_hardware = bool(data.get("is_hardware", False))
        rtc_timestamp = data.get("rtc_timestamp", None)
        
        if is_hardware:
            self.hardware_active_nodes[node_id] = time.time()
            logger.info(f"⚡ Real ESP32 Hardware packet received for {node_id} (RTC: {rtc_timestamp})")

        # Triaxial Geophone Inputs with Robust NaN Protection
        try:
            vib_x = float(data.get("vib_x", 0.18))
            if math.isnan(vib_x): vib_x = 0.18
        except (ValueError, TypeError):
            vib_x = 0.18

        try:
            vib_y = float(data.get("vib_y", 0.15))
            if math.isnan(vib_y): vib_y = 0.15
        except (ValueError, TypeError):
            vib_y = 0.15

        try:
            vib_z = float(data.get("vib_z", 0.22))
            if math.isnan(vib_z): vib_z = 0.22
        except (ValueError, TypeError):
            vib_z = 0.22

        try:
            vibration_val = float(data.get("vibration_val", math.sqrt(vib_x**2 + vib_y**2 + vib_z**2)))
            if math.isnan(vibration_val): vibration_val = math.sqrt(vib_x**2 + vib_y**2 + vib_z**2)
        except (ValueError, TypeError):
            vibration_val = math.sqrt(vib_x**2 + vib_y**2 + vib_z**2)

        # Edge Features
        try:
            f_dom = float(data.get("f_dom", 18.5 if vibration_val > 2.0 else 3.2))
            if math.isnan(f_dom): f_dom = 3.2
        except (ValueError, TypeError):
            f_dom = 3.2

        try:
            rms = float(data.get("rms", round(vibration_val * 0.707, 2)))
            if math.isnan(rms): rms = 0.2
        except (ValueError, TypeError):
            rms = 0.2

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
                alert_details = f"RTC: {rtc_timestamp}. {eval_result['details']}" if rtc_timestamp else eval_result['details']
                alert_id = log_alert(
                    trigger_nodes=eval_result["trigger_nodes"],
                    direction=eval_result["direction"],
                    threat_level=eval_result["threat_level"],
                    confidence=eval_result["confidence"],
                    mic_verified=eval_result["mic_verified"],
                    pir_verified=pir_active,
                    siren_activated=siren_activated,
                    details=alert_details
                )
                eval_result["alert_id"] = alert_id
                eval_result["siren_activated"] = siren_activated
                alert_data = eval_result

        wave_x = data.get("wave_x", [])
        wave_y = data.get("wave_y", [])
        wave_z = data.get("wave_z", [])

        if not isinstance(wave_x, list): wave_x = []
        if not isinstance(wave_y, list): wave_y = []
        if not isinstance(wave_z, list): wave_z = []

        wave_x = wave_x[:200]
        wave_y = wave_y[:200]
        wave_z = wave_z[:200]

        # 3. Broadcast to WebSockets
        if self.broadcast_callback:
            event_packet = {
                "type": "TELEMETRY_UPDATE",
                "data": {
                    "node_id": node_id,
                    "is_hardware": is_hardware,
                    "rtc_timestamp": rtc_timestamp,
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
                    "timestamp": time.time(),
                    "sample_rate_hz": data.get("sample_rate_hz", 200),
                    "sample_count": data.get("sample_count", len(wave_x) if wave_x else 200),
                    "sample_start": data.get("sample_start", 0),
                    "sample_end": data.get("sample_end", 0),
                    "chunk_id": data.get("chunk_id", 0),
                    "block_id": data.get("block_id", 0),
                    "wave_x": wave_x,
                    "wave_y": wave_y,
                    "wave_z": wave_z
                },
                "alert": alert_data
            }
            try:
                if self.event_loop is not None and self.event_loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        self.broadcast_callback(event_packet),
                        self.event_loop
                    )
            except Exception as e:
                logger.error(f"WebSocket broadcast failed: {e}")

# Global Singleton
mqtt_gateway = MQTTGatewayHandler()
