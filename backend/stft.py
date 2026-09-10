import math
import time
from typing import Any, Dict, List

from backend.mqtt_client import get_recent_waveform


WINDOW_SIZE = 128
HOP_SIZE = 64
MAX_FREQUENCY_HZ = 100.0


def _composite_waveform(x: List[float], y: List[float], z: List[float]) -> List[float]:
    count = min(len(x), len(y), len(z))
    return [
        math.sqrt(x[i] ** 2 + y[i] ** 2 + z[i] ** 2)
        for i in range(count)
    ]


def _dft_power(frame: List[float], sample_rate_hz: float) -> tuple[List[float], List[float]]:
    n = len(frame)
    half = n // 2
    frequencies = []
    powers = []

    # Hann window. The DC mean is removed before the transform.
    mean = sum(frame) / n
    windowed = []
    for i, value in enumerate(frame):
        window = 0.5 - 0.5 * math.cos((2.0 * math.pi * i) / (n - 1))
        windowed.append((value - mean) * window)

    for k in range(half + 1):
        frequency = (k * sample_rate_hz) / n
        if frequency > MAX_FREQUENCY_HZ:
            break

        real = 0.0
        imag = 0.0
        for index, value in enumerate(windowed):
            angle = (2.0 * math.pi * k * index) / n
            real += value * math.cos(angle)
            imag -= value * math.sin(angle)

        power = (real * real + imag * imag) / max(1, n * n)
        frequencies.append(round(frequency, 2))
        powers.append(power)

    return frequencies, powers


def generate_stft_matrix(node_id: str, is_intrusion: bool = False, peak_freq: float = 18.5) -> Dict[str, Any]:
    """Generate an STFT from waveform samples actually received by the backend.

    ``is_intrusion`` and ``peak_freq`` are retained for API compatibility with
    the existing dashboard, but they are no longer used to synthesize data.
    """
    received = get_recent_waveform(node_id, max_samples=2000)

    if not received:
        return {
            "node_id": node_id,
            "timestamp": time.time(),
            "available": False,
            "message": "Waiting for waveform data",
            "time_axis": [],
            "freq_axis": [],
            "stft_matrix": [],
            "peak_frequency_hz": None,
            "peak_energy_db": None,
            "bandwidth_hz": None,
            "signal_class": "Waiting for waveform data",
        }

    sample_rate_hz = float(received.get("sample_rate_hz") or 200)
    waveform = _composite_waveform(
        received.get("x", []),
        received.get("y", []),
        received.get("z", []),
    )

    if len(waveform) < WINDOW_SIZE:
        return {
            "node_id": node_id,
            "timestamp": time.time(),
            "available": False,
            "message": "Waiting for waveform data",
            "samples_available": len(waveform),
            "samples_required": WINDOW_SIZE,
            "time_axis": [],
            "freq_axis": [],
            "stft_matrix": [],
            "peak_frequency_hz": None,
            "peak_energy_db": None,
            "bandwidth_hz": None,
            "signal_class": "Waiting for waveform data",
        }

    start_index = max(0, len(waveform) - 2000)
    waveform = waveform[start_index:]

    frames = []
    time_axis = []
    global_max_power = 0.0
    frequency_axis = None

    frame_start = 0
    while frame_start + WINDOW_SIZE <= len(waveform):
        frame = waveform[frame_start:frame_start + WINDOW_SIZE]
        frequencies, powers = _dft_power(frame, sample_rate_hz)

        if frequency_axis is None:
            frequency_axis = frequencies

        global_max_power = max(global_max_power, max(powers, default=0.0))
        frames.append(powers)
        time_axis.append(round((frame_start + WINDOW_SIZE / 2) / sample_rate_hz, 3))
        frame_start += HOP_SIZE

    if not frames or frequency_axis is None or global_max_power <= 0.0:
        return {
            "node_id": node_id,
            "timestamp": time.time(),
            "available": False,
            "message": "Waiting for waveform data",
            "time_axis": [],
            "freq_axis": [],
            "stft_matrix": [],
            "peak_frequency_hz": None,
            "peak_energy_db": None,
            "bandwidth_hz": None,
            "signal_class": "Waiting for waveform data",
        }

    matrix = []
    for powers in frames:
        row = [
            round(min(1.0, power / global_max_power), 4)
            for power in powers
        ]
        matrix.append(row)

    # Peak frequency is derived from the strongest actual received bin.
    peak_frame_index = 0
    peak_bin_index = 0
    peak_power = 0.0
    for frame_index, powers in enumerate(frames):
        for bin_index, power in enumerate(powers):
            if power > peak_power:
                peak_power = power
                peak_frame_index = frame_index
                peak_bin_index = bin_index

    peak_frequency = frequency_axis[peak_bin_index]
    peak_energy_db = round(10.0 * math.log10(max(peak_power, 1e-12)), 2)

    half_power = peak_power * 0.5
    active_bins = [
        frequency_axis[index]
        for index, power in enumerate(frames[peak_frame_index])
        if power >= half_power
    ]
    if active_bins:
        bandwidth = round(max(active_bins) - min(active_bins), 2)
    else:
        bandwidth = 0.0

    return {
        "node_id": node_id,
        "timestamp": time.time(),
        "available": True,
        "sample_rate_hz": sample_rate_hz,
        "samples_used": len(waveform),
        "time_axis": time_axis,
        "freq_axis": frequency_axis,
        "stft_matrix": matrix,
        "peak_frequency_hz": peak_frequency,
        "peak_energy_db": peak_energy_db,
        "bandwidth_hz": bandwidth,
        "signal_class": "Received triaxial waveform",
    }
