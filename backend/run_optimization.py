"""
run_optimization.py — CLI script to run the prompt optimization loop.

Usage:
    cd backend
    python run_optimization.py
    python run_optimization.py --iterations 5
    python run_optimization.py --iterations 3 --quiet
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import argparse
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from optimizer import PromptOptimizer


def main():
    parser = argparse.ArgumentParser(description="Run the HR prompt optimization loop")
    parser.add_argument(
        "--iterations",
        type=int,
        default=3,
        help="Number of optimize-evaluate iterations to run (default: 3)",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress verbose output",
    )
    args = parser.parse_args()

    optimizer = PromptOptimizer(verbose=not args.quiet)
    optimizer.run(iterations=args.iterations)


if __name__ == "__main__":
    main()
