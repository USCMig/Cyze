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
