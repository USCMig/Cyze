//! Optional Tailscale `serve` hosting for the embedded frostd server.
//!
//! Unlike the Cloudflare quick tunnel (a bundled `cloudflared` sidecar), this
//! **detects and drives a system `tailscale` CLI** — it is deliberately *not*
//! bundled, because `tailscale serve` needs the privileged `tailscaled` daemon
//! running and the machine signed in to a tailnet, neither of which the
//! sidecar-spawn pattern can provide. The user installs Tailscale and signs in;
//! Cyze just runs the CLI.
//!
//! `tailscale serve --bg https+insecure://127.0.0.1:<port>` puts the loopback
//! frostd behind the machine's stable MagicDNS name over the tailnet, on port
//! 443 with an automatically-provisioned, publicly-valid TLS certificate. That
//! fixes the two things that hurt about quick tunnels: the URL is **stable**
//! (savable as a group's server and reused across launches) and there is **no
//! self-signed-cert trust step** (participants connect with system roots). The
//! `https+insecure` scheme is the tailnet-side equivalent of cloudflared's
//! `--no-tls-verify`: it tells Tailscale not to verify frostd's self-signed
//! backend certificate, exactly as the tunnel already does.
//!
//! We use `serve` (tailnet-only), never `funnel` (public internet): access is
//! scoped to the coordinator's tailnet, a strictly better default for a signing
//! server. frostd's Noise layer still authenticates participants end-to-end, so
//! the transport only ever provides reachability.

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tokio::process::Command;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The `serve` flag selecting the tailnet HTTPS port. Passed as a single
/// combined `--https=443` token because `tailscale serve` does not reliably
/// accept the space-separated form. 443 is Tailscale's HTTPS default, so the
/// served URL carries no explicit port.
const SERVE_HTTPS_FLAG: &str = "--https=443";

/// Records that Cyze started `tailscale serve` and the stable URL it produced.
/// There is no child process to hold: `serve --bg` configures the `tailscaled`
/// daemon and returns, so tearing down means calling `serve … off`, not killing
/// a process.
pub struct TailscaleHandle {
    pub public_url: String,
    pub port: u16,
}

#[derive(Serialize, Clone)]
pub struct TailscaleStatus {
    /// The `tailscale` CLI was found, the daemon is running, the machine is
    /// signed in and online, and a MagicDNS name is available — i.e. `serve`
    /// can be started.
    pub available: bool,
    /// Cyze currently has `serve` active in front of the embedded server.
    pub serving: bool,
    /// The stable tailnet URL participants connect to (present while serving).
    pub public_url: Option<String>,
    /// The local frostd port being served (present while serving).
    pub port: Option<u16>,
    /// The machine's MagicDNS name (without the trailing dot), when known —
    /// shown even before serving so the user can see where they'll be reachable.
    pub dns_name: Option<String>,
    /// Human-readable status, especially *why* Tailscale is unavailable
    /// (not installed, daemon stopped, signed out) so the UI can guide the user.
    pub detail: Option<String>,
}

impl TailscaleStatus {
    fn unavailable(detail: impl Into<String>) -> Self {
        TailscaleStatus {
            available: false,
            serving: false,
            public_url: None,
            port: None,
            dns_name: None,
            detail: Some(detail.into()),
        }
    }
}

/// Candidate `tailscale` binary locations: PATH first (bare name; the OS
/// resolves it), then the well-known per-platform install paths the GUI apps use
/// but which are often not on a GUI-launched app's PATH (notably macOS).
fn tailscale_candidates() -> Vec<PathBuf> {
    let mut c = vec![PathBuf::from("tailscale")];
    if cfg!(target_os = "macos") {
        c.push(PathBuf::from(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        ));
        c.push(PathBuf::from("/usr/local/bin/tailscale"));
        c.push(PathBuf::from("/opt/homebrew/bin/tailscale"));
    } else if cfg!(target_os = "windows") {
        c.push(PathBuf::from(
            r"C:\Program Files\Tailscale\tailscale.exe",
        ));
    } else {
        c.push(PathBuf::from("/usr/bin/tailscale"));
        c.push(PathBuf::from("/usr/local/bin/tailscale"));
    }
    c
}

