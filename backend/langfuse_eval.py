"""
Langfuse qualitative evaluation pipeline.

Fetches trace comments from Langfuse, runs axial coding via Claude,
and produces a downloadable CSV.
"""

import ast
import csv
import json
import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import StringIO

import anthropic
import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

_LANGFUSE_BASE = os.getenv("LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com").rstrip("/")
_LF_PUBLIC = os.getenv("LANGFUSE_PUBLIC_KEY", "")
_LF_SECRET = os.getenv("LANGFUSE_SECRET_KEY", "")
_AUTH = (_LF_PUBLIC, _LF_SECRET)

_anthropic = anthropic.Anthropic()

# Minimum spacing between outbound requests, shared across all threads
# (Langfuse free tier: 30 req/min)
_API_DELAY = 2.1  # seconds

# Hard ceiling on total fetch time; returns partial results with timed_out=True if hit
_TOTAL_TIMEOUT = 90  # seconds

# Retries for 429s before giving up on a single request
_MAX_RETRIES = 4


# ── HTTP helpers ───────────────────────────────────────────────────────────────

_rate_lock = threading.Lock()
_last_request_at = 0.0


def _throttle() -> None:
    """Block until at least _API_DELAY has passed since the last request start,
    across all threads. This is what actually keeps us under the Langfuse rate
    limit — a ThreadPoolExecutor alone does not."""
    global _last_request_at
    with _rate_lock:
        wait = _last_request_at + _API_DELAY - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_request_at = time.time()


def _lf_get(path: str, params: dict | None = None) -> dict | list | None:
    """GET from Langfuse public API. Returns parsed JSON or None on error.

    Retries 429s with backoff instead of silently dropping the request — a bare
    ThreadPoolExecutor hitting this endpoint used to blow through the free-tier
    rate limit and swallow the resulting 429s, which is what caused comment
    counts to vary between identical runs.
    """
    url = f"{_LANGFUSE_BASE}/api/public{path}"
    for attempt in range(_MAX_RETRIES + 1):
        _throttle()
        try:
            r = requests.get(url, auth=_AUTH, params=params, timeout=15)
        except Exception as e:
            print(f"[langfuse_eval] GET {path} error: {e}")
            return None
        if r.status_code == 429:
            if attempt == _MAX_RETRIES:
                print(f"[langfuse_eval] GET {path} → 429, out of retries")
                return None
            retry_after = r.headers.get("Retry-After")
            backoff = float(retry_after) if retry_after else _API_DELAY * (2 ** attempt)
            print(
                f"[langfuse_eval] GET {path} → 429, retrying in {backoff:.1f}s "
                f"(attempt {attempt + 1}/{_MAX_RETRIES})"
            )
            time.sleep(backoff)
            continue
        if r.status_code != 200:
            print(f"[langfuse_eval] GET {path} → {r.status_code}: {r.text[:200]}")
            return None
        return r.json()
    return None


def _extract_trace_id(trace_url: str) -> str | None:
    """Extract the trace ID from a stored Langfuse trace URL."""
    if not trace_url:
        return None
    # Skip old broken URLs with empty project ID (/project//traces/...)
    if "/project//traces/" in trace_url:
        return None
    parts = trace_url.rstrip("/").split("/")
    trace_id = parts[-1] if parts else None
    # Must be 32-char lowercase hex
    if trace_id and len(trace_id) == 32 and all(c in "0123456789abcdef" for c in trace_id):
        return trace_id
    return None


def _fetch_all_comments_paginated(object_type: str) -> list[dict]:
    """
    Bulk-fetch all Langfuse comments of a given objectType via paginated calls.
    Returns comments for the entire project; callers filter client-side by objectId.
    """
    all_items: list[dict] = []
    page = 1
    limit = 100
    while True:
        data = _lf_get(
            "/comments",
            params={"objectType": object_type, "limit": limit, "page": page},
        )
        if not data:
            break
        items = data.get("data", []) if isinstance(data, dict) else []
        all_items.extend(items)
        if len(items) < limit:
            break
        page += 1
    return all_items


def _fetch_all_observations_paginated(name: str) -> list[dict]:
    """
    Bulk-fetch all Langfuse observations with the given name via paginated calls.
    Returns observations for the entire project; callers filter client-side by traceId.
    """
    all_items: list[dict] = []
    page = 1
    limit = 100
    while True:
        data = _lf_get(
            "/observations",
            params={"name": name, "limit": limit, "page": page},
        )
        if not data:
            break
        items = data.get("data", []) if isinstance(data, dict) else []
        all_items.extend(items)
        if len(items) < limit:
            break
        page += 1
    return all_items


