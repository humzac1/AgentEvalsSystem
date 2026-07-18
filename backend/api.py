"""
FastAPI backend — multi-agent platform API.

Route structure:
  /api/agents                                  — agent registry CRUD
  /api/agents/{agent_id}/sessions              — simulation sessions
  /api/agents/{agent_id}/analytics             — score analytics
  /api/agents/{agent_id}/batches               — experiment batches
  /api/agents/{agent_id}/prompt-versions       — prompt history
  /api/agents/{agent_id}/run-simulation        — async optimization loop
  /api/agents/{agent_id}/documents             — knowledge base documents
  /api/agents/{agent_id}/personas              — synthetic user personas
  /api/agents/{agent_id}/personas/generate    — AI-generate a persona from a description
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import json
import uuid
import threading
import io
import random
from pathlib import Path
from typing import Optional

import anthropic as _anthropic

from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))

from registry import (
    init_registry,
    register_agent,
    get_all_agents,
    get_agent,
    agent_db_path,
    update_agent_stats,
    update_agent_identity,
)
from database import (
    init_db,
    seed_initial_prompt,
    get_all_sessions,
    get_session,
    get_analytics,
    get_all_batches,
    get_all_prompt_versions,
    get_active_prompt,
    create_prompt_version,
    get_batch_sessions_summary,
    get_all_documents,
    add_document,
    delete_document,
    get_all_personas,
    add_persona,
    update_persona,
    delete_persona,
    get_session_count,
    get_avg_score,
    create_batch,
    update_batch_stats,
    # Tools
    get_all_tools,
    get_tool,
    upsert_tool,
    delete_tool,
    upsert_tool_seed_data,
    get_session_tool_calls,
    # Tasks
    get_all_tasks,
    get_task,
    upsert_task,
    delete_task,
)
from optimizer import run_optimization_iteration

app = FastAPI(title="Agent Sim Lab API", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Track in-progress runs keyed by run_id
_runs: dict[str, dict] = {}
_runs_lock = threading.Lock()


# ── Default system prompt for new agents ──────────────────────────────────────

_DEFAULT_SYSTEM_PROMPT = """You are Alex, a friendly and professional HR onboarding assistant for Meridian Corp.
Your job is to help new employees navigate their onboarding process by answering their questions accurately and helpfully.

IMPORTANT GUIDELINES:
- Always use the `lookup_hr_info` tool to look up information before answering policy questions
- Never make up information — only provide details from the knowledge base
- Be warm, welcoming, and patient with new employees
- If you don't know something or it's not in your knowledge base, say so honestly and direct them to hr@meridian.com
- Keep responses clear and concise — new employees are often overwhelmed
- When appropriate, proactively mention related information the employee might need

