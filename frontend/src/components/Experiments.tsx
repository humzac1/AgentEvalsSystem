import { useEffect, useRef, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

interface PromptVersion {
  version_id: number;
  version_number: number;
  prompt_text: string;
  created_at: string;
  is_active: number;
  parent_version_id: number | null;
  change_summary: string | null;
}

interface Batch {
  batch_id: string;
  prompt_version_id: number | null;
  ran_at: string;
  session_count: number;
  avg_total_score: number | null;
  goal_achievement_rate: number | null;
  avg_resolution: number | null;
  avg_clarity: number | null;
  avg_handling: number | null;
  avg_accuracy: number | null;
  optimizer_accepted: number;
  in_optimizer_run: number;
  version_number: number | null;
}

interface ProfileSummary {
  user_profile: string;
  session_count: number;
  goals_achieved: number;
}

function formatTs(ts: string) {
  try {
    return new Date(ts + "Z").toLocaleString();
  } catch {
    return ts;
  }
}

function profileLabel(p: string) {
  const map: Record<string, string> = {
    confused_novice: "Novice",
    impatient_expert: "Expert",
    adversarial_user: "Adversarial",
  };
  return map[p] ?? p;
}

// ── Prompt modal ──────────────────────────────────────────────────────────────

function PromptModal({
  version,
  onClose,
}: {
  version: PromptVersion;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl p-6 max-w-2xl w-full mx-4 max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white font-semibold text-lg">
            Prompt v{version.version_number}
            {version.is_active ? (
              <span className="ml-2 text-xs bg-emerald-900/60 text-emerald-300 border border-emerald-700 px-2 py-0.5 rounded font-medium">
                Active
              </span>
            ) : null}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white text-xl leading-none"
          >
            ×
          </button>
        </div>
        {version.change_summary && (
          <p className="text-gray-400 text-xs mb-3 italic">{version.change_summary}</p>
        )}
        <div className="flex-1 overflow-y-auto">
          <pre className="text-gray-300 text-xs whitespace-pre-wrap font-mono bg-gray-950 rounded p-4 border border-gray-800">
            {version.prompt_text}
          </pre>
        </div>
        <p className="text-gray-600 text-xs mt-3">
          Created {formatTs(version.created_at)}
        </p>
      </div>
    </div>
  );
}

// ── Goal achievement tooltip (Fix 2) ─────────────────────────────────────────

function GoalTooltip({ batchId }: { batchId: string }) {
  const [profiles, setProfiles] = useState<ProfileSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    fetch(`/api/batches/${batchId}/sessions-summary`)
      .then((r) => r.json())
      .then((d) => {
        setProfiles(d.profiles ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [batchId]);

  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-48 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-2.5 text-xs pointer-events-none">
      <p className="text-gray-400 font-medium mb-1.5">Goal achievement</p>
      {loading && <p className="text-gray-500">Loading…</p>}
      {profiles &&
        profiles.map((p) => (
          <div key={p.user_profile} className="flex justify-between items-center py-0.5">
            <span className="text-gray-300">{profileLabel(p.user_profile)}</span>
            <span
              className={
                p.goals_achieved === 0 ? "text-red-400 font-medium" : "text-emerald-400 font-medium"
              }
            >
              {p.goals_achieved}/{p.session_count}
            </span>
          </div>
        ))}
      {profiles && profiles.length === 0 && (
        <p className="text-gray-600">No session data</p>
      )}
      {/* Arrow */}
      <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-gray-700" />
    </div>
  );
}

function GoalRateCell({ batch }: { batch: Batch }) {
  const [hovered, setHovered] = useState(false);
  const rate = batch.goal_achievement_rate;

  if (rate === null) return <span className="text-gray-600">—</span>;

  const pct = Math.round(rate * 100);
  const isZero = pct === 0;

  return (
    <div
      className="relative inline-flex items-center gap-1"
      onMouseEnter={() => isZero && setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="text-gray-300 text-xs">{pct}%</span>
      {isZero && (
        <span className="text-yellow-400 text-xs cursor-help leading-none" title="">
          ⚠
        </span>
      )}
      {isZero && hovered && <GoalTooltip batchId={batch.batch_id} />}
    </div>
  );
}

// ── Optimizer status cell (Fix 1) ─────────────────────────────────────────────

function OptimizerCell({ batch }: { batch: Batch }) {
  if (!batch.in_optimizer_run) {
    return (
      <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-800 text-gray-500 border border-gray-700">
        Manual
      </span>
    );
  }
  if (batch.optimizer_accepted) {
    return <span className="text-xs text-emerald-400 font-medium">✓ Accepted</span>;
  }
  return <span className="text-xs text-red-400 font-medium">✗ Rejected</span>;
}

// ── Custom x-axis tick (Fix 3) ────────────────────────────────────────────────

interface TickProps {
  x?: number;
  y?: number;
  payload?: { value: string };
  containerWidth?: number;
}

function CustomXTick({ x = 0, y = 0, payload, containerWidth = 400 }: TickProps) {
  if (!payload?.value) return null;
  // payload.value is like "#1 · v2" — split on " · "
  const [batchPart, versionPart] = payload.value.split(" · ");
  const narrow = containerWidth < 480;

  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={12}
        textAnchor="middle"
        fill="#9ca3af"
        fontSize={11}
      >
        {batchPart}
      </text>
      {!narrow && versionPart && (
        <text
          x={0}
          y={0}
          dy={23}
          textAnchor="middle"
          fill="#4b5563"
          fontSize={9}
        >
          {versionPart}
        </text>
      )}
    </g>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Experiments() {
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [activeVersionId, setActiveVersionId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<PromptVersion | null>(null);
  const [chartWidth, setChartWidth] = useState(600);
  const chartRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/prompt-versions").then((r) => r.json()),
      fetch("/api/batches").then((r) => r.json()),
    ])
      .then(([pvData, batchData]) => {
        setVersions(pvData.versions ?? []);
        setActiveVersionId(pvData.active_version_id ?? null);
        // Sort batches oldest-first for the chart
        const sorted = [...(batchData.batches ?? [])].sort(
          (a, b) => new Date(a.ran_at).getTime() - new Date(b.ran_at).getTime()
        );
        setBatches(sorted);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  // Track chart container width for responsive x-axis labels
  useEffect(() => {
    if (!chartRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setChartWidth(w);
    });
    ro.observe(chartRef.current);
    return () => ro.disconnect();
  }, []);

  if (loading) return <p className="text-gray-500 mt-8 text-sm">Loading experiments…</p>;
  if (error) return <p className="text-red-400 mt-8 text-sm">Error: {error}</p>;

  if (versions.length === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-gray-400 text-lg mb-2">No experiment data yet</p>
        <p className="text-gray-600 text-sm">
          Run{" "}
          <code className="bg-gray-800 px-1.5 py-0.5 rounded text-gray-300">
            python run.py
          </code>{" "}
          in the backend to start optimizing.
        </p>
      </div>
    );
  }

  // Chart data (Fix 3: label includes version)
  const chartData = batches
    .filter((b) => b.avg_total_score !== null)
    .map((b, i) => ({
      index: i + 1,
      // Full label for wide screens; CustomXTick splits on " · "
      label: b.version_number !== null ? `#${i + 1} · v${b.version_number}` : `#${i + 1}`,
      // Tooltip-only version string for narrow screens
      version: b.version_number !== null ? `v${b.version_number}` : "—",
      score: b.avg_total_score !== null ? Math.round(b.avg_total_score * 10) / 10 : null,
      accepted: b.optimizer_accepted === 1,
    }));

  // Fix 4: delta scores — compare each batch to the previous one
  const batchesWithDelta = batches.map((b, i) => {
    const prev = batches[i - 1];
    const delta =
      i > 0 && b.avg_total_score !== null && prev?.avg_total_score !== null
        ? b.avg_total_score - prev.avg_total_score!
        : null;
    return { ...b, delta };
  });

  const activeVersion = versions.find((v) => v.version_id === activeVersionId);

  return (
    <div>
      {selectedVersion && (
        <PromptModal
          version={selectedVersion}
          onClose={() => setSelectedVersion(null)}
        />
      )}

      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Experiments</h1>
        <div className="flex items-center gap-3">
          {activeVersion && (
            <span className="text-gray-400 text-sm">
              Active:{" "}
              <span className="text-emerald-400 font-medium">
                v{activeVersion.version_number}
              </span>
            </span>
          )}
          <span className="text-gray-500 text-sm">{versions.length} versions</span>
        </div>
      </div>

      {/* Score progression chart */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-4" ref={chartRef}>
        <h3 className="text-sm font-medium text-gray-300 mb-3">
          Avg Score Progression Across Batches
        </h3>
        {chartData.length === 0 ? (
          <p className="text-gray-600 text-xs">No evaluated batches yet.</p>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: -20, bottom: 16 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                dataKey="label"
                tick={(props) => <CustomXTick {...props} containerWidth={chartWidth} />}
                axisLine={false}
                tickLine={false}
                height={36}
              />
              <YAxis
                domain={[0, 40]}
                tick={{ fill: "#6b7280", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  borderRadius: "6px",
                  color: "#f3f4f6",
                  fontSize: "12px",
                }}
                formatter={(value, _name, props) => [
                  `${value}/40 (${props.payload.version})`,
                  "Avg Score",
                ]}
                labelFormatter={(label) => {
                  // On narrow screens the label is just "#N"; add version from payload
                  return label;
                }}
              />
              <ReferenceLine y={30} stroke="#10b981" strokeDasharray="4 4" strokeOpacity={0.4} />
              <ReferenceLine y={20} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.4} />
              <Line
                type="monotone"
                dataKey="score"
                stroke="#6366f1"
                strokeWidth={2}
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  const color = payload.accepted ? "#10b981" : "#6366f1";
                  return (
                    <circle
                      key={`dot-${payload.index}`}
                      cx={cx}
                      cy={cy}
                      r={5}
                      fill={color}
                      stroke={color}
                    />
                  );
                }}
                activeDot={{ r: 7 }}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
        <div className="flex gap-4 mt-2">
          <span className="text-xs text-gray-600 flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full bg-emerald-500"></span>
            Accepted batch
          </span>
          <span className="text-xs text-gray-600 flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 rounded-full bg-indigo-500"></span>
            Rejected / manual batch
          </span>
          <span className="text-xs text-gray-600 flex items-center gap-1.5">
            <span className="inline-block w-3 h-1.5 bg-emerald-500 opacity-40 rounded"></span>
            High quality threshold (30)
          </span>
        </div>
      </div>

      {/* Prompt version history table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-medium text-gray-300">Prompt Version History</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900/50">
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Version</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Status</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Change Summary</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Created</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Parent</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {[...versions].reverse().map((v) => (
              <tr key={v.version_id} className="hover:bg-gray-900/40 transition-colors">
                <td className="px-4 py-3">
                  <span className="text-white font-medium">v{v.version_number}</span>
                </td>
                <td className="px-4 py-3">
                  {v.version_id === activeVersionId ? (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-emerald-900/60 text-emerald-300 border border-emerald-700">
                      Active
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-xs font-medium bg-gray-800 text-gray-500">
                      Inactive
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-300 text-xs max-w-xs">
                  {v.change_summary || (
                    <span className="text-gray-600 italic">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {formatTs(v.created_at)}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {v.parent_version_id !== null ? `v${v.parent_version_id}` : (
                    <span className="text-gray-700">seed</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <button
                    onClick={() => setSelectedVersion(v)}
                    className="px-3 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
                  >
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Batch history table */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden mt-4">
        <div className="px-4 py-3 border-b border-gray-800">
          <h3 className="text-sm font-medium text-gray-300">Batch History</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-800 bg-gray-900/50">
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Batch</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Prompt</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Sessions</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Avg Score</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Δ Score</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Goal Rate</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Optimizer</th>
              <th className="px-4 py-3 text-left text-gray-400 font-medium">Ran At</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800">
            {[...batchesWithDelta].reverse().map((b) => (
              <tr key={b.batch_id} className="hover:bg-gray-900/40 transition-colors">
                <td className="px-4 py-3 font-mono text-xs text-gray-500">
                  {b.batch_id.slice(0, 8)}…
                </td>
                <td className="px-4 py-3 text-gray-400 text-xs">
                  {b.version_number !== null ? `v${b.version_number}` : "—"}
                </td>
                <td className="px-4 py-3 text-gray-300">{b.session_count}</td>
                <td className="px-4 py-3">
                  {b.avg_total_score !== null ? (
                    <span
                      className={`font-medium ${
                        b.avg_total_score >= 30
                          ? "text-emerald-400"
                          : b.avg_total_score >= 20
                          ? "text-yellow-400"
                          : "text-red-400"
                      }`}
                    >
                      {b.avg_total_score.toFixed(1)}/40
                    </span>
                  ) : (
                    <span className="text-gray-600">—</span>
                  )}
                </td>
                {/* Fix 4: Δ Score */}
                <td className="px-4 py-3 text-xs font-medium">
                  {b.delta === null ? (
                    <span className="text-gray-600">—</span>
                  ) : (
                    <span className={b.delta >= 0 ? "text-emerald-400" : "text-red-400"}>
                      {b.delta >= 0 ? "+" : ""}
                      {b.delta.toFixed(1)}
                    </span>
                  )}
                </td>
                {/* Fix 2: Goal rate with warning tooltip */}
                <td className="px-4 py-3">
                  <GoalRateCell batch={b} />
                </td>
                {/* Fix 1: Optimizer status */}
                <td className="px-4 py-3">
                  <OptimizerCell batch={b} />
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{formatTs(b.ran_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
