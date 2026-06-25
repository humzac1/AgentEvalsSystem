import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";

interface Turn {
  turn_id: number;
  session_id: string;
  turn_number: number;
  speaker: string;
  message: string;
  timestamp: string;
}

interface Evaluation {
  judge_json: {
    session_id: string;
    user_profile: string;
    hidden_goal_achieved: boolean;
    goal_achievement_explanation: string;
    scores: {
      resolution: number;
      clarity: number;
      handling_difficulty: number;
      policy_accuracy: number;
    };
    total_score: number;
    failure_modes: string[];
    standout_moments: string[];
    trajectory_quality: string;
  };
  hidden_goal_achieved: number;
  resolution_score: number;
  clarity_score: number;
  handling_difficulty_score: number;
  policy_accuracy_score: number;
}

interface SessionData {
  session_id: string;
  user_profile: string;
  hidden_goal: string;
  timestamp: string;
  total_score: number | null;
  trajectory_quality: string | null;
  turns: Turn[];
  evaluation: Evaluation | null;
}

const PROFILE_LABEL: Record<string, string> = {
  confused_novice: "Confused Novice",
  impatient_expert: "Impatient Expert",
  adversarial_user: "Adversarial User",
};

const SCORE_LABELS: Record<string, string> = {
  resolution: "Resolution",
  clarity: "Clarity",
  handling_difficulty: "Handling Difficulty",
  policy_accuracy: "Policy Accuracy",
};

const QUALITY_COLORS: Record<string, string> = {
  high: "text-emerald-400",
  medium: "text-yellow-400",
  low: "text-red-400",
};

export default function SessionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`/api/sessions/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [id]);

  if (loading) return <p className="text-gray-500 mt-8 text-sm">Loading…</p>;
  if (error) return <p className="text-red-400 mt-8 text-sm">Error: {error}</p>;
  if (!data) return null;

  const eval_ = data.evaluation?.judge_json;

  const scoreData = eval_
    ? Object.entries(eval_.scores).map(([key, val]) => ({
        name: SCORE_LABELS[key] ?? key,
        score: val,
      }))
    : [];

  const qualityColor = data.trajectory_quality
    ? QUALITY_COLORS[data.trajectory_quality] ?? "text-gray-400"
    : "text-gray-600";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate("/")}
          className="text-gray-500 hover:text-white text-sm transition-colors"
        >
          ← Sessions
        </button>
        <span className="text-gray-700">/</span>
        <span className="font-mono text-xs text-gray-400">{data.session_id.slice(0, 16)}…</span>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Profile</p>
          <p className="text-white font-medium">
            {PROFILE_LABEL[data.user_profile] ?? data.user_profile}
          </p>
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Total Score</p>
          <p className="text-white font-medium text-xl">
            {data.total_score !== null ? `${data.total_score}/40` : "—"}
          </p>
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Trajectory Quality</p>
          <p className={`font-semibold capitalize ${qualityColor}`}>
            {data.trajectory_quality ?? "—"}
          </p>
        </div>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-6">
        <p className="text-xs text-gray-500 mb-1">Hidden Goal</p>
        <p className="text-gray-200">{data.hidden_goal}</p>
        {eval_ && (
          <div className="mt-2 flex items-start gap-2">
            <span
              className={`text-xs font-medium mt-0.5 ${
                eval_.hidden_goal_achieved ? "text-emerald-400" : "text-red-400"
              }`}
            >
              {eval_.hidden_goal_achieved ? "✓ Achieved" : "✗ Not achieved"}
            </span>
            <span className="text-xs text-gray-500">
              — {eval_.goal_achievement_explanation}
            </span>
          </div>
        )}
      </div>

      {/* Transcript */}
      <h2 className="text-lg font-semibold text-white mb-3">Transcript</h2>
      <div className="space-y-3 mb-8">
        {data.turns.map((turn) => {
          const isUser = turn.speaker === "user";
          return (
            <div
              key={turn.turn_id}
              className={`flex ${isUser ? "justify-start" : "justify-end"}`}
            >
              <div
                className={`max-w-2xl rounded-lg px-4 py-3 text-sm ${
                  isUser
                    ? "bg-gray-800 text-gray-200 border border-gray-700"
                    : "bg-indigo-900/60 text-indigo-100 border border-indigo-700/50"
                }`}
              >
                <p className={`text-xs mb-1 font-medium ${isUser ? "text-gray-500" : "text-indigo-400"}`}>
                  {isUser
                    ? `${PROFILE_LABEL[data.user_profile] ?? "User"}`
                    : "HR Agent"}
                  <span className="ml-2 font-normal text-gray-600">Turn {turn.turn_number}</span>
                </p>
                <p className="whitespace-pre-wrap leading-relaxed">{turn.message}</p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Scorecard */}
      {eval_ && (
        <>
          <h2 className="text-lg font-semibold text-white mb-4">Judge Scorecard</h2>

          {/* Score bar chart */}
          <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-4">
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={scoreData} margin={{ top: 8, right: 16, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#9ca3af", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 10]}
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
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                />
                <Bar dataKey="score" radius={[4, 4, 0, 0]}>
                  {scoreData.map((entry, i) => (
                    <Cell
                      key={i}
                      fill={
                        entry.score >= 8
                          ? "#10b981"
                          : entry.score >= 5
                          ? "#f59e0b"
                          : "#ef4444"
                      }
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Failure modes + standout moments */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-red-400 mb-3">
                ✗ Failure Modes ({eval_.failure_modes.length})
              </h3>
              {eval_.failure_modes.length === 0 ? (
                <p className="text-gray-600 text-xs">None identified</p>
              ) : (
                <ul className="space-y-2">
                  {eval_.failure_modes.map((fm, i) => (
                    <li key={i} className="text-xs text-gray-300 flex gap-2">
                      <span className="text-red-500 mt-0.5 shrink-0">•</span>
                      <span>{fm}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
              <h3 className="text-sm font-medium text-emerald-400 mb-3">
                ✓ Standout Moments ({eval_.standout_moments.length})
              </h3>
              {eval_.standout_moments.length === 0 ? (
                <p className="text-gray-600 text-xs">None identified</p>
              ) : (
                <ul className="space-y-2">
                  {eval_.standout_moments.map((sm, i) => (
                    <li key={i} className="text-xs text-gray-300 flex gap-2">
                      <span className="text-emerald-500 mt-0.5 shrink-0">•</span>
                      <span>{sm}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
