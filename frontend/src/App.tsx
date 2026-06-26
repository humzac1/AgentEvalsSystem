import { Routes, Route, NavLink } from "react-router-dom";
import SessionsList from "./components/SessionsList";
import SessionDetail from "./components/SessionDetail";
import Analytics from "./components/Analytics";
import Experiments from "./components/Experiments";

function Nav() {
  const base = "px-4 py-2 text-sm font-medium rounded-md transition-colors";
  const active = "bg-indigo-600 text-white";
  const inactive = "text-gray-400 hover:text-white hover:bg-gray-800";

  return (
    <header className="border-b border-gray-800 bg-gray-950 sticky top-0 z-10">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
        <span className="text-white font-semibold tracking-tight mr-4">
          ⚗️ Agent Sim Lab
          <span className="text-gray-500 font-normal ml-2 text-xs">HR Edition</span>
        </span>
        <nav className="flex gap-2">
          <NavLink
            to="/"
            end
            className={({ isActive }) => `${base} ${isActive ? active : inactive}`}
          >
            Sessions
          </NavLink>
          <NavLink
            to="/analytics"
            className={({ isActive }) => `${base} ${isActive ? active : inactive}`}
          >
            Analytics
          </NavLink>
          <NavLink
            to="/experiments"
            className={({ isActive }) => `${base} ${isActive ? active : inactive}`}
          >
            Experiments
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <div className="min-h-screen bg-gray-950">
      <Nav />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<SessionsList />} />
          <Route path="/sessions" element={<SessionsList />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/experiments" element={<Experiments />} />
        </Routes>
      </main>
    </div>
  );
}
