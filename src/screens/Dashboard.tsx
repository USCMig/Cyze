import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listGroups, sidecarStatus, getSettings } from "../ipc/commands";

export default function Dashboard() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const sidecar = useQuery({ queryKey: ["sidecar"], queryFn: sidecarStatus });
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });

  return (
    <div>
      <h2>Dashboard</h2>
      <div className="card">
        <h3>Groups</h3>
        {groups.data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Description</th>
                <th>Threshold</th>
                <th>Ciphersuite</th>
              </tr>
            </thead>
            <tbody>
              {groups.data.map((g) => (
                <tr key={g.id}>
                  <td>{g.description || "(unnamed)"}</td>
                  <td>
                    {g.threshold}-of-{g.num_participants}
                  </td>
                  <td>
                    <span className="badge blue">{g.ciphersuite}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dim">
            No groups yet. Create one with <Link to="/groups">a DKG ceremony</Link>.
          </p>
        )}
      </div>
      <div className="card">
        <h3>Server</h3>
        {sidecar.data?.running ? (
          <p>
            <span className="badge green">embedded frostd running</span>{" "}
            <span className="dim">{sidecar.data.url}</span>
          </p>
        ) : settings.data?.server_url ? (
          <p className="dim">External server: {settings.data.server_url}</p>
        ) : (
          <p className="dim">
            No server configured. Set one up in <Link to="/server">Server</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
