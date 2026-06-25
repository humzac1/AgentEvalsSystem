"""
FastAPI backend — serves simulation data from SQLite to the React frontend.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from database import init_db, get_all_sessions, get_session, get_analytics

app = FastAPI(title="Agent Sim Lab API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup_event():
    init_db()


@app.get("/api/sessions")
def list_sessions():
    """List all simulation sessions."""
    return {"sessions": get_all_sessions()}


@app.get("/api/sessions/{session_id}")
def get_session_detail(session_id: str):
    """Get full detail for a session: metadata, transcript, and evaluation."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@app.get("/api/analytics")
def get_analytics_data():
    """Return aggregate analytics across all sessions."""
    return get_analytics()


@app.get("/health")
def health_check():
    return {"status": "ok"}
