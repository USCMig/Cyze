import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getWalletConfig,
  lightwalletdInfo,
  setWalletConfig,
  AppError,
  LightwalletdInfo,
} from "../ipc/commands";

export default function Wallet() {
  const queryClient = useQueryClient();
  const config = useQuery({ queryKey: ["wallet-config"], queryFn: getWalletConfig });

  const [network, setNetwork] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [info, setInfo] = useState<LightwalletdInfo | null>(null);
  const [testErr, setTestErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const net = network ?? config.data?.network ?? "test";
  const effectiveUrl = url ?? config.data?.lightwalletd_url ?? "";

  const save = useMutation({
    mutationFn: () => setWalletConfig(net, url ?? effectiveUrl),
    onSuccess: (cfg) => {
      setNetwork(null);
      setUrl(null);
      setInfo(null);
      queryClient.setQueryData(["wallet-config"], cfg);
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

  return (
    <div>
      <h2>Wallet</h2>
      <p className="dim">
        Cyze syncs Zcash shielded funds as a light client: it scans compact
        blocks locally with your group's viewing key and talks to a configurable{" "}
        <span className="code-inline">lightwalletd</span> server (no full node
        required). Start on <strong>testnet</strong> to try it with faucet funds;
        switch to mainnet once you're ready.
      </p>

      <div className="card">
        <h3>Network</h3>
        <div className="row" style={{ marginBottom: 14 }}>
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
            className={net === "main" ? "" : "secondary"}
            onClick={() => {
              setNetwork("main");
              setUrl("");
            }}
          >
            Mainnet
          </button>
          <span className="dim">
            {net === "main"
              ? "Real funds — use only when ready."
              : "Safe for testing with faucet funds."}
          </span>
        </div>

        <label>
          lightwalletd endpoint (leave blank to use the {net === "main" ? "mainnet" : "testnet"} default)
        </label>
        <input
          type="text"
          placeholder={
            net === "main"
              ? "https://zec.rocks:443"
              : "https://lightwalletd.testnet.electriccoin.co:9067"
          }
          value={effectiveUrl}
          onChange={(e) => setUrl(e.target.value)}
        />

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
                {info.vendor} · lightwalletd {info.version}
              </span>
            </span>
          </div>
        )}
        {testErr && <div className="error" style={{ marginTop: 10 }}>{testErr}</div>}
      </div>

      <div className="card">
        <h3>Coming next</h3>
        <p className="dim">
          Per-group balances, receiving to your group's unified address, and
          FROST-signed sending build on this connection. For now, this verifies
          your light-client endpoint and shows the live chain height.
        </p>
      </div>
    </div>
  );
}
