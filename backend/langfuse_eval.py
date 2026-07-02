"""
Langfuse qualitative evaluation pipeline.

Fetches trace comments from Langfuse, runs axial coding via Claude,
and produces a downloadable CSV.
"""

import csv
import json
import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor, wait
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

# Delay between sequential bulk-fetch pages (Langfuse free tier: 30 req/min)
_API_DELAY = 2.1  # seconds

# Hard ceiling on total fetch time; returns partial results with timed_out=True if hit
_TOTAL_TIMEOUT = 90  # seconds

# Max parallel workers for observation ID lookups
_OBS_WORKERS = 10


# ── HTTP helpers ───────────────────────────────────────────────────────────────

def _lf_get(path: str, params: dict | None = None) -> dict | list | None:
    """GET from Langfuse public API. Returns parsed JSON or None on error."""
    url = f"{_LANGFUSE_BASE}/api/public{path}"
    try:
        r = requests.get(url, auth=_AUTH, params=params, timeout=15)
        if r.status_code != 200:
            print(f"[langfuse_eval] GET {path} → {r.status_code}: {r.text[:200]}")
            return None
        return r.json()
    except Exception as e:
        print(f"[langfuse_eval] GET {path} error: {e}")
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
        time.sleep(_API_DELAY)
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


def _fetch_obs_ids_for_trace(trace_id: str, sem: threading.Semaphore) -> dict[str, str]:
    """
    Fetch all observation IDs for one trace (used in the thread pool).
    Returns {observation_id: trace_id}.
    """
    with sem:
        data = _lf_get("/observations", params={"traceId": trace_id, "limit": 100})
        if not data:
            return {}
        obs_list = data.get("data", []) if isinstance(data, dict) else []
        return {o["id"]: trace_id for o in obs_list if o.get("id")}


# ── Public API ─────────────────────────────────────────────────────────────────

def get_agent_trace_comments(agent_id: str, db_path) -> dict:
    """
    Fetch all Langfuse comments for an agent's sessions.

    Performance strategy:
    - Bulk-fetch ALL trace comments in 1-2 paginated calls, then filter client-side.
    - Fetch observation IDs for all traces in parallel (ThreadPoolExecutor).
    - Bulk-fetch ALL observation comments in 1-2 paginated calls, then filter client-side.

    Returns:
        {
          "comments": list[{session_id, comment, author, created_at}],
          "sessions_with_comments": int,
          "total_comments": int,
          "sessions_checked": int,
          "fetch_time_seconds": float,
          "timed_out": bool  (only present when True)
        }
    """
    start_time = time.time()
    deadline = start_time + _TOTAL_TIMEOUT

    # ── Step 1: Load sessions from DB ─────────────────────────────────────────
    from database import get_connection
    with get_connection(db_path) as conn:
        rows = conn.execute(
            """SELECT session_id, langfuse_trace_url
               FROM sessions
               WHERE langfuse_trace_url IS NOT NULL
               ORDER BY timestamp DESC"""
        ).fetchall()

    sessions_checked = len(rows)

    # Build trace_id → session_id map (only valid trace IDs)
    trace_to_session: dict[str, str] = {}
    for row in rows:
        trace_id = _extract_trace_id(row["langfuse_trace_url"])
        if trace_id:
            trace_to_session[trace_id] = row["session_id"]

    def _build_result(
        comments: list[dict],
        sessions_with: set[str],
        timed_out: bool = False,
    ) -> dict:
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

    # ── Step 3: Parallel observation ID fetch ──────────────────────────────────
    print(
        f"[langfuse_eval] Fetching observations for {len(known_trace_ids)} traces "
        f"({_OBS_WORKERS} parallel workers)..."
    )
    obs_to_trace: dict[str, str] = {}
    sem = threading.Semaphore(_OBS_WORKERS)
    remaining = max(5.0, deadline - time.time())

    with ThreadPoolExecutor(max_workers=_OBS_WORKERS) as executor:
        futures = {
            executor.submit(_fetch_obs_ids_for_trace, tid, sem): tid
            for tid in known_trace_ids
        }
        done, not_done = wait(futures, timeout=remaining)
        for future in done:
            try:
                obs_to_trace.update(future.result())
            except Exception as e:
                print(f"[langfuse_eval] Obs fetch error: {e}")
        if not_done:
            print(
                f"[langfuse_eval] Warning: {len(not_done)} observation fetches "
                f"did not finish — observation-level comments on those traces may be missed"
            )
            for f in not_done:
                f.cancel()

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

def propose_axial_codes(open_codes: list[dict]) -> list[str]:
    """
    Ask Claude to propose 2–6 axial code categories from the open codes.
    Returns a list of category name strings.
    """
    prompt = f"""You are a qualitative research assistant performing axial coding on LLM evaluation notes.

Below are open codes — notes made by a human reviewer on AI agent simulation sessions.
Each note describes something the reviewer observed about the agent's behavior.

Your task:
1. Read all open codes carefully
2. Identify the underlying themes and propose axial code category names that group these open codes
3. Propose between 2 and 6 axial categories — no more, no fewer
4. Each category name should be concise (3-5 words max) and descriptive
5. Return ONLY a JSON array of category name strings, nothing else

Open codes:
{json.dumps([item["comment"] for item in open_codes], indent=2)}"""

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

    # Count unique sessions per axial code
    freq: dict[str, set] = {cat: set() for cat in confirmed_categories}
    for item in coded:
        for code in item.get("axial_codes", []):
            if code in freq:
                freq[code].add(item["session_id"])

    frequencies = {cat: len(sessions) for cat, sessions in freq.items()}
    return coded, frequencies


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
