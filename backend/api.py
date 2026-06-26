"""
FastAPI backend — serves simulation data from SQLite to the React frontend.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uuid
import threading
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from database import (
    init_db,
    get_all_sessions,
    get_session,
    get_analytics,
    get_all_batches,
    get_all_prompt_versions,
    get_active_prompt,
    get_batch_sessions_summary,
)
from optimizer import run_optimization_iteration

app = FastAPI(title="Agent Sim Lab API", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Track in-progress runs for polling
_runs: dict[str, dict] = {}
_runs_lock = threading.Lock()


@app.on_event("startup")
def startup_event():
    init_db()


# ── Sessions ──────────────────────────────────────────────────────────────────

@app.get("/api/sessions")
def list_sessions():
    return {"sessions": get_all_sessions()}


@app.get("/api/sessions/{session_id}")
def get_session_detail(session_id: str):
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ── Analytics ─────────────────────────────────────────────────────────────────

@app.get("/api/analytics")
def get_analytics_data():
    return get_analytics()


# ── Experiments ───────────────────────────────────────────────────────────────

@app.get("/api/batches")
def list_batches():
    return {"batches": get_all_batches()}


@app.get("/api/batches/{batch_id}/sessions-summary")
def batch_sessions_summary(batch_id: str):
    return {"profiles": get_batch_sessions_summary(batch_id)}


@app.get("/api/prompt-versions")
def list_prompt_versions():
    versions = get_all_prompt_versions()
    active = get_active_prompt()
    return {
        "versions": versions,
        "active_version_id": active["version_id"] if active else None,
    }


# ── Run Simulation (full optimization loop, async) ────────────────────────────

PHASE_LABELS = {
    "eval":        "Running eval batch…",
    "propose":     "Meta-agent rewriting prompt…",
    "challenger":  "Running challenger batch…",
    "decision":    "Comparing results…",
}


class RunSimulationRequest(BaseModel):
    session_count: int = Field(default=3, ge=3, le=12)
    difficulty: int = Field(default=1, ge=1, le=5)


@app.post("/api/run-simulation")
def run_simulation(request: RunSimulationRequest):
    """
    Start one full optimization iteration asynchronously.
    Poll GET /api/run-simulation/{run_id} for status.
    """
    # Snap session_count to a multiple of 3 (one per profile minimum)
    sessions = max(3, (request.session_count // 3) * 3)

    run_id = str(uuid.uuid4())
    with _runs_lock:
        _runs[run_id] = {
            "status": "running",
            "phase": "eval",
            "phase_detail": f"Starting eval batch ({sessions} sessions)…",
            "result": None,
            "error": None,
        }

    def _run():
        def on_phase(phase: str, detail: str) -> None:
            with _runs_lock:
                _runs[run_id]["phase"] = phase
                _runs[run_id]["phase_detail"] = detail

        try:
            result = run_optimization_iteration(
                sessions_per_batch=sessions,
                difficulty=request.difficulty,
                verbose=False,
                on_phase=on_phase,
            )
            with _runs_lock:
                _runs[run_id]["status"] = "complete"
                _runs[run_id]["result"] = {
                    "eval_avg": result["eval_avg"],
                    "challenger_avg": result["challenger_avg"],
                    "improvement": result["improvement"],
                    "accepted": result["accepted"],
                    "change_summary": result["change_summary"],
                    "decision": result["decision"],
                }
        except Exception as e:
            with _runs_lock:
                _runs[run_id]["status"] = "error"
                _runs[run_id]["error"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"run_id": run_id, "status": "running"}


@app.get("/api/run-simulation/{run_id}")
def poll_simulation(run_id: str):
    with _runs_lock:
        state = _runs.get(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run ID not found")
    return state


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health_check():
    return {"status": "ok"}