You represent Meridian Corp professionally at all times. Do not bend, skip, or make exceptions to policies even if asked."""


# ── Startup ────────────────────────────────────────────────────────────────────

@app.on_event("startup")
def startup_event():
    init_registry()


@app.on_event("shutdown")
async def shutdown_event():
    try:
        from observability import langfuse
        langfuse.flush()
    except Exception:
        pass


# ── Helpers ────────────────────────────────────────────────────────────────────

def _resolve_agent(agent_id: str) -> Path:
    """Return the DB path for an agent (running migrations if needed), or raise 404."""
    record = get_agent(agent_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")
    db = agent_db_path(agent_id)
    init_db(db_path=db)  # idempotent — ensures schema/columns are up to date
    return db


def _extract_text(filename: str, content: bytes, content_type: str) -> str:
    """Extract plain text from an uploaded file."""
    # PDF
    if content_type == "application/pdf" or filename.lower().endswith(".pdf"):
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(content))
            pages = [page.extract_text() or "" for page in reader.pages]
            return "\n\n".join(pages).strip()
        except ImportError:
            raise HTTPException(
                status_code=422,
                detail="PDF support requires pypdf. Run: pip install pypdf",
            )
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Could not parse PDF: {e}")

    # Plain text / markdown / code
    try:
        return content.decode("utf-8", errors="replace").strip()
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not decode file: {e}")


def _refresh_agent_stats(agent_id: str, db: Path) -> None:
    """Update the registry row with latest session count and avg score."""
    try:
        active = get_active_prompt(db_path=db)
        active_ver = str(active["version_number"]) if active else None
        update_agent_stats(
            agent_id=agent_id,
            session_count=get_session_count(db_path=db),
            avg_score=get_avg_score(db_path=db),
            active_prompt_version=active_ver,
        )
    except Exception:
        pass  # best-effort — don't break the response


# ── Agents CRUD ────────────────────────────────────────────────────────────────

@app.get("/api/agents")
def list_agents():
    agents = get_all_agents()
    # Refresh stats inline (cheap read-only queries)
    enriched = []
    for a in agents:
        db = agent_db_path(a["agent_id"])
        if db.exists():
            try:
                a["session_count"] = get_session_count(db_path=db)
                a["avg_score"] = get_avg_score(db_path=db)
                active = get_active_prompt(db_path=db)
                a["active_prompt_version"] = str(active["version_number"]) if active else None
            except Exception:
                pass
        enriched.append(a)
    return {"agents": enriched}


class CreateAgentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field(default="")
    domain: str = Field(default="")
    initial_prompt: Optional[str] = None
    experiment_types: list[str] = Field(default_factory=lambda: ["conversation"])


@app.post("/api/agents", status_code=201)
def create_agent(request: CreateAgentRequest):
    agent_id = str(uuid.uuid4())
    db = agent_db_path(agent_id)
    db.parent.mkdir(parents=True, exist_ok=True)

    # Bootstrap the per-agent DB
    init_db(db_path=db)
    seed_initial_prompt(
        prompt_text=request.initial_prompt or _DEFAULT_SYSTEM_PROMPT,
        db_path=db,
    )

    # Register in global registry
    register_agent(
        agent_id=agent_id,
        name=request.name,
        description=request.description,
        domain=request.domain,
        db_path=str(db),
        experiment_types=request.experiment_types,
    )

    return {"agent_id": agent_id, "name": request.name}


@app.get("/api/agents/{agent_id}")
def get_agent_detail(agent_id: str):
    record = get_agent(agent_id)
    if not record:
        raise HTTPException(status_code=404, detail="Agent not found")
    db = agent_db_path(agent_id)
    if db.exists():
        try:
            record["session_count"] = get_session_count(db_path=db)
            record["avg_score"] = get_avg_score(db_path=db)
            active = get_active_prompt(db_path=db)
            record["active_prompt_version"] = str(active["version_number"]) if active else None
        except Exception:
            pass
    return record


@app.get("/api/agents/{agent_id}/config")
def get_agent_config(agent_id: str):
    """Return full agent config: identity + active prompt + documents + personas + tools + tasks."""
    record = get_agent(agent_id)
    if not record:
        raise HTTPException(status_code=404, detail="Agent not found")
    db = _resolve_agent(agent_id)
    active = get_active_prompt(db_path=db)
    return {
        "agent_id": record["agent_id"],
        "name": record["name"],
        "description": record["description"],
        "domain": record["domain"],
        "experiment_types": record["experiment_types"],
        "active_prompt": active,
        "documents": get_all_documents(db_path=db),
        "personas": get_all_personas(db_path=db),
        "tools": get_all_tools(db_path=db),
        "tasks": get_all_tasks(db_path=db),
    }


class UpdateAgentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field(default="")
    domain: str = Field(default="")
    experiment_types: list[str] = Field(default_factory=lambda: ["conversation"])


@app.put("/api/agents/{agent_id}")
def update_agent(agent_id: str, request: UpdateAgentRequest):
    """Update agent identity fields."""
    record = get_agent(agent_id)
    if not record:
        raise HTTPException(status_code=404, detail="Agent not found")
    update_agent_identity(
        agent_id=agent_id,
        name=request.name,
        description=request.description,
        domain=request.domain,
        experiment_types=request.experiment_types,
    )
    return {"agent_id": agent_id, "name": request.name}


class CreatePromptVersionRequest(BaseModel):
    prompt_text: str = Field(..., min_length=1)
    change_summary: str = Field(default="")
    parent_version_id: Optional[int] = None


@app.post("/api/agents/{agent_id}/prompt-versions", status_code=201)
def add_prompt_version(agent_id: str, request: CreatePromptVersionRequest):
    """Create a new prompt version and set it as active."""
    db = _resolve_agent(agent_id)
    version_id = create_prompt_version(
        prompt_text=request.prompt_text,
        parent_version_id=request.parent_version_id,
        change_summary=request.change_summary,
        set_active=True,
        db_path=db,
    )
    return {"version_id": version_id}


# ── Sessions ───────────────────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/sessions")
def list_sessions(agent_id: str):
    db = _resolve_agent(agent_id)
    return {"sessions": get_all_sessions(db_path=db)}


@app.get("/api/agents/{agent_id}/sessions/{session_id}")
def get_session_detail(agent_id: str, session_id: str):
    db = _resolve_agent(agent_id)
    session = get_session(session_id, db_path=db)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ── Analytics ─────────────────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/analytics")
def get_analytics_data(agent_id: str):
    db = _resolve_agent(agent_id)
    return get_analytics(db_path=db)


# ── Experiments / Batches ─────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/batches")
def list_batches(agent_id: str):
    db = _resolve_agent(agent_id)
    return {"batches": get_all_batches(db_path=db)}


@app.get("/api/agents/{agent_id}/batches/{batch_id}/sessions-summary")
def batch_sessions_summary(agent_id: str, batch_id: str):
    db = _resolve_agent(agent_id)
    return {"profiles": get_batch_sessions_summary(batch_id, db_path=db)}


@app.get("/api/agents/{agent_id}/prompt-versions")
def list_prompt_versions(agent_id: str):
    db = _resolve_agent(agent_id)
    versions = get_all_prompt_versions(db_path=db)
    active = get_active_prompt(db_path=db)
    return {
        "versions": versions,
        "active_version_id": active["version_id"] if active else None,
    }


# ── Run Simulation (async optimization loop) ───────────────────────────────────

class RunSimulationRequest(BaseModel):
    session_count: int = Field(default=3, ge=3, le=12)
    difficulty: int = Field(default=1, ge=1, le=5)


@app.post("/api/agents/{agent_id}/run-simulation")
def run_simulation(agent_id: str, request: RunSimulationRequest):
    """Start one full optimization iteration asynchronously."""
    db = _resolve_agent(agent_id)
    # Snap to a multiple of profile count (minimum 3)
    sessions = max(3, (request.session_count // 3) * 3)

    run_id = str(uuid.uuid4())
    with _runs_lock:
        _runs[run_id] = {
            "status": "running",
            "phase": "eval",
            "phase_detail": f"Starting eval batch ({sessions} sessions)…",
            "result": None,
            "error": None,
        }

    def _run():
        def on_phase(phase: str, detail: str) -> None:
            with _runs_lock:
                _runs[run_id]["phase"] = phase
                _runs[run_id]["phase_detail"] = detail

        try:
            result = run_optimization_iteration(
                sessions_per_batch=sessions,
                difficulty=request.difficulty,
                verbose=False,
                on_phase=on_phase,
                db_path=db,
            )
            with _runs_lock:
                _runs[run_id]["status"] = "complete"
                _runs[run_id]["result"] = {
                    "eval_avg": result["eval_avg"],
                    "challenger_avg": result["challenger_avg"],
                    "improvement": result["improvement"],
                    "accepted": result["accepted"],
                    "change_summary": result["change_summary"],
                    "decision": result["decision"],
                }
            _refresh_agent_stats(agent_id, db)
        except Exception as e:
            with _runs_lock:
                _runs[run_id]["status"] = "error"
                _runs[run_id]["error"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"run_id": run_id, "status": "running"}


@app.get("/api/agents/{agent_id}/run-simulation/{run_id}")
def poll_simulation(agent_id: str, run_id: str):
    # agent existence check (fast)
    _resolve_agent(agent_id)
    with _runs_lock:
        state = _runs.get(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run ID not found")
    return state


# ── Documents ─────────────────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/documents")
def list_documents(agent_id: str):
    db = _resolve_agent(agent_id)
    return {"documents": get_all_documents(db_path=db)}


@app.post("/api/agents/{agent_id}/documents", status_code=201)
async def upload_document(agent_id: str, file: UploadFile = File(...)):
    db = _resolve_agent(agent_id)

    content = await file.read()
    if not content:
        raise HTTPException(status_code=422, detail="Uploaded file is empty")

    content_text = _extract_text(
        filename=file.filename or "upload",
        content=content,
        content_type=file.content_type or "",
    )
    if not content_text:
        raise HTTPException(status_code=422, detail="Could not extract any text from file")

    doc_id = str(uuid.uuid4())
    add_document(
        doc_id=doc_id,
        filename=file.filename or "upload",
        file_type=file.content_type or "text/plain",
        content_text=content_text,
        file_size_bytes=len(content),
        db_path=db,
    )
    return {"doc_id": doc_id, "filename": file.filename}


@app.delete("/api/agents/{agent_id}/documents/{doc_id}", status_code=204)
def remove_document(agent_id: str, doc_id: str):
    db = _resolve_agent(agent_id)
    delete_document(doc_id, db_path=db)


# ── Personas ──────────────────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/personas")
def list_personas(agent_id: str):
    db = _resolve_agent(agent_id)
    return {"personas": get_all_personas(db_path=db)}


class CreatePersonaRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    description: str = Field(default="")
    behavioral_instructions: str = Field(..., min_length=1)
    difficulty_base: int = Field(default=1, ge=1, le=5)
    hidden_goals: list[str] = Field(default_factory=list)


@app.post("/api/agents/{agent_id}/personas", status_code=201)
def create_persona(agent_id: str, request: CreatePersonaRequest):
    db = _resolve_agent(agent_id)
    persona_id = str(uuid.uuid4())
    add_persona(
        persona_id=persona_id,
        name=request.name,
        description=request.description,
        behavioral_instructions=request.behavioral_instructions,
        difficulty_base=request.difficulty_base,
        hidden_goals=request.hidden_goals,
        db_path=db,
    )
    return {"persona_id": persona_id, "name": request.name}


@app.put("/api/agents/{agent_id}/personas/{persona_id}")
def update_persona_endpoint(agent_id: str, persona_id: str, request: CreatePersonaRequest):
    db = _resolve_agent(agent_id)
    updated = update_persona(
        persona_id=persona_id,
        name=request.name,
        description=request.description,
        behavioral_instructions=request.behavioral_instructions,
        difficulty_base=request.difficulty_base,
        hidden_goals=request.hidden_goals,
        db_path=db,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Persona not found")
    return {"persona_id": persona_id, "name": request.name}


@app.delete("/api/agents/{agent_id}/personas/{persona_id}", status_code=204)
def remove_persona(agent_id: str, persona_id: str):
    db = _resolve_agent(agent_id)
    delete_persona(persona_id, db_path=db)


class GeneratePersonaRequest(BaseModel):
    description: str = Field(
        ...,
        min_length=10,
        description="Plain-language description of the user type to generate",
    )


@app.post("/api/agents/{agent_id}/personas/generate", status_code=201)
def generate_persona(agent_id: str, request: GeneratePersonaRequest):
    """
    Use Claude to generate a full persona from a plain-language description,
    then save it to the agent's personas table.
    """
    db = _resolve_agent(agent_id)

    prompt = f"""You are designing synthetic user personas for an AI agent evaluation platform.

