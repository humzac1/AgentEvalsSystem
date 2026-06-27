"""
SQLite database setup and operations for the Agent Simulation Lab.

All public functions now accept an optional `db_path` argument.
When omitted they fall back to the legacy data/simulations.db path so that
any code that hasn't been migrated yet continues to work.
"""

import json
import sqlite3
import os
from datetime import datetime
from pathlib import Path
from typing import Union

# Legacy default — used only during the transition period and for backward compat
DB_PATH = Path(__file__).parent.parent / "data" / "simulations.db"


def _resolve(db_path: Union[str, Path, None]) -> Path:
    return Path(db_path) if db_path is not None else DB_PATH


def get_connection(db_path: Union[str, Path, None] = None) -> sqlite3.Connection:
    """Get a SQLite connection with row factory set."""
    p = _resolve(db_path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(db_path: Union[str, Path, None] = None) -> None:
    """Initialize the database schema (safe to call on existing DBs).

    Creates all tables including documents and personas.
    An optional initial_prompt can be passed; if omitted and the
    prompt_versions table is empty, nothing is seeded (the caller is
    responsible for seeding the first prompt).
    """
    with get_connection(db_path) as conn:
        # ── Step 1: base tables ───────────────────────────────────────────
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
                goal_achievement_score INTEGER,
                response_quality_score INTEGER,
                handling_difficulty_score INTEGER,
                staying_in_scope_score INTEGER,
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
                avg_goal_achievement REAL,
                avg_response_quality REAL,
                avg_handling REAL,
                avg_staying_in_scope REAL,
                optimizer_accepted INTEGER DEFAULT 0,
                in_optimizer_run INTEGER DEFAULT 0,
                rejection_reason TEXT,
                FOREIGN KEY (prompt_version_id) REFERENCES prompt_versions(version_id)
            );

            CREATE TABLE IF NOT EXISTS documents (
                doc_id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                file_type TEXT NOT NULL,
                content_text TEXT NOT NULL,
                uploaded_at TEXT NOT NULL,
                file_size_bytes INTEGER DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS personas (
                persona_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                behavioral_instructions TEXT NOT NULL,
                difficulty_base INTEGER NOT NULL DEFAULT 1,
                is_generated INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                hidden_goals TEXT NOT NULL DEFAULT '[]'
            );

            CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
            CREATE INDEX IF NOT EXISTS idx_evaluations_session ON evaluations(session_id);
        """)

        # ── Step 1b: tools / tasks / tool log tables ──────────────────────
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS tools (
                tool_id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                description TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                collection_name TEXT NOT NULL,
                input_schema TEXT NOT NULL DEFAULT '{}',
                output_schema TEXT NOT NULL DEFAULT '{}',
                error_conditions TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tool_seed_data (
                seed_id TEXT PRIMARY KEY,
                tool_id TEXT NOT NULL,
                collection_name TEXT NOT NULL,
                records TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL,
                FOREIGN KEY (tool_id) REFERENCES tools(tool_id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tool_call_logs (
                log_id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                tool_name TEXT NOT NULL,
                inputs TEXT NOT NULL DEFAULT '{}',
                output TEXT,
                success INTEGER NOT NULL DEFAULT 1,
                error_message TEXT,
                called_at TEXT NOT NULL,
                FOREIGN KEY (session_id) REFERENCES sessions(session_id)
            );

            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                experiment_type TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                expected_tool_calls TEXT NOT NULL DEFAULT '[]',
                expected_final_state TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tool_call_logs_session ON tool_call_logs(session_id);
            CREATE INDEX IF NOT EXISTS idx_tool_seed_tool ON tool_seed_data(tool_id);
        """)

        # ── Step 2: safe migrations for sessions, evaluations, and batches ──
        existing_session_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(sessions)").fetchall()
        }
        for col, definition in [
            ("difficulty", "INTEGER DEFAULT 1"),
            ("batch_id", "TEXT"),
            ("prompt_version_id", "INTEGER"),
            ("experiment_type", "TEXT DEFAULT 'conversation'"),
            ("task_id", "TEXT"),
        ]:
            if col not in existing_session_cols:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {definition}")

        existing_eval_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(evaluations)").fetchall()
        }
        for old_col, new_col in [
            ("resolution_score", "goal_achievement_score"),
            ("clarity_score", "response_quality_score"),
            ("policy_accuracy_score", "staying_in_scope_score"),
        ]:
            if old_col in existing_eval_cols and new_col not in existing_eval_cols:
                conn.execute(f"ALTER TABLE evaluations RENAME COLUMN {old_col} TO {new_col}")
        # Re-fetch after potential renames
        existing_eval_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(evaluations)").fetchall()
        }
        if "policy_accuracy_score" not in existing_eval_cols:
            conn.execute("ALTER TABLE evaluations ADD COLUMN policy_accuracy_score INTEGER")
        # New experiment-type-specific score columns (nullable)
        for col in [
            "output_correctness_score",
            "tool_call_accuracy_score",
            "format_compliance_score",
            "step_completion_rate_score",
            "error_handling_score",
        ]:
            if col not in existing_eval_cols:
                conn.execute(f"ALTER TABLE evaluations ADD COLUMN {col} INTEGER")

        existing_batch_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(batches)").fetchall()
        }
        if "in_optimizer_run" not in existing_batch_cols:
            conn.execute("ALTER TABLE batches ADD COLUMN in_optimizer_run INTEGER DEFAULT 0")
        for old_col, new_col in [
            ("avg_resolution", "avg_goal_achievement"),
            ("avg_clarity", "avg_response_quality"),
            ("avg_accuracy", "avg_staying_in_scope"),
        ]:
            if old_col in existing_batch_cols and new_col not in existing_batch_cols:
                conn.execute(f"ALTER TABLE batches RENAME COLUMN {old_col} TO {new_col}")
        if "rejection_reason" not in existing_batch_cols:
            conn.execute("ALTER TABLE batches ADD COLUMN rejection_reason TEXT")

        # ── Step 3: indexes on migrated columns ───────────────────────────
        conn.executescript("""
            CREATE INDEX IF NOT EXISTS idx_sessions_batch ON sessions(batch_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_prompt_version ON sessions(prompt_version_id);
        """)


