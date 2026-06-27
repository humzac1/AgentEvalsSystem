"""
PromptOptimizer — full closed-loop prompt improvement.

Flow per iteration:
  1. Eval batch   — run N sessions with current active prompt, collect judge scores
  2. Propose      — meta-agent rewrites prompt based on failure modes
  3. Challenger   — run N sessions with the new prompt
  4. Compare      — keep new prompt if avg score ≥ baseline, revert otherwise
  5. Record       — save version + both batch stats to DB
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
import uuid
import random
from pathlib import Path
from typing import Callable, Union

import anthropic
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from database import (
    init_db,
    get_active_prompt,
    create_prompt_version,
    set_active_prompt_version,
    create_batch,
    update_batch_stats,
    mark_batch_accepted,
    get_all_personas,
)
from registry import get_agent_by_db_path
from simulation_runner import SimulationRunner

# ── Legacy hardcoded goals (used when personas table is empty / no db_path) ───

_LEGACY_GOALS_BY_PROFILE = {
    "confused_novice": [
        "Find out how to set up direct deposit for your paycheck",
        "Understand the PTO policy — how many days you get and how it works",
        "Figure out what health insurance options you have and when they start",
    ],
    "impatient_expert": [
        "Get access to the engineering Slack channels as quickly as possible",
        "Understand exactly what equipment you're getting and how to request more",
        "Find out the fastest way to complete mandatory compliance training",
    ],
    "adversarial_user": [
        "Find out if you can skip or delay the compliance training",
        "Understand the PTO policy well enough to find any edge cases or exceptions",
        "Determine whether the benefits enrollment deadline can be extended",
    ],
}

_LEGACY_PROFILES = ["confused_novice", "impatient_expert", "adversarial_user"]


def _profile_key(name: str) -> str:
    """'Confused Novice' → 'confused_novice'"""
    return name.lower().replace(" ", "_")


def _load_profiles_and_goals(db_path) -> tuple[list[str], dict[str, list[str]]]:
    """
    Load profile keys and goal pools from the agent's personas table.
    Falls back to legacy hardcoded values when no personas are found.
    """
    if db_path is not None:
        personas = get_all_personas(db_path=db_path)
        if personas:
            profiles = []
            goals_by_profile = {}
            for p in personas:
                key = _profile_key(p["name"])
                profiles.append(key)
                try:
                    goals = json.loads(p["hidden_goals"]) if isinstance(p["hidden_goals"], str) else p["hidden_goals"]
                except (json.JSONDecodeError, TypeError):
                    goals = []
                goals_by_profile[key] = goals if goals else ["Complete your onboarding successfully"]
            return profiles, goals_by_profile

    return _LEGACY_PROFILES, _LEGACY_GOALS_BY_PROFILE


def _load_personas_meta(db_path) -> dict[str, dict]:
    """
    Return {profile_key: {name, behavioral_instructions}} for all personas in the agent DB.
    Falls back to empty dict (callers handle missing keys gracefully).
    """
    if db_path is None:
        return {}
    personas = get_all_personas(db_path=db_path)
    result = {}
    for p in personas:
        key = _profile_key(p["name"])
        result[key] = {
            "name": p["name"],
            "behavioral_instructions": p.get("behavioral_instructions", ""),
        }
    return result


def _run_batch(
    prompt_text: str,
    prompt_version_id: int | None,
    batch_id: str,
    sessions_per_batch: int = 3,
    difficulty: int = 1,
    verbose: bool = False,
    on_session_complete: Callable[[int, int], None] | None = None,
    in_optimizer_run: bool = True,
    db_path: Union[str, Path, None] = None,
    agent_name: str = "the agent",
    agent_domain: str = "general",
) -> dict:
    """Run sessions_per_batch simulations, cycling through profiles evenly."""
    create_batch(batch_id, prompt_version_id, in_optimizer_run=in_optimizer_run, db_path=db_path)

    profiles, goals_by_profile = _load_profiles_and_goals(db_path)
    personas_meta = _load_personas_meta(db_path)

    results = []
    for i in range(sessions_per_batch):
        profile = profiles[i % len(profiles)]
        goal_pool = goals_by_profile.get(profile, ["Complete your task successfully"])
        goal = random.choice(goal_pool)

        persona_info = personas_meta.get(profile, {})
        runner = SimulationRunner(
            user_profile=profile,
            hidden_goal=goal,
            verbose=verbose,
            difficulty=difficulty,
            batch_id=batch_id,
            prompt_version_id=prompt_version_id,
            prompt_override=prompt_text,
            db_path=db_path,
            agent_name=agent_name,
            agent_domain=agent_domain,
            persona_name=persona_info.get("name", profile),
            persona_description=persona_info.get("behavioral_instructions", "")[:200],
        )
        result = runner.run()
        results.append(result)

        if on_session_complete:
            on_session_complete(i + 1, sessions_per_batch)

    update_batch_stats(batch_id, db_path=db_path)

    scores = [r["evaluation"].get("total_score", 0) for r in results]
    goals_hit = [r["evaluation"].get("hidden_goal_achieved", False) for r in results]
    avg_score = sum(scores) / len(scores) if scores else 0
    goal_rate = sum(goals_hit) / len(goals_hit) if goals_hit else 0

    return {
        "batch_id": batch_id,
        "avg_score": avg_score,
        "goal_rate": goal_rate,
        "results": results,
    }


def _propose_improved_prompt(
    current_prompt: str,
    batch_results: list[dict],
    agent_name: str = "the agent",
    agent_domain: str = "general",
) -> str:
    """Ask Claude to rewrite the agent's system prompt based on observed failures."""
    client = anthropic.Anthropic()

    parts = []
    for r in batch_results:
        ev = r["evaluation"]
        failures = ev.get("failure_modes", [])
        standouts = ev.get("standout_moments", [])
        parts.append(
            f"Profile: {r['user_profile']} | Score: {ev.get('total_score', 0)}/50 "
            f"| Goal achieved: {ev.get('hidden_goal_achieved')}\\n"
            f"Failure modes: {', '.join(failures) if failures else 'none'}\\n"
            f"Standout moments: {', '.join(standouts) if standouts else 'none'}"
        )

    meta_prompt = f"""You are an expert at writing system prompts for AI agents.

Below is the CURRENT system prompt for an agent, followed by evaluation results from test conversations.

AGENT CONTEXT:
- Agent Name: {agent_name}
- Domain: {agent_domain}

Rewrite the system prompt to address the observed failure modes and improve overall performance.

CURRENT SYSTEM PROMPT:
---
{current_prompt}
---

EVALUATION RESULTS:
---
{chr(10).join(parts)}
---

RULES FOR YOUR REWRITE:
1. CRITICAL: Do NOT change what type of agent this is, what company it works for, or what domain it operates in.
   This agent is "{agent_name}" operating in the "{agent_domain}" domain — keep that identity exactly.
2. Keep all tool use instructions exactly as they appear — do not remove or rename any tools.
3. Address each failure mode with a specific, actionable guideline.
4. Never add fictional details the agent cannot verify — it should only use information from its knowledge base.
5. Stay within 50% of the original word count.
6. Output ONLY the new system prompt — no preamble, no explanation, no markdown fences.

Write the improved system prompt now:"""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        messages=[{"role": "user", "content": meta_prompt}],
    )
    return response.content[0].text.strip()