Generate a detailed persona based on this description:
"{request.description}"

Output ONLY a valid JSON object with exactly these fields:
{{
  "name": "<short display name, 2-4 words>",
  "description": "<one sentence describing who this person is>",
  "behavioral_instructions": "<2-4 paragraphs of specific behavioral rules the simulated user must follow, written in second person ('You are...'). Include communication style, how they react to unclear answers, and any quirks.>",
  "difficulty_base": <integer 1-5, where 1=easy/cooperative and 5=very challenging>,
  "hidden_goals": [
    "<specific goal this user might want to accomplish in an HR onboarding conversation>",
    "<another specific goal>",
    "<a third specific goal>"
  ]
}}

Rules:
- hidden_goals must be concrete tasks achievable in a short HR chat (e.g. 'Find out how to enroll in health insurance')
- behavioral_instructions must guide the LLM to simulate this persona consistently
- Output ONLY the JSON object — no markdown, no explanation"""

    client = _anthropic.Anthropic()
    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.rsplit("```", 1)[0].strip()
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Claude returned invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Claude API error: {e}")

    # Validate required fields
    required = {"name", "description", "behavioral_instructions", "difficulty_base", "hidden_goals"}
    missing = required - set(data.keys())
    if missing:
        raise HTTPException(status_code=500, detail=f"Claude response missing fields: {missing}")

    persona_id = str(uuid.uuid4())
    add_persona(
        persona_id=persona_id,
        name=str(data["name"]),
        description=str(data["description"]),
        behavioral_instructions=str(data["behavioral_instructions"]),
        difficulty_base=max(1, min(5, int(data["difficulty_base"]))),
        hidden_goals=list(data.get("hidden_goals", [])),
        is_generated=True,
        db_path=db,
    )

    return {
        "persona_id": persona_id,
        "name": data["name"],
        "description": data["description"],
        "difficulty_base": data["difficulty_base"],
        "hidden_goals": data["hidden_goals"],
    }


# ── Tools ─────────────────────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/tools")
def list_tools(agent_id: str):
    db = _resolve_agent(agent_id)
    return {"tools": get_all_tools(db_path=db)}


class UpsertToolRequest(BaseModel):
    tool_id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=80)
    display_name: str = Field(..., min_length=1, max_length=120)
    description: str = Field(..., min_length=1)
    operation_type: str = Field(...)
    collection_name: str = Field(..., min_length=1)
    input_schema: dict = Field(default_factory=dict)
    output_schema: dict = Field(default_factory=dict)
    error_conditions: list = Field(default_factory=list)
    seed_records: list = Field(default_factory=list)


@app.post("/api/agents/{agent_id}/tools", status_code=201)
def create_tool(agent_id: str, request: UpsertToolRequest):
    db = _resolve_agent(agent_id)
    tool_id = request.tool_id or str(uuid.uuid4())
    upsert_tool(
        tool_id=tool_id,
        name=request.name,
        display_name=request.display_name,
        description=request.description,
        operation_type=request.operation_type,
        collection_name=request.collection_name,
        input_schema=request.input_schema,
        output_schema=request.output_schema,
        error_conditions=request.error_conditions,
        db_path=db,
    )
    if request.seed_records:
        upsert_tool_seed_data(
            seed_id=str(uuid.uuid4()),
            tool_id=tool_id,
            collection_name=request.collection_name,
            records=request.seed_records,
            db_path=db,
        )
    return {"tool_id": tool_id, "name": request.name}


@app.put("/api/agents/{agent_id}/tools/{tool_id}")
def update_tool(agent_id: str, tool_id: str, request: UpsertToolRequest):
    db = _resolve_agent(agent_id)
    upsert_tool(
        tool_id=tool_id,
        name=request.name,
        display_name=request.display_name,
        description=request.description,
        operation_type=request.operation_type,
        collection_name=request.collection_name,
        input_schema=request.input_schema,
        output_schema=request.output_schema,
        error_conditions=request.error_conditions,
        db_path=db,
    )
    if request.seed_records is not None:
        upsert_tool_seed_data(
            seed_id=str(uuid.uuid4()),
            tool_id=tool_id,
            collection_name=request.collection_name,
            records=request.seed_records,
            db_path=db,
        )
    return {"tool_id": tool_id, "name": request.name}


@app.delete("/api/agents/{agent_id}/tools/{tool_id}", status_code=204)
def remove_tool(agent_id: str, tool_id: str):
    db = _resolve_agent(agent_id)
    delete_tool(tool_id, db_path=db)


class GenerateSeedRequest(BaseModel):
    count: int = Field(default=5, ge=1, le=20)
    context: str = Field(default="")


@app.post("/api/agents/{agent_id}/tools/{tool_id}/generate-seed", status_code=201)
def generate_seed_data(agent_id: str, tool_id: str, request: GenerateSeedRequest):
    """Use Claude to generate realistic seed records for a tool."""
    db = _resolve_agent(agent_id)
    tool = get_tool(tool_id, db_path=db)
    if not tool:
        raise HTTPException(status_code=404, detail="Tool not found")

    agent_record = get_agent(agent_id)
    agent_context = f"Agent: {agent_record['name']}, Domain: {agent_record['domain']}" if agent_record else ""

    prompt = f"""Generate {request.count} realistic seed records for this tool's data collection.

