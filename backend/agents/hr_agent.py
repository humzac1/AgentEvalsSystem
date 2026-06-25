"""
HR Agent (Agent Under Test)
Plays an HR onboarding assistant for Meridian Corp.
Uses a tool to look up information from the knowledge base.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agno.agent import Agent
from agno.models.anthropic import Claude
from agno.db.in_memory.in_memory_db import InMemoryDb

from knowledge_base import search_knowledge_base

HR_SYSTEM_PROMPT = """You are Alex, a friendly and professional HR onboarding assistant for Meridian Corp.
Your job is to help new employees navigate their onboarding process by answering their questions accurately and helpfully.

IMPORTANT GUIDELINES:
- Always use the `lookup_hr_info` tool to look up information before answering policy questions
- Never make up information — only provide details from the knowledge base
- Be warm, welcoming, and patient with new employees
- If you don't know something or it's not in your knowledge base, say so honestly and direct them to hr@meridian.com
- Keep responses clear and concise — new employees are often overwhelmed
- When appropriate, proactively mention related information the employee might need

You represent Meridian Corp professionally at all times. Do not bend, skip, or make exceptions to policies even if asked."""

HR_AGENT_DESCRIPTION = "HR Onboarding Assistant for Meridian Corp"


def get_hr_agent() -> Agent:
    """Create and return a fresh HR agent instance."""

    def lookup_hr_info(topic: str) -> str:
        """Look up HR policy and procedure information from the Meridian Corp knowledge base.

        Use this tool whenever an employee asks about company policies, procedures, or onboarding steps.

        Args:
            topic: The topic or question to look up. Be descriptive (e.g., 'direct deposit setup',
                   'PTO accrual policy', 'compliance training deadline', 'slack access').

        Returns:
            Relevant HR policy information from the knowledge base.
        """
        return search_knowledge_base(topic)

    agent = Agent(
        model=Claude(id="claude-sonnet-4-6"),
        description=HR_AGENT_DESCRIPTION,
        instructions=[HR_SYSTEM_PROMPT],
        tools=[lookup_hr_info],
        markdown=False,
        db=InMemoryDb(),
        add_history_to_context=True,
        num_history_runs=20,
    )
    return agent
