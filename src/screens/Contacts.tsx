import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addContact,
  exportMyContact,
  listContacts,
  removeContact,
  AppError,
  ContactDto,
} from "../ipc/commands";

export default function Contacts() {
  const queryClient = useQueryClient();
  const contacts = useQuery({ queryKey: ["contacts"], queryFn: listContacts });
  const [newContact, setNewContact] = useState("");
  const [myName, setMyName] = useState("");
  const [myContact, setMyContact] = useState<ContactDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const add = useMutation({
    mutationFn: addContact,
    onSuccess: () => {
      setNewContact("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (e) => setError((e as unknown as AppError).message),
  });

  const remove = useMutation({
    mutationFn: removeContact,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["contacts"] }),
  });

  return (
    <div>
      <h2>Contacts</h2>

      <div className="card">
        <h3>Share your contact</h3>
        <p className="dim">
          Export your contact string and send it to the people you want to run
          FROST with (and import theirs below).
        </p>
        <div className="row">
          <input
            type="text"
            placeholder="Your display name"
            value={myName}
            onChange={(e) => setMyName(e.target.value)}
          />
          <button
            disabled={!myName.trim()}
            onClick={async () => setMyContact(await exportMyContact(myName.trim()))}
          >
            Export
          </button>
        </div>
        {myContact && (
          <div style={{ marginTop: 12 }}>
            <div className="mono">{myContact.text}</div>
            <div className="row" style={{ marginTop: 8 }}>
              <button
                className="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(myContact.text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Import a contact</h3>
        <textarea
          rows={3}
          placeholder="zffrost1..."
          value={newContact}
          onChange={(e) => setNewContact(e.target.value)}
        />
        {error && <div className="error">{error}</div>}
        <button
          disabled={!newContact.trim() || add.isPending}
          onClick={() => add.mutate(newContact.trim())}
        >
          Import
        </button>
      </div>

      <div className="card">
        <h3>Address book</h3>
        {contacts.data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Public key</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {contacts.data.map((c) => (
                <tr key={c.pubkey}>
                  <td>{c.name}</td>
                  <td className="dim" style={{ fontFamily: "monospace", fontSize: 12 }}>
                    {c.pubkey.slice(0, 16)}…
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button className="danger" onClick={() => remove.mutate(c.pubkey)}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="dim">No contacts yet.</p>
        )}
      </div>
    </div>
  );
}