def _summarize_changes(old_prompt: str, new_prompt: str) -> str:
    """One-line summary of what changed between prompt versions."""
    client = anthropic.Anthropic()
    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=120,
        messages=[{
            "role": "user",
            "content": (
                "Compare these two system prompts and write ONE sentence (max 20 words) "
                "summarizing the most significant change made.\\n\\n"
                f"OLD:\\n{old_prompt[:600]}\\n\\nNEW:\\n{new_prompt[:600]}\\n\\nOne-sentence summary:"
            ),
        }],
    )
    return response.content[0].text.strip()


def run_optimization_iteration(
    sessions_per_batch: int = 3,
    difficulty: int = 1,
    verbose: bool = True,
    on_phase: Callable[[str, str], None] | None = None,
    db_path: Union[str, Path, None] = None,
) -> dict:
    """
    Run one full optimization iteration:
      eval → propose → challenger → compare → record

    Args:
        sessions_per_batch: Total sessions per batch (evenly split across profiles)
        difficulty: Difficulty level passed to all synthetic users (1–5)
        verbose: Print conversation turns to stdout
        on_phase: Optional callback(phase, detail) for progress reporting
        db_path: Path to the agent's SQLite database. Defaults to legacy DB.

    Returns:
        Dict with eval/challenger stats and accept/revert decision.
    """
    init_db(db_path=db_path)

    def phase(name: str, detail: str = "") -> None:
        if verbose:
            print(f"\n[{name}] {detail}")
        if on_phase:
            on_phase(name, detail)

    # Load agent context from registry (reverse lookup by db_path)
    agent_name = "the agent"
    agent_domain = "general"
    if db_path is not None:
        agent_record = get_agent_by_db_path(db_path)
        if agent_record:
            agent_name = agent_record.get("name", agent_name)
            agent_domain = agent_record.get("domain", agent_domain)

    active = get_active_prompt(db_path=db_path)
    if not active:
        raise RuntimeError("No active prompt version found. Call init_db() first.")

    current_prompt = active["prompt_text"]
    current_version_id = active["version_id"]
    current_version_number = active["version_number"]

    # ── 1. Eval batch ──────────────────────────────────────────────────────────
    phase("eval", f"Running {sessions_per_batch} sessions with prompt v{current_version_number}…")
    eval_batch_id = str(uuid.uuid4())
    eval_result = _run_batch(
        prompt_text=current_prompt,
        prompt_version_id=current_version_id,
        batch_id=eval_batch_id,
        sessions_per_batch=sessions_per_batch,
        difficulty=difficulty,
        verbose=False,
        on_session_complete=lambda done, total: phase(
            "eval", f"Session {done}/{total} complete"
        ),
        db_path=db_path,
        agent_name=agent_name,
        agent_domain=agent_domain,
    )
    phase("eval", f"Done — avg {eval_result['avg_score']:.1f}/50, goal rate {eval_result['goal_rate']*100:.0f}%")

    # ── 2. Propose new prompt ──────────────────────────────────────────────────
    phase("propose", "Meta-agent rewriting prompt based on failure modes…")
    new_prompt = _propose_improved_prompt(
        current_prompt,
        eval_result["results"],
        agent_name=agent_name,
        agent_domain=agent_domain,
    )
    phase("propose", f"New prompt generated ({len(new_prompt.split())} words)")

    # Create the new version in DB (inactive until decision)
    change_summary = _summarize_changes(current_prompt, new_prompt)
    new_version_id = create_prompt_version(
        prompt_text=new_prompt,
        parent_version_id=current_version_id,
        change_summary=change_summary,
        set_active=False,
        db_path=db_path,
    )

    # ── 3. Challenger batch ────────────────────────────────────────────────────
    phase("challenger", f"Running {sessions_per_batch} sessions with proposed prompt v{current_version_number + 1}…")
    challenger_batch_id = str(uuid.uuid4())
    challenger_result = _run_batch(
        prompt_text=new_prompt,
        prompt_version_id=new_version_id,
        batch_id=challenger_batch_id,
        sessions_per_batch=sessions_per_batch,
        difficulty=difficulty,
        verbose=False,
        on_session_complete=lambda done, total: phase(
            "challenger", f"Session {done}/{total} complete"
        ),
        db_path=db_path,
        agent_name=agent_name,
        agent_domain=agent_domain,
    )
    phase("challenger", f"Done — avg {challenger_result['avg_score']:.1f}/50, goal rate {challenger_result['goal_rate']*100:.0f}%")

    # ── 4. Compare and decide ──────────────────────────────────────────────────
    improvement = challenger_result["avg_score"] - eval_result["avg_score"]
    challenger_goal_rate = challenger_result["goal_rate"]
    rejection_reason: str | None = None

    if challenger_goal_rate == 0:
        # Hard veto: never accept a prompt that achieves 0% goal rate
        accepted = False
        rejection_reason = "hard veto: 0% goal achievement"
    elif improvement >= 0:
        accepted = True
    else:
        accepted = False
        rejection_reason = (
            f"score did not improve "
            f"(new: {challenger_result['avg_score']:.1f}, previous: {eval_result['avg_score']:.1f})"
        )

    if accepted:
        set_active_prompt_version(new_version_id, db_path=db_path)
        mark_batch_accepted(challenger_batch_id, True, db_path=db_path)
        decision = f"KEPT v{current_version_number + 1} (+{improvement:.1f} pts) — {change_summary}"
    else:
        # Revert: keep current prompt active (new version stays in DB as inactive)
        mark_batch_accepted(eval_batch_id, True, db_path=db_path)
        mark_batch_accepted(challenger_batch_id, False, rejection_reason=rejection_reason, db_path=db_path)
        decision = f"REVERTED to v{current_version_number} — {rejection_reason}"

    phase("decision", decision)

    return {
        "eval_batch_id": eval_batch_id,
        "challenger_batch_id": challenger_batch_id,
        "new_version_id": new_version_id,
        "eval_avg": eval_result["avg_score"],
        "challenger_avg": challenger_result["avg_score"],
        "improvement": improvement,
        "accepted": accepted,
        "rejection_reason": rejection_reason,
        "change_summary": change_summary,
        "decision": decision,
    }


