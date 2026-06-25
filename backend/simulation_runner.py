"""
SimulationRunner — orchestrates a full conversation between the synthetic user
and the HR agent, then passes the transcript to the judge for scoring.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uuid
from datetime import datetime

from agents.user_agent import get_user_agent
from agents.hr_agent import get_hr_agent
from agents.judge_agent import evaluate_conversation
from database import init_db, save_session, save_turn, save_evaluation

CONVERSATION_COMPLETE_TOKEN = "[CONVERSATION_COMPLETE]"
MAX_TURNS_PER_SIDE = 10  # Each side gets max 10 turns = 20 total


class SimulationRunner:
    """
    Runs a full simulation session between a synthetic user and the HR agent.

    Args:
        user_profile: One of 'confused_novice', 'impatient_expert', 'adversarial_user'
        hidden_goal: The goal the user is trying to accomplish
        verbose: If True, print conversation turns to stdout
    """

    def __init__(self, user_profile: str, hidden_goal: str, verbose: bool = True):
        self.user_profile = user_profile
        self.hidden_goal = hidden_goal
        self.verbose = verbose
        self.session_id = str(uuid.uuid4())
        self.transcript: list[dict] = []
        self.turn_number = 0

        # Ensure DB is initialized
        init_db()

    def _log(self, msg: str) -> None:
        if self.verbose:
            print(msg)

    def _add_turn(self, speaker: str, message: str) -> None:
        """Record a turn in the transcript and DB."""
        self.turn_number += 1
        entry = {
            "turn_number": self.turn_number,
            "speaker": speaker,
            "message": message,
        }
        self.transcript.append(entry)
        save_turn(self.session_id, self.turn_number, speaker, message)

    def run(self) -> dict:
        """
        Execute the full simulation.

        Returns:
            Dict with session_id, transcript, and evaluation.
        """
        self._log(f"\n{'='*60}")
        self._log(f"SIMULATION START")
        self._log(f"Session ID : {self.session_id}")
        self._log(f"Profile    : {self.user_profile}")
        self._log(f"Goal       : {self.hidden_goal}")
        self._log(f"{'='*60}\n")

        # Persist session metadata
        save_session(self.session_id, self.user_profile, self.hidden_goal)

        # Instantiate agents fresh for this session
        user_agent = get_user_agent(self.user_profile, self.hidden_goal)
        hr_agent = get_hr_agent()

        conversation_complete = False
        user_turn_count = 0
        hr_turn_count = 0

        # ── Main conversation loop ─────────────────────────────────────────
        while user_turn_count < MAX_TURNS_PER_SIDE and hr_turn_count < MAX_TURNS_PER_SIDE:

            # ── User turn ──────────────────────────────────────────────────
            if user_turn_count == 0:
                # First user message — prompt them to start
                user_prompt = (
                    "Start the conversation. Introduce yourself briefly and ask your first question "
                    "related to what you want to find out."
                )
            else:
                # User reacts to the last HR message
                last_hr_msg = self.transcript[-1]["message"]
                user_prompt = last_hr_msg

            try:
                user_response = user_agent.run(user_prompt)
                user_message = user_response.content if user_response.content else ""
            except Exception as e:
                self._log(f"[ERROR] User agent failed: {e}")
                break

            user_turn_count += 1

            # Strip the completion token from the stored message but detect it
            clean_user_message = user_message.replace(CONVERSATION_COMPLETE_TOKEN, "").strip()
            if CONVERSATION_COMPLETE_TOKEN in user_message:
                conversation_complete = True

            self._add_turn("user", clean_user_message)
            self._log(f"[USER ({self.user_profile})]: {clean_user_message}\n")

            if conversation_complete:
                self._log("[CONVERSATION_COMPLETE token detected — ending conversation]")
                break

            # ── HR Agent turn ──────────────────────────────────────────────
            try:
                hr_response = hr_agent.run(clean_user_message)
                hr_message = hr_response.content if hr_response.content else ""
            except Exception as e:
                self._log(f"[ERROR] HR agent failed: {e}")
                break

            hr_turn_count += 1
            self._add_turn("agent", hr_message)
            self._log(f"[HR AGENT]: {hr_message}\n")

        # ── Judge evaluation ───────────────────────────────────────────────
        self._log(f"\n{'─'*60}")
        self._log("Running judge evaluation...")

        evaluation = evaluate_conversation(
            session_id=self.session_id,
            user_profile=self.user_profile,
            hidden_goal=self.hidden_goal,
            transcript=self.transcript,
        )

        save_evaluation(self.session_id, evaluation)

        self._log(f"\nJUDGE RESULTS:")
        self._log(f"  Total Score       : {evaluation.get('total_score', 0)}/40")
        self._log(f"  Trajectory Quality: {evaluation.get('trajectory_quality', 'unknown')}")
        self._log(f"  Goal Achieved     : {evaluation.get('hidden_goal_achieved', False)}")
        self._log(f"  Failure Modes     : {evaluation.get('failure_modes', [])}")
        self._log(f"{'='*60}\n")

        return {
            "session_id": self.session_id,
            "user_profile": self.user_profile,
            "hidden_goal": self.hidden_goal,
            "turn_count": self.turn_number,
            "conversation_complete": conversation_complete,
            "transcript": self.transcript,
            "evaluation": evaluation,
        }
