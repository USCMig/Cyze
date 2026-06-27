import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  cancelCeremony,
  getIdentity,
  getWalletConfig,
  groupOrchardKeys,
  listContacts,
  listGroups,
  removeGroup,
  renameGroup,
  walletGroupStatus,
  walletInitAccount,
  walletSync,
  walletPrepareSend,
  walletSend,
  walletHistory,
  AppError,
  DraftTransaction,
  TxRecord,
  WalletStatus,
  ContactDto,
  GroupSummary,
  Identity,
} from "../ipc/commands";
import { resolveParticipant } from "../lib/participants";
import {
  useCeremonies,
  selectActiveSend,
  type CeremonyState,
} from "../stores/ceremonies";

/** ZEC display from zatoshis (1 ZEC = 1e8 zatoshis). */
function zec(zats: number): string {
  return (zats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

/** Full-page overlay confirmation required before broadcasting a mainnet send.
 *  The user must explicitly check a box acknowledging irreversibility. */
function MainnetConfirmModal({
  draft,
  isPending,
  onConfirm,
  onCancel,
}: {
  draft: DraftTransaction;
  isPending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [ack, setAck] = useState(false);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.72)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        className="card"
        style={{
          maxWidth: 480,
          width: "90%",
          margin: 0,
          border: "2px solid var(--danger)",
        }}
      >
        <div
          style={{
            background: "rgba(239,68,68,0.12)",
            border: "1px solid var(--danger)",
            borderRadius: 6,
            padding: "10px 14px",
            marginBottom: 16,
          }}
        >
          <strong style={{ color: "var(--danger)", fontSize: 15 }}>
            ⚠ Mainnet — Real ZEC Transaction
          </strong>
        </div>

        <p style={{ marginTop: 0 }}>
          You are about to sign and broadcast a transaction on the Zcash
          mainnet. This will move real funds.
        </p>

        <table className="participants" style={{ marginBottom: 14 }}>
          <tbody>
            <tr>
              <td>Sending</td>
              <td>
                <strong>{zec(draft.amount_zatoshis)} ZEC</strong>
              </td>
            </tr>
            <tr>
              <td>Network fee</td>
              <td>{zec(draft.fee_zatoshis)} ZEC</td>
            </tr>
            <tr>
              <td>Total deducted</td>
              <td>
                <strong>{zec(draft.amount_zatoshis + draft.fee_zatoshis)} ZEC</strong>
              </td>
            </tr>
            <tr>
              <td>Recipient</td>
              <td className="dim mono-cell" style={{ wordBreak: "break-all", fontSize: 11 }}>
                {draft.recipient}
              </td>
            </tr>
          </tbody>
        </table>

        <div className="row" style={{ alignItems: "flex-start", marginBottom: 16 }}>
          <input
            id="mainnet-ack"
            type="checkbox"
            style={{ width: "auto", marginTop: 3, flexShrink: 0 }}
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          <label htmlFor="mainnet-ack" style={{ cursor: "pointer", margin: 0 }}>
            I confirm the recipient address is correct and understand this
            transaction is <strong>irreversible</strong> once broadcast.
          </label>
        </div>

        <div className="row">
          <button
            className="danger"
            disabled={!ack || isPending}
            onClick={onConfirm}
          >
            {isPending ? "Starting…" : "Sign and broadcast"}
          </button>
          <button className="secondary" onClick={onCancel} disabled={isPending}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

type SendMode = "shielded" | "unshield";

/** Network a transparent address belongs to (mainnet t1/t3 P2PKH/P2SH,
 *  testnet tm/t2), or null if not a transparent address. */
function transparentNet(a: string): "main" | "test" | null {
  if (a.startsWith("t1") || a.startsWith("t3")) return "main";
  if (a.startsWith("tm") || a.startsWith("t2")) return "test";
  return null;
}

/** Network a shielded address belongs to (UA u1/utest1, Sapling zs1/ztestsapling),
 *  or null if not a shielded address. */
function shieldedNet(a: string): "main" | "test" | null {
  if (a.startsWith("utest") || a.startsWith("ztestsapling")) return "test";
  if (a.startsWith("u1") || a.startsWith("zs1")) return "main";
  return null;
}

/** Mode-aware recipient validation. Returns a human-readable error if the
 *  address is the wrong network OR the wrong kind for the selected mode (so the
 *  user catches a transparent/shielded mix-up before building). The backend
 *  Address::decode stays authoritative on submit; this is fast guidance. */
function validateRecipient(
  address: string,
  isMainnet: boolean,
  mode: SendMode
): string | null {
  const a = address.trim();
  if (!a) return null;
  const t = transparentNet(a);
  const sh = shieldedNet(a);
  const wrongNet = (net: "main" | "test" | null) =>
    (isMainnet && net === "test") || (!isMainnet && net === "main");

  if (mode === "unshield") {
    if (sh) {
      return "This is a shielded address — switch to Send for shielded recipients. Unshield needs a transparent t-address.";
    }
    if (t && wrongNet(t)) {
      return isMainnet
        ? "This looks like a testnet transparent address. You are on Mainnet."
        : "This looks like a mainnet transparent address. You are on Testnet.";
    }
    return null;
  }
  // shielded mode
  if (t) {
    return "This is a transparent address — switch to Unshield to send to a transparent t-address.";
  }
  if (sh && wrongNet(sh)) {
    return isMainnet
      ? "This looks like a testnet address. You are on Mainnet — check the address carefully."
      : "This looks like a mainnet address. You are on Testnet.";
  }
  return null;
}

/** Pool-awareness panel: the group holds & spends only Orchard. Surfaces the
 *  transparent/Sapling balances (normally 0) with a clear note that the
 *  threshold group cannot spend them — so users don't expect to. */
function PoolsPanel({ status }: { status: WalletStatus }) {
  const rows: { label: string; bal: number; spendable: boolean; note: string }[] = [
    {
      label: "Orchard (shielded)",
      bal: status.orchard.total_zatoshis,
      spendable: true,
      note: "Spendable by the threshold group via FROST.",
    },
    {
      label: "Sapling (shielded)",
      bal: status.sapling.total_zatoshis,
      spendable: false,
      note: "Not held or spendable by the group (different signature scheme).",
    },
    {
      label: "Transparent",
      bal: status.transparent.total_zatoshis,
      spendable: false,
      note: "Not held or spendable by the group (needs threshold ECDSA).",
    },
  ];
  return (
    <div className="card" style={{ marginTop: 14, background: "var(--bg-elevated)" }}>
      <h3 style={{ marginTop: 0 }}>Pools</h3>
      <table className="participants">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <td>
                {r.label}{" "}
                {r.spendable ? (
                  <span className="badge blue" style={{ marginLeft: 4 }}>
                    group-spendable
                  </span>
                ) : (
                  <span className="badge" style={{ marginLeft: 4 }}>
                    not group-held
                  </span>
                )}
                <div className="dim" style={{ fontSize: 12 }}>{r.note}</div>
              </td>
              <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                {zec(r.bal)} ZEC
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dim" style={{ marginTop: 8, fontSize: 12 }}>
        The group's key authorizes only Orchard spends. To move shielded funds
        out to a transparent address, use <strong>Unshield</strong> below.
      </p>
    </div>
  );
}

/** Receive / shield-into-group card: shows the group's Orchard unified address.
 *  "Shielding" into the group means sending funds to this address from a
 *  personal wallet — the group then holds them as spendable Orchard. */
function ReceiveShieldCard({ address }: { address: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  return (
    <div className="card" style={{ marginTop: 14, background: "var(--bg-elevated)" }}>
      <h3 style={{ marginTop: 0 }}>Receive / Shield into group</h3>
      <p className="dim" style={{ marginTop: 0 }}>
        Send Zcash to this unified address to fund the group. Funds arrive in the
        group's shielded <strong>Orchard</strong> pool and become spendable by the
        threshold. To <strong>shield</strong> transparent funds, send them here
        from a personal wallet — the receive itself is the shielding step.
      </p>
      <label>Group Orchard unified address</label>
      <div className="mono">{address}</div>
      <button
        className="secondary"
        style={{ marginTop: 6 }}
        onClick={async () => {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied!" : "Copy address"}
      </button>
    </div>
  );
}

type WalletTab = "balance" | "receive" | "send";

/** Per-group Zcash wallet: view-only account, receive address, balance. */
function GroupWallet({ group, isMainnet }: { group: GroupSummary; isMainnet: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["wallet-status", group.id],
    queryFn: () => walletGroupStatus(group.id),
    enabled: group.ciphersuite.includes("Pallas"),
  });
  const [err, setErr] = useState<string | null>(null);
  const [walletTab, setWalletTab] = useState<WalletTab>("balance");

  const init = useMutation({
    mutationFn: () => walletInitAccount(group.id),
    onSuccess: () => {
      setErr(null);
      queryClient.invalidateQueries({ queryKey: ["wallet-status", group.id] });
    },
    onError: (e) => setErr((e as unknown as AppError).message),
  });

  const [autoSyncOff, setAutoSyncOff] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const sync = useMutation({
    mutationFn: () => walletSync(group.id),
    onSuccess: (s) => {
      setErr(null);
      setLastSynced(new Date());
      queryClient.setQueryData(["wallet-status", group.id], s);
      queryClient.invalidateQueries({ queryKey: ["wallet-history", group.id] });
    },
    onError: (e) => {
      setErr((e as unknown as AppError).message);
      setAutoSyncOff(true);
    },
  });

  const [recipient, setRecipient] = useState("");
  const [amountZec, setAmountZec] = useState("");
  const [memo, setMemo] = useState("");
  const [draft, setDraft] = useState<DraftTransaction | null>(null);
  const [isConsolidation, setIsConsolidation] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // Shielded send (Orchard → Orchard) vs. unshield (Orchard → transparent).
  // Both reuse the same prepare/sign machinery; the mode only drives the
  // recipient validation, placeholder, and labeling — the backend decides the
  // authoritative is_unshield flag from the decoded address.
  const [sendMode, setSendMode] = useState<SendMode>("shielded");
  const recipientErr = validateRecipient(recipient, isMainnet, sendMode);
  const prepare = useMutation({
    mutationFn: () =>
      walletPrepareSend(
        group.id,
        recipient.trim(),
        Math.round(Number(amountZec) * 1e8),
        sendMode === "shielded" && memo.trim() ? memo.trim() : undefined,
      ),
    onSuccess: (d) => {
      setErr(null);
      setIsConsolidation(false);
      setDraft(d);
    },
    onError: (e) => setErr((e as unknown as AppError).message),
  });

  // Consolidation: self-transfer of nearly-all spendable balance. Forces the
  // note selector to pick all (or most) notes, merging them into one output so
  // future sends require only a single signing round. Costs a small network fee.
  // 100 000 zatoshis (0.001 ZEC) is a generous fee buffer for up to ~20 inputs.
  const CONSOLIDATE_FEE_BUFFER = 100_000;
  const consolidate = useMutation({
    mutationFn: () => {
      const addr = status.data?.address;
      const spendable = status.data?.spendable_zatoshis ?? 0;
      if (!addr) throw new Error("wallet address not available — try syncing first");
      if (spendable <= CONSOLIDATE_FEE_BUFFER)
        throw new Error("balance too low to consolidate (need > 0.001 ZEC above fees)");
      return walletPrepareSend(group.id, addr, spendable - CONSOLIDATE_FEE_BUFFER);
    },
    onSuccess: (d) => {
      setErr(null);
      setRecipient(status.data?.address ?? "");
      setAmountZec(String(d.amount_zatoshis / 1e8));
      setDraft(d);
      setIsConsolidation(true);
    },
    onError: (e) => setErr((e as unknown as AppError).message),
  });

  // The active send for this group lives in the persisted ceremony store, so it
  // survives navigation/reload and shows the same session id + step-by-step
  // progress the global CeremonyListener keeps updating. The signing ceremony
  // is driven via the other members' inbox; broadcast lands next (5.2c).
  const startSend = useCeremonies((s) => s.startSend);
  const clearSend = useCeremonies((s) => s.clearSend);
  const activeSend = useCeremonies((s) => selectActiveSend(s, group.id));
  const activeSendId = useCeremonies((s) => s.activeSendByGroup[group.id]);

  // Which group members will sign this transaction. A t-of-n group only needs
  // `threshold` of them online — selecting fewer would hang the ceremony, more
  // is allowed. Pre-seeded with this device's member (the coordinator), if it
  // is one, since it can contribute its share locally.
  const identity = useQuery({ queryKey: ["identity"], queryFn: getIdentity });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: listContacts });
  const signerOptions = useMemo(
    () =>
      Object.values(group.participants).map((pubkey) => {
        const r = resolveParticipant(pubkey, identity.data, contacts.data);
        return { pubkey, name: r.label, shortPubkey: r.shortPubkey };
      }),
    [group, identity.data, contacts.data]
  );
  const [signers, setSigners] = useState<Set<string>>(new Set());
  const seeded = useRef(false);
  useEffect(() => {
    const self = identity.data?.pubkey;
    if (!seeded.current && self && Object.values(group.participants).includes(self)) {
      setSigners(new Set([self]));
      seeded.current = true;
    }
  }, [identity.data, group]);

  const send = useMutation({
    mutationFn: () =>
      walletSend({
        group_id: group.id,
        recipient: recipient.trim(),
        amount_zatoshis: Math.round(Number(amountZec) * 1e8),
        signers: [...signers],
        memo: draft?.memo ?? null,
      }),
    onSuccess: (id) => {
      setErr(null);
      if (!draft) return;
      startSend(id, {
        groupId: group.id,
        recipient: draft.recipient,
        amountZatoshis: draft.amount_zatoshis,
        feeZatoshis: draft.fee_zatoshis,
        sighashHex: draft.sighash_hex,
        isConsolidation,
        isUnshield: draft.is_unshield,
        memo: draft.memo ?? undefined,
        signers: [...signers],
      });
    },
    onError: (e) => setErr((e as unknown as AppError).message),
  });

  // Auto-initialize the view-only account once, using the configured endpoint,
  // so the user doesn't need a separate step. Only retried manually on error.
  const autoTried = useRef(false);
  useEffect(() => {
    if (
      status.data &&
      !status.data.initialized &&
      !autoTried.current &&
      !init.isPending
    ) {
      autoTried.current = true;
      init.mutate();
    }
  }, [status.data, init]);

  // Auto-sync: fire immediately on first load, then every 30s.
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const statusRef = useRef(status.data);
  statusRef.current = status.data;
  const autoSyncOffRef = useRef(autoSyncOff);
  autoSyncOffRef.current = autoSyncOff;
  const syncedOnMount = useRef(false);
  useEffect(() => {
    if (status.data?.initialized && !syncedOnMount.current && !sync.isPending) {
      syncedOnMount.current = true;
      sync.mutate();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.initialized]);
  useEffect(() => {
    const t = setInterval(() => {
      const cur = syncRef.current;
      if (statusRef.current?.initialized && !cur.isPending && !autoSyncOffRef.current) {
        cur.mutate();
      }
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  if (!group.ciphersuite.includes("Pallas")) return null;
  const s = status.data;

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Wallet (Zcash Orchard)</h3>
      {!s || (!s.initialized && (init.isPending || !err)) ? (
        <p className="dim">Setting up the group's view-only wallet…</p>
      ) : !s.initialized ? (
        <>
          <p className="dim">
            Couldn't set up the wallet — check the lightwalletd endpoint on the{" "}
            <Link to="/wallet">Wallet</Link> page, then retry.
          </p>
          <button onClick={() => init.mutate()} disabled={init.isPending}>
            {init.isPending ? "Setting up…" : "Retry"}
          </button>
        </>
      ) : (
        <>
          {/* Balance summary — always visible at top */}
          <div className="wallet-summary">
            <div className="row" style={{ gap: 28 }}>
              <div>
                <label>Spendable (Orchard)</label>
                <div style={{ fontSize: 18, color: "var(--accent)" }}>
                  {zec(s.orchard.spendable_zatoshis)} ZEC
                </div>
              </div>
              <div>
                <label>Pending</label>
                <div style={{ fontSize: 18 }}>{zec(s.orchard.pending_zatoshis)} ZEC</div>
              </div>
              <div>
                <label>Total</label>
                <div style={{ fontSize: 18 }}>{zec(s.orchard.total_zatoshis)} ZEC</div>
              </div>
            </div>
            <div className="sync-box">
              <div className="dim" style={{ fontSize: 12 }}>
                Block {s.synced_height.toLocaleString()}
                {s.chain_tip_height > 0 && <> / {s.chain_tip_height.toLocaleString()}</>}
              </div>
              <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                {sync.isPending ? (
                  <span>↻ Syncing…</span>
                ) : lastSynced ? (
                  <span>
                    ✓ Synced {lastSynced.toLocaleTimeString(undefined, { timeStyle: "short" })}
                    {autoSyncOff && (
                      <>
                        {" · "}
                        <button
                          style={{ all: "unset", cursor: "pointer", color: "var(--accent)", fontSize: 11 }}
                          onClick={() => { setAutoSyncOff(false); sync.mutate(); }}
                        >
                          Resume auto-sync
                        </button>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="dim">Auto-syncing every 30s</span>
                )}
              </div>
            </div>
          </div>

          {/* Tab bar */}
          <div
            className="row"
            style={{
              gap: 0,
              marginTop: 16,
              borderBottom: "1px solid var(--border)",
              flexWrap: "wrap",
            }}
          >
            {(["balance", "receive", "send"] as WalletTab[]).map((tab) => {
              const active = walletTab === tab;
              const label =
                tab === "balance"
                  ? "Balance & Pools"
                  : tab === "receive"
                    ? "Receive / Shield"
                    : activeSend && !activeSend.done
                      ? "Send / Unshield ●"
                      : "Send / Unshield";
              return (
                <button
                  key={tab}
                  onClick={() => setWalletTab(tab)}
                  style={{
                    background: "none",
                    border: "none",
                    borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                    color: active ? "var(--accent)" : "inherit",
                    padding: "8px 14px",
                    cursor: "pointer",
                    fontSize: 13,
                    fontWeight: active ? 600 : 400,
                    marginBottom: -1,
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Balance & Pools tab */}
          {walletTab === "balance" && <PoolsPanel status={s} />}

          {/* Receive / Shield tab */}
          {walletTab === "receive" && <ReceiveShieldCard address={s.address} />}

          {/* Send / Unshield tab */}
          {walletTab === "send" && (
            <>
              {activeSend ? (
                <SendSessionPanel
                  ceremonyId={activeSendId ?? ""}
                  ceremony={activeSend}
                  onDismiss={() => {
                    clearSend(group.id);
                    setDraft(null);
                    setIsConsolidation(false);
                    setShowConfirm(false);
                  }}
                />
              ) : (
                <>
                  {isMainnet && (
                    <div
                      className="callout warn"
                      style={{
                        border: "1px solid var(--danger)",
                        background: "rgba(239,68,68,0.08)",
                        marginTop: 14,
                        marginBottom: 4,
                      }}
                    >
                      <span>
                        <strong>⚠ Mainnet</strong> — transactions move real ZEC and
                        are irreversible. Verify every address and amount carefully.
                      </span>
                    </div>
                  )}

                  {/* Mode toggle: shielded Orchard send vs. unshield to transparent. */}
                  <div className="row" style={{ marginTop: 14, marginBottom: 12, gap: 8 }}>
                    <button
                      className={sendMode === "shielded" ? "" : "secondary"}
                      onClick={() => { setSendMode("shielded"); setRecipient(""); setMemo(""); setDraft(null); }}
                    >
                      Send (shielded)
                    </button>
                    <button
                      className={sendMode === "unshield" ? "" : "secondary"}
                      onClick={() => { setSendMode("unshield"); setRecipient(""); setMemo(""); setDraft(null); }}
                    >
                      Unshield → transparent
                    </button>
                  </div>
                  {sendMode === "unshield" && (
                    <div className="callout warn" style={{ marginBottom: 10 }}>
                      <span>
                        Unshielding moves funds from the group's shielded Orchard pool to a{" "}
                        <strong>transparent</strong> address. The amount and recipient become{" "}
                        <strong>publicly visible on-chain</strong>. The group's Orchard spend is
                        still FROST-signed by the threshold.
                      </span>
                    </div>
                  )}
                  <label>
                    {sendMode === "unshield"
                      ? "Transparent recipient address"
                      : "Recipient unified address"}
                  </label>
                  <input
                    type="text"
                    placeholder={
                      sendMode === "unshield"
                        ? isMainnet
                          ? "t1… or t3… (mainnet transparent)"
                          : "tm… or t2… (testnet transparent)"
                        : isMainnet
                          ? "u1… (mainnet)"
                          : "utest1… (testnet)"
                    }
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                  />
                  {recipientErr && (
                    <div className="error" style={{ marginTop: -4 }}>
                      {recipientErr}
                    </div>
                  )}
                  <label>Amount (ZEC)</label>
                  <input
                    type="text"
                    placeholder="0.001"
                    value={amountZec}
                    onChange={(e) => setAmountZec(e.target.value)}
                  />
                  {sendMode === "shielded" && (
                    <>
                      <label>Memo (optional)</label>
                      <textarea
                        placeholder="Message to the recipient — stored encrypted on-chain, visible only to them."
                        value={memo}
                        maxLength={512}
                        rows={3}
                        onChange={(e) => setMemo(e.target.value)}
                        style={{ resize: "vertical", fontFamily: "monospace", fontSize: 13, width: "100%", boxSizing: "border-box" }}
                      />
                      {memo.length > 0 && (
                        <div className="dim" style={{ fontSize: 11, textAlign: "right", marginTop: 2 }}>
                          {memo.length}/512 characters
                        </div>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => prepare.mutate()}
                    disabled={
                      prepare.isPending ||
                      !recipient.trim() ||
                      !(Number(amountZec) > 0) ||
                      !!recipientErr
                    }
                  >
                    {prepare.isPending
                      ? "Building…"
                      : sendMode === "unshield"
                        ? "Prepare unshield transaction"
                        : "Prepare draft transaction"}
                  </button>
                  {draft && (
                    <div
                      className="card"
                      style={{ marginTop: 12, background: "var(--bg-elevated)" }}
                    >
                      <h3 style={{ marginTop: 0 }}>
                        {isConsolidation
                          ? "Consolidation transaction"
                          : draft.is_unshield
                            ? "Unshield transaction"
                            : "Prepared transaction"}
                      </h3>
                      {isConsolidation && (
                        <div className="callout" style={{ marginBottom: 12 }}>
                          <span>
                            Self-transfer — sends funds back to this group's own address, merging{" "}
                            <strong>{draft.spends.length} note{draft.spends.length !== 1 ? "s" : ""}</strong> into
                            one. After signing, future sends will need only a single signing round.
                            A small network fee applies.
                          </span>
                        </div>
                      )}
                      {!isConsolidation && draft.is_unshield && (
                        <div className="callout warn" style={{ marginBottom: 12 }}>
                          <span>
                            Unshield — moves <strong>{zec(draft.amount_zatoshis)} ZEC</strong> from
                            the group's shielded Orchard pool to a transparent address. The amount
                            and recipient will be <strong>publicly visible on-chain</strong>.
                          </span>
                        </div>
                      )}
                      <table className="participants">
                        <tbody>
                          <tr>
                            <td>Receiver</td>
                            <td className="dim mono-cell">
                              {isConsolidation ? "This group (self)" : draft.recipient}
                            </td>
                          </tr>
                          <tr>
                            <td>Amount to send</td>
                            <td>{zec(draft.amount_zatoshis)} ZEC</td>
                          </tr>
                          <tr>
                            <td>Fee</td>
                            <td>{zec(draft.fee_zatoshis)} ZEC</td>
                          </tr>
                          <tr>
                            <td>Total</td>
                            <td>{zec(draft.amount_zatoshis + draft.fee_zatoshis)} ZEC</td>
                          </tr>
                          <tr>
                            <td>Sighash</td>
                            <td className="dim mono-cell">{draft.sighash_hex}</td>
                          </tr>
                          {draft.memo && (
                            <tr>
                              <td>Memo</td>
                              <td style={{ fontStyle: "italic", wordBreak: "break-word" }}>{draft.memo}</td>
                            </tr>
                          )}
                        </tbody>
                      </table>

                      {draft.spends.length > 1 && (
                        <div className="callout warn" style={{ marginTop: 12 }}>
                          {isConsolidation ? (
                            <span>
                              Consolidating <strong>{draft.spends.length} notes</strong> — each signer
                              will see <strong>{draft.spends.length} inbox approvals</strong>, one per
                              input. After this completes, future sends will only need one.
                            </span>
                          ) : (
                            <>
                              <span>
                                This transaction uses <strong>{draft.spends.length} notes</strong> as
                                inputs. Each signer will see{" "}
                                <strong>{draft.spends.length} inbox approvals</strong> — one per input.
                              </span>
                              {status.data?.address &&
                                (status.data?.spendable_zatoshis ?? 0) > CONSOLIDATE_FEE_BUFFER && (
                                  <div style={{ marginTop: 8 }}>
                                    <button
                                      className="secondary"
                                      onClick={() => consolidate.mutate()}
                                      disabled={consolidate.isPending}
                                    >
                                      {consolidate.isPending
                                        ? "Building consolidation…"
                                        : "Consolidate notes first (recommended)"}
                                    </button>
                                    <p className="dim" style={{ margin: "6px 0 0", fontSize: 13 }}>
                                      Merges your notes into one via a self-transfer — costs a small
                                      fee, but future sends require only a single signing round.
                                    </p>
                                  </div>
                                )}
                            </>
                          )}
                        </div>
                      )}

                      <label style={{ marginTop: 12 }}>
                        Signers (need {group.threshold} of {group.num_participants})
                      </label>
                      {signerOptions.map((p) => (
                        <div key={p.pubkey} className="row" style={{ marginBottom: 6 }}>
                          <input
                            type="checkbox"
                            style={{ width: "auto" }}
                            checked={signers.has(p.pubkey)}
                            onChange={(e) => {
                              const next = new Set(signers);
                              if (e.target.checked) next.add(p.pubkey);
                              else next.delete(p.pubkey);
                              setSigners(next);
                            }}
                          />
                          <span>{p.name}</span>
                          <span className="dim code-inline">{p.shortPubkey}</span>
                        </div>
                      ))}
                      <p className="dim" style={{ marginTop: 6 }}>
                        {signers.size < group.threshold
                          ? `Select at least ${group.threshold} signer${
                              group.threshold === 1 ? "" : "s"
                            } (${signers.size} chosen). Each must be online to approve in their Inbox.`
                          : `${signers.size} of ${group.num_participants} selected — each must approve in their Inbox.`}
                      </p>
                      <button
                        onClick={() => {
                          if (isMainnet && !isConsolidation) {
                            setShowConfirm(true);
                          } else {
                            send.mutate();
                          }
                        }}
                        disabled={send.isPending || signers.size < group.threshold}
                      >
                        {send.isPending
                          ? "Starting…"
                          : isConsolidation
                            ? "Sign consolidation with the group"
                            : draft.is_unshield
                              ? "Sign unshield with the group"
                              : "Sign transaction with the group"}
                      </button>
                    </div>
                  )}

                  {showConfirm && draft && (
                    <MainnetConfirmModal
                      draft={draft}
                      isPending={send.isPending}
                      onConfirm={() => { setShowConfirm(false); send.mutate(); }}
                      onCancel={() => setShowConfirm(false)}
                    />
                  )}
                  <p className="dim" style={{ marginTop: 8 }}>
                    Building a draft constructs the transaction and computes what the
                    group needs to sign — it does not move funds or broadcast yet.
                  </p>
                </>
              )}
            </>
          )}
        </>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

/** Format a date for the history table. */
function fmtDate(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

/** Phase → human label for a wallet-send signing ceremony (coordinator side). */
const SEND_PHASES: { key: string; label: string }[] = [
  { key: "connecting", label: "Connecting to server" },
  { key: "session_created", label: "Session created — waiting for signers" },
  { key: "waiting_for_commitments", label: "Collecting commitments" },
  { key: "signing_package_sent", label: "Signing package sent" },
  { key: "waiting_for_shares", label: "Collecting signature shares" },
  { key: "aggregating", label: "Aggregating group signature" },
  { key: "proving", label: "Proving & broadcasting" },
  { key: "complete", label: "Sent — on-chain" },
];

/** Active signing session for a transaction: persisted session id (to convey to
 *  signers / find in their inbox) plus a live step-by-step status. Survives
 *  navigation because it reads from the ceremony store. */
function SendSessionPanel({
  ceremonyId,
  ceremony,
  onDismiss,
}: {
  ceremonyId: string;
  ceremony: CeremonyState;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // Track elapsed minutes so we can show a "stuck" warning when a signer
  // goes offline. Updates every 30 s while the ceremony is in flight.
  const [elapsedMin, setElapsedMin] = useState(0);
  useEffect(() => {
    if (!ceremony.startedAt || ceremony.done || ceremony.failed) return;
    const update = () =>
      setElapsedMin(Math.floor((Date.now() - ceremony.startedAt!) / 60_000));
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, [ceremony.startedAt, ceremony.done, ceremony.failed]);

  const handleCancel = async () => {
    setCancelling(true);
    try {
      if (ceremonyId) await cancelCeremony(ceremonyId);
    } finally {
      onDismiss();
    }
  };

  const meta = ceremony.send;
  const currentIdx = SEND_PHASES.findIndex((p) => p.key === ceremony.phase);
  const failed = ceremony.failed;
  const done = ceremony.done && !failed;

  return (
    <div className="card" style={{ marginTop: 18, background: "var(--bg-elevated)" }}>
      <h3 style={{ marginTop: 0 }}>Signing session</h3>
      {meta && (
        <>
          {meta.isConsolidation && (
            <div className="callout" style={{ marginBottom: 10 }}>
              <span>Note consolidation — merging fragmented notes into one to simplify future sends.</span>
            </div>
          )}
          {meta.isUnshield && (
            <div className="callout warn" style={{ marginBottom: 10 }}>
              <span>Unshield — moving funds from the group's shielded Orchard pool to a transparent address (publicly visible on-chain).</span>
            </div>
          )}
          <table className="participants">
            <tbody>
              <tr>
                <td>{meta.isUnshield ? "Unshielding" : "Sending"}</td>
                <td>{zec(meta.amountZatoshis)} ZEC</td>
              </tr>
              <tr>
                <td>To</td>
                <td className="dim mono-cell">
                  {meta.isConsolidation ? "This group (self)" : meta.recipient}
                </td>
              </tr>
              <tr>
                <td>Fee</td>
                <td>{zec(meta.feeZatoshis)} ZEC</td>
              </tr>
              {meta.memo && (
                <tr>
                  <td>Memo</td>
                  <td style={{ fontStyle: "italic", wordBreak: "break-word" }}>{meta.memo}</td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      <label style={{ marginTop: 12 }}>Session ID</label>
      {ceremony.sessionId ? (
        <>
          <div className="mono">{ceremony.sessionId}</div>
          <button
            className="secondary"
            style={{ marginTop: 6 }}
            onClick={async () => {
              await navigator.clipboard.writeText(ceremony.sessionId!);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied!" : "Copy session ID"}
          </button>
          <p className="dim" style={{ marginTop: 6 }}>
            The other signers approve this in their <Link to="/inbox">Inbox</Link>;
            share this ID if they need to find the session.
          </p>
        </>
      ) : (
        <div className="dim">Creating session…</div>
      )}

      <label style={{ marginTop: 12 }}>Progress</label>
      {!done && !failed && (ceremony.spendTotal ?? 1) > 1 && (
        <p className="dim" style={{ marginTop: 0 }}>
          Signing input {ceremony.spendIndex ?? 1} of {ceremony.spendTotal} — each
          input is a separate approval in signers' inboxes.
        </p>
      )}
      {/* Stuck warning: shown after 10 minutes with no completion. */}
      {!done && !failed && elapsedMin >= 10 && (
        <div className="callout warn" style={{ marginTop: 4 }}>
          <span>
            Waiting {elapsedMin} min — a signer may be offline or the session
            timed out. You can cancel and restart when everyone is available.
          </span>
        </div>
      )}
      <ol className="send-steps">
        {SEND_PHASES.map((p, i) => {
          const state = failed
            ? i < currentIdx
              ? "done"
              : i === currentIdx
                ? "failed"
                : "pending"
            : done || i < currentIdx
              ? "done"
              : i === currentIdx
                ? "active"
                : "pending";
          return (
            <li key={p.key} className={`send-step ${state}`}>
              <span className="send-step-mark">
                {state === "done" ? "✓" : state === "failed" ? "✕" : i === currentIdx ? "●" : "○"}
              </span>
              {p.label}
            </li>
          );
        })}
      </ol>

      {done && (
        <div className="callout" style={{ marginTop: 8 }}>
          <span>
            ✓ Sent. The group signed and the transaction was broadcast — it will
            confirm on-chain in a few minutes.
          </span>
        </div>
      )}
      {done && ceremony.txid && (
        <>
          <label style={{ marginTop: 12 }}>Transaction ID</label>
          <div className="mono">{ceremony.txid}</div>
        </>
      )}
      {failed && (
        <div className="error" style={{ marginTop: 8 }}>
          Signing session failed: {ceremony.error ?? "unknown error"}
        </div>
      )}

      <div className="row" style={{ marginTop: 12, flexWrap: "wrap", gap: 8 }}>
        <button className="secondary" onClick={onDismiss}>
          {done || failed ? "Done — start a new transaction" : "Dismiss"}
        </button>
        {!done && !failed && (
          <button
            className="danger"
            onClick={handleCancel}
            disabled={cancelling}
          >
            {cancelling ? "Cancelling…" : "Cancel ceremony"}
          </button>
        )}
      </div>
    </div>
  );
}

function isOrchard(group: GroupSummary): boolean {
  return group.ciphersuite.includes("Pallas");
}

/** Copyable labelled key/address row. */
function KeyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={{ marginTop: 8 }}>
      <label>{label}</label>
      <div className="mono">{value}</div>
      <button
        className="secondary"
        style={{ marginTop: 6 }}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied!" : "Copy"}
      </button>
    </div>
  );
}

/** The group's public key material and, for Orchard groups, its derived
 *  unified address and full viewing key. */
export function GroupKeys({ group }: { group: GroupSummary }) {
  const orchard = isOrchard(group);
  const keys = useQuery({
    queryKey: ["orchard-keys", group.id],
    queryFn: () => groupOrchardKeys(group.id),
    enabled: orchard,
    staleTime: Infinity,
  });

  return (
    <div style={{ marginTop: 10 }}>
      <KeyRow
        label={
          orchard
            ? "Orchard spend validating key (ak) — public"
            : "Group public verifying key"
        }
        value={group.id}
      />
      {orchard && keys.data && (
        <>
          <KeyRow label="Orchard unified address" value={keys.data.address} />
          <KeyRow
            label="Unified full viewing key (UFVK)"
            value={keys.data.ufvk}
          />
          <div className="callout" style={{ marginTop: 10 }}>
            <span>
              The viewing key (<span className="code-inline">nk</span>,{" "}
              <span className="code-inline">rivk</span>) is derived
              deterministically from the group's <span className="code-inline">ak</span>,
              so every member computes this same address. Funds sent here are
              spendable only by a threshold of the group. The UFVK grants{" "}
              <em>viewing</em> access — share it only within the group. The
              address is encoded for the network selected on the{" "}
              <Link to="/wallet">Wallet</Link> page (testnet by default).
            </span>
          </div>
        </>
      )}
      {orchard && keys.isError && (
        <div className="error">
          Could not derive the Orchard address for this group.
        </div>
      )}
    </div>
  );
}

/** Guided, accurate explanation of FROST's repairable-share recovery, shown in
 *  the group flow so a member knows what to do if they lose their share. */
function ShareRepairGuide({ group }: { group: GroupSummary }) {
  const [open, setOpen] = useState(false);
  const t = group.threshold;
  const n = group.num_participants;
  // Repairing one member's share needs `t` *other* members to help. There are
  // only n-1 others, so it is possible only when t <= n-1, i.e. t < n. An
  // m-of-m group (t === n) therefore cannot repair a lost share.
  const repairable = t < n;

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <button className="secondary" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Recovery & share repair"}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          {repairable ? (
            <div className="callout">
              <span>
                Because this is a <strong>{t}-of-{n}</strong> group, a lost or
                corrupted share is not fatal. Any <strong>{t}</strong> of the
                other {n - 1} members can help you regenerate <em>your</em> share
                — without ever revealing it and without anyone reconstructing the
                full group key. This is FROST's <em>repairable threshold</em>{" "}
                scheme.
              </span>
            </div>
          ) : (
            <div className="callout warn">
              <span>
                This is an <strong>{t}-of-{n}</strong> group — every member is
                required to sign. Repairing one member's share itself needs{" "}
                <strong>{t}</strong> other members to help, but only {n - 1}{" "}
                exist, so <strong>a lost share in this group cannot be repaired</strong>.
                Your only protection against losing a share is your recovery code
                and an encrypted keystore backup (below). If a member permanently
                loses their share, the group must run a new DKG to form a fresh
                group.
              </span>
            </div>
          )}

          <h3 style={{ marginTop: 16 }}>How your recovery options fit together</h3>
          <ul className="guide-list">
            <li>
              <strong>Forgot your passphrase</strong> but still have this device:
              use your 12-word recovery code to set a new one.
            </li>
            <li>
              <strong>Device failure</strong>, but you kept an encrypted keystore
              backup: restore the backup and unlock as normal.
            </li>
            <li>
              <strong>Lost the share entirely</strong> (no device, no backup):{" "}
              {repairable ? (
                "repair it with help from the group, using the steps below."
              ) : (
                <>
                  this {t}-of-{n} group cannot repair a share — the group would
                  need to form a new one with a fresh DKG.
                </>
              )}
            </li>
          </ul>

          {repairable && (
            <>
              <h3 style={{ marginTop: 16 }}>Before you start</h3>
              <div className="callout">
                <span>
                  You'll need: a working install of this app holding this group's
                  public data (already stored here), at least <strong>{t}</strong>{" "}
                  other participants online and willing to help, and agreement on
                  the identifier of the member being repaired.
                </span>
              </div>

              <h3 style={{ marginTop: 16 }}>The repair, step by step</h3>
              <ol className="steps">
                <li>
                  <div className="step-title">Choose your helpers</div>
                  <div className="step-body">
                    Pick any {t} of the other {n - 1} participants who still have
                    their shares. They are the “helpers.” Fewer than {t} cannot
                    repair a share — that is the security threshold working as
                    intended.
                  </div>
                </li>
                <li>
                  <div className="step-title">Round 1 — helpers compute repair deltas</div>
                  <div className="step-body">
                    Each helper uses their own share to compute a random blinding
                    value (a “delta”) for every other helper and sends it to them
                    over an encrypted channel. No delta reveals anything about a
                    share.
                  </div>
                </li>
                <li>
                  <div className="step-title">Round 2 — helpers combine into a “sigma”</div>
                  <div className="step-body">
                    Each helper sums the deltas they received into a single value
                    (their “sigma”) and sends it privately to you, the member
                    being repaired.
                  </div>
                </li>
                <li>
                  <div className="step-title">Round 3 — you reconstruct your share</div>
                  <div className="step-body">
                    Your device combines the {t} sigmas with your identifier and
                    the group's public commitments to rebuild your secret share
                    and key package — entirely locally.
                  </div>
                </li>
                <li>
                  <div className="step-title">Verify</div>
                  <div className="step-body">
                    Run a <Link to="/sign">test signing session</Link> with the
                    group to confirm your repaired share produces valid signatures.
                  </div>
                </li>
              </ol>

              <div className="callout warn" style={{ marginTop: 14 }}>
                <span>
                  <strong>Privacy guarantee:</strong> at no point does any helper
                  learn your share, and the full group secret is never
                  reconstructed. Helpers only ever exchange random blinding values.
                </span>
              </div>
            </>
          )}

          <p className="dim" style={{ marginTop: 12 }}>
            This screen documents the protocol (FROST's repairable threshold
            scheme, implemented in <span className="code-inline">frost-core</span>). A
            guided in-app repair ceremony — like the DKG wizard — is the planned
            next step; until then, the safest habit is to keep your recovery code
            and an encrypted keystore backup so you rarely need a full repair.
          </p>
        </div>
      )}
    </div>
  );
}

/** Inline group name editor — pencil icon toggles a text input in place. */
function GroupNameEditor({
  group,
  onRenamed,
}: {
  group: GroupSummary;
  onRenamed: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(group.description);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = () => {
    setValue(group.description);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };
  const cancel = () => setEditing(false);
  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === group.description) { setEditing(false); return; }
    setSaving(true);
    try {
      await renameGroup(group.id, trimmed);
      onRenamed();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="row" style={{ gap: 6, alignItems: "center", flex: 1 }}>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") cancel(); }}
          style={{ flex: 1, margin: 0, fontSize: 20, fontWeight: 600, padding: "2px 8px" }}
        />
        <button onClick={save} disabled={saving} style={{ padding: "4px 12px" }}>
          {saving ? "…" : "Save"}
        </button>
        <button className="secondary" onClick={cancel} style={{ padding: "4px 10px" }}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="row" style={{ gap: 8, alignItems: "center" }}>
      <h3 style={{ margin: 0 }}>{group.description || "(unnamed group)"}</h3>
      <button
        className="secondary"
        title="Edit group name"
        onClick={open}
        style={{ padding: "2px 7px", fontSize: 13, lineHeight: 1, border: "none", background: "none", cursor: "pointer", color: "var(--dim)" }}
      >
        ✏
      </button>
    </div>
  );
}

export function GroupCard({
  group,
  identity,
  contacts,
  onRemove,
  onRenamed,
}: {
  group: GroupSummary;
  identity: Identity | undefined;
  contacts: ContactDto[] | undefined;
  onRemove: (id: string) => void;
  onRenamed: () => void;
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <GroupNameEditor group={group} onRenamed={onRenamed} />
        <span className="badge blue" style={{ flexShrink: 0, marginLeft: 8 }}>{group.ciphersuite}</span>
      </div>
      <p>
        {group.threshold}-of-{group.num_participants} threshold
      </p>

      <GroupKeys group={group} />

      <div style={{ marginTop: 12 }}>
        <label>Participants</label>
        <table className="participants">
          <tbody>
            {Object.values(group.participants).map((pubkey) => {
              const p = resolveParticipant(pubkey, identity, contacts);
              return (
                <tr key={pubkey}>
                  <td className={p.isSelf ? "ok" : undefined}>{p.label}</td>
                  <td className="dim mono-cell">{p.pubkey}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ShareRepairGuide group={group} />

      <div style={{ marginTop: 12 }}>
        <button
          className="danger"
          onClick={() => {
            if (
              confirm(
                "Remove this group? Your key share will be deleted from the keystore. " +
                  "You can only get it back by repairing it with the group."
              )
            ) {
              onRemove(group.id);
            }
          }}
        >
          Remove group
        </button>
      </div>
    </div>
  );
}

/** Shared data + remove/rename mutations used by both the index and detail screens. */
function useGroupData() {
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: listContacts });
  const identity = useQuery({ queryKey: ["identity"], queryFn: getIdentity });
  const remove = useMutation({
    mutationFn: removeGroup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["groups"] }),
  });
  const invalidateGroups = () => queryClient.invalidateQueries({ queryKey: ["groups"] });
  return { groups, contacts, identity, remove, invalidateGroups };
}

/** `/groups` — pick a group (also reachable from the sidebar dropdown). */
export default function Groups() {
  const { groups } = useGroupData();

  return (
    <div>
      <h2>Groups</h2>
      <p className="dim">
        Threshold signing groups this keystore holds a share for. Choose one from
        the sidebar or below to see its keys, participants, and recovery options.
      </p>
      {groups.data?.length ? (
        groups.data.map((g) => (
          <Link
            key={g.id}
            to={`/groups/${g.id}`}
            className="card group-pick"
            style={{ display: "block", textDecoration: "none", color: "inherit" }}
          >
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>{g.description || "(unnamed group)"}</h3>
              <span className="badge blue">{g.ciphersuite}</span>
            </div>
            <p className="dim" style={{ margin: "6px 0 0" }}>
              {g.threshold}-of-{g.num_participants} threshold · {g.id.slice(0, 16)}…
            </p>
          </Link>
        ))
      ) : (
        <div className="card">
          <p className="dim">
            No groups in this keystore. Create one with a{" "}
            <Link to="/dkg">DKG ceremony</Link>.
          </p>
        </div>
      )}
    </div>
  );
}

/** `/groups/:id` — a single group's full detail. */
export function GroupDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { groups, contacts, identity, remove, invalidateGroups } = useGroupData();
  const group = groups.data?.find((g) => g.id === id);

  if (groups.isLoading) {
    return <p className="dim">Loading…</p>;
  }
  if (!group) {
    return (
      <div>
        <h2>Group not found</h2>
        <p className="dim">
          This group isn't in your keystore. <Link to="/groups">Back to groups</Link>.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>{/* spacer — name lives inside GroupCard */}</div>
        <div className="row" style={{ gap: 16 }}>
          <Link to="/sign">Start a Signing Session →</Link>
          {group.ciphersuite.includes("Pallas") && (
            <Link to={`/groups/${group.id}/wallet`}>Build a Transaction →</Link>
          )}
        </div>
      </div>
      <GroupCard
        group={group}
        identity={identity.data}
        contacts={contacts.data}
        onRenamed={invalidateGroups}
        onRemove={(gid) => {
          remove.mutate(gid);
          navigate("/groups");
        }}
      />
    </div>
  );
}

/** `/groups/:id/wallet` — the group's Zcash wallet: balance, send, history. */
export function GroupWalletPage() {
  const { id } = useParams();
  const { groups } = useGroupData();
  const group = groups.data?.find((g) => g.id === id);
  const walletConfig = useQuery({ queryKey: ["wallet-config"], queryFn: getWalletConfig });
  const isMainnet = walletConfig.data?.network === "main";

  if (groups.isLoading) return <p className="dim">Loading…</p>;
  if (!group) {
    return (
      <div>
        <h2>Group not found</h2>
        <p className="dim">
          <Link to="/groups">Back to groups</Link>.
        </p>
      </div>
    );
  }
  if (!group.ciphersuite.includes("Pallas")) {
    return (
      <div>
        <h2>{group.description || "(unnamed group)"} — Wallet</h2>
        <p className="dim">
          A Zcash wallet is only available for RedPallas (Orchard) groups.{" "}
          <Link to={`/groups/${group.id}`}>Back to group details</Link>.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ marginBottom: 0 }}>
          {group.description || "(unnamed group)"} — Wallet
          {isMainnet && (
            <span
              style={{
                marginLeft: 10,
                fontSize: 13,
                color: "var(--danger)",
                fontWeight: 600,
                verticalAlign: "middle",
              }}
            >
              ⚠ MAINNET
            </span>
          )}
        </h2>
        <Link to={`/groups/${group.id}`} className="dim">
          ← Group details
        </Link>
      </div>
      <div className="card">
        <GroupWallet group={group} isMainnet={isMainnet} />
      </div>
      <WalletTxHistory group={group} />
    </div>
  );
}

/** Unified on-chain + pending-ceremony transaction history for a group wallet.
 *
 *  Data sources:
 *  - On-chain rows come from the local SQLite wallet-db (authoritative).
 *  - Pending rows come from the in-memory ceremony store for sends that have
 *    been started but haven't landed on-chain yet (in-flight or failed).
 *
 *  Columns: Date & Time | Type | Amount | Address | Tx Hash | [+]
 */
function WalletTxHistory({ group }: { group: GroupSummary }) {
  const history = useQuery({
    queryKey: ["wallet-history", group.id],
    queryFn: () => walletHistory(group.id),
    enabled: group.ciphersuite.includes("Pallas"),
    refetchInterval: 35_000,
  });
  const walletStatus = useQuery({
    queryKey: ["wallet-status", group.id],
    queryFn: () => walletGroupStatus(group.id),
    enabled: group.ciphersuite.includes("Pallas"),
  });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: listContacts });
  const groupAddress = walletStatus.data?.address ?? null;

  // Pending / recently-completed sends not yet confirmed on-chain.
  const ceremonies = useCeremonies((s) => s.ceremonies);
  const txSigners = useCeremonies((s) => s.txSigners);
  const activeId = useCeremonies((s) => s.activeSendByGroup[group.id]);
  const onchainTxids = useMemo(
    () => new Set((history.data ?? []).map((t) => t.txid)),
    [history.data]
  );
  const pendingRows = useMemo(
    () =>
      Object.entries(ceremonies)
        .filter(
          ([id, c]) =>
            c.kind === "send" &&
            c.groupId === group.id &&
            id !== activeId &&
            // If it landed on-chain, let the SQLite row be authoritative.
            !(c.txid && onchainTxids.has(c.txid))
        )
        .map(([id, c]) => ({ ...c, id }))
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)),
    [ceremonies, group.id, activeId, onchainTxids]
  );

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const toggle = useCallback(
    (key: string) => setExpandedKey((prev) => (prev === key ? null : key)),
    []
  );

  if (!group.ciphersuite.includes("Pallas")) return null;

  const onchainRows = history.data ?? [];
  const hasAny = pendingRows.length > 0 || onchainRows.length > 0;

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>Transaction history</h3>

      {history.isLoading && <p className="dim">Loading…</p>}
      {history.isError && (
        <p className="error">
          Could not load history:{" "}
          {(history.error as unknown as AppError)?.message ?? String(history.error)}
        </p>
      )}
      {history.isSuccess && !hasAny && (
        <p className="dim">
          No transactions yet — balance updates appear here after syncing.
        </p>
      )}

      {hasAny && (
        <table className="participants" style={{ tableLayout: "fixed", width: "100%" }}>
          <colgroup>
            <col style={{ width: "21%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: "22%" }} />
            <col style={{ width: "9%" }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 500 }}>Date & Time</th>
              <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 500 }}>Type</th>
              <th style={{ textAlign: "right", paddingBottom: 6, fontWeight: 500 }}>Amount</th>
              <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 500 }}>Address</th>
              <th style={{ textAlign: "left", paddingBottom: 6, fontWeight: 500 }}>Tx Hash</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {/* Pending / in-flight / recently-failed ceremony rows */}
            {pendingRows.map((row) => (
              <PendingTxRow
                key={row.id}
                row={row}
                contacts={contacts.data ?? []}
                groupAddress={groupAddress}
                isExpanded={expandedKey === row.id}
                onToggle={() => toggle(row.id)}
              />
            ))}
            {/* On-chain confirmed rows from SQLite */}
            {onchainRows.slice(0, 50).map((tx) => (
              <OnchainTxRow
                key={tx.txid}
                tx={tx}
                contacts={contacts.data ?? []}
                groupAddress={groupAddress}
                signers={txSigners[tx.txid]}
                isExpanded={expandedKey === tx.txid}
                onToggle={() => toggle(tx.txid)}
              />
            ))}
          </tbody>
        </table>
      )}

      {onchainRows.length > 50 && (
        <p className="dim" style={{ marginTop: 8, fontSize: 12 }}>
          Showing 50 most recent of {onchainRows.length} transactions.
        </p>
      )}
    </div>
  );
}

/** Resolve a comm pubkey to a display name using the contacts list. */
function signerLabel(pubkey: string, contacts: ContactDto[]): string {
  const c = contacts.find((c) => c.pubkey === pubkey);
  return c ? (c.alias ?? c.name ?? pubkey.slice(0, 8) + "…") : pubkey.slice(0, 8) + "…";
}

/** Expand-detail panel shared by both row types. */
function TxDetail({
  colSpan,
  txid,
  timestamp,
  blockHeight,
  direction,
  amount,
  fee,
  fromAddress,
  recipient,
  memo,
  signers,
  contacts,
  error,
}: {
  colSpan: number;
  txid?: string;
  timestamp?: number | null;
  blockHeight?: number | null;
  direction?: string;
  amount?: number;
  fee?: number | null;
  fromAddress?: string | null;
  recipient?: string | null;
  memo?: string | null;
  signers?: string[];
  contacts?: ContactDto[];
  error?: string;
}) {
  const dateStr = timestamp
    ? fmtDate(new Date(timestamp * 1000))
    : blockHeight != null
      ? `Block #${blockHeight.toLocaleString()} (time unavailable)`
      : "Pending";

  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = [];

  rows.push({ label: "Date & Time", value: dateStr });
  if (blockHeight != null) rows.push({ label: "Block", value: `#${blockHeight.toLocaleString()}` });
  if (txid) rows.push({ label: "Transaction ID", value: txid, mono: true });
  if (direction) rows.push({ label: "Type", value: direction === "receive" ? "Received" : direction === "send" ? "Sent" : "Consolidation" });
  if (amount != null) rows.push({ label: "Amount", value: `${direction === "receive" ? "+" : direction === "send" ? "−" : ""}${zec(amount)} ZEC` });
  if (fee != null) rows.push({ label: "Network Fee", value: `${zec(fee)} ZEC` });
  if (fromAddress) rows.push({ label: "From", value: fromAddress, mono: true });
  else if (direction === "receive") rows.push({ label: "From", value: "Shielded sender (private)" });
  if (recipient) rows.push({ label: "To", value: recipient, mono: true });
  else if (direction === "send") rows.push({ label: "To", value: "This group (consolidation)" });
  if (memo) rows.push({ label: "Memo", value: memo });
  if (signers && signers.length > 0 && contacts) {
    rows.push({
      label: "Signed by",
      value: signers.map((pk) => signerLabel(pk, contacts)).join(", "),
    });
  }

  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{ padding: "0 0 12px 0", background: "var(--bg-elevated)" }}
      >
        <div style={{ padding: "8px 12px 4px", overflow: "hidden" }}>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <tbody>
              {rows.map(({ label, value, mono }) => (
                <tr key={label}>
                  <td style={{ color: "var(--fg-muted)", whiteSpace: "nowrap", paddingRight: 12, paddingBottom: 5, verticalAlign: "top", width: "120px" }}>
                    {label}
                  </td>
                  <td style={{ paddingBottom: 5, verticalAlign: "top", wordBreak: "break-all", overflowWrap: "anywhere" }}
                    className={mono ? "mono" : undefined}>
                    {value}
                  </td>
                </tr>
              ))}
              {error && (
                <tr>
                  <td style={{ color: "var(--fg-muted)", whiteSpace: "nowrap", paddingRight: 12, paddingBottom: 5, verticalAlign: "top" }}>Error</td>
                  <td style={{ color: "var(--danger)", paddingBottom: 5 }}>{error}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </td>
    </tr>
  );
}

type PendingRow = CeremonyState & { id: string };

function PendingTxRow({
  row,
  contacts,
  groupAddress,
  isExpanded,
  onToggle,
}: {
  row: PendingRow;
  contacts: ContactDto[];
  groupAddress: string | null;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const meta = row.send;
  const isSelf = meta?.isConsolidation;
  const isUnshield = meta?.isUnshield;
  const dateStr = row.startedAt ? fmtDate(new Date(row.startedAt)) : "—";
  const addrDisplay = isSelf
    ? "(self)"
    : meta?.recipient
      ? meta.recipient.slice(0, 10) + "…"
      : "—";
  const txHashDisplay = row.txid ? row.txid.slice(0, 10) + "…" : "—";

  return (
    <>
      <tr>
        <td className="dim" style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{dateStr}</td>
        <td style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {row.failed ? (
            <span style={{ color: "var(--danger)", fontSize: 12 }}>✕ Failed</span>
          ) : isSelf ? (
            <span className="dim" style={{ fontSize: 12 }}>⇄ Consolidation</span>
          ) : isUnshield ? (
            <span style={{ color: "var(--accent)", fontSize: 12 }}>⇲ Unshield</span>
          ) : (
            <span style={{ color: "var(--accent)", fontSize: 12 }}>↑ Sent</span>
          )}
        </td>
        <td style={{ textAlign: "right", maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
          {meta ? `−${zec(meta.amountZatoshis)} ZEC` : "—"}
        </td>
        <td className="dim mono-cell" style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
          {addrDisplay}
        </td>
        <td className="dim mono-cell" style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
          {txHashDisplay}
          {!row.txid && !row.failed && (
            <span style={{ marginLeft: 4 }} title="Awaiting confirmation">⏳</span>
          )}
        </td>
        <td style={{ textAlign: "center" }}>
          <button
            className="secondary"
            style={{ padding: "2px 6px", fontSize: 11, lineHeight: 1 }}
            onClick={onToggle}
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? "−" : "+"}
          </button>
        </td>
      </tr>
      {isExpanded && (
        <TxDetail
          colSpan={6}
          txid={row.txid}
          blockHeight={undefined}
          direction={isSelf ? "self" : isUnshield ? "send" : "send"}
          amount={meta?.amountZatoshis}
          fee={meta?.feeZatoshis}
          fromAddress={groupAddress}
          recipient={isSelf ? undefined : meta?.recipient}
          memo={meta?.memo}
          signers={meta?.signers}
          contacts={contacts}
          error={row.error}
        />
      )}
    </>
  );
}

function OnchainTxRow({
  tx,
  contacts,
  groupAddress,
  signers,
  isExpanded,
  onToggle,
}: {
  tx: TxRecord;
  contacts: ContactDto[];
  groupAddress: string | null;
  signers?: string[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isReceive = tx.direction === "receive";
  const isSelf = tx.direction === "send" && tx.recipient == null;
  const addrDisplay = isReceive
    ? "—"
    : isSelf
      ? "(self)"
      : tx.recipient
        ? tx.recipient.slice(0, 10) + "…"
        : "—";
  const txHashDisplay = tx.txid.slice(0, 10) + "…";
  const dateDisplay = tx.timestamp != null
    ? fmtDate(new Date(tx.timestamp * 1000))
    : tx.block_height != null
      ? `Block #${tx.block_height.toLocaleString()}`
      : "Pending";

  return (
    <>
      <tr>
        <td className="dim" style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>{dateDisplay}</td>
        <td style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {isReceive ? (
            <span style={{ color: "#4ade80", fontSize: 12 }}>↓ Received</span>
          ) : isSelf ? (
            <span className="dim" style={{ fontSize: 12 }}>⇄ Consolidation</span>
          ) : (
            <span style={{ color: "var(--accent)", fontSize: 12 }}>↑ Sent</span>
          )}
        </td>
        <td style={{ textAlign: "right", maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 }}>
          <span style={{ color: isReceive ? "#4ade80" : undefined }}>
            {isReceive ? "+" : isSelf ? "" : "−"}
            {zec(tx.amount_zatoshis)} ZEC
          </span>
        </td>
        <td className="dim mono-cell" style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>
          {addrDisplay}
        </td>
        <td className="dim mono-cell" style={{ maxWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }}>{txHashDisplay}</td>
        <td style={{ textAlign: "center" }}>
          <button
            className="secondary"
            style={{ padding: "2px 6px", fontSize: 11, lineHeight: 1 }}
            onClick={onToggle}
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? "−" : "+"}
          </button>
        </td>
      </tr>
      {isExpanded && (
        <TxDetail
          colSpan={6}
          txid={tx.txid}
          timestamp={tx.timestamp}
          blockHeight={tx.block_height}
          direction={isSelf ? "self" : tx.direction}
          amount={tx.amount_zatoshis}
          fee={tx.fee_zatoshis}
          fromAddress={isReceive ? null : groupAddress}
          recipient={isSelf ? undefined : tx.recipient}
          memo={tx.memo}
          signers={signers}
          contacts={contacts}
        />
      )}
    </>
  );
}
