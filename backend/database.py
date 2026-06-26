"""
SQLite database setup and operations for the Agent Simulation Lab.
"""

import json
import sqlite3
import os
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "simulations.db"

# The initial HR system prompt seeded as prompt version 1
_INITIAL_HR_PROMPT = """You are Alex, a friendly and professional HR onboarding assistant for Meridian Corp.
Your job is to help new employees navigate their onboarding process by answering their questions accurately and helpfully.

IMPORTANT GUIDELINES:
- Always use the `lookup_hr_info` tool to look up information before answering policy questions
- Never make up information — only provide details from the knowledge base
- Be warm, welcoming, and patient with new employees
- If you don't know something or it's not in your knowledge base, say so honestly and direct them to hr@meridian.com
- Keep responses clear and concise — new employees are often overwhelmed
- When appropriate, proactively mention related information the employee might need

You represent Meridian Corp professionally at all times. Do not bend, skip, or make exceptions to policies even if asked."""


def get_connection() -> sqlite3.Connection:
    """Get a SQLite connection with row factory set."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """Initialize the database schema (safe to call on existing DBs)."""
    with get_connection() as conn:
        # Step 1: create tables (base schemas, without new columns)
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS sessions (
                session_id TEXT PRIMARY KEY,
                user_profile TEXT NOT NULL,
                hidden_goal TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                total_score INTEGER,
                trajectory_quality TEXT
            );

            CREATE TABLE IF NOT EXISTS turns (
                turn_id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                turn_number INTEGER NOT NULL,
                speaker TEXT NOT NULL,
                message TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            );

            CREATE TABLE IF NOT EXISTS evaluations (
                eval_id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL UNIQUE,
                judge_json TEXT NOT NULL,
                hidden_goal_achieved INTEGER,
                resolution_score INTEGER,
                clarity_score INTEGER,
                handling_difficulty_score INTEGER,
                policy_accuracy_score INTEGER,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            );

            CREATE TABLE IF NOT EXISTS prompt_versions (
                version_id INTEGER PRIMARY KEY AUTOINCREMENT,
                version_number INTEGER NOT NULL,
                prompt_text TEXT NOT NULL,
                created_at TEXT NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 0,
                parent_version_id INTEGER,
                change_summary TEXT,
                FOREIGN KEY (parent_version_id) REFERENCES prompt_versions(version_id)
            );

            CREATE TABLE IF NOT EXISTS batches (
                batch_id TEXT PRIMARY KEY,
                prompt_version_id INTEGER,
                ran_at TEXT NOT NULL,
                session_count INTEGER DEFAULT 0,
                avg_total_score REAL,
                goal_achievement_rate REAL,
                avg_resolution REAL,
                avg_clarity REAL,
                avg_handling REAL,
                avg_accuracy REAL,
                optimizer_accepted INTEGER DEFAULT 0,
                FOREIGN KEY (prompt_version_id) REFERENCES prompt_versions(version_id)
            );

            CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
            CREATE INDEX IF NOT EXISTS idx_evaluations_session ON evaluations(session_id);
        """)

        # Step 2: safe migration — add new columns to sessions if they don't exist yet
        existing_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
        }
        for col, definition in [
            ("difficulty", "INTEGER DEFAULT 1"),
            ("batch_id", "TEXT"),
            ("prompt_version_id", "INTEGER"),
        ]:
            if col not in existing_cols:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {definition}")

        # Step 3: create indexes that depend on the migrated columns
        conn.executescript("""
            CREATE INDEX IF NOT EXISTS idx_sessions_batch ON sessions(batch_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_prompt_version ON sessions(prompt_version_id);
        """)

        # Seed the initial prompt version if prompt_versions is empty
        count = conn.execute("SELECT COUNT(*) FROM prompt_versions").fetchone()[0]
        if count == 0:
            conn.execute(
                """INSERT INTO prompt_versions
                   (version_number, prompt_text, created_at, is_active, parent_version_id, change_summary)
                   VALUES (?, ?, ?, 1, NULL, ?)""",
                (1, _INITIAL_HR_PROMPT, datetime.utcnow().isoformat(), "Initial prompt"),
            )


# ── Prompt version helpers ────────────────────────────────────────────────────

