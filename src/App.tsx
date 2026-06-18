import { useEffect, useState } from "react";
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  NavLink,
  Navigate,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useKeystore } from "./stores/keystore";
import { useCeremonies, selectDkgInProgress } from "./stores/ceremonies";
import { lockKeystore, listGroups } from "./ipc/commands";
import CeremonyListener from "./CeremonyListener";
import Unlock from "./screens/Unlock";
import Dashboard from "./screens/Dashboard";
import Contacts from "./screens/Contacts";
import Groups, { GroupDetail } from "./screens/Groups";
import ServerSettings from "./screens/ServerSettings";
import DkgWizard from "./screens/DkgWizard";
import NewSigningSession from "./screens/NewSigningSession";
import Inbox from "./screens/Inbox";

/** Expandable Groups nav entry: a dropdown listing every group the keystore
 *  can access, each linking to its own detail page. */
function GroupsNavItem() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const [open, setOpen] = useState(true);
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
          <NavLink key={g.id} to={`/groups/${g.id}`} className="nav-subitem">
            {g.description || `${g.id.slice(0, 10)}…`}
          </NavLink>
        ))}
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
];

function Layout() {
  const { unlocked, loaded, setUnlocked } = useKeystore();
  const dkgInProgress = useCeremonies(selectDkgInProgress);
  if (loaded && !unlocked) return <Navigate to="/unlock" replace />;
  return (
    <div className="layout">
      <CeremonyListener />
      <nav className="sidebar">
        <h1>FROST Companion</h1>
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
      { path: "dkg", element: <DkgWizard /> },
      { path: "sign", element: <NewSigningSession /> },
      { path: "inbox", element: <Inbox /> },
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
