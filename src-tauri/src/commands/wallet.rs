//! Zcash light-wallet commands (Phase 5.1, layer 1: lightwalletd config +
//! connectivity). Network and endpoint are user-configurable; testnet is the
//! default for testing, with mainnet available once the pipeline is complete.

use frost_app_core::wallet::{self, LightwalletdInfo, WalletNetwork};
use serde::Serialize;
use tauri::State;

use crate::error::AppResult;
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