# ── Public API ─────────────────────────────────────────────────────────────────

def get_agent_trace_comments(agent_id: str, db_path, limit: int | None = None) -> dict:
    """
    Fetch all Langfuse comments for an agent's sessions.

    Performance strategy: every fetch below is a bulk, paginated, project-wide
    call (TRACE comments, simulation-session observations, OBSERVATION comments)
    filtered client-side by ID — never one request per session/trace. That keeps
    total request count to a handful regardless of session count, which is what
    it takes to stay under Langfuse's per-project rate limit.

    Args:
        limit: if set, only the `limit` most recently created sessions (that have
            a langfuse_trace_url) are checked, instead of all of them.

    Returns:
        {
          "comments": list[{session_id, comment, author, created_at, experiment_type}],
          "sessions_with_comments": int,
          "total_comments": int,
          "sessions_checked": int,
          "fetch_time_seconds": float,
          "session_type_breakdown": dict[str, int],
          "timed_out": bool  (only present when True)
        }
    """
    start_time = time.time()
    deadline = start_time + _TOTAL_TIMEOUT

    # ── Step 1: Load sessions from DB ─────────────────────────────────────────
    from database import get_connection
    query = """SELECT session_id, langfuse_trace_url, experiment_type
               FROM sessions
               WHERE langfuse_trace_url IS NOT NULL
               ORDER BY timestamp DESC"""
    params: tuple = ()
    if limit:
        query += " LIMIT ?"
        params = (limit,)
    with get_connection(db_path) as conn:
        rows = conn.execute(query, params).fetchall()

    sessions_checked = len(rows)

    # Build trace_id → session_id map (only valid trace IDs), and
    # session_id → experiment_type for the breakdown/per-comment tagging below.
    trace_to_session: dict[str, str] = {}
    session_to_type: dict[str, str] = {}
    for row in rows:
        session_to_type[row["session_id"]] = row["experiment_type"] or "conversation"
        trace_id = _extract_trace_id(row["langfuse_trace_url"])
        if trace_id:
            trace_to_session[trace_id] = row["session_id"]

    def _build_result(
        comments: list[dict],
        sessions_with: set[str],
        timed_out: bool = False,
    ) -> dict:
        for c in comments:
            c["experiment_type"] = session_to_type.get(c["session_id"], "conversation")
        breakdown: dict[str, int] = {}
        for sid in sessions_with:
            etype = session_to_type.get(sid, "conversation")
            breakdown[etype] = breakdown.get(etype, 0) + 1

        fetch_time = round(time.time() - start_time, 2)
        print(
            f"[langfuse_eval] Done: {len(comments)} comments from "
            f"{len(sessions_with)} sessions (checked {sessions_checked} sessions) "
            f"in {fetch_time}s"
            + (" [TIMED OUT - partial results]" if timed_out else "")
        )
        result: dict = {
            "comments": comments,
            "sessions_with_comments": len(sessions_with),
            "total_comments": len(comments),
            "sessions_checked": sessions_checked,
            "fetch_time_seconds": fetch_time,
            "session_type_breakdown": breakdown,
        }
        if timed_out:
            result["timed_out"] = True
        return result

    if not trace_to_session:
        return _build_result([], set())

    known_trace_ids = set(trace_to_session.keys())

    # ── Step 2: Bulk-fetch all TRACE-level comments ────────────────────────────
    print(
        f"[langfuse_eval] Bulk-fetching TRACE comments "
        f"({sessions_checked} sessions with trace URLs)..."
    )
    trace_comments = _fetch_all_comments_paginated("TRACE")
    print(f"[langfuse_eval]   → {len(trace_comments)} TRACE comments fetched")

    if time.time() > deadline:
        # Correlate whatever trace comments we have and return early
        results, sessions_with = _correlate_trace(trace_comments, trace_to_session, known_trace_ids)
        return _build_result(results, sessions_with, timed_out=True)

    # ── Step 3: Bulk-fetch all "simulation-session" observations ────────────────
    # Comments live on this observation, not on the trace — see _correlate_all.
    # Bulk-fetching by name (like TRACE/OBSERVATION comments above) keeps this to
    # 1-2 requests regardless of session count; fetching one request per trace
    # (the old approach) needed 40+ requests and blew through the project's
    # rate limit well before finishing.
    print("[langfuse_eval] Bulk-fetching simulation-session observations...")
    observations = _fetch_all_observations_paginated("simulation-session")
    obs_to_trace: dict[str, str] = {
        o["id"]: o["traceId"]
        for o in observations
        if o.get("id") and o.get("traceId") in known_trace_ids
    }
    print(f"[langfuse_eval]   → {len(obs_to_trace)} observation IDs collected")

    timed_out = time.time() > deadline

    # ── Step 4: Bulk-fetch all OBSERVATION-level comments ─────────────────────
    obs_comments: list[dict] = []
    if not timed_out:
        print("[langfuse_eval] Bulk-fetching OBSERVATION comments...")
        obs_comments = _fetch_all_comments_paginated("OBSERVATION")
        print(f"[langfuse_eval]   → {len(obs_comments)} OBSERVATION comments fetched")
        timed_out = time.time() > deadline

    # ── Step 5: Correlate and deduplicate ─────────────────────────────────────
    results, sessions_with = _correlate_all(
        trace_comments, obs_comments,
        trace_to_session, known_trace_ids, obs_to_trace,
    )
    return _build_result(results, sessions_with, timed_out=timed_out)