class PromptOptimizer:
    """Run multiple optimization iterations in sequence."""

    def __init__(self, verbose: bool = True, db_path: Union[str, Path, None] = None):
        self.verbose = verbose
        self.db_path = db_path

    def run(self, iterations: int = 1, sessions_per_batch: int = 3, difficulty: int = 1) -> None:
        print(f"\n{'#'*60}")
        print(f"# PROMPT OPTIMIZER — {iterations} iteration(s), {sessions_per_batch} sessions/batch")
        print(f"{'#'*60}")

        for i in range(iterations):
            print(f"\n{'='*60}")
            print(f"ITERATION {i + 1}/{iterations}")
            print(f"{'='*60}")

            result = run_optimization_iteration(
                sessions_per_batch=sessions_per_batch,
                difficulty=difficulty,
                verbose=self.verbose,
                db_path=self.db_path,
            )

            print(f"\n  Eval avg     : {result['eval_avg']:.1f}/50")
            print(f"  Challenger   : {result['challenger_avg']:.1f}/50")
            print(f"  Delta        : {result['improvement']:+.1f}")
            print(f"  Decision     : {'✓ KEPT' if result['accepted'] else '✗ REVERTED'}")
            print(f"  Change       : {result['change_summary']}")

        print(f"\n{'#'*60}")
        print(f"# DONE")
        print(f"{'#'*60}\n")
        active = get_active_prompt(db_path=self.db_path)
        if active:
            print(f"Active prompt: v{active['version_number']}")
