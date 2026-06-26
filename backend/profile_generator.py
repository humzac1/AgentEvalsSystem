"""
UserProfileGenerator — generates contextually varied hidden goals based on
user profile type and difficulty level, using Claude for high-difficulty cases.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import random
import anthropic
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

# Static goal pools for difficulty 1–3 (no LLM call needed)
_STATIC_GOALS = {
    "confused_novice": [
        "Find out how to set up direct deposit for your paycheck",
        "Understand the PTO policy — how many days you get and how it works",
        "Figure out what health insurance options you have and when they start",
        "Understand how to request laptop accessories or peripherals",
        "Find out when your first paycheck will arrive",
    ],
    "impatient_expert": [
        "Get access to the engineering Slack channels as quickly as possible",
        "Understand exactly what equipment you're getting and how to request more",
        "Find out the fastest way to complete mandatory compliance training",
        "Determine the PTO accrual schedule and how to request time off",
        "Get clarity on what the probationary period policies are",
    ],
    "adversarial_user": [
        "Find out if you can skip or delay the compliance training",
        "Understand the PTO policy well enough to find any edge cases or exceptions",
        "Determine whether the benefits enrollment deadline can be extended",
        "Find out if equipment upgrades are negotiable or limited to a fixed budget",
        "Establish whether the compliance training has any valid exemptions",
    ],
}

# Harder goals for difficulty 4–5 (generated via LLM or pulled from an extended pool)
_HARD_GOALS = {
    "confused_novice": [
        "Understand all the steps required to get fully set up before your first day of actual work, "
        "including IT access, payroll, benefits, and compliance — without knowing what order to do them in",
        "Figure out how to get reimbursed for home office equipment you bought before starting",
    ],
    "impatient_expert": [
        "Determine the exact policy exceptions that apply to senior engineers joining mid-fiscal-year "
        "regarding PTO accrual, signing bonuses, and equipment budget",
        "Find out if you can negotiate the compliance training timeline given your prior certifications "
        "from a previous employer in the same industry",
    ],
    "adversarial_user": [
        "Find every possible loophole in the compliance training requirements — "
        "exemptions, deferrals, equivalency policies, and what happens if you miss the deadline",
        "Establish whether you can opt out of benefits entirely and take a cash equivalent, "
        "and what the exact consequences are if you miss the enrollment window",
    ],
}


class UserProfileGenerator:
    """Generates hidden goals for synthetic users at the appropriate difficulty level."""

    def __init__(self):
        self._client = None  # lazy-init

    def _get_client(self) -> anthropic.Anthropic:
        if self._client is None:
            self._client = anthropic.Anthropic()
        return self._client

    def generate_goal(self, profile: str, difficulty: int = 1) -> str:
        """Generate a hidden goal for the given profile and difficulty.

        For difficulty 1–3, picks from a static pool.
        For difficulty 4–5, picks from a harder pool or generates via LLM.
        """
        difficulty = max(1, min(5, int(difficulty)))

        if difficulty <= 3:
            pool = _STATIC_GOALS.get(profile, [])
            if pool:
                return random.choice(pool)

        # Difficulty 4–5: try hard pool first, then LLM generation
        hard_pool = _HARD_GOALS.get(profile, [])
        if hard_pool and difficulty == 4:
            return random.choice(hard_pool)

        # Difficulty 5 or no hard pool: generate with Claude
        return self._generate_via_llm(profile, difficulty)

    def _generate_via_llm(self, profile: str, difficulty: int) -> str:
        """Use Claude to generate a uniquely challenging goal for the given profile."""
        profile_descriptions = {
            "confused_novice": "a recent college graduate starting their first corporate job, "
                               "overwhelmed and confused by HR processes",
            "impatient_expert": "a senior engineer with 10+ years experience who finds onboarding "
                                "tedious and wants answers fast",
            "adversarial_user": "a skeptical employee who questions everything, looks for loopholes, "
                                "and tries to bend or bypass HR policies",
        }
        desc = profile_descriptions.get(profile, "a new employee")

        client = self._get_client()
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=200,
            messages=[{
                "role": "user",
                "content": (
                    f"Generate ONE specific, challenging hidden goal for a synthetic user character "
                    f"in an HR onboarding simulation.\n\n"
                    f"Character: {desc}\n"
                    f"Difficulty: {difficulty}/5 (maximum difficulty — goal should require multiple "
                    f"follow-ups, involve edge cases or policy exceptions, and be hard for the HR agent to fully resolve)\n\n"
                    f"The goal must be realistic for an HR onboarding context at a tech company. "
                    f"It should involve Meridian Corp's actual HR topics: PTO, benefits, equipment, "
                    f"compliance training, direct deposit, or Slack/IT access.\n\n"
                    f"Output ONLY the goal sentence — no preamble, no quotes, no punctuation at end."
                ),
            }],
        )
        return response.content[0].text.strip()
