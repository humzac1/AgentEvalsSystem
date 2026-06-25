import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Session {
  session_id: string;
  user_profile: string;
  hidden_goal: string;
  timestamp: string;
  total_score: number | null;
  trajectory_quality: string | null;
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

function formatTs(ts: string) {
  try {
    return new Date(ts + "Z").toLocaleString();
  } catch {
    return ts;
  }
}

type QualityFilter = "all" | "high" | "medium" | "low";

export default function SessionsList() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>("all");
  const navigate = useNavigate();

  useEffect(() => {
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
  }, []);

  if (loading) {
    return <p className="text-gray-500 mt-8 text-sm">Loading sessions…</p>;
  }
  if (error) {
    return <p className="text-red-400 mt-8 text-sm">Error: {error}</p>;
  }
  if (sessions.length === 0) {
    return (
      <div className="mt-12 text-center">
        <p className="text-gray-400 text-lg mb-2">No sessions yet</p>
        <p className="text-gray-600 text-sm">
          Run <code className="bg-gray-800 px-1.5 py-0.5 rounded text-gray-300">python run_batch.py</code> in the
          backend directory to generate simulations.
        </p>
      </div>
    );
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
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-white">Simulation Sessions</h1>
        <span className="text-gray-500 text-sm">{sessions.length} sessions</span>
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
                  <ProfileBadge profile={s.user_profile} />
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
    </div>
  );
}
