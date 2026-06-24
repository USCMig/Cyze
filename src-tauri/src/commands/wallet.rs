//! Zcash light-wallet commands (Phase 5.1, layer 1: lightwalletd config +
//! connectivity). Network and endpoint are user-configurable; testnet is the
//! default for testing, with mainnet available once the pipeline is complete.

use frost_app_core::ciphersuite::Suite;
use frost_app_core::signing::{run_coordinator, CoordinatorParams};
use frost_app_core::wallet::{self, LightwalletdInfo, WalletNetwork, WalletStatus};
use frost_client::api::PublicKey;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, CeremonyHandle};

fn network_from_str(s: &str) -> WalletNetwork {
    match s {
        "main" => WalletNetwork::Main,
        _ => WalletNetwork::Test,
    }
}

#[derive(Serialize)]
pub struct WalletConfig {
    /// "test" or "main".
    pub network: String,
    pub lightwalletd_url: String,
}

/// Resolve the effective wallet config, filling in the network's default
/// lightwalletd endpoint when none is saved.
fn resolve_config(state: &AppState) -> WalletConfig {
    let s = state.load_settings();
    let network = s.wallet_network.clone().unwrap_or_else(|| "test".into());
    let net = network_from_str(&network);
    let lightwalletd_url = s
        .lightwalletd_url
        .clone()
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| net.default_lightwalletd().to_string());
    WalletConfig {
        network,
        lightwalletd_url,
    }
}

#[tauri::command]
pub async fn get_wallet_config(state: State<'_, AppState>) -> AppResult<WalletConfig> {
    Ok(resolve_config(&state))
}

/// Save the wallet network and endpoint. An empty URL clears the override,
/// reverting to the network's default endpoint.
#[tauri::command]
pub async fn set_wallet_config(
    state: State<'_, AppState>,
    network: String,
    lightwalletd_url: String,
) -> AppResult<WalletConfig> {
    let mut settings = state.load_settings();
    settings.wallet_network = Some(if network == "main" { "main" } else { "test" }.to_string());
    let url = lightwalletd_url.trim();
    settings.lightwalletd_url = (!url.is_empty()).then(|| url.to_string());
    state.save_settings(&settings)?;
    Ok(resolve_config(&state))
}

/// Probe a lightwalletd endpoint and return its chain info (connectivity test).
/// Uses the configured endpoint when `url` is omitted.
#[tauri::command]
pub async fn lightwalletd_info(
    state: State<'_, AppState>,
    url: Option<String>,
) -> AppResult<LightwalletdInfo> {
    let url = url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| resolve_config(&state).lightwalletd_url);
    Ok(wallet::lightwalletd_info(&url).await?)
}

/// Resolve the wallet context for a RedPallas group: (network, lightwalletd
/// URL, derived UFVK string).
async fn group_wallet_ctx(
    state: &AppState,
    group_id: &str,
) -> AppResult<(WalletNetwork, String, String)> {
    let ciphersuite = state
        .with_config(|config| {
            config
                .group
                .get(group_id)
                .map(|g| g.ciphersuite.clone())
                .ok_or_else(|| AppError::new("config", "group not found"))
        })
        .await?;
    if !ciphersuite.contains("Pallas") {
        return Err(AppError::new(
            "config",
            "the wallet is only available for RedPallas (Zcash) groups",
        ));
    }
    let cfg = resolve_config(state);
    let network = WalletNetwork::from_str(&cfg.network);
    // The group id is the hex of its verifying key (the Orchard ak).
    let ufvk = frost_app_core::zcash::derive_orchard_keys_hex(group_id, network.network_type())?.ufvk;
    Ok((network, cfg.lightwalletd_url, ufvk))
}

/// Wallet balance + sync status for a group (reads the local db; no network).
#[tauri::command]
pub async fn wallet_group_status(
    state: State<'_, AppState>,
    group_id: String,
) -> AppResult<WalletStatus> {
    let (network, _url, ufvk) = group_wallet_ctx(&state, &group_id).await?;
    Ok(wallet::group_status(&state.data_dir, &group_id, network, &ufvk)?)
}

/// Import the group's UFVK as a view-only account (birthday = current chain
/// tip). Idempotent. Touches the network. Returns the birthday height.
#[tauri::command]
pub async fn wallet_init_account(
    state: State<'_, AppState>,
    group_id: String,
) -> AppResult<u64> {
    let (network, url, ufvk) = group_wallet_ctx(&state, &group_id).await?;
    Ok(wallet::init_group_account(&state.data_dir, &group_id, network, &ufvk, &url).await?)
}

/// Sync the group's wallet from lightwalletd, then return the updated status.
/// Long-running. Touches the network.
#[tauri::command]
pub async fn wallet_sync(state: State<'_, AppState>, group_id: String) -> AppResult<WalletStatus> {
    let (network, url, ufvk) = group_wallet_ctx(&state, &group_id).await?;
    wallet::sync_group(&state.data_dir, &group_id, network, &url).await?;
    Ok(wallet::group_status(&state.data_dir, &group_id, network, &ufvk)?)
}

/// Build (but do not sign or broadcast) an Orchard transfer, returning the
/// draft PCZT and the sighash the group must FROST-sign. Moves no funds.
#[tauri::command]
pub async fn wallet_prepare_send(
    state: State<'_, AppState>,
    group_id: String,
    recipient: String,
    amount_zatoshis: u64,
) -> AppResult<wallet::DraftTransaction> {
    let (network, _url, _ufvk) = group_wallet_ctx(&state, &group_id).await?;
    Ok(wallet::prepare_send(
        &state.data_dir,
        &group_id,
        network,
        &recipient,
        amount_zatoshis,
    )?)
}

