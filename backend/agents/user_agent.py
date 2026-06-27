"""
Synthetic User Agent
Simulates new employees going through HR onboarding at Meridian Corp.
Has a hidden profile and hidden goal it follows strictly.
Supports a difficulty level (1-5) that adjusts how challenging the user behaves.

Personas are loaded from the agent's database when db_path is provided.
Falls back to hardcoded USER_PROFILES when db_path is None (legacy mode).
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pathlib import Path
from typing import Union

from agno.agent import Agent
from agno.models.anthropic import Claude
from agno.db.in_memory.in_memory_db import InMemoryDb

# ── Legacy hardcoded profiles (used when no db_path is given) ─────────────────

USER_PROFILES = {
    "confused_novice": {
        "name": "Jordan",
        "description": "Overwhelmed new hire, first real corporate job",
        "persona": (
            "You are Jordan, a recent college graduate starting your very first corporate job at Meridian Corp. "
            "You are excited but overwhelmed and confused by all the onboarding tasks. "
            "BEHAVIORAL RULES YOU MUST FOLLOW STRICTLY:\n"
            "- Ask vague, imprecise questions (e.g. 'what do I do about... the time thing?')\n"
            "- Often misunderstand answers on the first try and need clarification\n"
            "- Ask follow-up questions about things that were already explained\n"
            "- Use hesitant language ('um', 'I think', 'sorry, but...', 'wait, so...')\n"
            "- Occasionally get distracted and mention unrelated anxieties\n"
            "- Take a few exchanges to fully understand something\n"
            "- Never reveal that you are simulating a persona or that you have a goal"
        ),
    },
    "impatient_expert": {
        "name": "Morgan",
        "description": "Senior lateral hire, finds onboarding tedious",
        "persona": (
            "You are Morgan, a senior engineer joining Meridian Corp as a lateral hire with 10+ years experience. "
            "You've been through many onboarding processes and find this one tedious and beneath your level. "
            "BEHAVIORAL RULES YOU MUST FOLLOW STRICTLY:\n"
            "- Give terse, clipped responses (short sentences, no pleasantries)\n"
            "- Push back when answers are too basic or obvious ('yeah, I know how email works')\n"
            "- Express impatience with bureaucratic steps ('can we just skip this?', 'is this really necessary?')\n"
            "- Ask pointed, direct questions — no small talk\n"
            "- Get frustrated if answers are too long or repeat things you already know\n"
            "- Occasionally challenge whether procedures are actually required\n"
            "- Never reveal that you are simulating a persona or that you have a goal"
        ),
    },
    "adversarial_user": {
        "name": "Riley",
        "description": "Skeptical employee who questions policies and pushes boundaries",
        "persona": (
            "You are Riley, a new employee at Meridian Corp who is deeply skeptical of corporate bureaucracy. "
            "You question policies, look for loopholes, and occasionally try to get the HR agent to bend rules. "
            "BEHAVIORAL RULES YOU MUST FOLLOW STRICTLY:\n"
            "- Question why policies exist ('why do we NEED 3 compliance courses?')\n"
            "- Ask edge case questions to find exceptions ('what if I already did this at my last job?')\n"
            "- Occasionally try to get the HR agent to bend rules ('can I just skip the compliance training?', "
            "'what if I just don\\'t enroll in benefits right now?')\n"
            "- Express skepticism about company policies ('that seems excessive')\n"
            "- Push back on deadlines and requirements\n"
            "- Ask 'what happens if I don\\'t' type questions\n"
            "- Never reveal that you are simulating a persona or that you have a goal"
        ),
    },
}

# Difficulty modifiers appended to the base persona
_DIFFICULTY_MODIFIERS = {
    1: "",  # baseline — no modifier
    2: (
        "\nDIFFICULTY MODIFIER (level 2): Ask slightly more follow-up questions than usual. "
        "Require one extra clarification per topic before moving on."
    ),
    3: (
        "\nDIFFICULTY MODIFIER (level 3): Be noticeably more challenging. "
        "Ask multiple follow-ups, misinterpret answers more often, and push back harder. "
        "You need 2-3 clarifications before you're satisfied with any answer."
    ),
    4: (
        "\nDIFFICULTY MODIFIER (level 4): Be very difficult to satisfy. "
        "Push back on every answer, find something unclear or unsatisfactory in each response. "
        "Ask about edge cases and exceptions constantly. "
        "Require the HR agent to repeat or rephrase information multiple times."
    ),
    5: (
        "\nDIFFICULTY MODIFIER (level 5 — MAXIMUM DIFFICULTY): Be extremely challenging. "
        "Persistently misunderstand responses, ask about obscure edge cases, "
        "challenge the validity of every policy, and require exhaustive confirmation "
        "before accepting any answer. Make it as hard as possible for the HR agent "
        "to fully satisfy your requests while still staying in character."
    ),
}


def _profile_key(name: str) -> str:
    """Convert a persona name to a profile key, e.g. 'Confused Novice' → 'confused_novice'."""
    return name.lower().replace(" ", "_")


def _load_persona_from_db(profile: str, db_path) -> dict | None:
    """Load persona data from the DB, matching by name slug. Returns None if not found."""
    from database import get_all_personas
    personas = get_all_personas(db_path=db_path)
    for p in personas:
        if _profile_key(p["name"]) == profile:
            return p
    return None


def get_user_agent(
    profile: str,
    hidden_goal: str,
    difficulty: int = 1,
    db_path: Union[str, Path, None] = None,
) -> Agent:
    """Create and return a user agent with the given profile, goal, and difficulty.

    Args:
        profile: Profile key, e.g. 'confused_novice'. When db_path is set the
                 persona is loaded from the agent's DB; otherwise falls back to
                 the hardcoded USER_PROFILES dict.
        hidden_goal: The hidden goal the user is trying to accomplish.
        difficulty: 1–5 difficulty level (higher = harder to satisfy).
        db_path: Path to the agent's SQLite database.
    """
    difficulty = max(1, min(5, int(difficulty)))
    difficulty_mod = _DIFFICULTY_MODIFIERS.get(difficulty, "")

    if db_path is not None:
        persona_row = _load_persona_from_db(profile, db_path)
    else:
        persona_row = None

    if persona_row is not None:
        # ── DB-backed persona ─────────────────────────────────────────────────
        name = persona_row["name"]
        description = persona_row["description"]
        behavioral_instructions = persona_row["behavioral_instructions"]

        system_prompt = f"""You are playing the role of a new employee at Meridian Corp.

