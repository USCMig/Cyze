# UAT — experimental pipelined sync

Acceptance checklist for the pipelined sync driver (`feat/sync-optimizations`).
Goal: prove the pipelined path produces the **same wallet state** as the stock
driver, only faster. Run on **testnet** first. Off by default; opt in per below.

See `docs/SYNC_OPTIMIZATION.md` for the design and the formal validation gate.

## Setup

- [ ] Build the current branch: `npm run tauri build` (or `cargo build` for a dev
      backend), and launch the freshly built binary — not a previously installed
      bundle.
- [ ] Use a **testnet** group with a known, non-trivial history (funded a few
      times, at least one send), so scanning actually finds notes.
- [ ] Know how to toggle the flag. Primary: **Zcash → Wallet Settings → Sync →
      "Experimental pipelined sync"** checkbox (persists immediately; takes effect
      on the next sync). It still maps to `settings.json`
      (`<data_dir>/settings.json`) `"experimental_pipelined_sync": true|false`,
      which you can edit directly if preferred. Default/absent = stock driver.

## A0a. The toggle itself (checkbox wiring)

- [ ] Wallet Settings shows a **Sync** card with the checkbox, **unchecked** by
      default on a fresh profile.
- [ ] Check it → reopen Wallet Settings (or another screen and back) → it stays
      checked (persisted). Confirm `settings.json` now has
      `"experimental_pipelined_sync": true`.
- [ ] Uncheck it → the value flips back to `false`. No restart needed either way.

## A. Baseline with the stock driver (control)

- [ ] Ensure the checkbox is **unchecked** (`experimental_pipelined_sync` `false`/absent).
- [ ] Delete the group's wallet db (force a full rescan from birthday) and sync to
      the tip. Time it roughly (wall clock).
- [ ] Record, from the group screen / notes:
  - [ ] Total balance, and the Orchard vs Ironwood breakdown.
  - [ ] Number of received notes.
  - [ ] Transaction history (count + amounts).
  - [ ] Scanned-to height (matches chain tip).

## B. Pipelined driver — clean-state equality (the core test)

- [ ] **Check** the pipelined-sync box (or set `experimental_pipelined_sync` to `true`).
- [ ] Delete the wallet db again (same starting point as A) and sync to the tip.
- [ ] Confirm the log shows **"using experimental pipelined sync driver"** (proves
      the flag took effect, not a silent fallback).
- [ ] **Balance is byte-identical to A** — total, Orchard, and Ironwood all match
      exactly.
- [ ] Received-note count matches A.
- [ ] Transaction history matches A (same txids, amounts, memos).
- [ ] Scanned-to height reaches the chain tip.
- [ ] Wall-clock sync time is **≤ A** (the point of the change; expect faster on a
      high-latency link, roughly equal on a fast LAN).

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

## G. Regression — flag off still works

- [ ] **Uncheck** the box (`experimental_pipelined_sync` back to `false`), sync once,
      and confirm the stock path still works normally (guards against the dispatch wiring breaking
      the default path).

## Sign-off

- [ ] A vs B balances/notes/history/height are identical.
- [ ] C, D, F pass on testnet.
- [ ] No panics, no stuck syncs, UI responsive throughout.

Only after this passes on testnet: consider flipping the default and/or repeating
A/B/F once on **mainnet** with a small balance before recommending it broadly.
