import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  exportSidecarCert,
  getSettings,
  setServerUrl,
  sidecarStatus,
  startSidecar,
  stopSidecar,
  testServerConnection,
  trustServerCert,
  AppError,
} from "../ipc/commands";
import { useTauriEvent } from "../ipc/events";

export default function ServerSettings() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const sidecar = useQuery({ queryKey: ["sidecar"], queryFn: sidecarStatus });

  const [url, setUrl] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);
  const [certPem, setCertPem] = useState("");
  const [trustMsg, setTrustMsg] = useState<string | null>(null);
  const [exportedCert, setExportedCert] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useTauriEvent<string>("sidecar:log", (line) =>
    setLogs((prev) => [...prev.slice(-200), line])
  );
  useTauriEvent<number | null>("sidecar:exited", () =>
    queryClient.invalidateQueries({ queryKey: ["sidecar"] })
  );

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sidecar"] }),
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
