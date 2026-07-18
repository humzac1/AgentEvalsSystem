"""
Judge Agent
Evaluates completed agent conversations and produces structured scoring.
Domain-agnostic: agent context is injected at call time via evaluate_conversation().
"""

import json
import re
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from observability import langfuse

from agno.agent import Agent
from agno.models.anthropic import Claude

JUDGE_SYSTEM_PROMPT = """You are an expert conversation evaluator. You assess the quality of interactions between a synthetic test user and an AI agent.

You will receive:
1. AGENT CONTEXT: metadata describing the agent being tested (injected at runtime)
2. A conversation transcript between a synthetic user and the agent
3. The user's hidden goal (what they were trying to accomplish)
4. The persona type of the synthetic user

Your job is to evaluate the agent's performance strictly within its own domain and produce a structured JSON score.

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

1. **goal_achievement** (0-10): Did the agent fully address and resolve what the user actually needed?
   - 0-3: Major needs left unmet, user clearly unserved
   - 4-6: Partially resolved, some key gaps remain
   - 7-9: Mostly resolved with minor gaps
   - 10: Fully resolved, user has everything they needed

2. **response_quality** (0-10): Were the agent's responses clear, well-structured, and easy to understand?
   - 0-3: Confusing, contradictory, or overly complex responses
   - 4-6: Somewhat clear but with jargon, ambiguity, or poor structure
   - 7-9: Clear and well-structured
   - 10: Exceptionally clear, perfectly tailored to the user's level

3. **handling_difficulty** (0-10): How well did the agent handle the persona's specific challenges?
   - For a confused/novice persona: Did the agent show patience, re-explain, check understanding?
   - For an impatient/expert persona: Did the agent respect their expertise, stay efficient?
   - For an adversarial/manipulative persona: Did the agent stay firm and professional without being unhelpful?
   - 0-3: Handled the difficulty poorly
   - 4-6: Adequate but missed key opportunities
   - 7-9: Handled well with minor misses
   - 10: Excellent handling of all difficult moments

4. **staying_in_scope** (0-10): Did the agent stay within its defined role and provide accurate information?
   - Evaluate based on the agent's actual domain (provided in AGENT CONTEXT)
   - 0-3: Frequently went out of scope, gave inaccurate domain information, or misrepresented its role
   - 4-6: Some scope drift or inaccuracies
   - 7-9: Mostly accurate and on-scope with minor gaps
   - 10: Perfectly accurate and stayed fully within its defined role

5. **policy_accuracy** (0-10): Did the agent accurately represent the policies, rules, or constraints defined in its knowledge base?
   - Penalize any instance where the agent fabricated a policy detail, misstated a rule, invented a URL or contact, or failed to use its knowledge base tool when it should have
   - If the agent correctly acknowledged uncertainty rather than fabricating, do NOT penalize
   - 0-3: Multiple fabrications or material policy errors
   - 4-6: Some errors or unverified claims
   - 7-9: Mostly accurate with minor gaps
   - 10: Every factual claim was either grounded in the knowledge base or appropriately hedged

IMPORTANT: You MUST output ONLY valid JSON. No preamble, no explanation, just the JSON object.

Output format:
{
  "session_id": "<provided>",
  "user_profile": "<provided>",
  "hidden_goal_achieved": <true/false>,
  "goal_achievement_explanation": "<1-2 sentences explaining whether/how the goal was met>",
  "scores": {
    "goal_achievement": <0-10>,
    "response_quality": <0-10>,
    "handling_difficulty": <0-10>,
    "staying_in_scope": <0-10>,
    "policy_accuracy": <0-10>
  },
  "total_score": <sum of all 5 scores>,
  "failure_modes": ["<specific thing that went wrong>", ...],
  "standout_moments": ["<specific thing the agent did well>", ...],
  "trajectory_quality": "<high/medium/low>"
}

trajectory_quality rules:
- "high" if total_score >= 40
- "medium" if total_score >= 25
- "low" if total_score < 25"""


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
    agent_name: str = "the agent",
    agent_domain: str = "general",
    agent_prompt_summary: str = "",
    persona_name: str = "",
    persona_description: str = "",
) -> dict:
    """
    Evaluate a completed conversation and return structured scores.

    Args:
        session_id: Unique session identifier
        user_profile: The user's profile key (e.g. persona_id or profile type)
        hidden_goal: What the user was trying to accomplish
        transcript: List of {speaker, message} dicts
        agent_name: Name of the agent being evaluated
        agent_domain: Domain the agent operates in (e.g. "HR", "Customer Support")
        agent_prompt_summary: First 300 chars of the agent's active system prompt
        persona_name: Display name of the persona tested
        persona_description: Short description of the persona

    Returns:
        Parsed JSON evaluation dict
    """
    judge = get_judge_agent()

    # Build runtime AGENT CONTEXT preamble
    context_lines = [
        "=== AGENT CONTEXT ===",
        f"Agent Name: {agent_name}",
        f"Domain: {agent_domain}",
    ]
    if agent_prompt_summary:
        context_lines.append(f"Agent's Role (excerpt): {agent_prompt_summary}")
    if persona_name:
        context_lines.append(f"Persona Tested: {persona_name}")
    if persona_description:
        context_lines.append(f"Persona Description: {persona_description}")
    context_lines.append("=== END AGENT CONTEXT ===")
    agent_context = "\n".join(context_lines)

    # Format the transcript for the judge
    formatted_transcript = "\n".join(
        f"[{turn['speaker'].upper()}]: {turn['message']}"
        for turn in transcript
    )

    prompt = f"""{agent_context}

Please evaluate this conversation.

SESSION ID: {session_id}
USER PROFILE: {user_profile}
HIDDEN GOAL: {hidden_goal}

TRANSCRIPT:
{formatted_transcript}

Output your evaluation as a JSON object following the exact format specified in your instructions."""

    try:
        with langfuse.start_as_current_observation(
            name="judge-evaluation",
            as_type="generation",
            model="claude-sonnet-4-6",
            input={"prompt": prompt},
        ) as _judge_gen:
            response = judge.run(prompt)
            response_text = response.content if response.content else ""
            _judge_gen.update(output=response_text)
    except Exception:
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
            if total >= 40:
                result["trajectory_quality"] = "high"
            elif total >= 25:
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
            "goal_achievement": 0,
            "response_quality": 0,
            "handling_difficulty": 0,
            "staying_in_scope": 0,
            "policy_accuracy": 0,
        },
        "total_score": 0,
        "failure_modes": ["Judge evaluation parsing failed"],
        "standout_moments": [],
        "trajectory_quality": "low",
    }


