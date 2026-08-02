# Sync optimization — design & roadmap

Status: **in progress** (branch `feat/sync-optimizations`). This is the next
major targeted update. Its goal is to cut the wall-clock latency of wallet
sync — especially the recovery / large-range case — without leaving the
Ironwood-capable `zcash_client_backend` (ECC) stack.

## Why we stay on the ECC stack

We surveyed the open-source Zcash wallets (YWallet/ZKool, Zingo, Cake, ZODL,
Vizor). All but ZODL are light wallets on lightwalletd compact blocks; the
differentiation is entirely in the scan engine.

- **YWallet/ZKool** use **Warp Sync** — the fastest engine — but it is
  Sapling/Orchard-oriented, keeps its own DB schema, and **has no Ironwood
  support**. Adopting it wholesale would fork us off the maintained NU6.3 stack
  for a rewrite: wrong trade for a funds wallet on Ironwood.
- **ZODL** offers a full/hybrid node mode — a privacy feature, not a general
  latency win, and a large architectural add.

So we **port Warp's ideas onto our existing stack** rather than switch engines.

## What we already have (main)

- **Tip-height birthday for new wallets** — a new group starts at the chain tip,
  so it never scans pre-creation history. (The single biggest first-sync win; done.)
- **Subtree-root tree init** — `zcash_client_backend::sync::run` calls
  `update_subtree_roots` (GetSubtreeRoots), so the note-commitment tree is
  initialized without replaying all history.
- **Spend-before-sync ordering** — `run` scans `suggest_scan_ranges()` in
  priority order (ChainTip/Verify first), so the balance surfaces before a full
  catch-up finishes, and the UI polls it every ~5s.
- **Configurable batch size** — `sync_group(batch_size)`, clamped
  `[MIN,MAX]_SYNC_BATCH_SIZE`, persisted via `Settings.sync_batch_size`.

## What's missing (this update)

The upstream `sync::run` is explicit that "block batches are not downloaded in
parallel with scanning." Two levers remain, and both require driving the sync
loop ourselves instead of calling `sync::run`:

1. **Pipelining** — overlap network download with CPU trial-decryption. This is
   Warp's core advantage and the single biggest safe win left.
2. **Adaptive batch size** — grow the batch over empty ranges (cheap to scan),
   shrink over dense ranges (expensive), instead of one fixed size for the run.

A third lever is crate-gated:

3. **Parallel trial decryption** — the pinned `zcash_note_encryption` 0.4.2 does
   batch decryption single-threaded. Getting multi-core decryption needs either a
   `zcash_note_encryption` with the `multicore` feature or wiring the
   `zcash_client_backend` `sync-decryptor` (rayon) pipeline. Deferred to the next
   crate-cohort bump; tracked here so it isn't forgotten.

## Approach: a custom pipelined driver, alongside `sync::run`

Pipelining and adaptive batching both need control of the loop, so we add a
**custom driver** that faithfully reproduces the upstream `run`/`running`
control flow (subtree roots → chain tip → transparent UTXO refresh → verify pass →
historic ranges), changing only how batches are fed:

- A **producer** task downloads each batch's compact blocks into the `FsCache`
  and the chain-state anchor, then hands `(ScanRange, ChainState)` over a
  **bounded channel** (capacity 1–2) so download runs 1–2 batches ahead.
- The **consumer** (main task) receives a ready batch and runs
  `scan_cached_blocks` on it (CPU-bound), commits, and deletes the cache.
- On a **reorg / continuity error** or a newly-added higher-priority range, we
  abort the producer, flush, and restart from `suggest_scan_ranges` — exactly the
  upstream `return Ok(true)` → outer-loop behavior.

Correctness-critical logic (reorg rewind, verify ranges, transparent UTXO
refresh, subtree roots) is **ported verbatim** from the upstream `sync.rs` we
depend on; only the download/scan overlap is new.

### Safety: gated and off by default

A hand-driven sync loop touches fund detection, so it does **not** replace the
default path until validated:

- Guarded by `Settings.experimental_pipelined_sync` (default `false`).
- When off, `sync_group` calls the stock `zcash_client_backend::sync::run`
  exactly as today.
- When on, `sync_group` calls the custom `run_pipelined` driver.

This lets the new driver be **validated on testnet** (and by opt-in users) before
it becomes the default, and reverted instantly by a setting.

### Validation gate before default

Before flipping the default to the pipelined driver:

1. A testnet recovery sync (large range) produces a **byte-identical** wallet
   state to the stock driver (same balance, notes, witnesses, scanned height).
2. A reorg is exercised (or simulated) and recovers correctly.
3. A shielded send after a pipelined sync builds, signs, and broadcasts.

## Sequencing

1. **[this update] Settings gate + custom pipelined driver** (prefetch + adaptive
   batch), off by default. ← core of the work
2. **[this update] Testnet validation** against the stock driver; flip default if
   it passes.
3. **[next crate bump] Parallel trial decryption** via note-encryption
   `multicore` / the `sync-decryptor` pipeline.
4. **[optional, infra] Zaino indexer** — evaluate a Rust indexer (Zingo's path)
   in place of stock lightwalletd for richer per-request data. Composes with the
   above; not a wallet rewrite.

## Explicit non-goals

- No wholesale swap to Warp/ZKool's engine (no Ironwood support; own DB).
- No full/hybrid-node mode (privacy feature, not latency; large surface).
