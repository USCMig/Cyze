use frost_app_core::transport::{FrostdClient, ServerTrust};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::AppResult;
use crate::sidecar::{self, SidecarStatus};
use crate::state::{AppState, Settings};
use crate::tunnel::{self, TunnelStatus};

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> AppResult<Settings> {
    Ok(state.load_settings())
}

#[tauri::command]
pub async fn set_server_url(state: State<'_, AppState>, url: String) -> AppResult<()> {
    let mut settings = state.load_settings();
    settings.server_url = Some(url);
    state.save_settings(&settings)
}

/// Determine trust for a given server URL: pinned certs for the embedded
/// sidecar and any TOFU-imported external certs, system roots otherwise.
pub async fn trust_for(state: &AppState, url: &str) -> ServerTrust {
    let normalized = url
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string();
    if normalized.starts_with("127.0.0.1") || normalized.starts_with("localhost") {
        if let Some(handle) = state.sidecar.lock().await.as_ref() {
            return ServerTrust::PinnedCertificate(handle.cert_pem.clone().into_bytes());
        }
    }
    let settings = state.load_settings();
    if let Some(pem) = settings.trusted_certs.get(&normalized) {
        return ServerTrust::PinnedCertificate(pem.clone().into_bytes());
    }
    ServerTrust::SystemRoots
}

/// Build a FrostdClient for a `host:port` server using stored trust.
pub async fn client_for(state: &AppState, url: &str) -> AppResult<FrostdClient> {
    let host_port = url.trim_start_matches("https://").trim_end_matches('/');
    let trust = trust_for(state, host_port).await;
    Ok(FrostdClient::new(format!("https://{host_port}"), &trust)?)
}

#[derive(Serialize)]
pub struct ConnectionTestResult {
    pub ok: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn test_server_connection(
    state: State<'_, AppState>,
    url: String,
) -> AppResult<ConnectionTestResult> {
    let client = client_for(&state, &url).await?;
    match client.challenge().await {
        Ok(_) => Ok(ConnectionTestResult {
            ok: true,
            error: None,
        }),
        Err(e) => Ok(ConnectionTestResult {
            ok: false,
            error: Some(e.to_string()),
        }),
    }
}

/// Trust a PEM certificate for an external server (TOFU import). The
/// frontend shows the fingerprint for confirmation before calling this.
#[tauri::command]
pub async fn trust_server_cert(
    state: State<'_, AppState>,
    url: String,
    cert_pem: String,
) -> AppResult<String> {
    let fingerprint = frost_app_core::tls::cert_fingerprint(&cert_pem)?;
    let mut settings = state.load_settings();
    let key = url
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string();
    settings.trusted_certs.insert(key, cert_pem);
    state.save_settings(&settings)?;
    Ok(fingerprint)
}

#[tauri::command]
pub async fn cert_fingerprint_of(cert_pem: String) -> AppResult<String> {
    Ok(frost_app_core::tls::cert_fingerprint(&cert_pem)?)
}

#[tauri::command]
pub async fn start_sidecar(app: AppHandle, port: Option<u16>) -> AppResult<SidecarStatus> {
    let state = app.state::<AppState>();
    let settings = state.load_settings();
    let port = port.or(settings.sidecar_port).unwrap_or(2744);
    let status = sidecar::start(&app, port).await?;
    let mut settings = state.load_settings();
    settings.sidecar_port = Some(port);
    state.save_settings(&settings)?;
    Ok(status)
}

#[tauri::command]
pub async fn stop_sidecar(state: State<'_, AppState>) -> AppResult<()> {
    // The tunnel points at the embedded server; stopping the server makes it
    // dead weight, so tear it down too.
    let _ = tunnel::stop(&state).await;
    sidecar::stop(&state).await
}

/// Start a Cloudflare quick tunnel in front of the running embedded server,
/// returning the public `https://*.trycloudflare.com` URL participants can use.
#[tauri::command]
pub async fn start_tunnel(app: AppHandle) -> AppResult<TunnelStatus> {
    let state = app.state::<AppState>();
    let port = {
        let guard = state.sidecar.lock().await;
        match guard.as_ref() {
            Some(handle) => handle.port,
            None => {
                return Err(crate::error::AppError::new(
                    "tunnel",
                    "start the embedded server before opening a tunnel",
                ))
            }
        }
    };
    tunnel::start(&app, port).await
}

#[tauri::command]
pub async fn stop_tunnel(state: State<'_, AppState>) -> AppResult<()> {
    tunnel::stop(&state).await
}

#[tauri::command]
pub async fn tunnel_status(state: State<'_, AppState>) -> AppResult<TunnelStatus> {
    Ok(tunnel::status(&state).await)
}

#[tauri::command]
pub async fn sidecar_status(state: State<'_, AppState>) -> AppResult<SidecarStatus> {
    sidecar::status(&state).await
}

/// Export the sidecar's certificate PEM so LAN participants can trust it.
#[tauri::command]
pub async fn export_sidecar_cert(state: State<'_, AppState>) -> AppResult<String> {
    let (cert_pem, _, _) = sidecar::ensure_certs(&state)?;
    Ok(cert_pem)
}
