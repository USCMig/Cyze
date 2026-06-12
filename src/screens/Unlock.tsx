import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useKeystore } from "../stores/keystore";
import {
  createKeystore,
  importUpstreamConfig,
  unlockKeystore,
  AppError,
} from "../ipc/commands";

type Mode = "unlock" | "create" | "import";

export default function Unlock() {
  const { exists, loaded, refresh, setUnlocked } = useKeystore();
  const [mode, setMode] = useState<Mode | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [importPath, setImportPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  if (!loaded) return null;
  const effectiveMode: Mode = mode ?? (exists ? "unlock" : "create");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (effectiveMode !== "unlock" && passphrase !== confirm) {
      setError("Passphrases do not match");
      return;
    }
    if (effectiveMode !== "unlock" && passphrase.length < 8) {
      setError("Use at least 8 characters");
      return;
    }
    setBusy(true);
    try {
      if (effectiveMode === "unlock") await unlockKeystore(passphrase);
      else if (effectiveMode === "create") await createKeystore(passphrase);
      else await importUpstreamConfig(importPath.trim() || null, passphrase);
      setUnlocked(true);
      await refresh();
      navigate("/");
    } catch (err) {
      const e = err as AppError;
      setError(e.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="unlock-wrap">
      <div className="card unlock-card">
        <h2>
          {effectiveMode === "unlock"
            ? "Unlock keystore"
            : effectiveMode === "create"
              ? "Create keystore"
              : "Import frost-client config"}
        </h2>
        {effectiveMode === "create" && (
          <p className="dim">
            A new communication keypair will be generated and stored in a
            passphrase-encrypted keystore.
          </p>
        )}
        {effectiveMode === "import" && (
          <p className="dim">
            Imports an existing plaintext frost-client credentials.toml
            (leave the path empty for the default location) into an encrypted
            keystore.
          </p>
        )}
        <form onSubmit={submit}>
          {effectiveMode === "import" && (
            <>
              <label>Path to credentials.toml (optional)</label>
              <input
                type="text"
                placeholder="~/.config/frost/credentials.toml"
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
              />
            </>
          )}
          <label>Passphrase</label>
          <input
            type="password"
            autoFocus
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          {effectiveMode !== "unlock" && (
            <>
              <label>Confirm passphrase</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </>
          )}
          {error && <div className="error">{error}</div>}
          <div className="row">
            <button type="submit" disabled={busy || !passphrase}>
              {busy
                ? "Working…"
                : effectiveMode === "unlock"
                  ? "Unlock"
                  : effectiveMode === "create"
                    ? "Create"
                    : "Import"}
            </button>
          </div>
        </form>
        <p className="dim" style={{ marginTop: 16 }}>
          {exists && effectiveMode !== "unlock" && (
            <a href="#" onClick={() => setMode("unlock")}>
              Unlock existing keystore
            </a>
          )}
          {!exists && effectiveMode !== "import" && (
            <a href="#" onClick={() => setMode("import")}>
              Import existing frost-client config instead
            </a>
          )}
          {!exists && effectiveMode === "import" && (
            <a href="#" onClick={() => setMode("create")}>
              Create a fresh keystore instead
            </a>
          )}
        </p>
      </div>
    </div>
  );
}
