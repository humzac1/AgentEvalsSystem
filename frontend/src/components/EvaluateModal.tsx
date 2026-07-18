import { useState, useCallback, Fragment } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type ExperimentType = "conversation" | "single_output" | "multi_step";

interface OpenCode {
  session_id: string;
  comment: string;
  author: string;
  created_at: string;
  experiment_type: ExperimentType;
}

const SESSION_TYPE_LABELS: Record<ExperimentType, string> = {
  conversation: "conversation",
  single_output: "single output",
  multi_step: "multi-step",
};

interface CodedSession {
  session_id: string;
  comment: string;
  axial_codes: string[];
  experiment_type: ExperimentType;
}

interface SessionContext {
  experiment_type: ExperimentType;
  persona: string;
  difficulty: number;
  goal: string;
  taskTitle: string;
  score: number | null;
}

interface Judge {
  axial_code: string;
  system_prompt: string;
}

interface Transcript {
  session_id: string;
  transcript: string;
}

// axial_code -> session_id -> "TRUE" | "FALSE"
type DecisionMap = Record<string, Record<string, string>>;
// axial_code -> session_id -> boolean
type HumanMap = Record<string, Record<string, boolean>>;

interface JudgeMetrics {
  TP: number;
  TN: number;
  FP: number;
  FN: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  auc: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BORDER_COLORS = [
  "border-l-indigo-500",
  "border-l-emerald-500",
  "border-l-amber-500",
  "border-l-rose-500",
  "border-l-purple-500",
  "border-l-cyan-500",
];

function codeBorderColor(code: string, categories: string[]) {
  const idx = categories.indexOf(code);
  return BORDER_COLORS[idx % BORDER_COLORS.length];
}

// TP/TN/FP/FN from judge vs. human labels for one axial code, across all sessions
// the judge produced a decision for.
function computeMetrics(
  judgeDecisions: Record<string, string>,
  humanLabelsForCode: Record<string, boolean>
): JudgeMetrics {
  let TP = 0, TN = 0, FP = 0, FN = 0;
  for (const sessionId of Object.keys(judgeDecisions)) {
    const judge = judgeDecisions[sessionId] === "TRUE";
    const human = !!humanLabelsForCode[sessionId];
    if (judge && human) TP++;
    else if (!judge && !human) TN++;
    else if (judge && !human) FP++;
    else FN++;
  }
  const accuracy = TP + TN + FP + FN > 0 ? (TP + TN) / (TP + TN + FP + FN) : 0;
  const precision = TP + FP > 0 ? TP / (TP + FP) : 0;
  const recall = TP + FN > 0 ? TP / (TP + FN) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  // No probability scores are available from a binary TRUE/FALSE judge, so AUC
  // is approximated as balanced accuracy (mean of recall and true-negative rate).
  const tnr = TN + FP > 0 ? TN / (TN + FP) : 0;
  const auc = (recall + tnr) / 2;
  return { TP, TN, FP, FN, accuracy, precision, recall, f1, auc };
}

function aucColor(auc: number) {
  if (auc >= 0.85) return "text-emerald-400";
  if (auc >= 0.70) return "text-amber-400";
  return "text-rose-400";
}

// Matches the session type badge used in SessionsList.tsx.
const EXPERIMENT_TYPE_BADGE: Record<ExperimentType, { label: string; classes: string }> = {
  conversation: { label: "Conv", classes: "bg-blue-900/60 text-blue-300 border border-blue-700" },
  single_output: { label: "Output", classes: "bg-orange-900/60 text-orange-300 border border-orange-700" },
  multi_step: { label: "Multi", classes: "bg-purple-900/60 text-purple-300 border border-purple-700" },
};

function TypeBadge({ type }: { type: ExperimentType }) {
  const badge = EXPERIMENT_TYPE_BADGE[type] ?? { label: type, classes: "bg-gray-800 text-gray-300" };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${badge.classes}`}>
      {badge.label}
    </span>
  );
}

function SessionPopover({
  agentId,
  sessionId,
  ctx,
  anchor,
}: {
  agentId: string;
  sessionId: string;
  ctx: SessionContext | undefined;
  anchor: { top: number; left: number };
}) {
  return (
    <div
      style={{ top: anchor.top, left: anchor.left }}
      className="fixed z-50 w-64 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-3 text-xs text-gray-300 space-y-1.5"
    >
      <div className="flex items-center gap-2">
        <TypeBadge type={ctx?.experiment_type ?? "conversation"} />
        {ctx?.score !== null && ctx?.score !== undefined && (
          <span className="text-gray-500">Score: <span className="text-white">{ctx.score}</span></span>
        )}
      </div>
      {ctx?.experiment_type === "conversation" ? (
        <>
          {ctx?.persona && <div><span className="text-gray-500">Persona:</span> {ctx.persona}</div>}
          {ctx?.goal && <div><span className="text-gray-500">Goal:</span> {ctx.goal}</div>}
        </>
      ) : (
        ctx?.taskTitle && <div><span className="text-gray-500">Task:</span> {ctx.taskTitle}</div>
      )}
      <a
        href={`/agents/${agentId}/sessions/${sessionId}`}
        target="_blank"
        rel="noopener noreferrer"
        className="block pt-1 text-indigo-400 hover:text-indigo-300"
      >
        Open transcript →
      </a>
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-gray-400">
      <div className="w-8 h-8 border-2 border-gray-600 border-t-indigo-400 rounded-full animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

const STEP_LABELS = [
  "Fetch Comments",
  "Confirm Categories",
  "Results & Export",
  "Judge Prompts",
  "Judge Decisions",
  "Metrics & Export",
];

function StepIndicator({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-6 flex-wrap">
      {STEP_LABELS.map((label, i) => {
        const s = i + 1;
        return (
          <div key={s} className="flex items-center gap-1.5">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-semibold border shrink-0 ${
                s < step
                  ? "bg-indigo-600 border-indigo-600 text-white"
                  : s === step
                  ? "border-indigo-500 text-indigo-300"
                  : "border-gray-700 text-gray-600"
              }`}
            >
              {s < step ? (
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                s
              )}
            </div>
            <span
              className={`text-[11px] ${
                s === step ? "text-gray-200" : s < step ? "text-gray-400" : "text-gray-600"
              }`}
            >
              {label}
            </span>
            {s < STEP_LABELS.length && <div className="w-5 h-px bg-gray-700 mx-0.5" />}
          </div>
        );
      })}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────