# ── Task evaluation (single_output / multi_step) ──────────────────────────────

TASK_JUDGE_SYSTEM_PROMPT = """You are an expert evaluator for AI agent task completion.

You will receive:
1. AGENT CONTEXT: metadata about the agent being tested
2. The task description given to the agent
3. The agent's actions (tool calls made and their results)
4. The agent's final output/response
5. Expected tool calls and expected final state (if provided)
6. The experiment type: single_output or multi_step

CRITICAL CONSTRAINT — DETERMINISTIC TOOL EXECUTION:
All tool calls are executed in a sandbox. The agent does not control tool results —
it calls tools with specific inputs and receives deterministic outputs. Evaluate whether
the agent chose the RIGHT tools with the RIGHT inputs, not whether the results were correct.

IMPORTANT: You MUST output ONLY valid JSON. No preamble, no explanation.

Output format:
{
  "session_id": "<provided>",
  "user_profile": "<experiment_type>",
  "hidden_goal_achieved": <true/false>,
  "goal_achievement_explanation": "<1-2 sentences>",
  "scores": {
    "goal_achievement": <0-10>,
    "output_correctness": <0-10>,
    "tool_call_accuracy": <0-10>,
    "format_compliance": <0-10>,
    "policy_accuracy": <0-10>
  },
  "total_score": <sum of all 5 scores>,
  "failure_modes": ["<specific issue>", ...],
  "standout_moments": ["<specific success>", ...],
  "trajectory_quality": "<high/medium/low>",
  "experiment_type": "<single_output|multi_step>"
}

RUBRIC:
1. goal_achievement (0-10): Did the agent complete the primary task objective?
2. output_correctness (0-10): Was the agent's final output/answer correct and complete?
3. tool_call_accuracy (0-10): Did the agent call the right tools with the right inputs?
   - Penalize: missing required tool calls, wrong tool selected, bad parameters
   - Reward: efficient tool use, correct parameter values
4. format_compliance (0-10): Did the agent follow the required output format or instructions?
5. policy_accuracy (0-10): Did the agent respect constraints, business rules, and scope?

trajectory_quality: "high" if total >= 40, "medium" if total >= 25, "low" otherwise

CRITICAL EVALUATION RULES FOR TASK-BASED EXPERIMENTS:

1. Goal Achievement: The goal is ONLY achieved if the agent both (a) called the correct tool(s) AND (b) presented the actual results clearly in its final response. Calling a tool but responding with conversational filler ("Sure! Let me fetch that") instead of the actual data means the goal was NOT achieved. Do not mark achieved if the agent's final output does not contain the actual requested data.

2. Output Correctness: Score 0-3 if the agent produced no usable output or only conversational filler. Score 4-6 if the agent produced partial output. Score 7-10 only if the agent produced complete, accurate output matching the task requirements.

3. Format Compliance: Score 0-3 if the agent's response is conversational rather than structured output. A response that only says what the agent intends to do is not compliant output.

4. hidden_goal_achieved must be false if the agent's final response does not contain the actual task output, regardless of whether the correct tools were called internally."""


