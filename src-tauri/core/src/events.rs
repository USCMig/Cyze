//! Progress events emitted by ceremony tasks. The app layer forwards these
//! to the frontend over Tauri events.

use serde::Serialize;
use uuid::Uuid;

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
    /// `message_hex` is what will be signed; show it to the user.
    AwaitingApproval { message_hex: String },
    /// Share computed and sent to the coordinator.
    ShareSent,
}
