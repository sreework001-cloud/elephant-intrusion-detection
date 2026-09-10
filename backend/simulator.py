import asyncio
import logging
import math
import random
from typing import Optional

from backend.mqtt_client import mqtt_gateway

logger = logging.getLogger("TelemetrySimulator")

SAMPLE_RATE_HZ = 200


class NodeSimulator:
    def __init__(self):
        self.is_running = False
        self.nodes = ["NODE_01", "NODE_02"]
        self.batteries = {"NODE_01": 95.0, "NODE_02": 90.0}
        self.simulation_task: Optional[asyncio.Task] = None

    async def start(self):
        if self.is_running:
            return
        self.is_running = True
        logger.info("Two-node dashboard simulator started.")
        self.simulation_task = asyncio.create_task(self._simulation_loop())

    async def stop(self):
        self.is_running = False
        if self.simulation_task:
            self.simulation_task.cancel()
            try:
                await self.simulation_task
            except asyncio.CancelledError:
                pass
            self.simulation_task = None
        logger.info("Two-node dashboard simulator stopped.")

    @staticmethod
    def _make_waveform(vx, vy, vz, dominant_frequency, event=False):
        samples = []
        x_wave = []
        y_wave = []
        z_wave = []

        for i in range(SAMPLE_RATE_HZ):
            t = i / SAMPLE_RATE_HZ
            noise = random.uniform(-0.05, 0.05)
            envelope = 1.0
            if event:
                envelope = 0.45 + 0.55 * math.exp(-((t - 0.55) ** 2) / 0.08)

            x_wave.append(round((vx * envelope * math.sin(2 * math.pi * dominant_frequency * t)) + noise, 4))
            y_wave.append(round((vy * envelope * math.cos(2 * math.pi * dominant_frequency * t + 0.4)) + noise, 4))
            z_wave.append(round((vz * envelope * math.sin(2 * math.pi * dominant_frequency * t + 1.0)) + noise, 4))

        return x_wave, y_wave, z_wave

    async def _simulation_loop(self):
        while self.is_running:
            try:
                for node_id in self.nodes:
                    if mqtt_gateway.is_hardware_active(node_id):
                        continue

                    vx = round(random.uniform(0.08, 0.35), 3)
                    vy = round(random.uniform(0.06, 0.30), 3)
                    vz = round(random.uniform(0.10, 0.42), 3)
                    f_dom = round(random.uniform(1.2, 4.5), 1)
                    wave_x, wave_y, wave_z = self._make_waveform(vx, vy, vz, f_dom, event=False)

                    self.batteries[node_id] = max(
                        10.0,
                        round(self.batteries[node_id] - 0.001, 2),
                    )

                    packet = {
                        "node_id": node_id,
                        "is_hardware": False,
                        "sample_rate_hz": SAMPLE_RATE_HZ,
                        "sample_count": SAMPLE_RATE_HZ,
                        "vib_x": vx,
                        "vib_y": vy,
                        "vib_z": vz,
                        "vibration_val": round(math.sqrt(vx**2 + vy**2 + vz**2), 3),
                        "f_dom": f_dom,
                        "rms": round(random.uniform(0.08, 0.30), 3),
                        "kurtosis": round(random.uniform(2.1, 3.1), 2),
                        "duration": round(random.uniform(0.2, 0.6), 2),
                        "battery": self.batteries[node_id],
                        "rssi": random.randint(-72, -60),
                        "snr": round(random.uniform(9.0, 11.8), 1),
                        "status": "ONLINE",
                        "waveform_mode": "SIMULATED CONTINUOUS",
                        "wave_x": wave_x,
                        "wave_y": wave_y,
                        "wave_z": wave_z,
                        "raspberry_pi_status": "SIMULATED",
                        "lora_gateway_status": "SIMULATED",
                        "backhaul_4g_status": "SIMULATED",
                    }

                    mqtt_gateway.process_node_packet(packet)
                    await asyncio.sleep(0.6)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Simulator error: %s", exc)
                await asyncio.sleep(2.0)

    async def trigger_simulated_intrusion(self, sequence_type: str = "INBOUND"):
        """Simulate a Raspberry-Pi decision across the two demo nodes."""
        if sequence_type == "OUTBOUND":
            seq = [
                ("NODE_02", 1.8, 1.5, 2.2, 17.0, 88),
                ("NODE_01", 1.4, 1.2, 1.8, 15.5, 84),
            ]
            direction = "G2 → G1 (SIMULATED)"
        else:
            seq = [
                ("NODE_01", 3.0, 2.6, 4.0, 18.5, 94),
                ("NODE_02", 3.5, 3.0, 4.6, 19.2, 96),
            ]
            direction = "G1 → G2 (SIMULATED)"

        for index, (node_id, vx, vy, vz, fdom, conf) in enumerate(seq):
            if mqtt_gateway.is_hardware_active(node_id):
                continue

            wave_x, wave_y, wave_z = self._make_waveform(vx, vy, vz, fdom, event=True)
            total_vib = round(math.sqrt(vx**2 + vy**2 + vz**2), 3)

            packet = {
                "node_id": node_id,
                "is_hardware": False,
                "sample_rate_hz": SAMPLE_RATE_HZ,
                "sample_count": SAMPLE_RATE_HZ,
                "vib_x": vx,
                "vib_y": vy,
                "vib_z": vz,
                "vibration_val": total_vib,
                "f_dom": fdom,
                "rms": round(total_vib * 0.707, 3),
                "kurtosis": round(random.uniform(5.2, 6.8), 2),
                "duration": round(random.uniform(2.2, 3.6), 2),
                "battery": self.batteries[node_id],
                "rssi": random.randint(-68, -56),
                "snr": round(random.uniform(10.5, 12.5), 1),
                "status": "ONLINE",
                "waveform_mode": "SIMULATED EVENT SNIPPET",
                "waveform_is_event": True,
                "wave_x": wave_x,
                "wave_y": wave_y,
                "wave_z": wave_z,
                "classification": "ELEPHANT",
                "confidence": conf,
                "event": True,
                "event_status": "ELEPHANT DETECTED",
                "detected_node": node_id,
                "direction": direction,
                "location": "SIMULATED TWO-NODE EVENT",
                "details": "Simulated Raspberry Pi classification and alert decision; not a hardware ML result.",
                "siren_activated": index == len(seq) - 1,
                "raspberry_pi_status": "SIMULATED",
                "lora_gateway_status": "SIMULATED",
                "backhaul_4g_status": "SIMULATED",
            }

            mqtt_gateway.process_node_packet(packet)
            await asyncio.sleep(1.5)


simulator = NodeSimulator()