def _correlate_trace(
    trace_comments: list[dict],
    trace_to_session: dict[str, str],
    known_trace_ids: set[str],
) -> tuple[list[dict], set[str]]:
    """Filter trace-level comments to sessions we own."""
    seen_by_session: dict[str, set] = {}
    results: list[dict] = []
    sessions_with: set[str] = set()

    for c in trace_comments:
        object_id = c.get("objectId", "")
        if object_id not in known_trace_ids:
            continue
        session_id = trace_to_session[object_id]
        _try_add(c, session_id, seen_by_session, sessions_with, results)

    return results, sessions_with


def _correlate_all(
    trace_comments: list[dict],
    obs_comments: list[dict],
    trace_to_session: dict[str, str],
    known_trace_ids: set[str],
    obs_to_trace: dict[str, str],
) -> tuple[list[dict], set[str]]:
    """Merge and deduplicate trace + observation comments for sessions we own."""
    seen_by_session: dict[str, set] = {}
    results: list[dict] = []
    sessions_with: set[str] = set()

    for c in trace_comments:
        object_id = c.get("objectId", "")
        if object_id not in known_trace_ids:
            continue
        session_id = trace_to_session[object_id]
        _try_add(c, session_id, seen_by_session, sessions_with, results)

    for c in obs_comments:
        object_id = c.get("objectId", "")
        trace_id = obs_to_trace.get(object_id)
        if not trace_id:
            continue
        session_id = trace_to_session.get(trace_id)
        if not session_id:
            continue
        _try_add(c, session_id, seen_by_session, sessions_with, results)

    return results, sessions_with


def _try_add(
    comment: dict,
    session_id: str,
    seen_by_session: dict[str, set],
    sessions_with: set[str],
    results: list[dict],
) -> None:
    text = comment.get("content") or comment.get("text", "")
    if not text:
        return
    seen = seen_by_session.setdefault(session_id, set())
    if text in seen:
        return
    seen.add(text)
    sessions_with.add(session_id)
    results.append({
        "session_id": session_id,
        "comment": text,
        "author": comment.get("authorUserId") or comment.get("author", ""),
        "created_at": comment.get("createdAt") or comment.get("created_at", ""),
    })


# ── Axial coding ───────────────────────────────────────────────────────────────

_SESSION_TYPE_BLURBS = {
    "conversation": "Multi-turn dialogue between a synthetic user and the agent",
    "single_output": "Agent receives one task and produces one structured output, potentially using tools",
    "multi_step": "Agent completes a workflow requiring sequential tool calls",
}


