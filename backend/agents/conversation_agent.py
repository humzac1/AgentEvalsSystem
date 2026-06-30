"""
conversation_agent.py — No-tools Agno agent for conversation experiment sessions.

The system prompt is accepted as a plain string (already resolved by the caller)
and passed directly as the Agno Agent `description` field so the model receives
it as close to verbatim as Agno allows, without wrapping or hardcoded prefixes.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pathlib import Path
from typing import Union

from agno.agent import Agent
from agno.models.anthropic import Claude
from agno.db.in_memory.in_memory_db import InMemoryDb

from database import search_documents


def get_conversation_agent(
    prompt_text: str,
    db_path: Union[str, Path, None] = None,
) -> Agent:
    """Create and return a fresh conversation agent instance.

    Args:
        prompt_text: The fully-resolved system prompt to use (loaded from DB
                     or overridden by the caller before passing in).
        db_path: Path to the agent's SQLite database for knowledge base lookups.
    """
    _db_path = db_path

    def lookup_hr_info(topic: str) -> str:
        """Look up policy and procedure information from the agent's knowledge base.

        Use this tool whenever a user asks about company policies, procedures, or
        processes that may be documented in the knowledge base.

        Args:
            topic: The topic or question to look up. Be descriptive (e.g.,
                   'direct deposit setup', 'PTO accrual policy', 'health insurance').

        Returns:
            Relevant information from the knowledge base, or a not-found message.
        """
        return search_documents(topic, db_path=_db_path)

    agent = Agent(
        model=Claude(id="claude-sonnet-4-6"),
        description=prompt_text,
        instructions=[],
        tools=[lookup_hr_info],
        markdown=False,
        db=InMemoryDb(),
        add_history_to_context=True,
        num_history_runs=20,
    )
    return agent
