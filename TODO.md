# Cyze — tracked follow-ups

## Planned for a future iteration

Larger pieces from external user testing. All are additive — nothing in the
current build depends on them.

- [ ] **ZcashNames (ZNS) integration** — human-readable names for FROST
      groups/wallets (e.g. `treasury.zcash` → the group's shielded receive
      address). Repo: https://github.com/zcashme/zcashnames

      How ZNS works: names are claimed/updated **on-chain via Ed25519-signed
      memos** (`ZNS:CLAIM:<name>:<ua>:<sig>[:<pubkey>]` in an Orchard note), and a
      **ZNS indexer** scans the chain and exposes a JSON-RPC API for resolution —
      so a wallet resolves by querying the indexer, not by scanning itself.

      - **Resolve (read) — DONE (this branch).** `name.zcash` in the Send recipient
        field resolves via the public indexer's JSON-RPC `resolve` method
        (`core/src/zns.rs` + `resolve_zns_name` command; endpoints
        `https://light.zcash.me/zns-{testnet,mainnet-test}`). The resolved address
        is shown for the user to confirm before sending, with a warning when the
        name is listed for sale. Remaining read follow-ups: accept names in
        **contact entries** too, and add a small resolver **cache**.

      - **Register/claim (write) — TODO, higher effort.** Let a group publish a
        name for its receive address. Threshold-authorised on-chain action that
        fits Cyze's FROST send + memo path: build the `ZNS:CLAIM:…` memo with an
        Ed25519 signature over the claim, sign the transaction with the group, and
        send it to the indexer's admin/registration address. Open questions: where
        the claim's Ed25519 key lives (per-group, in the keystore?), the exact
        pricing/fee tiers (indexer `status` method), and who may initiate a
        (re)claim. Note ownership is **sovereign** — once claimed with a key, all
        later actions on the name must be signed by that same key.

- [ ] **User avatars** — let a user pick an avatar, shown next to their name
      everywhere they are referenced (contacts, group participant lists, the
      signer picker, "Signed by" in transaction history, the inbox coordinator
      line).

      Design constraints to settle first, because these surfaces are dense and an
      avatar in each one will crowd them:
      - What *are* the avatars? Options, roughly in order of least effort:
        deterministic identicons derived from the comm pubkey (no asset pipeline,
        and doubles as a **visual key fingerprint** — a signer could spot a
        swapped pubkey at a glance); a fixed set of bundled illustrations; or
        user-uploaded images (needs storage in the keystore, size limits, and
        image decoding — most work, least security value).
      - Sizing: likely a 16–20px circle inline, larger only on the contact card.
        Participant lists and the signer picker are the tightest spots; check
        those before committing to a size.
      - Avatars are **cosmetic and self-asserted** — they must never be the thing
        a user relies on to identify a signer. The comm pubkey remains the
        identity. An identicon derived *from* the pubkey is the one variant that
        strengthens rather than weakens this, which argues for it.

