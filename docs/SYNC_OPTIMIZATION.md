# Sync optimization — design & roadmap

Status: **driver implemented, pending testnet validation** (branch
`feat/sync-optimizations`). The pipelined driver is built and off by default; it
becomes the default only after the validation gate below passes. This is the next
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
   Warp's core advantage and the single biggest safe win left. **Implemented**
   on this branch (`run_pipelined` in `wallet.rs`); off by default, opt-in via
   `Settings.experimental_pipelined_sync` — see the status note below.
2. **Adaptive batch size** — grow the batch over empty ranges (cheap to scan),
   shrink over dense ranges (expensive), instead of one fixed size for the run.
   **Deliberately deferred**: the pipelined driver keeps the *same* fixed batch
   units as the stock driver so its output is byte-identical and the validation
   gate below is a clean equality check. Adaptive sizing changes the scan units,
   so it lands as a separate follow-up once pipelining is validated and default.

A third lever is crate-gated:

3. **Parallel trial decryption** — the pinned `zcash_note_encryption` 0.4.2 does
   batch decryption single-threaded. Getting multi-core decryption needs either a
   `zcash_note_encryption` with the `multicore` feature or wiring the
   `zcash_client_backend` `sync-decryptor` (rayon) pipeline. Deferred to the next
   crate-cohort bump; tracked here so it isn't forgotten.

## Approach: a custom pipelined driver, alongside `sync::run`

Pipelining needs control of the loop, so we add a **custom driver**
(`run_pipelined` / `running_pipelined` in `wallet.rs`) that faithfully reproduces
the upstream `run`/`running` control flow (subtree roots → chain tip → verify
pass → historic ranges), changing only how batches are fed:

- A **producer** task downloads each batch's compact blocks **into memory** and
  the chain-state anchor, then hands `(ScanRange, Vec<CompactBlock>, ChainState)`
  over a **bounded channel** (capacity 2) so download runs up to two batches
  ahead. A cloned tonic client shares the underlying HTTP/2 connection, so this
  adds no new socket.
- The **consumer** (main task) receives a ready batch, wraps its blocks in an
  in-memory `BlockSource` (`MemBlockSource`), and runs `scan_cached_blocks` on it
  (CPU-bound). Scanning is transactional per batch via `put_blocks`, so an
  interrupted or cancelled batch leaves the db consistent at a batch boundary —
  the same guarantee the stock driver gives.
- On a **reorg / continuity error** or a newly-added higher-priority range, the
  consumer breaks, the producer is aborted, and the pass restarts from
  `suggest_scan_ranges` — exactly the upstream `return Ok(true)` → outer-loop
  behavior.

Because each batch is downloaded fresh into memory and never persisted, the
pipelined path **never touches the on-disk `FsCache`** — no file writes, no cache
mutex contended between producer and consumer, and nothing to truncate on a
reorg rewind (only the db is rewound).

**Transparent UTXO refresh is intentionally omitted.** Upstream `running` performs
it only under the `transparent-inputs` feature, which our `zcash_client_backend`
build does not enable (group accounts are Orchard-only view keys). The stock
driver we run today therefore does not perform it either, so omitting it keeps
the two byte-identical.

Correctness-critical logic (reorg rewind, verify ranges, subtree roots,
chain-tip update, batch splitting) is **ported faithfully** from the upstream
`sync.rs` we depend on; only the download/scan overlap is new. The batch splitter
(`split_scan_range`) has a unit test asserting it produces the exact same units as
the upstream step-7 splitter.

### A note on overlap and the runtime

`scan_cached_blocks` is synchronous and CPU-bound; the consumer calls it directly
on the async task. On the multi-threaded Tokio runtime the app uses, the producer
keeps downloading the next batches on other worker threads while the consumer
thread scans — which is where the latency win comes from. On a single-threaded
runtime the code is still correct (no overlap, identical result). Moving the scan
onto `spawn_blocking` to guarantee overlap regardless of runtime is a possible
future refinement; it is not needed for correctness.

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

1. **[done] Settings gate + custom pipelined driver** (prefetch download while
   scanning), off by default. ← core of the work; `run_pipelined` in `wallet.rs`.
2. **[next] Testnet validation** against the stock driver; flip default if it
   passes (see the validation gate above).
3. **[follow-up] Adaptive batch size** — grow/shrink the batch by range density,
   once pipelining is the validated default.
4. **[next crate bump] Parallel trial decryption** via note-encryption
   `multicore` / the `sync-decryptor` pipeline.
5. **[optional, infra] Zaino indexer** — evaluate a Rust indexer (Zingo's path)
   in place of stock lightwalletd for richer per-request data. Composes with the
   above; not a wallet rewrite.

## Explicit non-goals

- No wholesale swap to Warp/ZKool's engine (no Ironwood support; own DB).
- No full/hybrid-node mode (privacy feature, not latency; large surface).