def propose_axial_codes(open_codes: list[dict]) -> list[str]:
    """
    Ask Claude to propose 2–4 axial code categories from the open codes, grouped
    by session type so Claude can tell which behaviors are universal vs.
    session-type-specific (e.g. "Incorrect Tool Sequencing" only makes sense for
    multi_step sessions).
    Returns a list of category name strings.
    """
    grouped: dict[str, list[dict]] = {"conversation": [], "single_output": [], "multi_step": []}
    for item in open_codes:
        etype = item.get("experiment_type", "conversation")
        grouped.setdefault(etype, []).append(item)

    def _notes(etype: str) -> str:
        comments = [item["comment"] for item in grouped.get(etype, [])]
        return json.dumps(comments, indent=2) if comments else "(none)"

    breakdown_lines = "\n".join(
        f"- {label.replace('_', ' ').title()} sessions ({len(grouped.get(key, []))}): {blurb}"
        for key, label, blurb in [
            ("conversation", "conversation", _SESSION_TYPE_BLURBS["conversation"]),
            ("single_output", "single output", _SESSION_TYPE_BLURBS["single_output"]),
            ("multi_step", "multi-step", _SESSION_TYPE_BLURBS["multi_step"]),
        ]
    )

    total_sessions = len(open_codes)
    prompt = f"""You are a qualitative research assistant performing axial coding on LLM agent evaluation notes.

These notes were made by a human reviewer observing AI agent simulations across different experiment types.

CRITICAL RULES:
- Propose between 2 and 4 categories MAXIMUM. Fewer is better.
- Do NOT create separate categories for things that share the same root cause. Example: "tool call error", "casting errors", "wrong parameter type" all belong in ONE category about tool execution failures — not three separate ones.
- Each category must be meaningfully distinct from every other. If two categories would frequently co-occur on the same session, merge them.
- Categories must be abstract enough to capture a cluster of related behaviors, not so specific that only 1-2 sessions qualify.
- A good category covers at least 30% of the {total_sessions} commented sessions (~{max(1, round(total_sessions * 0.3))} sessions). If a proposed category would only apply to 1-2 sessions, it is too narrow — absorb it into a broader category.
- Name categories at the behavioral theme level, not the symptom level. "Tool Execution Failures" is correct. "Casting Errors With Data Types" is too specific and wrong.
- You may still propose a session-type-specific category if a theme only appears in one session type (e.g. "Incorrect Tool Sequencing" only makes sense for multi-step sessions) — but it still must clear the 30% coverage bar and the "not just 1-2 sessions" rule above.

SESSION TYPE BREAKDOWN:
{breakdown_lines}

OPEN CODES BY SESSION TYPE:
Conversation notes:
{_notes("conversation")}

Single Output notes:
{_notes("single_output")}

Multi-Step notes:
{_notes("multi_step")}

Given these open codes, propose the minimum number of meaningful behavioral categories that cover all the observed failures without overlap. Return ONLY a JSON array of category name strings."""

    response = _anthropic.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    if text.startswith("```"):
        text = "\n".join(text.split("\n")[1:])
        text = text.rsplit("```", 1)[0].strip()
    return json.loads(text)


def assign_axial_codes(
    open_codes: list[dict], confirmed_categories: list[str]
) -> tuple[list[dict], dict[str, int]]:
    """
    Ask Claude to assign axial codes to each session comment.
    Returns (coded_sessions, frequencies).
    """
    prompt = f"""You are a qualitative research assistant performing axial coding on LLM evaluation notes.

Axial code categories (confirmed by researcher):
{json.dumps(confirmed_categories, indent=2)}

For each open code below, assign ALL axial categories that apply.
A session can have multiple axial codes if the comment touches multiple themes.
Return ONLY a JSON array where each item has:
- "session_id": the session ID
- "comment": the original comment
- "axial_codes": array of applicable category names from the confirmed list

Open codes:
{json.dumps(open_codes, indent=2)}"""

    response = _anthropic.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=4096,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    if text.startswith("```"):
        text = "\n".join(text.split("\n")[1:])
        text = text.rsplit("```", 1)[0].strip()
    coded = json.loads(text)

    # experiment_type is deterministic passthrough data, not something Claude
    # should be asked to reproduce — merge it back in from the input rather than
    # trusting the model's JSON echo to preserve it faithfully.
    session_to_type = {oc["session_id"]: oc.get("experiment_type", "conversation") for oc in open_codes}
    for item in coded:
        item["experiment_type"] = session_to_type.get(item.get("session_id"), "conversation")

    # Count unique sessions per axial code
    freq: dict[str, set] = {cat: set() for cat in confirmed_categories}
    for item in coded:
        for code in item.get("axial_codes", []):
            if code in freq:
                freq[code].add(item["session_id"])

    frequencies = {cat: len(sessions) for cat, sessions in freq.items()}
    return coded, frequencies


