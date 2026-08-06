import time
from typing import Dict, List, Optional, Any

class TriangularTDOAFusionEngine:
    """
    Direction Mapping & Path Estimation Engine using 3-Node Triangular Array.
    Calculates Time Difference of Arrival (TDOA) in milliseconds between G1, G2, G3.
    
    Layout:
         G1 (Apex - Deep Forest Trail)
         /  \
        /    \
      G2 ---- G3 (Boundary - Agricultural Border)
    """
    def __init__(self, tdoa_window_seconds: float = 5.0):
        self.tdoa_window = tdoa_window_seconds
        self.node_arrival_times: Dict[str, float] = {}
        self.node_amplitudes: Dict[str, float] = {}
        self.node_confidence: Dict[str, int] = {}
        self.mic_status: Dict[str, bool] = {}

    def register_node_trigger(self, node_id: str, vibration_val: float, mic_verified: bool, confidence: int) -> Optional[Dict[str, Any]]:
        now = time.time()
        
        # Reset window if last trigger was long ago (>15s)
        if self.node_arrival_times and max(self.node_arrival_times.values()) < (now - 15.0):
            self.clear_history()

        self.node_arrival_times[node_id] = now
        self.node_amplitudes[node_id] = vibration_val
        self.node_confidence[node_id] = confidence
        self.mic_status[node_id] = mic_verified

        return self._evaluate_tdoa_direction()

    def _evaluate_tdoa_direction(self) -> Dict[str, Any]:
        """
        Calculates Time Difference of Arrival (TDOA) in milliseconds and estimates intrusion direction vector.
        """
        # Determine arrival order
        sorted_triggers = sorted(self.node_arrival_times.items(), key=lambda x: x[1])
        t_first = sorted_triggers[0][1]
        
        # Calculate TDOA delays in ms relative to first node
        tdoa_delays = {}
        for nid in ["NODE_01", "NODE_02", "NODE_03"]:
            if nid in self.node_arrival_times:
                delay_ms = round((self.node_arrival_times[nid] - t_first) * 1000, 1)
                tdoa_delays[nid] = delay_ms
            else:
                tdoa_delays[nid] = 999.0 # Not yet triggered

        nearest_node = sorted_triggers[0][0]
        nearest_label = "G1 (Deep Forest)" if nearest_node == "NODE_01" else ("G2 (Left Boundary)" if nearest_node == "NODE_02" else "G3 (Right Boundary)")
        
        num_triggered = len(self.node_arrival_times)
        max_conf = max(self.node_confidence.values()) if self.node_confidence else 75
        any_mic = any(self.mic_status.values())

        # Direction Mapping Logic based on Triangular TDOA
        direction = "Localized Activity"
        threat_level = "WARNING"
        compass_bearing = "N"
        
        if num_triggered == 1:
            if nearest_node == "NODE_01":
                direction = "⬅ North-West (Approach from Deep Forest)"
                compass_bearing = "NW"
                threat_level = "WARNING"
            elif nearest_node == "NODE_02":
                direction = "↙ South-West (Agricultural Border Left)"
                compass_bearing = "SW"
                threat_level = "CRITICAL"
            else:
                direction = "↘ South-East (Agricultural Border Right)"
                compass_bearing = "SE"
                threat_level = "CRITICAL"
        else:
            # Multi-Node TDOA Direction Resolution
            first_two = [t[0] for t in sorted_triggers[:2]]
            
            if first_two == ["NODE_01", "NODE_02"]:
                direction = "↙ Inbound trajectory: Deep Forest → Left Border (NW to SW)"
                compass_bearing = "SW"
                threat_level = "CRITICAL"
                max_conf = min(98, max_conf + 12)
            elif first_two == ["NODE_01", "NODE_03"]:
                direction = "↘ Inbound trajectory: Deep Forest → Right Border (NE to SE)"
                compass_bearing = "SE"
                threat_level = "CRITICAL"
                max_conf = min(98, max_conf + 12)
            elif first_two == ["NODE_02", "NODE_03"] or first_two == ["NODE_03", "NODE_02"]:
                direction = "⬇ Direct Incursion: Agricultural Line Perimeter"
                compass_bearing = "S"
                threat_level = "CRITICAL"
                max_conf = min(99, max_conf + 15)
            elif sorted_triggers[0][0] in ["NODE_02", "NODE_03"] and sorted_triggers[-1][0] == "NODE_01":
                direction = "⬆ Outbound Retreat: Moving back into Deep Forest"
                compass_bearing = "N"
                threat_level = "LOW"

        trigger_summary = " → ".join([t[0] for t in sorted_triggers])
        tdoa_str = f"TDOA: G1={tdoa_delays['NODE_01']}ms, G2={tdoa_delays['NODE_02']}ms, G3={tdoa_delays['NODE_03']}ms"
        details = f"Triangular TDOA Direction Mapping. Nearest Node: {nearest_label}. [{tdoa_str}]. Sequence: [{trigger_summary}]."

        return {
            "trigger_nodes": trigger_summary,
            "direction": direction,
            "nearest_node": nearest_node,
            "nearest_label": nearest_label,
            "compass_bearing": compass_bearing,
            "threat_level": threat_level,
            "confidence": max_conf,
            "mic_verified": any_mic,
            "tdoa_delays": tdoa_delays,
            "details": details,
            "latest_node": sorted_triggers[-1][0],
            "timestamp": sorted_triggers[-1][1]
        }

    def clear_history(self):
        self.node_arrival_times.clear()
        self.node_amplitudes.clear()
        self.node_confidence.clear()
        self.mic_status.clear()

# Global Singleton
fusion_engine = TriangularTDOAFusionEngine()
