from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Any
import json
import os

app = FastAPI(title="Mortgage Tracker API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

DATA_FILE = os.environ.get("DATA_FILE", "/data/mortgage-tracker.json")


def read_data() -> dict:
    if not os.path.exists(DATA_FILE):
        return {"settings": None, "log": [], "reconcile": []}
    with open(DATA_FILE, "r") as f:
        return json.load(f)


def write_data(data: dict):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, "w") as f:
        json.dump(data, f, indent=2)


class SavePayload(BaseModel):
    settings: Any = None
    log: list = []
    reconcile: list = []


@app.get("/api/data")
def get_data():
    return read_data()


@app.post("/api/data")
def save_data(payload: SavePayload):
    try:
        write_data({"settings": payload.settings, "log": payload.log, "reconcile": payload.reconcile})
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/health")
def health():
    return {"status": "ok"}
