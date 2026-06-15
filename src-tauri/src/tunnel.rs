//! Optional Cloudflare quick-tunnel manager.
//!
//! Spawns `cloudflared tunnel --url https://localhost:<port> --no-tls-verify`
//! and parses the assigned `*.trycloudflare.com` URL from its output. This
//! gives external participants a public HTTPS endpoint that reaches the
//! embedded frostd through NAT with no router configuration. Cloudflare's
//! edge terminates TLS with a publicly trusted certificate, so participants
//! connect with system roots and skip the self-signed-cert trust step
//! entirely.
//!
//! Unlike the frostd sidecar (a bundled binary spawned through the Tauri
//! shell plugin), `cloudflared` is an external system binary, so we spawn it
//! directly with `tokio::process` and own the child ourselves.

use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::oneshot;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub struct TunnelHandle {
    pub child: Child,
    pub public_url: String,
    pub port: u16,
}

#[derive(Serialize, Clone)]
pub struct TunnelStatus {
    pub running: bool,
    pub public_url: Option<String>,
    pub port: Option<u16>,
}

/// Extract a `https://<sub>.trycloudflare.com` URL from a log line, if present.
fn parse_tunnel_url(line: &str) -> Option<String> {
    let start = line.find("https://")?;
    let rest = &line[start..];
    // The URL ends at the first whitespace or box-drawing/punctuation char.
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '|' || c == '"')
        .unwrap_or(rest.len());
    let url = rest[..end].trim_end_matches(['/', '.']).to_string();
    if url.ends_with(".trycloudflare.com") {
        Some(url)
    } else {
        None
    }
}

/// Drain one of cloudflared's output streams: forward each line to the
/// frontend as a `tunnel:log` event, and on the first line that carries the
/// public URL, send it through `url_tx` (once).
fn spawn_reader<R>(
    stream: R,
    app: AppHandle,
    url_tx: Arc<std::sync::Mutex<Option<oneshot::Sender<String>>>>,
) where
    R: AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stream).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(url) = parse_tunnel_url(&line) {
                if let Ok(mut slot) = url_tx.lock() {
                    if let Some(tx) = slot.take() {
                        let _ = tx.send(url);
                    }
                }
            }
            let _ = app.emit("tunnel:log", line);
        }
    });
}

pub async fn start(app: &AppHandle, port: u16) -> AppResult<TunnelStatus> {
    let state = app.state::<AppState>();
    if state.tunnel.lock().await.is_some() {
        return Err(AppError::new("tunnel", "a tunnel is already running"));
    }

    let mut child = Command::new("cloudflared")
        .args([
            "tunnel",
            "--url",
            &format!("https://localhost:{port}"),
            "--no-tls-verify",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            AppError::new(
                "tunnel",
                format!(
                    "could not start cloudflared — is it installed and on PATH? ({e}). \
                     Install it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
                ),
            )
        })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (url_tx, url_rx) = oneshot::channel::<String>();
    let url_tx = Arc::new(std::sync::Mutex::new(Some(url_tx)));
    if let Some(out) = stdout {
        spawn_reader(out, app.clone(), url_tx.clone());
    }
    if let Some(err) = stderr {
        spawn_reader(err, app.clone(), url_tx.clone());
    }

    // Wait (bounded) for cloudflared to report the assigned URL.
    let public_url = match tokio::time::timeout(std::time::Duration::from_secs(30), url_rx).await {
        Ok(Ok(url)) => url,
        _ => {
            let _ = child.start_kill();
            return Err(AppError::new(
                "tunnel",
                "cloudflared did not report a public URL within 30 seconds",
            ));
        }
    };

    let _ = app.emit("tunnel:ready", public_url.clone());

    // Notice if cloudflared exits later so the UI can reflect it.
    {
        let app_handle = app.clone();
        let pid = child.id();
        tauri::async_runtime::spawn(async move {
            // The child is owned by AppState; poll for disappearance instead
            // of awaiting `wait()` (which needs &mut child).
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                if let Some(st) = app_handle.try_state::<AppState>() {
                    let mut guard = st.tunnel.lock().await;
                    match guard.as_mut() {
                        Some(h) if h.child.id() == pid => {
                            if matches!(h.child.try_wait(), Ok(Some(_))) {
                                *guard = None;
                                let _ = app_handle.emit("tunnel:exited", ());
                                break;
                            }
                        }
                        _ => break, // replaced or stopped elsewhere
                    }
                } else {
                    break;
                }
            }
        });
    }

    *state.tunnel.lock().await = Some(TunnelHandle {
        child,
        public_url: public_url.clone(),
        port,
    });

    Ok(TunnelStatus {
        running: true,
        public_url: Some(public_url),
        port: Some(port),
    })
}

pub async fn stop(state: &AppState) -> AppResult<()> {
    let mut guard = state.tunnel.lock().await;
    if let Some(mut handle) = guard.take() {
        let _ = handle.child.start_kill();
    }
    Ok(())
}

pub async fn status(state: &AppState) -> TunnelStatus {
    match state.tunnel.lock().await.as_ref() {
        Some(h) => TunnelStatus {
            running: true,
            public_url: Some(h.public_url.clone()),
            port: Some(h.port),
        },
        None => TunnelStatus {
            running: false,
            public_url: None,
            port: None,
        },
    }
}
