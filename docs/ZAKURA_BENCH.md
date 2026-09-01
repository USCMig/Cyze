# Zakura crypto-stack sync benchmark

Cyze's `feat/zakura-stack` branch swaps the Zcash crypto + wallet crates to the
[Zakura](https://github.com/zakura-core) forks. The **only** thing that changed
between the old and new dependency sets is the crypto stack — block download is
byte-identical (same `tonic`/lightwalletd path). So "does Zakura speed up sync?"
reduces to "does the new stack trial-decrypt compact blocks faster?", which
Orchard's own `note_decryption` benchmark measures directly, with no network.

Reproduce: `scripts/bench-crypto-stack.sh`

## Method

- **Baseline:** upstream `orchard 0.15.5` (the crates.io wave Cyze used before).
- **New:** `zakura-orchard 1.0.0` (from `zakura-core/common` @ `v1.0.0`).
- Both ship the identical `benches/note_decryption.rs` (only import-order and
  test-setup RNG cosmetics differ), so the comparison is apples-to-apples.
- Criterion, run **sequentially** (no CPU contention), `--measurement-time 6
  --sample-size 15`, single WSL2 host.

## Results (median)

Batch decryption — what real sync does:

| Benchmark | orchard 0.15.5 | zakura 1.0.0 | speedup |
|---|--:|--:|--:|
| `compact-invalid/50`  *(sync-dominant)* | 6.79 ms | 4.62 ms | **1.47×** |
| `compact-invalid/100` *(sync-dominant)* | 10.87 ms | 8.72 ms | **1.25×** |
| `compact-valid/50` | 95.4 ms | 39.2 ms | **2.43×** |
| `compact-valid/100` | 148.5 ms | 79.1 ms | **1.88×** |
| `valid/10` | 20.0 ms | 8.0 ms | **2.51×** |
| `valid/100` | 131.2 ms | 115.9 ms | 1.13× |
| `invalid/100` | 11.3 ms | 9.33 ms | 1.21× |

Single-note micro-cases (µs-scale, noisy, **not** sync-representative): mixed —
`valid` ~1.8× faster; `invalid` measured slower, within measurement noise at that
scale. Sync decrypts in batches, so the batch rows are the signal.

## Interpretation

`zakura-orchard` decrypts compact blocks **~1.25–1.5× faster on the
sync-dominant path** (`compact-invalid` — notes that aren't yours, the bulk of
scanning) and up to **~2× when notes are yours**. Likely the `ff 0.14` /
`group 0.14` / newer-halo2 arithmetic in the Zakura cohort. Zakura publishes no
benchmark claims; this is an independent measurement.

### Caveats

1. **CPU/decryption leg only.** Download is identical between stacks. Whether
   this moves end-to-end wall-clock depends on whether a given sync is
   scan-bound or download-bound — read the per-batch throughput line the app
   logs (`pipelined scan: … blocks/s`, `wallet.rs`) to tell which. Scan-bound
   syncs should see ~1.3–2×; download-bound syncs won't move.
2. Single host, single run, short criterion timing. Trust the **direction**;
   treat exact multipliers as ±15%.
3. Orchard crate in isolation, not the full app loop (which also does
   note-commitment-tree updates + SQLCipher writes per batch).
