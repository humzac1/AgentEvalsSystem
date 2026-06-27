import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Agent {
  agent_id: string;
  name: string;
  description: string;
  domain: string;
  created_at: string;
  last_active: string | null;
  session_count: number;
  avg_score: number | null;
  active_prompt_version: string | null;
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <span className="text-gray-600 text-sm">—</span>;
  const pct = (score / 50) * 100;
  const cls =
    pct >= 75
      ? "text-emerald-400"
      : pct >= 50
      ? "text-yellow-400"
      : "text-red-400";
  return (
    <span className={`text-sm font-medium ${cls}`}>
      {score.toFixed(1)}<span className="text-gray-600 font-normal">/50</span>
    </span>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg px-5 py-4">
      <p className="text-xs text-gray-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-semibold text-white">{value}</p>
    </div>
  );
}

export default function AgentLibrary() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => setAgents(d.agents ?? []))
      .finally(() => setLoading(false));
  }, []);

  const totalSessions = agents.reduce((s, a) => s + (a.session_count ?? 0), 0);
  const scoredAgents = agents.filter((a) => a.avg_score !== null);
  const fleetAvg =
    scoredAgents.length > 0
      ? scoredAgents.reduce((s, a) => s + a.avg_score!, 0) / scoredAgents.length
      : null;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-500 text-sm">
        Loading agents…
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Agent Library</h1>
          <p className="text-gray-400 text-sm mt-1">
            Manage your AI agents and their simulation history.
          </p>
        </div>
        <button
          onClick={() => navigate("/agents/new")}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-md transition-colors"
        >
          + New Agent
        </button>
      </div>

      {/* Fleet stats */}
      {agents.length > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <StatCard label="Total Agents" value={agents.length} />
          <StatCard label="Total Sessions" value={totalSessions.toLocaleString()} />
          <StatCard
            label="Fleet Avg Score"
            value={fleetAvg !== null ? `${fleetAvg.toFixed(1)} / 50` : "—"}
          />
        </div>
      )}

      {/* Agent table */}
      {agents.length === 0 ? (
        <div className="border border-dashed border-gray-700 rounded-xl p-12 text-center space-y-3">
          <p className="text-gray-400">No agents yet.</p>
          <button
            onClick={() => navigate("/agents/new")}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-md transition-colors"
          >
            Create your first agent
          </button>
        </div>
      ) : (
        <div className="border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 bg-gray-900/60">
                <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">
                  Agent
                </th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">
                  Domain
                </th>
                <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">
                  Sessions
                </th>
                <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">
                  Avg Score
                </th>
                <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">
                  Prompt
                </th>
                <th className="text-right px-4 py-3 text-xs text-gray-500 uppercase tracking-wide font-medium">
                  Last Active
                </th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent, i) => (
                <tr
                  key={agent.agent_id}
                  onClick={() => navigate(`/agents/${agent.agent_id}/sessions`)}
                  className={`cursor-pointer transition-colors hover:bg-gray-800/60 ${
                    i < agents.length - 1 ? "border-b border-gray-800" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <p className="text-white font-medium">{agent.name}</p>
                    {agent.description && (
                      <p className="text-gray-500 text-xs mt-0.5 truncate max-w-xs">
                        {agent.description}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {agent.domain ? (
                      <span className="px-2 py-0.5 rounded-full text-xs bg-gray-800 text-gray-300 border border-gray-700">
                        {agent.domain}
                      </span>
                    ) : (
                      <span className="text-gray-700">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-300">
                    {(agent.session_count ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <ScoreBadge score={agent.avg_score} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {agent.active_prompt_version ? (
                      <span className="text-gray-400 text-xs">
                        v{agent.active_prompt_version}
                      </span>
                    ) : (
                      <span className="text-gray-700 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500 text-xs">
                    {agent.last_active
                      ? new Date(agent.last_active).toLocaleDateString()
                      : "Never"}
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
