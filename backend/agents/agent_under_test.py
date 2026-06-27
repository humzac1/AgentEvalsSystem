"""
agent_under_test.py — Runs the agent being tested using the Anthropic API directly.

Used when an agent has sandbox tools configured. The agent receives:
  - Its system prompt (optionally with a TOOLS AVAILABLE section appended)
  - A user message (either from the user simulator or a task description)
  - Sandbox tool definitions for structured tool calling

For conversation experiments the caller drives the multi-turn loop externally.
For single_output / multi_step experiments this module drives the tool loop
until [TASK_COMPLETE] is emitted or max_tool_calls is reached.
"""

from __future__ import annotations

import os
from typing import Any

import anthropic
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", ".env"))

_client: anthropic.Anthropic | None = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic()
    return _client


def call_agent(
    system_prompt: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    max_tokens: int = 1024,
) -> tuple[str, list[dict]]:
    """
    Send one turn to the agent and return (text_response, tool_calls).

    tool_calls is a list of {"tool_name": str, "inputs": dict} dicts.
    If the agent does not call any tools, tool_calls is empty.
    """
    client = _get_client()
    kwargs: dict[str, Any] = {
        "model": "claude-sonnet-4-6",
        "max_tokens": max_tokens,
        "system": system_prompt,
        "messages": messages,
    }
    if tools:
        kwargs["tools"] = tools

    response = client.messages.create(**kwargs)

    text_parts = []
    tool_calls = []
    raw_content = []

    for block in response.content:
        raw_content.append(block)
        if block.type == "text":
            text_parts.append(block.text)
        elif block.type == "tool_use":
            tool_calls.append({
                "tool_use_id": block.id,
                "tool_name": block.name,
                "inputs": block.input,
            })

    return "".join(text_parts), tool_calls, response.stop_reason, raw_content


def run_task_session(
    system_prompt: str,
    task_description: str,
    executor,  # SandboxExecutor
    experiment_type: str = "single_output",
    max_tool_calls: int = 15,
    verbose: bool = False,
) -> dict:
    """
    Run a full single_output or multi_step task session.

    Returns a dict with:
      - turns: list of {"speaker": "user"|"agent", "message": str}
      - tool_calls: full call log from executor
      - final_text: last agent text response
      - final_store: snapshot of the in-memory store at completion
      - completed: bool (True if agent said [TASK_COMPLETE] or single_output)
    """
    api_tools = executor.build_tools_for_anthropic() if executor else []
    tools_section = executor.format_tools_for_prompt() if executor else ""
    full_system = system_prompt + tools_section

    turns = []
    messages: list[dict] = [{"role": "user", "content": task_description}]
    turns.append({"speaker": "user", "message": task_description})

    total_tool_calls = 0
    final_text = ""
    completed = False

    while True:
        text, tool_calls, stop_reason, raw_content = call_agent(
            system_prompt=full_system,
            messages=messages,
            tools=api_tools if api_tools else None,
        )

        if verbose:
            if text:
                print(f"\n[Agent]: {text}")
            for tc in tool_calls:
                print(f"\n[Tool call]: {tc['tool_name']}({tc['inputs']})")

        final_text = text or final_text

        # Build the assistant turn for history
        assistant_content = []
        for block in raw_content:
            if block.type == "text":
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                assistant_content.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
        messages.append({"role": "assistant", "content": assistant_content})

        # Record agent turn
        if text:
            turns.append({"speaker": "agent", "message": text})

        # Execute tool calls and collect results
        if tool_calls and executor:
            tool_results = []
            for tc in tool_calls:
                total_tool_calls += 1
                result = executor.execute(tc["tool_name"], tc["inputs"])
                result_text = str(result.get("result", result.get("error", "no result")))
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": tc["tool_use_id"],
                    "content": result_text,
                })
                turns.append({
                    "speaker": "tool",
                    "message": f"{tc['tool_name']} → {result_text}",
                })
                if verbose:
                    print(f"\n[Tool result]: {result_text}")

            messages.append({"role": "user", "content": tool_results})

        # Termination conditions
        if experiment_type == "single_output":
            if not tool_calls:
                # Agent produced its final text response with no pending tool calls
                completed = True
                break
            # Tool calls were made — loop once more so the agent can see results
            # and produce its actual output (not just the "I'll fetch that" prefix)

        if "[TASK_COMPLETE]" in (text or ""):
            completed = True
            break

        if stop_reason == "end_turn" and not tool_calls:
            # Agent finished without more tool calls
            break

        if total_tool_calls >= max_tool_calls:
            if verbose:
                print(f"\n[Max tool calls ({max_tool_calls}) reached]")
            break

    return {
        "turns": turns,
        "tool_calls": executor.call_log if executor else [],
        "final_text": final_text,
        "final_store": executor.get_store_snapshot() if executor else {},
        "completed": completed,
        "total_tool_calls": total_tool_calls,
    }


def get_single_agent_reply(
    system_prompt: str,
    messages: list[dict],
    executor=None,
) -> tuple[str, list[dict]]:
    """
    Single conversation turn for the agent — used in conversation experiments
    when the agent has sandbox tools.

    Returns (text_response, tool_calls_executed).
    If tool calls are made, they are executed against the executor and the
    conversation history is updated in-place with results before returning.
    """
    api_tools = executor.build_tools_for_anthropic() if executor else []
    tools_section = executor.format_tools_for_prompt() if executor else ""
    # Find and augment system prompt (passed by reference not possible, so we
    # return it; caller is responsible for using the returned prompt)
    full_system = system_prompt + tools_section

    text, tool_calls, stop_reason, raw_content = call_agent(
        system_prompt=full_system,
        messages=messages,
        tools=api_tools if api_tools else None,
    )

    executed_calls = []

    if tool_calls and executor:
        # Build assistant message with tool_use blocks
        assistant_content = []
        for block in raw_content:
            if block.type == "text":
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                assistant_content.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
        messages.append({"role": "assistant", "content": assistant_content})

        # Execute each tool, collect results
        tool_results = []
        for tc in tool_calls:
            result = executor.execute(tc["tool_name"], tc["inputs"])
            result_text = str(result.get("result", result.get("error", "no result")))
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc["tool_use_id"],
                "content": result_text,
            })
            executed_calls.append({**tc, "result": result_text})

        messages.append({"role": "user", "content": tool_results})

        # Get final text after tool execution
        text2, _, _, _ = call_agent(
            system_prompt=full_system,
            messages=messages,
            tools=api_tools if api_tools else None,
        )
        if text2:
            text = (text + "\n" + text2).strip() if text else text2

    return text, executed_calls
