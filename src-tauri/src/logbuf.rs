//! In-app log capture.
//!
//! The app emits diagnostics via `tracing`, but nothing was subscribing to them,
//! so they went nowhere. This installs a global subscriber that formats every
//! event to **stdout** (for terminal runs) and into an in-memory **ring buffer**
//! that the UI can read back — so a user can copy the logs (e.g. sync timing)
//! straight from the app without a terminal.
//!
//! The buffer is bounded ([`MAX_LINES`]) and lives only for the process: it is
//! not persisted to disk (logs can contain addresses/amounts, and a wallet
//! should not silently write those to a log file). Restarting the app clears it.

use std::collections::VecDeque;
use std::io;
use std::sync::{Arc, Mutex, OnceLock};

use tracing_subscriber::fmt::writer::MakeWriter;

/// Maximum number of log lines retained in memory. Older lines are dropped as
/// new ones arrive, so a long-running session can't grow memory without bound.
const MAX_LINES: usize = 3000;

/// A bounded, shareable ring buffer of formatted log lines.
#[derive(Clone)]
pub struct LogBuffer {
    lines: Arc<Mutex<VecDeque<String>>>,
}

impl LogBuffer {
    fn new() -> Self {
        Self {
            lines: Arc::new(Mutex::new(VecDeque::with_capacity(MAX_LINES))),
        }
    }

    /// A copy of the currently buffered lines, oldest first.
    pub fn snapshot(&self) -> Vec<String> {
        self.lines
            .lock()
            .map(|l| l.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// Drop all buffered lines.
    pub fn clear(&self) {
        if let Ok(mut l) = self.lines.lock() {
            l.clear();
        }
    }

    fn push_line(&self, line: String) {
        if let Ok(mut l) = self.lines.lock() {
            while l.len() >= MAX_LINES {
                l.pop_front();
            }
            l.push_back(line);
        }
    }
}

/// The process-wide log buffer, shared by the subscriber (writer) and the
/// `get_logs` command (reader).
static LOG_BUFFER: OnceLock<LogBuffer> = OnceLock::new();

/// Access the global log buffer, creating it on first use.
pub fn global() -> &'static LogBuffer {
    LOG_BUFFER.get_or_init(LogBuffer::new)
}

/// A short-lived writer for one `tracing` event. `fmt` formats the whole event
/// (a single line ending in `\n`) into this, then drops it; on drop we split the
/// accumulated bytes into lines and append them to the buffer.
pub struct LineWriter {
    buf: LogBuffer,
    pending: Vec<u8>,
}

impl io::Write for LineWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for LineWriter {
    fn drop(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        let text = String::from_utf8_lossy(&self.pending);
        for line in text.split('\n') {
            let line = line.trim_end_matches('\r');
            if !line.is_empty() {
                self.buf.push_line(line.to_string());
            }
        }
    }
}

impl<'a> MakeWriter<'a> for LogBuffer {
    type Writer = LineWriter;
    fn make_writer(&'a self) -> Self::Writer {
        LineWriter {
            buf: self.clone(),
            pending: Vec::new(),
        }
    }
}

/// Install the global `tracing` subscriber. Idempotent: a second call (e.g. in
/// tests) is a no-op rather than a panic. Formats to stdout and the in-app ring
/// buffer, honouring `RUST_LOG` when set; otherwise our crates log at `debug`
/// (so sync timing is captured) and dependencies stay at `info`.
pub fn init_logging() {
    use tracing_subscriber::fmt::writer::MakeWriterExt;
    use tracing_subscriber::EnvFilter;

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,frost_app=debug,frost_app_core=debug"));

    // Tee: the same formatted event goes to stdout and the in-app buffer.
    let writer = std::io::stdout.and(global().clone());

    let _ = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_target(false)
        .with_env_filter(filter)
        .with_writer(writer)
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn ring_buffer_caps_and_orders() {
        let buf = LogBuffer::new();
        for i in 0..(MAX_LINES + 50) {
            buf.push_line(format!("line {i}"));
        }
        let snap = buf.snapshot();
        assert_eq!(snap.len(), MAX_LINES, "buffer is capped");
        assert_eq!(snap.first().unwrap(), "line 50", "oldest dropped first");
        assert_eq!(snap.last().unwrap(), &format!("line {}", MAX_LINES + 49));
        buf.clear();
        assert!(buf.snapshot().is_empty());
    }

    #[test]
    fn line_writer_splits_events_into_lines() {
        let buf = LogBuffer::new();
        {
            let mut w = buf.make_writer();
            w.write_all(b"first line\n").unwrap();
        } // dropped here -> flushed
        {
            let mut w = buf.make_writer();
            w.write_all(b"second\nthird\n").unwrap();
        }
        assert_eq!(buf.snapshot(), vec!["first line", "second", "third"]);
    }
}
