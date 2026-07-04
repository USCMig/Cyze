//! Progress events emitted by ceremony tasks. The app layer forwards these
//! to the frontend over Tauri events.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Human-readable description of the transaction a participant is being asked to
/// sign. Sent by the coordinator over the signing package's `aux_msg` side
/// channel so co-signers can review *what* they are signing instead of an
/// opaque 32-byte sighash. This is advisory context for the approval gate; the
/// bytes actually signed are still the FROST message (the sighash).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SigningContext {
    /// Destination address (unified/orchard or transparent).
    pub recipient: String,
    /// Amount sent to the recipient, in zatoshis.
    pub amount_zatoshis: u64,
    /// Network fee, in zatoshis.
    pub fee_zatoshis: u64,
    /// Optional memo attached to the recipient's shielded output.
    pub memo: Option<String>,
    /// True when the recipient is transparent (an unshield): amount and
    /// recipient become public on-chain.
    pub is_unshield: bool,
    /// Zcash network the transaction targets ("test" or "main").
    pub network: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum DkgEvent {
    Connecting,
    /// Session established; identifiers derived for all participants.
    SessionReady {
        session_id: Uuid,
        num_participants: u16,
    },
    /// Own round 1 package sent; waiting for the others.
    Round1,
    /// Echo-broadcast verification of round 1 packages (3+ participants).
    Round1Broadcast,
    /// Own round 2 packages sent; waiting for the others.
    Round2,
    /// Computing the final key share.
    Finalizing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum CoordinatorEvent {
    Connecting,
    SessionCreated { session_id: Uuid },
    WaitingForCommitments,
    SigningPackageSent,
    WaitingForShares,
    Aggregating,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum ParticipantEvent {
    Connecting,
    /// Commitments sent (message-independent round 1).
    CommitmentsSent,
    /// Signing package received — paused until the user approves.
    /// `message_hex` is what will be signed (the raw sighash); show it to the
    /// user. `context`, when present, decodes that sighash into the human-
    /// readable transaction the coordinator says it corresponds to.
    AwaitingApproval {
        message_hex: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<SigningContext>,
    },
    /// Share computed and sent to the coordinator.
    ShareSent,
}
