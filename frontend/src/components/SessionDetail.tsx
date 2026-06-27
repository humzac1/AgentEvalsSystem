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

interface ToolCall {
  log_id: number;
  tool_name: string;
  inputs: Record<string, unknown>;
  output: string;
  success: boolean;
  called_at: string;
}

interface Evaluation {
  judge_json: {
    session_id: string;
    user_profile: string;
    hidden_goal_achieved: boolean;
    goal_achievement_explanation: string;
    scores: Record<string, number>;
    total_score: number;
    failure_modes: string[];
    standout_moments: string[];
    trajectory_quality: string;
    experiment_type?: string;
  };
  hidden_goal_achieved: number;
  goal_achievement_score: number;
  response_quality_score: number;
  handling_difficulty_score: number;
  staying_in_scope_score: number;
}

interface SessionData {
  session_id: string;
  user_profile: string;
  hidden_goal: string;
  timestamp: string;
  total_score: number | null;
  trajectory_quality: string | null;
  experiment_type: string | null;
  task_id: string | null;
  turns: Turn[];
  evaluation: Evaluation | null;
}

const PROFILE_LABEL: Record<string, string> = {
  confused_novice: "Confused Novice",
  impatient_expert: "Impatient Expert",
  adversarial_user: "Adversarial User",
};

const SCORE_LABELS: Record<string, string> = {
  // Conversation rubric
  goal_achievement: "Goal Achievement",
  response_quality: "Response Quality",
  handling_difficulty: "Handling Difficulty",
  staying_in_scope: "Staying In Scope",
  policy_accuracy: "Policy Accuracy",
  // Task rubric
  output_correctness: "Output Correctness",
  tool_call_accuracy: "Tool Accuracy",
  format_compliance: "Format Compliance",
  // Legacy labels
  resolution: "Goal Achievement",
  clarity: "Response Quality",
};

const QUALITY_COLORS: Record<string, string> = {
  high: "text-emerald-400",
  medium: "text-yellow-400",
  low: "text-red-400",
};

const EXPERIMENT_TYPE_LABEL: Record<string, string> = {
  conversation: "Conversation",
  single_output: "Single Output",
  multi_step: "Multi-Step",
};

// ── Tool Call Timeline ─────────────────────────────────────────────────────

function ToolCallRow({ tc, index }: { tc: ToolCall; index: number }) {
  const [expanded, setExpanded] = useState(false);

  const inputStr = (() => {
    try {
      return JSON.stringify(tc.inputs, null, 2);
    } catch {
      return String(tc.inputs);
    }
  })();

  return (
    <div className="flex gap-3">
      {/* Vertical line + dot */}
      <div className="flex flex-col items-center">
        <div
          className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
            tc.success
              ? "bg-emerald-900/60 text-emerald-300 border border-emerald-700"
              : "bg-red-900/60 text-red-300 border border-red-700"
          }`}
        >
          {index + 1}
        </div>
        <div className="w-px flex-1 bg-gray-800 mt-1" />
      </div>

      {/* Content */}
      <div className="flex-1 pb-4 min-w-0">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full text-left"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="text-white text-sm font-mono font-medium">{tc.tool_name}</span>
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${
                tc.success
                  ? "bg-emerald-900/40 text-emerald-400"
                  : "bg-red-900/40 text-red-400"
              }`}
            >
              {tc.success ? "ok" : "error"}
            </span>
            <span className="ml-auto text-gray-600 text-xs">{expanded ? "▲" : "▼"}</span>
          </div>

          {/* Collapsed preview */}
          {!expanded && (
            <p className="text-xs text-gray-500 truncate font-mono">
              {inputStr.replace(/\n/g, " ").slice(0, 120)}
            </p>
          )}
        </button>

        {/* Expanded detail */}
        {expanded && (
          <div className="mt-2 space-y-2">
            <div className="bg-gray-950 rounded border border-gray-800 p-3">
              <p className="text-gray-500 text-xs mb-1">Inputs</p>
              <pre className="text-xs text-gray-300 whitespace-pre-wrap break-all font-mono leading-relaxed">
                {inputStr}
              </pre>
            </div>
            <div className="bg-gray-950 rounded border border-gray-800 p-3">
              <p className="text-gray-500 text-xs mb-1">Result</p>
              <pre className="text-xs text-gray-300 whitespace-pre-wrap break-all font-mono leading-relaxed">
                {tc.output}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCallTimeline({ toolCalls }: { toolCalls: ToolCall[] }) {
  if (toolCalls.length === 0) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-6 text-center mb-8">
        <p className="text-gray-500 text-sm">No tool calls recorded for this session.</p>
      </div>
    );
  }

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white">Tool Call Timeline</h2>
        <span className="text-gray-500 text-xs">{toolCalls.length} calls</span>
      </div>
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        {toolCalls.map((tc, i) => (
          <ToolCallRow key={tc.log_id} tc={tc} index={i} />
        ))}
      </div>
    </div>
  );
}

// ── Agent Output display ───────────────────────────────────────────────────

