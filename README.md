  e88'Y88 Y88b Y8P  8P d8P 888'Y88 
 d888  'Y  Y88b Y   P d8P  888 ,'Y 
C8888       Y88b     d8P d 888C8   
 Y888  ,d    888    d8P d8 888 ",d 
  "88,d88    888   d8P d88 888,d88 
                                   
Coordinate Your ZCash Easily

**A FROST signing companion for Zcash** ❄️

A desktop GUI for [ZF FROST](https://frost.zfnd.org/) threshold signatures,
built on the Zcash Foundation's [frost-tools](https://github.com/ZcashFoundation/frost-tools)
(`frost-client` as a library, `frostd` as a bundled sidecar server).

Replaces CLI workflows for:

- **Key ceremonies (DKG)** — create or join a distributed key generation
  ceremony; no party ever holds the full private key.
- **Signing sessions** — coordinate a threshold signing session, or
  participate via an inbox with an explicit review/approve step before your
  signature share is produced.
- **Server hosting** — run `frostd` embedded (with auto-generated self-signed
  TLS and a shareable certificate) or point at any external frostd URL:port.

Supports both ciphersuites used by frost-tools: **Ed25519** and
**RedPallas** (re-randomized FROST, Zcash Orchard spend authorization).

## Security model

- Key shares and contacts live in a passphrase-encrypted keystore
  (Argon2id + XChaCha20-Poly1305). The plaintext is byte-compatible with
  upstream `~/.config/frost/credentials.toml`, so you can import an existing
  frost-client config in one step.
- All ceremony messages are end-to-end encrypted (Noise, via frost-client);
  frostd is an untrusted relay.
- Self-signed server certificates are pinned explicitly (TOFU import with
  fingerprint display) — never blanket-accepted.
- Participants see the exact message (hex + UTF-8) and must approve before
  the round-2 signature share is computed. Round-1 commitments are
  message-independent, so nothing is at risk before approval.

## Building

Prerequisites:

- Rust (1.92+), Node 18+
- Tauri Linux system deps:
  `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libdbus-1-dev librsvg2-dev libayatana-appindicator3-dev build-essential`

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
ciphersuites, plus a rejection-path test.

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