{agent_context}
Tool: {tool['display_name']} ({tool['operation_type']} on '{tool['collection_name']}')
Description: {tool['description']}
Input Schema: {json.dumps(tool.get('input_schema', {}), indent=2)}
{f"Additional context: {request.context}" if request.context else ""}

Generate realistic records that would exist in a real {agent_record.get('domain', 'business') if agent_record else 'business'} system.
Each record should have an "id" field plus all relevant fields from the schema.

Output ONLY a valid JSON array of {request.count} record objects. No explanation, no markdown."""

    client = _anthropic.Anthropic()
    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.rsplit("```", 1)[0].strip()
        records = json.loads(raw)
        if not isinstance(records, list):
            records = [records]
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Claude returned invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Claude API error: {e}")

    seed_id = str(uuid.uuid4())
    upsert_tool_seed_data(
        seed_id=seed_id,
        tool_id=tool_id,
        collection_name=tool["collection_name"],
        records=records,
        db_path=db,
    )
    return {"seed_id": seed_id, "records": records, "count": len(records)}


# ── Tasks ─────────────────────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/tasks")
def list_tasks(agent_id: str):
    db = _resolve_agent(agent_id)
    return {"tasks": get_all_tasks(db_path=db)}


class UpsertTaskRequest(BaseModel):
    task_id: Optional[str] = None
    experiment_type: str = Field(...)
    title: str = Field(..., min_length=1, max_length=120)
    description: str = Field(..., min_length=1)
    expected_tool_calls: list = Field(default_factory=list)
    expected_final_state: dict = Field(default_factory=dict)


@app.post("/api/agents/{agent_id}/tasks", status_code=201)
def create_task(agent_id: str, request: UpsertTaskRequest):
    db = _resolve_agent(agent_id)
    task_id = request.task_id or str(uuid.uuid4())
    upsert_task(
        task_id=task_id,
        experiment_type=request.experiment_type,
        title=request.title,
        description=request.description,
        expected_tool_calls=request.expected_tool_calls,
        expected_final_state=request.expected_final_state,
        db_path=db,
    )
    return {"task_id": task_id, "title": request.title}


@app.put("/api/agents/{agent_id}/tasks/{task_id}")
def update_task_endpoint(agent_id: str, task_id: str, request: UpsertTaskRequest):
    db = _resolve_agent(agent_id)
    upsert_task(
        task_id=task_id,
        experiment_type=request.experiment_type,
        title=request.title,
        description=request.description,
        expected_tool_calls=request.expected_tool_calls,
        expected_final_state=request.expected_final_state,
        db_path=db,
    )
    return {"task_id": task_id, "title": request.title}


@app.delete("/api/agents/{agent_id}/tasks/{task_id}", status_code=204)
def remove_task(agent_id: str, task_id: str):
    db = _resolve_agent(agent_id)
    delete_task(task_id, db_path=db)


class GenerateTasksRequest(BaseModel):
    experiment_type: str = Field(...)
    count: int = Field(default=3, ge=1, le=10)
    context: str = Field(default="")


@app.post("/api/agents/{agent_id}/tasks/generate", status_code=201)
def generate_tasks(agent_id: str, request: GenerateTasksRequest):
    """Use Claude to generate tasks for a given experiment type."""
    db = _resolve_agent(agent_id)
    agent_record = get_agent(agent_id)
    tools = get_all_tools(db_path=db)

    # Build rich tool descriptions including input schemas and sample seed records
    tool_blocks = []
    for t in tools:
        # Fetch full tool record (includes seed_data)
        full_tool = get_tool(t["tool_id"], db_path=db) or t
        schema_props = full_tool.get("input_schema", {}).get("properties", {})
        params_str = ", ".join(
            f"{k} ({v.get('type','any')}): {v.get('description','')}"
            for k, v in schema_props.items()
        )
        seed_sample = ""
        seed_data = full_tool.get("seed_data", [])
        if seed_data:
            records = seed_data[0].get("records", [])
            if records:
                # Show up to 3 sample records so Claude can reference real names/IDs
                sample = records[:3]
                seed_sample = f"\n  Sample records: {json.dumps(sample)}"
        tool_blocks.append(
            f"- {t['name']} ({t['operation_type']} on '{t['collection_name']}')\n"
            f"  Description: {t['description']}\n"
            f"  Inputs: {params_str or 'none'}"
            + seed_sample
        )
    tool_section = "\n".join(tool_blocks) if tool_blocks else "No tools defined."

    agent_name = agent_record["name"] if agent_record else "the agent"
    agent_domain = agent_record["domain"] if agent_record else "general"
    n = request.count
    context_line = f"\nAdditional context: {request.context}" if request.context else ""

    if request.experiment_type == "single_output":
        prompt = f"""You are generating Single Output tasks for an AI agent simulation lab.

