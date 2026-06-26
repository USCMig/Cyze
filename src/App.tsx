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
import { useQuery } from "@tanstack/react-query";
import { useKeystore } from "./stores/keystore";
import { useCeremonies, selectDkgInProgress } from "./stores/ceremonies";
import { lockKeystore, listGroups } from "./ipc/commands";
import CeremonyListener from "./CeremonyListener";
import { Logo } from "./components/Logo";
import Unlock from "./screens/Unlock";
import Dashboard from "./screens/Dashboard";
import Contacts from "./screens/Contacts";
import Groups, { GroupDetail, GroupWalletPage } from "./screens/Groups";
import ServerSettings from "./screens/ServerSettings";
import DkgWizard from "./screens/DkgWizard";
import NewSigningSession from "./screens/NewSigningSession";
import Inbox from "./screens/Inbox";
import Wallet from "./screens/Wallet";

/** Expandable Groups nav entry: accordion — at most one group's sub-links
 *  visible at a time to keep the sidebar uncluttered. Auto-opens the group
 *  whose page is currently active. */
function GroupsNavItem() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const [open, setOpen] = useState(true);
  const location = useLocation();

  // Track which group id (if any) is expanded. Auto-update when the route
  // changes so navigating via the main content stays in sync with the sidebar.
  const activeGroupId = useMemo(() => {
    const m = location.pathname.match(/^\/groups\/([^/]+)/);
    return m ? m[1] : null;
  }, [location.pathname]);
  const [expandedId, setExpandedId] = useState<string | null>(activeGroupId);
  useEffect(() => {
    if (activeGroupId) setExpandedId(activeGroupId);
  }, [activeGroupId]);

  const hasGroups = !!groups.data?.length;
  return (
    <div className="nav-expandable">
      <div className="nav-row">
        <NavLink to="/groups" end>
          Groups
        </NavLink>
        {hasGroups && (
          <button
            className="nav-caret"
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Collapse groups" : "Expand groups"}
          >
            {open ? "▾" : "▸"}
          </button>
        )}
      </div>
      {open &&
        groups.data?.map((g) => (
          <GroupNavEntry
            key={g.id}
            g={g}
            isOpen={expandedId === g.id}
            onToggle={() =>
              setExpandedId((prev) => (prev === g.id ? null : g.id))
            }
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
    ],
  },
  {
    title: "2 · Keys",
    links: [
      { to: "/dkg", label: "New DKG" },
      { to: "/groups", label: "Groups" },
    ],
  },
  {
    title: "3 · Signing",
    links: [
      { to: "/sign", label: "Sign" },
      { to: "/inbox", label: "Inbox" },
    ],
  },
  {
    title: "4 · Zcash",
    links: [{ to: "/wallet", label: "Wallet" }],
  },
];

function Layout() {
  const { unlocked, loaded, setUnlocked } = useKeystore();
  const dkgInProgress = useCeremonies(selectDkgInProgress);
  if (loaded && !unlocked) return <Navigate to="/unlock" replace />;
  return (
    <div className="layout">
      <CeremonyListener />
      <nav className="sidebar">
        <div className="sidebar-brand">
          <Logo markSize={24} showTagline />
        </div>
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