/// Resolve a working `tailscale` binary by trying each candidate with `version`.
/// Returns the first that runs, or `None` if Tailscale is not installed.
async fn resolve_bin() -> Option<PathBuf> {
    for bin in tailscale_candidates() {
        let ok = Command::new(&bin)
            .arg("version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return Some(bin);
        }
    }
    None
}

/// Run a `tailscale` subcommand and capture its output. Short-lived commands
/// only (`status`, `serve`), so we wait for completion rather than streaming.
async fn run(bin: &PathBuf, args: &[&str]) -> AppResult<std::process::Output> {
    Command::new(bin)
        .args(args)
        .output()
        .await
        .map_err(|e| AppError::new("tailscale", format!("running `tailscale {}`: {e}", args.join(" "))))
}

/// Probe the daemon via `tailscale status --json`, returning the MagicDNS name
/// (trailing dot stripped) when the machine is signed in and online. `Ok(Err)`
/// carries a user-facing reason it is not ready; the outer `Err` is an I/O
/// failure running the CLI.
async fn probe_dns_name(bin: &PathBuf) -> AppResult<Result<String, String>> {
    let out = run(bin, &["status", "--json"]).await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Ok(Err(format!(
            "Tailscale is installed but not ready: {}",
            first_line(&stderr).unwrap_or("run `tailscale up` and sign in")
        )));
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::new("tailscale", format!("parsing status JSON: {e}")))?;

    let backend = json.get("BackendState").and_then(|v| v.as_str()).unwrap_or("");
    if backend != "Running" {
        // NeedsLogin / Stopped / NoState — the actionable states.
        let hint = match backend {
            "NeedsLogin" | "NoState" => "sign in with `tailscale up`",
            "Stopped" => "start Tailscale (`tailscale up`)",
            _ => "start Tailscale and sign in",
        };
        return Ok(Err(format!("Tailscale is not connected — {hint}.")));
    }

    let self_node = json.get("Self");
    let online = self_node
        .and_then(|s| s.get("Online"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let dns = self_node
        .and_then(|s| s.get("DNSName"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim_end_matches('.').to_string())
        .filter(|s| !s.is_empty());

    match (online, dns) {
        (true, Some(name)) => Ok(Ok(name)),
        (false, _) => Ok(Err(
            "This machine is signed in but shows offline in the tailnet.".into(),
        )),
        (_, None) => Ok(Err(
            "MagicDNS is not enabled for this tailnet — enable it in the Tailscale admin console."
                .into(),
        )),
    }
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().map(str::trim).find(|l| !l.is_empty())
}

/// Turn off any HTTPS serve on 443 (best-effort). Used before starting (to clear
/// a stale mapping) and on stop. Surgical — only touches the 443 mount Cyze uses,
/// not the user's other serve config.
async fn serve_off(bin: &PathBuf) {
    let _ = run(bin, &["serve", SERVE_HTTPS_FLAG, "off"]).await;
}

/// Start `tailscale serve` in front of the embedded server on `port`, returning
/// the stable tailnet URL. Requires Tailscale installed, connected, and online.
pub async fn start(state: &AppState, port: u16) -> AppResult<TailscaleStatus> {
    if state.tailscale.lock().await.is_some() {
        return Err(AppError::new("tailscale", "Tailscale serve is already running"));
    }

    let bin = resolve_bin().await.ok_or_else(|| {
        AppError::new(
            "tailscale",
            "Tailscale CLI not found. Install Tailscale and sign in, then try again.",
        )
    })?;

    let dns_name = match probe_dns_name(&bin).await? {
        Ok(name) => name,
        Err(reason) => return Err(AppError::new("tailscale", reason)),
    };

    // Clear any stale 443 mapping from a previous run/crash, then serve the
    // loopback frostd. `https+insecure` skips verification of frostd's
    // self-signed backend cert (the tailnet edge presents a real cert outward).
    serve_off(&bin).await;
    let target = format!("https+insecure://127.0.0.1:{port}");
    let out = run(
        &bin,
        &["serve", "--bg", SERVE_HTTPS_FLAG, &target],
    )
    .await?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(AppError::new(
            "tailscale",
            format!(
                "`tailscale serve` failed: {}",
                first_line(&stderr).unwrap_or("unknown error (is the daemon running?)")
            ),
        ));
    }

    let public_url = format!("https://{dns_name}");
    *state.tailscale.lock().await = Some(TailscaleHandle {
        public_url: public_url.clone(),
        port,
    });

    Ok(TailscaleStatus {
        available: true,
        serving: true,
        public_url: Some(public_url),
        port: Some(port),
        dns_name: Some(dns_name),
        detail: None,
    })
}

/// Stop serving: drop our handle and turn off the 443 serve mapping. Best-effort
/// on the CLI side — if Tailscale is gone the mapping is moot anyway.
pub async fn stop(state: &AppState) -> AppResult<()> {
    state.tailscale.lock().await.take();
    if let Some(bin) = resolve_bin().await {
        serve_off(&bin).await;
    }
    Ok(())
}

/// Report Tailscale availability and whether Cyze is currently serving. Safe to
/// call any time (drives the UI); never errors — availability problems are
/// reported in `detail`.
pub async fn status(state: &AppState) -> TailscaleStatus {
    // Snapshot our own serve handle first, then release the lock before probing.
    let (serving, public_url, port) = match state.tailscale.lock().await.as_ref() {
        Some(h) => (true, Some(h.public_url.clone()), Some(h.port)),
        None => (false, None, None),
    };

    let bin = match resolve_bin().await {
        Some(b) => b,
        None => {
            let mut s = TailscaleStatus::unavailable(
                "Tailscale is not installed. Install it from tailscale.com and sign in.",
            );
            // Preserve any active serve we already recorded, even if the CLI
            // moved (unlikely) — the URL is still what participants use.
            s.serving = serving;
            s.public_url = public_url;
            s.port = port;
            return s;
        }
    };

    match probe_dns_name(&bin).await {
        Ok(Ok(dns_name)) => TailscaleStatus {
            available: true,
            serving,
            public_url,
            port,
            dns_name: Some(dns_name),
            detail: None,
        },
        Ok(Err(reason)) => {
            let mut s = TailscaleStatus::unavailable(reason);
            s.serving = serving;
            s.public_url = public_url;
            s.port = port;
            s
        }
        Err(e) => {
            let mut s = TailscaleStatus::unavailable(e.message);
            s.serving = serving;
            s.public_url = public_url;
            s.port = port;
            s
        }
    }
}

/// Synchronously turn off the 443 serve mapping, for use in the app-exit handler
/// (which is not async). `serve --bg` lives in the `tailscaled` daemon and would
/// otherwise outlive the app, leaving a mapping pointing at a dead frostd port.
/// Best-effort: resolves the binary and runs the off command, ignoring failures.
pub fn stop_serve_blocking() {
    use std::process::Command as StdCommand;
    for bin in tailscale_candidates() {
        let ran = StdCommand::new(&bin)
            .args(["serve", SERVE_HTTPS_FLAG, "off"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ran {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_include_path_and_platform_paths() {
        let c = tailscale_candidates();
        assert_eq!(c[0], PathBuf::from("tailscale"), "PATH lookup must be tried first");
        assert!(c.len() > 1, "should include platform-specific fallbacks");
    }

    #[test]
    fn first_line_trims_and_skips_blanks() {
        assert_eq!(first_line("\n  \n  hello \nworld"), Some("hello"));
        assert_eq!(first_line("   "), None);
    }
}