A Single Output task has ALL of these properties:
- Requires exactly 1-2 tool calls maximum to complete
- Has one clear, atomic deliverable
- Does not require the output of one tool call to feed into another
- Can be fully completed in a single agent response

Examples of good Single Output tasks for an invoicing agent:
- "Look up customer Acme Corp and return their full billing record"
- "List all invoices currently in overdue status"
- "Calculate the total for 40 hours of software consulting at standard rates with a retainer discount"

Examples of BAD Single Output tasks (too complex, belong in Multi-Step):
- "Look up a customer, create an invoice, and send it" (3 chained tool calls)
- "Find overdue invoices and create follow-up drafts" (multi-tool workflow)

Generate {n} Single Output tasks for the following agent. Each task must be completable with 1-2 tool calls maximum. Tasks must be meaningfully different from each other — do not repeat the same tool or scenario.

Agent: {agent_name}
Domain: {agent_domain}{context_line}

Available tools (use real names/IDs from the sample records in your task descriptions):
{tool_section}

Output ONLY a valid JSON array of {n} task objects with exactly these fields:
[
  {{
    "title": "<short task title, under 60 chars>",
    "description": "<full task description given to the agent — be specific, reference real record names/IDs from the seed data above>",
    "expected_tool_calls": ["<tool_name>"],
    "expected_final_state": {{"<collection>": "<what the result should contain>"}}
  }}
]

Each task must use at most 2 tool calls. Return only the JSON array, no explanation."""

    elif request.experiment_type == "multi_step":
        prompt = f"""You are generating Multi-Step Agentic tasks for an AI agent simulation lab.

A Multi-Step task has ALL of these properties:
- Requires 3 or more tool calls chained in sequence
- The output of one tool call is used as input to the next
- Involves decision-making between steps (e.g. checking a result before proceeding)
- Cannot be completed in a single tool call — the agent must plan and execute a workflow
- Has a meaningful end state that can be verified (e.g. a record was created AND updated AND sent)

Examples of good Multi-Step tasks for an invoicing agent:
- "Look up customer Orion Logistics, calculate the total for 25 hours of project management at standard rates with their new client discount, create the invoice, then send it to their billing contact with a welcome message"
- "List all overdue invoices, identify the customer with the highest overdue amount, look up their full record, and create a new draft invoice for the same amount"

Examples of BAD Multi-Step tasks (too simple, belong in Single Output):
- "Look up customer Acme Corp" (single tool call)
- "List all invoices with status sent" (single tool call)

Generate {n} Multi-Step tasks for the following agent. Each task must require at least 3 chained tool calls where step outputs feed into subsequent steps. Tasks must be meaningfully different from each other.

Agent: {agent_name}
Domain: {agent_domain}{context_line}

Available tools (use real names/IDs from the sample records in your task descriptions):
{tool_section}

Output ONLY a valid JSON array of {n} task objects with exactly these fields:
[
  {{
    "title": "<short task title, under 60 chars>",
    "description": "<full task description given to the agent — be specific, reference real record names/IDs, describe the full workflow the agent must complete>",
    "expected_tool_calls": ["<tool_name_step1>", "<tool_name_step2>", "<tool_name_step3>", ...],
    "expected_final_state": {{"<collection>": "<what should exist after all steps complete>"}}
  }}
]

Each task must list at least 3 tool calls in sequence. Return only the JSON array, no explanation."""

    else:
        # Fallback for any other experiment type
        prompt = f"""Generate {n} realistic {request.experiment_type} tasks for this AI agent.

Agent: {agent_name}
Domain: {agent_domain}{context_line}

Available tools:
{tool_section}

Output ONLY a valid JSON array of {n} task objects with exactly these fields:
[
  {{
    "title": "<short task title, under 60 chars>",
    "description": "<full task description given to agent, 1-3 paragraphs with specific requirements>",
    "expected_tool_calls": ["<tool_name>", ...],
    "expected_final_state": {{"<collection>": "<description of what should be in it>"}}
  }}
]"""

    client = _anthropic.Anthropic()
    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2048,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = response.content[0].text.strip()
        if raw.startswith("```"):
            raw = raw.split("```", 2)[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.rsplit("```", 1)[0].strip()
        tasks_data = json.loads(raw)
        if not isinstance(tasks_data, list):
            tasks_data = [tasks_data]
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"Claude returned invalid JSON: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Claude API error: {e}")

    created = []
    for t in tasks_data:
        task_id = str(uuid.uuid4())
        upsert_task(
            task_id=task_id,
            experiment_type=request.experiment_type,
            title=str(t.get("title", "Untitled Task")),
            description=str(t.get("description", "")),
            expected_tool_calls=list(t.get("expected_tool_calls", [])),
            expected_final_state=dict(t.get("expected_final_state", {})),
            db_path=db,
        )
        created.append({"task_id": task_id, "title": t.get("title")})
    return {"tasks": created}


# ── Tool Call Logs ─────────────────────────────────────────────────────────────

@app.get("/api/agents/{agent_id}/sessions/{session_id}/tool-calls")
def get_tool_calls(agent_id: str, session_id: str):
    db = _resolve_agent(agent_id)
    return {"tool_calls": get_session_tool_calls(session_id, db_path=db)}


# ── Run Task (single session, non-optimization) ───────────────────────────────

class RunTaskRequest(BaseModel):
    task_id: str
    difficulty: int = Field(default=1, ge=1, le=5)


@app.post("/api/agents/{agent_id}/run-task")
def run_task_endpoint(agent_id: str, request: RunTaskRequest):
    """Run a single task session asynchronously."""
    db = _resolve_agent(agent_id)
    agent_record = get_agent(agent_id)
    task = get_task(request.task_id, db_path=db)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    run_id = str(uuid.uuid4())
    with _runs_lock:
        _runs[run_id] = {
            "status": "running",
            "phase": "running",
            "phase_detail": f"Running {task['experiment_type']} task: {task['title']}",
            "result": None,
            "error": None,
        }

    def _run():
        try:
            from simulation_runner import SimulationRunner
            runner = SimulationRunner(
                user_profile=task["experiment_type"],
                hidden_goal=task["description"],
                verbose=False,
                difficulty=request.difficulty,
                db_path=db,
                agent_name=agent_record.get("name", "the agent") if agent_record else "the agent",
                agent_domain=agent_record.get("domain", "general") if agent_record else "general",
                experiment_type=task["experiment_type"],
                task_id=task["task_id"],
                task_title=task["title"],
                expected_tool_calls=task.get("expected_tool_calls", []),
                expected_final_state=task.get("expected_final_state", {}),
            )
            result = runner.run()
            with _runs_lock:
                _runs[run_id]["status"] = "complete"
                _runs[run_id]["result"] = {
                    "session_id": result["session_id"],
                    "total_score": result["evaluation"].get("total_score", 0),
                    "trajectory_quality": result["evaluation"].get("trajectory_quality", "low"),
                    "goal_achieved": result["evaluation"].get("hidden_goal_achieved", False),
                    "total_tool_calls": result.get("total_tool_calls", 0),
                }
            _refresh_agent_stats(agent_id, db)
        except Exception as e:
            with _runs_lock:
                _runs[run_id]["status"] = "error"
                _runs[run_id]["error"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"run_id": run_id, "status": "running"}


@app.get("/api/agents/{agent_id}/run-task/{run_id}")
def poll_task_run(agent_id: str, run_id: str):
    _resolve_agent(agent_id)
    with _runs_lock:
        state = _runs.get(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run ID not found")
    return state


# ── Batch-with-optimizer helpers ──────────────────────────────────────────────

def _profile_key(name: str) -> str:
    return name.lower().replace(" ", "_")


def _generate_challenger_prompt(
    current_prompt: str,
    batch_results: list[dict],
    focus_area: str = "",
    agent_name: str = "the agent",
    agent_domain: str = "general",
) -> str:
    client = _anthropic.Anthropic()

    parts = []
    for r in batch_results:
        ev = r.get("evaluation", {})
        failures = ev.get("failure_modes", [])
        standouts = ev.get("standout_moments", [])
        parts.append(
            f"Profile: {r.get('user_profile', '?')} | Score: {ev.get('total_score', 0)}/50 "
            f"| Goal achieved: {ev.get('hidden_goal_achieved')}\n"
            f"Failure modes: {', '.join(failures) if failures else 'none'}\n"
            f"Standout moments: {', '.join(standouts) if standouts else 'none'}"
        )

    focus_line = f"\n\nFOCUS AREA FOR IMPROVEMENT: {focus_area.strip()}" if focus_area.strip() else ""

    meta_prompt = f"""You are an expert at writing system prompts for AI agents.{focus_line}

