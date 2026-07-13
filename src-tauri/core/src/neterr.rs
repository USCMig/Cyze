//! Turning opaque network failures into messages a user can act on.
//!
//! `reqwest` and `tonic` both render only their *outermost* layer via `Display`:
//! reqwest gives "error sending request for url (…)" and tonic gives, famously,
//! just "transport error". The actual cause — DNS lookup failed, connection
//! refused, certificate rejected — lives further down the `source()` chain and is
//! thrown away by a plain `e.to_string()`. That is how a dead Cloudflare tunnel
//! and a transient DNS blip end up looking identical and equally unhelpful.
//!
//! [`describe`] flattens the whole chain; [`connection_error`] classifies it and
//! attaches the fix.

use crate::error::CoreError;

/// Render an error together with every `source()` beneath it, so the root cause
/// survives. Consecutive duplicate layers are collapsed (reqwest/hyper often
/// repeat themselves).
pub fn describe(err: &(dyn std::error::Error + 'static)) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut cur: Option<&(dyn std::error::Error + 'static)> = Some(err);
    while let Some(e) = cur {
        let msg = e.to_string();
        if parts.last().map(|p: &String| p != &msg).unwrap_or(true) && !msg.is_empty() {
            parts.push(msg);
        }
        cur = e.source();
    }
    parts.join(": ")
}

/// The host portion of a `scheme://host:port` (or bare `host:port`) URL.
fn host_of(url: &str) -> &str {
    let s = url
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let s = s.split('/').next().unwrap_or(s);
    // Strip a trailing `:port`, but never mistake an unbracketed IPv6 literal
    // ("::1") for host+port. A bracketed literal ("[::1]:443") splits correctly:
    // the closing bracket is what proves the last colon is a port separator.
    match s.rsplit_once(':') {
        Some((h, p))
            if p.chars().all(|c| c.is_ascii_digit())
                && !p.is_empty()
                && (h.ends_with(']') || !h.contains(':')) =>
        {
            h
        }
        _ => s,
    }
}

/// A TryCloudflare *quick tunnel* hostname. These are ephemeral: `cloudflared`
/// mints a new random hostname every run and deregisters the old one the moment
/// it exits, so a URL shared from a previous session stops resolving entirely.
fn is_quick_tunnel(host: &str) -> bool {
    host.ends_with(".trycloudflare.com")
}

/// What went wrong at the network layer, inferred from the flattened chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dns,
    Refused,
    Unreachable,
    Tls,
    Timeout,
    Other,
}

fn classify(chain: &str) -> Kind {
    let c = chain.to_ascii_lowercase();
    // Order matters: a TLS failure can also mention "connect".
    if c.contains("dns error")
        || c.contains("failed to lookup address")
        || c.contains("name or service not known")
        || c.contains("no such host")
        || c.contains("nodename nor servname")
        || c.contains("temporary failure in name resolution")
    {
        Kind::Dns
    } else if c.contains("certificate")
        || c.contains("unknownissuer")
        || c.contains("unknown issuer")
        || c.contains("self-signed")
        || c.contains("bad certificate")
        || c.contains("handshake")
        || c.contains("invalid peer certificate")
    {
        Kind::Tls
    } else if c.contains("connection refused") {
        Kind::Refused
    } else if c.contains("network is unreachable") || c.contains("no route to host") {
        Kind::Unreachable
    } else if c.contains("timed out") || c.contains("timeout") || c.contains("deadline") {
        Kind::Timeout
    } else {
        Kind::Other
    }
}

