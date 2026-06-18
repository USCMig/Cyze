import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  getIdentity,
  listContacts,
  listGroups,
  removeGroup,
  ContactDto,
  GroupSummary,
  Identity,
} from "../ipc/commands";
import { resolveParticipant } from "../lib/participants";

/** Guided, accurate explanation of FROST's repairable-share recovery, shown in
 *  the group flow so a member knows what to do if they lose their share. */
function ShareRepairGuide({ group }: { group: GroupSummary }) {
  const [open, setOpen] = useState(false);
  const t = group.threshold;
  const n = group.num_participants;

  return (
    <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <button className="secondary" onClick={() => setOpen((o) => !o)}>
        {open ? "Hide" : "Recovery & share repair"}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div className="callout">
            <span>
              Because this is a <strong>{t}-of-{n}</strong> group, a lost or
              corrupted share is not fatal. Any <strong>{t}</strong> of the
              other members can help you regenerate <em>your</em> share — without
              ever revealing it and without anyone reconstructing the full group
              key. This is FROST's <em>repairable threshold</em> scheme.
            </span>
          </div>

          <h3 style={{ marginTop: 16 }}>How your recovery options fit together</h3>
          <ul className="step-body" style={{ marginTop: 4, paddingLeft: 18 }}>
            <li>
              <strong>Forgot your passphrase</strong> but still have this device:
              use your 12-word <Link to="/">recovery code</Link> to set a new one.
            </li>
            <li>
              <strong>Device failure</strong>, but you kept an encrypted keystore
              backup: restore the backup and unlock as normal.
            </li>
            <li>
              <strong>Lost the share entirely</strong> (no device, no backup):
              repair it with help from the group, using the steps below.
            </li>
          </ul>

          <h3 style={{ marginTop: 16 }}>Before you start</h3>
          <div className="callout">
            <span>
              You'll need: a working install of this app holding this group's
              public data (already stored here), at least <strong>{t}</strong>{" "}
              other participants online and willing to help, and agreement on the
              identifier of the member being repaired.
            </span>
          </div>

          <h3 style={{ marginTop: 16 }}>The repair, step by step</h3>
          <ol className="steps">
            <li>
              <div className="step-title">Choose your helpers</div>
              <div className="step-body">
                Pick any {t} participants who still have their shares. They are
                the “helpers.” Fewer than {t} cannot repair a share — that is the
                security threshold working as intended.
              </div>
            </li>
            <li>
              <div className="step-title">Round 1 — helpers compute repair deltas</div>
              <div className="step-body">
                Each helper uses their own share to compute a random blinding
                value (a “delta”) for every other helper and sends it to them over
                an encrypted channel. No delta reveals anything about a share.
              </div>
            </li>
            <li>
              <div className="step-title">Round 2 — helpers combine into a “sigma”</div>
              <div className="step-body">
                Each helper sums the deltas they received into a single value
                (their “sigma”) and sends it privately to you, the member being
                repaired.
              </div>
            </li>
            <li>
              <div className="step-title">Round 3 — you reconstruct your share</div>
              <div className="step-body">
                Your device combines the {t} sigmas with your identifier and the
                group's public commitments to rebuild your secret share and key
                package — entirely locally.
              </div>
            </li>
            <li>
              <div className="step-title">Verify</div>
              <div className="step-body">
                Run a <Link to="/sign">test signing session</Link> with the group
                to confirm your repaired share produces valid signatures.
              </div>
            </li>
          </ol>

          <div className="callout warn" style={{ marginTop: 14 }}>
            <span>
              <strong>Privacy guarantee:</strong> at no point does any helper
              learn your share, and the full group secret is never reconstructed.
              Helpers only ever exchange random blinding values.
            </span>
          </div>

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

function GroupCard({
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
      <label>Group verifying key</label>
      <div className="mono">{group.id}</div>
      <div style={{ marginTop: 10 }}>
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

export default function Groups() {
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ["groups"], queryFn: listGroups });
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: listContacts });
  const identity = useQuery({ queryKey: ["identity"], queryFn: getIdentity });
  const remove = useMutation({
    mutationFn: removeGroup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["groups"] }),
  });

  return (
    <div>
      <h2>Groups</h2>
      <p className="dim">
        Threshold signing groups this keystore holds a share for. Each group
        includes recovery instructions in case a share is ever lost.
      </p>
      {groups.data?.length ? (
        groups.data.map((g) => (
          <GroupCard
            key={g.id}
            group={g}
            identity={identity.data}
            contacts={contacts.data}
            onRemove={(id) => remove.mutate(id)}
          />
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
