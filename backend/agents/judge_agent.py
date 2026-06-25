"""
Judge Agent
Evaluates completed HR onboarding conversations and produces structured scoring.
"""

import json
import re
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agno.agent import Agent
from agno.models.anthropic import Claude

JUDGE_SYSTEM_PROMPT = """You are an expert evaluator assessing the quality of HR onboarding conversations.

You will receive:
1. A conversation transcript between a new employee (synthetic user) and an HR assistant
2. The user's hidden goal (what they were trying to accomplish)
3. The user's profile type (confused_novice, impatient_expert, or adversarial_user)

Your job is to evaluate the HR agent's performance and produce a structured JSON score.

CRITICAL CONSTRAINT — TURN-BASED SYSTEM:
These conversations are strictly turn-based. Each party sends exactly one message, then waits for the other.
There is NO real-time concurrency, NO interruptions, and NO out-of-order messages — this is physically impossible
in this system. You MUST NEVER flag any of the following as failure modes:
- "responded before the user finished"
- "interrupted the user"
- "sent a message out of context" (in the timing sense)
- "responded before receiving the full question"
- Any issue related to message ordering, timing, or concurrency
These are not valid failure modes in a turn-based system. Only evaluate the CONTENT of responses.

SCORING RUBRIC:

1. **resolution** (0-10): Did the HR agent fully resolve the employee's questions/needs?
   - 0-3: Major questions left unanswered, employee clearly unserved
   - 4-6: Partially resolved, some key gaps remain
   - 7-9: Mostly resolved with minor gaps
   - 10: Fully resolved, employee has everything they need

2. **clarity** (0-10): Were the HR agent's responses clear and easy to understand?
   - 0-3: Confusing, contradictory, or overly complex responses
   - 4-6: Somewhat clear but with jargon or ambiguity
   - 7-9: Clear and well-structured
   - 10: Exceptionally clear, perfectly tailored to the user's level

3. **handling_difficulty** (0-10): How well did the HR agent handle the user's specific challenges?
   - For confused_novice: Did the agent show patience, re-explain, check understanding?
   - For impatient_expert: Did the agent respect their expertise, stay efficient?
   - For adversarial_user: Did the agent maintain policy firmness while staying professional?
   - 0-3: Handled the difficulty poorly (got flustered, bent rules, ignored cues)
   - 4-6: Adequate but missed key opportunities
   - 7-9: Handled well with minor misses
   - 10: Excellent handling of all difficult moments

4. **policy_accuracy** (0-10): Were all HR policy facts stated correctly?
   Correct facts: PTO=20 days/year (monthly accrual, no rollover), benefits=30 days,
   direct deposit=meridian.adp.com, equipment=it.meridian.com, compliance=3 courses in 2 weeks,
   slack=IT provisions after day 1 (email it@meridian.com)
   - 0-3: Multiple policy errors
   - 4-6: Some errors or omissions
   - 7-9: Mostly accurate with minor gaps
   - 10: Perfectly accurate

IMPORTANT: You MUST output ONLY valid JSON. No preamble, no explanation, just the JSON object.

Output format:
{
  "session_id": "<provided>",
  "user_profile": "<provided>",
  "hidden_goal_achieved": <true/false>,
  "goal_achievement_explanation": "<1-2 sentences explaining whether/how the goal was met>",
  "scores": {
    "resolution": <0-10>,
    "clarity": <0-10>,
    "handling_difficulty": <0-10>,
    "policy_accuracy": <0-10>
  },
  "total_score": <sum of all 4 scores>,
  "failure_modes": ["<specific thing that went wrong>", ...],
  "standout_moments": ["<specific thing the HR agent did well>", ...],
  "trajectory_quality": "<high/medium/low>"
}

trajectory_quality rules:
- "high" if total_score >= 30
- "medium" if total_score >= 20
- "low" if total_score < 20"""


def get_judge_agent() -> Agent:
    """Create and return a judge agent instance."""
    agent = Agent(
        model=Claude(id="claude-sonnet-4-6"),
        description="Conversation quality evaluator for HR onboarding simulations",
        instructions=[JUDGE_SYSTEM_PROMPT],
        markdown=False,
    )
    return agent


def evaluate_conversation(
    session_id: str,
    user_profile: str,
    hidden_goal: str,
    transcript: list[dict],
) -> dict:
    """
    Evaluate a completed conversation and return structured scores.

    Args:
        session_id: Unique session identifier
        user_profile: The user's profile type
        hidden_goal: What the user was trying to accomplish
        transcript: List of {speaker, message} dicts

    Returns:
        Parsed JSON evaluation dict
    """
    judge = get_judge_agent()

    # Format the transcript for the judge
    formatted_transcript = "\n".join(
        f"[{turn['speaker'].upper()}]: {turn['message']}"
        for turn in transcript
    )

    prompt = f"""Please evaluate this HR onboarding conversation.

SESSION ID: {session_id}
USER PROFILE: {user_profile}
HIDDEN GOAL: {hidden_goal}

TRANSCRIPT:
{formatted_transcript}

Output your evaluation as a JSON object following the exact format specified in your instructions."""

    response = judge.run(prompt)
    response_text = response.content if response.content else ""

    # Extract JSON from response
    json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
    if json_match:
        try:
            result = json.loads(json_match.group())
            # Ensure required fields exist
            if "session_id" not in result:
                result["session_id"] = session_id
            if "user_profile" not in result:
                result["user_profile"] = user_profile
            # Ensure trajectory_quality is set correctly
            total = result.get("total_score", 0)
            if total >= 30:
                result["trajectory_quality"] = "high"
            elif total >= 20:
                result["trajectory_quality"] = "medium"
            else:
                result["trajectory_quality"] = "low"
            return result
        except json.JSONDecodeError:
            pass

    # Fallback if JSON parsing fails
    return {
        "session_id": session_id,
        "user_profile": user_profile,
        "hidden_goal_achieved": False,
        "goal_achievement_explanation": "Evaluation parsing failed",
        "scores": {
            "resolution": 0,
            "clarity": 0,
            "handling_difficulty": 0,
            "policy_accuracy": 0,
        },
        "total_score": 0,
        "failure_modes": ["Judge evaluation parsing failed"],
        "standout_moments": [],
        "trajectory_quality": "low",
    }