#[derive(Deserialize)]
pub struct WalletSendArgs {
    pub group_id: String,
    pub recipient: String,
    pub amount_zatoshis: u64,
    /// Hex comm pubkeys of the group members who will sign (>= threshold).
    pub signers: Vec<String>,
}

/// Build, FROST-sign, and (next phase) broadcast an Orchard transfer. Builds the
/// PCZT, then drives the existing coordinator ceremony over the transaction
/// sighash using each spend's α as the re-randomizer; on completion, applies the
/// group signature to the PCZT. Emits `send:progress` / `send:complete` /
/// `send:failed`. Returns the ceremony id.
#[tauri::command]
pub async fn wallet_send<R: tauri::Runtime>(
    app: AppHandle<R>,
    args: WalletSendArgs,
) -> AppResult<Uuid> {
    let state = app.state::<AppState>();
    let (network, url, _ufvk) = group_wallet_ctx(&state, &args.group_id).await?;

    // 1. Build the unsigned transaction.
    let draft = wallet::prepare_send(
        &state.data_dir,
        &args.group_id,
        network,
        &args.recipient,
        args.amount_zatoshis,
    )?;
    if draft.spends.len() != 1 {
        return Err(AppError::new(
            "wallet",
            format!(
                "this version supports single-Orchard-spend transactions (built {})",
                draft.spends.len()
            ),
        ));
    }
    let spend = draft.spends[0].clone();
    let message = hex::decode(draft.sighash_hex.trim())
        .map_err(|e| AppError::new("wallet", format!("sighash: {e}")))?;
    let randomizer = hex::decode(spend.alpha_hex.trim())
        .map_err(|e| AppError::new("wallet", format!("alpha: {e}")))?;

    // 2. Coordinator params over the sighash, with the spend's α as randomizer.
    let (group, server_url) =
        crate::commands::signing::group_context(&state, &args.group_id, None).await?;
    let suite = Suite::from_id(&group.ciphersuite).map_err(AppError::from)?;
    let trust = crate::commands::server::trust_for(&state, &server_url).await;
    let signers = args
        .signers
        .iter()
        .map(|hex_pubkey| {
            let pubkey = PublicKey(
                hex::decode(hex_pubkey)
                    .map_err(|e| AppError::new("config", format!("bad signer pubkey: {e}")))?,
            );
            let participant = group
                .participant
                .values()
                .find(|p| p.pubkey == pubkey)
                .ok_or_else(|| AppError::new("config", "signer is not a group participant"))?;
            Ok((pubkey, participant.identifier.clone()))
        })
        .collect::<AppResult<Vec<_>>>()?;
    let (comm_privkey, comm_pubkey) = state
        .with_config(|config| {
            let comm = config
                .communication_key
                .as_ref()
                .ok_or_else(|| AppError::new("config", "keystore has no communication key"))?;
            Ok((comm.privkey.clone(), comm.pubkey.clone()))
        })
        .await?;
    let params = CoordinatorParams {
        server_url,
        trust,
        comm_privkey,
        comm_pubkey,
        public_key_package: group.public_key_package.clone(),
        message,
        signers,
        self_key_package: group.key_package.clone(),
        randomizer: Some(randomizer), // the Orchard spend's α
    };

    // 3. Spawn the ceremony; apply the signature to the PCZT on completion.
    let ceremony_id = Uuid::new_v4();
    let cancel = CancellationToken::new();
    state.ceremonies.lock().await.insert(
        ceremony_id,
        CeremonyHandle {
            cancel: cancel.clone(),
            approval: None,
        },
    );

    let (tx, mut rx) = mpsc::channel(64);
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = event_app.emit(
                "send:progress",
                serde_json::json!({ "ceremony_id": ceremony_id, "event": event }),
            );
        }
    });

    let task_app = app.clone();
    let pczt_hex = draft.pczt_hex.clone();
    let sighash_hex = draft.sighash_hex.clone();
    tauri::async_runtime::spawn(async move {
        let result = run_coordinator(suite, params, tx, cancel).await;
        let state = task_app.state::<AppState>();
        state.ceremonies.lock().await.remove(&ceremony_id);
        let fail = |error: String| {
            let _ = task_app.emit(
                "send:failed",
                serde_json::json!({ "ceremony_id": ceremony_id, "error": error }),
            );
        };
        match result {
            Ok(output) => {
                let sig_hex = hex::encode(&output.signature);
                let signed_pczt_hex = match wallet::apply_orchard_signatures(
                    &pczt_hex,
                    &sighash_hex,
                    vec![(spend.index, sig_hex)],
                ) {
                    Ok(hex) => hex,
                    Err(e) => return fail(e.to_string()),
                };
                // Prove + broadcast. Surfaced as its own phase since the proof
                // build is the slow part (several seconds).
                let _ = task_app.emit(
                    "send:progress",
                    serde_json::json!({
                        "ceremony_id": ceremony_id,
                        "event": { "phase": "proving" },
                    }),
                );
                match wallet::broadcast_signed(&signed_pczt_hex, network, &url).await {
                    Ok(txid) => {
                        let _ = task_app.emit(
                            "send:complete",
                            serde_json::json!({
                                "ceremony_id": ceremony_id,
                                "txid": txid,
                                "signed_pczt_hex": signed_pczt_hex,
                            }),
                        );
                    }
                    Err(e) => fail(e.to_string()),
                }
            }
            Err(e) => fail(e.to_string()),
        }
    });

    Ok(ceremony_id)
}