def seed_initial_prompt(prompt_text: str, db_path: Union[str, Path, None] = None) -> int:
    """Seed v1 prompt if prompt_versions is empty. Returns version_id."""
    with get_connection(db_path) as conn:
        count = conn.execute("SELECT COUNT(*) FROM prompt_versions").fetchone()[0]
        if count == 0:
            cursor = conn.execute(
                """INSERT INTO prompt_versions
                   (version_number, prompt_text, created_at, is_active, parent_version_id, change_summary)
                   VALUES (?, ?, ?, 1, NULL, ?)""",
                (1, prompt_text, datetime.utcnow().isoformat(), "Initial prompt"),
            )
            return cursor.lastrowid
        # Return existing active version id
        row = conn.execute("SELECT version_id FROM prompt_versions WHERE is_active=1").fetchone()
        return row[0] if row else 1


# ── Prompt version helpers ────────────────────────────────────────────────────

def get_active_prompt(db_path: Union[str, Path, None] = None) -> dict | None:
    with get_connection(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM prompt_versions WHERE is_active = 1 ORDER BY version_id DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def get_all_prompt_versions(db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM prompt_versions ORDER BY version_number ASC"
        ).fetchall()
        return [dict(r) for r in rows]


def create_prompt_version(
    prompt_text: str,
    parent_version_id: int | None = None,
    change_summary: str = "",
    set_active: bool = True,
    db_path: Union[str, Path, None] = None,
) -> int:
    with get_connection(db_path) as conn:
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


def set_active_prompt_version(version_id: int, db_path: Union[str, Path, None] = None) -> None:
    with get_connection(db_path) as conn:
        conn.execute("UPDATE prompt_versions SET is_active = 0")
        conn.execute(
            "UPDATE prompt_versions SET is_active = 1 WHERE version_id = ?", (version_id,)
        )


# ── Batch helpers ─────────────────────────────────────────────────────────────

def create_batch(
    batch_id: str,
    prompt_version_id: int | None = None,
    in_optimizer_run: bool = False,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO batches (batch_id, prompt_version_id, ran_at, in_optimizer_run)
               VALUES (?, ?, ?, ?)""",
            (batch_id, prompt_version_id, datetime.utcnow().isoformat(), 1 if in_optimizer_run else 0),
        )


def update_batch_stats(batch_id: str, db_path: Union[str, Path, None] = None) -> None:
    with get_connection(db_path) as conn:
        row = conn.execute(
            """SELECT
                   COUNT(*) as session_count,
                   AVG(s.total_score) as avg_total_score,
                   AVG(CAST(e.hidden_goal_achieved AS REAL)) as goal_achievement_rate,
                   AVG(e.goal_achievement_score) as avg_goal_achievement,
                   AVG(e.response_quality_score) as avg_response_quality,
                   AVG(e.handling_difficulty_score) as avg_handling,
                   AVG(e.staying_in_scope_score) as avg_staying_in_scope
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
                   avg_goal_achievement = ?,
                   avg_response_quality = ?,
                   avg_handling = ?,
                   avg_staying_in_scope = ?
               WHERE batch_id = ?""",
            (
                row["session_count"],
                row["avg_total_score"],
                row["goal_achievement_rate"],
                row["avg_goal_achievement"],
                row["avg_response_quality"],
                row["avg_handling"],
                row["avg_staying_in_scope"],
                batch_id,
            ),
        )


def get_all_batches(db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """SELECT b.*, pv.version_number
               FROM batches b
               LEFT JOIN prompt_versions pv ON b.prompt_version_id = pv.version_id
               ORDER BY b.ran_at DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def mark_batch_accepted(
    batch_id: str,
    accepted: bool = True,
    rejection_reason: str | None = None,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            "UPDATE batches SET optimizer_accepted = ?, rejection_reason = ? WHERE batch_id = ?",
            (1 if accepted else 0, rejection_reason, batch_id),
        )


def get_batch_sessions_summary(batch_id: str, db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """SELECT s.user_profile,
                      COUNT(*) as session_count,
                      SUM(COALESCE(e.hidden_goal_achieved, 0)) as goals_achieved
               FROM sessions s
               LEFT JOIN evaluations e ON s.session_id = e.session_id
               WHERE s.batch_id = ?
               GROUP BY s.user_profile
               ORDER BY s.user_profile""",
            (batch_id,),
        ).fetchall()
        return [dict(r) for r in rows]


# ── Session write helpers ─────────────────────────────────────────────────────

def save_session(
    session_id: str,
    user_profile: str,
    hidden_goal: str,
    difficulty: int = 1,
    batch_id: str | None = None,
    prompt_version_id: int | None = None,
    experiment_type: str = "conversation",
    task_id: str | None = None,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT OR REPLACE INTO sessions
               (session_id, user_profile, hidden_goal, timestamp, difficulty, batch_id,
                prompt_version_id, experiment_type, task_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id,
                user_profile,
                hidden_goal,
                datetime.utcnow().isoformat(),
                difficulty,
                batch_id,
                prompt_version_id,
                experiment_type,
                task_id,
            ),
        )


def save_turn(
    session_id: str,
    turn_number: int,
    speaker: str,
    message: str,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO turns (session_id, turn_number, speaker, message, timestamp)
               VALUES (?, ?, ?, ?, ?)""",
            (session_id, turn_number, speaker, message, datetime.utcnow().isoformat()),
        )


def save_evaluation(session_id: str, evaluation: dict, db_path: Union[str, Path, None] = None) -> None:
    scores = evaluation.get("scores", {})
    total_score = evaluation.get("total_score", 0)
    trajectory_quality = evaluation.get("trajectory_quality", "low")
    hidden_goal_achieved = 1 if evaluation.get("hidden_goal_achieved") else 0
    experiment_type = evaluation.get("experiment_type", "conversation")

    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT OR REPLACE INTO evaluations
               (session_id, judge_json, hidden_goal_achieved,
                goal_achievement_score, response_quality_score,
                handling_difficulty_score, staying_in_scope_score,
                policy_accuracy_score,
                output_correctness_score, tool_call_accuracy_score,
                format_compliance_score, step_completion_rate_score,
                error_handling_score)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id,
                json.dumps(evaluation),
                hidden_goal_achieved,
                # conversation rubric (also used as goal_achievement in all rubrics)
                scores.get("goal_achievement", scores.get("resolution", 0)),
                scores.get("response_quality", scores.get("clarity", 0)),
                scores.get("handling_difficulty"),
                scores.get("staying_in_scope"),
                scores.get("policy_accuracy"),
                # single_output / multi_step rubric columns
                scores.get("output_correctness"),
                scores.get("tool_call_accuracy"),
                scores.get("format_compliance"),
                scores.get("step_completion_rate"),
                scores.get("error_handling"),
            ),
        )
        conn.execute(
            """UPDATE sessions
               SET total_score = ?, trajectory_quality = ?
               WHERE session_id = ?""",
            (total_score, trajectory_quality, session_id),
        )


# ── Read helpers for the API ──────────────────────────────────────────────────

def get_all_sessions(db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """SELECT session_id, user_profile, hidden_goal, timestamp,
                      total_score, trajectory_quality, difficulty, batch_id,
                      prompt_version_id, experiment_type, task_id
               FROM sessions ORDER BY timestamp DESC"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_session(session_id: str, db_path: Union[str, Path, None] = None) -> dict | None:
    with get_connection(db_path) as conn:
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
            judge_json = json.loads(eval_dict["judge_json"])
            # Normalize old score keys to new names for backward compatibility
            scores = judge_json.get("scores", {})
            if "resolution" in scores and "goal_achievement" not in scores:
                scores["goal_achievement"] = scores.pop("resolution")
            if "clarity" in scores and "response_quality" not in scores:
                scores["response_quality"] = scores.pop("clarity")
            # Old "policy_accuracy" (pre-rename) → "staying_in_scope";
            # new "policy_accuracy" is a distinct fifth dimension and is kept as-is
            if "policy_accuracy" in scores and "staying_in_scope" not in scores:
                scores["staying_in_scope"] = scores["policy_accuracy"]
            judge_json["scores"] = scores
            eval_dict["judge_json"] = judge_json
            result["evaluation"] = eval_dict
        else:
            result["evaluation"] = None

        return result


def get_analytics(db_path: Union[str, Path, None] = None) -> dict:
    with get_connection(db_path) as conn:
        profile_stats = conn.execute(
            """SELECT s.user_profile,
                      COUNT(*) as session_count,
                      AVG(s.total_score) as avg_total_score,
                      SUM(e.hidden_goal_achieved) as goals_achieved,
                      AVG(e.goal_achievement_score) as avg_goal_achievement,
                      AVG(e.response_quality_score) as avg_response_quality,
                      AVG(e.handling_difficulty_score) as avg_handling,
                      AVG(e.staying_in_scope_score) as avg_staying_in_scope
               FROM sessions s
               LEFT JOIN evaluations e ON s.session_id = e.session_id
               GROUP BY s.user_profile"""
        ).fetchall()

        quality_dist = conn.execute(
            """SELECT trajectory_quality, COUNT(*) as count
               FROM sessions WHERE trajectory_quality IS NOT NULL
               GROUP BY trajectory_quality"""
        ).fetchall()

        score_dist = conn.execute(
            """SELECT total_score FROM sessions WHERE total_score IS NOT NULL"""
        ).fetchall()

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


# ── Documents helpers ─────────────────────────────────────────────────────────

def get_all_documents(db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT doc_id, filename, file_type, uploaded_at, file_size_bytes FROM documents ORDER BY uploaded_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def add_document(
    doc_id: str,
    filename: str,
    file_type: str,
    content_text: str,
    file_size_bytes: int = 0,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO documents (doc_id, filename, file_type, content_text, uploaded_at, file_size_bytes)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (doc_id, filename, file_type, content_text, datetime.utcnow().isoformat(), file_size_bytes),
        )


def delete_document(doc_id: str, db_path: Union[str, Path, None] = None) -> bool:
    with get_connection(db_path) as conn:
        cursor = conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
        return cursor.rowcount > 0


def search_documents(query: str, db_path: Union[str, Path, None] = None) -> str:
    """Keyword search across all documents for the agent KB tool."""
    query_lower = query.lower()
    query_words = [w for w in query_lower.split() if len(w) > 2]

    with get_connection(db_path) as conn:
        docs = conn.execute(
            "SELECT filename, content_text FROM documents"
        ).fetchall()

    if not docs:
        return (
            f"No knowledge base documents available. "
            "Please contact support or upload relevant documents."
        )

    matches = []
    for doc in docs:
        content = doc["content_text"]
        content_lower = content.lower()
        score = sum(1 for w in query_words if w in content_lower)
        if score > 0:
            # Find best matching segment (up to 600 chars around first keyword hit)
            first_idx = next(
                (content_lower.find(w) for w in query_words if w in content_lower), 0
            )
            start = max(0, first_idx - 80)
            end = min(len(content), first_idx + 600)
            segment = content[start:end].strip()
            matches.append((score, doc["filename"], segment))

    if not matches:
        # Fall back: return the beginning of the first document
        fallback = docs[0]["content_text"][:500]
        return (
            f"No specific match found for '{query}'. "
            f"Here is available information:\n\n{fallback}"
        )

    matches.sort(reverse=True)
    top = matches[0]
    result = f"**{top[1]}**\n\n{top[2]}"
    if len(matches) > 1:
        related = ", ".join(m[1] for m in matches[1:3])
        result += f"\n\nRelated sources: {related}"
    return result


# ── Persona helpers ───────────────────────────────────────────────────────────

def get_all_personas(db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM personas ORDER BY created_at ASC"
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["hidden_goals"] = json.loads(d["hidden_goals"])
            except (json.JSONDecodeError, TypeError):
                d["hidden_goals"] = []
            result.append(d)
        return result


def add_persona(
    persona_id: str,
    name: str,
    description: str,
    behavioral_instructions: str,
    difficulty_base: int = 1,
    is_generated: bool = False,
    hidden_goals: list[str] | None = None,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO personas
               (persona_id, name, description, behavioral_instructions,
                difficulty_base, is_generated, created_at, hidden_goals)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                persona_id,
                name,
                description,
                behavioral_instructions,
                difficulty_base,
                1 if is_generated else 0,
                datetime.utcnow().isoformat(),
                json.dumps(hidden_goals or []),
            ),
        )


def update_persona(
    persona_id: str,
    name: str,
    description: str,
    behavioral_instructions: str,
    difficulty_base: int = 1,
    hidden_goals: list[str] | None = None,
    db_path: Union[str, Path, None] = None,
) -> bool:
    with get_connection(db_path) as conn:
        cursor = conn.execute(
            """UPDATE personas SET
                   name = ?,
                   description = ?,
                   behavioral_instructions = ?,
                   difficulty_base = ?,
                   hidden_goals = ?
               WHERE persona_id = ?""",
            (
                name,
                description,
                behavioral_instructions,
                difficulty_base,
                json.dumps(hidden_goals or []),
                persona_id,
            ),
        )
        return cursor.rowcount > 0


def delete_persona(persona_id: str, db_path: Union[str, Path, None] = None) -> bool:
    with get_connection(db_path) as conn:
        cursor = conn.execute("DELETE FROM personas WHERE persona_id = ?", (persona_id,))
        return cursor.rowcount > 0


def get_session_count(db_path: Union[str, Path, None] = None) -> int:
    with get_connection(db_path) as conn:
        return conn.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]


def get_avg_score(db_path: Union[str, Path, None] = None) -> float | None:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT AVG(total_score) FROM sessions WHERE total_score IS NOT NULL").fetchone()
        return row[0]


# ── Tool helpers ───────────────────────────────────────────────────────────────

def get_all_tools(db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute("SELECT * FROM tools ORDER BY created_at ASC").fetchall()
        result = []
        for r in rows:
            d = dict(r)
            for field in ("input_schema", "output_schema", "error_conditions"):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    d[field] = {} if field != "error_conditions" else []
            result.append(d)
        return result


def get_tool(tool_id: str, db_path: Union[str, Path, None] = None) -> dict | None:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM tools WHERE tool_id = ?", (tool_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        for field in ("input_schema", "output_schema", "error_conditions"):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                d[field] = {} if field != "error_conditions" else []
        # Attach seed data
        seed_rows = conn.execute(
            "SELECT * FROM tool_seed_data WHERE tool_id = ? ORDER BY created_at ASC",
            (tool_id,),
        ).fetchall()
        seeds = []
        for s in seed_rows:
            sd = dict(s)
            try:
                sd["records"] = json.loads(sd["records"])
            except (json.JSONDecodeError, TypeError):
                sd["records"] = []
            seeds.append(sd)
        d["seed_data"] = seeds
        return d


def upsert_tool(
    tool_id: str,
    name: str,
    display_name: str,
    description: str,
    operation_type: str,
    collection_name: str,
    input_schema: dict | None = None,
    output_schema: dict | None = None,
    error_conditions: list | None = None,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO tools
               (tool_id, name, display_name, description, operation_type,
                collection_name, input_schema, output_schema, error_conditions, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(tool_id) DO UPDATE SET
                   name=excluded.name,
                   display_name=excluded.display_name,
                   description=excluded.description,
                   operation_type=excluded.operation_type,
                   collection_name=excluded.collection_name,
                   input_schema=excluded.input_schema,
                   output_schema=excluded.output_schema,
                   error_conditions=excluded.error_conditions""",
            (
                tool_id,
                name,
                display_name,
                description,
                operation_type,
                collection_name,
                json.dumps(input_schema or {}),
                json.dumps(output_schema or {}),
                json.dumps(error_conditions or []),
                datetime.utcnow().isoformat(),
            ),
        )


def delete_tool(tool_id: str, db_path: Union[str, Path, None] = None) -> bool:
    with get_connection(db_path) as conn:
        cursor = conn.execute("DELETE FROM tools WHERE tool_id = ?", (tool_id,))
        return cursor.rowcount > 0


def upsert_tool_seed_data(
    seed_id: str,
    tool_id: str,
    collection_name: str,
    records: list,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO tool_seed_data (seed_id, tool_id, collection_name, records, created_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(seed_id) DO UPDATE SET
                   records=excluded.records,
                   collection_name=excluded.collection_name""",
            (seed_id, tool_id, collection_name, json.dumps(records), datetime.utcnow().isoformat()),
        )


def get_all_seed_data(db_path: Union[str, Path, None] = None) -> list[dict]:
    """Return all seed data records across all tools, for executor initialization."""
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """SELECT ts.collection_name, ts.records, t.operation_type
               FROM tool_seed_data ts
               JOIN tools t ON ts.tool_id = t.tool_id
               ORDER BY ts.created_at ASC"""
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["records"] = json.loads(d["records"])
            except (json.JSONDecodeError, TypeError):
                d["records"] = []
            result.append(d)
        return result


def log_tool_call(
    session_id: str,
    tool_name: str,
    inputs: dict,
    output: str | None = None,
    success: bool = True,
    error_message: str | None = None,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO tool_call_logs
               (session_id, tool_name, inputs, output, success, error_message, called_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                session_id,
                tool_name,
                json.dumps(inputs),
                output,
                1 if success else 0,
                error_message,
                datetime.utcnow().isoformat(),
            ),
        )


def get_session_tool_calls(session_id: str, db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """SELECT log_id, tool_name, inputs, output, success, error_message, called_at
               FROM tool_call_logs WHERE session_id = ? ORDER BY log_id ASC""",
            (session_id,),
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["inputs"] = json.loads(d["inputs"])
            except (json.JSONDecodeError, TypeError):
                d["inputs"] = {}
            result.append(d)
        return result


# ── Task helpers ───────────────────────────────────────────────────────────────

def get_all_tasks(db_path: Union[str, Path, None] = None) -> list[dict]:
    with get_connection(db_path) as conn:
        rows = conn.execute("SELECT * FROM tasks ORDER BY created_at ASC").fetchall()
        result = []
        for r in rows:
            d = dict(r)
            for field in ("expected_tool_calls", "expected_final_state"):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    d[field] = [] if field == "expected_tool_calls" else {}
            result.append(d)
        return result


def get_task(task_id: str, db_path: Union[str, Path, None] = None) -> dict | None:
    with get_connection(db_path) as conn:
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        for field in ("expected_tool_calls", "expected_final_state"):
            try:
                d[field] = json.loads(d[field])
            except (json.JSONDecodeError, TypeError):
                d[field] = [] if field == "expected_tool_calls" else {}
        return d


def upsert_task(
    task_id: str,
    experiment_type: str,
    title: str,
    description: str,
    expected_tool_calls: list | None = None,
    expected_final_state: dict | None = None,
    db_path: Union[str, Path, None] = None,
) -> None:
    with get_connection(db_path) as conn:
        conn.execute(
            """INSERT INTO tasks
               (task_id, experiment_type, title, description,
                expected_tool_calls, expected_final_state, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(task_id) DO UPDATE SET
                   experiment_type=excluded.experiment_type,
                   title=excluded.title,
                   description=excluded.description,
                   expected_tool_calls=excluded.expected_tool_calls,
                   expected_final_state=excluded.expected_final_state""",
            (
                task_id,
                experiment_type,
                title,
                description,
                json.dumps(expected_tool_calls or []),
                json.dumps(expected_final_state or {}),
                datetime.utcnow().isoformat(),
            ),
        )


def delete_task(task_id: str, db_path: Union[str, Path, None] = None) -> bool:
    with get_connection(db_path) as conn:
        cursor = conn.execute("DELETE FROM tasks WHERE task_id = ?", (task_id,))
        return cursor.rowcount > 0