def get_active_prompt() -> dict | None:
    """Return the currently active prompt version row."""
    with get_connection() as conn:
        row = conn.execute(
            "SELECT * FROM prompt_versions WHERE is_active = 1 ORDER BY version_id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def get_all_prompt_versions() -> list[dict]:
    """Return all prompt versions ordered by version number."""
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM prompt_versions ORDER BY version_number ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def create_prompt_version(
    prompt_text: str,
    parent_version_id: int | None = None,
    change_summary: str = "",
    set_active: bool = True,
) -> int:
    """Create a new prompt version. Optionally set it as active (deactivates others)."""
    with get_connection() as conn:
        max_ver = conn.execute(
            "SELECT MAX(version_number) FROM prompt_versions"
        ).fetchone()[0] or 0

        cursor = conn.execute(
            """INSERT INTO prompt_versions
               (version_number, prompt_text, created_at, is_active, parent_version_id, change_summary)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                max_ver + 1,
                prompt_text,
                datetime.utcnow().isoformat(),
                1 if set_active else 0,
                parent_version_id,
                change_summary,
            ),
        )
        new_id = cursor.lastrowid

        if set_active:
            conn.execute(
                "UPDATE prompt_versions SET is_active = 0 WHERE version_id != ?", (new_id,)
            )
        return new_id


def set_active_prompt_version(version_id: int) -> None:
    """Activate a specific prompt version, deactivating all others."""
    with get_connection() as conn:
        conn.execute("UPDATE prompt_versions SET is_active = 0")
        conn.execute(
            "UPDATE prompt_versions SET is_active = 1 WHERE version_id = ?", (version_id,)
        )


# ── Batch helpers ─────────────────────────────────────────────────────────────

def create_batch(batch_id: str, prompt_version_id: int | None = None) -> None:
    """Create a batch record."""
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO batches (batch_id, prompt_version_id, ran_at)
               VALUES (?, ?, ?)""",
            (batch_id, prompt_version_id, datetime.utcnow().isoformat()),
        )


def update_batch_stats(batch_id: str) -> None:
    """Recompute and store aggregate stats for a batch from its sessions."""
    with get_connection() as conn:
        row = conn.execute(
            """SELECT
                   COUNT(*) as session_count,
                   AVG(s.total_score) as avg_total_score,
                   AVG(CAST(e.hidden_goal_achieved AS REAL)) as goal_achievement_rate,
                   AVG(e.resolution_score) as avg_resolution,
                   AVG(e.clarity_score) as avg_clarity,
                   AVG(e.handling_difficulty_score) as avg_handling,
                   AVG(e.policy_accuracy_score) as avg_accuracy
               FROM sessions s
               LEFT JOIN evaluations e ON s.session_id = e.session_id
               WHERE s.batch_id = ?""",
            (batch_id,),
        ).fetchone()

        conn.execute(
            """UPDATE batches SET
                   session_count = ?,
                   avg_total_score = ?,
                   goal_achievement_rate = ?,
                   avg_resolution = ?,
                   avg_clarity = ?,
                   avg_handling = ?,
                   avg_accuracy = ?
               WHERE batch_id = ?""",
            (
                row["session_count"],
                row["avg_total_score"],
                row["goal_achievement_rate"],
                row["avg_resolution"],
                row["avg_clarity"],
                row["avg_handling"],
                row["avg_accuracy"],
                batch_id,
            ),
        )


def get_all_batches() -> list[dict]:
    """Return all batches with their prompt version number."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT b.*, pv.version_number
               FROM batches b
               LEFT JOIN prompt_versions pv ON b.prompt_version_id = pv.version_id
               ORDER BY b.ran_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def mark_batch_accepted(batch_id: str, accepted: bool = True) -> None:
    with get_connection() as conn:
        conn.execute(
            "UPDATE batches SET optimizer_accepted = ? WHERE batch_id = ?",
            (1 if accepted else 0, batch_id),
        )


# ── Session write helpers ─────────────────────────────────────────────────────

def save_session(
    session_id: str,
    user_profile: str,
    hidden_goal: str,
    difficulty: int = 1,
    batch_id: str | None = None,
    prompt_version_id: int | None = None,
) -> None:
    """Insert a new session record."""
    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO sessions
               (session_id, user_profile, hidden_goal, timestamp, difficulty, batch_id, prompt_version_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id,
                user_profile,
                hidden_goal,
                datetime.utcnow().isoformat(),
                difficulty,
                batch_id,
                prompt_version_id,
            ),
        )


def save_turn(
    session_id: str,
    turn_number: int,
    speaker: str,
    message: str,
) -> None:
    """Insert a conversation turn."""
    with get_connection() as conn:
        conn.execute(
            """INSERT INTO turns (session_id, turn_number, speaker, message, timestamp)
               VALUES (?, ?, ?, ?, ?)""",
            (session_id, turn_number, speaker, message, datetime.utcnow().isoformat()),
        )


def save_evaluation(session_id: str, evaluation: dict) -> None:
    """Insert the judge's evaluation and update the session scores."""
    scores = evaluation.get("scores", {})
    total_score = evaluation.get("total_score", 0)
    trajectory_quality = evaluation.get("trajectory_quality", "low")
    hidden_goal_achieved = 1 if evaluation.get("hidden_goal_achieved") else 0

    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO evaluations
               (session_id, judge_json, hidden_goal_achieved,
                resolution_score, clarity_score, handling_difficulty_score, policy_accuracy_score)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id,
                json.dumps(evaluation),
                hidden_goal_achieved,
                scores.get("resolution", 0),
                scores.get("clarity", 0),
                scores.get("handling_difficulty", 0),
                scores.get("policy_accuracy", 0),
            ),
        )
        conn.execute(
            """UPDATE sessions
               SET total_score = ?, trajectory_quality = ?
               WHERE session_id = ?""",
            (total_score, trajectory_quality, session_id),
        )