/// Build a [`CoreError::Connection`] that names the cause and the fix.
///
/// `what` is the action being attempted ("connecting to lightwalletd", "reaching
/// the signing server"); `url` is the endpoint it was attempted against.
pub fn connection_error(
    what: &str,
    url: &str,
    err: &(dyn std::error::Error + 'static),
) -> CoreError {
    let chain = describe(err);
    let host = host_of(url);
    let kind = classify(&chain);

    let hint = match kind {
        Kind::Dns if is_quick_tunnel(host) => format!(
            "the Cloudflare tunnel '{host}' is no longer registered. Quick-tunnel URLs are \
             regenerated every time the coordinator restarts the tunnel, and the old URL stops \
             resolving. Ask the coordinator to restart the tunnel and share the current URL."
        ),
        Kind::Dns => format!(
            "'{host}' could not be resolved (DNS). Check the address for typos, and that this \
             machine has working DNS — a VPN or split-DNS resolver is a common cause."
        ),
        Kind::Refused => format!(
            "nothing accepted the connection at {host}. Check the server is running and the port \
             is correct."
        ),
        Kind::Unreachable => format!(
            "{host} is unreachable from this machine — no network route. A VPN, firewall, or a \
             host with no IPv6 route can cause this."
        ),
        Kind::Tls => format!(
            "the TLS certificate for {host} was not accepted. For a self-signed server, import \
             its certificate first (trust-on-first-use) so it can be pinned."
        ),
        Kind::Timeout => format!(
            "the connection to {host} timed out. The server may be down, or a firewall may be \
             dropping the traffic."
        ),
        Kind::Other => String::new(),
    };

    // Keep the raw chain: it is what makes an unrecognized failure diagnosable
    // instead of a dead end.
    if hint.is_empty() {
        CoreError::Connection(format!("{what} {url}: {chain}"))
    } else {
        CoreError::Connection(format!("{what} {url}: {hint} ({chain})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_is_extracted_from_each_url_shape() {
        assert_eq!(host_of("https://zec.rocks:443"), "zec.rocks");
        assert_eq!(host_of("https://a.trycloudflare.com/challenge"), "a.trycloudflare.com");
        assert_eq!(host_of("host:2744"), "host");
        assert_eq!(host_of("https://[::1]:443"), "[::1]");
    }

    #[test]
    fn quick_tunnel_hostnames_are_recognized() {
        assert!(is_quick_tunnel("san-times-certain-alerts.trycloudflare.com"));
        assert!(!is_quick_tunnel("zec.rocks"));
    }

    #[test]
    fn classify_reads_the_root_cause_not_the_wrapper() {
        // The shapes reqwest/hyper/tonic actually produce.
        assert_eq!(classify("error sending request: dns error: failed to lookup address"), Kind::Dns);
        assert_eq!(classify("transport error: tcp connect error: Connection refused (os error 111)"), Kind::Refused);
        assert_eq!(classify("transport error: invalid peer certificate: UnknownIssuer"), Kind::Tls);
        assert_eq!(classify("error sending request: operation timed out"), Kind::Timeout);
        assert_eq!(classify("network is unreachable (os error 101)"), Kind::Unreachable);
        assert_eq!(classify("something else entirely"), Kind::Other);
    }

    #[test]
    fn a_dead_quick_tunnel_says_so() {
        #[derive(Debug)]
        struct E;
        impl std::fmt::Display for E {
            fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "dns error: failed to lookup address information")
            }
        }
        impl std::error::Error for E {}
        let msg = connection_error(
            "reaching the signing server",
            "https://san-times-certain-alerts.trycloudflare.com",
            &E,
        )
        .to_string();
        assert!(msg.contains("no longer registered"), "{msg}");
        assert!(msg.contains("restart the tunnel"), "{msg}");
    }

    #[test]
    fn describe_walks_the_source_chain() {
        #[derive(Debug)]
        struct Inner;
        impl std::fmt::Display for Inner {
            fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "Connection refused (os error 111)")
            }
        }
        impl std::error::Error for Inner {}

        #[derive(Debug)]
        struct Outer;
        impl std::fmt::Display for Outer {
            fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "transport error")
            }
        }
        impl std::error::Error for Outer {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&Inner)
            }
        }
        // The bare Display ("transport error") is exactly what used to be shown.
        assert_eq!(describe(&Outer), "transport error: Connection refused (os error 111)");
    }
}
