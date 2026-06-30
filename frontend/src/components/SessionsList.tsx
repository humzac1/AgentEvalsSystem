import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Session {
  session_id: string;
  user_profile: string;
  hidden_goal: string;
  timestamp: string;
  total_score: number | null;
  trajectory_quality: string | null;
  difficulty: number | null;
  experiment_type: string | null;
  batch_role: string | null;
}

interface Task {
  task_id: string;
  title: string;
  description: string;
  experiment_type: string;
}

interface Persona {
  persona_id: string;
  name: string;
  hidden_goals: string[];
  behavioral_instructions: string;
  difficulty_base: number;
}

interface PollState {
  status: "running" | "complete" | "error";
  phase: "primary" | "generating_challenger" | "challenger";
  current_run: number;
  total_runs: number;
  persona_name: string | null;
  persona_run: number | null;
  persona_runs_total: number | null;
  cancel_requested: boolean;
  stopped_early: boolean;
  primary_complete: boolean;
  primary_avg: number | null;
  primary_goal_rate: number | null;
  primary_quality_counts: Record<string, number> | null;
  challenger_prompt_text: string | null;
  result: BatchResult | null;
  error: string | null;
}

interface BatchResult {
  total_runs: number;
  quality_counts: Record<string, number>;
  primary_avg: number;
  primary_goal_rate?: number;
  challenger_avg?: number;
  challenger_goal_rate?: number;
  delta?: number;
  decision?: "challenger_wins" | "challenger_loses" | "rejected_zero_goals";
  challenger_prompt_text?: string;
  optimizer_enabled: boolean;
}

const PROFILE_BADGE: Record<string, { label: string; classes: string }> = {
  confused_novice: {
    label: "Confused Novice",
    classes: "bg-emerald-900/60 text-emerald-300 border border-emerald-700",
  },
  impatient_expert: {
    label: "Impatient Expert",
    classes: "bg-yellow-900/60 text-yellow-300 border border-yellow-700",
  },
  adversarial_user: {
    label: "Adversarial",
    classes: "bg-red-900/60 text-red-300 border border-red-700",
  },
};

const QUALITY_BADGE: Record<string, { label: string; classes: string }> = {
  high: { label: "High", classes: "bg-emerald-900/60 text-emerald-300" },
  medium: { label: "Medium", classes: "bg-yellow-900/60 text-yellow-300" },
  low: { label: "Low", classes: "bg-red-900/60 text-red-300" },
};

const EXPERIMENT_TYPE_BADGE: Record<string, { label: string; classes: string }> = {
  conversation: {
    label: "Conv",
    classes: "bg-blue-900/60 text-blue-300 border border-blue-700",
  },
  single_output: {
    label: "Output",
    classes: "bg-orange-900/60 text-orange-300 border border-orange-700",
  },
  multi_step: {
    label: "Multi",
    classes: "bg-purple-900/60 text-purple-300 border border-purple-700",
  },
};

function ProfileBadge({ profile }: { profile: string }) {
  const badge = PROFILE_BADGE[profile] ?? {
    label: profile,
    classes: "bg-gray-800 text-gray-300",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.classes}`}>
      {badge.label}
    </span>
  );
}

function QualityBadge({ quality }: { quality: string | null }) {
  if (!quality) return <span className="text-gray-600 text-xs">—</span>;
  const badge = QUALITY_BADGE[quality] ?? { label: quality, classes: "bg-gray-800 text-gray-300" };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.classes}`}>
      {badge.label}
    </span>
  );
}