# ── Transcripts ────────────────────────────────────────────────────────────────

def _get_session_row(conn, session_id: str):
    return conn.execute("SELECT * FROM sessions WHERE session_id = ?", (session_id,)).fetchone()


def _get_task_row(conn, task_id: str | None):
    if not task_id:
        return None
    return conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()


def _get_tool_calls(conn, session_id: str):
    return conn.execute(
        """SELECT tool_name, inputs, output, success FROM tool_call_logs
           WHERE session_id = ? ORDER BY log_id""",
        (session_id,),
    ).fetchall()


def _get_final_agent_turn(conn, session_id: str) -> str:
    """The final agent output for single_output/multi_step sessions is just the
    last speaker='agent' row in turns — there's no separate "final output" column."""
    row = conn.execute(
        """SELECT message FROM turns WHERE session_id = ? AND speaker = 'agent'
           ORDER BY turn_number DESC LIMIT 1""",
        (session_id,),
    ).fetchone()
    return row["message"] if row else ""


def _format_tool_output(raw_output: str | None) -> str:
    """tool_call_logs.output is stored as str(dict) (Python repr, single-quoted),
    not JSON. Re-serialize as proper JSON; fall back to the raw text if it isn't
    a parseable literal."""
    if raw_output is None:
        return "null"
    try:
        return json.dumps(ast.literal_eval(raw_output))
    except Exception:
        return raw_output


def _task_description(conn, session) -> str:
    task = _get_task_row(conn, session["task_id"]) if session else None
    if task and task["description"]:
        return task["description"]
    return session["hidden_goal"] if session else ""


def _format_conversation_transcript(conn, session_id: str) -> str:
    session = _get_session_row(conn, session_id)
    persona = session["user_profile"] if session else ""
    difficulty = session["difficulty"] if session else ""
    goal = session["hidden_goal"] if session else ""
    header = f"[EXPERIMENT TYPE: Conversation]\n[PERSONA: {persona} | DIFFICULTY: {difficulty} | GOAL: {goal}]\n"

    rows = conn.execute(
        """SELECT turn_number, speaker, message FROM turns
           WHERE session_id = ? ORDER BY turn_number""",
        (session_id,),
    ).fetchall()
    lines = [
        f"{'Synthetic User' if r['speaker'] == 'user' else 'Agent'} Turn {r['turn_number']}: {r['message']}"
        for r in rows
    ]
    return header + "\n" + "\n\n".join(lines)


def _format_tool_call_lines(tc) -> list[str]:
    return [
        f"Tool: {tc['tool_name']}",
        f"Input: {tc['inputs']}",
        f"Output: {_format_tool_output(tc['output'])}",
        f"Status: {'SUCCESS' if tc['success'] else 'ERROR'}",
        "",
    ]


def _format_single_output_transcript(conn, session_id: str) -> str:
    session = _get_session_row(conn, session_id)
    header = f"[EXPERIMENT TYPE: Single Output]\n[TASK: {_task_description(conn, session)}]\n"

    lines = ["--- TOOL CALLS ---"]
    tool_calls = _get_tool_calls(conn, session_id)
    if not tool_calls:
        lines.append("(no tool calls)")
        lines.append("")
    for tc in tool_calls:
        lines.extend(_format_tool_call_lines(tc))

    lines.append("--- AGENT FINAL RESPONSE ---")
    lines.append(_get_final_agent_turn(conn, session_id))
    return header + "\n" + "\n".join(lines)


