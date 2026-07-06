import { useEffect, useMemo, useState } from "react";
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  NavLink,
  Navigate,
  useLocation,
} from "react-router-dom";
import type { GroupSummary } from "./ipc/commands";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { useKeystore } from "./stores/keystore";
import { useCeremonies, selectDkgInProgress } from "./stores/ceremonies";
import {
  lockKeystore,
  listGroups,
  recordActivity,
  getSettings,
  setSessionRole,
} from "./ipc/commands";
import CeremonyListener from "./CeremonyListener";
import { Logo } from "./components/Logo";
import Unlock from "./screens/Unlock";
import Dashboard from "./screens/Dashboard";
import Contacts from "./screens/Contacts";
import Groups, { GroupDetail, GroupWalletPage } from "./screens/Groups";
import ServerSettings from "./screens/ServerSettings";
import SessionSetup from "./screens/SessionSetup";
import DkgWizard from "./screens/DkgWizard";
import NewSigningSession from "./screens/NewSigningSession";
import Inbox from "./screens/Inbox";
import Wallet from "./screens/Wallet";

/** Expandable Groups nav entry: accordion — at most one group's sub-links
 *  visible at a time to keep the sidebar uncluttered. Auto-opens the group
 *  whose page is currently active. */
function GroupsNavItem() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const location = useLocation();

  const activeGroupId = useMemo(() => {
    const m = location.pathname.match(/^\/groups\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);
  const [expandedId, setExpandedId] = useState<string | null>(activeGroupId);
  useEffect(() => {
    if (activeGroupId) setExpandedId(activeGroupId);
  }, [activeGroupId]);

  if (!groups.data?.length) return null;
  return (
    <div>
      {groups.data.map((g) => (
        <GroupNavEntry
          key={g.id}
          g={g}
          isOpen={expandedId === g.id}
          onToggle={() => setExpandedId((prev) => (prev === g.id ? null : g.id))}
        />
      ))}
    </div>
  );
}

/** A single group in the sidebar. Controlled open state is lifted to the
 *  parent so only one group can be expanded at a time. */
function GroupNavEntry({
  g,
  isOpen,
  onToggle,
}: {
  g: GroupSummary;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="nav-group">
      <button
        className="nav-group-name"
        onClick={onToggle}
        title={g.description || g.id}
      >
        <span className="nav-group-caret">{isOpen ? "▾" : "▸"}</span>
        {g.description || `${g.id.slice(0, 10)}…`}
      </button>
      {isOpen && (
        <>
          <NavLink to={`/groups/${g.id}`} end className="nav-subsubitem">
            Details
          </NavLink>
          {g.ciphersuite.includes("Pallas") && (
            <NavLink to={`/groups/${g.id}/wallet`} className="nav-subsubitem">
              Wallet
            </NavLink>
          )}
        </>
      )}
    </div>
  );
}

/** Nav grouped in the order a first-time user moves through the tool:
 *  set up a server and contacts, create or join a group, then sign. */
const NAV_SECTIONS: { title: string; links: { to: string; label: string }[] }[] = [
  { title: "Overview", links: [{ to: "/", label: "Dashboard" }] },
  {
    title: "1 · Setup",
    links: [
      { to: "/server", label: "Server" },
      { to: "/contacts", label: "Contacts" },
      { to: "/dkg", label: "New DKG" },
    ],
  },
  {
    title: "2 · Groups",
    links: [
      { to: "/groups", label: "Groups" },
    ],
  },
  {
    title: "3 · Signing",
    links: [
      { to: "/inbox", label: "Inbox" },
    ],
  },
  {
    title: "4 · Zcash",
    links: [
      { to: "/setup", label: "Session Configuration" },
      { to: "/wallet", label: "Wallet Settings" },
    ],
  },
];

/** Sidebar profile switch: a two-state slider toggling the active session
 *  profile (Coordinator / Participant). Clicking anywhere flips it; the current
 *  side is highlighted and bold. Persists the choice. */
function ProfileSlider() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const role = settings.data?.session_role === "participant" ? "participant" : "coordinator";

  const toggle = useMutation({
    mutationFn: () => setSessionRole(role === "coordinator" ? "participant" : "coordinator"),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  const isCoord = role === "coordinator";
  return (
    <button
      className="profile-slider"
      onClick={() => toggle.mutate()}
      title="Switch session profile"
      aria-label={`Session profile: ${role}. Click to switch.`}
    >
      <span
        className="profile-slider-thumb"
        style={{ left: isCoord ? "3px" : "calc(50% + 0px)" }}
      />
      <span className={`profile-slider-opt ${isCoord ? "on" : ""}`}>Coordinator</span>
      <span className={`profile-slider-opt ${!isCoord ? "on" : ""}`}>Participant</span>
    </button>
  );
}

function Layout() {
  const { unlocked, loaded, setUnlocked } = useKeystore();
  const dkgInProgress = useCeremonies(selectDkgInProgress);
  const location = useLocation();
  const settings = useQuery({
    queryKey: ["settings"],
    queryFn: getSettings,
    enabled: loaded && unlocked,
  });

  // Auto-lock: reflect a backend-initiated idle lock in the UI, and report user
  // activity (throttled) so the idle timer only fires when truly inactive.
  useEffect(() => {
    const unlisten = listen("keystore:auto-locked", () => setUnlocked(false));
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      // Throttle to at most one IPC call every 30s.
      if (now - last < 30_000) return;
      last = now;
      void recordActivity();
    };
    const events: (keyof WindowEventMap)[] = [
      "mousedown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    return () => {
      void unlisten.then((f) => f());
      events.forEach((e) => window.removeEventListener(e, onActivity));
    };
  }, [setUnlocked]);

  if (loaded && !unlocked) return <Navigate to="/unlock" replace />;

  // First run: once unlocked, if the session has never been configured, send the
  // user to Session Configuration to set it up (and save it). Skip the redirect
  // while already there so they can complete and save.
  if (
    settings.data &&
    !settings.data.session_configured &&
    location.pathname !== "/setup"
  ) {
    return <Navigate to="/setup" replace />;
  }

  return (
    <div className="layout">
      <CeremonyListener />
      <nav className="sidebar">
        <div className="sidebar-brand">
          <Logo markSize={24} showTagline />
        </div>
        <ProfileSlider />
        {NAV_SECTIONS.map((section) => (
          <div className="nav-section" key={section.title}>
            <div className="nav-section-title">{section.title}</div>
            {section.links.map((link) =>
              link.to === "/groups" ? (
                <GroupsNavItem key={link.to} />
              ) : (
                <NavLink key={link.to} to={link.to} end={link.to === "/"}>
                  {link.label}
                  {link.to === "/dkg" && dkgInProgress && (
                    <span className="nav-pulse" title="A DKG ceremony is running" />
                  )}
                </NavLink>
              )
            )}
          </div>
        ))}
        <div className="spacer" />
        <a
          href="#"
          onClick={async (e) => {
            e.preventDefault();
            await lockKeystore();
            setUnlocked(false);
          }}
        >
          Lock
        </a>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

const router = createBrowserRouter([
  { path: "/unlock", element: <Unlock /> },
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "contacts", element: <Contacts /> },
      { path: "groups", element: <Groups /> },
      { path: "groups/:id", element: <GroupDetail /> },
      { path: "groups/:id/wallet", element: <GroupWalletPage /> },
      { path: "dkg", element: <DkgWizard /> },
      { path: "sign", element: <NewSigningSession /> },
      { path: "inbox", element: <Inbox /> },
      { path: "wallet", element: <Wallet /> },
      { path: "server", element: <ServerSettings /> },
      { path: "setup", element: <SessionSetup /> },
    ],
  },
]);

export default function App() {
  const refresh = useKeystore((s) => s.refresh);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return <RouterProvider router={router} />;
}
