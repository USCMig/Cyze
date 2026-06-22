# Cyze — tracked follow-ups

## Wallet (Zcash)

- [ ] **Auto-sync polish** — auto-sync runs every 30s (see `GroupWallet` in
      `src/screens/Groups.tsx`). Once proven reliable on testnet/mainnet,
      **remove the manual "Sync now" button** and surface a subtle
      syncing/last-synced indicator instead.
- [ ] **Transaction history** — populate the "Transaction history" panel
      (`GroupHistory` in `src/screens/Groups.tsx`). `zcash_client_backend 0.23`
      `WalletRead` has no clean tx-list API, so this needs direct wallet-db
      (sqlite) queries over the `transactions`/`sent_notes`/`received_notes`
      tables in `core/src/wallet.rs` (a new `wallet_history` command). Show
      txid, direction, net value, height/time, status.
- [ ] **Message history** — memos from received and sent notes, surfaced in the
      "Message history" panel. Comes from the same wallet-db query work.

## Send path (Phase 5.2, in progress)

- [x] 5.2a — build draft Orchard tx (PCZT) + sighash (no funds moved).
- [ ] 5.2b — FROST-sign the sighash with `randomizer = α` and
      `apply_orchard_signature` into the PCZT (drive the existing ceremony).
- [ ] 5.2c — Orchard proof → `SpendFinalizer` → `TransactionExtractor` →
      lightwalletd `send_transaction`.
