import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  cancelCeremony,
  getSettings,
  listContacts,
  sidecarStatus,
  startDkg,
  AppError,
  Ciphersuite,
} from "../ipc/commands";
import { useCeremonies } from "../stores/ceremonies";

const DKG_PHASES: Record<string, string> = {
  connecting: "Connecting to server",
  session_ready: "Session established",
  round1: "Round 1: exchanging commitments",
  round1_broadcast: "Round 1: verifying echo broadcast",
  round2: "Round 2: exchanging key shares",
  finalizing: "Computing final key share",
  complete: "Group created",
  failed: "Failed",
};

export default function DkgWizard() {
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: listContacts });
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const sidecar = useQuery({ queryKey: ["sidecar"], queryFn: sidecarStatus });

  const [role, setRole] = useState<"create" | "join">("create");
  const [suite, setSuite] = useState<Ciphersuite>("redpallas");
  const [description, setDescription] = useState("");
  const [threshold, setThreshold] = useState(2);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The active ceremony id lives in the global store, not local state, so it
  // survives navigating away and back (and even a reload) while the backend
  // ceremony keeps running. Listeners are mounted globally in CeremonyListener.
  const { ceremonies, activeDkgId, setActiveDkg } = useCeremonies();
  const ceremonyId = activeDkgId;
  const ceremony = ceremonyId ? ceremonies[ceremonyId] : undefined;

  const effectiveServer = useMemo(() => {
    if (serverUrl !== null) return serverUrl;
    if (sidecar.data?.running && sidecar.data.port) return `127.0.0.1:${sidecar.data.port}`;
    return settings.data?.server_url ?? "";
  }, [serverUrl, sidecar.data, settings.data]);

  const totalParticipants = selected.size + 1; // others + self

  const begin = async () => {
    setError(null);
    try {
      const id = await startDkg({
        suite,
        description,
        threshold,
        participants: role === "create" ? [...selected] : [],
        server_url: effectiveServer || null,
        session_id: null,
      });
      setActiveDkg(id);
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  };

  if (ceremony) {
    const phases = ["connecting", "session_ready", "round1", "round1_broadcast", "round2", "finalizing"];
    const currentIdx = phases.indexOf(ceremony.phase);
    return (
      <div>
        <h2>DKG ceremony</h2>
        <div className="card">
          <div className="stepper">
            {phases.map((p, i) => (
              <div
                key={p}
                className={`step ${
                  ceremony.failed && i === currentIdx
                    ? "failed"
                    : ceremony.done || i < currentIdx
                      ? "done"
                      : i === currentIdx
                        ? "active"
                        : ""
                }`}
              >
                <div className="dot" />
                {DKG_PHASES[p]}
              </div>
            ))}
          </div>
          {ceremony.done && !ceremony.failed && (
            <>
              <p className="ok">Group created successfully.</p>
              <Link to="/groups">
                <button>View groups</button>
              </Link>
            </>
          )}
          {ceremony.failed && <p className="error">{ceremony.error}</p>}
          {!ceremony.done && (
            <>
              <p className="dim">
                This ceremony runs in the background — you can leave this screen
                and come back; it stays attached until it finishes.
              </p>
              <div className="row">
                <button
                  className="danger"
                  onClick={async () => {
                    if (ceremonyId) await cancelCeremony(ceremonyId);
                    setActiveDkg(null);
                  }}
                >
                  Cancel ceremony
                </button>
              </div>
            </>
          )}
          {ceremony.done && (
            <button
              className="secondary"
              style={{ marginLeft: 8 }}
              onClick={() => setActiveDkg(null)}
            >
              New ceremony
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>New DKG ceremony</h2>

      <div className="card">
        <label>Role</label>
        <div className="row" style={{ marginBottom: 12 }}>
          <button
            className={role === "create" ? "" : "secondary"}
            onClick={() => setRole("create")}
          >
            Create a group (initiator)
          </button>
          <button
            className={role === "join" ? "" : "secondary"}
            onClick={() => setRole("join")}
          >
            Join a ceremony
          </button>
        </div>

        {role === "create" ? (
          <>
            <label>Group description</label>
            <input
              type="text"
              placeholder="e.g. Treasury 2-of-3"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />

            <label>Ciphersuite</label>
            <select value={suite} onChange={(e) => setSuite(e.target.value as Ciphersuite)}>
              <option value="redpallas">RedPallas (Zcash Orchard)</option>
              <option value="ed25519">Ed25519 (generic)</option>
            </select>

            <label>Participants (besides you)</label>
            {contacts.data?.length ? (
              contacts.data.map((c) => (
                <div key={c.pubkey} className="row" style={{ marginBottom: 6 }}>
                  <input
                    type="checkbox"
                    style={{ width: "auto" }}
                    checked={selected.has(c.pubkey)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(c.pubkey);
                      else next.delete(c.pubkey);
                      setSelected(next);
                    }}
                  />
                  <span>{c.name}</span>
                </div>
              ))
            ) : (
              <p className="dim">
                No contacts — <Link to="/contacts">import contacts</Link> first.
              </p>
            )}

            <label style={{ marginTop: 12 }}>
              Threshold ({threshold} of {totalParticipants} must sign)
            </label>
            <input
              type="number"
              min={2}
              max={totalParticipants}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </>
        ) : (
          <>
            <p className="dim">
              You will join the ceremony that an initiator created on the
              server below. Make sure they included your contact as a
              participant, and enter the same threshold they chose — all
              participants must agree on it.
            </p>
            <label>Ciphersuite (must match the initiator)</label>
            <select value={suite} onChange={(e) => setSuite(e.target.value as Ciphersuite)}>
              <option value="redpallas">RedPallas (Zcash Orchard)</option>
              <option value="ed25519">Ed25519 (generic)</option>
            </select>
            <label>Threshold (as chosen by the initiator)</label>
            <input
              type="number"
              min={2}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
          </>
        )}

        <label>Server (host:port)</label>
        <input
          type="text"
          value={effectiveServer}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder="127.0.0.1:2744"
        />

        {error && <div className="error">{error}</div>}
        <button
          disabled={
            !effectiveServer ||
            threshold < 2 ||
            (role === "create" && (selected.size < 1 || threshold > totalParticipants))
          }
          onClick={begin}
        >
          {role === "create" ? "Start ceremony" : "Join ceremony"}
        </button>
      </div>
    </div>
  );
}
