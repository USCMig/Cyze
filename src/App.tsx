import { useEffect } from "react";
import {
  createBrowserRouter,
  RouterProvider,
  Outlet,
  NavLink,
  Navigate,
} from "react-router-dom";
import { useKeystore } from "./stores/keystore";
import { lockKeystore } from "./ipc/commands";
import Unlock from "./screens/Unlock";
import Dashboard from "./screens/Dashboard";
import Contacts from "./screens/Contacts";
import Groups from "./screens/Groups";
import ServerSettings from "./screens/ServerSettings";
import DkgWizard from "./screens/DkgWizard";
import NewSigningSession from "./screens/NewSigningSession";
import Inbox from "./screens/Inbox";

function Layout() {
  const { unlocked, loaded, setUnlocked } = useKeystore();
  if (loaded && !unlocked) return <Navigate to="/unlock" replace />;
  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>FROST Companion</h1>
        <NavLink to="/" end>Dashboard</NavLink>
        <NavLink to="/contacts">Contacts</NavLink>
        <NavLink to="/groups">Groups</NavLink>
        <NavLink to="/dkg">New DKG</NavLink>
        <NavLink to="/sign">Sign</NavLink>
        <NavLink to="/inbox">Inbox</NavLink>
        <NavLink to="/server">Server</NavLink>
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
