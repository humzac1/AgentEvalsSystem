import { useState, useEffect, useCallback } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpenCode {
  session_id: string;
  comment: string;
  author: string;
  created_at: string;
}

interface CodedSession {
  session_id: string;
  comment: string;
  axial_codes: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PILL_COLORS = [
  "bg-indigo-900 text-indigo-300 border-indigo-700",
  "bg-emerald-900 text-emerald-300 border-emerald-700",
  "bg-amber-900 text-amber-300 border-amber-700",
  "bg-rose-900 text-rose-300 border-rose-700",
  "bg-purple-900 text-purple-300 border-purple-700",
  "bg-cyan-900 text-cyan-300 border-cyan-700",
];

function codePillColor(code: string, categories: string[]) {
  const idx = categories.indexOf(code);
  return PILL_COLORS[idx % PILL_COLORS.length];
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-4 text-gray-400">
      <div className="w-8 h-8 border-2 border-gray-600 border-t-indigo-400 rounded-full animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

function StepIndicator({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2 mb-6">
      {[1, 2, 3].map((s) => (
        <div key={s} className="flex items-center gap-2">
          <div
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border ${
              s < step
                ? "bg-indigo-600 border-indigo-600 text-white"
                : s === step
                ? "border-indigo-500 text-indigo-300"
                : "border-gray-700 text-gray-600"
            }`}
          >
            {s < step ? (
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              s
            )}
          </div>
          <span
            className={`text-xs ${
              s === step ? "text-gray-200" : s < step ? "text-gray-400" : "text-gray-600"
            }`}
          >
            {s === 1 ? "Fetch Comments" : s === 2 ? "Confirm Categories" : "Results & Export"}
          </span>
          {s < 3 && <div className="w-8 h-px bg-gray-700 mx-1" />}
        </div>
      ))}
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
  const [openCodes, setOpenCodes] = useState<OpenCode[]>([]);
  const [sessionsChecked, setSessionsChecked] = useState(0);
  const [fetchTime, setFetchTime] = useState<number | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  // Step 2
  const [categories, setCategories] = useState<string[]>([]);

  // Step 3
  const [codedSessions, setCodedSessions] = useState<CodedSession[]>([]);
  const [frequencies, setFrequencies] = useState<Record<string, number>>({});
  const [expandedComments, setExpandedComments] = useState<Set<string>>(new Set());

  // ── Step 1: fetch comments on mount ────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setLoadingLabel("Fetching Langfuse comments...");
    fetch(`${API}/langfuse-comments`)
      .then((r) => r.json())
      .then((data) => {
        setOpenCodes(data.comments || []);
        setSessionsChecked(data.sessions_checked || 0);
        setFetchTime(data.fetch_time_seconds ?? null);
        setTimedOut(!!data.timed_out);
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to fetch Langfuse comments.");
        setLoading(false);
      });
  }, [API]);

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

  // ── Category editing helpers ───────────────────────────────────────────────
  const updateCategory = (i: number, val: string) =>
    setCategories((prev) => prev.map((c, idx) => (idx === i ? val : c)));
  const removeCategory = (i: number) =>
    setCategories((prev) => prev.filter((_, idx) => idx !== i));
  const addCategory = () => setCategories((prev) => [...prev, ""]);

  const sessionCount = new Set(openCodes.map((c) => c.session_id)).size;

  // ── Chart data ─────────────────────────────────────────────────────────────
  const chartData = Object.entries(frequencies).map(([name, count]) => ({
    name,
    count,
  }));

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
              {loading ? (
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
                  <div className="space-y-2 mb-4">
                    {categories.map((cat, i) => (
                      <div key={i} className="flex items-center gap-2">
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
                <>
                  {/* Session coding table */}
                  <h3 className="text-sm font-medium text-gray-300 mb-3">Session Coding</h3>
                  <div className="border border-gray-800 rounded-lg overflow-hidden mb-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                          <th className="text-left px-4 py-2.5 w-36">Session</th>
                          <th className="text-left px-4 py-2.5">Comment</th>
                          <th className="text-left px-4 py-2.5 w-56">Axial Codes</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {codedSessions.map((item, i) => {
                          const key = `${item.session_id}-${i}`;
                          const isExpanded = expandedComments.has(key);
                          const truncated = item.comment.length > 100;
                          return (
                            <tr key={key} className="hover:bg-gray-800/30 align-top">
                              <td className="px-4 py-2.5">
                                <a
                                  href={`/agents/${agentId}/sessions/${item.session_id}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="font-mono text-xs text-indigo-400 hover:text-indigo-300"
                                >
                                  {item.session_id.slice(0, 8)}…
                                </a>
                              </td>
                              <td className="px-4 py-2.5 text-gray-300 text-xs">
                                {isExpanded || !truncated
                                  ? item.comment
                                  : `${item.comment.slice(0, 100)}…`}
                                {truncated && (
                                  <button
                                    onClick={() =>
                                      setExpandedComments((prev) => {
                                        const next = new Set(prev);
                                        if (isExpanded) next.delete(key);
                                        else next.add(key);
                                        return next;
                                      })
                                    }
                                    className="ml-1 text-indigo-400 hover:text-indigo-300 text-xs"
                                  >
                                    {isExpanded ? "less" : "more"}
                                  </button>
                                )}
                              </td>
                              <td className="px-4 py-2.5">
                                <div className="flex flex-wrap gap-1">
                                  {item.axial_codes.map((code) => (
                                    <span
                                      key={code}
                                      className={`px-1.5 py-0.5 rounded border text-xs ${codePillColor(
                                        code,
                                        Object.keys(frequencies)
                                      )}`}
                                    >
                                      {code}
                                    </span>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Frequency section */}
                  <h3 className="text-sm font-medium text-gray-300 mb-3">Frequency Summary</h3>
                  <div className="mb-4 h-48">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={chartData} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                        <XAxis
                          dataKey="name"
                          tick={{ fill: "#9ca3af", fontSize: 11 }}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          tick={{ fill: "#9ca3af", fontSize: 11 }}
                          allowDecimals={false}
                          axisLine={false}
                          tickLine={false}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#1f2937",
                            border: "1px solid #374151",
                            borderRadius: 6,
                            color: "#f3f4f6",
                            fontSize: 12,
                          }}
                          cursor={{ fill: "rgba(99,102,241,0.1)" }}
                        />
                        <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="border border-gray-800 rounded-lg overflow-hidden mb-6">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-gray-800/60 text-gray-400 text-xs uppercase tracking-wide">
                          <th className="text-left px-4 py-2.5">Axial Code</th>
                          <th className="text-left px-4 py-2.5 w-32">Session Count</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-800">
                        {Object.entries(frequencies).map(([cat, count]) => (
                          <tr key={cat} className="hover:bg-gray-800/30">
                            <td className="px-4 py-2.5 text-gray-300">{cat}</td>
                            <td className="px-4 py-2.5 text-white font-medium">{count}</td>
                          </tr>
                        ))}
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
              onClick={onClose}
              className="px-4 py-2 rounded border border-gray-700 text-gray-400 hover:text-white text-sm transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
