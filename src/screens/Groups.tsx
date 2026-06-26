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
  walletGroupStatus,
  walletInitAccount,
  walletSync,
  walletPrepareSend,
  walletSend,
  walletHistory,
  AppError,
  DraftTransaction,
  TxRecord,
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

/** Returns a human-readable error if `address` clearly belongs to the wrong
 *  network, so the user catches the mismatch before paying gas to find out. */
function detectAddressNetworkMismatch(address: string, isMainnet: boolean): string | null {
  const a = address.trim();
  if (!a) return null;
  if (isMainnet) {
    if (a.startsWith("utest") || a.startsWith("ztestsapling") || a.startsWith("tm")) {
      return "This looks like a testnet address. You are on Mainnet — check the address carefully.";
    }
  } else {
    // Mainnet UA starts with "u1"; testnet UA starts with "utest1"
    if ((a.startsWith("u") && !a.startsWith("utest")) || a.startsWith("zs1") || a.startsWith("t1")) {
      return "This looks like a mainnet address. You are on Testnet.";
    }
  }
  return null;
}

/** Per-group Zcash wallet: view-only account, receive address, balance. */
function GroupWallet({ group, isMainnet }: { group: GroupSummary; isMainnet: boolean }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["wallet-status", group.id],
    queryFn: () => walletGroupStatus(group.id),
    enabled: group.ciphersuite.includes("Pallas"),
  });
  const [err, setErr] = useState<string | null>(null);

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
  const [draft, setDraft] = useState<DraftTransaction | null>(null);
  const [isConsolidation, setIsConsolidation] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const prepare = useMutation({
    mutationFn: () =>
      walletPrepareSend(group.id, recipient.trim(), Math.round(Number(amountZec) * 1e8)),
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
          <div className="wallet-summary">
            <div className="row" style={{ gap: 28 }}>
              <div>
                <label>Total</label>
                <div style={{ fontSize: 18 }}>{zec(s.total_zatoshis)} ZEC</div>
              </div>
              <div>
                <label>Spendable</label>
                <div style={{ fontSize: 18 }}>{zec(s.spendable_zatoshis)} ZEC</div>
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

          {activeSend && (
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
          )}

          {!activeSend && (
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
          <h3 style={{ marginTop: 18 }}>Send</h3>
          <label>Recipient unified address</label>
          <input
            type="text"
            placeholder={isMainnet ? "u1… (mainnet)" : "utest1… (testnet)"}
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          {/* Warn immediately if the typed address looks like the wrong network */}
          {detectAddressNetworkMismatch(recipient, isMainnet) && (
            <div className="error" style={{ marginTop: -4 }}>
              {detectAddressNetworkMismatch(recipient, isMainnet)}
            </div>
          )}
          <label>Amount (ZEC)</label>
          <input
            type="text"
            placeholder="0.001"
            value={amountZec}
            onChange={(e) => setAmountZec(e.target.value)}
          />
          <button
            onClick={() => prepare.mutate()}
            disabled={
              prepare.isPending ||
              !recipient.trim() ||
              !(Number(amountZec) > 0) ||
              !!detectAddressNetworkMismatch(recipient, isMainnet)
            }
          >
            {prepare.isPending ? "Building…" : "Prepare draft transaction"}
          </button>
          {draft && (
            <div
              className="card"
              style={{ marginTop: 12, background: "var(--bg-elevated)" }}
            >
              <h3 style={{ marginTop: 0 }}>
                {isConsolidation ? "Consolidation transaction" : "Prepared transaction"}
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
                </tbody>
              </table>

              {/* Multi-spend warning: show when the wallet's notes are fragmented. */}
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
                    : "Sign transaction with the group"}
              </button>
            </div>
          )}

          {/* Mainnet confirmation modal — shown before starting a real-ZEC send. */}
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
          <table className="participants">
            <tbody>
              <tr>
                <td>Sending</td>
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

export function GroupCard({
  group,
  identity,
  contacts,
  onRemove,
}: {
  group: GroupSummary;
  identity: Identity | undefined;
  contacts: ContactDto[] | undefined;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>{group.description || "(unnamed group)"}</h3>
        <span className="badge blue">{group.ciphersuite}</span>
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

/** Shared data + remove mutation used by both the index and detail screens. */
function useGroupData() {
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: listContacts });
  const identity = useQuery({ queryKey: ["identity"], queryFn: getIdentity });
  const remove = useMutation({
    mutationFn: removeGroup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["groups"] }),
  });
  return { groups, contacts, identity, remove };
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
  const { groups, contacts, identity, remove } = useGroupData();
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
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <h2 style={{ marginBottom: 0 }}>{group.description || "(unnamed group)"}</h2>
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

  // Pending / recently-completed sends not yet confirmed on-chain.
  const ceremonies = useCeremonies((s) => s.ceremonies);
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
            <col style={{ width: "13%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "28%" }} />
            <col style={{ width: "28%" }} />
            <col style={{ width: "6%" }} />
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
                isExpanded={expandedKey === row.id}
                onToggle={() => toggle(row.id)}
              />
            ))}
            {/* On-chain confirmed rows from SQLite */}
            {onchainRows.slice(0, 50).map((tx) => (
              <OnchainTxRow
                key={tx.txid}
                tx={tx}
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

/** Expand-detail panel shared by both row types. */
function TxDetail({
  colSpan,
  txid,
  recipient,
  fee,
  memo,
  blockHeight,
  error,
}: {
  colSpan: number;
  txid?: string;
  recipient?: string | null;
  fee?: number | null;
  memo?: string | null;
  blockHeight?: number | null;
  error?: string;
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        style={{ padding: "0 0 12px 0", background: "var(--bg-elevated)" }}
      >
        <div style={{ padding: "8px 12px", fontSize: 13, display: "grid", gap: 6 }}>
          {txid && (
            <div>
              <label>Transaction ID</label>
              <div className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                {txid}
              </div>
            </div>
          )}
          {recipient && (
            <div>
              <label>Recipient</label>
              <div className="mono" style={{ fontSize: 11, wordBreak: "break-all" }}>
                {recipient}
              </div>
            </div>
          )}
          {fee != null && (
            <div>
              <label>Fee</label>
              <div>{zec(fee)} ZEC</div>
            </div>
          )}
          {blockHeight != null && (
            <div>
              <label>Block</label>
              <div>#{blockHeight.toLocaleString()}</div>
            </div>
          )}
          {memo && (
            <div>
              <label>Memo</label>
              <div>{memo}</div>
            </div>
          )}
          {error && (
            <div>
              <label>Error</label>
              <div style={{ color: "var(--danger)", fontSize: 12 }}>{error}</div>
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

type PendingRow = CeremonyState & { id: string };

function PendingTxRow({
  row,
  isExpanded,
  onToggle,
}: {
  row: PendingRow;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const meta = row.send;
  const isSelf = meta?.isConsolidation;
  const dateStr = row.startedAt ? fmtDate(new Date(row.startedAt)) : "—";
  const addrDisplay = isSelf
    ? "(self)"
    : meta?.recipient
      ? meta.recipient.slice(0, 16) + "…"
      : "—";
  const txHashDisplay = row.txid ? row.txid.slice(0, 12) + "…" : "—";

  return (
    <>
      <tr>
        <td className="dim" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{dateStr}</td>
        <td>
          {row.failed ? (
            <span style={{ color: "var(--danger)", fontSize: 12 }}>✕ Failed</span>
          ) : isSelf ? (
            <span className="dim" style={{ fontSize: 12 }}>⇄ Consolidation</span>
          ) : (
            <span style={{ color: "var(--accent)", fontSize: 12 }}>↑ Sent</span>
          )}
        </td>
        <td style={{ textAlign: "right", whiteSpace: "nowrap", fontSize: 12 }}>
          {meta ? `−${zec(meta.amountZatoshis)} ZEC` : "—"}
        </td>
        <td className="dim mono-cell" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>
          {addrDisplay}
        </td>
        <td className="dim mono-cell" style={{ fontSize: 11 }}>
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
          recipient={isSelf ? undefined : meta?.recipient}
          fee={meta?.feeZatoshis}
          error={row.error}
        />
      )}
    </>
  );
}

function OnchainTxRow({
  tx,
  isExpanded,
  onToggle,
}: {
  tx: TxRecord;
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
        ? tx.recipient.slice(0, 16) + "…"
        : "—";
  const txHashDisplay = tx.txid.slice(0, 12) + "…";
  // Block height as approximate date label (no timestamp in db).
  const dateDisplay = tx.block_height != null
    ? `Block #${tx.block_height.toLocaleString()}`
    : "Pending";

  return (
    <>
      <tr>
        <td className="dim" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{dateDisplay}</td>
        <td>
          {isReceive ? (
            <span style={{ color: "#4ade80", fontSize: 12 }}>↓ Received</span>
          ) : isSelf ? (
            <span className="dim" style={{ fontSize: 12 }}>⇄ Consolidation</span>
          ) : (
            <span style={{ color: "var(--accent)", fontSize: 12 }}>↑ Sent</span>
          )}
        </td>
        <td style={{ textAlign: "right", whiteSpace: "nowrap", fontSize: 12 }}>
          <span style={{ color: isReceive ? "#4ade80" : undefined }}>
            {isReceive ? "+" : isSelf ? "" : "−"}
            {zec(tx.amount_zatoshis)} ZEC
          </span>
        </td>
        <td className="dim mono-cell" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis" }}>
          {addrDisplay}
        </td>
        <td className="dim mono-cell" style={{ fontSize: 11 }}>{txHashDisplay}</td>
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
          recipient={isSelf ? undefined : tx.recipient}
          fee={tx.fee_zatoshis}
          memo={tx.memo}
          blockHeight={tx.block_height ?? undefined}
        />
      )}
    </>
  );
}
