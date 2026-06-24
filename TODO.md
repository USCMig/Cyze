# Cyze — tracked follow-ups

## Wallet (Zcash)

- [ ] **Auto-sync polish** — auto-sync runs every 30s (see `GroupWallet` in
      `src/screens/Groups.tsx`). Once proven reliable on testnet/mainnet,
      **remove the manual "Sync now" button** and surface a subtle
      syncing/last-synced indicator instead.
- [x] **Send history (client-side)** — the "Transaction history" panel
      (`SendHistory` in `src/screens/Groups.tsx`) now lists this device's past
      send ceremonies from the persisted store (time, amount, recipient, status
      + txid). Survives reload.
- [ ] **On-chain transaction history** — the client-side log only covers sends
      *initiated on this device*; it misses received funds and sends made
      elsewhere with the same UFVK. For a complete ledger, add direct wallet-db
      (sqlite) queries over `transactions`/`sent_notes`/`received_notes` in
      `core/src/wallet.rs` (a new `wallet_history` command): txid, direction,
      net value, height/time, status. Merge with the client-side log.
- [ ] **Message history** — memos from received and sent notes, surfaced in the
      "Message history" panel. Comes from the same wallet-db query work.

## Send path (Phase 5.2, in progress)

- [x] 5.2a — build draft Orchard tx (PCZT) + sighash (no funds moved).
- [x] 5.2b — FROST-sign the sighash with `randomizer = α` and
      `apply_orchard_signature` into the PCZT (drive the existing ceremony).
- [x] 5.2c — Orchard proof → `SpendFinalizer` → `TransactionExtractor` →
      lightwalletd `send_transaction` (`wallet::broadcast_signed`). Emits the
      `proving` phase + final txid. **Needs a live testnet end-to-end run** to
      confirm the proof/finalize/extract/broadcast leg (compile-verified only).
- [ ] **Multi-spend sends** — `wallet_send` currently requires exactly one
      Orchard spend (one α / one ceremony). Support N spends: one re-randomized
      ceremony per spend (or batch), then apply all signatures before proving.
- [ ] **Signer selection** — `wallet_send` signs with *all* group members;
      add a threshold-subset picker (reuse `NewSigningSession`'s selector).
- [ ] **Longer expiry window** — `prepare_send` now anchors the tx expiry to the
      live chain tip, but `propose_standard_transfer_to_address` bakes in the
      default ~40-block delta (≈50 min on testnet). A slow multi-party ceremony
      can still exceed it. `zcash_client_backend` exposes no expiry knob and the
      pczt `Updater` has no `set_expiry_height`, so a longer/zero expiry needs
      either an upstream API or writing the PCZT global directly. NB: bumping the
      wallet's chain tip past reality is NOT a workaround — it makes `sync::run`
      try to fetch non-existent blocks and fail.
