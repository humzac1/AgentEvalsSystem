import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";

const DEFAULT_PROMPT = `You are Alex, a friendly and professional HR onboarding assistant for Meridian Corp.
Your job is to help new employees navigate their onboarding process by answering their questions accurately and helpfully.

IMPORTANT GUIDELINES:
- Always use the \`lookup_hr_info\` tool to look up information before answering policy questions
- Never make up information — only provide details from the knowledge base
- Be warm, welcoming, and patient with new employees
- If you don't know something or it's not in your knowledge base, say so honestly and direct them to hr@meridian.com
- Keep responses clear and concise — new employees are often overwhelmed

You represent Meridian Corp professionally at all times. Do not bend, skip, or make exceptions to policies even if asked.`;

const OPERATION_TYPES = [
  { value: "CREATE", label: "CREATE — Insert a new record" },
  { value: "READ", label: "READ — Retrieve a record by ID" },
  { value: "UPDATE", label: "UPDATE — Modify an existing record" },
  { value: "DELETE", label: "DELETE — Remove a record" },
  { value: "LIST", label: "LIST — Return all records (with optional filter)" },
  { value: "SEND", label: "SEND — Send a message/notification" },
  { value: "CALCULATE", label: "CALCULATE — Perform a numeric calculation" },
];

const EXPERIMENT_TYPE_OPTIONS = [
  { value: "conversation", label: "Conversation", desc: "Multi-turn dialogue testing" },
  { value: "single_output", label: "Single Output", desc: "One task, agent produces a final answer" },
  { value: "multi_step", label: "Multi-Step", desc: "Complex workflow with sequential tool calls" },
];

interface UploadedFile {
  name: string;
  size: number;
  file: File;
  status: "pending" | "uploading" | "done" | "error";
  error?: string;
}

interface Persona {
  persona_id: string;
  name: string;
  description: string;
  difficulty_base: number;
  hidden_goals: string[];
  is_generated: number;
}

interface ToolParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

interface ToolDraft {
  id: string;
  name: string;
  display_name: string;
  description: string;
  operation_type: string;
  collection_name: string;
  params: ToolParam[];
  seed_json: string;
  seedError: string;
}

interface TaskDraft {
  id: string;
  experiment_type: string;
  title: string;
  description: string;
  expected_tool_calls: string[];
  expected_final_state_json: string;
  stateError: string;
}

function newTaskDraft(expType: string): TaskDraft {
  return {
    id: `task-${Date.now()}`,
    experiment_type: expType,
    title: "",
    description: "",
    expected_tool_calls: [],
    expected_final_state_json: "{}",
    stateError: "",
  };
}

const DIFFICULTY_LABEL: Record<number, string> = {
  1: "Easy",
  2: "Moderate",
  3: "Challenging",
  4: "Hard",
  5: "Adversarial",
};

function newToolDraft(): ToolDraft {
  return {
    id: `tool-${Date.now()}`,
    name: "",
    display_name: "",
    description: "",
    operation_type: "CREATE",
    collection_name: "",
    params: [{ name: "", type: "string", description: "", required: true }],
    seed_json: "",
    seedError: "",
  };
}