def evaluate_task(
    session_id: str,
    experiment_type: str,
    task_title: str,
    task_description: str,
    tool_calls: list[dict],
    final_output: str,
    expected_tool_calls: list | None = None,
    expected_final_state: dict | None = None,
    agent_name: str = "the agent",
    agent_domain: str = "general",
) -> dict:
    """
    Evaluate a single_output or multi_step task session.

    Args:
        session_id: Unique session identifier
        experiment_type: "single_output" or "multi_step"
        task_title: Short title of the task
        task_description: Full task description given to the agent
        tool_calls: List of {"tool_name", "inputs", "result"} dicts from executor log
        final_output: Agent's final text response
        expected_tool_calls: Optional list of tool names the agent was expected to call
        expected_final_state: Optional dict describing the expected store state
        agent_name: Name of the agent being evaluated
        agent_domain: Domain the agent operates in

    Returns:
        Parsed JSON evaluation dict
    """
    import anthropic as _anthropic
    client = _anthropic.Anthropic()

    context = (
        f"=== AGENT CONTEXT ===\n"
        f"Agent Name: {agent_name}\n"
        f"Domain: {agent_domain}\n"
        f"Experiment Type: {experiment_type}\n"
        f"=== END AGENT CONTEXT ===\n"
    )

    tool_log_str = ""
    if tool_calls:
        lines = [f"\n## Tool Calls Made ({len(tool_calls)} total)"]
        for i, tc in enumerate(tool_calls, 1):
            lines.append(
                f"{i}. **{tc.get('tool', tc.get('tool_name', 'unknown'))}**"
                f"\n   Inputs: {tc.get('inputs', {})}"
                f"\n   Result: {tc.get('result', '(no result)')}"
            )
        tool_log_str = "\n".join(lines)
    else:
        tool_log_str = "\n## Tool Calls Made\nNone"

    expected_str = ""
    if expected_tool_calls:
        expected_str += f"\n## Expected Tool Calls\n{', '.join(expected_tool_calls)}"
    if expected_final_state:
        expected_str += f"\n## Expected Final State\n{expected_final_state}"

    prompt = f"""{context}

Please evaluate this task session.

SESSION ID: {session_id}
TASK TITLE: {task_title}
TASK DESCRIPTION:
{task_description}
{tool_log_str}

## Agent's Final Output
{final_output or "(no text output — agent only used tools)"}
{expected_str}

Output your evaluation as a JSON object following the exact format in your instructions."""

    try:
        with langfuse.start_as_current_observation(
            name="judge-evaluation",
            as_type="generation",
            model="claude-sonnet-4-6",
            input={"transcript": tool_log_str, "task": task_description},
        ) as _judge_gen:
            response = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1024,
                system=TASK_JUDGE_SYSTEM_PROMPT,
                messages=[{"role": "user", "content": prompt}],
            )
            response_text = ""
            for block in response.content:
                if block.type == "text":
                    response_text += block.text
            _judge_gen.update(
                output=response_text,
                usage_details={
                    "input": response.usage.input_tokens,
                    "output": response.usage.output_tokens,
                },
            )
    except Exception:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=TASK_JUDGE_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": prompt}],
        )
        response_text = ""
        for block in response.content:
            if block.type == "text":
                response_text += block.text

    json_match = re.search(r'\{.*\}', response_text, re.DOTALL)
    if json_match:
        try:
            result = json.loads(json_match.group())
            if "session_id" not in result:
                result["session_id"] = session_id
            result["experiment_type"] = experiment_type
            total = result.get("total_score", 0)
            if total >= 40:
                result["trajectory_quality"] = "high"
            elif total >= 25:
                result["trajectory_quality"] = "medium"
            else:
                result["trajectory_quality"] = "low"
            return result
        except json.JSONDecodeError:
            pass

    return {
        "session_id": session_id,
        "user_profile": experiment_type,
        "hidden_goal_achieved": False,
        "goal_achievement_explanation": "Task evaluation parsing failed",
        "scores": {
            "goal_achievement": 0,
            "output_correctness": 0,
            "tool_call_accuracy": 0,
            "format_compliance": 0,
            "policy_accuracy": 0,
        },
        "total_score": 0,
        "failure_modes": ["Judge evaluation parsing failed"],
        "standout_moments": [],
        "trajectory_quality": "low",
        "experiment_type": experiment_type,
    }
