import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  joinSigningSession,
  listGroups,
  listPendingSessions,
  respondToSigning,
  AppError,
} from "../ipc/commands";
import { useTauriEvent } from "../ipc/events";
import { useCeremonies, CeremonyEventPayload } from "../stores/ceremonies";

function hexToUtf8(hex: string): string {
  try {
    const bytes = new Uint8Array(hex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "(not valid UTF-8)";
  }
}

export default function Inbox() {
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const sessions = useQuery({
    queryKey: ["pending-sessions"],
    queryFn: () => listPendingSessions(null),
    refetchInterval: 10_000,
    retry: false,
  });

  const [joined, setJoined] = useState<Record<string, string>>({}); // session -> ceremony
  const [error, setError] = useState<string | null>(null);

  const { ceremonies, onProgress, onComplete, onFailed } = useCeremonies();
  useTauriEvent<CeremonyEventPayload>("signing:progress", (p) => onProgress("signing", p));
  useTauriEvent<CeremonyEventPayload>("signing:complete", (p) => onComplete("signing", p));
  useTauriEvent<CeremonyEventPayload>("signing:failed", (p) => onFailed("signing", p));

  const join = async (sessionId: string, groupId: string) => {
    setError(null);
    try {
      const ceremonyId = await joinSigningSession({
        group_id: groupId,
        session_id: sessionId,
        server_url: null,
      });
      setJoined((j) => ({ ...j, [sessionId]: ceremonyId }));
    } catch (e) {
      setError((e as AppError).message ?? String(e));
    }
  };

  return (
    <div>
      <h2>Inbox</h2>
      <p className="dim">
        Signing sessions on your configured server where someone else is the
        coordinator. Joining sends your commitments; your signature share is
        only produced after you approve the exact message below.
      </p>
      {sessions.isError && (
        <div className="card">
          <p className="error">
            Could not reach the server — check your server settings.
          </p>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {sessions.data?.length ? (
        sessions.data.map((s) => {
          const ceremonyId = joined[s.session_id];
          const ceremony = ceremonyId ? ceremonies[ceremonyId] : undefined;
          const awaiting =
            ceremony?.phase === "awaiting_approval"
              ? (ceremony.detail?.message_hex as string | undefined)
              : undefined;
          return (
            <div className="card" key={s.session_id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <h3 style={{ margin: 0 }}>
                  Session from {s.coordinator ?? "(unknown contact)"}
                </h3>
                <span className="badge">{s.session_id.slice(0, 8)}…</span>
              </div>

              {!ceremony && (
                <>
                  {s.matching_groups.length ? (
                    s.matching_groups.map((gid) => {
                      const g = groups.data?.find((x) => x.id === gid);
                      return (
                        <div className="row" key={gid} style={{ marginTop: 10 }}>
                          <span className="dim">
                            {g?.description || gid.slice(0, 16)}
                          </span>
                          <button onClick={() => join(s.session_id, gid)}>
                            Join with this group
                          </button>
                        </div>
                      );
                    })
                  ) : (
                    <p className="dim">
                      Coordinator does not match any of your groups.
                    </p>
                  )}
                </>
              )}

              {ceremony && !awaiting && !ceremony.done && (
                <p>
                  <span className="badge blue">{ceremony.phase}</span>
                </p>
              )}

              {awaiting && ceremonyId && (
                <div style={{ marginTop: 10 }}>
                  <p className="error" style={{ fontWeight: 600 }}>
                    Review carefully — approving produces your signature share.
                  </p>
                  <label>Message (hex)</label>
                  <div className="mono">{awaiting}</div>
                  <label style={{ marginTop: 8 }}>Message (as UTF-8)</label>
                  <div className="mono">{hexToUtf8(awaiting)}</div>
                  <div className="row" style={{ marginTop: 12 }}>
                    <button onClick={() => respondToSigning(ceremonyId, true)}>
                      Approve and sign
                    </button>
                    <button
                      className="danger"
                      onClick={() => respondToSigning(ceremonyId, false)}
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {ceremony?.done && !ceremony.failed && (
                <p className="ok">Share sent — the coordinator completes the signature.</p>
              )}
              {ceremony?.failed && <p className="error">{ceremony.error}</p>}
            </div>
          );
        })
      ) : (
        <div className="card">
          <p className="dim">
            {sessions.isLoading ? "Checking server…" : "No pending sessions."}
          </p>
        </div>
      )}
    </div>
  );
}