function ExperimentTypeBadge({ type }: { type: string | null }) {
  if (!type) return null;
  const badge = EXPERIMENT_TYPE_BADGE[type] ?? {
    label: type,
    classes: "bg-gray-800 text-gray-300 border border-gray-700",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${badge.classes}`}>
      {badge.label}
    </span>
  );
}

function DifficultyBadge({ difficulty }: { difficulty: number | null }) {
  if (!difficulty) return null;
  const colors = [
    "",
    "text-gray-400",
    "text-sky-400",
    "text-yellow-400",
    "text-orange-400",
    "text-red-400",
  ];
  return (
    <span className={`text-xs font-mono font-bold ml-1 ${colors[difficulty] ?? "text-gray-400"}`}>
      D{difficulty}
    </span>
  );
}

function ChallengerPill() {
  return (
    <span className="px-2 py-0.5 rounded text-xs font-medium bg-purple-900/60 text-purple-300 border border-purple-700">
      Challenger
    </span>
  );
}

function formatTs(ts: string) {
  try {
    return new Date(ts + "Z").toLocaleString();
  } catch {
    return ts;
  }
}

type QualityFilter = "all" | "high" | "medium" | "low";

// ── Run Simulation Modal ──────────────────────────────────────────────────────

const TASK_PRESETS = [1, 3, 5, 10];

const EXPERIMENT_TYPE_OPTIONS = [
  { value: "conversation", label: "Conversation", desc: "Multi-turn dialogue optimization" },
  { value: "single_output", label: "Single Output", desc: "One-shot task completion" },
  { value: "multi_step", label: "Multi-Step", desc: "Complex multi-tool task" },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function Spinner({ cls = "w-4 h-4" }: { cls?: string }) {
  return (
    <svg className={`animate-spin ${cls} text-indigo-400`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
    </svg>
  );
}

function OptimizerSection({
  enabled, onToggle, mode, onModeChange, focus, onFocusChange,
  challengerText, onChallengerTextChange, activePromptText,
}: {
  enabled: boolean;
  onToggle: () => void;
  mode: "auto" | "manual";
  onModeChange: (m: "auto" | "manual") => void;
  focus: string;
  onFocusChange: (s: string) => void;
  challengerText: string;
  onChallengerTextChange: (s: string) => void;
  activePromptText: string;
}) {
  return (
    <div className="border-t border-gray-800 pt-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-gray-300">Prompt Optimization</span>
        <button
          onClick={onToggle}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            enabled ? "bg-indigo-600" : "bg-gray-700"
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
              enabled ? "translate-x-[18px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      <p className="text-gray-600 text-xs mb-3">Test a challenger prompt after this batch</p>

      {enabled && (
        <div className="space-y-3 bg-gray-950 rounded-lg p-3 border border-gray-800">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="optimizer-mode"
              value="auto"
              checked={mode === "auto"}
              onChange={() => onModeChange("auto")}
              className="mt-0.5 accent-indigo-500 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-gray-300 font-medium">Auto-generate challenger prompt</span>
              {mode === "auto" && (
                <input
                  type="text"
                  value={focus}
                  onChange={e => onFocusChange(e.target.value)}
                  placeholder="Focus area (optional) — e.g. reduce fabrication, improve tone"
                  className="mt-1.5 w-full bg-gray-800 border border-gray-700 text-white text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:border-indigo-500"
                />
              )}
            </div>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="optimizer-mode"
              value="manual"
              checked={mode === "manual"}
              onChange={() => {
                onModeChange("manual");
                if (!challengerText && activePromptText) onChallengerTextChange(activePromptText);
              }}
              className="mt-0.5 accent-indigo-500 shrink-0"
            />
            <div className="flex-1 min-w-0">
              <span className="text-xs text-gray-300 font-medium">Write my own challenger prompt</span>
              {mode === "manual" && (
                <textarea
                  value={challengerText}
                  onChange={e => onChallengerTextChange(e.target.value)}
                  rows={6}
                  className="mt-1.5 w-full bg-gray-800 border border-gray-700 text-gray-200 text-xs font-mono rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500 resize-y"
                  placeholder="Enter challenger system prompt…"
                />
              )}
            </div>
          </label>
        </div>
      )}
    </div>
  );
}

function BatchProgressDisplay({
  pollState, isConversation, stopRequested, onStop,
}: {
  pollState: PollState | null;
  isConversation: boolean;
  stopRequested: boolean;
  onStop: () => void;
}) {
  const phase = pollState?.phase ?? "primary";
  const currentRun = pollState?.current_run ?? 0;
  const totalRuns = pollState?.total_runs ?? 0;
  const personaName = pollState?.persona_name;
  const personaRun = pollState?.persona_run;
  const personaRunsTotal = pollState?.persona_runs_total;
  const primaryAvg = pollState?.primary_avg;
  const progress = totalRuns > 0 ? (currentRun / totalRuns) * 100 : 0;

  if (phase === "generating_challenger") {
    return (
      <div className="py-6 flex flex-col items-center gap-4">
        {primaryAvg != null && (
          <div className="rounded-lg bg-gray-800 px-4 py-2 text-center">
            <p className="text-xs text-gray-400 mb-0.5">Primary batch complete</p>
            <p className="text-white font-semibold">Avg: {primaryAvg.toFixed(1)}/50</p>
          </div>
        )}
        <div className="flex items-center gap-2 text-gray-400">
          <Spinner />
          <span className="text-sm">Generating challenger prompt…</span>
        </div>
      </div>
    );
  }

  const phaseLabel = phase === "challenger" ? "Challenger batch" : "Primary batch";

  return (
    <div className="py-2 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-400">{phaseLabel}</span>
        {phase === "challenger" && primaryAvg != null && (
          <span className="text-xs text-gray-500">Primary avg: {primaryAvg.toFixed(1)}/50</span>
        )}
      </div>

      <div>
        <div className="flex justify-between text-xs text-gray-400 mb-1.5">
          <span>Running simulation {currentRun} of {totalRuns}</span>
          <span>{Math.round(progress)}%</span>
        </div>
        <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {isConversation && personaName && (
        <div className="flex items-center gap-2">
          <Spinner cls="w-3.5 h-3.5" />
          <p className="text-xs text-gray-300">
            Persona: <span className="text-white">{personaName}</span>
            {personaRun != null && personaRunsTotal != null && (
              <span className="text-gray-500"> — Run {personaRun} of {personaRunsTotal}</span>
            )}
          </p>
        </div>
      )}

      {phase === "primary" && (
        <button
          onClick={onStop}
          disabled={stopRequested}
          className="w-full py-1.5 rounded-lg bg-gray-800 text-gray-400 hover:text-white text-xs transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {stopRequested ? "Stopping after current run…" : "Stop after current run"}
        </button>
      )}
    </div>
  );
}

function BatchResultDisplay({
  result, savedChallenger, savingChallenger, onAccept, onDecline,
}: {
  result: BatchResult;
  savedChallenger: boolean;
  savingChallenger: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const { total_runs, quality_counts, optimizer_enabled, primary_avg, challenger_avg, delta, decision } = result;

  if (!optimizer_enabled) {
    return (
      <div className="py-8 text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-900/40 border border-emerald-700 flex items-center justify-center mx-auto mb-4">
          <span className="text-emerald-400 text-xl">✓</span>
        </div>
        <p className="text-white font-medium mb-1">
          {total_runs} simulation{total_runs !== 1 ? "s" : ""} complete
        </p>
        <p className="text-gray-500 text-sm">
          {quality_counts?.high ?? 0} High / {quality_counts?.medium ?? 0} Medium / {quality_counts?.low ?? 0} Low quality
        </p>
        <p className="text-gray-600 text-xs mt-3">Closing in 3 seconds…</p>
      </div>
    );
  }

  if (savedChallenger) {
    return (
      <div className="py-8 text-center">
        <div className="w-12 h-12 rounded-full bg-emerald-900/40 border border-emerald-700 flex items-center justify-center mx-auto mb-4">
          <span className="text-emerald-400 text-xl">✓</span>
        </div>
        <p className="text-white font-medium">New prompt version saved and activated</p>
        <p className="text-gray-500 text-xs mt-1">Closing…</p>
      </div>
    );
  }

  if (decision === "challenger_wins") {
    return (
      <div className="py-2">
        <div className="rounded-lg p-4 mb-4 bg-emerald-900/20 border border-emerald-800">
          <p className="text-emerald-400 text-sm font-semibold mb-0.5">
            Challenger prompt wins (+{delta?.toFixed(1)} pts)
          </p>
          <p className="text-gray-400 text-xs">Save as new active version?</p>
        </div>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-gray-500 text-xs mb-1">Primary avg</p>
            <p className="text-white font-semibold">{primary_avg?.toFixed(1)}/50</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-gray-500 text-xs mb-1">Challenger avg</p>
            <p className="text-emerald-400 font-semibold">{challenger_avg?.toFixed(1)}/50</p>
          </div>
          <div className="bg-gray-800 rounded-lg p-3 text-center">
            <p className="text-gray-500 text-xs mb-1">Quality</p>
            <p className="text-gray-300 text-xs">
              {quality_counts?.high ?? 0}H {quality_counts?.medium ?? 0}M {quality_counts?.low ?? 0}L
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            onClick={onDecline}
            className="flex-1 py-2 rounded-lg bg-gray-800 text-gray-400 hover:text-white text-sm transition-colors"
          >
            No, keep current
          </button>
          <button
            onClick={onAccept}
            disabled={savingChallenger}
            className="flex-1 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {savingChallenger ? "Saving…" : "Yes, save"}
          </button>
        </div>
      </div>
    );
  }

  const msg =
    decision === "rejected_zero_goals"
      ? "Challenger rejected — 0% goal achievement rate."
      : `Challenger did not improve (${delta?.toFixed(1)} pts). Keeping current prompt.`;

  return (
    <div className="py-8 text-center">
      <div className="w-12 h-12 rounded-full bg-yellow-900/40 border border-yellow-700 flex items-center justify-center mx-auto mb-4">
        <span className="text-yellow-400 text-xl">↩</span>
      </div>
      <p className="text-white font-medium mb-3">{msg}</p>
      <div className="grid grid-cols-2 gap-3 max-w-xs mx-auto">
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-gray-500 text-xs mb-1">Primary</p>
          <p className="text-white font-semibold">{primary_avg?.toFixed(1)}/50</p>
        </div>
        <div className="bg-gray-800 rounded-lg p-3 text-center">
          <p className="text-gray-500 text-xs mb-1">Challenger</p>
          <p className="text-red-400 font-semibold">{challenger_avg?.toFixed(1)}/50</p>
        </div>
      </div>
      <p className="text-gray-600 text-xs mt-4">Closing in 3 seconds…</p>
    </div>
  );
}

function RunSimulationModal({
  agentId,
  onClose,
  onComplete,
}: {
  agentId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  // ── Config ────────────────────────────────────────────────────────
  const [experimentType, setExperimentType] = useState("conversation");
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [personasLoading, setPersonasLoading] = useState(false);
  const [activePromptText, setActivePromptText] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [difficulty, setDifficulty] = useState(1);

  // ── Run count ─────────────────────────────────────────────────────
  const [convPreset, setConvPreset] = useState<number | "custom">(0);
  const [convCustom, setConvCustom] = useState("");
  const [taskPreset, setTaskPreset] = useState<number | "custom">(1);
  const [taskCustom, setTaskCustom] = useState("");

  // ── Optimizer ─────────────────────────────────────────────────────
  const [optimizerEnabled, setOptimizerEnabled] = useState(false);
  const [optimizerMode, setOptimizerMode] = useState<"auto" | "manual">("auto");
  const [optimizerFocus, setOptimizerFocus] = useState("");
  const [challengerPromptEdit, setChallengerPromptEdit] = useState("");

  // ── Run state ─────────────────────────────────────────────────────
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [pollState, setPollState] = useState<PollState | null>(null);
  const [completionResult, setCompletionResult] = useState<BatchResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [savingChallenger, setSavingChallenger] = useState(false);
  const [savedChallenger, setSavedChallenger] = useState(false);

  const difficultyLabels = ["", "Easy", "Moderate", "Hard", "Very Hard", "Extreme"];
  const isConversation = experimentType === "conversation";
  const k = personas.length;
  const filteredTasks = tasks.filter(t => t.experiment_type === experimentType);

  const convPresetOptions = k > 0 ? [
    { value: k, label: String(k), sub: "1 round" },
    { value: k * 3, label: String(k * 3), sub: "3 rounds" },
    { value: k * 5, label: String(k * 5), sub: "5 rounds" },
    { value: k * 10, label: String(k * 10), sub: "10 rounds" },
  ] : [];

  const actualConvRuns = convPreset === "custom" ? (parseInt(convCustom) || 0) : (convPreset as number);
  const convCustomIsValid = convPreset !== "custom" || (parseInt(convCustom) > 0 && k > 0 && parseInt(convCustom) % k === 0);
  const actualTaskRuns = taskPreset === "custom" ? (parseInt(taskCustom) || 0) : (taskPreset as number);
  const totalRuns = isConversation ? actualConvRuns : actualTaskRuns;

  const canRun = status === "idle" && (
    isConversation
      ? k > 0 && actualConvRuns > 0 && convCustomIsValid
      : filteredTasks.length > 0 && !!selectedTaskId && actualTaskRuns > 0
  );

  // ── Data loading ──────────────────────────────────────────────────
  useEffect(() => {
    setPersonasLoading(true);
    setTasksLoading(true);
    Promise.all([
      fetch(`/api/agents/${agentId}/personas`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/tasks`).then(r => r.json()),
      fetch(`/api/agents/${agentId}/config`).then(r => r.json()),
    ]).then(([pd, td, cd]) => {
      const p: Persona[] = pd.personas ?? [];
      setPersonas(p);
      setPersonasLoading(false);
      setTasks(td.tasks ?? []);
      setTasksLoading(false);
      setActivePromptText(cd.active_prompt?.prompt_text ?? "");
    }).catch(() => { setPersonasLoading(false); setTasksLoading(false); });
  }, [agentId]);

  useEffect(() => {
    if (personas.length > 0 && convPreset === 0) setConvPreset(personas.length);
  }, [personas, convPreset]);

  useEffect(() => {
    const filtered = tasks.filter(t => t.experiment_type === experimentType);
    setSelectedTaskId(filtered.length > 0 ? filtered[0].task_id : "");
  }, [experimentType, tasks]);

  useEffect(() => {
    if (optimizerEnabled && optimizerMode === "manual" && activePromptText && !challengerPromptEdit) {
      setChallengerPromptEdit(activePromptText);
    }
  }, [optimizerEnabled, optimizerMode, activePromptText]);

  // ── Polling ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!runId || status !== "running") return;
    let active = true;
    (async () => {
      while (active) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const res = await fetch(`/api/agents/${agentId}/run-batch-with-optimizer/${runId}`);
          const data: PollState = await res.json();
          if (!active) break;
          setPollState(data);
          if (data.status === "complete") { setCompletionResult(data.result); setStatus("done"); break; }
          if (data.status === "error") { setErrorMsg(data.error || "Run failed"); setStatus("error"); break; }
        } catch (e) {
          if (active) { setErrorMsg(String(e)); setStatus("error"); }
          break;
        }
      }
    })();
    return () => { active = false; };
  }, [runId, agentId, status]);

  // ── Auto-close when no user decision needed ───────────────────────
  useEffect(() => {
    if (status !== "done" || !completionResult) return;
    const needsDecision =
      completionResult.optimizer_enabled &&
      completionResult.decision === "challenger_wins" &&
      !savedChallenger;
    if (needsDecision) return;
    const t = setTimeout(() => { onComplete(); onClose(); }, 3000);
    return () => clearTimeout(t);
  }, [status, completionResult, savedChallenger]);

  // ── Handlers ──────────────────────────────────────────────────────
  const handleRun = async () => {
    setStatus("running");
    setStopRequested(false);
    setPollState(null);
    setCompletionResult(null);
    setErrorMsg(null);
    const body: Record<string, unknown> = {
      experiment_type: experimentType,
      total_runs: totalRuns,
      difficulty,
      optimizer_enabled: optimizerEnabled,
      optimizer_mode: optimizerMode,
      optimizer_focus: optimizerFocus,
    };
    if (optimizerMode === "manual") body.challenger_prompt = challengerPromptEdit;
    if (!isConversation) body.task_id = selectedTaskId;
    try {
      const res = await fetch(`/api/agents/${agentId}/run-batch-with-optimizer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const err = await res.json(); throw new Error(err.detail || "Request failed"); }
      const { run_id } = await res.json();
      setRunId(run_id);
    } catch (e) { setStatus("error"); setErrorMsg(String(e)); }
  };

  const handleStopAfterCurrent = async () => {
    if (!runId || stopRequested) return;
    setStopRequested(true);
    try {
      await fetch(`/api/agents/${agentId}/run-batch-with-optimizer/${runId}/cancel`, { method: "POST" });
    } catch { /* ignore */ }
  };

  const handleAcceptChallenger = async () => {
    if (!completionResult?.challenger_prompt_text) return;
    setSavingChallenger(true);
    try {
      await fetch(`/api/agents/${agentId}/prompt-versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt_text: completionResult.challenger_prompt_text,
          change_summary: "Challenger batch winner — promoted by user",
        }),
      });
      setSavedChallenger(true);
      setTimeout(() => { onComplete(); onClose(); }, 2000);
    } catch { setSavingChallenger(false); }
  };

  const handleDeclineChallenger = () => { onComplete(); onClose(); };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={status === "running" ? undefined : onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-lg w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-white font-semibold text-lg">Run Simulation</h2>
            <p className="text-gray-500 text-xs mt-0.5">
              {isConversation
                ? "Evaluate agent across personas"
                : experimentType === "single_output"
                ? "Single task evaluation"
                : "Multi-step task evaluation"}
            </p>
          </div>
          {status !== "running" && (
            <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">×</button>
          )}
        </div>

        {/* ── Idle ───────────────────────────────────────────────── */}
        {status === "idle" && (
          <>
            <div className="mb-5">
              <label className="block text-xs text-gray-400 mb-2">Experiment Type</label>
              <div className="grid grid-cols-3 gap-2">
                {EXPERIMENT_TYPE_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setExperimentType(opt.value)}
                    className={`py-2 px-1 rounded-lg text-xs font-medium transition-colors text-center ${
                      experimentType === opt.value
                        ? "bg-indigo-600 text-white"
                        : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {isConversation ? (
              <div className="space-y-5">
                {/* Conversation run count */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Number of runs</label>
                  {personasLoading ? (
                    <p className="text-gray-600 text-xs py-3">Loading personas…</p>
                  ) : k === 0 ? (
                    <div className="bg-gray-950 rounded-lg p-3 border border-gray-800">
                      <p className="text-gray-400 text-xs mb-1">No personas configured</p>
                      <p className="text-gray-600 text-xs">
                        Add personas in the{" "}
                        <a href={`/agents/${agentId}/edit`} className="text-indigo-400 hover:underline" onClick={onClose}>
                          Edit page
                        </a>{" "}
                        to enable conversation simulations.
                      </p>
                    </div>
                  ) : (
                    <>
                      <p className="text-gray-600 text-xs mb-2">
                        Must be a multiple of {k} persona{k !== 1 ? "s" : ""} — each persona runs equally
                      </p>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {convPresetOptions.map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => setConvPreset(opt.value)}
                            className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors text-center min-w-[52px] ${
                              convPreset === opt.value
                                ? "bg-indigo-600 text-white"
                                : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                            }`}
                          >
                            <span className="block text-sm font-semibold">{opt.label}</span>
                            <span className="block text-[10px] opacity-70">{opt.sub}</span>
                          </button>
                        ))}
                        <button
                          onClick={() => setConvPreset("custom")}
                          className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                            convPreset === "custom"
                              ? "bg-indigo-600 text-white"
                              : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                          }`}
                        >
                          Custom
                        </button>
                      </div>
                      {convPreset === "custom" && (
                        <div>
                          <input
                            type="number"
                            min={k}
                            step={k}
                            value={convCustom}
                            onChange={e => setConvCustom(e.target.value)}
                            placeholder={`e.g. ${k * 2}`}
                            className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                          />
                          {convCustom && !convCustomIsValid && (
                            <p className="text-red-400 text-xs mt-1">Must be a multiple of {k}</p>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Difficulty */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">
                    Difficulty — {difficulty}: {difficultyLabels[difficulty]}
                  </label>
                  <input
                    type="range" min={1} max={5} value={difficulty}
                    onChange={e => setDifficulty(Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                  <div className="flex justify-between text-xs text-gray-600 mt-1">
                    <span>1 Easy</span><span>5 Extreme</span>
                  </div>
                </div>

                <OptimizerSection
                  enabled={optimizerEnabled}
                  onToggle={() => setOptimizerEnabled(v => !v)}
                  mode={optimizerMode}
                  onModeChange={setOptimizerMode}
                  focus={optimizerFocus}
                  onFocusChange={setOptimizerFocus}
                  challengerText={challengerPromptEdit}
                  onChallengerTextChange={setChallengerPromptEdit}
                  activePromptText={activePromptText}
                />
              </div>
            ) : (
              <div className="space-y-4">
                {tasksLoading ? (
                  <p className="text-gray-500 text-sm text-center py-4">Loading tasks…</p>
                ) : filteredTasks.length === 0 ? (
                  <div className="bg-gray-950 rounded-lg p-4 border border-gray-800 text-center">
                    <p className="text-gray-400 text-sm mb-1">No tasks configured</p>
                    <p className="text-gray-600 text-xs">
                      Add tasks in the{" "}
                      <a href={`/agents/${agentId}/edit`} className="text-indigo-400 hover:underline" onClick={onClose}>
                        Edit page
                      </a>{" "}
                      under Experiment Types &amp; Tasks.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs text-gray-400 mb-2">Select Task</label>
                    <select
                      value={selectedTaskId}
                      onChange={e => setSelectedTaskId(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    >
                      {filteredTasks.map(t => <option key={t.task_id} value={t.task_id}>{t.title}</option>)}
                    </select>
                    {selectedTaskId && (
                      <p className="text-gray-600 text-xs mt-1.5 truncate">
                        {filteredTasks.find(t => t.task_id === selectedTaskId)?.description}
                      </p>
                    )}
                  </div>
                )}

                {filteredTasks.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-2">Number of runs per task</label>
                    <div className="flex flex-wrap gap-2">
                      {TASK_PRESETS.map(n => (
                        <button
                          key={n}
                          onClick={() => setTaskPreset(n)}
                          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            taskPreset === n
                              ? "bg-indigo-600 text-white"
                              : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                      <button
                        onClick={() => setTaskPreset("custom")}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                          taskPreset === "custom"
                            ? "bg-indigo-600 text-white"
                            : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                        }`}
                      >
                        Custom
                      </button>
                    </div>
                    {taskPreset === "custom" && (
                      <input
                        type="number" min={1} value={taskCustom}
                        onChange={e => setTaskCustom(e.target.value)}
                        placeholder="e.g. 7"
                        className="mt-2 w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                      />
                    )}
                  </div>
                )}

                {filteredTasks.length > 0 && (
                  <OptimizerSection
                    enabled={optimizerEnabled}
                    onToggle={() => setOptimizerEnabled(v => !v)}
                    mode={optimizerMode}
                    onModeChange={setOptimizerMode}
                    focus={optimizerFocus}
                    onFocusChange={setOptimizerFocus}
                    challengerText={challengerPromptEdit}
                    onChallengerTextChange={setChallengerPromptEdit}
                    activePromptText={activePromptText}
                  />
                )}
              </div>
            )}

            <div className="flex gap-3 mt-5">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg bg-gray-800 text-gray-400 hover:text-white text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleRun}
                disabled={!canRun}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Run {totalRuns > 0 ? totalRuns : "…"} simulation{totalRuns !== 1 ? "s" : ""}
              </button>
            </div>
          </>
        )}

        {/* ── Running ────────────────────────────────────────────── */}
        {status === "running" && (
          <BatchProgressDisplay
            pollState={pollState}
            isConversation={isConversation}
            stopRequested={stopRequested}
            onStop={handleStopAfterCurrent}
          />
        )}

        {/* ── Done ───────────────────────────────────────────────── */}
        {status === "done" && completionResult && (
          <BatchResultDisplay
            result={completionResult}
            savedChallenger={savedChallenger}
            savingChallenger={savingChallenger}
            onAccept={handleAcceptChallenger}
            onDecline={handleDeclineChallenger}
          />
        )}

        {/* ── Error ──────────────────────────────────────────────── */}
        {status === "error" && (
          <div className="py-4 text-center">
            <p className="text-red-400 text-sm mb-2">Run failed</p>
            {errorMsg && <p className="text-gray-500 text-xs mb-4 break-all">{errorMsg}</p>}
            <button
              onClick={() => setStatus("idle")}
              className="px-4 py-2 rounded-lg bg-gray-800 text-gray-300 hover:text-white text-sm transition-colors"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function SessionsList({ agentId }: { agentId: string }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [showRunModal, setShowRunModal] = useState(false);
  const navigate = useNavigate();

  const loadSessions = () => {
    fetch(`/api/agents/${agentId}/sessions`)
      .then((r) => r.json())
      .then((d) => {
        setSessions(d.sessions ?? []);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  };

  useEffect(() => {
    loadSessions();
  }, []);

  if (loading) {
    return <p className="text-gray-500 mt-8 text-sm">Loading sessions…</p>;
  }
  if (error) {
    return <p className="text-red-400 mt-8 text-sm">Error: {error}</p>;
  }

  const FILTERS: { key: QualityFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "high", label: "High" },
    { key: "medium", label: "Medium" },
    { key: "low", label: "Low" },
  ];

  const filtered =
    qualityFilter === "all"
      ? sessions
      : sessions.filter((s) => s.trajectory_quality === qualityFilter);

  return (
    <div>
      {showRunModal && (
        <RunSimulationModal
          agentId={agentId}
          onClose={() => setShowRunModal(false)}
          onComplete={() => {
            setLoading(true);
            loadSessions();
          }}
        />
      )}

      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Simulation Sessions</h1>
        <div className="flex items-center gap-3">
          <span className="text-gray-500 text-sm">{sessions.length} sessions</span>
          <button
            onClick={() => setShowRunModal(true)}
            className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium transition-colors"
          >
            + Run Simulation
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setQualityFilter(f.key)}
            className={`px-3 py-1 text-xs rounded font-medium transition-colors ${
              qualityFilter === f.key
                ? "bg-indigo-600 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
            }`}
          >
            {f.label}
            <span className="ml-1.5 text-gray-500 font-normal">
              {f.key === "all"
                ? sessions.length
                : sessions.filter((s) => s.trajectory_quality === f.key).length}
            </span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="mt-12 text-center">
          <p className="text-gray-400 text-lg mb-2">No sessions yet</p>
          <p className="text-gray-600 text-sm">
            Click{" "}
            <button
              onClick={() => setShowRunModal(true)}
              className="text-indigo-400 hover:underline"
            >
              Run Simulation
            </button>{" "}
            or run{" "}
            <code className="bg-gray-800 px-1.5 py-0.5 rounded text-gray-300">
              python run.py
            </code>{" "}
            in the backend to generate simulations.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/50">
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Session ID</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Type</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Profile / Task</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Goal</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Score</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Quality</th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Timestamp</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {filtered.map((s) => (
                <tr
                  key={s.session_id}
                  className="hover:bg-gray-900/40 transition-colors"
                >
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">
                    {s.session_id.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 flex-wrap">
                      <ExperimentTypeBadge type={s.experiment_type ?? "conversation"} />
                      {s.batch_role === "challenger" && <ChallengerPill />}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {(!s.experiment_type || s.experiment_type === "conversation") ? (
                      <div className="flex items-center gap-1">
                        <ProfileBadge profile={s.user_profile} />
                        <DifficultyBadge difficulty={s.difficulty} />
                      </div>
                    ) : (
                      <span className="text-gray-400 text-xs">task run</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-300 max-w-xs truncate" title={s.hidden_goal}>
                    {s.hidden_goal}
                  </td>
                  <td className="px-4 py-3">
                    {s.total_score !== null ? (
                      <span className="text-white font-medium">{s.total_score}/50</span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <QualityBadge quality={s.trajectory_quality} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {formatTs(s.timestamp)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => navigate(`/agents/${agentId}/sessions/${s.session_id}`)}
                      className="px-3 py-1 text-xs rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                    >
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
