"""
SimulationRunner — orchestrates a full simulation session and judges it.

Supports three experiment types:
  conversation  — multi-turn dialogue between user agent and HR/agent (existing behaviour)
  single_output — agent receives one task, may call tools, judge evaluates output
  multi_step    — agent receives complex task, runs tool loop until [TASK_COMPLETE]
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uuid
from pathlib import Path
from typing import Union

from agents.user_agent import get_user_agent
from agents.conversation_agent import get_conversation_agent
from agents.judge_agent import evaluate_conversation, evaluate_task
from agents.agent_under_test import run_task_session, get_single_agent_reply
from database import (
    init_db, save_session, save_turn, save_evaluation,
    get_active_prompt, get_all_tools, get_all_seed_data,
    log_tool_call, update_session_trace_url,
)
from observability import langfuse
from langfuse import propagate_attributes
from langfuse.types import TraceContext

CONVERSATION_COMPLETE_TOKEN = "[CONVERSATION_COMPLETE]"
MAX_TURNS_PER_SIDE = 10  # Each side gets max 10 turns = 20 total


class SimulationRunner:
    """
    Runs a full simulation session.

    Args:
        user_profile: Profile key or experiment_type label
        hidden_goal: The goal / task description
        verbose: If True, print progress to stdout
        difficulty: 1–5 difficulty rating for the synthetic user (conversation only)
        batch_id: ID of the batch this simulation belongs to
        prompt_version_id: ID of the prompt version used for the agent
        prompt_override: If set, use this prompt text instead of DB lookup
        db_path: Path to the agent's SQLite database
        agent_name: Display name of the agent being tested
        agent_domain: Domain the agent operates in
        persona_name: Display name of the persona tested
        persona_description: Short description of the persona
        experiment_type: "conversation" | "single_output" | "multi_step"
        task_id: ID of the task (for non-conversation types)
        task_title: Short title of the task
        expected_tool_calls: Expected tool names (for evaluation)
        expected_final_state: Expected store state dict (for evaluation)
    """

    def __init__(
        self,
        user_profile: str,
        hidden_goal: str,
        verbose: bool = True,
        difficulty: int = 1,
        batch_id: str | None = None,
        prompt_version_id: int | None = None,
        prompt_override: str | None = None,
        db_path: Union[str, Path, None] = None,
        agent_name: str = "the agent",
        agent_domain: str = "general",
        persona_name: str = "",
        persona_description: str = "",
        experiment_type: str = "conversation",
        task_id: str | None = None,
        task_title: str = "",
        expected_tool_calls: list | None = None,
        expected_final_state: dict | None = None,
        batch_role: str | None = None,
    ):
        self.user_profile = user_profile
        self.hidden_goal = hidden_goal
        self.verbose = verbose
        self.difficulty = difficulty
        self.batch_id = batch_id
        self.prompt_version_id = prompt_version_id
        self.prompt_override = prompt_override
        self.db_path = db_path
        self.agent_name = agent_name
        self.agent_domain = agent_domain
        self.persona_name = persona_name
        self.persona_description = persona_description
        self.experiment_type = experiment_type
        self.task_id = task_id
        self.task_title = task_title
        self.expected_tool_calls = expected_tool_calls or []
        self.expected_final_state = expected_final_state or {}
        self.batch_role = batch_role
        self.session_id = str(uuid.uuid4())
        self.transcript: list[dict] = []
        self.turn_number = 0

        # Ensure DB is initialized
        init_db(db_path=self.db_path)

    def _log(self, msg: str) -> None:
        if self.verbose:
            print(msg)

    def _add_turn(self, speaker: str, message: str) -> None:
        """Record a turn in the transcript and DB."""
        self.turn_number += 1
        entry = {"turn_number": self.turn_number, "speaker": speaker, "message": message}
        self.transcript.append(entry)
        save_turn(self.session_id, self.turn_number, speaker, message, db_path=self.db_path)

    def _get_prompt(self) -> str:
        """Resolve the active system prompt text."""
        if self.prompt_override:
            return self.prompt_override
        active = get_active_prompt(db_path=self.db_path)
        return active["prompt_text"] if active else ""

    def _build_executor(self):
        """Build a SandboxExecutor if the agent has tools, else return None."""
        from sandbox.executor import SandboxExecutor
        tools = get_all_tools(db_path=self.db_path)
        if not tools:
            return None
        seed_data = get_all_seed_data(db_path=self.db_path)
        return SandboxExecutor(tools=tools, seed_data=seed_data)

    def run(self) -> dict:
        """Execute the simulation and return results."""
        self._log(f"\n{'='*60}")
        self._log(f"SIMULATION START [{self.experiment_type.upper()}]")
        self._log(f"Session ID : {self.session_id}")
        self._log(f"Profile    : {self.user_profile}")
        if self.experiment_type == "conversation":
            self._log(f"Difficulty : {self.difficulty}")
        self._log(f"Goal/Task  : {self.hidden_goal[:80]}")
        self._log(f"{'='*60}\n")

        # ── Langfuse trace setup ──────────────────────────────────────
        trace_id = langfuse.create_trace_id(seed=self.session_id)
        base_url = os.getenv("LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com").rstrip("/")
        project_id = os.getenv("LANGFUSE_PROJECT_ID", "")
        trace_url = f"{base_url}/project/{project_id}/traces/{trace_id}"

        active_prompt = get_active_prompt(db_path=self.db_path)
        prompt_version_num = active_prompt.get("version_number") if active_prompt else None

        save_session(
            self.session_id,
            self.user_profile,
            self.hidden_goal,
            difficulty=self.difficulty,
            batch_id=self.batch_id,
            prompt_version_id=self.prompt_version_id,
            experiment_type=self.experiment_type,
            task_id=self.task_id,
            batch_role=self.batch_role,
            db_path=self.db_path,
        )

        try:
            update_session_trace_url(self.session_id, trace_url, db_path=self.db_path)
        except Exception:
            pass

        result = {}
        try:
            with langfuse.start_as_current_observation(
                name="simulation-session",
                as_type="span",
                trace_context=TraceContext(trace_id=trace_id),
                metadata={
                    "agent_name": self.agent_name,
                    "experiment_type": self.experiment_type,
                    "persona": self.persona_name,
                    "difficulty": self.difficulty,
                    "task_title": self.task_title or None,
                    "prompt_version": prompt_version_num,
                },
            ) as root_span:
                with propagate_attributes(session_id=self.session_id):
                    if self.experiment_type == "conversation":
                        result = self._run_conversation()
                    else:
                        result = self._run_task()

                evaluation = result.get("evaluation", {})
                root_span.update(output={
                    "final_score": evaluation.get("total_score", 0),
                    "trajectory_quality": evaluation.get("trajectory_quality", "low"),
                })
        except Exception as _e:
            self._log(f"[WARNING] Langfuse tracing error: {_e}")
            if not result:
                if self.experiment_type == "conversation":
                    result = self._run_conversation()
                else:
                    result = self._run_task()

        # ── Log scores to Langfuse ────────────────────────────────────
        evaluation = result.get("evaluation", {})
        try:
            for dim, val in evaluation.get("scores", {}).items():
                if val is not None:
                    langfuse.create_score(trace_id=trace_id, name=dim, value=float(val), data_type="NUMERIC")
            total = evaluation.get("total_score", 0)
            langfuse.create_score(trace_id=trace_id, name="total_score", value=float(total), data_type="NUMERIC")
            goal_achieved = 1 if evaluation.get("hidden_goal_achieved") else 0
            langfuse.create_score(trace_id=trace_id, name="goal_achieved", value=float(goal_achieved), data_type="NUMERIC")
        except Exception:
            pass

        try:
            langfuse.flush()
        except Exception:
            pass

        return result

    # ── Conversation experiment ────────────────────────────────────────────────

    def _run_conversation(self) -> dict:
        prompt_text = self._get_prompt()
        executor = self._build_executor()

        user_agent = get_user_agent(
            self.user_profile,
            self.hidden_goal,
            difficulty=self.difficulty,
            db_path=self.db_path,
        )

        # Use executor-aware agent if tools exist, otherwise Agno conversation agent
        if executor:
            hr_reply_fn = lambda msg, hist: self._agent_with_tools_reply(
                prompt_text, msg, hist, executor
            )
            history: list[dict] = []
        else:
            conv_agent = get_conversation_agent(prompt_text, db_path=self.db_path)
            hr_reply_fn = lambda msg, _hist: self._agno_reply(conv_agent, msg)
            history = None  # not used for Agno path

        conversation_complete = False
        user_turn_count = 0
        hr_turn_count = 0

        while user_turn_count < MAX_TURNS_PER_SIDE and hr_turn_count < MAX_TURNS_PER_SIDE:
            # ── User turn ──────────────────────────────────────────────────
            if user_turn_count == 0:
                user_prompt = (
                    "Start the conversation. Introduce yourself briefly and ask your first "
                    "question related to what you want to find out."
                )
            else:
                user_prompt = self.transcript[-1]["message"]

            user_message = ""
            try:
                with langfuse.start_as_current_observation(
                    name=f"synthetic-user-turn-{user_turn_count + 1}",
                    as_type="span",
                    input={"persona": self.persona_name or self.user_profile, "prompt": user_prompt},
                ) as _user_span:
                    user_response = user_agent.run(user_prompt)
                    user_message = user_response.content if user_response.content else ""
                    _user_span.update(output={"message": user_message})
            except Exception as e:
                self._log(f"[ERROR] User agent failed: {e}")
                break

            user_turn_count += 1
            clean_user_message = user_message.replace(CONVERSATION_COMPLETE_TOKEN, "").strip()
            if CONVERSATION_COMPLETE_TOKEN in user_message:
                conversation_complete = True

            self._add_turn("user", clean_user_message)
            self._log(f"[USER ({self.user_profile})]: {clean_user_message}\n")

            if conversation_complete:
                self._log("[CONVERSATION_COMPLETE token detected — ending conversation]")
                break

            # ── Agent turn ─────────────────────────────────────────────────
            try:
                if executor:
                    api_messages = []
                    for t in self.transcript:
                        role = "user" if t["speaker"] == "user" else "assistant"
                        api_messages.append({"role": role, "content": t["message"]})
                    hr_message, tool_calls = get_single_agent_reply(
                        system_prompt=prompt_text,
                        messages=api_messages,
                        executor=executor,
                    )
                    for tc in tool_calls:
                        log_tool_call(
                            session_id=self.session_id,
                            tool_name=tc.get("tool_name", "unknown"),
                            inputs=tc.get("inputs", {}),
                            output=str(tc.get("result", "")),
                            success=True,
                            db_path=self.db_path,
                        )
                else:
                    with langfuse.start_as_current_observation(
                        name=f"agent-turn-{hr_turn_count + 1}",
                        as_type="generation",
                        model="claude-sonnet-4-6",
                        input={"message": clean_user_message},
                    ) as _agent_gen:
                        hr_response = hr_reply_fn(clean_user_message, None)
                        hr_message = hr_response.content if hasattr(hr_response, "content") else str(hr_response)
                        _agent_gen.update(output=hr_message)
            except Exception as e:
                self._log(f"[ERROR] Agent failed: {e}")
                break

            hr_turn_count += 1
            self._add_turn("agent", hr_message)
            self._log(f"[AGENT]: {hr_message}\n")

        # ── Judge evaluation ───────────────────────────────────────────────
        self._log(f"\n{'─'*60}")
        self._log("Running judge evaluation...")

        evaluation = evaluate_conversation(
            session_id=self.session_id,
            user_profile=self.user_profile,
            hidden_goal=self.hidden_goal,
            transcript=self.transcript,
            agent_name=self.agent_name,
            agent_domain=self.agent_domain,
            agent_prompt_summary=(prompt_text or "")[:300],
            persona_name=self.persona_name,
            persona_description=self.persona_description,
        )

        save_evaluation(self.session_id, evaluation, db_path=self.db_path)

        self._log(f"\nJUDGE RESULTS:")
        self._log(f"  Total Score       : {evaluation.get('total_score', 0)}/50")
        self._log(f"  Trajectory Quality: {evaluation.get('trajectory_quality', 'unknown')}")
        self._log(f"  Goal Achieved     : {evaluation.get('hidden_goal_achieved', False)}")
        self._log(f"{'='*60}\n")

        return {
            "session_id": self.session_id,
            "user_profile": self.user_profile,
            "hidden_goal": self.hidden_goal,
            "difficulty": self.difficulty,
            "turn_count": self.turn_number,
            "conversation_complete": conversation_complete,
            "transcript": self.transcript,
            "evaluation": evaluation,
        }

    def _agno_reply(self, agent, message: str):
        return agent.run(message)

    def _agent_with_tools_reply(self, prompt: str, message: str, history, executor):
        # Not called directly; handled inline above
        pass

    # ── Task experiment (single_output / multi_step) ───────────────────────────

    _TASK_EXECUTION_INSTRUCTION = """
