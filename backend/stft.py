import math
import random
import time
from typing import Dict, Any, List

def generate_stft_matrix(node_id: str, is_intrusion: bool = False, peak_freq: float = 18.5) -> Dict[str, Any]:
    """
    Generates Short-Time Fourier Transform (STFT) spectrogram data matrix.
    - Frequencies: 0 to 50 Hz (Seismic & Low Frequency Acoustic Band)
    - Time frames: 50 time steps across 5 seconds window (0.1s resolution)
    """
    num_time_frames = 50
    num_freq_bins = 40  # 0 to 50 Hz, step ~1.25 Hz
    
    freq_axis = [round(i * (50.0 / num_freq_bins), 1) for i in range(num_freq_bins)]
    time_axis = [round(i * 0.1, 1) for i in range(num_time_frames)]
    
    matrix: List[List[float]] = []
    
    # Fundamental elephant seismic footfall frequency range: 14 - 24 Hz
    target_freq = peak_freq if is_intrusion else 0.0
    
    for t_idx in range(num_time_frames):
        t = time_axis[t_idx]
        frame_energies = []
        
        # Periodic pulse modulation for footsteps (every ~1.2 seconds)
        footstep_envelope = 1.0
        if is_intrusion:
            phase = (t % 1.2) / 1.2
            footstep_envelope = math.exp(-((phase - 0.3) ** 2) / 0.04) * 3.5 + 0.5
        
        for f_idx in range(num_freq_bins):
            f = freq_axis[f_idx]
            
            # Ambient background noise floor (-60 dB to -40 dB)
            base_noise = random.uniform(0.02, 0.12)
            
            # Low frequency earth rumble (0 - 5 Hz)
            earth_rumble = math.exp(-((f - 2.0) ** 2) / 4.0) * 0.25
            
            intensity = base_noise + earth_rumble
            
            if is_intrusion and f > 2.0:
                # Primary elephant seismic footfall peak
                primary_peak = math.exp(-((f - target_freq) ** 2) / 12.0) * 0.85 * footstep_envelope
                # 2nd harmonic
                secondary_peak = math.exp(-((f - (target_freq * 1.8)) ** 2) / 18.0) * 0.4 * footstep_envelope
                intensity += primary_peak + secondary_peak
            
            # Clamp normalized intensity between 0.0 and 1.0
            intensity = max(0.0, min(1.0, intensity))
            frame_energies.append(round(intensity, 3))
            
        matrix.append(frame_energies)
        
    dominant_f = target_freq if is_intrusion else round(random.uniform(1.5, 4.0), 1)
    max_energy_db = round(20 * math.log10(max(max(row) for row in matrix) + 1e-5) + 60, 1)

    return {
        "node_id": node_id,
        "timestamp": time.time(),
        "is_intrusion": is_intrusion,
        "time_axis": time_axis,
        "freq_axis": freq_axis,
        "stft_matrix": matrix,
        "peak_frequency_hz": dominant_f,
        "peak_energy_db": max_energy_db,
        "bandwidth_hz": 12.5 if is_intrusion else 3.2,
        "signal_class": "Elephant Seismic Footfall (Infrasound)" if is_intrusion else "Ambient Environmental Baseline"
    }