def _format_multi_step_transcript(conn, session_id: str) -> str:
    session = _get_session_row(conn, session_id)
    task = _get_task_row(conn, session["task_id"]) if session else None
    expected_tools: list[str] = json.loads(task["expected_tool_calls"]) if task and task["expected_tool_calls"] else []
    header = (
        f"[EXPERIMENT TYPE: Multi-Step]\n"
        f"[TASK: {_task_description(conn, session)}]\n"
        f"[EXPECTED TOOL SEQUENCE: {' → '.join(expected_tools) if expected_tools else '(none specified)'}]\n"
    )

    lines: list[str] = []
    tool_calls = _get_tool_calls(conn, session_id)
    for i, tc in enumerate(tool_calls, start=1):
        lines.append(f"--- STEP {i} ---")
        lines.extend(_format_tool_call_lines(tc))

    lines.append("--- AGENT FINAL RESPONSE ---")
    lines.append(_get_final_agent_turn(conn, session_id))
    lines.append("")

    lines.append("--- TASK OUTCOME ---")
    eval_row = conn.execute(
        "SELECT hidden_goal_achieved FROM evaluations WHERE session_id = ?", (session_id,)
    ).fetchone()
    if eval_row is not None:
        lines.append(f"Goal Achieved: {'YES' if eval_row['hidden_goal_achieved'] else 'NO'}")
    actual_tools = {
        r["tool_name"] for r in conn.execute(
            "SELECT tool_name FROM tool_call_logs WHERE session_id = ? AND success = 1",
            (session_id,),
        ).fetchall()
    }
    completed = sum(1 for t in expected_tools if t in actual_tools)
    lines.append(f"Expected steps completed: {completed}/{len(expected_tools)}")

    return header + "\n" + "\n".join(lines)


def fetch_transcripts(sessions: list[dict], db_path) -> list[dict]:
    """
    Fetch and format a transcript per session, dispatching on experiment_type:
    conversation (dialogue turns), single_output (tool calls + final response),
    multi_step (numbered tool call steps + final response + task outcome).

    Args:
        sessions: list of {"session_id": str, "experiment_type": str}
    """
    from database import get_connection
    formatters = {
        "single_output": _format_single_output_transcript,
        "multi_step": _format_multi_step_transcript,
    }
    transcripts: list[dict] = []
    with get_connection(db_path) as conn:
        for s in sessions:
            session_id = s["session_id"]
            formatter = formatters.get(s.get("experiment_type", "conversation"), _format_conversation_transcript)
            transcripts.append({"session_id": session_id, "transcript": formatter(conn, session_id)})
    return transcripts


# ── Judge pipeline ─────────────────────────────────────────────────────────────

_JUDGE_META_PROMPT = """You are an expert prompt engineer designing a binary LLM judge for qualitative research on AI agent simulations.

The judge will evaluate simulation transcripts and classify each one TRUE or FALSE for membership in a behavioral cluster (axial code).

Agent being evaluated: {agent_name} ({agent_domain} domain)
Axial code to classify: {axial_code}

IMPORTANT — This judge must handle multiple session types:
{session_type_descriptions}

The transcript format varies by session type:
- Conversation: marked [EXPERIMENT TYPE: Conversation] — contains dialogue turns
- Single Output: marked [EXPERIMENT TYPE: Single Output] — contains tool calls and one final response
- Multi-Step: marked [EXPERIMENT TYPE: Multi-Step] — contains sequential tool call steps and outcome

Your judge prompt must:
1. Define what this axial code means for EACH session type present
   - For conversation: what does this behavior look like in dialogue?
   - For single output: what does this behavior look like in a tool call / response?
   - For multi-step: what does this behavior look like in a tool call sequence?
2. Give concrete TRUE criteria for each session type
3. Give concrete FALSE criteria for each session type
4. Instruct the judge to first identify the session type from the [EXPERIMENT TYPE] tag, then apply the appropriate criteria
5. Specify output format: return ONLY the token TRUE or FALSE

If this axial code is clearly only relevant to one session type (e.g. "Incorrect Tool Sequencing" only applies to multi-step), the prompt must explicitly instruct: "If this is a Conversation session, return FALSE — this criterion does not apply to conversational sessions" (substituting whichever session type(s) don't apply).

The human reviewer's open-code notes are often terse (a few words). Don't calibrate TRUE criteria only to the literal failure mode named in the note — generalize to the underlying category of problem it's pointing at, since a two-word note like "tool call error" may cover a range of concrete failures (a tool erroring, a tool being skipped entirely while the agent claims otherwise, a tool given malformed input, etc.), not just the narrowest literal reading.

CONCRETE EXAMPLES FROM THIS AGENT'S SESSIONS:

Sessions where this code IS present (TRUE examples):
{true_examples}

Sessions where this code is NOT present (FALSE examples, i.e. tagged with other axial codes instead):
{false_examples}

Use these as calibration anchors for where the TRUE/FALSE boundary sits.

Add this instruction to the generated judge prompt: "Err on the side of TRUE when there is clear evidence of this failure pattern, even if it doesn't exactly match a literal example above. Only return FALSE when you are confident the pattern is genuinely absent. In this research context a human reviewer checks every judge decision afterward, so a missed detection (false negative) is costlier than a false alarm the reviewer can just uncheck."

Return only the system prompt text, nothing else."""


