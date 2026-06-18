import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  exportSidecarCert,
  getSettings,
  setServerUrl,
  sidecarStatus,
  startSidecar,
  startTunnel,
  stopSidecar,
  stopTunnel,
  testServerConnection,
  trustServerCert,
  tunnelStatus,
  AppError,
} from "../ipc/commands";
import { useTauriEvent } from "../ipc/events";

export default function ServerSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const sidecar = useQuery({ queryKey: ["sidecar"], queryFn: sidecarStatus });
  const tunnel = useQuery({ queryKey: ["tunnel"], queryFn: tunnelStatus });

  const [url, setUrl] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [certPem, setCertPem] = useState("");
  const [trustMsg, setTrustMsg] = useState<string | null>(null);
  const [exportedCert, setExportedCert] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tunnelCopied, setTunnelCopied] = useState<"app" | "cli" | null>(null);

  useTauriEvent<string>("sidecar:log", (line) =>
    setLogs((prev) => [...prev.slice(-200), line])
  );
  useTauriEvent<number | null>("sidecar:exited", () =>
    queryClient.invalidateQueries({ queryKey: ["sidecar"] })
  );
  useTauriEvent<string>("tunnel:ready", () =>
    queryClient.invalidateQueries({ queryKey: ["tunnel"] })
  );
  useTauriEvent<null>("tunnel:exited", () =>
    queryClient.invalidateQueries({ queryKey: ["tunnel"] })
  );

  const openTunnel = useMutation({
    mutationFn: startTunnel,
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["tunnel"] });
    },
    onError: (e) => setError((e as unknown as AppError).message),
  });
  const closeTunnel = useMutation({
    mutationFn: stopTunnel,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["tunnel"] }),
  });

  const effectiveUrl = url ?? settings.data?.server_url ?? "";

  const start = useMutation({
    mutationFn: () => startSidecar(null),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["sidecar"] });
    },
    onError: (e) => setError((e as unknown as AppError).message),
  });

  const stop = useMutation({
    mutationFn: stopSidecar,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidecar"] });
      queryClient.invalidateQueries({ queryKey: ["tunnel"] });
    },
  });

  return (
    <div>
      <h2>Server</h2>

      <div className="card">
        <h3>Embedded server (frostd)</h3>
        {sidecar.data?.running ? (
          <>
            <p>
              <span className="badge green">running</span>{" "}
              <span className="dim">{sidecar.data.url}</span>
            </p>
            {sidecar.data.cert_fingerprint && (
              <>
                <label>Certificate fingerprint (SHA-256)</label>
                <div className="mono">{sidecar.data.cert_fingerprint}</div>
              </>
            )}
            {sidecar.data.lan_addresses.length > 0 && (
              <p className="dim">
                LAN participants can connect to:{" "}
                {sidecar.data.lan_addresses
                  .map((ip) => `${ip}:${sidecar.data!.port}`)
                  .join(", ")}
              </p>
            )}
            <div className="row" style={{ marginTop: 10 }}>
              <button className="danger" onClick={() => stop.mutate()}>
                Stop server
              </button>
              <button
                className="secondary"
                onClick={async () => setExportedCert(await exportSidecarCert())}
              >
                Export certificate
              </button>
            </div>
            <p className="dim" style={{ marginTop: 8 }}>
              Note: frostd keeps sessions in memory — stopping the server drops
              any in-flight ceremonies.
            </p>
          </>
        ) : (
          <>
            <p className="dim">
              Run a frostd server inside the app for participants to connect to.
              A self-signed certificate is generated automatically; share it
              with participants so they can trust the connection.
            </p>
            <button onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending ? "Starting…" : "Start embedded server"}
            </button>
          </>
        )}
        {error && <div className="error">{error}</div>}
        {exportedCert && (
          <div style={{ marginTop: 10 }}>
            <label>Certificate PEM (send to participants)</label>
            <textarea rows={5} readOnly value={exportedCert} />
            <button
              className="secondary"
              onClick={() => navigator.clipboard.writeText(exportedCert)}
            >
              Copy
            </button>
          </div>
        )}
        {logs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <label>Server log</label>
            <div className="log">{logs.join("")}</div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Public access (Cloudflare tunnel)</h3>
        {!sidecar.data?.running ? (
          <p className="dim">
            Start the embedded server first. A tunnel then makes it reachable
            from the internet — no router port-forwarding required.
          </p>
        ) : tunnel.data?.running && tunnel.data.public_url ? (
          <>
            <p>
              <span className="badge green">tunnel up</span>
            </p>
            {(() => {
              const fullUrl = tunnel.data.public_url;
              // The frost-client CLI prepends https:// itself and parses the
              // host, so it needs the bare hostname (no scheme / trailing slash).
              const bareHost = fullUrl
                .replace(/^https?:\/\//, "")
                .replace(/\/+$/, "");
              const copy = async (which: "app" | "cli", value: string) => {
                await navigator.clipboard.writeText(value);
                setTunnelCopied(which);
                setTimeout(() => setTunnelCopied(null), 1500);
              };
              return (
                <>
                  <label>For this app (paste as the participant's server)</label>
                  <div className="mono">{fullUrl}</div>
                  <label style={{ marginTop: 10 }}>
                    For the frost-client CLI (<span className="code-inline">-s</span>{" "}
                    value — no <span className="code-inline">https://</span>)
                  </label>
                  <div className="mono">{bareHost}</div>
                  <p className="dim" style={{ marginTop: 6 }}>
                    Cloudflare presents a valid certificate, so participants
                    connect to this server and <strong>do not</strong> need to
                    trust your self-signed certificate. Anyone with the URL can
                    reach your server, so only share it with intended
                    participants.
                  </p>
                  <div className="row" style={{ marginTop: 10 }}>
                    <button onClick={() => copy("app", fullUrl)}>
                      {tunnelCopied === "app" ? "Copied!" : "Copy for app"}
                    </button>
                    <button
                      className="secondary"
                      onClick={() => copy("cli", bareHost)}
                    >
                      {tunnelCopied === "cli"
                        ? "Copied!"
                        : "Copy for frost-client CLI"}
                    </button>
                    <button
                      className="danger"
                      onClick={() => closeTunnel.mutate()}
                      disabled={closeTunnel.isPending}
                    >
                      Close tunnel
                    </button>
                  </div>
                </>
              );
            })()}
          </>
        ) : (
          <>
            <p className="dim">
              Open a public HTTPS endpoint in front of the embedded server so
              participants on other networks can connect — no firewall changes
              needed. Requires <span className="code-inline">cloudflared</span> to be
              installed and on your PATH.
            </p>
            <button
              onClick={() => openTunnel.mutate()}
              disabled={openTunnel.isPending}
            >
              {openTunnel.isPending ? "Opening tunnel…" : "Open public tunnel"}
            </button>
          </>
        )}
      </div>

      <div className="card">
        <h3>External server</h3>
        <label>Server (host:port)</label>
        <div className="row">
          <input
            type="text"
            placeholder="frost.example.com:2744"
            value={effectiveUrl}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            className="secondary"
            disabled={!effectiveUrl}
            onClick={async () => {
              setTestResult(null);
              try {
                const r = await testServerConnection(effectiveUrl);
                setTestOk(r.ok);
                setTestResult(r.ok ? "Connection OK" : (r.error ?? "failed"));
              } catch (e) {
                setTestOk(false);
                setTestResult((e as AppError).message);
              }
            }}
          >
            Test
          </button>
          <button
            disabled={!effectiveUrl}
            onClick={async () => {
              await setServerUrl(effectiveUrl);
              queryClient.invalidateQueries({ queryKey: ["settings"] });
            }}
          >
            Save
          </button>
        </div>
        {testResult && (
          <div className={testOk ? "ok" : "error"}>{testResult}</div>
        )}
      </div>

      <div className="card">
        <h3>Trust a server certificate</h3>
        <p className="dim">
          For servers using a self-signed certificate (like another user's
          embedded server), paste the PEM they shared. Verify the fingerprint
          with them over a separate channel before trusting it.
        </p>
        <textarea
          rows={5}
          placeholder="-----BEGIN CERTIFICATE-----"
          value={certPem}
          onChange={(e) => setCertPem(e.target.value)}
        />
        <button
          disabled={!certPem.trim() || !effectiveUrl}
          onClick={async () => {
            try {
              const fp = await trustServerCert(effectiveUrl, certPem.trim());
              setTrustMsg(`Trusted for ${effectiveUrl} — fingerprint ${fp}`);
              queryClient.invalidateQueries({ queryKey: ["settings"] });
            } catch (e) {
              setTrustMsg((e as AppError).message);
            }
          }}
        >
          Trust certificate for this server
        </button>
        {trustMsg && <div className="ok">{trustMsg}</div>}
      </div>
    </div>
  );
}
