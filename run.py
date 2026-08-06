import uvicorn
import os
import sys

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding='utf-8')
    print("==========================================================")
    print("[ELEPHANT INTRUSION EARLY WARNING SYSTEM DASHBOARD]")
    print("==========================================================")
    print("Starting FastAPI Server & Real-time MQTT Telemetry Simulator...")
    print("Dashboard UI URL: http://127.0.0.1:8000")
    print("Press Ctrl+C to stop the server.")
    print("==========================================================")
    
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)

