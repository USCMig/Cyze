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
  AppError,
  ContactDto,
  GroupSummary,
  Identity,
} from "../ipc/commands";
import { resolveParticipant } from "../lib/participants";

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
          <div className="row" style={{ gap: 28, marginBottom: 6 }}>
            <div>
              <label>Total</label>
              <div style={{ fontSize: 18 }}>{zec(s.total_zatoshis)} ZEC</div>
            </div>
            <div>
              <label>Spendable</label>
              <div style={{ fontSize: 18 }}>{zec(s.spendable_zatoshis)} ZEC</div>
            </div>
          </div>
          <p className="dim">
            Synced to block {s.synced_height.toLocaleString()}
            {s.chain_tip_height > 0 && <> of {s.chain_tip_height.toLocaleString()}</>}.
            Balance updates after syncing (compact-block sync lands next).
          </p>
        </>
      )}
      {err && <div className="error">{err}</div>}
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

      <GroupWallet group={group} />

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
        <Link to="/sign" className="dim">
          Start a signing session →
        </Link>
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
