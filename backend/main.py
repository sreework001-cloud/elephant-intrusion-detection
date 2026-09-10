import os
import asyncio
import logging
from typing import List, Dict, Any
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from backend.database import (
    init_db,
    get_all_nodes,
    get_recent_alerts,
    get_recent_telemetry,
)
from backend.mqtt_client import mqtt_gateway
from backend.simulator import simulator
from backend.stft import generate_stft_matrix

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ElephantDashboard")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(
            "New WebSocket client connected. Total clients: %s",
            len(self.active_connections),
        )

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info(
                "WebSocket client disconnected. Remaining clients: %s",
                len(self.active_connections),
            )

    async def broadcast(self, message: dict):
        if not self.active_connections:
            return

        to_remove = []
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                to_remove.append(connection)

        for connection in to_remove:
            self.disconnect(connection)


manager = ConnectionManager()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing Elephant Intrusion Detection System Backend...")
    init_db()

    mqtt_gateway.set_broadcast_callback(manager.broadcast)
    mqtt_gateway.set_event_loop(asyncio.get_running_loop())
    mqtt_gateway.start()

    await simulator.start()

    yield

    logger.info("Shutting down backend services...")
    await simulator.stop()
    mqtt_gateway.stop()


app = FastAPI(
    title="Elephant Intrusion Detection System API",
    lifespan=lifespan,
)

app.mount(
    "/static",
    StaticFiles(directory=os.path.join(BASE_DIR, "static")),
    name="static",
)
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))


@app.get("/", response_class=HTMLResponse)
async def get_dashboard(request: Request):
    return templates.TemplateResponse(request=request, name="index.html")


@app.get("/api/nodes")
async def api_get_nodes():
    return get_all_nodes()


@app.get("/api/alerts")
async def api_get_alerts(limit: int = Query(50, ge=1, le=200)):
    return get_recent_alerts(limit)


@app.get("/api/telemetry")
async def api_get_telemetry(
    node_id: str = None,
    limit: int = Query(50, ge=1, le=200),
):
    return get_recent_telemetry(node_id, limit)


@app.get("/api/stft/{node_id}")
async def api_get_stft(node_id: str, is_intrusion: bool = Query(False)):
    # is_intrusion is retained only for API compatibility. STFT generation
    # uses received waveform samples and does not synthesize an event spectrum.
    return generate_stft_matrix(node_id=node_id, is_intrusion=is_intrusion)


@app.post("/api/simulate/intrusion")
async def api_simulate_intrusion(payload: Dict[str, Any] = None):
    sequence_type = payload.get("type", "INBOUND") if payload else "INBOUND"
    asyncio.create_task(simulator.trigger_simulated_intrusion(sequence_type))
    return {
        "status": "SUCCESS",
        "message": f"Simulated intrusion sequence '{sequence_type}' triggered across nodes.",
    }


@app.post("/api/simulate/clear")
async def api_clear_simulation():
    # Simulation events are intentionally not deleted from persistent history.
    # This endpoint simply acknowledges the UI reset action and does not invoke
    # the obsolete triangular fusion engine.
    return {
        "status": "SUCCESS",
        "message": "Simulation clear acknowledged; persistent event history retained.",
    }


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        initial_data = {
            "type": "INITIAL_STATE",
            "nodes": get_all_nodes(),
            "recent_alerts": get_recent_alerts(10),
        }
        await websocket.send_json(initial_data)

        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_text("pong")

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)
        manager.disconnect(websocket)
