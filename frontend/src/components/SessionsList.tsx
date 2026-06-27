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
}

interface Task {
  task_id: string;
  title: string;
  description: string;
  experiment_type: string;
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

function formatTs(ts: string) {
  try {
    return new Date(ts + "Z").toLocaleString();
  } catch {
    return ts;
  }
}

type QualityFilter = "all" | "high" | "medium" | "low";

// ── Run Simulation Modal ──────────────────────────────────────────────────────

const PHASE_STEPS = [
  { key: "eval",       label: "Run eval batch",       desc: "Scoring current prompt" },
  { key: "propose",    label: "Rewrite prompt",        desc: "Meta-agent proposes changes" },
  { key: "challenger", label: "Run challenger batch",  desc: "Scoring new prompt" },
  { key: "decision",   label: "Compare & decide",      desc: "Keep or revert" },
];

const SESSION_COUNT_OPTIONS = [3, 6, 9, 12];
const RUN_COUNT_OPTIONS: Array<1 | 3 | 5> = [1, 3, 5];

interface RunResult {
  eval_avg: number;
  challenger_avg: number;
  improvement: number;
  accepted: boolean;
  change_summary: string;
  decision: string;
}

interface TaskRunResult {
  session_id: string;
  total_score: number;
  trajectory_quality: string;
  goal_achieved: boolean;
  total_tool_calls: number;
}

const EXPERIMENT_TYPE_OPTIONS = [
  { value: "conversation", label: "Conversation", desc: "Multi-turn dialogue optimization" },
  { value: "single_output", label: "Single Output", desc: "One-shot task completion" },
  { value: "multi_step", label: "Multi-Step", desc: "Complex multi-tool task" },
];

function RunSimulationModal({
  agentId,
  onClose,
  onComplete,
}: {
  agentId: string;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [experimentType, setExperimentType] = useState("conversation");
  const [sessionCount, setSessionCount] = useState(3);
  const [difficulty, setDifficulty] = useState(1);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [tasksLoading, setTasksLoading] = useState(false);
  const [runCount, setRunCount] = useState<1 | 3 | 5>(1);
  const [multiRunProgress, setMultiRunProgress] = useState<{ current: number; total: number } | null>(null);

  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [currentPhase, setCurrentPhase] = useState<string>("eval");
  const [phaseDetail, setPhaseDetail] = useState<string>("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [taskResult, setTaskResult] = useState<TaskRunResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const difficultyLabels = ["", "Easy", "Moderate", "Hard", "Very Hard", "Extreme"];
  const isConversation = experimentType === "conversation";

  // Derived: tasks filtered to match selected experiment type
  const filteredTasks = tasks.filter((t) => t.experiment_type === experimentType);

  // Load all tasks once on mount
  useEffect(() => {
    setTasksLoading(true);
    fetch(`/api/agents/${agentId}/tasks`)
      .then((r) => r.json())
      .then((d) => {
        setTasks(d.tasks ?? []);
        setTasksLoading(false);
      })
      .catch(() => setTasksLoading(false));
  }, [agentId]);

  // Reset selectedTaskId when experiment type or task list changes
  useEffect(() => {
    const filtered = tasks.filter((t) => t.experiment_type === experimentType);
    setSelectedTaskId(filtered.length > 0 ? filtered[0].task_id : "");
  }, [experimentType, tasks]);

  // Auto-close 2s after multi-run completes
  useEffect(() => {
    if (status === "done" && runCount > 1) {
      const timer = setTimeout(() => onClose(), 2000);
      return () => clearTimeout(timer);
    }
  }, [status, runCount, onClose]);

  // Inline polling helpers (avoids separate useEffect / runId state)
  const pollConversation = async (runId: string): Promise<any> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      const res = await fetch(`/api/agents/${agentId}/run-simulation/${runId}`);
      const data = await res.json();
      setCurrentPhase(data.phase ?? "eval");
      setPhaseDetail(data.phase_detail ?? "");
      if (data.status === "complete") return data;
      if (data.status === "error") throw new Error(data.error || "Run failed");
    }
  };

  const pollTask = async (runId: string): Promise<any> => {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise<void>((r) => setTimeout(r, 2000));
      const res = await fetch(`/api/agents/${agentId}/run-task/${runId}`);
      const data = await res.json();
      if (data.status === "complete") return data;
      if (data.status === "error") throw new Error(data.error || "Run failed");
    }
  };