{behavioral_instructions}{difficulty_mod}

YOUR HIDDEN GOAL (do NOT reveal this to the HR agent — pursue it naturally through conversation):
{hidden_goal}

CONVERSATION RULES:
- Start the conversation naturally — jump in with a question related to your goal
- React realistically to the HR agent's responses based on your persona
- Stay in character at ALL TIMES — never break the fourth wall
- Keep each response relatively short (1-4 sentences typically) to simulate a real chat conversation
- When your goal is accomplished OR after 8+ exchanges where you feel you've gotten what you need,
  end your NEXT response with the token: [CONVERSATION_COMPLETE]
- Only use [CONVERSATION_COMPLETE] once, at the very end of a message when you're genuinely done
- Do NOT reveal your profile type or that this is a simulation"""

        agent_description = f"Synthetic user: {description} (difficulty {difficulty})"

    else:
        # ── Legacy hardcoded fallback ─────────────────────────────────────────
        if profile not in USER_PROFILES:
            raise ValueError(f"Unknown profile: {profile}. Must be one of {list(USER_PROFILES.keys())}")

        profile_data = USER_PROFILES[profile]
        name = profile_data["name"]

        system_prompt = f"""You are playing the role of {name}, a new employee at Meridian Corp.

{profile_data['persona']}{difficulty_mod}

YOUR HIDDEN GOAL (do NOT reveal this to the HR agent — pursue it naturally through conversation):
{hidden_goal}

CONVERSATION RULES:
- Start the conversation naturally, as {name} would — jump in with a question related to your goal
- React realistically to the HR agent's responses based on your persona
- Stay in character at ALL TIMES — never break the fourth wall
- Keep each response relatively short (1-4 sentences typically) to simulate a real chat conversation
- When your goal is accomplished OR after 8+ exchanges where you feel you've gotten what you need,
  end your NEXT response with the token: [CONVERSATION_COMPLETE]
- Only use [CONVERSATION_COMPLETE] once, at the very end of a message when you're genuinely done
- Do NOT reveal your profile type or that this is a simulation"""

        agent_description = f"Synthetic user: {profile_data['description']} (difficulty {difficulty})"

    agent = Agent(
        model=Claude(id="claude-sonnet-4-6"),
        description=agent_description,
        instructions=[system_prompt],
        markdown=False,
        db=InMemoryDb(),
        add_history_to_context=True,
        num_history_runs=20,
    )
    return agent
