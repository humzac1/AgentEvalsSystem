"""
run_batch.py — Runs one simulation per user profile, picking a randomized
hidden goal from a predefined list. Creates a batch record automatically.

Usage:
    cd backend
    python run_batch.py
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uuid
import random
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from database import init_db, get_active_prompt, create_batch, update_batch_stats
from simulation_runner import SimulationRunner

# 6 goals total — 2 per profile archetype
GOALS_BY_PROFILE = {
    "confused_novice": [
        "Find out how to set up direct deposit for your paycheck",
        "Understand the PTO policy — how many days you get and how it works",
    ],
    "impatient_expert": [
        "Get access to the engineering Slack channels as quickly as possible",
        "Understand exactly what equipment you're getting and how to request more",
    ],
    "adversarial_user": [
        "Find out if you can skip or delay the compliance training",
        "Understand the PTO policy well enough to find any edge cases or exceptions",
    ],
}

PROFILES = ["confused_novice", "impatient_expert", "adversarial_user"]


def run_batch(verbose: bool = True) -> list[dict]:
    """
    Run one simulation for each profile with a randomly selected goal.
    Creates a batch record and associates all sessions with it.

    Returns:
        List of simulation result dicts.
    """
    init_db()

    batch_id = str(uuid.uuid4())
    active_prompt = get_active_prompt()
    prompt_version_id = active_prompt["version_id"] if active_prompt else None

    create_batch(batch_id, prompt_version_id)

    print(f"\nBatch ID: {batch_id}")
    if active_prompt:
        print(f"Prompt version: v{active_prompt['version_number']}")

    results = []

    for profile in PROFILES:
        goals = GOALS_BY_PROFILE[profile]
        goal = random.choice(goals)

        print(f"\n{'#'*60}")
        print(f"# Starting simulation: {profile}")
        print(f"# Goal: {goal}")
        print(f"{'#'*60}")

        runner = SimulationRunner(
            user_profile=profile,
            hidden_goal=goal,
            verbose=verbose,
            batch_id=batch_id,
            prompt_version_id=prompt_version_id,
        )
        result = runner.run()
        results.append(result)

        print(f"\n✓ Completed session {result['session_id']}")
        print(f"  Score: {result['evaluation'].get('total_score', 0)}/40")
        print(f"  Quality: {result['evaluation'].get('trajectory_quality', 'unknown')}")

    update_batch_stats(batch_id)

    print(f"\n{'='*60}")
    print(f"BATCH COMPLETE — {len(results)} sessions run")
    print(f"{'='*60}")

    for r in results:
        ev = r["evaluation"]
        print(
            f"  {r['user_profile']:<20} | "
            f"Score: {ev.get('total_score', 0):>2}/40 | "
            f"Quality: {ev.get('trajectory_quality', 'N/A'):<6} | "
            f"Goal: {'✓' if ev.get('hidden_goal_achieved') else '✗'}"
        )

    return results


if __name__ == "__main__":
    run_batch(verbose=True)
