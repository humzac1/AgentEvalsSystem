# Agent Simulation Lab — HR Onboarding Edition

A mini simulation lab that runs an AI agent through realistic multi-turn conversations with synthetic users, scores each conversation automatically, and logs the trajectories as training-ready data.

Inspired by Collinear AI's Simulation Lab concept.

## Architecture

```
┌─────────────────────┐     ┌──────────────────────┐
│  Synthetic User     │◄───►│  HR Agent (Under Test)│
│  (agno Agent)       │     │  (agno Agent + tools) │
└─────────────────────┘     └──────────────────────┘
         │                            │
         └──────────┬─────────────────┘
                    │ transcript
                    ▼
         ┌─────────────────────┐
         │   Judge Agent       │
         │   (agno Agent)      │
         └─────────────────────┘
                    │ structured JSON scores
                    ▼
         ┌─────────────────────┐     ┌────────────────┐
         │   SQLite DB         │◄───►│  FastAPI API   │◄───► React Frontend
         │   (simulations.db)  │     │  (api.py)      │
         └─────────────────────┘     └────────────────┘
```

## Stack

- **Agent orchestration**: [Agno](https://github.com/agno-agi/agno)
- **LLM**: `claude-sonnet-4-6` (all three agents)
- **Backend**: FastAPI + SQLite
- **Frontend**: React + Vite + Tailwind + Recharts

## Agents

### 1. Synthetic User Agent
Simulates new employees with three profiles:
- **`confused_novice`** — overwhelmed new hire, asks vague questions, needs clarification
- **`impatient_expert`** — senior lateral hire, terse, pushes back on basic answers
- **`adversarial_user`** — skeptical, questions policies, tries to bend rules

### 2. HR Agent (Agent Under Test)
Plays an HR onboarding assistant for Meridian Corp. Uses a Agno tool to look up the knowledge base (simulating RAG). Knowledge base covers: PTO, benefits, direct deposit, equipment, compliance training, and Slack access.

### 3. Judge Agent
Evaluates completed conversations on: resolution, clarity, handling difficulty, and policy accuracy (each 0–10, total 0–40). Outputs structured JSON with failure modes, standout moments, and trajectory quality (`high`/`medium`/`low`).

---

## Setup

### Prerequisites
- Python 3.11+
- Node.js 18+
- An Anthropic API key

### 1. Environment

```bash
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY
```

### 2. Python backend

```bash
cd /path/to/AgentSimLabHR

# Create and activate a virtual environment
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### 3. Frontend

```bash
cd frontend
npm install
```

---

## Running a Batch Simulation

```bash
# From the project root, with virtualenv activated:
cd backend
python run_batch.py
```

This runs one simulation per profile (3 total) with randomized hidden goals. Results are saved to `data/simulations.db`.

To run a single simulation manually:
```python
# In Python
import sys; sys.path.insert(0, "backend")
from simulation_runner import SimulationRunner

runner = SimulationRunner(
    user_profile="confused_novice",
    hidden_goal="Find out how to set up direct deposit",
    verbose=True,
)
result = runner.run()
```

---

## Starting the Frontend

You need two terminals:

**Terminal 1 — FastAPI backend:**
```bash
cd backend
uvicorn api:app --reload --port 8000
```

**Terminal 2 — React frontend:**
```bash
cd frontend
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Database Schema

**`sessions`** — one row per simulation session
| Column | Type | Notes |
|---|---|---|
| session_id | TEXT PK | UUID |
| user_profile | TEXT | confused_novice / impatient_expert / adversarial_user |
| hidden_goal | TEXT | What the user was trying to accomplish |
| timestamp | TEXT | ISO UTC |
| total_score | INTEGER | 0–40 (from judge) |
| trajectory_quality | TEXT | high / medium / low |

**`turns`** — one row per conversation turn
| Column | Type | Notes |
|---|---|---|
| turn_id | INTEGER PK | Auto |
| session_id | TEXT FK | References sessions |
| turn_number | INTEGER | Sequential |
| speaker | TEXT | user or agent |
| message | TEXT | Message content |
| timestamp | TEXT | ISO UTC |

**`evaluations`** — one row per session evaluation
| Column | Type | Notes |
|---|---|---|
| eval_id | INTEGER PK | Auto |
| session_id | TEXT FK UNIQUE | References sessions |
| judge_json | TEXT | Full judge output as JSON blob |
| hidden_goal_achieved | INTEGER | 0 or 1 |
| resolution_score | INTEGER | 0–10 |
| clarity_score | INTEGER | 0–10 |
| handling_difficulty_score | INTEGER | 0–10 |
| policy_accuracy_score | INTEGER | 0–10 |

---

## Project Structure

```
AgentSimLabHR/
├── backend/
│   ├── agents/
│   │   ├── user_agent.py       # Synthetic user (3 profiles)
│   │   ├── hr_agent.py         # HR agent under test
│   │   └── judge_agent.py      # Conversation evaluator
│   ├── knowledge_base.py       # Meridian Corp HR knowledge base
│   ├── simulation_runner.py    # Orchestrates user ↔ HR conversations
│   ├── run_batch.py            # Runs 3 simulations back-to-back
│   ├── database.py             # SQLite schema + read/write helpers
│   └── api.py                  # FastAPI routes
├── frontend/
│   ├── src/
│   │   ├── App.tsx             # Root with nav + routing
│   │   ├── components/
│   │   │   ├── SessionsList.tsx    # Sessions table view
│   │   │   ├── SessionDetail.tsx   # Chat transcript + scorecard
│   │   │   └── Analytics.tsx       # Aggregate analytics
│   │   └── index.css
│   ├── package.json
│   └── vite.config.ts
├── data/
│   └── simulations.db          # SQLite database (created on first run)
├── .env.example
├── requirements.txt
└── README.md
```

---

## Trajectory Quality

Judge scores map to training data quality tiers:
- **High** (≥30/40) — ideal for RL/DPO positive examples
- **Medium** (≥20/40) — useful with careful filtering
- **Low** (<20/40) — useful as negative examples for DPO

---

## Meridian Corp Knowledge Base

| Topic | Key Facts |
|---|---|
| PTO | 20 days/year, accrues monthly, **no rollover** |
| Benefits | 30-day enrollment window from day 1 |
| Direct Deposit | `meridian.adp.com` |
| Equipment | IT ticket at `it.meridian.com` |
| Compliance Training | 3 courses, must complete in **first 2 weeks** |
| Slack Access | IT provisions after day 1, email `it@meridian.com` |
