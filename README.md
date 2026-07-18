# Agent Simulation Lab HR Onboarding Edition

Simulations with evaluations.

Describe a agent in a "create a agent workspace" (can have tools), and run simulations based off of your current system prompt and tooling of whatever agent you want. Then agent is evaluated by a judge on certain metrics (need to be fixed to binary not scale). You can then attempt to use a prompt optimizer thats benchmarked against current prompts results. Also can evaluate current issues with agents performance through open and axial coding (a social science concept) to cluster errors.

## Stack

- **Agent orchestration**: [Agno](https://github.com/agno-agi/agno)
- **LLM**: `claude-sonnet-4-6` (all three agents)
- **Backend**: FastAPI + SQLite
- **Frontend**: React + Vite + Tailwind + Recharts


## Setup

### Prerequisites
- Python 3.11+
- Node.js 18+
- An Anthropic API key

### 1. Environment

create env file with this:

ANTHROPIC_API_KEY=

LANGFUSE_SECRET_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_BASE_URL=
LANGFUSE_PROJECT_ID=


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


