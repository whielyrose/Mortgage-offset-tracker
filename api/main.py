from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Any
import json
import os
import asyncio

app = FastAPI(title="Mortgage Tracker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

DATA_FILE = os.environ.get("DATA_FILE", "/data/mortgage-tracker.json")

# ── SSE broadcast queue ───────────────────────────────────────────────────────
# Each connected browser gets its own asyncio.Queue entry
_sse_clients: list[asyncio.Queue] = []


def read_data() -> dict:
    if not os.path.exists(DATA_FILE):
        return {"settings": None, "log": [], "reconcile": [], "propValueLog": []}
    with open(DATA_FILE, "r") as f:
        return json.load(f)


def write_data(data: dict):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


async def broadcast(event: str, data: str = "update"):
    """Push an SSE event to all connected browser tabs."""
    dead = []
    for q in _sse_clients:
        try:
            q.put_nowait(f"event: {event}\ndata: {data}\n\n")
        except asyncio.QueueFull:
            dead.append(q)
    for q in dead:
        _sse_clients.remove(q)


class SavePayload(BaseModel):
    settings: Any = None
    log: list = []
    reconcile: list = []
    propValueLog: list = []


@app.get("/api/data")
def get_data():
    return read_data()


@app.post("/api/data")
async def save_data(payload: SavePayload):
    try:
        write_data({
            "settings": payload.settings,
            "log": payload.log,
            "reconcile": payload.reconcile,
            "propValueLog": payload.propValueLog
        })
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notify")
async def notify():
    """Called by the sync script after it posts new data.
    Broadcasts a 'sync-complete' SSE event to all open browser tabs."""
    await broadcast("sync-complete", "update")
    return {"ok": True, "clients": len(_sse_clients)}


@app.get("/api/events")
async def events():
    """SSE endpoint — browser connects here and receives push notifications."""
    queue: asyncio.Queue = asyncio.Queue(maxsize=10)
    _sse_clients.append(queue)

    async def stream():
        try:
            # Send initial connected event
            yield "event: connected\ndata: ok\n\n"
            while True:
                try:
                    # Wait for a message, send a keepalive comment every 30s
                    msg = await asyncio.wait_for(queue.get(), timeout=30)
                    yield msg
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            if queue in _sse_clients:
                _sse_clients.remove(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",   # disable nginx buffering for SSE
        }
    )


@app.get("/api/health")
def health():
    return {"status": "ok", "sse_clients": len(_sse_clients)}
