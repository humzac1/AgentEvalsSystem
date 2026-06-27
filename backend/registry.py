"""
registry.py — manages data/registry.db, the global agent registry.

Each row in `agents` describes one agent and points to its isolated database.
This is the only database NOT scoped to a specific agent.
"""

import json
import sqlite3
from datetime import datetime
from pathlib import Path

REGISTRY_DB_PATH = Path(__file__).parent.parent / "data" / "registry.db"
AGENTS_DIR = Path(__file__).parent.parent / "data" / "agents"


def get_registry_connection() -> sqlite3.Connection:
    REGISTRY_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(REGISTRY_DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_registry() -> None:
    """Create the agents table if it doesn't exist."""
    with get_registry_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS agents (
                agent_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                domain TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                last_active TEXT,
                session_count INTEGER DEFAULT 0,
                avg_score REAL,
                active_prompt_version TEXT,
                db_path TEXT NOT NULL,
                experiment_types TEXT NOT NULL DEFAULT '["conversation"]'
            )
        """)
        # Safe migration for existing DBs
        existing_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(agents)").fetchall()
        }
        if "experiment_types" not in existing_cols:
            conn.execute(
                "ALTER TABLE agents ADD COLUMN experiment_types TEXT NOT NULL DEFAULT '[\"conversation\"]'"
            )


def register_agent(
    agent_id: str,
    name: str,
    description: str,
    domain: str,
    db_path: str,
    created_at: str | None = None,
    experiment_types: list[str] | None = None,
) -> None:
    """Insert a new agent into the registry."""
    now = created_at or datetime.utcnow().isoformat()
    exp_types = json.dumps(experiment_types or ["conversation"])
    with get_registry_connection() as conn:
        conn.execute(
            """INSERT INTO agents
               (agent_id, name, description, domain, created_at, db_path, experiment_types)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (agent_id, name, description, domain, now, str(db_path), exp_types),
        )


def _parse_agent(row) -> dict:
    d = dict(row)
    try:
        d["experiment_types"] = json.loads(d.get("experiment_types") or '["conversation"]')
    except (json.JSONDecodeError, TypeError):
        d["experiment_types"] = ["conversation"]
    return d


def get_all_agents() -> list[dict]:
    """Return all agents from the registry."""
    with get_registry_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM agents ORDER BY last_active DESC, created_at DESC"
        ).fetchall()
        return [_parse_agent(r) for r in rows]


def get_agent(agent_id: str) -> dict | None:
    """Return a single agent record, or None if not found."""
    with get_registry_connection() as conn:
        row = conn.execute(
            "SELECT * FROM agents WHERE agent_id = ?", (agent_id,)
        ).fetchone()
        return _parse_agent(row) if row else None


def update_agent_identity(
    agent_id: str,
    name: str,
    description: str,
    domain: str,
    experiment_types: list[str],
) -> None:
    """Update editable identity fields on an agent registry record."""
    with get_registry_connection() as conn:
        conn.execute(
            """UPDATE agents SET name = ?, description = ?, domain = ?, experiment_types = ?
               WHERE agent_id = ?""",
            (name, description, domain, json.dumps(experiment_types), agent_id),
        )


def update_agent_stats(agent_id: str, session_count: int, avg_score: float | None, active_prompt_version: str | None) -> None:
    """Refresh summary stats on the registry row after a simulation run."""
    now = datetime.utcnow().isoformat()
    with get_registry_connection() as conn:
        conn.execute(
            """UPDATE agents SET
                   session_count = ?,
                   avg_score = ?,
                   active_prompt_version = ?,
                   last_active = ?
               WHERE agent_id = ?""",
            (session_count, avg_score, active_prompt_version, now, agent_id),
        )


def touch_agent_last_active(agent_id: str) -> None:
    """Update last_active timestamp."""
    with get_registry_connection() as conn:
        conn.execute(
            "UPDATE agents SET last_active = ? WHERE agent_id = ?",
            (datetime.utcnow().isoformat(), agent_id),
        )


def agent_db_path(agent_id: str) -> Path:
    """Return the path to this agent's database."""
    return AGENTS_DIR / f"{agent_id}.db"


def get_agent_by_db_path(db_path) -> dict | None:
    """Find an agent record by its database path (reverse lookup)."""
    db_str = str(db_path)
    with get_registry_connection() as conn:
        row = conn.execute(
            "SELECT * FROM agents WHERE db_path = ?", (db_str,)
        ).fetchone()
        return _parse_agent(row) if row else None


def agent_docs_dir(agent_id: str) -> Path:
    """Return the path to this agent's document storage directory."""
    return AGENTS_DIR / agent_id / "docs"
