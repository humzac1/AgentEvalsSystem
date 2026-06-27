import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ComposedChart,
  BarChart,
  Bar,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  PieChart,
  Pie,
  Legend,
} from "recharts";

interface ProfileStat {
  user_profile: string;
  session_count: number;
  avg_total_score: number | null;
  goals_achieved: number;
  avg_goal_achievement: number | null;
  avg_response_quality: number | null;
  avg_handling: number | null;
  avg_staying_in_scope: number | null;
}

interface QualityDist {
  trajectory_quality: string;
  count: number;
}

interface FailureMode {
  mode: string;
  count: number;
}

interface StandoutMoment {
  moment: string;
  count: number;
}

interface Analytics {
  profile_stats: ProfileStat[];
  quality_distribution: QualityDist[];
  score_distribution: number[];
  top_failure_modes: FailureMode[];
  top_standout_moments: StandoutMoment[];
}

interface Session {
  session_id: string;
  user_profile: string;
  total_score: number | null;
  trajectory_quality: string | null;
}

const PROFILE_LABEL: Record<string, string> = {
  confused_novice: "Confused Novice",
  impatient_expert: "Impatient Expert",
  adversarial_user: "Adversarial User",
};

const QUALITY_COLORS: Record<string, string> = {
  high: "#10b981",
  medium: "#f59e0b",
  low: "#ef4444",
};

