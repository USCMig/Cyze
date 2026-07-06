# Building & Releasing Cyze

Cyze packages as a native desktop app via [Tauri](https://tauri.app). This
document covers producing installable executables for Linux, macOS, and Windows,
and the (optional) code-signing needed for distribution.

## What gets produced

`bundle.targets` is `"all"`, so each platform emits its native installers:

| Platform | Artifacts |
| --- | --- |
| Linux | `.deb`, `.AppImage`, `.rpm` |
| macOS | `.app`, `.dmg` (per-arch: Apple Silicon + Intel) |
| Windows | `.msi` (WiX), `.exe` (NSIS) |

Each bundle embeds the `frostd` sidecar (the local FROST coordination server)
for that platform, so users don't install anything extra to host a session.

## The `frostd` sidecar

Tauri resolves `bundle.externalBin: ["binaries/frostd"]` to a per-target file:

```
src-tauri/binaries/frostd-<target-triple>[.exe]
```

The binary is built from the same pinned `frost-tools` revision the app links
`frost-client` against (see `frost-client`'s `rev` in `src-tauri/Cargo.toml`).
CI builds it automatically (see below). To produce it locally for your host:

```bash
REV=$(grep -oP 'frost-tools.git", rev = "\K[0-9a-f]+' src-tauri/Cargo.toml)
git clone https://github.com/ZcashFoundation/frost-tools.git /tmp/frost-tools
cd /tmp/frost-tools && git checkout "$REV"
TRIPLE=$(rustc -vV | sed -n 's/host: //p')
cargo build --release -p frostd
mkdir -p "$OLDPWD/src-tauri/binaries"
cp "target/release/frostd" "$OLDPWD/src-tauri/binaries/frostd-$TRIPLE"
```

(A checked-in `frostd-x86_64-unknown-linux-gnu` already exists for local Linux dev.)

## Local build

Prerequisites:

- **Rust** (stable) and **Node 20+**.
- A **C toolchain + Perl** — the wallet DB uses SQLCipher with *vendored* OpenSSL
  (`bundled-sqlcipher-vendored-openssl`), which compiles OpenSSL from source.
  - Windows additionally needs **NASM** on `PATH`.
- **Linux** desktop deps: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`.

Then:

```bash
npm ci
npm run tauri build          # bundles for the current OS into src-tauri/target/release/bundle/
```

## Automated cross-platform release

Pushing a version tag runs `.github/workflows/release.yml`, which builds all
four targets (Linux x64, Windows x64, macOS arm64, macOS x64), builds the
matching `frostd` sidecar for each, and attaches the installers to a **draft**
GitHub Release:

```bash
# bump version in src-tauri/tauri.conf.json + package.json first, then:
git tag v0.1.0
git push origin v0.1.0
```

Review and publish the draft release in the GitHub UI.

## Code signing (for distribution)

Unsigned builds run but trigger OS warnings (macOS Gatekeeper, Windows
SmartScreen). To ship signed builds, add these repository **secrets** — the
release workflow already wires them, and skips signing cleanly if they're unset.

### macOS (notarized)

| Secret | What it is |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of your "Developer ID Application" `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | password for that `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Org (TEAMID)` |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | app-specific password for notarization |
| `APPLE_TEAM_ID` | your Apple Developer Team ID |

### Windows (Authenticode)

Set `bundle.windows.certificateThumbprint` (+ `digestAlgorithm`, `timestampUrl`)
in `tauri.conf.json` to sign with a cert installed on the runner, or use
[Azure Trusted Signing](https://v2.tauri.app/distribute/sign/windows/). Without
this, the `.msi`/`.exe` are unsigned.

### Optional: signed auto-updates

Set `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) and add an `updater` section to
`tauri.conf.json` to enable Tauri's updater. This is worth it given the Zcash
network-upgrade cadence — it lets you push a consensus-critical update (e.g. the
NU6.3 / Ironwood crate bump) to users ahead of a mainnet activation height.

## Icons

The icon set under `src-tauri/icons/` (including `icon.ico` / `icon.icns`) is
generated from `src-tauri/app-icon.svg`:

```bash
cd src-tauri && npx tauri icon app-icon.svg
```

## Caveats / first-run notes

- The macOS and Windows jobs have not been executed from the primary dev
  environment (Linux-only here); the first CI run on those OSes may need minor
  iteration (e.g. Perl/NASM availability for vendored OpenSSL). The Linux path
  and all app config are verified.
- Building `frostd` from source on every release is slower but keeps the sidecar
  locked to the app's `frost-client` protocol revision.
- Before a **mainnet** release, see the mainnet-readiness items tracked
  separately (consensus-branch/NU cadence, participant-side sighash
  verification, passphrase/zeroization hardening).
