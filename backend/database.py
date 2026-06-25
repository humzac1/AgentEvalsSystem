"""
SQLite database setup and operations for the Agent Simulation Lab.
"""

import json
import sqlite3
import os
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "data" / "simulations.db"


def get_connection() -> sqlite3.Connection:
    """Get a SQLite connection with row factory set."""
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """Initialize the database schema."""
    with get_connection() as conn:
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

            CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
            CREATE INDEX IF NOT EXISTS idx_evaluations_session ON evaluations(session_id);
        """)


def save_session(
    session_id: str,
    user_profile: str,
    hidden_goal: str,
) -> None:
    """Insert a new session record."""
    with get_connection() as conn:
        conn.execute(
            """INSERT OR REPLACE INTO sessions
               (session_id, user_profile, hidden_goal, timestamp)
               VALUES (?, ?, ?, ?)""",
            (session_id, user_profile, hidden_goal, datetime.utcnow().isoformat()),
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
                      total_score, trajectory_quality
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
