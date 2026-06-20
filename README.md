# CYZE - Coordinate Your ZCash Easily
**A FROST signing companion for Zcash** ❄️

A desktop GUI for [ZF FROST](https://frost.zfnd.org/) threshold signatures,
built on the Zcash Foundation's [frost-tools](https://github.com/ZcashFoundation/frost-tools)
(`frost-client` as a library, `frostd` as a bundled sidecar server).

Replaces CLI workflows for:

- **Key ceremonies (DKG)** — create or join a distributed key generation
  ceremony; no party ever holds the full private key.
- **Signing sessions** — coordinate a threshold signing session (the
  coordinator can also be a signer), or participate via an inbox with an
  explicit review/approve step before your signature share is produced.
- **Server hosting** — run `frostd` embedded (auto-generated self-signed TLS
  with a shareable certificate), expose it to off-LAN peers through a built-in
  **Cloudflare tunnel** (a public HTTPS URL, no port-forwarding), or point at
  any external frostd URL:port.
- **Groups** — per-group view with public key material (the Orchard spend
  validating key for RedPallas), named participants, and share-repair guidance.

Supports both ciphersuites used by frost-tools: **Ed25519** and
**RedPallas** (re-randomized FROST, Zcash Orchard spend authorization).

## Security model

- Key shares and contacts live in an envelope-encrypted keystore: a random
  data key (XChaCha20-Poly1305) is wrapped under both your passphrase and a
  one-time **12-word BIP-39 recovery code** (Argon2id), so either can unlock
  and changing one doesn't invalidate the other. The plaintext is
  byte-compatible with upstream `~/.config/frost/credentials.toml`, so you can
  import an existing frost-client config in one step.
- The recovery code is shown once at setup behind an explicit acknowledgement,
  and is never stored — it's your only way back in if you forget the passphrase.
- All ceremony messages are end-to-end encrypted (Noise, via frost-client);
  frostd is an untrusted relay.
- Self-signed server certificates are pinned explicitly (TOFU import with
  fingerprint display) — never blanket-accepted. A Cloudflare tunnel presents
  a publicly valid certificate, so peers using its URL skip cert trust.
- Participants see the exact message (hex + UTF-8) and must approve before
  the round-2 signature share is computed. Round-1 commitments are
  message-independent, so nothing is at risk before approval.

## Building

Prerequisites:

- Rust (1.92+), Node 18+
- Tauri Linux system deps:
  `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev librsvg2-dev libayatana-appindicator3-dev build-essential`
- Optional: [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  on your PATH, for the public-tunnel feature.

On first launch you set a passphrase and a display name, and are shown a
one-time recovery code to back up. Windows builds run natively (MSVC + Node)
or via WSL2; build a Windows `frostd` sidecar and target `nsis`/`msi`.

```sh
npm install
./scripts/build-sidecar.sh   # builds frostd at the pinned rev (scripts/PINNED_REV)
npm run tauri dev            # development
npm run tauri build          # AppImage/deb
```

To run two instances on one machine (e.g. to play coordinator and
participant), give the second instance its own data dir:

```sh
FROST_APP_DATA_DIR=/tmp/frost-app-2 npm run tauri dev
```

## Tests

The core crate is Tauri-free and fully testable headlessly:

```sh
cd src-tauri && cargo test -p frost-app-core
```

`tests/ceremony_e2e.rs` spawns a real frostd (the sidecar binary) and runs
complete 3-party DKG + 2-of-3 signing ceremonies over TLS for both
ciphersuites, plus a rejection path; keystore tests cover the envelope format
and recovery code. A headless smoke test drives the full Tauri command layer
(`cargo test -p frost-app --test smoke`).

## Layout

- `src-tauri/core` — `frost-app-core`: keystore, frostd transport (pinned-cert
  TLS), DKG/signing ceremony engines. No Tauri dependency.
- `src-tauri/src` — Tauri adapter: commands, event forwarding, sidecar
  lifecycle.
- `src/` — React + TypeScript frontend.
- `scripts/PINNED_REV` — the frost-tools revision used for both the
  `frost-client` library dependency and the `frostd` sidecar build (they must
  match for wire compatibility).

## Roadmap

Transaction building (PCZT-based, for Zcash) is planned as a later phase —
the signing layer signs arbitrary bytes, so a tx builder plugs in by
supplying sighashes as the message.
