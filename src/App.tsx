import { useEffect, useMemo, useState } from "react";
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  NavLink,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
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

/** Groups nav entry: a single-select dropdown so exactly one group ("active
 *  wallet") is shown at a time, with only that group's links below it. Keeps
 *  the sidebar quiet no matter how many groups exist. Follows the current
 *  route, and switching the picker navigates into the chosen group. */
function GroupsNavItem() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const location = useLocation();
  const navigate = useNavigate();

  const activeGroupId = useMemo(() => {
    const m = location.pathname.match(/^\/groups\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);
  const [selectedId, setSelectedId] = useState<string | null>(activeGroupId);
  useEffect(() => {
    if (activeGroupId) setSelectedId(activeGroupId);
  }, [activeGroupId]);

  const list = groups.data ?? [];
  if (!list.length) return null;

  // Always resolve to one real group so the panel shows a single active wallet.
  const current =
    list.find((g) => g.id === selectedId) ?? list[0];

  return (
    <div className="nav-group">
      <select
        className="nav-group-select group-pick"
        value={current.id}
        title={current.description || current.id}
        aria-label="Active group"
        onChange={(e) => {
          setSelectedId(e.target.value);
          navigate(`/groups/${e.target.value}`);
        }}
      >
        {list.map((g) => (
          <option key={g.id} value={g.id}>
            {g.description || `${g.id.slice(0, 10)}…`}
          </option>
        ))}
      </select>
      <NavLink to={`/groups/${current.id}`} end className="nav-subsubitem">
        Details
      </NavLink>
      {current.ciphersuite.includes("Pallas") && (
        <NavLink to={`/groups/${current.id}/wallet`} className="nav-subsubitem">
          Wallet
        </NavLink>
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
