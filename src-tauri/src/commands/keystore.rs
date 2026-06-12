use frost_client::cli::config::{CommunicationKey, Config};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
pub struct KeystoreStatus {
    pub exists: bool,
    pub unlocked: bool,
}

#[tauri::command]
pub async fn keystore_status(state: State<'_, AppState>) -> AppResult<KeystoreStatus> {
    Ok(KeystoreStatus {
        exists: state.keystore().exists(),
        unlocked: state.unlocked.read().await.is_some(),
    })
}

/// Create a fresh keystore with a newly generated communication keypair
/// (the equivalent of `frost-client init`).
#[tauri::command]
pub async fn create_keystore(state: State<'_, AppState>, passphrase: String) -> AppResult<()> {
    let (privkey, pubkey) = frost_client::cipher::Cipher::generate_keypair()
        .map_err(|e| AppError::new("crypto", e.to_string()))?;
    let config = Config {
        communication_key: Some(CommunicationKey { privkey, pubkey }),
        ..Default::default()
    };
    let toml = frost_app_core::config::serialize_config(&config)?;
    state.keystore().create(toml.as_bytes(), &passphrase)?;
    *state.unlocked.write().await = Some(crate::state::UnlockedState {
        config,
        passphrase: Zeroizing::new(passphrase),
    });
    Ok(())
}

/// Import an existing plaintext frost-client credentials.toml into a new
/// encrypted keystore. `path` defaults to the upstream location.
#[tauri::command]
pub async fn import_upstream_config(
    state: State<'_, AppState>,
    path: Option<String>,
    passphrase: String,
) -> AppResult<()> {
    let path = match path {
        Some(p) => std::path::PathBuf::from(p),
        None => dirs::config_local_dir()
            .ok_or_else(|| AppError::new("config", "no config dir on this platform"))?
            .join("frost")
            .join("credentials.toml"),
    };
    let toml_str = Zeroizing::new(std::fs::read_to_string(&path).map_err(|e| {
        AppError::new(
            "config",
            format!("cannot read {}: {e}", path.display()),
        )
    })?);
    let config = frost_app_core::config::parse_config(&toml_str)?;
    state.keystore().create(toml_str.as_bytes(), &passphrase)?;
    *state.unlocked.write().await = Some(crate::state::UnlockedState {
        config,
        passphrase: Zeroizing::new(passphrase),
    });
    Ok(())
}

#[tauri::command]
pub async fn unlock_keystore(state: State<'_, AppState>, passphrase: String) -> AppResult<()> {
    let plaintext = state.keystore().unlock(&passphrase)?;
    let toml_str = std::str::from_utf8(&plaintext)
        .map_err(|e| AppError::new("malformed_keystore", e.to_string()))?;
    let config = frost_app_core::config::parse_config(toml_str)?;
    *state.unlocked.write().await = Some(crate::state::UnlockedState {
        config,
        passphrase: Zeroizing::new(passphrase),
    });
    Ok(())
}

#[tauri::command]
pub async fn lock_keystore(state: State<'_, AppState>) -> AppResult<()> {
    // Cancel any running ceremonies; their key material must not outlive the lock.
    for (_, handle) in state.ceremonies.lock().await.drain() {
        handle.cancel.cancel();
    }
    *state.unlocked.write().await = None;
    Ok(())
}

#[tauri::command]
pub async fn change_passphrase(
    state: State<'_, AppState>,
    old_passphrase: String,
    new_passphrase: String,
) -> AppResult<()> {
    // Verify the old passphrase against the file rather than trusting memory.
    let plaintext = state.keystore().unlock(&old_passphrase)?;
    state.keystore().save(&plaintext, &new_passphrase)?;
    if let Some(unlocked) = state.unlocked.write().await.as_mut() {
        unlocked.passphrase = Zeroizing::new(new_passphrase);
    }
    Ok(())
}
