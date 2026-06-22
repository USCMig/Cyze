//! Zcash light-wallet commands (Phase 5.1, layer 1: lightwalletd config +
//! connectivity). Network and endpoint are user-configurable; testnet is the
//! default for testing, with mainnet available once the pipeline is complete.

use frost_app_core::wallet::{self, LightwalletdInfo, WalletNetwork, WalletStatus};
use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

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