def _generate_one_judge_prompt(
    axial_code: str,
    open_codes: list[dict],
    agent_name: str,
    agent_domain: str,
    session_type_breakdown: dict[str, int],
) -> dict:
    true_examples = [
        {"comment": oc["comment"], "experiment_type": oc.get("experiment_type", "conversation")}
        for oc in open_codes
        if axial_code in (oc.get("axial_codes") or [])
    ]
    false_examples = [
        {"comment": oc["comment"], "experiment_type": oc.get("experiment_type", "conversation")}
        for oc in open_codes
        if axial_code not in (oc.get("axial_codes") or [])
    ]
    present_types = [t for t, n in session_type_breakdown.items() if n] or ["conversation"]
    session_type_descriptions = "\n".join(
        f"- {_SESSION_TYPE_BLURBS.get(t, t)} ({session_type_breakdown.get(t, 0)} sessions)"
        for t in present_types
    )
    meta_prompt = _JUDGE_META_PROMPT.format(
        agent_name=agent_name,
        agent_domain=agent_domain,
        axial_code=axial_code,
        session_type_descriptions=session_type_descriptions,
        true_examples=(
            json.dumps(true_examples, indent=2) if true_examples else "(no tagged examples available)"
        ),
        false_examples=(
            json.dumps(false_examples, indent=2) if false_examples else "(no counter-examples available)"
        ),
    )
    response = _anthropic.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1536,
        messages=[{"role": "user", "content": meta_prompt}],
    )
    return {"axial_code": axial_code, "system_prompt": response.content[0].text.strip()}


def generate_judge_prompts(
    axial_codes: list[str],
    open_codes: list[dict],
    agent_name: str,
    agent_domain: str,
    session_type_breakdown: dict[str, int] | None = None,
) -> list[dict]:
    """
    Generate one binary-classifier judge system prompt per axial code, grounded in
    the open codes tagged with that code. `open_codes` items are expected to carry
    an `axial_codes` list (i.e. the coded_sessions from assign_axial_codes) so each
    judge can be grounded in the examples actually tagged with its category.

    session_type_breakdown (e.g. {"conversation": 6, "multi_step": 1}) tells the
    meta-prompt which session types the judge will actually see, so it only
    generates per-type criteria for types that are present.
    """
    if not axial_codes:
        return []
    breakdown = session_type_breakdown or {"conversation": len(open_codes)}
    with ThreadPoolExecutor(max_workers=min(len(axial_codes), 6)) as executor:
        futures = [
            executor.submit(_generate_one_judge_prompt, code, open_codes, agent_name, agent_domain, breakdown)
            for code in axial_codes
        ]
        return [f.result() for f in futures]


def _run_one_judge(judge: dict, transcript_entry: dict) -> tuple[str, str, str]:
    """Runs a single judge against a single transcript. Returns (axial_code, session_id, decision)."""
    axial_code = judge["axial_code"]
    session_id = transcript_entry["session_id"]
    try:
        response = _anthropic.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=10,
            system=judge["system_prompt"],
            messages=[{
                "role": "user",
                "content": f"Evaluate this session transcript and return TRUE or FALSE:\n\n{transcript_entry['transcript']}",
            }],
        )
        result = response.content[0].text.strip().upper()
        decision = "TRUE" if "TRUE" in result else "FALSE"
    except Exception as e:
        print(f"[langfuse_eval] Judge error ({axial_code}, {session_id}): {e}")
        decision = "FALSE"
    return axial_code, session_id, decision


def run_judges_stream(judges: list[dict], transcripts: list[dict]):
    """
    Run every judge x transcript combination in parallel, yielding one NDJSON
    line per pair as it completes (so callers can show real progress), followed
    by a final line with the complete decisions dict.
    """
    decisions: dict[str, dict[str, str]] = {j["axial_code"]: {} for j in judges}
    pairs = [(j, t) for j in judges for t in transcripts]
    total = len(pairs)
    if not pairs:
        yield json.dumps({"type": "done", "decisions": decisions}) + "\n"
        return
    done = 0
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = [executor.submit(_run_one_judge, j, t) for j, t in pairs]
        for future in as_completed(futures):
            axial_code, session_id, decision = future.result()
            decisions[axial_code][session_id] = decision
            done += 1
            yield json.dumps({
                "type": "progress",
                "axial_code": axial_code,
                "session_id": session_id,
                "decision": decision,
                "done": done,
                "total": total,
            }) + "\n"
    yield json.dumps({"type": "done", "decisions": decisions}) + "\n"


