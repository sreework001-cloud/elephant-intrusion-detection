import os
import json
import asyncio
import logging
from typing import List, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from backend.database import (
    init_db, get_all_nodes, get_recent_alerts, get_recent_telemetry,
    log_alert
)
from backend.fusion_engine import fusion_engine
from backend.mqtt_client import mqtt_gateway
from backend.simulator import simulator
from backend.stft import generate_stft_matrix

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")
logger = logging.getLogger("ElephantDashboard")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# WebSocket Connection Manager
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"New WebSocket client connected. Total clients: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(f"WebSocket client disconnected. Remaining clients: {len(self.active_connections)}")

    async def broadcast(self, message: dict):
        if not self.active_connections:
            return
        to_remove = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                to_remove.append(connection)
        
        for conn in to_remove:
            self.disconnect(conn)

manager = ConnectionManager()

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup logic
    logger.info("Initializing Elephant Intrusion Detection System Backend...")
    init_db()
    
    # Hook MQTT broadcast callback to WebSocket manager broadcast
    mqtt_gateway.set_broadcast_callback(manager.broadcast)
    mqtt_gateway.set_event_loop(asyncio.get_running_loop())
    mqtt_gateway.start()
    
    # Start telemetry simulator
    await simulator.start()
    
    yield
    
    # Shutdown logic
    logger.info("Shutting down backend services...")
    await simulator.stop()
    mqtt_gateway.stop()

app = FastAPI(title="Elephant Intrusion Detection System API", lifespan=lifespan)

# Mount Static Files & Templates
app.mount("/static", StaticFiles(directory=os.path.join(BASE_DIR, "static")), name="static")
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# --- Page Routes ---
@app.get("/", response_class=HTMLResponse)
async def get_dashboard(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")

# --- REST API Endpoints ---
@app.get("/api/nodes")
async def api_get_nodes():
    return get_all_nodes()

@app.get("/api/alerts")
async def api_get_alerts(limit: int = Query(50, ge=1, le=200)):
    return get_recent_alerts(limit)

@app.get("/api/telemetry")
async def api_get_telemetry(node_id: str = None, limit: int = Query(50, ge=1, le=200)):
    return get_recent_telemetry(node_id, limit)

@app.get("/api/stft/{node_id}")
async def api_get_stft(node_id: str, is_intrusion: bool = Query(False)):
    return generate_stft_matrix(node_id=node_id, is_intrusion=is_intrusion)

@app.post("/api/simulate/intrusion")
async def api_simulate_intrusion(payload: Dict[str, Any] = None):
    seq_type = payload.get("type", "INBOUND") if payload else "INBOUND"
    asyncio.create_task(simulator.trigger_simulated_intrusion(seq_type))
    return {"status": "SUCCESS", "message": f"Simulated intrusion sequence '{seq_type}' triggered across nodes."}

@app.post("/api/simulate/clear")
async def api_clear_simulation():
    fusion_engine.clear_history()
    return {"status": "SUCCESS", "message": "Fusion history cleared."}

# --- WebSocket Endpoint ---
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        # Send initial snapshot of nodes and recent alerts upon connection
        initial_data = {
            "type": "INITIAL_STATE",
            "nodes": get_all_nodes(),
            "recent_alerts": get_recent_alerts(10)
        }
        await websocket.send_json(initial_data)
        
        while True:
            # Keep connection alive and listen for client messages if any
            data = await websocket.receive_text()
            # Handle potential client commands (e.g. ping)
            if data == "ping":
                await websocket.send_text("pong")
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)