export default function CreateAgent() {
  const navigate = useNavigate();

  // Section 1 — Identity
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [domain, setDomain] = useState("");

  // Section 2 — System prompt
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);

  // Section 3 — Documents
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [dragging, setDragging] = useState(false);

  // Section 4 — Personas
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [genDesc, setGenDesc] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");

  // Section 5 — Experiment types & tools
  const [experimentTypes, setExperimentTypes] = useState<string[]>(["conversation"]);
  const [tools, setTools] = useState<ToolDraft[]>([]);
  const [showToolForm, setShowToolForm] = useState(false);
  const [currentTool, setCurrentTool] = useState<ToolDraft>(newToolDraft());

  // Section 6 — Tasks
  const [tasks, setTasks] = useState<TaskDraft[]>([]);
  const [showTaskForm, setShowTaskForm] = useState<string | null>(null);
  const [currentTask, setCurrentTask] = useState<TaskDraft>(newTaskDraft("single_output"));

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function uploadFileTo(agentId: string, file: File, idx: number) {
    setFiles((prev) =>
      prev.map((f, i) => (i === idx ? { ...f, status: "uploading" } : f))
    );
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch(`/api/agents/${agentId}/documents`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail ?? "Upload failed");
      }
      setFiles((prev) =>
        prev.map((f, i) => (i === idx ? { ...f, status: "done" } : f))
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setFiles((prev) =>
        prev.map((f, i) => (i === idx ? { ...f, status: "error", error: msg } : f))
      );
    }
  }

  function addFiles(incoming: FileList | null) {
    if (!incoming) return;
    const newEntries: UploadedFile[] = Array.from(incoming).map((f) => ({
      name: f.name,
      size: f.size,
      file: f,
      status: "pending",
    }));
    setFiles((prev) => [...prev, ...newEntries]);
  }

  function removeFile(idx: number) {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleGenerate() {
    if (!genDesc.trim()) return;
    setGenerating(true);
    setGenError("");
    const placeholder: Persona = {
      persona_id: `pending-${Date.now()}`,
      name: genDesc.slice(0, 40) + (genDesc.length > 40 ? "…" : ""),
      description: genDesc,
      difficulty_base: 2,
      hidden_goals: [],
      is_generated: 1,
    };
    setPersonas((prev) => [...prev, placeholder]);
    setGenDesc("");
    setGenerating(false);
  }

  function removePersona(id: string) {
    setPersonas((prev) => prev.filter((p) => p.persona_id !== id));
  }

  function toggleExperimentType(val: string) {
    setExperimentTypes((prev) =>
      prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]
    );
  }

  // ── Tool builder ────────────────────────────────────────────────────────────

  function updateToolField<K extends keyof ToolDraft>(field: K, value: ToolDraft[K]) {
    setCurrentTool((prev) => ({ ...prev, [field]: value }));
  }

  function addParam() {
    setCurrentTool((prev) => ({
      ...prev,
      params: [...prev.params, { name: "", type: "string", description: "", required: false }],
    }));
  }

  function updateParam(idx: number, field: keyof ToolParam, value: string | boolean) {
    setCurrentTool((prev) => ({
      ...prev,
      params: prev.params.map((p, i) => (i === idx ? { ...p, [field]: value } : p)),
    }));
  }

  function removeParam(idx: number) {
    setCurrentTool((prev) => ({
      ...prev,
      params: prev.params.filter((_, i) => i !== idx),
    }));
  }

  function saveTool() {
    // Validate seed JSON if provided
    let seedError = "";
    if (currentTool.seed_json.trim()) {
      try {
        const parsed = JSON.parse(currentTool.seed_json);
        if (!Array.isArray(parsed)) seedError = "Seed data must be a JSON array";
      } catch {
        seedError = "Invalid JSON";
      }
    }
    if (seedError) {
      setCurrentTool((prev) => ({ ...prev, seedError }));
      return;
    }
    if (!currentTool.name.trim() || !currentTool.display_name.trim() || !currentTool.collection_name.trim()) {
      setCurrentTool((prev) => ({ ...prev, seedError: "Name, display name, and collection are required" }));
      return;
    }
    setTools((prev) => {
      const existing = prev.findIndex((t) => t.id === currentTool.id);
      if (existing >= 0) {
        return prev.map((t, i) => (i === existing ? currentTool : t));
      }
      return [...prev, currentTool];
    });
    setCurrentTool(newToolDraft());
    setShowToolForm(false);
  }

  function removeTool(id: string) {
    setTools((prev) => prev.filter((t) => t.id !== id));
  }

  function editTool(tool: ToolDraft) {
    setCurrentTool(tool);
    setShowToolForm(true);
  }

  // ── Task builder ────────────────────────────────────────────────────────────

  function saveTask() {
    let stateError = "";
    try {
      JSON.parse(currentTask.expected_final_state_json || "{}");
    } catch {
      stateError = "Invalid JSON for expected final state";
    }
    if (!currentTask.title.trim() || !currentTask.description.trim()) {
      setCurrentTask((prev) => ({ ...prev, stateError: "Title and description are required" }));
      return;
    }
    if (stateError) {
      setCurrentTask((prev) => ({ ...prev, stateError }));
      return;
    }
    setTasks((prev) => {
      const existing = prev.findIndex((t) => t.id === currentTask.id);
      if (existing >= 0) return prev.map((t, i) => (i === existing ? currentTask : t));
      return [...prev, currentTask];
    });
    setShowTaskForm(null);
  }

  function editTask(task: TaskDraft) {
    setCurrentTask(task);
    setShowTaskForm(task.experiment_type);
  }

  function removeTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function addExpectedToolCall(toolName: string) {
    if (!toolName || currentTask.expected_tool_calls.includes(toolName)) return;
    setCurrentTask((prev) => ({
      ...prev,
      expected_tool_calls: [...prev.expected_tool_calls, toolName],
    }));
  }

  function removeExpectedToolCall(toolName: string) {
    setCurrentTask((prev) => ({
      ...prev,
      expected_tool_calls: prev.expected_tool_calls.filter((t) => t !== toolName),
    }));
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setSubmitError("Agent name is required.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");

    try {
      // 1. Create the agent
      const agentRes = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          domain: domain.trim(),
          initial_prompt: prompt.trim() || undefined,
          experiment_types: experimentTypes.length > 0 ? experimentTypes : ["conversation"],
        }),
      });
      if (!agentRes.ok) {
        const err = await agentRes.json().catch(() => ({}));
        throw new Error(err.detail ?? "Failed to create agent");
      }
      const { agent_id } = await agentRes.json();

      // 2. Upload documents
      await Promise.all(
        files.map((f, idx) => uploadFileTo(agent_id, f.file, idx))
      );

      // 3. Generate and save queued personas
      for (const p of personas) {
        if (p.persona_id.startsWith("pending-")) {
          try {
            await fetch(`/api/agents/${agent_id}/personas/generate`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ description: p.description }),
            });
          } catch {
            // non-fatal
          }
        }
      }

      // 4. Save sandbox tools
      for (const tool of tools) {
        const properties: Record<string, object> = {};
        const required: string[] = [];
        for (const p of tool.params) {
          if (!p.name.trim()) continue;
          properties[p.name] = { type: p.type, description: p.description };
          if (p.required) required.push(p.name);
        }
        let seedRecords: object[] = [];
        if (tool.seed_json.trim()) {
          try { seedRecords = JSON.parse(tool.seed_json); } catch { /* skip */ }
        }
        try {
          await fetch(`/api/agents/${agent_id}/tools`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: tool.name.trim(),
              display_name: tool.display_name.trim(),
              description: tool.description.trim(),
              operation_type: tool.operation_type,
              collection_name: tool.collection_name.trim(),
              input_schema: { type: "object", properties, required },
              seed_records: seedRecords,
            }),
          });
        } catch {
          // non-fatal
        }
      }

      // 5. Save tasks
      for (const task of tasks) {
        let finalState = {};
        try { finalState = JSON.parse(task.expected_final_state_json || "{}"); } catch { /* skip */ }
        try {
          await fetch(`/api/agents/${agent_id}/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              experiment_type: task.experiment_type,
              title: task.title,
              description: task.description,
              expected_tool_calls: task.expected_tool_calls,
              expected_final_state: finalState,
            }),
          });
        } catch {
          // non-fatal
        }
      }

      navigate(`/agents/${agent_id}/sessions`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitError(msg);
      setSubmitting(false);
    }
  }

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const sectionClass = "bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4";
  const labelClass = "block text-sm font-medium text-gray-300 mb-1.5";
  const inputClass =
    "w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500";

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      {/* Back link */}
      <button
        type="button"
        onClick={() => navigate("/")}
        className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        ← Back to Agent Library
      </button>

      <div>
        <h1 className="text-2xl font-bold text-white">New Agent</h1>
        <p className="text-gray-400 text-sm mt-1">
          Configure your agent's identity, system prompt, knowledge base, test personas, and sandbox tools.
        </p>
      </div>

      {/* ── Section 1: Identity ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">Identity</h2>

        <div>
          <label className={labelClass}>
            Agent name <span className="text-red-400">*</span>
          </label>
          <input
            className={inputClass}
            placeholder="e.g. HR Onboarding Assistant"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </div>

        <div>
          <label className={labelClass}>Description</label>
          <input
            className={inputClass}
            placeholder="Short description of what this agent does"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Domain</label>
          <input
            className={inputClass}
            placeholder="e.g. HR Onboarding, Customer Support, Legal"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
      </div>

      {/* ── Section 2: System prompt ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">System Prompt</h2>
        <p className="text-xs text-gray-500">
          The initial instructions for your agent. The optimizer will iterate on
          this prompt to improve performance.
        </p>
        <textarea
          className={`${inputClass} font-mono text-xs leading-relaxed resize-y`}
          rows={12}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </div>

      {/* ── Section 3: Documents ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">Knowledge Base</h2>
        <p className="text-xs text-gray-500">
          Upload documents your agent can reference when answering questions.
          Supports .txt, .md, .pdf files.
        </p>

        {/* Dropzone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            dragging
              ? "border-indigo-500 bg-indigo-950/30"
              : "border-gray-700 hover:border-gray-600"
          }`}
        >
          <p className="text-sm text-gray-400">
            Drag & drop files here, or{" "}
            <span className="text-indigo-400">browse</span>
          </p>
          <p className="text-xs text-gray-600 mt-1">TXT · MD · PDF</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
            className="hidden"
            onChange={(e) => addFiles(e.target.files)}
          />
        </div>

        {files.length > 0 && (
          <ul className="space-y-2">
            {files.map((f, i) => (
              <li
                key={i}
                className="flex items-center justify-between bg-gray-800 rounded-md px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-300 truncate">{f.name}</span>
                  <span className="text-gray-600 text-xs shrink-0">
                    {(f.size / 1024).toFixed(1)} KB
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {f.status === "done" && (
                    <span className="text-emerald-400 text-xs">✓ Ready</span>
                  )}
                  {f.status === "error" && (
                    <span className="text-red-400 text-xs" title={f.error}>
                      ✗ Error
                    </span>
                  )}
                  {f.status === "uploading" && (
                    <span className="text-indigo-400 text-xs animate-pulse">
                      Uploading…
                    </span>
                  )}
                  {(f.status === "pending" || f.status === "error") && (
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      className="text-gray-600 hover:text-gray-400 text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Section 4: Personas ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">Test Personas</h2>
        <p className="text-xs text-gray-500">
          Describe user types to test against. Claude will generate detailed
          behavioral instructions for each. You can add more after creation.
        </p>

        <div className="flex gap-2">
          <input
            className={`${inputClass} flex-1`}
            placeholder="e.g. A senior engineer who is impatient and hates jargon"
            value={genDesc}
            onChange={(e) => setGenDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleGenerate(); } }}
          />
          <button
            type="button"
            onClick={handleGenerate}
            disabled={generating || !genDesc.trim()}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-md transition-colors shrink-0"
          >
            {generating ? "…" : "+ Add"}
          </button>
        </div>
        {genError && <p className="text-red-400 text-xs">{genError}</p>}

        {personas.length > 0 && (
          <ul className="space-y-2">
            {personas.map((p) => (
              <li
                key={p.persona_id}
                className="flex items-center justify-between bg-gray-800 rounded-md px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-300 truncate">{p.name}</span>
                    {p.is_generated === 1 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-900/60 text-indigo-300 border border-indigo-700 shrink-0">
                        AI
                      </span>
                    )}
                    <span className="text-xs text-gray-600 shrink-0">
                      {DIFFICULTY_LABEL[p.difficulty_base] ?? `Lvl ${p.difficulty_base}`}
                    </span>
                  </div>
                  {p.description && p.persona_id.startsWith("pending-") && (
                    <p className="text-gray-500 text-xs truncate mt-0.5">
                      Will be generated on save
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => removePersona(p.persona_id)}
                  className="text-gray-600 hover:text-gray-400 text-xs ml-3 shrink-0"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Section 5: Experiment Types & Tools ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">Experiment Types & Sandbox Tools</h2>
        <p className="text-xs text-gray-500">
          Choose what types of experiments to run. Add sandbox tools if your agent should interact
          with structured data (invoices, customers, orders, etc.).
        </p>

        {/* Experiment type checkboxes */}
        <div>
          <label className={labelClass}>Experiment Types</label>
          <div className="space-y-2">
            {EXPERIMENT_TYPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-start gap-3 cursor-pointer group"
              >
                <input
                  type="checkbox"
                  checked={experimentTypes.includes(opt.value)}
                  onChange={() => toggleExperimentType(opt.value)}
                  className="mt-0.5 accent-indigo-500"
                />
                <div>
                  <span className="text-sm text-gray-200 font-medium">{opt.label}</span>
                  <span className="text-xs text-gray-500 ml-2">{opt.desc}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Tool list */}
        {tools.length > 0 && (
          <div>
            <label className={`${labelClass} mb-2`}>Sandbox Tools</label>
            <ul className="space-y-2">
              {tools.map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between bg-gray-800 rounded-md px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <span className="text-gray-200 font-medium">{t.display_name}</span>
                    <span className="text-gray-500 text-xs ml-2">{t.operation_type}</span>
                    <span className="text-gray-600 text-xs ml-2">→ {t.collection_name}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => editTool(t)}
                      className="text-indigo-400 hover:text-indigo-300 text-xs"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeTool(t.id)}
                      className="text-gray-600 hover:text-gray-400 text-xs"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Add tool button */}
        {!showToolForm && (
          <button
            type="button"
            onClick={() => { setCurrentTool(newToolDraft()); setShowToolForm(true); }}
            className="px-3 py-2 border border-gray-700 hover:border-gray-600 text-gray-400 hover:text-gray-300 text-sm rounded-md transition-colors"
          >
            + Add Sandbox Tool
          </button>
        )}

        {/* Tool form */}
        {showToolForm && (
          <div className="border border-gray-700 rounded-lg p-4 space-y-3 bg-gray-800/50">
            <h3 className="text-sm font-medium text-gray-200">
              {tools.some((t) => t.id === currentTool.id) ? "Edit Tool" : "New Tool"}
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Tool Name <span className="text-gray-600">(snake_case)</span>
                </label>
                <input
                  className={inputClass}
                  placeholder="e.g. create_invoice"
                  value={currentTool.name}
                  onChange={(e) => updateToolField("name", e.target.value.replace(/\s+/g, "_").toLowerCase())}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">Display Name</label>
                <input
                  className={inputClass}
                  placeholder="e.g. Create Invoice"
                  value={currentTool.display_name}
                  onChange={(e) => updateToolField("display_name", e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1">Description</label>
              <input
                className={inputClass}
                placeholder="What this tool does"
                value={currentTool.description}
                onChange={(e) => updateToolField("description", e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Operation Type</label>
                <select
                  className={inputClass}
                  value={currentTool.operation_type}
                  onChange={(e) => updateToolField("operation_type", e.target.value)}
                >
                  {OPERATION_TYPES.map((op) => (
                    <option key={op.value} value={op.value}>{op.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  Collection Name <span className="text-gray-600">(e.g. invoices, customers)</span>
                </label>
                <input
                  className={inputClass}
                  placeholder="e.g. invoices"
                  value={currentTool.collection_name}
                  onChange={(e) => updateToolField("collection_name", e.target.value.toLowerCase())}
                />
              </div>
            </div>

            {/* Parameters */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs text-gray-400">Input Parameters</label>
                <button
                  type="button"
                  onClick={addParam}
                  className="text-xs text-indigo-400 hover:text-indigo-300"
                >
                  + Add parameter
                </button>
              </div>
              <div className="space-y-2">
                {currentTool.params.map((param, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="param_name"
                      value={param.name}
                      onChange={(e) => updateParam(idx, "name", e.target.value)}
                    />
                    <select
                      className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none"
                      value={param.type}
                      onChange={(e) => updateParam(idx, "type", e.target.value)}
                    >
                      <option value="string">string</option>
                      <option value="number">number</option>
                      <option value="boolean">boolean</option>
                      <option value="object">object</option>
                      <option value="array">array</option>
                    </select>
                    <input
                      className="flex-[2] bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                      placeholder="Description"
                      value={param.description}
                      onChange={(e) => updateParam(idx, "description", e.target.value)}
                    />
                    <label className="flex items-center gap-1 text-xs text-gray-500 shrink-0">
                      <input
                        type="checkbox"
                        checked={param.required}
                        onChange={(e) => updateParam(idx, "required", e.target.checked)}
                        className="accent-indigo-500"
                      />
                      req
                    </label>
                    <button
                      type="button"
                      onClick={() => removeParam(idx)}
                      className="text-gray-600 hover:text-gray-400 text-xs shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Seed data */}
            <div>
              <label className="block text-xs text-gray-400 mb-1">
                Seed Data <span className="text-gray-600">(JSON array, optional)</span>
              </label>
              <textarea
                className={`${inputClass} font-mono text-xs resize-y`}
                rows={4}
                placeholder={`[\n  {"id": "INV-0001", "amount": 1500, "status": "pending"}\n]`}
                value={currentTool.seed_json}
                onChange={(e) => updateToolField("seed_json", e.target.value)}
              />
              {currentTool.seedError && (
                <p className="text-red-400 text-xs mt-1">{currentTool.seedError}</p>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={saveTool}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition-colors"
              >
                Save Tool
              </button>
              <button
                type="button"
                onClick={() => setShowToolForm(false)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium rounded transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Section 6: Tasks (visible when task experiment types are selected) ── */}
      {(experimentTypes.includes("single_output") || experimentTypes.includes("multi_step")) && (
        <div className={sectionClass}>
          <h2 className="text-base font-semibold text-white">Task Configuration</h2>
          <p className="text-xs text-gray-500">
            Define tasks for your task-based experiment types. You can also add tasks after creating the agent.
          </p>

          {["single_output", "multi_step"].filter((et) => experimentTypes.includes(et)).map((expType) => {
            const typeTasks = tasks.filter((t) => t.experiment_type === expType);
            const typeLabel = expType === "single_output" ? "Single Output" : "Multi-Step";

            return (
              <div key={expType} className="space-y-3">
                <h3 className="text-sm font-medium text-gray-300">{typeLabel} Tasks</h3>

                {typeTasks.length > 0 && (
                  <ul className="space-y-2">
                    {typeTasks.map((task) => (
                      <li key={task.id} className="flex items-center justify-between bg-gray-800 rounded-md px-3 py-2 text-sm">
                        <div className="min-w-0">
                          <span className="text-gray-200 font-medium truncate">{task.title}</span>
                          {task.expected_tool_calls.length > 0 && (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {task.expected_tool_calls.map((tc) => (
                                <span key={tc} className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">{tc}</span>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-3">
                          <button type="button" onClick={() => editTask(task)} className="text-indigo-400 hover:text-indigo-300 text-xs">Edit</button>
                          <button type="button" onClick={() => removeTask(task.id)} className="text-gray-600 hover:text-gray-400 text-xs">✕</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {showTaskForm === expType && currentTask.experiment_type === expType && (
                  <div className="border border-gray-700 rounded-lg p-4 space-y-3 bg-gray-800/50">
                    <h4 className="text-xs font-medium text-gray-300">
                      {tasks.some((t) => t.id === currentTask.id) ? "Edit Task" : `New ${typeLabel} Task`}
                    </h4>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Title</label>
                      <input
                        className={inputClass}
                        placeholder="Short task title"
                        value={currentTask.title}
                        onChange={(e) => setCurrentTask((prev) => ({ ...prev, title: e.target.value }))}
                        maxLength={120}
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Task Description</label>
                      <textarea
                        className={`${inputClass} text-xs resize-y`}
                        rows={4}
                        placeholder="Full task description given to the agent."
                        value={currentTask.description}
                        onChange={(e) => setCurrentTask((prev) => ({ ...prev, description: e.target.value }))}
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Expected Tool Calls</label>
                      <div className="flex gap-2 mb-2">
                        <select
                          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none"
                          defaultValue=""
                          onChange={(e) => { addExpectedToolCall(e.target.value); e.target.value = ""; }}
                        >
                          <option value="" disabled>Select tool to add…</option>
                          {tools.map((t) => (
                            <option key={t.id} value={t.name}>{t.display_name || t.name}</option>
                          ))}
                        </select>
                      </div>
                      {currentTask.expected_tool_calls.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {currentTask.expected_tool_calls.map((tc) => (
                            <span key={tc} className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-indigo-900/50 text-indigo-300 border border-indigo-700">
                              {tc}
                              <button type="button" onClick={() => removeExpectedToolCall(tc)} className="text-indigo-400 hover:text-white">×</button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Expected Final State (JSON, optional)</label>
                      <textarea
                        className={`${inputClass} font-mono text-xs resize-y`}
                        rows={3}
                        placeholder={`{"collection": "description of expected state"}`}
                        value={currentTask.expected_final_state_json}
                        onChange={(e) => setCurrentTask((prev) => ({ ...prev, expected_final_state_json: e.target.value }))}
                      />
                      {currentTask.stateError && <p className="text-red-400 text-xs mt-1">{currentTask.stateError}</p>}
                    </div>

                    <div className="flex gap-2">
                      <button type="button" onClick={saveTask} className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition-colors">Save Task</button>
                      <button type="button" onClick={() => setShowTaskForm(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium rounded transition-colors">Cancel</button>
                    </div>
                  </div>
                )}

                {showTaskForm !== expType && (
                  <button
                    type="button"
                    onClick={() => { setCurrentTask(newTaskDraft(expType)); setShowTaskForm(expType); }}
                    className="px-3 py-2 border border-gray-700 hover:border-gray-600 text-gray-400 hover:text-gray-300 text-xs rounded-md transition-colors"
                  >
                    + Add {typeLabel} Task
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Submit ── */}
      {submitError && (
        <p className="text-red-400 text-sm">{submitError}</p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-md transition-colors"
        >
          {submitting ? "Creating…" : "Create Agent"}
        </button>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="px-5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-md transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
