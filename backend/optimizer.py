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

import uuid
import random
from typing import Callable

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
)
from simulation_runner import SimulationRunner

GOALS_BY_PROFILE = {
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

PROFILES = ["confused_novice", "impatient_expert", "adversarial_user"]


def _run_batch(
    prompt_text: str,
    prompt_version_id: int | None,
    batch_id: str,
    sessions_per_batch: int = 3,
    difficulty: int = 1,
    verbose: bool = False,
    on_session_complete: Callable[[int, int], None] | None = None,
    in_optimizer_run: bool = True,
) -> dict:
    """Run sessions_per_batch simulations, cycling through profiles evenly."""
    create_batch(batch_id, prompt_version_id, in_optimizer_run=in_optimizer_run)

    results = []
    for i in range(sessions_per_batch):
        profile = PROFILES[i % len(PROFILES)]
        goal_pool = GOALS_BY_PROFILE[profile]
        goal = random.choice(goal_pool)

        runner = SimulationRunner(
            user_profile=profile,
            hidden_goal=goal,
            verbose=verbose,
            difficulty=difficulty,
            batch_id=batch_id,
            prompt_version_id=prompt_version_id,
            prompt_override=prompt_text,
        )
        result = runner.run()
        results.append(result)

        if on_session_complete:
            on_session_complete(i + 1, sessions_per_batch)

    update_batch_stats(batch_id)

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


def _propose_improved_prompt(current_prompt: str, batch_results: list[dict]) -> str:
    """Ask Claude to rewrite the HR agent prompt based on observed failures."""
    client = anthropic.Anthropic()

    parts = []
    for r in batch_results:
        ev = r["evaluation"]
        failures = ev.get("failure_modes", [])
        standouts = ev.get("standout_moments", [])
        parts.append(
            f"Profile: {r['user_profile']} | Score: {ev.get('total_score', 0)}/40 "
            f"| Goal achieved: {ev.get('hidden_goal_achieved')}\n"
            f"Failure modes: {', '.join(failures) if failures else 'none'}\n"
            f"Standout moments: {', '.join(standouts) if standouts else 'none'}"
        )

    meta_prompt = f"""You are an expert at writing system prompts for AI HR assistants.

Below is the CURRENT system prompt for an HR onboarding assistant named Alex at Meridian Corp,
followed by evaluation results from test conversations with synthetic users.

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
1. Keep Alex's name, Meridian Corp, and core role (HR onboarding assistant)
2. Keep the `lookup_hr_info` tool instruction — mandatory
3. Address each failure mode with a specific, actionable guideline
4. Never add fictional policy details — Alex only provides information from the knowledge base
5. Stay within 50% of the original word count
6. Output ONLY the new system prompt — no preamble, no explanation, no markdown

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
                "summarizing the most significant change made.\n\n"
                f"OLD:\n{old_prompt[:600]}\n\nNEW:\n{new_prompt[:600]}\n\nOne-sentence summary:"
            ),
        }],
    )
    return response.content[0].text.strip()


def run_optimization_iteration(
    sessions_per_batch: int = 3,
    difficulty: int = 1,
    verbose: bool = True,
    on_phase: Callable[[str, str], None] | None = None,
) -> dict:
    """
    Run one full optimization iteration:
      eval → propose → challenger → compare → record

    Args:
        sessions_per_batch: Total sessions per batch (evenly split across 3 profiles)
        difficulty: Difficulty level passed to all synthetic users (1–5)
        verbose: Print conversation turns to stdout
        on_phase: Optional callback(phase, detail) for progress reporting

    Returns:
        Dict with eval/challenger stats and accept/revert decision.
    """
    init_db()

    def phase(name: str, detail: str = "") -> None:
        if verbose:
            print(f"\n[{name}] {detail}")
        if on_phase:
            on_phase(name, detail)

    active = get_active_prompt()
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
    )
    phase("eval", f"Done — avg {eval_result['avg_score']:.1f}/40, goal rate {eval_result['goal_rate']*100:.0f}%")

    # ── 2. Propose new prompt ──────────────────────────────────────────────────
    phase("propose", "Meta-agent rewriting prompt based on failure modes…")
    new_prompt = _propose_improved_prompt(current_prompt, eval_result["results"])
    phase("propose", f"New prompt generated ({len(new_prompt.split())} words)")

    # Create the new version in DB (inactive until decision)
    change_summary = _summarize_changes(current_prompt, new_prompt)
    new_version_id = create_prompt_version(
        prompt_text=new_prompt,
        parent_version_id=current_version_id,
        change_summary=change_summary,
        set_active=False,
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
    )
    phase("challenger", f"Done — avg {challenger_result['avg_score']:.1f}/40, goal rate {challenger_result['goal_rate']*100:.0f}%")

    # ── 4. Compare and decide ──────────────────────────────────────────────────
    improvement = challenger_result["avg_score"] - eval_result["avg_score"]
    accepted = improvement >= 0

    if accepted:
        set_active_prompt_version(new_version_id)
        mark_batch_accepted(challenger_batch_id, True)
        decision = f"KEPT v{current_version_number + 1} (+{improvement:.1f} pts) — {change_summary}"
    else:
        # Revert: keep current prompt active (new version stays in DB as inactive)
        mark_batch_accepted(eval_batch_id, True)
        decision = f"REVERTED to v{current_version_number} ({improvement:+.1f} pts) — new prompt was worse"

    phase("decision", decision)

    return {
        "eval_batch_id": eval_batch_id,
        "challenger_batch_id": challenger_batch_id,
        "new_version_id": new_version_id,
        "eval_avg": eval_result["avg_score"],
        "challenger_avg": challenger_result["avg_score"],
        "improvement": improvement,
        "accepted": accepted,
        "change_summary": change_summary,
        "decision": decision,
    }


class PromptOptimizer:
    """Run multiple optimization iterations in sequence."""

    def __init__(self, verbose: bool = True):
        self.verbose = verbose

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
            )

            print(f"\n  Eval avg     : {result['eval_avg']:.1f}/40")
            print(f"  Challenger   : {result['challenger_avg']:.1f}/40")
            print(f"  Delta        : {result['improvement']:+.1f}")
            print(f"  Decision     : {'✓ KEPT' if result['accepted'] else '✗ REVERTED'}")
            print(f"  Change       : {result['change_summary']}")

        print(f"\n{'#'*60}")
        print(f"# DONE")
        print(f"{'#'*60}\n")
        active = get_active_prompt()
        if active:
            print(f"Active prompt: v{active['version_number']}")