function AgentOutput({ turns }: { turns: Turn[] }) {
  const agentTurns = turns.filter((t) => t.speaker === "agent");
  const taskTurn = turns.find((t) => t.speaker === "user");

  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold text-white mb-3">Task & Output</h2>
      <div className="space-y-3">
        {taskTurn && (
          <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
            <p className="text-xs text-gray-500 mb-2">Task Description</p>
            <p className="text-gray-200 text-sm whitespace-pre-wrap">{taskTurn.message}</p>
          </div>
        )}
        {agentTurns.map((turn, i) => (
          <div key={turn.turn_id} className="bg-indigo-900/20 rounded-lg border border-indigo-700/40 p-4">
            <p className="text-xs text-indigo-400 mb-2">
              Agent Output {agentTurns.length > 1 ? `(${i + 1})` : ""}
            </p>
            <p className="text-gray-200 text-sm whitespace-pre-wrap leading-relaxed">{turn.message}</p>
          </div>
        ))}
        {agentTurns.length === 0 && (
          <p className="text-gray-600 text-sm">No text output — agent completed via tool calls only.</p>
        )}
      </div>
    </div>
  );
}

// ── Conversation Transcript ────────────────────────────────────────────────

function ConversationTranscript({
  turns,
  userProfile,
}: {
  turns: Turn[];
  userProfile: string;
}) {
  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold text-white mb-3">Transcript</h2>
      <div className="space-y-3">
        {turns.map((turn) => {
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
                    ? PROFILE_LABEL[userProfile] ?? "User"
                    : "Agent"}
                  <span className="ml-2 font-normal text-gray-600">Turn {turn.turn_number}</span>
                </p>
                <p className="whitespace-pre-wrap leading-relaxed">{turn.message}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Scorecard ─────────────────────────────────────────────────────────────

function Scorecard({ eval_ }: { eval_: NonNullable<Evaluation["judge_json"]> }) {
  const scoreData = Object.entries(eval_.scores).map(([key, val]) => ({
    name: SCORE_LABELS[key] ?? key,
    score: val,
  }));

  return (
    <>
      <h2 className="text-lg font-semibold text-white mb-4">Judge Scorecard</h2>

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
  );
}

// ── Main Component ─────────────────────────────────────────────────────────

export default function SessionDetail({ agentId }: { agentId: string }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<SessionData | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    Promise.all([
      fetch(`/api/agents/${agentId}/sessions/${sessionId}`).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<SessionData>;
      }),
      fetch(`/api/agents/${agentId}/sessions/${sessionId}/tool-calls`)
        .then((r) => (r.ok ? r.json() : { tool_calls: [] }))
        .then((d) => (d.tool_calls ?? []) as ToolCall[]),
    ])
      .then(([sessionData, calls]) => {
        setData(sessionData);
        setToolCalls(calls);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [agentId, sessionId]);

  if (loading) return <p className="text-gray-500 mt-8 text-sm">Loading…</p>;
  if (error) return <p className="text-red-400 mt-8 text-sm">Error: {error}</p>;
  if (!data) return null;

  const eval_ = data.evaluation?.judge_json;
  const expType = data.experiment_type ?? "conversation";
  const isConversation = expType === "conversation";

  const qualityColor = data.trajectory_quality
    ? QUALITY_COLORS[data.trajectory_quality] ?? "text-gray-400"
    : "text-gray-600";

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate(`/agents/${agentId}/sessions`)}
          className="text-gray-500 hover:text-white text-sm transition-colors"
        >
          ← Sessions
        </button>
        <span className="text-gray-700">/</span>
        <span className="font-mono text-xs text-gray-400">{data.session_id.slice(0, 16)}…</span>
        <span
          className={`ml-2 px-2 py-0.5 rounded text-xs font-medium ${
            expType === "conversation"
              ? "bg-blue-900/60 text-blue-300 border border-blue-700"
              : expType === "single_output"
              ? "bg-orange-900/60 text-orange-300 border border-orange-700"
              : "bg-purple-900/60 text-purple-300 border border-purple-700"
          }`}
        >
          {EXPERIMENT_TYPE_LABEL[expType] ?? expType}
        </span>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">
            {isConversation ? "Profile" : "Experiment"}
          </p>
          <p className="text-white font-medium">
            {isConversation
              ? PROFILE_LABEL[data.user_profile] ?? data.user_profile
              : EXPERIMENT_TYPE_LABEL[expType] ?? expType}
          </p>
          {!isConversation && toolCalls.length > 0 && (
            <p className="text-gray-500 text-xs mt-1">{toolCalls.length} tool calls</p>
          )}
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Total Score</p>
          <p className="text-white font-medium text-xl">
            {data.total_score !== null ? `${data.total_score}/50` : "—"}
          </p>
        </div>
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <p className="text-xs text-gray-500 mb-1">Trajectory Quality</p>
          <p className={`font-semibold capitalize ${qualityColor}`}>
            {data.trajectory_quality ?? "—"}
          </p>
        </div>
      </div>

      {/* Goal / task description */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 mb-6">
        <p className="text-xs text-gray-500 mb-1">
          {isConversation ? "Hidden Goal" : "Task Description"}
        </p>
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

      {/* Main content branching by experiment type */}
      {isConversation ? (
        <ConversationTranscript turns={data.turns} userProfile={data.user_profile} />
      ) : (
        <>
          <ToolCallTimeline toolCalls={toolCalls} />
          <AgentOutput turns={data.turns} />
        </>
      )}

      {/* Scorecard (shown for all experiment types) */}
      {eval_ && <Scorecard eval_={eval_} />}
    </div>
  );
}