function ScoreHistogram({ scores }: { scores: number[] }) {
  // Build bins: 0-9, 10-19, 20-29, 30-39, 40-49, 50
  const bins = [
    { range: "0–9", min: 0, max: 10 },
    { range: "10–19", min: 10, max: 20 },
    { range: "20–29", min: 20, max: 30 },
    { range: "30–39", min: 30, max: 40 },
    { range: "40–49", min: 40, max: 50 },
    { range: "50", min: 50, max: 51 },
  ];

  const data = bins.map((b) => ({
    name: b.range,
    count: scores.filter((s) => s >= b.min && s < b.max).length,
  }));

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 8, right: 16, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
        <XAxis dataKey="name" tick={{ fill: "#9ca3af", fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            backgroundColor: "#111827",
            border: "1px solid #374151",
            borderRadius: "6px",
            color: "#f3f4f6",
            fontSize: "12px",
          }}
          cursor={{ fill: "rgba(255,255,255,0.03)" }}
        />
        <Bar dataKey="count" fill="#6366f1" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export default function Analytics({ agentId }: { agentId: string }) {
  const [data, setData] = useState<Analytics | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([
      fetch(`/api/agents/${agentId}/analytics`).then((r) => r.json()),
      fetch(`/api/agents/${agentId}/sessions`).then((r) => r.json()),
    ])
      .then(([analyticsData, sessionsData]) => {
        setData(analyticsData);
        setSessions(sessionsData.sessions ?? []);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  if (loading) return <p className="text-gray-500 mt-8 text-sm">Loading analytics…</p>;
  if (error) return <p className="text-red-400 mt-8 text-sm">Error: {error}</p>;
  if (!data) return null;

  const totalSessions = data.profile_stats.reduce((s, p) => s + p.session_count, 0);

  if (totalSessions === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-gray-400 text-lg mb-2">No data yet</p>
        <p className="text-gray-600 text-sm">
          Run <code className="bg-gray-800 px-1.5 py-0.5 rounded text-gray-300">python run_batch.py</code> to
          generate sessions.
        </p>
      </div>
    );
  }

  const profileOrder = data.profile_stats.map((p) => p.user_profile);

  const profileScoreData = data.profile_stats.map((p) => ({
    name: PROFILE_LABEL[p.user_profile] ?? p.user_profile,
    profile: p.user_profile,
    avg: p.avg_total_score !== null ? Math.round(p.avg_total_score * 10) / 10 : 0,
    goal_rate:
      p.session_count > 0 ? Math.round((p.goals_achieved / p.session_count) * 100) : 0,
  }));

  // Individual session dots: map each session to its profile bar's x-index
  const sessionDots = sessions
    .filter((s) => s.total_score !== null && profileOrder.includes(s.user_profile))
    .map((s) => ({
      x: profileOrder.indexOf(s.user_profile),
      y: s.total_score as number,
    }));

  const pieData = data.quality_distribution.map((q) => ({
    name: q.trajectory_quality.charAt(0).toUpperCase() + q.trajectory_quality.slice(1),
    value: q.count,
    color: QUALITY_COLORS[q.trajectory_quality] ?? "#6b7280",
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-white">Analytics</h1>
        <span className="text-gray-500 text-sm">{totalSessions} total sessions</span>
      </div>

      {/* Top-level stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Total Sessions</p>
          <p className="text-white font-semibold text-2xl">{totalSessions}</p>
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Overall Avg Score</p>
          <p className="text-white font-semibold text-2xl">
            {data.score_distribution.length > 0
              ? (
                  data.score_distribution.reduce((a, b) => a + b, 0) /
                  data.score_distribution.length
                ).toFixed(1)
              : "—"}
            <span className="text-gray-600 text-sm font-normal">/50</span>
          </p>
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Overall Goal Achievement</p>
          <p className="text-white font-semibold text-2xl">
            {data.profile_stats.length > 0
              ? Math.round(
                  (data.profile_stats.reduce((s, p) => s + p.goals_achieved, 0) / totalSessions) *
                    100
                )
              : "—"}
            <span className="text-gray-600 text-sm font-normal">%</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        {/* Avg score by profile with individual session dots */}
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Avg Score by Profile</h3>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={profileScoreData} margin={{ top: 8, right: 16, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
              <XAxis
                xAxisId="cat"
                dataKey="name"
                tick={{ fill: "#9ca3af", fontSize: 10 }}
                axisLine={false}
                tickLine={false}
              />
              <XAxis
                xAxisId="num"
                type="number"
                dataKey="x"
                domain={[-0.5, profileScoreData.length - 0.5]}
                hide
              />
              <YAxis domain={[0, 50]} tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  borderRadius: "6px",
                  color: "#f3f4f6",
                  fontSize: "12px",
                }}
                cursor={{ fill: "rgba(255,255,255,0.03)" }}
              />
              <Bar xAxisId="cat" dataKey="avg" name="Avg Score" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Scatter
                xAxisId="num"
                data={sessionDots}
                dataKey="y"
                name="Session"
                fill="#a5b4fc"
                r={5}
                shape="circle"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* Quality distribution pie + low quality session list */}
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-gray-300 mb-3">Trajectory Quality</h3>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie
                data={pieData}
                cx="50%"
                cy="50%"
                innerRadius={45}
                outerRadius={70}
                paddingAngle={3}
                dataKey="value"
              >
                {pieData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <Legend
                iconType="circle"
                iconSize={8}
                wrapperStyle={{ fontSize: "11px", color: "#9ca3af" }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#111827",
                  border: "1px solid #374151",
                  borderRadius: "6px",
                  color: "#f3f4f6",
                  fontSize: "12px",
                }}
              />
            </PieChart>
          </ResponsiveContainer>

          {(() => {
            const lowSessions = sessions.filter((s) => s.trajectory_quality === "low");
            if (lowSessions.length === 0) return null;
            return (
              <div className="mt-3 pt-3 border-t border-gray-800">
                <p className="text-xs font-medium text-red-400 mb-2">Low Quality Sessions</p>
                <ul className="space-y-1.5">
                  {lowSessions.map((s) => (
                    <li key={s.session_id}>
                      <button
                        onClick={() => navigate(`/sessions/${s.session_id}`)}
                        className="w-full flex items-center gap-2 text-left hover:bg-gray-800 rounded px-1.5 py-1 transition-colors"
                      >
                        <span className="font-mono text-xs text-gray-500">
                          {s.session_id.slice(0, 8)}…
                        </span>
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium shrink-0 ${
                          s.user_profile === "adversarial_user"
                            ? "bg-red-900/60 text-red-300"
                            : s.user_profile === "impatient_expert"
                            ? "bg-yellow-900/60 text-yellow-300"
                            : "bg-emerald-900/60 text-emerald-300"
                        }`}>
                          {s.user_profile === "adversarial_user"
                            ? "Adversarial"
                            : s.user_profile === "impatient_expert"
                            ? "Impatient"
                            : "Novice"}
                        </span>
                        <span className="text-xs text-gray-400 ml-auto">
                          {s.total_score}/50
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()}
        </div>
      </div>

      {/* Goal achievement by profile */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Goal Achievement Rate by Profile</h3>
        <div className="space-y-3">
          {data.profile_stats.map((p) => {
            const rate = p.session_count > 0 ? (p.goals_achieved / p.session_count) * 100 : 0;
            return (
              <div key={p.user_profile}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-gray-400">
                    {PROFILE_LABEL[p.user_profile] ?? p.user_profile}
                  </span>
                  <span className="text-gray-400">
                    {p.goals_achieved}/{p.session_count} ({Math.round(rate)}%)
                  </span>
                </div>
                <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-indigo-500 rounded-full transition-all"
                    style={{ width: `${rate}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Score distribution histogram */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Score Distribution</h3>
        <ScoreHistogram scores={data.score_distribution} />
      </div>

      {/* Failure modes + standouts */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-red-400 mb-3">
            Top Failure Modes
          </h3>
          {data.top_failure_modes.length === 0 ? (
            <p className="text-gray-600 text-xs">No data yet</p>
          ) : (
            <ol className="space-y-2">
              {data.top_failure_modes.map((fm, i) => (
                <li key={i} className="flex gap-3 items-start">
                  <span className="text-gray-600 text-xs w-4 shrink-0">{i + 1}.</span>
                  <span className="text-xs text-gray-300 flex-1">{fm.mode}</span>
                  <span className="text-xs text-gray-600 shrink-0">×{fm.count}</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <h3 className="text-sm font-medium text-emerald-400 mb-3">
            Top Standout Moments
          </h3>
          {data.top_standout_moments.length === 0 ? (
            <p className="text-gray-600 text-xs">No data yet</p>
          ) : (
            <ol className="space-y-2">
              {data.top_standout_moments.map((sm, i) => (
                <li key={i} className="flex gap-3 items-start">
                  <span className="text-gray-600 text-xs w-4 shrink-0">{i + 1}.</span>
                  <span className="text-xs text-gray-300 flex-1">{sm.moment}</span>
                  <span className="text-xs text-gray-600 shrink-0">×{sm.count}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
