# UAT — pipelined sync & Tailscale serve

User-acceptance checklists for the two in-flight features. Each part names the
branch it needs; until both merge to `main`, test each on its own branch build
(they don't depend on each other).

- **Part A — Pipelined sync** → branch `feat/sync-optimizations`
- **Part B — Tailscale serve** → branch `feat/tailscale-serve`

Build fresh and launch the built binary each time (`npm run tauri build`, or
`cargo build` + `npm run tauri dev`) — never a previously installed bundle.

---

# Part A — Experimental pipelined sync  (`feat/sync-optimizations`)

Goal: prove the pipelined driver produces the **same wallet state** as the stock
driver, only faster. Testnet first. Off by default; opt in via `settings.json`
(`<data_dir>/settings.json`) → `"experimental_pipelined_sync": true|false`.
Toggling takes effect on the next sync (Sync Now / relaunch). See
`docs/SYNC_OPTIMIZATION.md` for the design.

## A0. Setup
- [ ] Fresh build launched (not an installed bundle).
- [ ] A **testnet** group with real history (funded a few times, ≥1 send).
- [ ] Know how to edit `experimental_pipelined_sync` in `settings.json`.

## A1. Baseline — stock driver (control)
- [ ] `experimental_pipelined_sync` is `false`/absent.
- [ ] Delete the group's wallet db (force full rescan) and sync to tip; note the
      rough wall-clock time.
- [ ] Record: total balance + Orchard/Ironwood split; received-note count;
      transaction history (count + amounts); scanned-to height (= chain tip).

## A2. Pipelined — clean-state equality (the core test)
- [ ] Set `experimental_pipelined_sync` to `true`.
- [ ] Delete the wallet db again (same start as A1) and sync to tip.
- [ ] Log shows **"using experimental pipelined sync driver"** (not a fallback).
- [ ] Balance **byte-identical to A1** — total, Orchard, and Ironwood all match.
- [ ] Received-note count matches A1.
- [ ] Transaction history matches A1 (txids, amounts, memos).
- [ ] Scanned-to height reaches the chain tip.
- [ ] Wall-clock sync time is **≤ A1** (bigger win on a high-latency link).

## A3. Incremental sync
- [ ] From tip, receive a new testnet payment, then Sync Now → only new blocks
      scanned, new note appears, balance rises by the expected amount.
- [ ] Sync again with no activity → quick, balance unchanged (no drift/double-count).

## A4. Cancellation / resume
- [ ] Start a full rescan (delete db), then cancel mid-sync (Sync Now / navigate away).
- [ ] App stays responsive; no panic; at most an expected "cancelled".
- [ ] Sync again → resumes and completes at the same balance/height as A2.

## A5. Reorg tolerance (best-effort)
- [ ] If a reorg occurs during a sync, log shows "chain reorg detected … rewinding"
      and the sync still finishes at the correct tip/balance. (Opportunistic.)

## A6. Send after a pipelined sync (funds path)
- [ ] After a pipelined sync, build + FROST-sign + broadcast a small testnet send.
- [ ] Node accepts it (no branch-id / MissingSpendAuthSig / selection errors).
- [ ] After confirmation, a re-sync shows the spend and reduced balance.

## A7. Regression — flag off still works
- [ ] Set the flag back to `false`, sync once → stock path works normally.

## A — Sign-off
- [ ] A1 vs A2 identical across balance/notes/history/height.
- [ ] A3, A4, A6 pass on testnet. No panics, no stuck syncs, UI responsive.
- [ ] Only then: consider flipping the default, and repeat A1/A2/A6 once on
      **mainnet** with a small balance before recommending broadly.

---

# Part B — Tailscale serve hosting  (`feat/tailscale-serve`)

Goal: a coordinator can publish the embedded frostd to their tailnet at a stable
`*.ts.net` URL, participants on the same tailnet connect with no cert-trust step,
and the mapping is cleaned up correctly. `serve` is tailnet-only (not public).

## B0. Setup
- [ ] Fresh build launched on the **coordinator** machine.
- [ ] Tailscale installed and **signed in** on the coordinator (`tailscale status`
      shows Running + online).
- [ ] A **second device on the same tailnet** to act as a participant (another
      Cyze install, or at least a browser/curl to hit the URL).
- [ ] (For B6) a device **not** on the tailnet, to confirm scoping.

## B1. Detection states (before serving)
Open Session Setup → Coordinator → **Tailscale** tab and verify the guidance
matches reality:
- [ ] **Signed in & online** → tab shows this machine's `https://<name>.ts.net`
      and a **"Publish to tailnet"** button.
- [ ] **Signed out** (`tailscale logout`) → shows an actionable message
      (sign in with `tailscale up`), no Publish button.
- [ ] **Tailscale stopped** (`tailscale down`) → shows a "not connected" message.
- [ ] **Not installed** (test machine without Tailscale, or rename the binary) →
      shows "not installed, install from tailscale.com".

## B2. Happy path — publish
- [ ] Start the embedded server (Step 1).
- [ ] Tailscale tab → **Publish to tailnet** → badge **"serving on tailnet"** and
      a stable `https://<name>.ts.net` URL (no port).
- [ ] `tailscale serve status` on the coordinator shows the 443 → 127.0.0.1:<port>
      mapping (confirms the CLI invocation succeeded — the one flagged risk).
- [ ] Copy URL works.

## B3. Reachability from a tailnet participant
- [ ] On the participant device, open the URL / paste it into Participant setup and
      **Test connection** → succeeds, `tls` reported as **public** (no cert import),
      reasonable latency.
- [ ] No certificate-trust step was needed anywhere.

## B4. Stable save & reuse
- [ ] Save the `.ts.net` URL as the server (it is **not** treated as ephemeral).
- [ ] Fully quit and relaunch Cyze; re-publish; the URL is the **same** as before.
- [ ] The saved server still connects after relaunch (contrast: a Cloudflare quick
      tunnel would have a new URL).

## B5. Teardown paths
- [ ] **Stop serving** button → badge clears; from the participant the URL no
      longer reaches frostd; `tailscale serve status` shows the mapping gone.
- [ ] Re-publish, then **Stop server** (Step 1) → serve mapping is also torn down
      (sidecar stop cascades to Tailscale).
- [ ] Re-publish, then **quit the app** → after quit, `tailscale serve status`
      shows no leftover 443 mapping (exit cleanup ran).

## B6. Tailnet scoping (not public)
- [ ] From a device **not** on the tailnet, the `.ts.net` URL does **not** resolve/
      connect (confirms `serve`, not `funnel` — access is tailnet-scoped).

## B7. End-to-end ceremony over Tailscale
- [ ] With serve up and a participant joined via the `.ts.net` URL, run a real
      **signing** (or DKG) ceremony to completion over the tailnet transport.

## B — Sign-off
- [ ] B2–B5 pass; the URL is stable across relaunch and cleaned up on stop/quit.
- [ ] B6 confirms tailnet-only scoping.
- [ ] B7 completes a real ceremony over the transport.
- [ ] Note the Tailscale CLI version tested here: ____________  (so we know which
      `serve` grammar was validated).
