import sqlite3
import os
import time
from typing import List, Dict, Any, Optional

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "elephant_detection.db")

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_db()
    cursor = conn.cursor()
    
    # 1. Nodes table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ONLINE',
        battery REAL NOT NULL DEFAULT 100.0,
        rssi INTEGER NOT NULL DEFAULT -68,
        snr REAL NOT NULL DEFAULT 9.8,
        last_seen REAL NOT NULL,
        vibration_threshold REAL DEFAULT 4.5,
        mic_enabled INTEGER DEFAULT 1,
        pir_enabled INTEGER DEFAULT 1,
        lat REAL DEFAULT 11.582,
        lng REAL DEFAULT 76.945
    )
    """)
    
    # Re-create telemetry & alerts tables to ensure full triaxial columns
    cursor.execute("DROP TABLE IF EXISTS telemetry")
    cursor.execute("DROP TABLE IF EXISTS alerts")
    
    # 2. Alerts table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp REAL NOT NULL,
        trigger_nodes TEXT NOT NULL,
        direction TEXT NOT NULL,
        threat_level TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        mic_verified INTEGER NOT NULL DEFAULT 1,
        pir_verified INTEGER NOT NULL DEFAULT 1,
        siren_activated INTEGER NOT NULL DEFAULT 0,
        details TEXT
    )
    """)
    
    # 3. Telemetry log table (Triaxial X, Y, Z + Mic + Edge Features: f_dom, RMS, Kurtosis)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp REAL NOT NULL,
        node_id TEXT NOT NULL,
        vib_x REAL NOT NULL DEFAULT 0.0,
        vib_y REAL NOT NULL DEFAULT 0.0,
        vib_z REAL NOT NULL DEFAULT 0.0,
        vibration_val REAL NOT NULL,
        f_dom REAL NOT NULL DEFAULT 18.5,
        rms REAL NOT NULL DEFAULT 0.85,
        kurtosis REAL NOT NULL DEFAULT 3.2,
        duration REAL NOT NULL DEFAULT 1.2,
        mic_val REAL NOT NULL,
        pir_active INTEGER NOT NULL DEFAULT 0,
        battery REAL NOT NULL,
        rssi INTEGER NOT NULL
    )
    """)
    
    # Pre-populate initial 3 field nodes if empty
    cursor.execute("SELECT COUNT(*) FROM nodes")
    if cursor.fetchone()[0] == 0:
        now = time.time()
        initial_nodes = [
            ("NODE_01", "Sensor Node 1 (Forest Boundary)", "Forest Edge - 1.2km (11.582N, 76.945E)", "ONLINE", 95.4, -65, 11.2, now, 4.2, 1, 1, 11.582, 76.945),
            ("NODE_02", "Sensor Node 2 (Buffer Zone)", "Forest Path - 600m (11.586N, 76.950E)", "ONLINE", 89.2, -72, 9.8, now, 4.5, 1, 1, 11.586, 76.950),
            ("NODE_03", "Sensor Node 3 (Village Perimeter)", "Village Border - 100m (11.590N, 76.955E)", "ONLINE", 92.1, -68, 10.5, now, 4.0, 1, 1, 11.590, 76.955),
        ]
        cursor.executemany("""
        INSERT INTO nodes (node_id, name, location, status, battery, rssi, snr, last_seen, vibration_threshold, mic_enabled, pir_enabled, lat, lng)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, initial_nodes)
    
    conn.commit()
    conn.close()

def get_all_nodes() -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM nodes ORDER BY node_id ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def update_node_status(node_id: str, status: str, battery: float, rssi: int, snr: float, last_seen: Optional[float] = None):
    conn = get_db()
    cursor = conn.cursor()
    if last_seen is None:
        last_seen = time.time()
    cursor.execute("""
    UPDATE nodes 
    SET status = ?, battery = ?, rssi = ?, snr = ?, last_seen = ?
    WHERE node_id = ?
    """, (status, battery, rssi, snr, last_seen, node_id))
    conn.commit()
    conn.close()

def log_telemetry(node_id: str, vib_x: float, vib_y: float, vib_z: float, vibration_val: float, f_dom: float, rms: float, kurtosis: float, duration: float, mic_val: float, pir_active: bool, battery: float, rssi: int, timestamp: Optional[float] = None):
    if timestamp is None:
        timestamp = time.time()
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO telemetry (timestamp, node_id, vib_x, vib_y, vib_z, vibration_val, f_dom, rms, kurtosis, duration, mic_val, pir_active, battery, rssi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (timestamp, node_id, vib_x, vib_y, vib_z, vibration_val, f_dom, rms, kurtosis, duration, mic_val, 1 if pir_active else 0, battery, rssi))
    
    cursor.execute("DELETE FROM telemetry WHERE id NOT IN (SELECT id FROM telemetry ORDER BY id DESC LIMIT 1000)")
    
    conn.commit()
    conn.close()

def log_alert(trigger_nodes: str, direction: str, threat_level: str, confidence: int, mic_verified: bool, pir_verified: bool, siren_activated: bool, details: str) -> int:
    now = time.time()
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO alerts (timestamp, trigger_nodes, direction, threat_level, confidence, mic_verified, pir_verified, siren_activated, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (now, trigger_nodes, direction, threat_level, confidence, 1 if mic_verified else 0, 1 if pir_verified else 0, 1 if siren_activated else 0, details))
    alert_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return alert_id

def get_recent_alerts(limit: int = 50) -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM alerts ORDER BY timestamp DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def get_recent_telemetry(node_id: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    if node_id:
        cursor.execute("SELECT * FROM telemetry WHERE node_id = ? ORDER BY timestamp DESC LIMIT ?", (node_id, limit))
    else:
        cursor.execute("SELECT * FROM telemetry ORDER BY timestamp DESC LIMIT ?", (limit,))
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]
