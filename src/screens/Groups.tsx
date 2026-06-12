import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listGroups, removeGroup } from "../ipc/commands";

export default function Groups() {
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const remove = useMutation({
    mutationFn: removeGroup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["groups"] }),
  });

  return (
    <div>
      <h2>Groups</h2>
      <p className="dim">
        Threshold signing groups this keystore holds a share for. New groups
        are created through a DKG ceremony (coming in the next milestone).
      </p>
      {groups.data?.length ? (
        groups.data.map((g) => (
          <div className="card" key={g.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>{g.description || "(unnamed group)"}</h3>
              <span className="badge blue">{g.ciphersuite}</span>
            </div>
            <p>
              {g.threshold}-of-{g.num_participants} threshold
              {g.server_url && <span className="dim"> · server {g.server_url}</span>}
            </p>
            <label>Group verifying key</label>
            <div className="mono">{g.id}</div>
            <div style={{ marginTop: 10 }}>
              <label>Participants</label>
              {Object.entries(g.participants).map(([ident, pubkey]) => (
                <div key={ident} className="dim" style={{ fontFamily: "monospace", fontSize: 12 }}>
                  {ident.slice(0, 8)}… → {pubkey.slice(0, 16)}…
                </div>
              ))}
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                className="danger"
                onClick={() => {
                  if (confirm("Remove this group? Your key share will be deleted from the keystore.")) {
                    remove.mutate(g.id);
                  }
                }}
              >
                Remove group
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="card">
          <p className="dim">No groups in this keystore.</p>
        </div>
      )}
    </div>
  );
}