  const startConversationRun = async () => {
    setStatus("running");
    setCurrentPhase("eval");
    setPhaseDetail("");
    setErrorMsg(null);
    setMultiRunProgress(runCount > 1 ? { current: 1, total: runCount } : null);

    for (let i = 0; i < runCount; i++) {
      if (runCount > 1) setMultiRunProgress({ current: i + 1, total: runCount });
      try {
        const res = await fetch(`/api/agents/${agentId}/run-simulation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_count: sessionCount, difficulty }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || "Request failed");
        }
        const { run_id } = await res.json();
        const pollData = await pollConversation(run_id);
        if (i === runCount - 1) setResult(pollData.result);
        // Reset phase display between runs
        if (runCount > 1 && i < runCount - 1) {
          setCurrentPhase("eval");
          setPhaseDetail("");
        }
      } catch (e) {
        setStatus("error");
        setErrorMsg(String(e));
        setMultiRunProgress(null);
        return;
      }
    }

    setMultiRunProgress(null);
    setStatus("done");
    onComplete();
  };

  const startTaskRun = async () => {
    if (!selectedTaskId) return;
    setStatus("running");
    setErrorMsg(null);
    setMultiRunProgress(runCount > 1 ? { current: 1, total: runCount } : null);

    for (let i = 0; i < runCount; i++) {
      if (runCount > 1) setMultiRunProgress({ current: i + 1, total: runCount });
      try {
        const res = await fetch(`/api/agents/${agentId}/run-task`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ task_id: selectedTaskId, experiment_type: experimentType }),
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.detail || "Request failed");
        }
        const { run_id } = await res.json();
        const pollData = await pollTask(run_id);
        if (i === runCount - 1) setTaskResult(pollData.result);
      } catch (e) {
        setStatus("error");
        setErrorMsg(String(e));
        setMultiRunProgress(null);
        return;
      }
    }

    setMultiRunProgress(null);
    setStatus("done");
    onComplete();
  };

  const currentPhaseIndex = PHASE_STEPS.findIndex((s) => s.key === currentPhase);
  const runButtonLabel = runCount === 1 ? "Run" : `Run ${runCount} simulations`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={status === "running" ? undefined : onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-md w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-white font-semibold text-lg">Run Simulation</h2>
            <p className="text-gray-500 text-xs mt-0.5">
              {isConversation
                ? "eval → rewrite → challenge → compare"
                : experimentType === "single_output"
                ? "Single task evaluation"
                : "Multi-step task evaluation"}
            </p>
          </div>
          {status !== "running" && (
            <button onClick={onClose} className="text-gray-500 hover:text-white text-xl leading-none">
              ×
            </button>
          )}
        </div>

        {status === "idle" && (
          <>
            {/* Experiment type selector */}
            <div className="mb-5">
              <label className="block text-xs text-gray-400 mb-2">Experiment Type</label>
              <div className="grid grid-cols-3 gap-2">
                {EXPERIMENT_TYPE_OPTIONS.map((opt) => (
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
              <p className="text-gray-600 text-xs mt-1.5">
                {EXPERIMENT_TYPE_OPTIONS.find((o) => o.value === experimentType)?.desc}
              </p>
            </div>

            {isConversation ? (
              <div className="space-y-5">
                {/* Session count */}
                <div>
                  <label className="block text-xs text-gray-400 mb-2">Sessions per batch</label>
                  <div className="grid grid-cols-4 gap-2">
                    {SESSION_COUNT_OPTIONS.map((n) => (
                      <button
                        key={n}
                        onClick={() => setSessionCount(n)}
                        className={`py-2 rounded-lg text-sm font-medium transition-colors ${
                          sessionCount === n
                            ? "bg-indigo-600 text-white"
                            : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <p className="text-gray-600 text-xs mt-1.5">
                    {sessionCount} sessions × 2 batches = {sessionCount * 2} total simulations
                  </p>
                </div>

                {/* Difficulty */}
                <div>
                  <label className="block text-xs text-gray-400 mb-1.5">
                    Difficulty — {difficulty}: {difficultyLabels[difficulty]}
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={5}
                    value={difficulty}
                    onChange={(e) => setDifficulty(Number(e.target.value))}
                    className="w-full accent-indigo-500"
                  />
                  <div className="flex justify-between text-xs text-gray-600 mt-1">
                    <span>1 Easy</span>
                    <span>5 Extreme</span>
                  </div>
                </div>

                {/* Number of runs */}
                <div>
                  <label className="block text-xs text-gray-400 mb-2">Number of runs</label>
                  <div className="grid grid-cols-3 gap-2">
                    {RUN_COUNT_OPTIONS.map((n) => (
                      <button
                        key={n}
                        onClick={() => setRunCount(n)}
                        className={`py-2 rounded-lg text-sm font-medium transition-colors ${
                          runCount === n
                            ? "bg-indigo-600 text-white"
                            : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Flow preview */}
                <div className="bg-gray-950 rounded-lg p-3 border border-gray-800">
                  <p className="text-gray-500 text-xs mb-2">Flow</p>
                  <div className="flex items-center gap-1 flex-wrap">
                    {PHASE_STEPS.map((s, i) => (
                      <span key={s.key} className="flex items-center gap-1">
                        <span className="text-xs text-gray-400">{s.label}</span>
                        {i < PHASE_STEPS.length - 1 && (
                          <span className="text-gray-700 text-xs">→</span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
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
                      <a
                        href={`/agents/${agentId}/edit`}
                        className="text-indigo-400 hover:underline"
                        onClick={onClose}
                      >
                        Edit page
                      </a>
                      {" "}under Experiment Types & Tasks.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs text-gray-400 mb-2">Select Task</label>
                    <select
                      value={selectedTaskId}
                      onChange={(e) => setSelectedTaskId(e.target.value)}
                      className="w-full bg-gray-800 border border-gray-700 text-white text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-indigo-500"
                    >
                      {filteredTasks.map((t) => (
                        <option key={t.task_id} value={t.task_id}>
                          {t.title}
                        </option>
                      ))}
                    </select>
                    {selectedTaskId && (
                      <p className="text-gray-600 text-xs mt-1.5 truncate">
                        {filteredTasks.find((t) => t.task_id === selectedTaskId)?.description}
                      </p>
                    )}
                  </div>
                )}

                {/* Number of runs — only shown when tasks are available */}
                {filteredTasks.length > 0 && (
                  <div>
                    <label className="block text-xs text-gray-400 mb-2">Number of runs</label>
                    <div className="grid grid-cols-3 gap-2">
                      {RUN_COUNT_OPTIONS.map((n) => (
                        <button
                          key={n}
                          onClick={() => setRunCount(n)}
                          className={`py-2 rounded-lg text-sm font-medium transition-colors ${
                            runCount === n
                              ? "bg-indigo-600 text-white"
                              : "bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700"
                          }`}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-gray-950 rounded-lg p-3 border border-gray-800">
                  <p className="text-gray-500 text-xs mb-1">Flow</p>
                  <p className="text-xs text-gray-400">
                    {experimentType === "single_output"
                      ? "task → single agent response → judge evaluation"
                      : "task → tool loop → [TASK_COMPLETE] → judge evaluation"}
                  </p>
                </div>
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
                onClick={isConversation ? startConversationRun : startTaskRun}
                disabled={!isConversation && (filteredTasks.length === 0 || !selectedTaskId)}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {runButtonLabel}
              </button>
            </div>
          </>
        )}

        {status === "running" && isConversation && (
          <div className="py-2">
            {multiRunProgress && (
              <div className="mb-4">
                <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                  <span>Running optimization {multiRunProgress.current} of {multiRunProgress.total}</span>
                  <span>{multiRunProgress.current - 1}/{multiRunProgress.total} done</span>
                </div>
                <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                    style={{ width: `${((multiRunProgress.current - 1) / multiRunProgress.total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            <div className="space-y-3 mb-5">
              {PHASE_STEPS.map((step, i) => {
                const isDone = i < currentPhaseIndex;
                const isActive = i === currentPhaseIndex;
                return (
                  <div key={step.key} className="flex items-start gap-3">
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 text-xs font-bold ${
                        isDone
                          ? "bg-emerald-600 text-white"
                          : isActive
                          ? "bg-indigo-600 text-white"
                          : "bg-gray-800 text-gray-600"
                      }`}
                    >
                      {isDone ? "✓" : i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p
                        className={`text-sm font-medium ${
                          isActive ? "text-white" : isDone ? "text-gray-400" : "text-gray-600"
                        }`}
                      >
                        {step.label}
                      </p>
                      {isActive && phaseDetail && (
                        <p className="text-xs text-indigo-400 mt-0.5 truncate">{phaseDetail}</p>
                      )}
                      {!isActive && (
                        <p className="text-xs text-gray-700 mt-0.5">{step.desc}</p>
                      )}
                    </div>
                    {isActive && (
                      <svg className="animate-spin w-4 h-4 text-indigo-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-gray-600 text-xs text-center">
              {sessionCount * 2} simulations total — this takes a few minutes
            </p>
          </div>
        )}

        {status === "running" && !isConversation && (
          <div className="py-6 flex flex-col items-center gap-4">
            {multiRunProgress ? (
              <>
                <div className="w-full">
                  <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                    <span>Running simulation {multiRunProgress.current} of {multiRunProgress.total}…</span>
                    <span>{multiRunProgress.current - 1}/{multiRunProgress.total} done</span>
                  </div>
                  <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                      style={{ width: `${((multiRunProgress.current - 1) / multiRunProgress.total) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2 text-gray-400">
                  <svg className="animate-spin w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  <span className="text-sm">
                    {experimentType === "multi_step" ? "Agent is executing tool calls" : "Agent is generating response"}
                  </span>
                </div>
              </>
            ) : (
              <>
                <svg className="animate-spin w-8 h-8 text-indigo-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                <div className="text-center">
                  <p className="text-white text-sm font-medium">Running task…</p>
                  <p className="text-gray-500 text-xs mt-1">
                    {experimentType === "multi_step"
                      ? "Agent is executing tool calls"
                      : "Agent is generating response"}
                  </p>
                </div>
              </>
            )}
          </div>
        )}

        {/* Multi-run completion flash (auto-closes after 2s) */}
        {status === "done" && runCount > 1 && (
          <div className="py-8 text-center">
            <div className="w-12 h-12 rounded-full bg-emerald-900/40 border border-emerald-700 flex items-center justify-center mx-auto mb-4">
              <span className="text-emerald-400 text-xl">✓</span>
            </div>
            <p className="text-white font-medium">{runCount} simulations completed.</p>
            <p className="text-gray-500 text-xs mt-1">Closing…</p>
          </div>
        )}

        {/* Single conversation run result */}
        {status === "done" && runCount === 1 && result && isConversation && (
          <div className="py-2">
            <div
              className={`rounded-lg p-4 mb-4 border ${
                result.accepted
                  ? "bg-emerald-900/20 border-emerald-800"
                  : "bg-yellow-900/20 border-yellow-800"
              }`}
            >
              <p
                className={`text-sm font-semibold mb-1 ${
                  result.accepted ? "text-emerald-400" : "text-yellow-400"
                }`}
              >
                {result.accepted ? "✓ New prompt kept" : "↩ Reverted to previous"}
              </p>
              <p className="text-gray-300 text-xs">{result.change_summary}</p>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-gray-500 text-xs mb-1">Baseline</p>
                <p className="text-white font-semibold">{result.eval_avg.toFixed(1)}</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-gray-500 text-xs mb-1">Challenger</p>
                <p className="text-white font-semibold">{result.challenger_avg.toFixed(1)}</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-gray-500 text-xs mb-1">Delta</p>
                <p
                  className={`font-semibold ${
                    result.improvement >= 0 ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {result.improvement >= 0 ? "+" : ""}
                  {result.improvement.toFixed(1)}
                </p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg bg-gray-800 text-gray-400 hover:text-white text-sm transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => { onClose(); window.location.href = `/agents/${agentId}/experiments`; }}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                View Experiments
              </button>
            </div>
          </div>
        )}

        {/* Single task run result */}
        {status === "done" && runCount === 1 && taskResult && !isConversation && (
          <div className="py-2">
            <div
              className={`rounded-lg p-4 mb-4 border ${
                taskResult.goal_achieved
                  ? "bg-emerald-900/20 border-emerald-800"
                  : "bg-red-900/20 border-red-800"
              }`}
            >
              <p
                className={`text-sm font-semibold ${
                  taskResult.goal_achieved ? "text-emerald-400" : "text-red-400"
                }`}
              >
                {taskResult.goal_achieved ? "✓ Goal achieved" : "✗ Goal not achieved"}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-4">
              <div className="bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-gray-500 text-xs mb-1">Score</p>
                <p className="text-white font-semibold">{taskResult.total_score ?? "—"}/50</p>
              </div>
              <div className="bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-gray-500 text-xs mb-1">Quality</p>
                <p
                  className={`font-semibold text-sm capitalize ${
                    taskResult.trajectory_quality === "high"
                      ? "text-emerald-400"
                      : taskResult.trajectory_quality === "medium"
                      ? "text-yellow-400"
                      : "text-red-400"
                  }`}
                >
                  {taskResult.trajectory_quality ?? "—"}
                </p>
              </div>
              <div className="bg-gray-800 rounded-lg p-3 text-center">
                <p className="text-gray-500 text-xs mb-1">Tool Calls</p>
                <p className="text-white font-semibold">{taskResult.total_tool_calls ?? 0}</p>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg bg-gray-800 text-gray-400 hover:text-white text-sm transition-colors"
              >
                Close
              </button>
              <button
                onClick={() => {
                  onClose();
                  if (taskResult.session_id) {
                    window.location.href = `/agents/${agentId}/sessions/${taskResult.session_id}`;
                  }
                }}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                View Session
              </button>
            </div>
          </div>
        )}

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
                    <ExperimentTypeBadge type={s.experiment_type ?? "conversation"} />
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