EXECUTION MODE: TASK COMPLETION

You are operating in automated task execution mode. A task will be given to you directly. You must:
- Execute immediately using your available tools — do not narrate what you are about to do
- Never say things like "Sure!", "Let me fetch that", "I'll look that up right away", or any conversational filler
- Call the required tool(s), receive the results, and present the complete results directly in your response
- Your response should be the actual output — the data, the result, the completed action — not a description of what you are doing
- If a task requires multiple tool calls, complete all of them before responding
- Do not ask clarifying questions — execute the task as described
- Your response is complete when you have presented the task output. Do not ask follow-up questions, offer next steps, or invite further action. End your response after the output."""

    def _run_task(self) -> dict:
        base_prompt = self._get_prompt()
        prompt_text = base_prompt + self._TASK_EXECUTION_INSTRUCTION
        executor = self._build_executor()

        result = run_task_session(
            system_prompt=prompt_text,
            task_description=self.hidden_goal,
            executor=executor,
            experiment_type=self.experiment_type,
            max_tool_calls=15,
            verbose=self.verbose,
        )

        # Persist turns
        for t in result["turns"]:
            if t["speaker"] in ("user", "agent"):
                self._add_turn(t["speaker"], t["message"])
            # "tool" turns are logged separately

        # Persist tool call logs
        for tc in result.get("tool_calls", []):
            log_tool_call(
                session_id=self.session_id,
                tool_name=tc.get("tool", "unknown"),
                inputs=tc.get("inputs", {}),
                output=str(tc.get("result", "")),
                success=True,
                db_path=self.db_path,
            )

        # ── Judge evaluation ───────────────────────────────────────────────
        self._log(f"\n{'─'*60}")
        self._log("Running task judge evaluation...")

        evaluation = evaluate_task(
            session_id=self.session_id,
            experiment_type=self.experiment_type,
            task_title=self.task_title or self.hidden_goal[:60],
            task_description=self.hidden_goal,
            tool_calls=result.get("tool_calls", []),
            final_output=result.get("final_text", ""),
            expected_tool_calls=self.expected_tool_calls,
            expected_final_state=self.expected_final_state,
            agent_name=self.agent_name,
            agent_domain=self.agent_domain,
        )
        evaluation["experiment_type"] = self.experiment_type

        save_evaluation(self.session_id, evaluation, db_path=self.db_path)

        self._log(f"\nJUDGE RESULTS:")
        self._log(f"  Total Score       : {evaluation.get('total_score', 0)}/50")
        self._log(f"  Trajectory Quality: {evaluation.get('trajectory_quality', 'unknown')}")
        self._log(f"  Goal Achieved     : {evaluation.get('hidden_goal_achieved', False)}")
        self._log(f"{'='*60}\n")

        return {
            "session_id": self.session_id,
            "user_profile": self.user_profile,
            "hidden_goal": self.hidden_goal,
            "experiment_type": self.experiment_type,
            "task_id": self.task_id,
            "turn_count": self.turn_number,
            "completed": result.get("completed", False),
            "total_tool_calls": result.get("total_tool_calls", 0),
            "transcript": self.transcript,
            "evaluation": evaluation,
        }