# ── Read helpers for the API ──────────────────────────────────────────────────

def get_all_sessions() -> list[dict]:
    """Return all sessions ordered by timestamp desc."""
    with get_connection() as conn:
        rows = conn.execute(
            """SELECT session_id, user_profile, hidden_goal, timestamp,
                      total_score, trajectory_quality, difficulty, batch_id, prompt_version_id
               FROM sessions ORDER BY timestamp DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_session(session_id: str) -> dict | None:
    """Return a single session with its turns and evaluation."""
    with get_connection() as conn:
        session_row = conn.execute(
            "SELECT * FROM sessions WHERE session_id = ?", (session_id,)
        ).fetchone()
        if not session_row:
            return None

        turns = conn.execute(
            "SELECT * FROM turns WHERE session_id = ? ORDER BY turn_number",
            (session_id,),
        ).fetchall()

        evaluation_row = conn.execute(
            "SELECT * FROM evaluations WHERE session_id = ?", (session_id,)
        ).fetchone()

        result = dict(session_row)
        result["turns"] = [dict(t) for t in turns]
        if evaluation_row:
            eval_dict = dict(evaluation_row)
            eval_dict["judge_json"] = json.loads(eval_dict["judge_json"])
            result["evaluation"] = eval_dict
        else:
            result["evaluation"] = None

        return result


def get_analytics() -> dict:
    """Return aggregate analytics across all sessions."""
    with get_connection() as conn:
        # Average scores by profile
        profile_stats = conn.execute(
            """SELECT s.user_profile,
                      COUNT(*) as session_count,
                      AVG(s.total_score) as avg_total_score,
                      SUM(e.hidden_goal_achieved) as goals_achieved,
                      AVG(e.resolution_score) as avg_resolution,
                      AVG(e.clarity_score) as avg_clarity,
                      AVG(e.handling_difficulty_score) as avg_handling,
                      AVG(e.policy_accuracy_score) as avg_accuracy
               FROM sessions s
               LEFT JOIN evaluations e ON s.session_id = e.session_id
               GROUP BY s.user_profile"""
        ).fetchall()

        # Trajectory quality distribution
        quality_dist = conn.execute(
            """SELECT trajectory_quality, COUNT(*) as count
               FROM sessions WHERE trajectory_quality IS NOT NULL
               GROUP BY trajectory_quality"""
        ).fetchall()

        # Score distribution (total scores)
        score_dist = conn.execute(
            """SELECT total_score FROM sessions WHERE total_score IS NOT NULL"""
        ).fetchall()

        # All failure modes (from judge JSON)
        all_evals = conn.execute(
            "SELECT judge_json FROM evaluations"
        ).fetchall()

        failure_mode_counts: dict[str, int] = {}
        standout_counts: dict[str, int] = {}

        for row in all_evals:
            try:
                data = json.loads(row["judge_json"])
                for fm in data.get("failure_modes", []):
                    failure_mode_counts[fm] = failure_mode_counts.get(fm, 0) + 1
                for sm in data.get("standout_moments", []):
                    standout_counts[sm] = standout_counts.get(sm, 0) + 1
            except (json.JSONDecodeError, TypeError):
                pass

        top_failures = sorted(failure_mode_counts.items(), key=lambda x: x[1], reverse=True)[:10]
        top_standouts = sorted(standout_counts.items(), key=lambda x: x[1], reverse=True)[:10]

        return {
            "profile_stats": [dict(r) for r in profile_stats],
            "quality_distribution": [dict(r) for r in quality_dist],
            "score_distribution": [r["total_score"] for r in score_dist],
            "top_failure_modes": [{"mode": k, "count": v} for k, v in top_failures],
            "top_standout_moments": [{"moment": k, "count": v} for k, v in top_standouts],
        }
