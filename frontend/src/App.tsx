import { useState } from "react";
import { Routes, Route, NavLink, useParams, Link } from "react-router-dom";
import SessionsList from "./components/SessionsList";
import SessionDetail from "./components/SessionDetail";
import Analytics from "./components/Analytics";
import Experiments from "./components/Experiments";
import AgentLibrary from "./components/AgentLibrary";
import CreateAgent from "./components/CreateAgent";
import EditAgent from "./components/EditAgent";
import { EvaluateModal } from "./components/EvaluateModal";

// ── Top-level nav (Agent Library only) ───────────────────────────────────────

function TopNav() {
  return (
    <header className="border-b border-gray-800 bg-gray-950 sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
        <Link to="/" className="text-white font-semibold tracking-tight">
          ⚗️ Agent Sim Lab
        </Link>
      </div>
    </header>
  );
}

// ── Per-agent nav (shown inside an agent workspace) ───────────────────────────

function AgentNav() {
  const { agentId } = useParams<{ agentId: string }>();
  const [evaluateOpen, setEvaluateOpen] = useState(false);
  const base = "px-3 py-1.5 text-sm font-medium rounded-md transition-colors";
  const active = "bg-indigo-600 text-white";
  const inactive = "text-gray-400 hover:text-white hover:bg-gray-800";

  return (
    <>
      <header className="border-b border-gray-800 bg-gray-950 sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <Link to="/" className="text-white font-semibold tracking-tight shrink-0">
            ⚗️ Agent Sim Lab
          </Link>
          <span className="text-gray-700 select-none">/</span>
          <Link to={`/agents/${agentId}/sessions`} className="text-gray-300 text-sm truncate max-w-[180px]">
            Agent Workspace
          </Link>
          <nav className="flex gap-1.5 ml-auto items-center">
            <NavLink
              to={`/agents/${agentId}/sessions`}
              className={({ isActive }) => `${base} ${isActive ? active : inactive}`}
            >
              Sessions
            </NavLink>
            <NavLink
              to={`/agents/${agentId}/analytics`}
              className={({ isActive }) => `${base} ${isActive ? active : inactive}`}
            >
              Analytics
            </NavLink>
            <NavLink
              to={`/agents/${agentId}/experiments`}
              className={({ isActive }) => `${base} ${isActive ? active : inactive}`}
            >
              Experiments
            </NavLink>
            <button
              onClick={() => setEvaluateOpen(true)}
              className="ml-2 px-3 py-1.5 text-sm font-medium rounded-md border border-indigo-700 text-indigo-300 hover:bg-indigo-900/50 hover:text-indigo-200 transition-colors"
              title="Qualitative evaluation via Langfuse comments"
            >
              Evaluate
            </button>
            <Link
              to={`/agents/${agentId}/edit`}
              className="ml-1 p-1.5 rounded-md text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
              title="Edit agent"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z" clipRule="evenodd" />
              </svg>
            </Link>
          </nav>
        </div>
      </header>
      {evaluateOpen && agentId && (
        <EvaluateModal agentId={agentId} onClose={() => setEvaluateOpen(false)} />
      )}
    </>
  );
}

// ── Agent workspace layout (nav + content) ────────────────────────────────────

function AgentWorkspace() {
  const { agentId } = useParams<{ agentId: string }>();
  return (
    <div className="min-h-screen bg-gray-950">
      <AgentNav />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="sessions" element={<SessionsList agentId={agentId!} />} />
          <Route path="sessions/:sessionId" element={<SessionDetail agentId={agentId!} />} />
          <Route path="analytics" element={<Analytics agentId={agentId!} />} />
          <Route path="experiments" element={<Experiments agentId={agentId!} />} />
          <Route path="edit" element={<EditAgent />} />
        </Routes>
      </main>
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
  return (
    <Routes>
      {/* Agent Library & Create */}
      <Route
        path="/"
        element={
          <div className="min-h-screen bg-gray-950">
            <TopNav />
            <main className="max-w-6xl mx-auto px-4 py-6">
              <AgentLibrary />
            </main>
          </div>
        }
      />
      <Route
        path="/agents/new"
        element={
          <div className="min-h-screen bg-gray-950">
            <TopNav />
            <main className="max-w-6xl mx-auto px-4 py-6">
              <CreateAgent />
            </main>
          </div>
        }
      />

      {/* Agent workspace — nested routes handled inside AgentWorkspace */}
      <Route path="/agents/:agentId/*" element={<AgentWorkspace />} />
    </Routes>
  );
}
