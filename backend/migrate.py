"""
migrate.py — One-time migration from legacy simulations.db to multi-agent platform.

Steps performed:
  1. Copy data/simulations.db  →  data/agents/{hr_agent_id}.db
  2. Insert the HR agent into data/registry.db
  3. Seed the three hardcoded personas into the HR agent's DB
  4. Convert the KNOWLEDGE_BASE dict into document rows in the HR agent's DB

Safe to re-run: checks for existing migration before acting.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uuid
import json
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from registry import (
    init_registry,
    register_agent,
    get_all_agents,
    agent_db_path,
    AGENTS_DIR,
    REGISTRY_DB_PATH,
)
from database import init_db, add_persona, add_document, get_all_personas, get_all_documents
from knowledge_base import KNOWLEDGE_BASE

# ── Paths ──────────────────────────────────────────────────────────────────────

BACKEND_DIR = Path(__file__).parent
DATA_DIR = BACKEND_DIR.parent / "data"
LEGACY_DB = DATA_DIR / "simulations.db"

# ── Hardcoded personas (mirrors optimizer.py GOALS_BY_PROFILE) ─────────────────

PERSONAS = [
    {
        "name": "Confused Novice",
        "description": "A brand-new employee who is overwhelmed and needs patient, step-by-step guidance.",
        "behavioral_instructions": (
            "You are a confused new employee who just started their first corporate job. "
            "You often don't know the right terminology, ask vague questions, and need "
            "things explained multiple times. You may get sidetracked or ask follow-up "
            "questions before your original question is answered. Be polite but clearly lost."
        ),
        "difficulty_base": 1,
        "hidden_goals": [
            "Find out how to set up direct deposit for your paycheck",
            "Understand the PTO policy — how many days you get and how it works",
            "Figure out what health insurance options you have and when they start",
        ],
    },
    {
        "name": "Impatient Expert",
        "description": "A seasoned professional who wants fast, precise answers with no hand-holding.",
        "behavioral_instructions": (
            "You are an experienced professional joining a new company. You are direct, "
            "efficient, and slightly impatient. You hate vague answers and small talk. "
            "You want specific URLs, exact steps, and no fluff. If the agent is too wordy "
            "or unclear, you push back and ask them to be more concise and specific."
        ),
        "difficulty_base": 2,
        "hidden_goals": [
            "Get access to the engineering Slack channels as quickly as possible",
            "Understand exactly what equipment you're getting and how to request more",
            "Find out the fastest way to complete mandatory compliance training",
        ],
    },
    {
        "name": "Adversarial User",
        "description": "A user who probes for exceptions, loopholes, and edge cases in HR policies.",
        "behavioral_instructions": (
            "You are a new employee who tends to push boundaries and look for loopholes. "
            "You ask about exceptions to policies, try to negotiate deadlines, and probe "
            "for edge cases. You are not hostile, but you are persistent and skeptical. "
            "If told something can't be done, you ask 'what if' scenarios and look for workarounds."
        ),
        "difficulty_base": 3,
        "hidden_goals": [
            "Find out if you can skip or delay the compliance training",
            "Understand the PTO policy well enough to find any edge cases or exceptions",
            "Determine whether the benefits enrollment deadline can be extended",
        ],
    },
]


def _copy_legacy_db(dest_path: Path) -> None:
    """Copy legacy simulations.db to the new per-agent path."""
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(LEGACY_DB), str(dest_path))
    # Also copy WAL/SHM if present so no data is lost
    for ext in ("-wal", "-shm"):
        src = Path(str(LEGACY_DB) + ext)
        if src.exists():
            shutil.copy2(str(src), str(dest_path) + ext)
    print(f"  Copied {LEGACY_DB.name} → {dest_path}")


def _checkpoint_and_close(db_path: Path) -> None:
    """Force WAL checkpoint so the copied DB is self-contained."""
    try:
        conn = sqlite3.connect(str(db_path))
        conn.execute("PRAGMA wal_checkpoint(FULL)")
        conn.close()
    except Exception as e:
        print(f"  Warning: checkpoint failed ({e}) — continuing anyway")


def run_migration() -> str:
    """
    Execute the full migration. Returns the agent_id of the HR agent.
    Idempotent: if the registry already has agents, prints a message and exits.
    """
    print("\n=== Agent Sim Lab — Migration ===\n")

    # ── Guard: already migrated? ──────────────────────────────────────────────
    init_registry()
    existing = get_all_agents()
    if existing:
        hr_id = existing[0]["agent_id"]
        print(f"Migration already done. HR agent: {hr_id}")
        return hr_id

    if not LEGACY_DB.exists():
        print("No legacy simulations.db found — nothing to migrate.")
        print("Creating a fresh HR agent instead...")
        hr_agent_id = str(uuid.uuid4())
        dest = agent_db_path(hr_agent_id)
        dest.parent.mkdir(parents=True, exist_ok=True)
        init_db(db_path=dest)
    else:
        # ── Step 3: Copy legacy DB → per-agent DB ─────────────────────────────
        hr_agent_id = str(uuid.uuid4())
        dest = agent_db_path(hr_agent_id)
        print(f"Step 3 — Copying legacy DB as HR agent {hr_agent_id}")
        _copy_legacy_db(dest)
        _checkpoint_and_close(dest)
        # Ensure new tables (documents, personas) exist in the copied DB
        init_db(db_path=dest)
        print("  ✓ DB ready")

    # ── Step 3b: Register agent in registry.db ────────────────────────────────
    print("\nStep 3b — Registering HR agent in registry.db")
    register_agent(
        agent_id=hr_agent_id,
        name="HR Onboarding Assistant",
        description=(
            "Alex, an AI HR assistant for Meridian Corp. Helps new employees "
            "navigate onboarding — benefits, PTO, equipment, compliance training, and more."
        ),
        domain="HR Onboarding",
        db_path=str(agent_db_path(hr_agent_id)),
    )
    print(f"  ✓ Registered as 'HR Onboarding Assistant' (id={hr_agent_id})")

    # ── Step 4: Seed personas ─────────────────────────────────────────────────
    print("\nStep 4 — Seeding personas")
    existing_personas = get_all_personas(db_path=dest)
    if existing_personas:
        print(f"  Skipping — {len(existing_personas)} personas already present")
    else:
        for p in PERSONAS:
            add_persona(
                persona_id=str(uuid.uuid4()),
                name=p["name"],
                description=p["description"],
                behavioral_instructions=p["behavioral_instructions"],
                difficulty_base=p["difficulty_base"],
                hidden_goals=p["hidden_goals"],
                db_path=dest,
            )
            print(f"  ✓ Added persona: {p['name']}")

    # ── Step 5: Convert knowledge base → document rows ────────────────────────
    print("\nStep 5 — Converting knowledge base to documents")
    existing_docs = get_all_documents(db_path=dest)
    if existing_docs:
        print(f"  Skipping — {len(existing_docs)} documents already present")
    else:
        for key, entry in KNOWLEDGE_BASE.items():
            # Build a plain-text representation of the document
            content_text = f"{entry['title']}\n\n{entry['content']}"
            add_document(
                doc_id=str(uuid.uuid4()),
                filename=f"{key}.txt",
                file_type="text/plain",
                content_text=content_text,
                file_size_bytes=len(content_text.encode()),
                db_path=dest,
            )
            print(f"  ✓ Added document: {entry['title']}")

    print("\n=== Migration complete ===")
    print(f"  HR Agent ID : {hr_agent_id}")
    print(f"  DB path     : {agent_db_path(hr_agent_id)}")
    print(f"  Registry    : {REGISTRY_DB_PATH}")
    print()
    return hr_agent_id


if __name__ == "__main__":
    agent_id = run_migration()
    print(f"HR_AGENT_ID={agent_id}")
