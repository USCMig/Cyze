import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  getIdentity,
  groupOrchardKeys,
  listContacts,
  listGroups,
  removeGroup,
  walletGroupStatus,
  walletInitAccount,
  walletSync,
  walletPrepareSend,
  walletSend,
  AppError,
  DraftTransaction,
  ContactDto,
  GroupSummary,
  Identity,
} from "../ipc/commands";
import { resolveParticipant } from "../lib/participants";
import {
  useCeremonies,
  selectActiveSend,
  selectSendHistory,
  type CeremonyState,
} from "../stores/ceremonies";

/** ZEC display from zatoshis (1 ZEC = 1e8 zatoshis). */
function zec(zats: number): string {
  return (zats / 1e8).toLocaleString(undefined, { maximumFractionDigits: 8 });
}

/** Per-group Zcash wallet: view-only account, receive address, balance. */
function GroupWallet({ group }: { group: GroupSummary }) {
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

  // TODO(wallet): once auto-sync is proven reliable, remove the manual
  // "Sync now" button entirely (tracked in TODO.md).
  const [autoSyncOff, setAutoSyncOff] = useState(false);
  const sync = useMutation({
    mutationFn: () => walletSync(group.id),
    onSuccess: (s) => {
      setErr(null);
      queryClient.setQueryData(["wallet-status", group.id], s);
    },
    onError: (e) => {
      setErr((e as unknown as AppError).message);
      setAutoSyncOff(true); // pause auto-sync after a failure until manual retry
    },
  });

  const [recipient, setRecipient] = useState("");
  const [amountZec, setAmountZec] = useState("");
  const [draft, setDraft] = useState<DraftTransaction | null>(null);
  const prepare = useMutation({
    mutationFn: () =>
      walletPrepareSend(group.id, recipient.trim(), Math.round(Number(amountZec) * 1e8)),
    onSuccess: (d) => {
      setErr(null);
      setDraft(d);
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
  const send = useMutation({
    mutationFn: () =>
      walletSend({
        group_id: group.id,
        recipient: recipient.trim(),
        amount_zatoshis: Math.round(Number(amountZec) * 1e8),
        signers: Object.values(group.participants),
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

  // Auto-sync every 30s while the wallet is open (skipped if a sync is in
  // flight or after a failure, until the user manually retries).
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const statusRef = useRef(status.data);
  statusRef.current = status.data;
  const autoSyncOffRef = useRef(autoSyncOff);
  autoSyncOffRef.current = autoSyncOff;
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
                Synced to block {s.synced_height.toLocaleString()}
                {s.chain_tip_height > 0 && <> of {s.chain_tip_height.toLocaleString()}</>}
              </div>
              <button
                className="secondary"
                style={{ marginTop: 8 }}
                onClick={() => {
                  setAutoSyncOff(false);
                  sync.mutate();
                }}
                disabled={sync.isPending}
              >
                {sync.isPending ? "Syncing…" : "Sync now"}
              </button>
              <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
                Auto-syncs every 30s.
              </div>
            </div>
          </div>

          {activeSend && (
            <SendSessionPanel
              ceremony={activeSend}
              onDismiss={() => {
                clearSend(group.id);
                setDraft(null);
              }}
            />
          )}

          {!activeSend && (
          <>
          <h3 style={{ marginTop: 18 }}>Send</h3>
          <label>Recipient unified address</label>
          <input
            type="text"
            placeholder="utest1… (testnet) / u1… (mainnet)"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
          />
          <label>Amount (ZEC)</label>
          <input
            type="text"
            placeholder="0.001"
            value={amountZec}
            onChange={(e) => setAmountZec(e.target.value)}
          />
          <button
            onClick={() => prepare.mutate()}
            disabled={prepare.isPending || !recipient.trim() || !(Number(amountZec) > 0)}
          >
            {prepare.isPending ? "Building…" : "Prepare draft transaction"}
          </button>
          {draft && (
            <div
              className="card"
              style={{ marginTop: 12, background: "var(--bg-elevated)" }}
            >
              <h3 style={{ marginTop: 0 }}>Prepared transaction</h3>
              <table className="participants">
                <tbody>
                  <tr>
                    <td>Receiver</td>
                    <td className="dim mono-cell">{draft.recipient}</td>
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
              <p className="dim" style={{ marginTop: 8 }}>
                Review the details above, then start a signing session with the
                group.
              </p>
              <button onClick={() => send.mutate()} disabled={send.isPending}>
                {send.isPending ? "Starting…" : "Sign transaction with the group"}
              </button>
            </div>
          )}
          <p className="dim" style={{ marginTop: 8 }}>
            Building a draft constructs the transaction and computes what the
            group needs to sign — it does not move funds or broadcast yet.
          </p>
          </>
          )}
          <SendHistory groupId={group.id} />
        </>
      )}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

/** Persisted log of past sends for a group: each signing session and its
 *  outcome (broadcast txid or failure), newest first. */
function SendHistory({ groupId }: { groupId: string }) {
  const history = useCeremonies((s) => selectSendHistory(s, groupId));
  const activeId = useCeremonies((s) => s.activeSendByGroup[groupId]);
  // The in-progress send shows in its own panel above; history is the rest.
  const past = history.filter((h) => h.id !== activeId);
  if (past.length === 0) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <h3>Transaction history</h3>
      <table className="participants">
        <tbody>
          {past.slice(0, 20).map((h) => (
            <tr key={h.id}>
              <td style={{ whiteSpace: "nowrap" }}>
                {h.startedAt
                  ? new Date(h.startedAt).toLocaleString(undefined, {
                      dateStyle: "short",
                      timeStyle: "short",
                    })
                  : "—"}
              </td>
              <td>{h.send ? `${zec(h.send.amountZatoshis)} ZEC` : "—"}</td>
              <td className="dim mono-cell" style={{ maxWidth: 220 }}>
                {h.send?.recipient ?? ""}
              </td>
              <td style={{ whiteSpace: "nowrap" }}>
                {h.failed ? (
                  <span style={{ color: "var(--danger)" }}>Failed</span>
                ) : h.done && h.txid ? (
                  <span title={h.txid} style={{ color: "#4ade80" }}>
                    Sent · {h.txid.slice(0, 10)}…
                  </span>
                ) : h.done ? (
                  <span style={{ color: "#4ade80" }}>Sent</span>
                ) : (
                  <span className="dim">In progress</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
  ceremony,
  onDismiss,
}: {
  ceremony: CeremonyState;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const meta = ceremony.send;
  const currentIdx = SEND_PHASES.findIndex((p) => p.key === ceremony.phase);
  const failed = ceremony.failed;
  const done = ceremony.done && !failed;

  return (
    <div className="card" style={{ marginTop: 18, background: "var(--bg-elevated)" }}>
      <h3 style={{ marginTop: 0 }}>Signing session</h3>
      {meta && (
        <table className="participants">
          <tbody>
            <tr>
              <td>Sending</td>
              <td>{zec(meta.amountZatoshis)} ZEC</td>
            </tr>
            <tr>
              <td>To</td>
              <td className="dim mono-cell">{meta.recipient}</td>
            </tr>
            <tr>
              <td>Fee</td>
              <td>{zec(meta.feeZatoshis)} ZEC</td>
            </tr>
          </tbody>
        </table>
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

      <button className="secondary" style={{ marginTop: 12 }} onClick={onDismiss}>
        {done || failed ? "Done — start a new transaction" : "Dismiss (build a new one)"}
      </button>
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
        <h2 style={{ marginBottom: 0 }}>{group.description || "(unnamed group)"} — Wallet</h2>
        <Link to={`/groups/${group.id}`} className="dim">
          ← Group details
        </Link>
      </div>
      <div className="card">
        <GroupWallet group={group} />
      </div>
      <GroupHistory group={group} />
    </div>
  );
}

/** Transaction + message history for a group's wallet.
 *  Scaffold: zcash_client_backend 0.23 has no clean tx-history read API, so the
 *  populated view is tracked in TODO.md (direct wallet-db queries). */
function GroupHistory({ group }: { group: GroupSummary }) {
  void group;
  return (
    <>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Transaction history</h3>
        <p className="dim">
          Sends and receives for this group will appear here once history
          indexing lands. For now, balance reflects synced funds above.
        </p>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Message history</h3>
        <p className="dim">
          Memos attached to received and sent notes will appear here.
        </p>
      </div>
    </>
  );
}