Rewrite the system prompt below to address the observed failure modes and improve overall performance.

AGENT CONTEXT:
- Agent Name: {agent_name}
- Domain: {agent_domain}

CURRENT SYSTEM PROMPT:
---
{current_prompt}
---

EVALUATION RESULTS:
---
{chr(10).join(parts) if parts else "No evaluation data available."}
---

RULES:
1. Do NOT change the agent identity, company, or domain.
2. Keep all tool use instructions exactly as-is — do not remove or rename any tools.
3. Address each failure mode with a specific, actionable guideline.
4. Stay within 50% of the original word count.
5. Output ONLY the new system prompt — no preamble, no explanation, no markdown fences.

Write the improved system prompt now:"""

    response = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=2048,
        messages=[{"role": "user", "content": meta_prompt}],
    )
    return response.content[0].text.strip()


def _run_personas_batch(
    run_id: str,
    phase: str,
    experiment_type: str,
    task_id_arg: Optional[str],
    total_runs: int,
    difficulty: int,
    batch_id: str,
    batch_role: str,
    prompt_override: Optional[str],
    prompt_version_id: Optional[int],
    personas: list,
    db,
    agent_name: str,
    agent_domain: str,
) -> tuple[list, bool]:
    """Run a batch of simulations. Returns (results, stopped_early)."""
    from simulation_runner import SimulationRunner

    create_batch(batch_id, prompt_version_id, in_optimizer_run=False, db_path=db)

    results: list[dict] = []
    stopped = False

    if experiment_type == "conversation" and personas:
        k = len(personas)
        last_goals: dict[str, str] = {}

        for i in range(total_runs):
            with _runs_lock:
                if _runs[run_id]["cancel_requested"]:
                    stopped = True
                    break

            persona = personas[i % k]
            pid = persona["persona_id"]
            goals = persona.get("hidden_goals") or []
            if not goals:
                goals = ["Complete your onboarding successfully"]

            last = last_goals.get(pid)
            if len(goals) > 1 and last in goals:
                available = [g for g in goals if g != last]
            else:
                available = goals
            goal = random.choice(available)
            last_goals[pid] = goal

            runs_per_persona = max(1, total_runs // k)
            persona_run_num = (i // k) + 1

            with _runs_lock:
                _runs[run_id]["current_run"] = i + 1
                _runs[run_id]["persona_name"] = persona["name"]
                _runs[run_id]["persona_run"] = persona_run_num
                _runs[run_id]["persona_runs_total"] = runs_per_persona

            runner = SimulationRunner(
                user_profile=_profile_key(persona["name"]),
                hidden_goal=goal,
                verbose=False,
                difficulty=difficulty,
                batch_id=batch_id,
                prompt_version_id=prompt_version_id,
                prompt_override=prompt_override,
                db_path=db,
                agent_name=agent_name,
                agent_domain=agent_domain,
                persona_name=persona["name"],
                persona_description=persona.get("description", "")[:200],
                batch_role=batch_role,
            )
            results.append(runner.run())

    else:
        task = get_task(task_id_arg, db_path=db) if task_id_arg else None

        for i in range(total_runs):
            with _runs_lock:
                if _runs[run_id]["cancel_requested"]:
                    stopped = True
                    break
                _runs[run_id]["current_run"] = i + 1
                _runs[run_id]["persona_name"] = None

            if task:
                runner = SimulationRunner(
                    user_profile=task["experiment_type"],
                    hidden_goal=task["description"],
                    verbose=False,
                    difficulty=difficulty,
                    batch_id=batch_id,
                    prompt_version_id=prompt_version_id,
                    prompt_override=prompt_override,
                    db_path=db,
                    agent_name=agent_name,
                    agent_domain=agent_domain,
                    experiment_type=task["experiment_type"],
                    task_id=task["task_id"],
                    task_title=task["title"],
                    expected_tool_calls=task.get("expected_tool_calls", []),
                    expected_final_state=task.get("expected_final_state", {}),
                    batch_role=batch_role,
                )
                results.append(runner.run())

    update_batch_stats(batch_id, db_path=db)
    return results, stopped


def _batch_quality_counts(results: list[dict]) -> dict:
    counts: dict[str, int] = {"high": 0, "medium": 0, "low": 0}
    for r in results:
        q = (r.get("evaluation") or {}).get("trajectory_quality") or "low"
        counts[q] = counts.get(q, 0) + 1
    return counts


def _batch_avg_score(results: list[dict]) -> float:
    scores = [(r.get("evaluation") or {}).get("total_score") or 0 for r in results]
    return sum(scores) / len(scores) if scores else 0.0


def _batch_goal_rate(results: list[dict]) -> float:
    goals = [(r.get("evaluation") or {}).get("hidden_goal_achieved", False) for r in results]
    return sum(1 for g in goals if g) / len(goals) if goals else 0.0


# ── Run-batch-with-optimizer endpoint ─────────────────────────────────────────

class RunBatchWithOptimizerRequest(BaseModel):
    experiment_type: str = Field(default="conversation")
    task_id: Optional[str] = None
    total_runs: int = Field(default=3, ge=1, le=100)
    difficulty: int = Field(default=1, ge=1, le=5)
    optimizer_enabled: bool = Field(default=False)
    optimizer_mode: str = Field(default="auto")  # "auto" | "manual"
    optimizer_focus: str = Field(default="")
    challenger_prompt: Optional[str] = None


@app.post("/api/agents/{agent_id}/run-batch-with-optimizer")
def run_batch_with_optimizer(agent_id: str, request: RunBatchWithOptimizerRequest):
    """Run a batch of simulations with an optional challenger-prompt comparison step."""
    db = _resolve_agent(agent_id)
    agent_record = get_agent(agent_id)
    agent_name = agent_record.get("name", "the agent") if agent_record else "the agent"
    agent_domain = agent_record.get("domain", "general") if agent_record else "general"

    run_id = str(uuid.uuid4())
    with _runs_lock:
        _runs[run_id] = {
            "status": "running",
            "phase": "primary",
            "current_run": 0,
            "total_runs": request.total_runs,
            "persona_name": None,
            "persona_run": None,
            "persona_runs_total": None,
            "cancel_requested": False,
            "stopped_early": False,
            "primary_complete": False,
            "primary_avg": None,
            "primary_goal_rate": None,
            "primary_quality_counts": None,
            "challenger_prompt_text": None,
            "result": None,
            "error": None,
        }

    def _run():
        try:
            personas = []
            if request.experiment_type == "conversation":
                personas = get_all_personas(db_path=db)

            # ── Primary batch ──────────────────────────────────────────────
            primary_batch_id = str(uuid.uuid4())
            primary_results, stopped = _run_personas_batch(
                run_id=run_id,
                phase="primary",
                experiment_type=request.experiment_type,
                task_id_arg=request.task_id,
                total_runs=request.total_runs,
                difficulty=request.difficulty,
                batch_id=primary_batch_id,
                batch_role="primary",
                prompt_override=None,
                prompt_version_id=None,
                personas=personas,
                db=db,
                agent_name=agent_name,
                agent_domain=agent_domain,
            )

            primary_avg = _batch_avg_score(primary_results)
            primary_goal_rate = _batch_goal_rate(primary_results)
            q_counts = _batch_quality_counts(primary_results)

            with _runs_lock:
                _runs[run_id]["primary_complete"] = True
                _runs[run_id]["primary_avg"] = primary_avg
                _runs[run_id]["primary_goal_rate"] = primary_goal_rate
                _runs[run_id]["primary_quality_counts"] = q_counts

            if stopped or not request.optimizer_enabled:
                with _runs_lock:
                    _runs[run_id]["stopped_early"] = stopped
                    _runs[run_id]["status"] = "complete"
                    _runs[run_id]["result"] = {
                        "total_runs": len(primary_results),
                        "quality_counts": q_counts,
                        "primary_avg": primary_avg,
                        "optimizer_enabled": False,
                    }
                _refresh_agent_stats(agent_id, db)
                return

            # ── Generate challenger prompt ──────────────────────────────────
            with _runs_lock:
                _runs[run_id]["phase"] = "generating_challenger"

            active = get_active_prompt(db_path=db)
            current_prompt = active["prompt_text"] if active else ""

            if request.optimizer_mode == "manual" and request.challenger_prompt:
                challenger_text = request.challenger_prompt
            else:
                challenger_text = _generate_challenger_prompt(
                    current_prompt=current_prompt,
                    batch_results=primary_results,
                    focus_area=request.optimizer_focus or "",
                    agent_name=agent_name,
                    agent_domain=agent_domain,
                )

            with _runs_lock:
                _runs[run_id]["challenger_prompt_text"] = challenger_text

            # ── Challenger batch ────────────────────────────────────────────
            with _runs_lock:
                _runs[run_id]["phase"] = "challenger"
                _runs[run_id]["current_run"] = 0

            challenger_batch_id = str(uuid.uuid4())
            challenger_results, _ = _run_personas_batch(
                run_id=run_id,
                phase="challenger",
                experiment_type=request.experiment_type,
                task_id_arg=request.task_id,
                total_runs=request.total_runs,
                difficulty=request.difficulty,
                batch_id=challenger_batch_id,
                batch_role="challenger",
                prompt_override=challenger_text,
                prompt_version_id=None,
                personas=personas,
                db=db,
                agent_name=agent_name,
                agent_domain=agent_domain,
            )

            challenger_avg = _batch_avg_score(challenger_results)
            challenger_goal_rate = _batch_goal_rate(challenger_results)
            delta = challenger_avg - primary_avg

            if challenger_goal_rate == 0 and challenger_results:
                decision = "rejected_zero_goals"
            elif delta > 0:
                decision = "challenger_wins"
            else:
                decision = "challenger_loses"

            with _runs_lock:
                _runs[run_id]["status"] = "complete"
                _runs[run_id]["result"] = {
                    "total_runs": len(primary_results),
                    "quality_counts": q_counts,
                    "primary_avg": primary_avg,
                    "primary_goal_rate": primary_goal_rate,
                    "challenger_avg": challenger_avg,
                    "challenger_goal_rate": challenger_goal_rate,
                    "delta": delta,
                    "decision": decision,
                    "challenger_prompt_text": challenger_text,
                    "optimizer_enabled": True,
                }

            _refresh_agent_stats(agent_id, db)

        except Exception as e:
            with _runs_lock:
                _runs[run_id]["status"] = "error"
                _runs[run_id]["error"] = str(e)

    threading.Thread(target=_run, daemon=True).start()
    return {"run_id": run_id, "status": "running"}


@app.get("/api/agents/{agent_id}/run-batch-with-optimizer/{run_id}")
def poll_batch_with_optimizer(agent_id: str, run_id: str):
    _resolve_agent(agent_id)
    with _runs_lock:
        state = _runs.get(run_id)
    if not state:
        raise HTTPException(status_code=404, detail="Run ID not found")
    return state


@app.post("/api/agents/{agent_id}/run-batch-with-optimizer/{run_id}/cancel")
def cancel_batch_run(agent_id: str, run_id: str):
    _resolve_agent(agent_id)
    with _runs_lock:
        state = _runs.get(run_id)
        if not state:
            raise HTTPException(status_code=404, detail="Run ID not found")
        state["cancel_requested"] = True
    return {"cancelled": True}


# ── Langfuse qualitative evaluation ──────────────────────────────────────────

from fastapi.responses import StreamingResponse
from langfuse_eval import (
    get_agent_trace_comments,
    propose_axial_codes,
    assign_axial_codes,
    build_csv,
    generate_judge_prompts,
    fetch_transcripts,
    run_judges_stream,
    build_judge_report_csv,
)


class _ProposeCodesRequest(BaseModel):
    open_codes: list[dict]


class _AssignCodesRequest(BaseModel):
    open_codes: list[dict]
    confirmed_categories: list[str]


class _ExportCsvRequest(BaseModel):
    coded_sessions: list[dict]
    frequencies: dict


class _GenerateJudgePromptsRequest(BaseModel):
    axial_codes: list[str]
    open_codes: list[dict]
    agent_name: str
    agent_domain: str
    session_type_breakdown: dict[str, int] = {}


class _FetchTranscriptsRequest(BaseModel):
    sessions: list[dict]


class _RunJudgesRequest(BaseModel):
    judges: list[dict]
    transcripts: list[dict]


class _ExportJudgeReportRequest(BaseModel):
    judges: list[dict]
    decisions: dict[str, dict[str, str]]
    human_labels: dict[str, dict[str, bool]]
    metrics: dict[str, dict[str, float]]
    open_codes: list[dict]
    agent_name: str
    metrics_by_type: dict[str, dict[str, dict]] = {}


@app.get("/api/agents/{agent_id}/langfuse-comments")
def get_langfuse_comments(agent_id: str, limit: int | None = None):
    db = _resolve_agent(agent_id)
    return get_agent_trace_comments(agent_id, db, limit=limit)


@app.post("/api/agents/{agent_id}/evaluate/propose-codes")
def evaluate_propose_codes(agent_id: str, body: _ProposeCodesRequest):
    _resolve_agent(agent_id)
    if not body.open_codes:
        raise HTTPException(status_code=400, detail="open_codes is required")
    categories = propose_axial_codes(body.open_codes)
    return {"proposed_categories": categories}


@app.post("/api/agents/{agent_id}/evaluate/assign-codes")
def evaluate_assign_codes(agent_id: str, body: _AssignCodesRequest):
    _resolve_agent(agent_id)
    if not body.open_codes or not body.confirmed_categories:
        raise HTTPException(status_code=400, detail="open_codes and confirmed_categories are required")
    coded, frequencies = assign_axial_codes(body.open_codes, body.confirmed_categories)
    return {"coded_sessions": coded, "frequencies": frequencies}


@app.post("/api/agents/{agent_id}/evaluate/export-csv")
def evaluate_export_csv(agent_id: str, body: _ExportCsvRequest):
    record = get_agent(agent_id)
    if not record:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent_name = record.get("name", agent_id).replace(" ", "_")
    date_str = __import__("datetime").date.today().isoformat()
    filename = f"axial_coding_{agent_name}_{date_str}.csv"
    csv_content = build_csv(body.coded_sessions, body.frequencies)
    return StreamingResponse(
        iter([csv_content]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.post("/api/agents/{agent_id}/evaluate/generate-judge-prompts")
def evaluate_generate_judge_prompts(agent_id: str, body: _GenerateJudgePromptsRequest):
    _resolve_agent(agent_id)
    if not body.axial_codes:
        raise HTTPException(status_code=400, detail="axial_codes is required")
    judges = generate_judge_prompts(
        body.axial_codes,
        body.open_codes,
        body.agent_name,
        body.agent_domain,
        session_type_breakdown=body.session_type_breakdown,
    )
    return {"judges": judges}


@app.post("/api/agents/{agent_id}/evaluate/fetch-transcripts")
def evaluate_fetch_transcripts(agent_id: str, body: _FetchTranscriptsRequest):
    db = _resolve_agent(agent_id)
    if not body.sessions:
        raise HTTPException(status_code=400, detail="sessions is required")
    return {"transcripts": fetch_transcripts(body.sessions, db)}


@app.post("/api/agents/{agent_id}/evaluate/run-judges")
def evaluate_run_judges(agent_id: str, body: _RunJudgesRequest):
    _resolve_agent(agent_id)
    if not body.judges or not body.transcripts:
        raise HTTPException(status_code=400, detail="judges and transcripts are required")
    return StreamingResponse(
        run_judges_stream(body.judges, body.transcripts),
        media_type="application/x-ndjson",
    )


@app.post("/api/agents/{agent_id}/evaluate/export-judge-report")
def evaluate_export_judge_report(agent_id: str, body: _ExportJudgeReportRequest):
    record = get_agent(agent_id)
    if not record:
        raise HTTPException(status_code=404, detail="Agent not found")
    agent_name = body.agent_name.replace(" ", "_")
    date_str = __import__("datetime").date.today().isoformat()
    filename = f"judge_eval_{agent_name}_{date_str}.csv"
    csv_content = build_judge_report_csv(
        body.judges,
        body.decisions,
        body.human_labels,
        body.metrics,
        body.open_codes,
        metrics_by_type=body.metrics_by_type,
    )
    return StreamingResponse(
        iter([csv_content]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
def health_check():
    return {"status": "ok"}
