import time
import random
import asyncio
import logging
from typing import Callable, Optional

from backend.mqtt_client import mqtt_gateway

logger = logging.getLogger("TelemetrySimulator")

class NodeSimulator:
    def __init__(self):
        self.is_running = False
        self.nodes = ["NODE_01", "NODE_02", "NODE_03"]
        self.batteries = {"NODE_01": 95.4, "NODE_02": 89.2, "NODE_03": 92.1}
        self.simulation_task: Optional[asyncio.Task] = None

    async def start(self):
        if self.is_running:
            return
        self.is_running = True
        logger.info("Triangular TDOA Multimodal System Simulator started.")
        self.simulation_task = asyncio.create_task(self._simulation_loop())

    async def stop(self):
        self.is_running = False
        if self.simulation_task:
            self.simulation_task.cancel()
            logger.info("Triangular TDOA Multimodal System Simulator stopped.")

    async def _simulation_loop(self):
        while self.is_running:
            try:
                for node_id in self.nodes:
                    # Triaxial Ambient noise (Horizontal X, Horizontal Y, Vertical Z in mm/s)
                    vx = round(random.uniform(0.08, 0.35), 2)
                    vy = round(random.uniform(0.06, 0.30), 2)
                    vz = round(random.uniform(0.10, 0.42), 2)
                    mic = round(random.uniform(0.05, 0.35), 2)
                    
                    self.batteries[node_id] = max(10.0, round(self.batteries[node_id] - 0.005, 2))
                    
                    packet = {
                        "node_id": node_id,
                        "vib_x": vx,
                        "vib_y": vy,
                        "vib_z": vz,
                        "f_dom": round(random.uniform(1.2, 4.5), 1),
                        "rms": round(random.uniform(0.1, 0.4), 2),
                        "kurtosis": round(random.uniform(2.1, 3.1), 1),
                        "duration": round(random.uniform(0.2, 0.6), 1),
                        "mic_val": mic,
                        "mic_verified": False,
                        "pir_active": False,
                        "confidence": 0,
                        "battery": self.batteries[node_id],
                        "rssi": random.randint(-72, -60),
                        "snr": round(random.uniform(9.0, 11.8), 1),
                        "status": "ONLINE"
                    }
                    
                    mqtt_gateway.process_node_packet(packet)
                    await asyncio.sleep(1.2)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Simulator error: {e}")
                await asyncio.sleep(2.0)

    async def trigger_simulated_intrusion(self, sequence_type: str = "INBOUND_NW"):
        """
        Simulate elephant movement sequence across the Triangular Sensor Array (G1, G2, G3).
        TDOA Delays are simulated in milliseconds.
        """
        if sequence_type == "INBOUND_NW":
            # G1 (0ms) -> G2 (18ms) -> G3 (42ms) (Approach from North-West)
            seq = [("NODE_01", 3.8, 3.2, 4.9, 18.5, 94), ("NODE_02", 4.2, 3.6, 5.4, 19.2, 96), ("NODE_03", 3.5, 3.0, 4.2, 17.8, 90)]
        elif sequence_type == "INBOUND_NE":
            # G1 (0ms) -> G3 (15ms) -> G2 (38ms) (Approach from North-East)
            seq = [("NODE_01", 4.0, 3.4, 5.1, 18.8, 94), ("NODE_03", 4.5, 3.9, 5.8, 20.1, 97), ("NODE_02", 3.4, 2.9, 4.1, 17.5, 89)]
        elif sequence_type == "OUTBOUND":
            # G2 (0ms) -> G3 (16ms) -> G1 (35ms) (Outbound Retreat back to forest)
            seq = [("NODE_02", 3.8, 3.2, 4.6, 19.0, 88), ("NODE_03", 3.6, 3.1, 4.3, 18.5, 86), ("NODE_01", 3.1, 2.6, 3.8, 18.0, 92)]
        else:
            # Direct South Incursion: G2 & G3 (0-12ms) -> G1 (45ms)
            seq = [("NODE_02", 4.5, 4.0, 5.8, 21.0, 98), ("NODE_03", 4.3, 3.8, 5.5, 20.5, 96), ("NODE_01", 3.2, 2.7, 4.0, 18.0, 91)]

        for node_id, vx, vy, vz, fdom, conf in seq:
            total_vib = round((vx**2 + vy**2 + vz**2)**0.5, 2)
            packet = {
                "node_id": node_id,
                "vib_x": vx,
                "vib_y": vy,
                "vib_z": vz,
                "f_dom": fdom,
                "rms": round(total_vib * 0.707, 2),
                "kurtosis": round(random.uniform(5.2, 6.8), 1),
                "duration": round(random.uniform(2.2, 3.6), 1),
                "mic_val": round(total_vib * 0.8, 2),
                "mic_verified": True,
                "pir_active": True,
                "confidence": conf,
                "battery": self.batteries[node_id],
                "rssi": random.randint(-68, -56),
                "snr": round(random.uniform(10.5, 12.5), 1),
                "status": "ALERT"
            }
            mqtt_gateway.process_node_packet(packet)
            await asyncio.sleep(2.5) # Time step between node arrival

# Global Singleton
simulator = NodeSimulator()
