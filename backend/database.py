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

    # Sensor nodes used by the current physical demo: G1 and G2.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ONLINE',
        battery REAL NOT NULL DEFAULT 100.0,
        rssi INTEGER NOT NULL DEFAULT -68,
        snr REAL NOT NULL DEFAULT 0.0,
        last_seen REAL NOT NULL,
        vibration_threshold REAL DEFAULT 4.5,
        mic_enabled INTEGER DEFAULT 0,
        pir_enabled INTEGER DEFAULT 0,
        lat REAL,
        lng REAL
    )
    """)

    # The old prototype stored a 3-node triangular fusion model. The current
    # demo has two geophone nodes, so remove the obsolete third node.
    cursor.execute("DELETE FROM nodes WHERE node_id NOT IN ('NODE_01', 'NODE_02')")

    now = time.time()
    initial_nodes = [
        (
            "NODE_01",
            "G1",
            "Deep Forest / Boundary Node",
            "OFFLINE",
            0.0,
            0,
            0.0,
            now,
            4.5,
            0,
            0,
            None,
            None,
        ),
        (
            "NODE_02",
            "G2",
            "Agricultural Boundary Node",
            "OFFLINE",
            0.0,
            0,
            0.0,
            now,
            4.5,
            0,
            0,
            None,
            None,
        ),
    ]

    cursor.executemany("""
    INSERT OR IGNORE INTO nodes (
        node_id, name, location, status, battery, rssi, snr, last_seen,
        vibration_threshold, mic_enabled, pir_enabled, lat, lng
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, initial_nodes)

    # Telemetry and alert tables are recreated to keep the prototype schema
    # deterministic while the dashboard data model is being developed.
    cursor.execute("DROP TABLE IF EXISTS telemetry")
    cursor.execute("DROP TABLE IF EXISTS alerts")

    cursor.execute("""
    CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp REAL NOT NULL,
        trigger_nodes TEXT NOT NULL,
        direction TEXT,
        threat_level TEXT,
        confidence REAL,
        classification TEXT,
        event_status TEXT,
        detected_node TEXT,
        dominant_frequency REAL,
        rms REAL,
        location TEXT,
        tdoa_ms REAL,
        mic_verified INTEGER NOT NULL DEFAULT 0,
        pir_verified INTEGER NOT NULL DEFAULT 0,
        siren_activated INTEGER NOT NULL DEFAULT 0,
        details TEXT
    )
    """)

    cursor.execute("""
    CREATE TABLE telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp REAL NOT NULL,
        node_id TEXT NOT NULL,
        vib_x REAL NOT NULL DEFAULT 0.0,
        vib_y REAL NOT NULL DEFAULT 0.0,
        vib_z REAL NOT NULL DEFAULT 0.0,
        vibration_val REAL NOT NULL DEFAULT 0.0,
        f_dom REAL,
        rms REAL,
        kurtosis REAL,
        duration REAL,
        mic_val REAL,
        pir_active INTEGER NOT NULL DEFAULT 0,
        battery REAL,
        rssi INTEGER,
        snr REAL
    )
    """)

    conn.commit()
    conn.close()


def get_all_nodes() -> List[Dict[str, Any]]:
    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM nodes WHERE node_id IN ('NODE_01', 'NODE_02') ORDER BY node_id ASC")
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]


def update_node_status(
    node_id: str,
    status: str,
    battery: Optional[float],
    rssi: Optional[int],
    snr: Optional[float],
    last_seen: Optional[float] = None,
):
    if node_id not in ("NODE_01", "NODE_02"):
        return

    if last_seen is None:
        last_seen = time.time()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    UPDATE nodes
    SET status = ?, battery = COALESCE(?, battery), rssi = COALESCE(?, rssi),
        snr = COALESCE(?, snr), last_seen = ?
    WHERE node_id = ?
    """, (status, battery, rssi, snr, last_seen, node_id))
    conn.commit()
    conn.close()


def log_telemetry(
    node_id: str,
    vib_x: float,
    vib_y: float,
    vib_z: float,
    vibration_val: float,
    f_dom: Optional[float],
    rms: Optional[float],
    kurtosis: Optional[float],
    duration: Optional[float],
    mic_val: Optional[float],
    pir_active: bool,
    battery: Optional[float],
    rssi: Optional[int],
    snr: Optional[float] = None,
    timestamp: Optional[float] = None,
):
    if timestamp is None:
        timestamp = time.time()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO telemetry (
        timestamp, node_id, vib_x, vib_y, vib_z, vibration_val,
        f_dom, rms, kurtosis, duration, mic_val, pir_active,
        battery, rssi, snr
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        timestamp,
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
        1 if pir_active else 0,
        battery,
        rssi,
        snr,
    ))

    cursor.execute(
        "DELETE FROM telemetry WHERE id NOT IN "
        "(SELECT id FROM telemetry ORDER BY id DESC LIMIT 1000)"
    )

    conn.commit()
    conn.close()


def log_alert(
    trigger_nodes: str,
    direction: Optional[str],
    threat_level: Optional[str],
    confidence: Optional[float],
    mic_verified: bool,
    pir_verified: bool,
    siren_activated: bool,
    details: str,
    classification: Optional[str] = None,
    event_status: Optional[str] = None,
    detected_node: Optional[str] = None,
    dominant_frequency: Optional[float] = None,
    rms: Optional[float] = None,
    location: Optional[str] = None,
    tdoa_ms: Optional[float] = None,
    timestamp: Optional[float] = None,
) -> int:
    if timestamp is None:
        timestamp = time.time()

    conn = get_db()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO alerts (
        timestamp, trigger_nodes, direction, threat_level, confidence,
        classification, event_status, detected_node, dominant_frequency,
        rms, location, tdoa_ms, mic_verified, pir_verified,
        siren_activated, details
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        timestamp,
        trigger_nodes,
        direction,
        threat_level,
        confidence,
        classification,
        event_status,
        detected_node,
        dominant_frequency,
        rms,
        location,
        tdoa_ms,
        1 if mic_verified else 0,
        1 if pir_verified else 0,
        1 if siren_activated else 0,
        details,
    ))
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
        cursor.execute(
            "SELECT * FROM telemetry WHERE node_id = ? ORDER BY timestamp DESC LIMIT ?",
            (node_id, limit),
        )
    else:
        cursor.execute(
            "SELECT * FROM telemetry ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        )
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]
