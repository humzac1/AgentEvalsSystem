import { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";

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

const DIFFICULTY_LABEL: Record<number, string> = {
  1: "Easy",
  2: "Moderate",
  3: "Challenging",
  4: "Hard",
  5: "Adversarial",
};

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExistingDocument {
  doc_id: string;
  filename: string;
  file_type: string;
  uploaded_at: string;
  file_size_bytes: number;
}

interface Persona {
  persona_id: string;
  name: string;
  description: string;
  behavioral_instructions: string;
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
  id: string; // client-side only key
  tool_id?: string; // server-assigned ID for existing tools
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
  id: string; // client-side key
  task_id?: string; // server-assigned ID for existing tasks
  experiment_type: string;
  title: string;
  description: string;
  expected_tool_calls: string[];
  expected_final_state_json: string;
  stateError: string;
}

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

// ── Main Component ─────────────────────────────────────────────────────────────

export default function EditAgent() {
  const { agentId } = useParams<{ agentId: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitSuccess, setSubmitSuccess] = useState(false);

  // Section 1 — Identity
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [domain, setDomain] = useState("");

  // Section 2 — System prompt
  const [prompt, setPrompt] = useState("");
  const [promptChangeSummary, setPromptChangeSummary] = useState("");
  const [promptOriginal, setPromptOriginal] = useState("");

  // Section 3 — Documents
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [existingDocs, setExistingDocs] = useState<ExistingDocument[]>([]);
  const [newFiles, setNewFiles] = useState<{ name: string; size: number; file: File }[]>([]);
  const [dragging, setDragging] = useState(false);

  // Section 4 — Personas
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [genDesc, setGenDesc] = useState("");
  const [generating, setGenerating] = useState(false);
  const [expandedPersona, setExpandedPersona] = useState<string | null>(null);
  const [personaEdits, setPersonaEdits] = useState<Record<string, Partial<Persona>>>({});

  // Section 5 — Experiment types & tools
  const [experimentTypes, setExperimentTypes] = useState<string[]>(["conversation"]);
  const [tools, setTools] = useState<ToolDraft[]>([]);
  const [showToolForm, setShowToolForm] = useState(false);
  const [currentTool, setCurrentTool] = useState<ToolDraft>(newToolDraft());

  // Section 6 — Tasks (visible when single_output or multi_step selected)
  const [tasks, setTasks] = useState<TaskDraft[]>([]);
  const [showTaskForm, setShowTaskForm] = useState<string | null>(null); // expType or null
  const [currentTask, setCurrentTask] = useState<TaskDraft>(newTaskDraft("single_output"));
  const [generatingTasks, setGeneratingTasks] = useState<string | null>(null);

  // ── Load config ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!agentId) return;
    fetch(`/api/agents/${agentId}/config`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setName(data.name ?? "");
        setDescription(data.description ?? "");
        setDomain(data.domain ?? "");
        setExperimentTypes(data.experiment_types ?? ["conversation"]);

        const activePrompt = data.active_prompt?.prompt_text ?? "";
        setPrompt(activePrompt);
        setPromptOriginal(activePrompt);

        setExistingDocs(data.documents ?? []);
        setPersonas(data.personas ?? []);

        // Convert server tools to ToolDraft shape
        const serverTools: ToolDraft[] = (data.tools ?? []).map(
          (t: {
            tool_id: string;
            name: string;
            display_name: string;
            description: string;
            operation_type: string;
            collection_name: string;
            input_schema: { properties?: Record<string, { type: string; description: string }>; required?: string[] };
            seed_data?: { records?: object[] }[];
          }) => {
            const props = t.input_schema?.properties ?? {};
            const reqFields = t.input_schema?.required ?? [];
            const params: ToolParam[] = Object.entries(props).map(([pname, pval]) => ({
              name: pname,
              type: (pval as { type: string }).type ?? "string",
              description: (pval as { description: string }).description ?? "",
              required: reqFields.includes(pname),
            }));
            const seedRecords = t.seed_data?.[0]?.records ?? [];
            return {
              id: t.tool_id,
              tool_id: t.tool_id,
              name: t.name,
              display_name: t.display_name,
              description: t.description,
              operation_type: t.operation_type,
              collection_name: t.collection_name,
              params: params.length > 0 ? params : [{ name: "", type: "string", description: "", required: true }],
              seed_json: seedRecords.length > 0 ? JSON.stringify(seedRecords, null, 2) : "",
              seedError: "",
            };
          }
        );
        setTools(serverTools);

        // Convert server tasks to TaskDraft shape
        const serverTasks: TaskDraft[] = (data.tasks ?? []).map(
          (t: {
            task_id: string;
            experiment_type: string;
            title: string;
            description: string;
            expected_tool_calls: string[];
            expected_final_state: object;
          }) => ({
            id: t.task_id,
            task_id: t.task_id,
            experiment_type: t.experiment_type,
            title: t.title,
            description: t.description,
            expected_tool_calls: t.expected_tool_calls ?? [],
            expected_final_state_json: JSON.stringify(t.expected_final_state ?? {}, null, 2),
            stateError: "",
          })
        );
        setTasks(serverTasks);

        setLoading(false);
      })
      .catch((e) => {
        setLoadError(e.message);
        setLoading(false);
      });
  }, [agentId]);

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function toggleExperimentType(val: string) {
    setExperimentTypes((prev) =>
      prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]
    );
  }

  function addNewFiles(incoming: FileList | null) {
    if (!incoming) return;
    const entries = Array.from(incoming).map((f) => ({ name: f.name, size: f.size, file: f }));
    setNewFiles((prev) => [...prev, ...entries]);
  }

  async function deleteExistingDoc(docId: string) {
    await fetch(`/api/agents/${agentId}/documents/${docId}`, { method: "DELETE" });
    setExistingDocs((prev) => prev.filter((d) => d.doc_id !== docId));
  }

  async function generatePersona() {
    if (!genDesc.trim()) return;
    setGenerating(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/personas/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: genDesc }),
      });
      if (!res.ok) throw new Error("Generation failed");
      const p = await res.json();
      setPersonas((prev) => [
        ...prev,
        {
          persona_id: p.persona_id,
          name: p.name,
          description: p.description,
          behavioral_instructions: "",
          difficulty_base: p.difficulty_base,
          hidden_goals: p.hidden_goals ?? [],
          is_generated: 1,
        },
      ]);
      setGenDesc("");
    } catch {
      // non-fatal
    } finally {
      setGenerating(false);
    }
  }

  async function deletePersona(personaId: string) {
    await fetch(`/api/agents/${agentId}/personas/${personaId}`, { method: "DELETE" });
    setPersonas((prev) => prev.filter((p) => p.persona_id !== personaId));
  }

  // ── Tool builder ─────────────────────────────────────────────────────────────

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
    let seedError = "";
    if (currentTool.seed_json.trim()) {
      try {
        const parsed = JSON.parse(currentTool.seed_json);
        if (!Array.isArray(parsed)) seedError = "Seed data must be a JSON array";
      } catch {
        seedError = "Invalid JSON";
      }
    }
    if (!currentTool.name.trim() || !currentTool.display_name.trim() || !currentTool.collection_name.trim()) {
      setCurrentTool((prev) => ({ ...prev, seedError: "Name, display name, and collection are required" }));
      return;
    }
    if (seedError) {
      setCurrentTool((prev) => ({ ...prev, seedError }));
      return;
    }
    setTools((prev) => {
      const existing = prev.findIndex((t) => t.id === currentTool.id);
      if (existing >= 0) return prev.map((t, i) => (i === existing ? currentTool : t));
      return [...prev, currentTool];
    });
    setCurrentTool(newToolDraft());
    setShowToolForm(false);
  }

  function editTool(tool: ToolDraft) {
    setCurrentTool(tool);
    setShowToolForm(true);
  }

  function removeTool(id: string) {
    setTools((prev) => prev.filter((t) => t.id !== id));
  }

  // ── Task builder ─────────────────────────────────────────────────────────────

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

  async function autoGenerateTasks(expType: string) {
    setGeneratingTasks(expType);
    try {
      const res = await fetch(`/api/agents/${agentId}/tasks/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experiment_type: expType, count: 3 }),
      });
      if (!res.ok) throw new Error("Generation failed");
      const data = await res.json();
      // Reload tasks from server since they were saved
      const tasksRes = await fetch(`/api/agents/${agentId}/tasks`);
      const tasksData = await tasksRes.json();
      const serverTasks: TaskDraft[] = (tasksData.tasks ?? []).map(
        (t: {
          task_id: string;
          experiment_type: string;
          title: string;
          description: string;
          expected_tool_calls: string[];
          expected_final_state: object;
        }) => ({
          id: t.task_id,
          task_id: t.task_id,
          experiment_type: t.experiment_type,
          title: t.title,
          description: t.description,
          expected_tool_calls: t.expected_tool_calls ?? [],
          expected_final_state_json: JSON.stringify(t.expected_final_state ?? {}, null, 2),
          stateError: "",
        })
      );
      setTasks(serverTasks);
      void data;
    } catch {
      // non-fatal
    } finally {
      setGeneratingTasks(null);
    }
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

  // ── Save all ─────────────────────────────────────────────────────────────────

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setSubmitError("Agent name is required.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    setSubmitSuccess(false);

    try {
      // 1. Update identity + experiment types
      const identRes = await fetch(`/api/agents/${agentId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          domain: domain.trim(),
          experiment_types: experimentTypes.length > 0 ? experimentTypes : ["conversation"],
        }),
      });
      if (!identRes.ok) throw new Error("Failed to update agent identity");

      // 2. Update system prompt if changed
      if (prompt.trim() !== promptOriginal.trim()) {
        const promptRes = await fetch(`/api/agents/${agentId}/prompt-versions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt_text: prompt.trim(),
            change_summary: promptChangeSummary.trim() || "Manual edit",
          }),
        });
        if (!promptRes.ok) throw new Error("Failed to save prompt version");
        setPromptOriginal(prompt.trim());
        setPromptChangeSummary("");
      }

      // 3. Upload new documents
      for (const f of newFiles) {
        const fd = new FormData();
        fd.append("file", f.file);
        await fetch(`/api/agents/${agentId}/documents`, { method: "POST", body: fd });
      }
      setNewFiles([]);

      // 4. Save tools (upsert each — POST for new, PUT for existing)
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
        const body = {
          name: tool.name.trim(),
          display_name: tool.display_name.trim(),
          description: tool.description.trim(),
          operation_type: tool.operation_type,
          collection_name: tool.collection_name.trim(),
          input_schema: { type: "object", properties, required },
          seed_records: seedRecords,
        };
        if (tool.tool_id) {
          await fetch(`/api/agents/${agentId}/tools/${tool.tool_id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } else {
          const res = await fetch(`/api/agents/${agentId}/tools`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            const data = await res.json();
            setTools((prev) => prev.map((t) => t.id === tool.id ? { ...t, tool_id: data.tool_id } : t));
          }
        }
      }

      // 5. Save tasks (upsert each)
      for (const task of tasks) {
        let finalState = {};
        try { finalState = JSON.parse(task.expected_final_state_json || "{}"); } catch { /* skip */ }
        const body = {
          experiment_type: task.experiment_type,
          title: task.title,
          description: task.description,
          expected_tool_calls: task.expected_tool_calls,
          expected_final_state: finalState,
        };
        if (task.task_id) {
          await fetch(`/api/agents/${agentId}/tasks/${task.task_id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } else {
          const res = await fetch(`/api/agents/${agentId}/tasks`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (res.ok) {
            const data = await res.json();
            setTasks((prev) => prev.map((t) => t.id === task.id ? { ...t, task_id: data.task_id } : t));
          }
        }
      }

      setSubmitSuccess(true);
      setTimeout(() => setSubmitSuccess(false), 3000);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const sectionClass = "bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4";
  const labelClass = "block text-sm font-medium text-gray-300 mb-1.5";
  const inputClass =
    "w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500";

  if (loading) {
    return (
      <div className="max-w-3xl">
        <p className="text-gray-400 text-sm animate-pulse">Loading agent config…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="max-w-3xl">
        <p className="text-red-400 text-sm">Error loading agent: {loadError}</p>
      </div>
    );
  }

  const hasTaskTypes = experimentTypes.includes("single_output") || experimentTypes.includes("multi_step");

  return (
    <form onSubmit={handleSave} className="space-y-6 max-w-3xl">
      {/* Back */}
      <button
        type="button"
        onClick={() => navigate(`/agents/${agentId}/sessions`)}
        className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
      >
        ← Back to Sessions
      </button>

      <div>
        <h1 className="text-2xl font-bold text-white">Edit Agent</h1>
        <p className="text-gray-400 text-sm mt-1">
          Update identity, prompt, knowledge base, personas, tools, and tasks.
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
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
          />
        </div>

        <div>
          <label className={labelClass}>Description</label>
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div>
          <label className={labelClass}>Domain</label>
          <input
            className={inputClass}
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
      </div>

      {/* ── Section 2: System prompt ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">System Prompt</h2>
        <p className="text-xs text-gray-500">
          Editing this will create a new prompt version and set it as active.
        </p>
        <textarea
          className={`${inputClass} font-mono text-xs leading-relaxed resize-y`}
          rows={12}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        {prompt !== promptOriginal && (
          <div>
            <label className={labelClass}>Change summary (optional)</label>
            <input
              className={inputClass}
              placeholder="e.g. Improved instructions for tool usage"
              value={promptChangeSummary}
              onChange={(e) => setPromptChangeSummary(e.target.value)}
            />
          </div>
        )}
      </div>

      {/* ── Section 3: Documents ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">Knowledge Base</h2>

        {existingDocs.length > 0 && (
          <ul className="space-y-2">
            {existingDocs.map((doc) => (
              <li
                key={doc.doc_id}
                className="flex items-center justify-between bg-gray-800 rounded-md px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-gray-300 truncate">{doc.filename}</span>
                  <span className="text-gray-600 text-xs shrink-0">
                    {(doc.file_size_bytes / 1024).toFixed(1)} KB
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => deleteExistingDoc(doc.doc_id)}
                  className="text-gray-600 hover:text-red-400 text-xs ml-3 shrink-0"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* Dropzone for new files */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addNewFiles(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
            dragging ? "border-indigo-500 bg-indigo-950/30" : "border-gray-700 hover:border-gray-600"
          }`}
        >
          <p className="text-sm text-gray-400">
            Upload new document — <span className="text-indigo-400">browse</span>
          </p>
          <p className="text-xs text-gray-600 mt-1">TXT · MD · PDF</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.md,.pdf,text/plain,text/markdown,application/pdf"
            className="hidden"
            onChange={(e) => addNewFiles(e.target.files)}
          />
        </div>

        {newFiles.length > 0 && (
          <ul className="space-y-2">
            {newFiles.map((f, i) => (
              <li
                key={i}
                className="flex items-center justify-between bg-gray-800 rounded-md px-3 py-2 text-sm"
              >
                <span className="text-gray-300 truncate">{f.name}</span>
                <div className="flex items-center gap-2">
                  <span className="text-indigo-400 text-xs">Will upload on save</span>
                  <button
                    type="button"
                    onClick={() => setNewFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="text-gray-600 hover:text-gray-400 text-xs"
                  >
                    ✕
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Section 4: Personas ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">Test Personas</h2>

        {personas.length > 0 && (
          <ul className="space-y-2">
            {personas.map((p) => (
              <li key={p.persona_id} className="bg-gray-800 rounded-md text-sm">
                <div className="flex items-center justify-between px-3 py-2">
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
                    {p.description && (
                      <p className="text-gray-500 text-xs truncate mt-0.5">{p.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-3">
                    <button
                      type="button"
                      onClick={() => setExpandedPersona((prev) => (prev === p.persona_id ? null : p.persona_id))}
                      className="text-indigo-400 hover:text-indigo-300 text-xs"
                    >
                      {expandedPersona === p.persona_id ? "Collapse" : "Edit"}
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePersona(p.persona_id)}
                      className="text-gray-600 hover:text-red-400 text-xs"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Inline edit form */}
                {expandedPersona === p.persona_id && (
                  <div className="border-t border-gray-700 px-3 py-3 space-y-2">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Name</label>
                      <input
                        className={inputClass}
                        value={personaEdits[p.persona_id]?.name ?? p.name}
                        onChange={(e) =>
                          setPersonaEdits((prev) => ({
                            ...prev,
                            [p.persona_id]: { ...prev[p.persona_id], name: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Description</label>
                      <input
                        className={inputClass}
                        value={personaEdits[p.persona_id]?.description ?? p.description}
                        onChange={(e) =>
                          setPersonaEdits((prev) => ({
                            ...prev,
                            [p.persona_id]: { ...prev[p.persona_id], description: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Behavioral Instructions</label>
                      <textarea
                        className={`${inputClass} text-xs resize-y`}
                        rows={4}
                        value={personaEdits[p.persona_id]?.behavioral_instructions ?? p.behavioral_instructions}
                        onChange={(e) =>
                          setPersonaEdits((prev) => ({
                            ...prev,
                            [p.persona_id]: {
                              ...prev[p.persona_id],
                              behavioral_instructions: e.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Difficulty (1–5)</label>
                      <input
                        type="number"
                        min={1}
                        max={5}
                        className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none"
                        value={personaEdits[p.persona_id]?.difficulty_base ?? p.difficulty_base}
                        onChange={(e) =>
                          setPersonaEdits((prev) => ({
                            ...prev,
                            [p.persona_id]: {
                              ...prev[p.persona_id],
                              difficulty_base: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        const edits = personaEdits[p.persona_id] ?? {};
                        const updated = { ...p, ...edits };
                        await fetch(`/api/agents/${agentId}/personas/${p.persona_id}`, {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            name: updated.name,
                            description: updated.description,
                            behavioral_instructions: updated.behavioral_instructions,
                            difficulty_base: updated.difficulty_base,
                            hidden_goals: updated.hidden_goals,
                          }),
                        });
                        setPersonas((prev) =>
                          prev.map((x) => (x.persona_id === p.persona_id ? updated : x))
                        );
                        setPersonaEdits((prev) => {
                          const next = { ...prev };
                          delete next[p.persona_id];
                          return next;
                        });
                        setExpandedPersona(null);
                      }}
                      className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition-colors"
                    >
                      Save Persona
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <input
            className={`${inputClass} flex-1`}
            placeholder="e.g. A senior engineer who is impatient and hates jargon"
            value={genDesc}
            onChange={(e) => setGenDesc(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); generatePersona(); } }}
          />
          <button
            type="button"
            onClick={generatePersona}
            disabled={generating || !genDesc.trim()}
            className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-md transition-colors shrink-0"
          >
            {generating ? "Generating…" : "+ Generate"}
          </button>
        </div>
      </div>

      {/* ── Section 5: Experiment Types & Tools ── */}
      <div className={sectionClass}>
        <h2 className="text-base font-semibold text-white">Experiment Types & Sandbox Tools</h2>

        <div>
          <label className={labelClass}>Experiment Types</label>
          <div className="space-y-2">
            {EXPERIMENT_TYPE_OPTIONS.map((opt) => (
              <label key={opt.value} className="flex items-start gap-3 cursor-pointer">
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
                      onClick={async () => {
                        if (t.tool_id) {
                          await fetch(`/api/agents/${agentId}/tools/${t.tool_id}`, { method: "DELETE" });
                        }
                        removeTool(t.id);
                      }}
                      className="text-gray-600 hover:text-red-400 text-xs"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!showToolForm && (
          <button
            type="button"
            onClick={() => { setCurrentTool(newToolDraft()); setShowToolForm(true); }}
            className="px-3 py-2 border border-gray-700 hover:border-gray-600 text-gray-400 hover:text-gray-300 text-sm rounded-md transition-colors"
          >
            + Add Sandbox Tool
          </button>
        )}

        {showToolForm && (
          <div className="border border-gray-700 rounded-lg p-4 space-y-3 bg-gray-800/50">
            <h3 className="text-sm font-medium text-gray-200">
              {tools.some((t) => t.id === currentTool.id) ? "Edit Tool" : "New Tool"}
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Tool Name (snake_case)</label>
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
                <label className="block text-xs text-gray-400 mb-1">Collection Name</label>
                <input
                  className={inputClass}
                  placeholder="e.g. invoices"
                  value={currentTool.collection_name}
                  onChange={(e) => updateToolField("collection_name", e.target.value.toLowerCase())}
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="block text-xs text-gray-400">Input Parameters</label>
                <button type="button" onClick={addParam} className="text-xs text-indigo-400 hover:text-indigo-300">
                  + Add parameter
                </button>
              </div>
              <div className="space-y-2">
                {currentTool.params.map((param, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none"
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
                      className="flex-[2] bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white placeholder-gray-600 focus:outline-none"
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

            <div>
              <label className="block text-xs text-gray-400 mb-1">Seed Data (JSON array, optional)</label>
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

      {/* ── Section 6: Tasks ── */}
      {hasTaskTypes && (
        <div className={sectionClass}>
          <h2 className="text-base font-semibold text-white">Task Configuration</h2>
          <p className="text-xs text-gray-500">
            Define tasks for your task-based experiment types. Tasks specify what the agent must accomplish
            and what tool calls / final states are expected.
          </p>

          {["single_output", "multi_step"].filter((et) => experimentTypes.includes(et)).map((expType) => {
            const typeTasks = tasks.filter((t) => t.experiment_type === expType);
            const typeLabel = expType === "single_output" ? "Single Output" : "Multi-Step";

            return (
              <div key={expType} className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium text-gray-300">{typeLabel} Tasks</h3>
                  <button
                    type="button"
                    onClick={() => autoGenerateTasks(expType)}
                    disabled={generatingTasks === expType}
                    className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40"
                  >
                    {generatingTasks === expType ? "Generating…" : "Auto-generate 3 tasks"}
                  </button>
                </div>

                {typeTasks.length > 0 && (
                  <ul className="space-y-2">
                    {typeTasks.map((task) => (
                      <li key={task.id} className="bg-gray-800 rounded-md text-sm">
                        <div className="flex items-center justify-between px-3 py-2">
                          <div className="min-w-0">
                            <span className="text-gray-200 font-medium truncate">{task.title}</span>
                            {task.expected_tool_calls.length > 0 && (
                              <div className="flex gap-1 mt-1 flex-wrap">
                                {task.expected_tool_calls.map((tc) => (
                                  <span
                                    key={tc}
                                    className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400"
                                  >
                                    {tc}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0 ml-3">
                            <button
                              type="button"
                              onClick={() => editTask(task)}
                              className="text-indigo-400 hover:text-indigo-300 text-xs"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={async () => {
                                if (task.task_id) {
                                  await fetch(`/api/agents/${agentId}/tasks/${task.task_id}`, { method: "DELETE" });
                                }
                                removeTask(task.id);
                              }}
                              className="text-gray-600 hover:text-red-400 text-xs"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Task form for this experiment type */}
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
                        placeholder="Full task description given to the agent. Be specific about requirements."
                        value={currentTask.description}
                        onChange={(e) =>
                          setCurrentTask((prev) => ({ ...prev, description: e.target.value }))
                        }
                      />
                    </div>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Expected Tool Calls</label>
                      <div className="flex gap-2 mb-2">
                        <select
                          className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-white focus:outline-none"
                          defaultValue=""
                          onChange={(e) => {
                            addExpectedToolCall(e.target.value);
                            e.target.value = "";
                          }}
                        >
                          <option value="" disabled>Select tool to add…</option>
                          {tools.map((t) => (
                            <option key={t.id} value={t.name}>{t.display_name}</option>
                          ))}
                        </select>
                      </div>
                      {currentTask.expected_tool_calls.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {currentTask.expected_tool_calls.map((tc) => (
                            <span
                              key={tc}
                              className="flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-indigo-900/50 text-indigo-300 border border-indigo-700"
                            >
                              {tc}
                              <button
                                type="button"
                                onClick={() => removeExpectedToolCall(tc)}
                                className="text-indigo-400 hover:text-white"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <label className="block text-xs text-gray-400 mb-1">
                        Expected Final State <span className="text-gray-600">(JSON, optional)</span>
                      </label>
                      <textarea
                        className={`${inputClass} font-mono text-xs resize-y`}
                        rows={3}
                        placeholder={`{"invoices": "should contain new invoice INV-0042"}`}
                        value={currentTask.expected_final_state_json}
                        onChange={(e) =>
                          setCurrentTask((prev) => ({ ...prev, expected_final_state_json: e.target.value }))
                        }
                      />
                      {currentTask.stateError && (
                        <p className="text-red-400 text-xs mt-1">{currentTask.stateError}</p>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={saveTask}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded transition-colors"
                      >
                        Save Task
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowTaskForm(null)}
                        className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs font-medium rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {showTaskForm !== expType && (
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentTask(newTaskDraft(expType));
                      setShowTaskForm(expType);
                    }}
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
      {submitError && <p className="text-red-400 text-sm">{submitError}</p>}
      {submitSuccess && (
        <p className="text-emerald-400 text-sm">Changes saved successfully.</p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={submitting || !name.trim()}
          className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-md transition-colors"
        >
          {submitting ? "Saving…" : "Save Changes"}
        </button>
        <button
          type="button"
          onClick={() => navigate(`/agents/${agentId}/sessions`)}
          className="px-5 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-md transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
