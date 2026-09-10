import asyncio
import json
import logging
import math
import time
from collections import defaultdict, deque
from typing import Callable, Dict, Optional

import paho.mqtt.client as mqtt

from backend.database import update_node_status, log_telemetry, log_alert

logger = logging.getLogger("MQTT_Gateway")

NODE_IDS = ("NODE_01", "NODE_02")
WAVEFORM_HISTORY_SAMPLES = 4000

# Recent waveform samples are retained in memory so the STFT endpoint can use
# actual received samples rather than generating synthetic spectra.
waveform_history = defaultdict(
    lambda: {
        "x": deque(maxlen=WAVEFORM_HISTORY_SAMPLES),
        "y": deque(maxlen=WAVEFORM_HISTORY_SAMPLES),
        "z": deque(maxlen=WAVEFORM_HISTORY_SAMPLES),
        "sample_rate_hz": 200,
        "last_update": 0.0,
    }
)


class MQTTGatewayHandler:
    def __init__(
        self,
        broker_host: str = "broker.hivemq.com",
        broker_port: int = 1883,
        topic: str = "elephant/nodes/#",
    ):
        self.broker_host = broker_host
        self.broker_port = broker_port
        self.topic = topic
        self.client = mqtt.Client(client_id="Elephant_Dashboard_Gateway_Receiver")
        self.broadcast_callback: Optional[Callable] = None
        self.is_connected = False
        self.event_loop = None
        self.hardware_active_nodes: Dict[str, float] = {}
        self.last_packet_time = 0.0

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
            logger.info(
                "Attempting connection to MQTT Broker %s:%s...",
                self.broker_host,
                self.broker_port,
            )
            self.client.connect_async(self.broker_host, self.broker_port, keepalive=60)
            self.client.loop_start()
        except Exception as exc:
            logger.warning("MQTT connection failed: %s", exc)

    def stop(self):
        try:
            self.client.loop_stop()
            self.client.disconnect()
        except Exception:
            pass

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self.is_connected = True
            logger.info("Connected to MQTT broker. Subscribing to %s", self.topic)
            client.subscribe(self.topic)
        else:
            self.is_connected = False
            logger.warning("MQTT connection failed with response code: %s", rc)

    def _on_disconnect(self, client, userdata, rc):
        self.is_connected = False
        logger.info("Disconnected from MQTT broker.")

    def _on_message(self, client, userdata, msg):
        try:
            payload_str = msg.payload.decode("utf-8")
            data = json.loads(payload_str)
            data["is_hardware"] = True
            self.process_node_packet(data)
        except Exception as exc:
            logger.error("Error decoding MQTT packet on %s: %s", msg.topic, exc)

    @staticmethod
    def _number(value, default=None):
        try:
            number = float(value)
            if math.isfinite(number):
                return number
        except (TypeError, ValueError):
            pass
        return default

    def _store_waveform(self, node_id: str, wave_x, wave_y, wave_z, sample_rate_hz):
        if node_id not in NODE_IDS:
            return

        if not (
            isinstance(wave_x, list)
            and isinstance(wave_y, list)
            and isinstance(wave_z, list)
        ):
            return

        count = min(len(wave_x), len(wave_y), len(wave_z))
        if count == 0:
            return

        history = waveform_history[node_id]
        history["sample_rate_hz"] = int(sample_rate_hz or 200)
        history["last_update"] = time.time()

        for index in range(count):
            x = self._number(wave_x[index])
            y = self._number(wave_y[index])
            z = self._number(wave_z[index])
            if x is None or y is None or z is None:
                continue
            history["x"].append(x)
            history["y"].append(y)
            history["z"].append(z)

    def process_node_packet(self, data: dict):
        """Process telemetry and transparently relay any supplied Pi decision."""
        node_id = str(data.get("node_id", "NODE_01"))
        if node_id not in NODE_IDS:
            logger.warning("Ignoring unsupported node_id=%s", node_id)
            return

        is_hardware = bool(data.get("is_hardware", False))
        rtc_timestamp = data.get("rtc_timestamp")
        packet_timestamp = time.time()
        self.last_packet_time = packet_timestamp

        if is_hardware:
            self.hardware_active_nodes[node_id] = packet_timestamp
            logger.info(
                "ESP32 packet received for %s (RTC: %s)",
                node_id,
                rtc_timestamp,
            )

        vib_x = self._number(data.get("vib_x"), 0.0)
        vib_y = self._number(data.get("vib_y"), 0.0)
        vib_z = self._number(data.get("vib_z"), 0.0)
        vibration_val = self._number(data.get("vibration_val"))
        if vibration_val is None:
            vibration_val = math.sqrt(vib_x**2 + vib_y**2 + vib_z**2)

        f_dom = self._number(data.get("f_dom"))
        rms = self._number(data.get("rms"))
        kurtosis = self._number(data.get("kurtosis"))
        duration = self._number(data.get("duration"))
        mic_val = self._number(data.get("mic_val"))
        battery = self._number(data.get("battery"))
        rssi_value = self._number(data.get("rssi"))
        rssi = int(rssi_value) if rssi_value is not None else None
        snr = self._number(data.get("snr"))
        status = str(data.get("status", "ONLINE"))
        sample_rate_hz = int(self._number(data.get("sample_rate_hz"), 200))

        mic_verified = bool(data.get("mic_verified", False))
        pir_active = bool(data.get("pir_active", False))

        # These are deliberately optional. The dashboard must never create
        # confidence/classification values that were not supplied by the
        # Raspberry Pi or another upstream decision source.
        classification = data.get("classification")
        confidence = self._number(data.get("confidence"))
        event_value = data.get("event")
        event_status = data.get("event_status") or data.get("alert_state")
        detected_node = data.get("detected_node") or data.get("source_node")
        direction = data.get("direction")
        location = data.get("location")
        tdoa_ms = self._number(data.get("tdoa_ms"))
        siren_activated = bool(data.get("siren_activated", False))

        wave_x = data.get("wave_x", [])
        wave_y = data.get("wave_y", [])
        wave_z = data.get("wave_z", [])
        if not isinstance(wave_x, list):
            wave_x = []
        if not isinstance(wave_y, list):
            wave_y = []
        if not isinstance(wave_z, list):
            wave_z = []

        self._store_waveform(node_id, wave_x, wave_y, wave_z, sample_rate_hz)

        update_node_status(node_id, status, battery, rssi, snr, packet_timestamp)
        log_telemetry(
            node_id,
            vib_x,
            vib_y,
            vib_z,
            vibration_val,
            f_dom,
            rms,
            kurtosis,
            duration,
            mic_val,
            pir_active,
            battery,
            rssi,
            snr,
            packet_timestamp,
        )

        # Only a supplied upstream event decision creates an alert record.
        # Vibration magnitude alone is not interpreted as an elephant event.
        event_is_true = event_value is True
        if isinstance(event_value, str):
            event_is_true = event_value.strip().upper() in {"TRUE", "1", "DETECTED", "YES"}
        if event_status:
            normalized_status = str(event_status).strip().upper()
            event_is_true = event_is_true or normalized_status in {
                "POSSIBLE EVENT",
                "ELEPHANT DETECTED",
                "DETECTED",
                "ALERT",
            }

        alert_data = None
        if event_is_true:
            trigger_nodes = str(detected_node or node_id)
            threat_level = "CRITICAL" if str(event_status).upper() in {"ELEPHANT DETECTED", "DETECTED", "ALERT"} else "WARNING"
            details = data.get("details") or "Decision received from upstream processing unit."

            alert_id = log_alert(
                trigger_nodes=trigger_nodes,
                direction=direction,
                threat_level=threat_level,
                confidence=confidence,
                classification=classification,
                event_status=event_status,
                detected_node=detected_node or node_id,
                dominant_frequency=f_dom,
                rms=rms,
                location=location,
                tdoa_ms=tdoa_ms,
                mic_verified=mic_verified,
                pir_verified=pir_active,
                siren_activated=siren_activated,
                details=details,
                timestamp=packet_timestamp,
            )

            alert_data = {
                "alert_id": alert_id,
                "timestamp": packet_timestamp,
                "trigger_nodes": trigger_nodes,
                "direction": direction,
                "threat_level": threat_level,
                "confidence": confidence,
                "classification": classification,
                "event_status": event_status,
                "detected_node": detected_node or node_id,
                "dominant_frequency": f_dom,
                "rms": rms,
                "location": location,
                "tdoa_ms": tdoa_ms,
                "details": details,
                "siren_activated": siren_activated,
            }

        decision = {
            "classification": classification,
            "confidence": confidence,
            "event": event_value,
            "event_status": event_status,
            "detected_node": detected_node,
            "timestamp": data.get("decision_timestamp") or rtc_timestamp or packet_timestamp,
        }

        system_status = {
            "dashboard_server": True,
            "gateway_uplink": self.is_connected,
            "lora_gateway": data.get("lora_gateway_status"),
            "raspberry_pi": data.get("raspberry_pi_status"),
            "backhaul_4g": data.get("backhaul_4g_status"),
            "last_packet": packet_timestamp,
        }

        event_packet = {
            "type": "TELEMETRY_UPDATE",
            "data": {
                "node_id": node_id,
                "is_hardware": is_hardware,
                "source_type": "ESP32 HARDWARE" if is_hardware else "SIMULATION",
                "rtc_timestamp": rtc_timestamp,
                "vib_x": vib_x,
                "vib_y": vib_y,
                "vib_z": vib_z,
                "vibration_val": round(vibration_val, 4),
                "f_dom": f_dom,
                "rms": rms,
                "kurtosis": kurtosis,
                "duration": duration,
                "mic_verified": mic_verified,
                "pir_active": pir_active,
                "battery": battery,
                "rssi": rssi,
                "snr": snr,
                "status": status,
                "timestamp": packet_timestamp,
                "sample_rate_hz": sample_rate_hz,
                "sample_count": data.get("sample_count", len(wave_x)),
                "first_sample": data.get("first_sample"),
                "last_sample": data.get("last_sample"),
                "waveform_mode": data.get("waveform_mode") or ("EVENT SNIPPET" if data.get("waveform_is_event") else "RECEIVED WAVEFORM"),
                "waveform_is_event": bool(data.get("waveform_is_event", False)),
                "wave_x": wave_x[:400],
                "wave_y": wave_y[:400],
                "wave_z": wave_z[:400],
            },
            "decision": decision,
            "alert": alert_data,
            "system_status": system_status,
        }

        if self.broadcast_callback and self.event_loop is not None and self.event_loop.is_running():
            try:
                asyncio.run_coroutine_threadsafe(
                    self.broadcast_callback(event_packet),
                    self.event_loop,
                )
            except Exception as exc:
                logger.error("WebSocket broadcast failed: %s", exc)


def get_recent_waveform(node_id: str, max_samples: int = 2000):
    if node_id not in NODE_IDS:
        return None

    history = waveform_history[node_id]
    count = min(max_samples, len(history["x"]))
    if count == 0:
        return None

    return {
        "node_id": node_id,
        "sample_rate_hz": history["sample_rate_hz"],
        "timestamp": history["last_update"],
        "x": list(history["x"])[-count:],
        "y": list(history["y"])[-count:],
        "z": list(history["z"])[-count:],
    }


mqtt_gateway = MQTTGatewayHandler()
