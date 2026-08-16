# UAT — pipelined sync (now the standard driver)

Acceptance checklist for the pipelined sync driver (`feat/sync-optimizations`).
Run on **testnet** first.

> **Note:** the pipelined driver is now the **standard, only** sync path — there
> is no `experimental_pipelined_sync` toggle anymore, and the stock
> `sync::run` path was removed. Sections **A0a** and **A** (the on/off
> checkbox test and the stock-driver baseline) are therefore **historical** — you
> can no longer switch to the stock driver in-app to compare. If you still want an
> equality baseline, capture it from an older build; otherwise start at **B** and
> validate the single driver's correctness, speed, incremental behavior,
> cancellation, and post-sync send.

See `docs/SYNC_OPTIMIZATION.md` for the design.

## Setup

- [ ] Build the current branch: `npm run tauri build` (or `cargo build` for a dev
      backend), and launch the freshly built binary — not a previously installed
      bundle.
- [ ] Use a **testnet** group with a known, non-trivial history (funded a few
      times, at least one send), so scanning actually finds notes.

## A0a. The toggle itself (checkbox wiring) — HISTORICAL

- [ ] *(No longer applies — the toggle was removed and pipelined is the only path.)*

## A. Baseline with the stock driver (control) — HISTORICAL

- [ ] *(No longer runnable in-app — the stock driver was removed. Kept for
      reference; use an older build if you need a stock baseline to compare.)*

## B. Pipelined driver — clean-state correctness (the core test)

- [ ] Delete the wallet db (force a full rescan from birthday) and sync to the tip.
- [ ] **Balance is correct** — total (Ironwood), plus any legacy Orchard, matches
      the group's known funds and what block explorers show.
- [ ] Received-note count is correct.
- [ ] Transaction history is complete (txids, amounts, memos).
- [ ] Scanned-to height reaches the chain tip.
- [ ] Wall-clock sync time is reasonable (faster on a high-latency link is the
      whole point). If you kept a stock baseline from an older build, it should be
      **≤** that.

## C. Incremental sync

- [ ] With the pipelined wallet already at the tip, wait for / cause a new inbound
      testnet payment, then "Sync Now".
- [ ] Only the new blocks are scanned (fast), the new note appears, and the balance
      increases by the expected amount.
- [ ] Sync a second time with no new activity → completes quickly, balance
      unchanged (no double-count, no drift).

## D. Cancellation / resume

- [ ] Start a full rescan (delete db) with the pipelined driver, then hit "Sync
      Now" (or switch away) mid-sync to cancel it.
- [ ] App stays responsive; no panic; no error toast beyond an expected
      "cancelled".
- [ ] Start sync again → it resumes and completes, ending at the same
      balance/height as B (cancellation left the db consistent at a batch
      boundary, not corrupted).

## E. Reorg tolerance (best-effort)

- [ ] If a testnet reorg happens to occur during a sync, confirm it recovers: the
      log shows a "chain reorg detected … rewinding" line and the sync finishes at
      the correct tip with the correct balance. (Hard to force on demand; watch for
      it opportunistically during A–D.)

## F. Send after a pipelined sync (funds path)

- [ ] After a pipelined sync, build + FROST-sign + broadcast a small testnet send.
- [ ] Transaction is accepted by the node (no branch-id / MissingSpendAuthSig /
      note-selection errors).
- [ ] After it confirms, a re-sync shows the spend and the reduced balance
      correctly.

## G. Regression — HISTORICAL

- [ ] *(No longer applies — there is no flag to turn off; the pipelined driver is
      the only path.)*

## Sign-off

- [ ] B balances/notes/history/height are correct (against known funds / an
      explorer).
- [ ] C, D, F pass on testnet.
- [ ] No panics, no stuck syncs, UI responsive throughout.

Only after this passes on testnet: repeat B/F once on **mainnet** with a small
balance before relying on it broadly.
