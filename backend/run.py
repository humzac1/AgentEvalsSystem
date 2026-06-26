"""
run.py — single entry point for the Agent Sim Lab.

Full loop per iteration:
  1. Run eval batch (N sessions) with current prompt
  2. Judge scores each session
  3. Meta-agent rewrites the prompt based on failure modes
  4. Run challenger batch (N sessions) with the new prompt
  5. Keep new prompt if avg score improved, revert otherwise
  6. Record version + both batches in the dashboard

Usage:
    cd backend
    python run.py                         # 1 iteration, 3 sessions/batch
    python run.py --sessions 6            # 6 sessions per batch
    python run.py --iterations 3          # 3 full optimization loops
    python run.py --sessions 6 --iterations 3
    python run.py --difficulty 3          # harder synthetic users (1-5)
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import argparse
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from database import init_db
from optimizer import PromptOptimizer


def main():
    parser = argparse.ArgumentParser(
        description="Run the Agent Sim Lab optimization loop",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--sessions",
        type=int,
        default=3,
        metavar="N",
        help="Sessions per batch — split evenly across 3 profiles (default: 3)",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=1,
        metavar="N",
        help="Number of full eval→propose→challenge→compare cycles (default: 1)",
    )
    parser.add_argument(
        "--difficulty",
        type=int,
        default=1,
        choices=[1, 2, 3, 4, 5],
        help="Synthetic user difficulty 1–5 (default: 1)",
    )
    args = parser.parse_args()

    init_db()
    optimizer = PromptOptimizer(verbose=True)
    optimizer.run(
        iterations=args.iterations,
        sessions_per_batch=args.sessions,
        difficulty=args.difficulty,
    )


if __name__ == "__main__":
    main()
