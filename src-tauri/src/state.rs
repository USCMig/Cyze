use std::collections::HashMap;
use std::path::PathBuf;

use frost_app_core::keystore::Keystore;
use frost_client::cli::config::Config;
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::error::{AppError, AppResult};

/// Non-secret app settings, stored as plaintext JSON so they are readable
/// before the keystore is unlocked.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Settings {
    /// Display name for the local user, shown wherever this identity appears
    /// (own participant entries in groups, signer lists, etc.).
    #[serde(default)]
    pub username: Option<String>,
    /// Last external server the user connected to, `host:port`.
    pub server_url: Option<String>,
    /// Port for the embedded frostd sidecar.
    pub sidecar_port: Option<u16>,
    /// PEM certs trusted for specific external servers, keyed by `host:port`.
    #[serde(default)]
    pub trusted_certs: HashMap<String, String>,
}

/// Keystore contents held in memory while unlocked. The unlocked
/// [`KeystoreFile`] carries the data-encryption key and key slots, so config
/// mutations re-encrypt transparently without rotating the DEK or invalidating
/// the recovery slot.
pub struct UnlockedState {
    pub config: Config,
    pub file: frost_app_core::keystore::KeystoreFile,
}

/// Handle to a running ceremony task (DKG or signing).
pub struct CeremonyHandle {
    pub cancel: CancellationToken,
    /// Present for participant signing ceremonies that are paused at the
    /// approval gate; resolving it releases the round-2 signature share.
    pub approval: Option<oneshot::Sender<bool>>,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub unlocked: RwLock<Option<UnlockedState>>,
    pub ceremonies: Mutex<HashMap<Uuid, CeremonyHandle>>,
    pub sidecar: Mutex<Option<crate::sidecar::SidecarHandle>>,
    /// Optional Cloudflare quick tunnel exposing the embedded server publicly.
    pub tunnel: Mutex<Option<crate::tunnel::TunnelHandle>>,
}

impl AppState {
    pub fn new() -> Self {
        let data_dir = std::env::var("FROST_APP_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                dirs::data_local_dir()
                    .expect("no local data dir on this platform")
                    .join("frost-app")
            });
        Self::with_dir(data_dir)
    }

    pub fn with_dir(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            unlocked: RwLock::new(None),
            ceremonies: Mutex::new(HashMap::new()),
            sidecar: Mutex::new(None),
            tunnel: Mutex::new(None),
        }
    }

    pub fn keystore(&self) -> Keystore {
        Keystore::new(self.data_dir.join("keystore.frost"))
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn load_settings(&self) -> Settings {
        std::fs::read_to_string(self.settings_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &Settings) -> AppResult<()> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::write(
            self.settings_path(),
            serde_json::to_string_pretty(settings)
                .map_err(|e| AppError::new("config", e.to_string()))?,
        )?;
        Ok(())
    }

    /// Run `f` against the unlocked config, then re-encrypt and persist it.
    pub async fn mutate_config<T>(
        &self,
        f: impl FnOnce(&mut Config) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self.unlocked.write().await;
        let unlocked = guard.as_mut().ok_or_else(AppError::locked)?;
        let result = f(&mut unlocked.config)?;
        let toml = frost_app_core::config::serialize_config(&unlocked.config)
            .map_err(AppError::from)?;
        self.keystore()
            .save_file(&unlocked.file, toml.as_bytes())
            .map_err(AppError::from)?;
        Ok(result)
    }

    /// Read-only access to the unlocked config.
    pub async fn with_config<T>(
        &self,
        f: impl FnOnce(&Config) -> AppResult<T>,
    ) -> AppResult<T> {
        let guard = self.unlocked.read().await;
        let unlocked = guard.as_ref().ok_or_else(AppError::locked)?;
        f(&unlocked.config)
    }
}