- [ ] **Tailscale `serve` as a fourth hosting option** — alongside Direct URL,
      Cloudflare Tunnel, and NGINX in Session Configuration.

      **Feasibility/impact (2026-08-01):** effort Med, impact Med–High, not gated
      by the testnet-send validation. Slots in as a fourth `coordinator_exposure`
      variant reusing the existing exposure plumbing + a status probe; no crypto
      change (frostd's Noise layer still authenticates end-to-end). Structural
      difference from cloudflared: **detect-and-drive a system `tailscale` CLI,
      do NOT bundle** — it needs the `tailscaled` daemon (privileged) and a
      logged-in tailnet, so the sidecar-spawn pattern doesn't apply. Read the
      stable MagicDNS hostname back via `tailscale status --json` as the saved
      server URL. Verdict: **do** — best fix for the disposable-quick-tunnel URL
      pain (stable, savable, auto-TLS, tailnet-scoped).

      Why it is attractive: `tailscale serve https / http://127.0.0.1:<port>`
      exposes the loopback frostd over the tailnet with a **stable** MagicDNS
      hostname and an automatically-provisioned, publicly-valid TLS certificate.
      That fixes the two things that hurt most about quick tunnels: the URL is
      **not disposable** (so it can be saved as a group's server and reused), and
      there is no cert-trust step. Access is also restricted to the tailnet rather
      than the whole internet, which is a strictly better default for a signing
      server. (`tailscale funnel` would expose it publicly if a participant is
      outside the tailnet.)

      Open questions:
      - Detect an existing `tailscale` binary/daemon, or bundle it? Bundling is
        heavier than `cloudflared` and the daemon needs privileges — detection
        plus a clear "install Tailscale" path is likely the right first cut.
      - Every participant must be on the tailnet (or the coordinator uses Funnel).
        That is a real constraint to surface in the UI, not bury.
      - Reuse the existing exposure plumbing: this is a new `Exposure` variant
        plus a status probe; the trust model is unchanged (frostd's Noise layer
        still authenticates end-to-end, so the transport only provides
        reachability).

## Voting (coinholder polling)

- [ ] **Automated poll source / discovery** — voting currently uses **manual
      ballot entry**: the user pastes the poll's published ballot-definition JSON
      and its reception address, answers, and casts (a shielded memo via the FROST
      send path; weight is set by the poll's off-chain balance snapshot). Replace
      the manual paste with a programmatic source once one is available:
      - Fetch active polls from a configurable **poll-source URL** (Zodl exposes a
        "custom poll sources" config; confirm the feed format), render the ballot
        automatically, and show live/closed status + results.
      - The definitive protocol design is ValarDragon/Valar's; get the poll-feed +
        registration/snapshot spec from there (or the Zodl integration docs) to
        match eligibility exactly. Keep manual entry as the fallback/offline path.
      - The casting core (`voting.rs`: memo v1 encode/validate/poll-hash,
        `prepare_vote`) is source-agnostic and already done — this is only about
        *where the ballot comes from* and surfacing results.

## Wallet (Zcash)

- [ ] **Auto-sync polish** — auto-sync runs every 10s (see `GroupWallet` in
      `src/screens/Groups.tsx`), and a manual **Sync Now** button sits in the
      sync box because auto-sync can still lag or stall. Once auto-sync is proven
      reliable in the field, reconsider whether the manual button is still needed.
- [x] **Send history (client-side)** — the "Transaction history" panel
      (`SendHistory` in `src/screens/Groups.tsx`) now lists this device's past
      send ceremonies from the persisted store (time, amount, recipient, status
      + txid). Survives reload.
- [x] **On-chain transaction history** — `wallet_history` command queries
      `orchard_received_notes` (is_change=0) and `sent_notes` directly from the
      wallet sqlite, returning `TxRecord[]` (txid, direction, amount, fee, memo,
      recipient). Rendered in the expandable `GroupHistory` table on the wallet
      page. Refreshes after each sync cycle. Capped at 50 rows displayed.
- [x] **Message history** — memos decoded from `orchard_received_notes.memo`
      and `sent_notes.memo` (0xF6 empty-sentinel + null-padding stripped).
      Rendered in the "Message history" panel below the tx table, filtered to
      entries with non-null memos. Capped at 30 rows.

## Send path (Phase 5.2, in progress)

- [x] 5.2a — build draft Orchard tx (PCZT) + sighash (no funds moved).
- [x] 5.2b — FROST-sign the sighash with `randomizer = α` and
      `apply_orchard_signature` into the PCZT (drive the existing ceremony).
- [x] 5.2c — Orchard proof → `SpendFinalizer` → `TransactionExtractor` →
      lightwalletd `send_transaction` (`wallet::broadcast_signed`). Emits the
      `proving` phase + final txid. **Needs a live testnet end-to-end run** to
      confirm the proof/finalize/extract/broadcast leg (compile-verified only).
- [x] **Multi-spend sends** — `wallet_send` now runs one re-randomized ceremony
      per Orchard spend (each over the shared sighash with that spend's α),
      sequentially, then applies all signatures before proving + broadcasting.
      The UI shows "Signing input i of N". NB: signers approve N times (one
      inbox session per input). Sequential keeps it within the expiry window for
      small N; parallelizing the ceremonies is a future optimization if needed.
- [x] **Signer selection** — the send form now has a threshold-subset signer
      picker (`GroupWallet` in `src/screens/Groups.tsx`), pre-seeded with this
      device's member; the Sign button is gated on `>= threshold`. The chosen
      pubkeys flow through `wallet_send` unchanged (backend already accepted an
      arbitrary signer list).
- [ ] **Longer expiry window** — `prepare_send` now anchors the tx expiry to the
      live chain tip, but `propose_standard_transfer_to_address` bakes in the
      default ~40-block delta (≈50 min on testnet). A slow multi-party ceremony
      can still exceed it. `zcash_client_backend` exposes no expiry knob and the
      pczt `Updater` has no `set_expiry_height`, so a longer/zero expiry needs
      either an upstream API or writing the PCZT global directly. NB: bumping the
      wallet's chain tip past reality is NOT a workaround — it makes `sync::run`
      try to fetch non-existent blocks and fail.