interface Props {
  agentId: string;
  onClose: () => void;
}

export function EvaluateModal({ agentId, onClose }: Props) {
  const API = `/api/agents/${agentId}`;

  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Step 1
  const [fetchStarted, setFetchStarted] = useState(false);
  const [recentLimit, setRecentLimit] = useState("");
  const [openCodes, setOpenCodes] = useState<OpenCode[]>([]);
  const [sessionsChecked, setSessionsChecked] = useState(0);
  const [fetchTime, setFetchTime] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [sessionTypeBreakdown, setSessionTypeBreakdown] = useState<Record<string, number>>({});

  // Step 2
  const [categories, setCategories] = useState<string[]>([]);

  // Step 3
  const [codedSessions, setCodedSessions] = useState<CodedSession[]>([]);
  const [frequencies, setFrequencies] = useState<Record<string, number>>({});

  // Step 4
  const [agentInfo, setAgentInfo] = useState<{ name: string; domain: string } | null>(null);
  const [judges, setJudges] = useState<Judge[]>([]);
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set());

  // Step 5
  const [decisions, setDecisions] = useState<DecisionMap>({});
  const [humanLabels, setHumanLabels] = useState<HumanMap>({});
  const [runningJudges, setRunningJudges] = useState(false);
  const [judgeProgress, setJudgeProgress] = useState({ done: 0, total: 0 });
  const [reviewedConfirmed, setReviewedConfirmed] = useState(false);
  const [sessionContexts, setSessionContexts] = useState<Record<string, SessionContext>>({});
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);
  const [hoverAnchor, setHoverAnchor] = useState<{ top: number; left: number } | null>(null);

  // Step 6
  const [metrics, setMetrics] = useState<Record<string, JudgeMetrics>>({});
  const [metricsByType, setMetricsByType] = useState<Record<string, Record<string, JudgeMetrics>>>({});
  const [promptsExpanded, setPromptsExpanded] = useState(false);
  const [reportDownloaded, setReportDownloaded] = useState(false);

  // ── Step 1: fetch comments (triggered by user, optionally scoped to the N
  // most recent sessions so a quick check doesn't have to scan everything) ───
  const handleFetchComments = useCallback(() => {
    setFetchStarted(true);
    setLoading(true);
    setLoadingLabel("Fetching Langfuse comments...");
    setError(null);
    const k = recentLimit.trim();
    const url = k
      ? `${API}/langfuse-comments?limit=${encodeURIComponent(k)}`
      : `${API}/langfuse-comments`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => {
        setOpenCodes(data.comments || []);
        setSessionsChecked(data.sessions_checked || 0);
        setFetchTime(data.fetch_time_seconds ?? null);
        setTimedOut(!!data.timed_out);
        setSessionTypeBreakdown(data.session_type_breakdown || {});
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to fetch Langfuse comments.");
        setLoading(false);
      });
  }, [API, recentLimit]);

  // ── Step 2: propose codes ──────────────────────────────────────────────────
  const handleGenerateCodes = useCallback(async () => {
    setLoading(true);
    setLoadingLabel("Generating axial code categories...");
    setError(null);
    try {
      const res = await fetch(`${API}/evaluate/propose-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ open_codes: openCodes }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCategories(data.proposed_categories || []);
      setStep(2);
    } catch (e: any) {
      setError(e.message || "Failed to generate axial codes.");
    } finally {
      setLoading(false);
    }
  }, [API, openCodes]);

  // ── Step 3: assign codes ───────────────────────────────────────────────────
  const handleAssignCodes = useCallback(async () => {
    const validCats = categories.filter((c) => c.trim());
    if (!validCats.length) {
      setError("Add at least one category before confirming.");
      return;
    }
    setLoading(true);
    setLoadingLabel("Assigning axial codes...");
    setError(null);
    try {
      const res = await fetch(`${API}/evaluate/assign-codes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ open_codes: openCodes, confirmed_categories: validCats }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setCodedSessions(data.coded_sessions || []);
      setFrequencies(data.frequencies || {});
      setStep(3);
    } catch (e: any) {
      setError(e.message || "Failed to assign codes.");
    } finally {
      setLoading(false);
    }
  }, [API, openCodes, categories]);

  // ── CSV download ───────────────────────────────────────────────────────────
  const handleDownloadCSV = useCallback(async () => {
    const res = await fetch(`${API}/evaluate/export-csv`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coded_sessions: codedSessions, frequencies }),
    });
    if (!res.ok) return;
    const cd = res.headers.get("Content-Disposition") || "";
    const nameMatch = cd.match(/filename="([^"]+)"/);
    const filename = nameMatch ? nameMatch[1] : "axial_coding.csv";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, [API, codedSessions, frequencies]);

  // ── Step 3 → 4: generate judge prompts ─────────────────────────────────────
  const handleContinueToJudges = useCallback(async () => {
    setLoading(true);
    setLoadingLabel("Generating judge prompts...");
    setError(null);
    try {
      let info = agentInfo;
      if (!info) {
        const agentRes = await fetch(`/api/agents/${agentId}`);
        if (!agentRes.ok) throw new Error("Failed to load agent info.");
        const agentData = await agentRes.json();
        info = { name: agentData.name || agentId, domain: agentData.domain || "" };
        setAgentInfo(info);
      }
      const axialCodes = Object.keys(frequencies);
      const res = await fetch(`${API}/evaluate/generate-judge-prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          axial_codes: axialCodes,
          open_codes: codedSessions,
          agent_name: info.name,
          agent_domain: info.domain,
          session_type_breakdown: sessionTypeBreakdown,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setJudges(data.judges || []);
      setStep(4);
    } catch (e: any) {
      setError(e.message || "Failed to generate judge prompts.");
    } finally {
      setLoading(false);
    }
  }, [API, agentId, agentInfo, frequencies, codedSessions, sessionTypeBreakdown]);

  // ── Step 4: edit / regenerate a single judge prompt ────────────────────────
  const updateJudgePrompt = (axialCode: string, text: string) =>
    setJudges((prev) =>
      prev.map((j) => (j.axial_code === axialCode ? { ...j, system_prompt: text } : j))
    );

  const handleRegenerateJudge = useCallback(
    async (axialCode: string) => {
      if (!agentInfo) return;
      setRegenerating((prev) => new Set(prev).add(axialCode));
      setError(null);
      try {
        const res = await fetch(`${API}/evaluate/generate-judge-prompts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            axial_codes: [axialCode],
            open_codes: codedSessions,
            agent_name: agentInfo.name,
            agent_domain: agentInfo.domain,
            session_type_breakdown: sessionTypeBreakdown,
          }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const updated = data.judges?.[0];
        if (updated) {
          setJudges((prev) => prev.map((j) => (j.axial_code === axialCode ? updated : j)));
        }
      } catch (e: any) {
        setError(e.message || "Failed to regenerate judge prompt.");
      } finally {
        setRegenerating((prev) => {
          const next = new Set(prev);
          next.delete(axialCode);
          return next;
        });
      }
    },
    [API, agentInfo, codedSessions, sessionTypeBreakdown]
  );

  // ── Step 4 → 5: fetch transcripts + session context, stream judge decisions ─
  const handleRunJudges = useCallback(async () => {
    setStep(5);
    setRunningJudges(true);
    setError(null);
    setDecisions({});
    setJudgeProgress({ done: 0, total: 0 });
    try {
      const uniqueSessions = Array.from(
        new Map(openCodes.map((c) => [c.session_id, c])).values()
      ).map((c) => ({ session_id: c.session_id, experiment_type: c.experiment_type }));

      const [tRes, sessionsRes, tasksRes] = await Promise.all([
        fetch(`${API}/evaluate/fetch-transcripts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessions: uniqueSessions }),
        }),
        fetch(`/api/agents/${agentId}/sessions`),
        fetch(`/api/agents/${agentId}/tasks`),
      ]);
      if (!tRes.ok) throw new Error(await tRes.text());
      const tData = await tRes.json();
      const fetchedTranscripts: Transcript[] = tData.transcripts || [];

      if (sessionsRes.ok && tasksRes.ok) {
        const sessionsData = await sessionsRes.json();
        const tasksData = await tasksRes.json();
        const taskTitleById: Record<string, string> = {};
        for (const t of tasksData.tasks || []) taskTitleById[t.task_id] = t.title;
        const relevantIds = new Set(uniqueSessions.map((s) => s.session_id));
        const contexts: Record<string, SessionContext> = {};
        for (const s of sessionsData.sessions || []) {
          if (!relevantIds.has(s.session_id)) continue;
          contexts[s.session_id] = {
            experiment_type: s.experiment_type || "conversation",
            persona: s.experiment_type === "conversation" || !s.experiment_type ? s.user_profile : "",
            difficulty: s.difficulty,
            goal: s.hidden_goal,
            taskTitle: s.task_id ? taskTitleById[s.task_id] || "" : "",
            score: s.total_score ?? null,
          };
        }
        setSessionContexts(contexts);
      }

      const res = await fetch(`${API}/evaluate/run-judges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ judges, transcripts: fetchedTranscripts }),
      });
      if (!res.ok || !res.body) throw new Error(await res.text());

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const live: DecisionMap = {};
      judges.forEach((j) => {
        live[j.axial_code] = {};
      });

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === "progress") {
            live[msg.axial_code] = { ...live[msg.axial_code], [msg.session_id]: msg.decision };
            setDecisions({ ...live });
            setJudgeProgress({ done: msg.done, total: msg.total });
          } else if (msg.type === "done") {
            setDecisions(msg.decisions);
            const initHuman: HumanMap = {};
            for (const code of Object.keys(msg.decisions)) {
              initHuman[code] = {};
              for (const sid of Object.keys(msg.decisions[code])) {
                initHuman[code][sid] = msg.decisions[code][sid] === "TRUE";
              }
            }
            setHumanLabels(initHuman);
          }
        }
      }
    } catch (e: any) {
      setError(e.message || "Failed to run judges.");
    } finally {
      setRunningJudges(false);
    }
  }, [API, agentId, judges, openCodes]);

  const toggleHumanLabel = (axialCode: string, sessionId: string) =>
    setHumanLabels((prev) => ({
      ...prev,
      [axialCode]: {
        ...prev[axialCode],
        [sessionId]: !prev[axialCode]?.[sessionId],
      },
    }));

  // ── Step 5 → 6: compute metrics client-side from the decision matrix ──────
  const handleComputeMetrics = useCallback(() => {
    const sessionType: Record<string, ExperimentType> = {};
    for (const c of openCodes) sessionType[c.session_id] = c.experiment_type;

    const computed: Record<string, JudgeMetrics> = {};
    const computedByType: Record<string, Record<string, JudgeMetrics>> = {};
    for (const judge of judges) {
      const judgeDecisions = decisions[judge.axial_code] || {};
      const humanForCode = humanLabels[judge.axial_code] || {};
      computed[judge.axial_code] = computeMetrics(judgeDecisions, humanForCode);

      const byType: Record<string, Record<string, string>> = {};
      for (const [sid, decision] of Object.entries(judgeDecisions)) {
        const t = sessionType[sid] || "conversation";
        byType[t] = byType[t] || {};
        byType[t][sid] = decision;
      }
      computedByType[judge.axial_code] = Object.fromEntries(
        Object.entries(byType).map(([t, dec]) => [t, computeMetrics(dec, humanForCode)])
      );
    }
    setMetrics(computed);
    setMetricsByType(computedByType);
    setStep(6);
  }, [judges, decisions, humanLabels, openCodes]);

  // ── Step 6: full report download ───────────────────────────────────────────
  const handleDownloadReport = useCallback(async () => {
    const res = await fetch(`${API}/evaluate/export-judge-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        judges,
        decisions,
        human_labels: humanLabels,
        metrics,
        open_codes: openCodes,
        agent_name: agentInfo?.name || agentId,
        metrics_by_type: metricsByType,
      }),
    });
    if (!res.ok) return;
    const cd = res.headers.get("Content-Disposition") || "";
    const nameMatch = cd.match(/filename="([^"]+)"/);
    const filename = nameMatch ? nameMatch[1] : "judge_eval.csv";
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    setReportDownloaded(true);
  }, [API, judges, decisions, humanLabels, metrics, metricsByType, openCodes, agentInfo, agentId]);

  // ── Category editing helpers ───────────────────────────────────────────────
  const updateCategory = (i: number, val: string) =>
    setCategories((prev) => prev.map((c, idx) => (idx === i ? val : c)));
  const removeCategory = (i: number) =>
    setCategories((prev) => prev.filter((_, idx) => idx !== i));
  const addCategory = () => setCategories((prev) => [...prev, ""]);
  const mergeCategories = (i: number) =>
    setCategories((prev) => {
      if (i < 0 || i + 1 >= prev.length) return prev;
      const next = [...prev];
      next.splice(i, 2, `${prev[i]} + ${prev[i + 1]}`.trim());
      return next;
    });

  const sessionCount = new Set(openCodes.map((c) => c.session_id)).size;

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-gray-800 shrink-0">
          <div>
            <h2 className="text-lg font-semibold text-white">Qualitative Evaluate</h2>
            <p className="text-xs text-gray-500 mt-0.5">Axial coding from Langfuse trace comments</p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <StepIndicator step={step} />

          {error && (
            <div className="mb-4 px-3 py-2 rounded bg-red-900/40 border border-red-700 text-red-300 text-sm">
              {error}
            </div>
          )}

          {/* ── Step 1 ── */}
          {step === 1 && (
            <>
              {!fetchStarted ? (
                <div className="py-8">
                  <p className="text-sm text-gray-400 mb-4">
                    Fetch comments left on this agent's Langfuse traces to build open codes.
                  </p>
                  <label className="block text-xs text-gray-500 mb-1.5">
                    Only check the N most recent sessions (optional)
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={1}
                      value={recentLimit}
                      onChange={(e) => setRecentLimit(e.target.value)}
                      placeholder="All sessions"
                      className="w-40 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      onClick={handleFetchComments}
                      className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                    >
                      Fetch Comments
                    </button>
                  </div>
                </div>
              ) : loading ? (
                <Spinner label={loadingLabel} />
              ) : openCodes.length === 0 ? (
                <div className="py-12 text-center text-gray-400">
                  <div className="text-4xl mb-4">💬</div>
                  <p className="text-sm font-medium text-gray-300 mb-2">
                    No Langfuse comments found for this agent's sessions.
                  </p>
                  <p className="text-xs text-gray-500">
                    Add comments to traces in Langfuse to use this feature.
                  </p>
                  <button
                    onClick={onClose}
                    className="mt-6 px-4 py-2 rounded border border-gray-700 text-gray-400 hover:text-white text-sm transition-colors"
                  >
                    Close
                  </button>
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-400 mb-3">
                    <span className="text-white font-medium">{openCodes.length}</span> comment
                    {openCodes.length !== 1 ? "s" : ""} found across{" "}
                    <span className="text-white font-medium">{sessionCount}</span> session
                    {sessionCount !== 1 ? "s" : ""}
                    {Object.keys(sessionTypeBreakdown).length > 0 && (
                      <>
                        {" "}
                        (
                        {(["conversation", "single_output", "multi_step"] as ExperimentType[])
                          .filter((t) => sessionTypeBreakdown[t])
                          .map((t) => `${sessionTypeBreakdown[t]} ${SESSION_TYPE_LABELS[t]}`)
                          .join(", ")}
                        )
                      </>
                    )}
                  </p>
                  <div className="flex items-center gap-4 mb-4 text-xs text-gray-500">
                    <span>{sessionsChecked} sessions scanned</span>
                    {fetchTime !== null && <span>{fetchTime}s fetch time</span>}
                    {timedOut && (
                      <span className="text-amber-500">⚠ Partial results (timeout)</span>
                    )}
                  </div>
                  <div className="border border-gray-800 rounded-lg overflow-hidden mb-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                          <th className="text-left px-4 py-2.5 w-40">Session</th>
                          <th className="text-left px-4 py-2.5">Comment</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {openCodes.map((c, i) => (
                          <tr key={i} className="hover:bg-gray-800/30">
                            <td className="px-4 py-2.5 font-mono text-xs text-gray-500">
                              {c.session_id.slice(0, 8)}…
                            </td>
                            <td className="px-4 py-2.5 text-gray-300">{c.comment}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <button
                    onClick={handleGenerateCodes}
                    className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
                  >
                    Generate Axial Codes →
                  </button>
                </>
              )}
            </>
          )}

          {/* ── Step 2 ── */}
          {step === 2 && (
            <>
              {loading ? (
                <Spinner label={loadingLabel} />
              ) : (
                <>
                  <p className="text-sm text-gray-400 mb-4">
                    Review and edit the proposed categories. You can rename, remove, or add new ones.
                  </p>
                  {categories.length > 4 && (
                    <div className="mb-4 px-3 py-2 rounded bg-amber-900/30 border border-amber-700 text-amber-300 text-xs">
                      ⚠️ {categories.length} categories were proposed. We recommend consolidating to 4 or
                      fewer for reliable judge performance. Categories that frequently co-occur may be too
                      granular — use Merge below to combine them.
                    </div>
                  )}
                  <div className="space-y-1 mb-4">
                    {categories.map((cat, i) => (
                      <Fragment key={i}>
                        <div className="flex items-center gap-2">
                          <span className="text-gray-600 text-xs w-5 text-right">{i + 1}.</span>
                          <input
                            value={cat}
                            onChange={(e) => updateCategory(i, e.target.value)}
                            className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-white focus:outline-none focus:border-indigo-500"
                            placeholder="Category name…"
                          />
                          <button
                            onClick={() => removeCategory(i)}
                            className="text-gray-600 hover:text-red-400 transition-colors p-1"
                            title="Remove"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>
                        {i < categories.length - 1 && (
                          <div className="flex items-center gap-2 pl-7">
                            <div className="flex-1 h-px bg-gray-800" />
                            <button
                              onClick={() => mergeCategories(i)}
                              className="text-[11px] text-gray-500 hover:text-indigo-400 transition-colors flex items-center gap-1 px-1"
                              title="Merge these two categories into one"
                            >
                              ⇅ Merge
                            </button>
                            <div className="flex-1 h-px bg-gray-800" />
                          </div>
                        )}
                      </Fragment>
                    ))}
                  </div>
                  <button
                    onClick={addCategory}
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors mb-6 flex items-center gap-1"
                  >
                    <span>+</span> Add Category
                  </button>
                  <p className="text-xs text-gray-500 mb-4">
                    These categories will be used to classify all{" "}
                    <span className="text-gray-300">{openCodes.length}</span> comments.
                  </p>
                  <button
                    onClick={handleAssignCodes}
                    disabled={!categories.some((c) => c.trim())}
                    className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                  >
                    Confirm & Assign Codes →
                  </button>
                </>
              )}
            </>
          )}

          {/* ── Step 3 ── */}
          {step === 3 && (
            <>
              {loading ? (
                <Spinner label={loadingLabel} />
              ) : (
                <p className="text-sm text-gray-400">
                  <span className="text-white font-medium">{codedSessions.length}</span> session
                  {codedSessions.length !== 1 ? "s" : ""} coded across{" "}
                  <span className="text-white font-medium">{Object.keys(frequencies).length}</span>{" "}
                  axial code{Object.keys(frequencies).length !== 1 ? "s" : ""}
                </p>
              )}
            </>
          )}

          {/* ── Step 4 ── */}
          {step === 4 && (
            <>
              {loading ? (
                <Spinner label={loadingLabel} />
              ) : (
                <>
                  <p className="text-sm text-gray-400 mb-4">
                    Review and edit each judge's system prompt before running them against session
                    transcripts.
                  </p>
                  <div className="space-y-4 mb-6">
                    {judges.map((judge) => {
                      const isRegenerating = regenerating.has(judge.axial_code);
                      return (
                        <div
                          key={judge.axial_code}
                          className={`border border-gray-800 border-l-4 rounded-lg p-4 ${codeBorderColor(
                            judge.axial_code,
                            Object.keys(frequencies)
                          )}`}
                        >
                          <div className="flex items-center justify-between mb-2">
                            <h4 className="text-sm font-medium text-white">{judge.axial_code}</h4>
                            <button
                              onClick={() => handleRegenerateJudge(judge.axial_code)}
                              disabled={isRegenerating}
                              className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-40 transition-colors flex items-center gap-1"
                            >
                              {isRegenerating ? "Regenerating…" : "↻ Regenerate"}
                            </button>
                          </div>
                          <textarea
                            value={judge.system_prompt}
                            onChange={(e) => updateJudgePrompt(judge.axial_code, e.target.value)}
                            rows={8}
                            spellCheck={false}
                            className="w-full bg-gray-950 border border-gray-800 rounded px-3 py-2 text-xs font-mono text-gray-300 focus:outline-none focus:border-indigo-500 resize-y"
                          />
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={handleRunJudges}
                    disabled={judges.length === 0}
                    className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                  >
                    Run Judges →
                  </button>
                </>
              )}
            </>
          )}

          {/* ── Step 5 ── */}
          {step === 5 && (
            <>
              {runningJudges ? (
                <div className="flex flex-col items-center justify-center py-16 gap-4 text-gray-400">
                  <div className="w-8 h-8 border-2 border-gray-600 border-t-indigo-400 rounded-full animate-spin" />
                  <span className="text-sm">
                    Running {judgeProgress.total || judges.length * sessionCount} judge evaluations...
                  </span>
                  {judgeProgress.total > 0 && (
                    <span className="text-xs text-gray-500">
                      {judgeProgress.done} of {judgeProgress.total} complete
                    </span>
                  )}
                </div>
              ) : (
                <>
                  <p className="text-sm text-gray-400 mb-1">
                    Review each judge's decisions below. Check the Human column to indicate ground
                    truth. Uncheck to mark as FALSE.
                  </p>
                  <p className="text-xs text-gray-500 mb-4">
                    {sessionCount} sessions × {judges.length} judge{judges.length !== 1 ? "s" : ""}
                  </p>
                  <div className="border border-gray-800 rounded-lg overflow-x-auto mb-4">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                          <th
                            className="text-left px-4 py-2.5 w-32 sticky left-0 z-20 bg-gray-800"
                            rowSpan={2}
                          >
                            Session
                          </th>
                          <th
                            className="text-left px-2 py-2.5 w-16 sticky left-32 z-20 bg-gray-800"
                            rowSpan={2}
                          >
                            Type
                          </th>
                          <th
                            className="text-left px-4 py-2.5 min-w-[250px] max-w-[350px] sticky left-48 z-20 bg-gray-800"
                            rowSpan={2}
                          >
                            Comment
                          </th>
                          {judges.map((j) => (
                            <th
                              key={j.axial_code}
                              className="text-center px-2 py-1.5 border-l border-gray-800 whitespace-nowrap"
                              colSpan={2}
                            >
                              {j.axial_code}
                            </th>
                          ))}
                        </tr>
                        <tr className="bg-gray-800/40 text-gray-500 text-[10px] uppercase tracking-wide">
                          {judges.map((j) => (
                            <Fragment key={j.axial_code}>
                              <th className="text-center px-2 py-1 border-l border-gray-800">Judge</th>
                              <th className="text-center px-2 py-1">Human</th>
                            </Fragment>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {openCodes.map((c) => (
                          <tr key={c.session_id} className="hover:bg-gray-800/30">
                            <td className="px-4 py-2 font-mono text-xs text-gray-500 sticky left-0 z-10 bg-gray-900">
                              <a
                                href={`/agents/${agentId}/sessions/${c.session_id}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-indigo-400 hover:text-indigo-300 underline font-mono text-xs"
                                onMouseEnter={(e) => {
                                  const rect = e.currentTarget.getBoundingClientRect();
                                  setHoverAnchor({ top: rect.bottom + 4, left: rect.left });
                                  setHoveredSession(c.session_id);
                                }}
                                onMouseLeave={() => setHoveredSession(null)}
                              >
                                {c.session_id.slice(0, 8)}...
                              </a>
                            </td>
                            <td className="px-2 py-2 sticky left-32 z-10 bg-gray-900">
                              <TypeBadge type={c.experiment_type} />
                            </td>
                            <td className="px-4 py-2 text-gray-300 text-xs whitespace-normal break-words min-w-[250px] max-w-[350px] sticky left-48 z-10 bg-gray-900">
                              {c.comment}
                            </td>
                            {judges.map((j) => {
                              const judgeVal = decisions[j.axial_code]?.[c.session_id];
                              const humanVal = humanLabels[j.axial_code]?.[c.session_id] ?? false;
                              return (
                                <Fragment key={j.axial_code}>
                                  <td className="text-center px-2 py-2 border-l border-gray-800">
                                    {judgeVal ? (
                                      <span
                                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                          judgeVal === "TRUE"
                                            ? "bg-emerald-900 text-emerald-300"
                                            : "bg-rose-900 text-rose-300"
                                        }`}
                                      >
                                        {judgeVal}
                                      </span>
                                    ) : (
                                      <span className="text-gray-700 text-xs">…</span>
                                    )}
                                  </td>
                                  <td className="text-center px-2 py-2">
                                    <input
                                      type="checkbox"
                                      checked={humanVal}
                                      onChange={() => toggleHumanLabel(j.axial_code, c.session_id)}
                                      className="w-3.5 h-3.5 accent-indigo-500"
                                    />
                                  </td>
                                </Fragment>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {hoveredSession && hoverAnchor && (
                    <SessionPopover
                      agentId={agentId}
                      sessionId={hoveredSession}
                      ctx={sessionContexts[hoveredSession]}
                      anchor={hoverAnchor}
                    />
                  )}
                  <label className="flex items-center gap-2 mb-4 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={reviewedConfirmed}
                      onChange={(e) => setReviewedConfirmed(e.target.checked)}
                      className="w-4 h-4 accent-indigo-500"
                    />
                    I've reviewed all decisions
                  </label>
                  <button
                    onClick={handleComputeMetrics}
                    disabled={!reviewedConfirmed}
                    className="px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                  >
                    Compute Metrics →
                  </button>
                </>
              )}
            </>
          )}

          {/* ── Step 6 ── */}
          {step === 6 && (
            <>
              {/* Section 1: judge system prompts */}
              <div className="mb-6">
                <button
                  onClick={() => setPromptsExpanded((v) => !v)}
                  className="flex items-center gap-2 text-sm font-medium text-gray-300 mb-3"
                >
                  <svg
                    className={`w-4 h-4 transition-transform ${promptsExpanded ? "rotate-90" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  Judge System Prompts
                </button>
                {promptsExpanded && (
                  <div className="space-y-3">
                    {judges.map((judge) => (
                      <div key={judge.axial_code} className="border border-gray-800 rounded-lg p-3">
                        <h5 className="text-xs font-medium text-gray-300 mb-2">{judge.axial_code}</h5>
                        <pre className="whitespace-pre-wrap text-[11px] font-mono text-gray-500 bg-gray-950 rounded p-2 max-h-48 overflow-y-auto">
                          {judge.system_prompt}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Section 2: decision matrix */}
              <h3 className="text-sm font-medium text-gray-300 mb-3">Decision Matrix</h3>
              <div className="border border-gray-800 rounded-lg overflow-x-auto mb-6">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                      <th className="text-left px-4 py-2.5 w-32">Session</th>
                      <th className="text-left px-4 py-2.5">Comment</th>
                      {judges.map((j) => (
                        <th
                          key={j.axial_code}
                          className="text-center px-2 py-1.5 border-l border-gray-800 whitespace-nowrap"
                        >
                          {j.axial_code}
                          <div className="text-[9px] text-gray-600 normal-case">Judge / Human</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {openCodes.map((c) => (
                      <tr key={c.session_id} className="hover:bg-gray-800/30">
                        <td className="px-4 py-2 font-mono text-xs text-gray-500">
                          {c.session_id.slice(0, 8)}…
                        </td>
                        <td
                          className="px-4 py-2 text-gray-300 text-xs max-w-xs truncate"
                          title={c.comment}
                        >
                          {c.comment}
                        </td>
                        {judges.map((j) => {
                          const judgeVal = decisions[j.axial_code]?.[c.session_id];
                          const humanVal = humanLabels[j.axial_code]?.[c.session_id] ?? false;
                          const agree = (judgeVal === "TRUE") === humanVal;
                          return (
                            <td
                              key={j.axial_code}
                              className={`text-center px-2 py-2 border-l border-gray-800 text-[10px] font-medium ${
                                agree
                                  ? "bg-emerald-950/60 text-emerald-300"
                                  : "bg-rose-950/60 text-rose-300"
                              }`}
                            >
                              {judgeVal || "…"} / {humanVal ? "TRUE" : "FALSE"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Section 3: performance metrics */}
              <h3 className="text-sm font-medium text-gray-300 mb-3">Performance Metrics</h3>
              <div className="border border-gray-800 rounded-lg overflow-x-auto mb-6">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                      <th className="text-left px-4 py-2.5">Axial Code</th>
                      <th className="text-center px-2 py-2.5">TP</th>
                      <th className="text-center px-2 py-2.5">TN</th>
                      <th className="text-center px-2 py-2.5">FP</th>
                      <th className="text-center px-2 py-2.5">FN</th>
                      <th className="text-center px-2 py-2.5">Accuracy</th>
                      <th className="text-center px-2 py-2.5">Precision</th>
                      <th className="text-center px-2 py-2.5">Recall</th>
                      <th className="text-center px-2 py-2.5">F1</th>
                      <th className="text-center px-2 py-2.5">AUC</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {judges.map((j) => {
                      const m = metrics[j.axial_code];
                      if (!m) return null;
                      return (
                        <tr key={j.axial_code} className="hover:bg-gray-800/30">
                          <td className="px-4 py-2.5 text-gray-300">{j.axial_code}</td>
                          <td className="text-center px-2 py-2.5 text-gray-400">{m.TP}</td>
                          <td className="text-center px-2 py-2.5 text-gray-400">{m.TN}</td>
                          <td className="text-center px-2 py-2.5 text-gray-400">{m.FP}</td>
                          <td className="text-center px-2 py-2.5 text-gray-400">{m.FN}</td>
                          <td className="text-center px-2 py-2.5 text-gray-300">{m.accuracy.toFixed(2)}</td>
                          <td className="text-center px-2 py-2.5 text-gray-300">{m.precision.toFixed(2)}</td>
                          <td className="text-center px-2 py-2.5 text-gray-300">{m.recall.toFixed(2)}</td>
                          <td className="text-center px-2 py-2.5 text-gray-300">{m.f1.toFixed(2)}</td>
                          <td className={`text-center px-2 py-2.5 font-semibold ${aucColor(m.auc)}`}>
                            {m.auc.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Section 4: per-session-type breakdown — surfaces judges that do well on
                  one session type but poorly on another, which the aggregate row hides */}
              {Object.keys(sessionTypeBreakdown).length > 1 && (
                <>
                  <h3 className="text-sm font-medium text-gray-300 mb-3">Session Type Breakdown</h3>
                  <div className="border border-gray-800 rounded-lg overflow-x-auto mb-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                          <th className="text-left px-4 py-2.5">Axial Code</th>
                          <th className="text-left px-4 py-2.5">Session Type</th>
                          <th className="text-center px-2 py-2.5">TP</th>
                          <th className="text-center px-2 py-2.5">TN</th>
                          <th className="text-center px-2 py-2.5">FP</th>
                          <th className="text-center px-2 py-2.5">FN</th>
                          <th className="text-center px-2 py-2.5">Accuracy</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {judges.flatMap((j) => {
                          const byType = metricsByType[j.axial_code] || {};
                          return (["conversation", "single_output", "multi_step"] as ExperimentType[])
                            .filter((t) => byType[t])
                            .map((t) => {
                              const m = byType[t];
                              return (
                                <tr key={`${j.axial_code}-${t}`} className="hover:bg-gray-800/30">
                                  <td className="px-4 py-2 text-gray-300">{j.axial_code}</td>
                                  <td className="px-4 py-2">
                                    <TypeBadge type={t} />
                                  </td>
                                  <td className="text-center px-2 py-2 text-gray-400">{m.TP}</td>
                                  <td className="text-center px-2 py-2 text-gray-400">{m.TN}</td>
                                  <td className="text-center px-2 py-2 text-gray-400">{m.FP}</td>
                                  <td className="text-center px-2 py-2 text-gray-400">{m.FN}</td>
                                  <td className="text-center px-2 py-2 text-gray-300">{m.accuracy.toFixed(2)}</td>
                                </tr>
                              );
                            });
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {step === 3 && !loading && (
          <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3 shrink-0">
            <button
              onClick={handleDownloadCSV}
              className="flex items-center gap-2 px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download CSV
            </button>
            <button
              onClick={handleContinueToJudges}
              className="px-4 py-2 rounded border border-indigo-600 text-indigo-300 hover:bg-indigo-600/20 text-sm font-medium transition-colors"
            >
              Continue to Judge Pipeline →
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 rounded border border-gray-700 text-gray-400 hover:text-white text-sm transition-colors"
            >
              Close
            </button>
          </div>
        )}
        {step === 6 && !loading && Object.keys(metrics).length > 0 && (
          <div className="px-6 py-4 border-t border-gray-800 flex items-center gap-3 shrink-0">
            <button
              onClick={handleDownloadReport}
              className="flex items-center gap-2 px-4 py-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Full Report
            </button>
            {reportDownloaded && (
              <span className="text-xs text-gray-500">
                Report downloaded. Close this modal to clear all judge data from memory.
              </span>
            )}
            <button
              onClick={onClose}
              className="ml-auto px-4 py-2 rounded border border-gray-700 text-gray-400 hover:text-white text-sm transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
