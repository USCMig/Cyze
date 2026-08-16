import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getWalletConfig,
  lightwalletdInfo,
  setWalletConfig,
  getSettings,
  setExperimentalPipelinedSync,
  getLogs,
  clearLogs,
  AppError,
  LightwalletdInfo,
} from "../ipc/commands";

/** Known public lightwalletd endpoints per network (user can also type their own). */
const PRESETS: Record<string, { label: string; url: string }[]> = {
  test: [
    { label: "zec.rocks — testnet", url: "https://testnet.zec.rocks:443" },
    { label: "tz.ombie.cash", url: "https://tz.ombie.cash:443" },
    { label: "tl.ombie.cash", url: "https://tl.ombie.cash:443" },
  ],
  main: [{ label: "zec.rocks", url: "https://zec.rocks:443" }],
};

export default function Wallet() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["wallet-config"], queryFn: getWalletConfig });

  const [network, setNetwork] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [info, setInfo] = useState<LightwalletdInfo | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Mainnet is the default (matches the backend), so the app opens on the network
  // it is actually used on rather than quietly pointing at testnet.
  const net = network ?? config.data?.network ?? "main";
  const effectiveUrl = url ?? config.data?.lightwalletd_url ?? "";

  const save = useMutation({
    mutationFn: () => setWalletConfig(net, url ?? effectiveUrl),
    onSuccess: (cfg) => {
      setNetwork(null);
      setUrl(null);
      setInfo(null);
      queryClient.setQueryData(["wallet-config"], cfg);
      // Each network has its own wallet db, so balances/notes/history/addresses
      // must be re-read after switching — otherwise the previous network's
      // numbers linger. Invalidate by prefix so every group's queries refetch.
      for (const key of [
        "wallet-status",
        "wallet-history",
        "wallet-notes",
        "sync-progress",
        "receive-address",
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });

  const test = async () => {
    setTesting(true);
    setTestErr(null);
    setInfo(null);
    try {
      setInfo(await lightwalletdInfo(effectiveUrl || null));
    } catch (e) {
      setTestErr((e as AppError).message ?? String(e));
    } finally {
      setTesting(false);
    }
  };

  const isMainnet = net === "main";

  return (
    <div>
      <h2>Wallet</h2>

      <p className="dim">
        Cyze syncs Zcash as a light client against a configurable{" "}
        <span className="code-inline">lightwalletd</span> server — no full node
        needed. Start on testnet with faucet funds; switch to mainnet when ready.
      </p>

      <div className="card">
        <h3>Network</h3>
        <div className="row" style={{ marginBottom: 14, alignItems: "center" }}>
          <button
            className={net === "test" ? "" : "secondary"}
            onClick={() => {
              setNetwork("test");
              setUrl("");
            }}
          >
            Testnet
          </button>
          <button
            className={isMainnet ? "" : "secondary"}
            onClick={() => {
              if (net !== "main") {
                setNetwork("main");
                setUrl("");
              }
            }}
          >
            Mainnet
          </button>
          <span className="dim">
            {isMainnet ? "Live network — real ZEC." : "Test network — faucet funds."}
          </span>
        </div>

        <label>lightwalletd endpoint</label>
        <select
          value={
            PRESETS[net]?.some((p) => p.url === effectiveUrl) ? effectiveUrl : "custom"
          }
          onChange={(e) => {
            if (e.target.value !== "custom") setUrl(e.target.value);
          }}
        >
          {PRESETS[net]?.map((p) => (
            <option key={p.url} value={p.url}>
              {p.label} — {p.url}
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        <input
          type="text"
          placeholder={net === "main" ? "https://zec.rocks:443" : "https://testnet.zec.rocks:443"}
          value={effectiveUrl}
          onChange={(e) => setUrl(e.target.value)}
        />
        <p className="dim" style={{ marginTop: -6 }}>
          Pick a server above or type your own (a bare <span className="code-inline">host:443</span>{" "}
          works too).
        </p>

        <div className="row" style={{ marginTop: 4 }}>
          <button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          <button className="secondary" onClick={test} disabled={testing}>
            {testing ? "Connecting…" : "Test connection"}
          </button>
        </div>

        {info && (
          <div className="callout" style={{ marginTop: 14 }}>
            <span>
              Connected to <strong>{info.chain_name}</strong> · block height{" "}
              <strong>{info.block_height.toLocaleString()}</strong>
              {info.estimated_height > info.block_height && (
                <> (chain tip ~{info.estimated_height.toLocaleString()})</>
              )}
              <br />
              <span className="dim">
                {info.vendor} · lightwalletd {info.version} · branch{" "}
                {info.consensus_branch_id || "?"}
              </span>
            </span>
          </div>
        )}
        {info && info.branch_supported === false && (
          <div className="callout warn" style={{ marginTop: 10 }}>
            <span>
              <strong>⚠ Network upgrade mismatch — sends will be rejected.</strong>{" "}
              This node expects consensus branch{" "}
              <span className="mono">{info.consensus_branch_id}</span>, but this
              wallet build produces{" "}
              <span className="mono">{info.wallet_branch_id}</span>. The network
              has activated an upgrade (e.g. Ironwood/NU7) whose branch id isn't
              in this build's Zcash libraries yet. Transactions will FROST-sign
              fine but fail at broadcast with "incorrect consensus branch id"
              until the wallet is updated to Ironwood-aware Zcash crates.
              Receiving and syncing are unaffected.
            </span>
          </div>
        )}
        {testErr && <div className="error" style={{ marginTop: 10 }}>{testErr}</div>}
      </div>

      <SyncCard />

      <LogsCard />
    </div>
  );
}

/** Sync settings: opt into the experimental pipelined sync driver. Persisted and
 *  read at the start of each sync, so the toggle takes effect on the next sync. */
function SyncCard() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const enabled = settings.data?.experimental_pipelined_sync ?? false;

  const toggle = useMutation({
    mutationFn: (next: boolean) => setExperimentalPipelinedSync(next),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <h3 style={{ marginTop: 0 }}>Sync</h3>
      <label
        className="row"
        style={{ gap: 10, alignItems: "flex-start", cursor: "pointer" }}
      >
        <input
          type="checkbox"
          checked={enabled}
          disabled={settings.isLoading || toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
          style={{ marginTop: 3 }}
        />
        <span>
          <strong>Experimental pipelined sync</strong>
          <span className="dim" style={{ display: "block", fontSize: 13, marginTop: 4 }}>
            Downloads the next batch of blocks while the current one is still being
            scanned, which can speed up a long initial sync — most on high-latency
            connections. Off by default while it's being validated against the
            standard sync. Takes effect on your <strong>next sync</strong>; if a
            sync misbehaves, turn this off and sync again.
          </span>
        </span>
      </label>
      {toggle.isError && (
        <div className="error" style={{ marginTop: 8 }}>
          {(toggle.error as unknown as AppError).message}
        </div>
      )}
    </div>
  );
}

/** In-app diagnostics log: shows what the app has logged this session (sync
 *  timing, errors, ceremony steps) so it can be copied and shared without a
 *  terminal. In-memory only — cleared when the app restarts. */
function LogsCard() {
  const [live, setLive] = useState(true);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const atBottomRef = useRef(true);

  const logs = useQuery({
    queryKey: ["app-logs"],
    queryFn: getLogs,
    refetchInterval: live ? 2000 : false,
  });
  const lines = logs.data ?? [];

  const clear = useMutation({
    mutationFn: clearLogs,
    onSuccess: () => logs.refetch(),
  });

  // Keep the view pinned to the newest line while live, unless the user has
  // scrolled up to read older output.
  useEffect(() => {
    const el = preRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  const onScroll = () => {
    const el = preRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const copyAll = async () => {
    await navigator.clipboard.writeText(lines.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>Diagnostics log</h3>
        <span className="dim" style={{ fontSize: 12 }}>
          {lines.length} line{lines.length === 1 ? "" : "s"} · this session
        </span>
      </div>
      <p className="dim" style={{ fontSize: 12, marginTop: 6 }}>
        What the app has logged while running (sync timing, errors, ceremony
        steps). Kept in memory only and cleared on restart — copy it here to share
        for troubleshooting.
      </p>

      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
        <button className="secondary" onClick={() => copyAll()} disabled={lines.length === 0}>
          {copied ? "Copied!" : "Copy all"}
        </button>
        <button className="secondary" onClick={() => logs.refetch()}>
          Refresh
        </button>
        <button className="secondary" onClick={() => clear.mutate()} disabled={lines.length === 0}>
          Clear
        </button>
        <label className="row" style={{ gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live
        </label>
      </div>

      <pre
        ref={preRef}
        onScroll={onScroll}
        className="mono"
        style={{
          margin: 0,
          maxHeight: 320,
          overflow: "auto",
          fontSize: 11.5,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          background: "var(--bg-elevated, rgba(0,0,0,0.04))",
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: 10,
        }}
      >
        {lines.length ? lines.join("\n") : "No log output yet."}
      </pre>
    </div>
  );
}
