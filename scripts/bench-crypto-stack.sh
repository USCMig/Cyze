#!/usr/bin/env bash
# Reproducible A/B benchmark of the Orchard trial-decryption hot path — the
# scan-bound leg of wallet sync — comparing the pre-Zakura baseline
# (upstream `orchard 0.15.5`) against the Zakura fork (`zakura-orchard 1.0.0`).
#
# Only the crypto stack differs between Cyze's old and new dependency sets;
# block download is byte-identical (same tonic/lightwalletd), so the sync-speed
# question reduces to "does the new stack decrypt faster?" — which orchard's own
# `note_decryption` bench measures directly, with no network.
#
# Usage: scripts/bench-crypto-stack.sh [workdir]
set -euo pipefail
WORK="${1:-$(mktemp -d)}"
MT="${MEASUREMENT_TIME:-6}"; SS="${SAMPLE_SIZE:-15}"
echo "workdir: $WORK"
cd "$WORK"
[ -d orchard-upstream ] || git clone --depth 1 --branch 0.15.5 https://github.com/zcash/orchard.git orchard-upstream
[ -d zakura-common   ] || git clone --depth 1 --branch v1.0.0   https://github.com/zakura-core/common.git zakura-common
# The upstream clone pins an old rust-toolchain; drop it so the installed
# toolchain (>=1.85) is used. Zakura needs edition 2024 (>=1.91).
rm -f orchard-upstream/rust-toolchain.toml
echo "### UPSTREAM orchard 0.15.5 ###"
( cd orchard-upstream && RUSTUP_TOOLCHAIN=stable cargo bench --bench note_decryption -- \
    --measurement-time "$MT" --sample-size "$SS" ) | tee "$WORK/clean-upstream.log"
echo "### ZAKURA zakura-orchard 1.0.0 ###"
( cd zakura-common && cargo bench -p zakura-orchard --bench note_decryption -- \
    --measurement-time "$MT" --sample-size "$SS" ) | tee "$WORK/clean-zakura.log"
echo
echo "Compare the 'batch-note-decryption/*' rows (real sync decrypts in batches)."
echo "The 'compact-invalid/*' rows dominate sync (most notes aren't yours)."