# ── CSV export ─────────────────────────────────────────────────────────────────

def build_csv(coded_sessions: list[dict], frequencies: dict[str, int]) -> str:
    """Build the two-section CSV string."""
    buf = StringIO()
    writer = csv.writer(buf)

    writer.writerow(["Session", "Comment", "Axial Code"])
    for item in coded_sessions:
        codes_str = "; ".join(item.get("axial_codes", []))
        writer.writerow([item["session_id"], item["comment"], codes_str])

    writer.writerow([])

    writer.writerow(["Axial Code", "Frequency"])
    for cat, count in frequencies.items():
        writer.writerow([cat, count])

    return buf.getvalue()


def build_judge_report_csv(
    judges: list[dict],
    decisions: dict[str, dict[str, str]],
    human_labels: dict[str, dict[str, bool]],
    metrics: dict[str, dict[str, float]],
    open_codes: list[dict],
    metrics_by_type: dict[str, dict[str, dict]] | None = None,
) -> str:
    """Build the judge report CSV: system prompts, decision matrix, performance
    metrics, and (if metrics_by_type is given) a per-session-type breakdown."""
    buf = StringIO()
    writer = csv.writer(buf)
    axial_codes = [j["axial_code"] for j in judges]
    session_type = {item["session_id"]: item.get("experiment_type", "conversation") for item in open_codes}

    # ── Section 1: judge system prompts ─────────────────────────────────────
    writer.writerow(["JUDGE SYSTEM PROMPTS"])
    writer.writerow(["Axial Code", "System Prompt"])
    for judge in judges:
        writer.writerow([judge["axial_code"], judge["system_prompt"]])

    writer.writerow([])
    writer.writerow([])

    # ── Section 2: decision matrix ──────────────────────────────────────────
    writer.writerow(["DECISION MATRIX"])
    header = ["Session ID", "Session Type", "Comment"]
    for code in axial_codes:
        header.append(f"{code} - Judge")
        header.append(f"{code} - Human")
    writer.writerow(header)
    for item in open_codes:
        session_id = item["session_id"]
        row = [session_id, session_type.get(session_id, "conversation"), item.get("comment", "")]
        for code in axial_codes:
            judge_decision = decisions.get(code, {}).get(session_id, "")
            human_value = human_labels.get(code, {}).get(session_id)
            human_decision = "TRUE" if human_value else "FALSE" if human_value is not None else ""
            row.append(judge_decision)
            row.append(human_decision)
        writer.writerow(row)

    writer.writerow([])
    writer.writerow([])

    # ── Section 3: performance metrics ──────────────────────────────────────
    writer.writerow(["PERFORMANCE METRICS"])
    writer.writerow(["Axial Code", "TP", "TN", "FP", "FN", "Accuracy", "Precision", "Recall", "F1", "AUC"])
    for code in axial_codes:
        m = metrics.get(code, {})
        writer.writerow([
            code,
            m.get("TP", 0),
            m.get("TN", 0),
            m.get("FP", 0),
            m.get("FN", 0),
            f"{m.get('accuracy', 0):.2f}",
            f"{m.get('precision', 0):.2f}",
            f"{m.get('recall', 0):.2f}",
            f"{m.get('f1', 0):.2f}",
            f"{m.get('auc', 0):.2f}",
        ])

    # ── Section 4: per-session-type breakdown ────────────────────────────────
    if metrics_by_type:
        writer.writerow([])
        writer.writerow([])
        writer.writerow(["PER SESSION TYPE BREAKDOWN"])
        writer.writerow(["Axial Code", "Session Type", "TP", "TN", "FP", "FN", "Accuracy"])
        for code in axial_codes:
            for etype in ("conversation", "single_output", "multi_step"):
                m = metrics_by_type.get(code, {}).get(etype)
                if not m:
                    continue
                writer.writerow([
                    code,
                    etype,
                    m.get("TP", 0),
                    m.get("TN", 0),
                    m.get("FP", 0),
                    m.get("FN", 0),
                    f"{m.get('accuracy', 0):.2f}",
                ])

    return buf.getvalue()
