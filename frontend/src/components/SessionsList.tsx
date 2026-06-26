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

function DifficultyBadge({ difficulty }: { difficulty: number | null }) {
  if (!difficulty) return null;
  const colors = [
    "",
    "text-gray-400",      // 1
    "text-sky-400",       // 2
    "text-yellow-400",    // 3
    "text-orange-400",    // 4
    "text-red-400",       // 5
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
  { key: "eval",       label: "Run eval batch",          desc: "Scoring current prompt" },
  { key: "propose",    label: "Rewrite prompt",          desc: "Meta-agent proposes changes" },
  { key: "challenger", label: "Run challenger batch",    desc: "Scoring new prompt" },
  { key: "decision",   label: "Compare & decide",        desc: "Keep or revert" },
];

const SESSION_COUNT_OPTIONS = [3, 6, 9, 12];

interface RunResult {
  eval_avg: number;
  challenger_avg: number;
  improvement: number;
  accepted: boolean;
  change_summary: string;
  decision: string;
}

function RunSimulationModal({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => void;
}) {
  const [sessionCount, setSessionCount] = useState(3);
  const [difficulty, setDifficulty] = useState(1);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error">("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [currentPhase, setCurrentPhase] = useState<string>("eval");
  const [phaseDetail, setPhaseDetail] = useState<string>("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const difficultyLabels = ["", "Easy", "Moderate", "Hard", "Very Hard", "Extreme"];

  const startRun = async () => {
    setStatus("running");
    setCurrentPhase("eval");
    setPhaseDetail("");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/run-simulation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_count: sessionCount, difficulty }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || "Request failed");
      }
      const data = await res.json();
      setRunId(data.run_id);
    } catch (e) {
      setStatus("error");
      setErrorMsg(String(e));
    }
  };

  useEffect(() => {
    if (!runId) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/run-simulation/${runId}`);
        const data = await res.json();
        setCurrentPhase(data.phase ?? "eval");
        setPhaseDetail(data.phase_detail ?? "");
        if (data.status === "complete") {
          clearInterval(interval);
          setStatus("done");
          setResult(data.result);
          onComplete();
        } else if (data.status === "error") {
          clearInterval(interval);
          setStatus("error");
          setErrorMsg(data.error || "Run failed");
        }
      } catch {
        // keep polling
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [runId, onComplete]);

  const currentPhaseIndex = PHASE_STEPS.findIndex((s) => s.key === currentPhase);

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
            <h2 className="text-white font-semibold text-lg">Run Optimization</h2>
            <p className="text-gray-500 text-xs mt-0.5">
              eval → rewrite → challenge → compare
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

            <div className="flex gap-3 mt-5">
              <button
                onClick={onClose}
                className="flex-1 py-2 rounded-lg bg-gray-800 text-gray-400 hover:text-white text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={startRun}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                Run
              </button>
            </div>
          </>
        )}

        {status === "running" && (
          <div className="py-2">
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

        {status === "done" && result && (
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
                onClick={() => { onClose(); window.location.href = "/experiments"; }}
                className="flex-1 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
              >
                View Experiments
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

export default function SessionsList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const [showRunModal, setShowRunModal] = useState(false);
  const navigate = useNavigate();

  const loadSessions = () => {
    fetch("/api/sessions")
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
          onClose={() => setShowRunModal(false)}
          onComplete={() => {
            // Reload sessions list after completion
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
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Profile</th>
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
                    <div className="flex items-center gap-1">
                      <ProfileBadge profile={s.user_profile} />
                      <DifficultyBadge difficulty={s.difficulty} />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-300 max-w-xs truncate" title={s.hidden_goal}>
                    {s.hidden_goal}
                  </td>
                  <td className="px-4 py-3">
                    {s.total_score !== null ? (
                      <span className="text-white font-medium">{s.total_score}/40</span>
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
                      onClick={() => navigate(`/sessions/${s.session_id}`)}
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
