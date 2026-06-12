//! Signing ceremony engine (coordinator and participant roles).
//!
//! Mirrors upstream `frost_client::coordinator::comms::http` and
//! `frost_client::participant::comms::http`, restructured as cancellable
//! async tasks with progress events. The participant flow pauses at an
//! approval gate after the message is known but before the round-2
//! signature share is produced (round-1 commitments are message-independent,
//! so nothing secret is committed before approval).

use std::collections::HashMap;

use frost_client::api::{self, PublicKey, SendSigningPackageArgs, Uuid};
use frost_client::cipher::{Cipher, PrivateKey};
use frost_client::session::CoordinatorSessionState;
use frost_core::keys::{KeyPackage, PublicKeyPackage};
use frost_core::{self as frost, Ciphersuite, Identifier, SigningPackage};
use frost_ed25519::Ed25519Sha512;
use frost_rerandomized::{RandomizedCiphersuite, Randomizer};
use rand::rngs::OsRng;
use reddsa::frost::redpallas::PallasBlake2b512;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::ciphersuite::Suite;
use crate::error::CoreError;
use crate::events::{CoordinatorEvent, ParticipantEvent};
use crate::transport::{FrostdClient, ServerTrust};

fn cerr(e: Box<dyn std::error::Error>) -> CoreError {
    CoreError::Ceremony(e.to_string())
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

pub struct CoordinatorParams {
    pub server_url: String,
    pub trust: ServerTrust,
    pub comm_privkey: PrivateKey,
    pub comm_pubkey: PublicKey,
    /// Postcard-encoded `PublicKeyPackage` from the group config.
    pub public_key_package: Vec<u8>,
    /// The raw message to sign (for Zcash, a future tx builder supplies the
    /// sighash here).
    pub message: Vec<u8>,
    /// Selected signers: comm pubkey -> serialized FROST identifier, both
    /// taken from the group config.
    pub signers: Vec<(PublicKey, Vec<u8>)>,
}

pub struct SigningOutput {
    /// Serialized group signature.
    pub signature: Vec<u8>,
}

pub async fn run_coordinator(
    suite: Suite,
    params: CoordinatorParams,
    events: mpsc::Sender<CoordinatorEvent>,
    cancel: CancellationToken,
) -> Result<SigningOutput, CoreError> {
    match suite {
        Suite::Ed25519 => run_coordinator_generic::<Ed25519Sha512>(params, events, cancel).await,
        Suite::RedPallas => {
            run_coordinator_generic::<PallasBlake2b512>(params, events, cancel).await
        }
    }
}

async fn run_coordinator_generic<C: RandomizedCiphersuite + 'static>(
    params: CoordinatorParams,
    events: mpsc::Sender<CoordinatorEvent>,
    cancel: CancellationToken,
) -> Result<SigningOutput, CoreError> {
    let public_key_package: PublicKeyPackage<C> = postcard::from_bytes(&params.public_key_package)
        .map_err(|e| CoreError::Config(format!("bad public key package: {e}")))?;

    let signers: HashMap<PublicKey, Identifier<C>> = params
        .signers
        .iter()
        .map(|(pubkey, id_bytes)| {
            Ok((
                pubkey.clone(),
                Identifier::<C>::deserialize(id_bytes)
                    .map_err(|e| CoreError::Ceremony(e.to_string()))?,
            ))
        })
        .collect::<Result<_, CoreError>>()?;
    let num_signers = signers.len();
    if num_signers == 0 {
        return Err(CoreError::Ceremony("no signers selected".into()));
    }

    let mut client = FrostdClient::new(format!("https://{}", params.server_url), &params.trust)?;
    let _ = events.send(CoordinatorEvent::Connecting).await;
    client.login(&params.comm_privkey, &params.comm_pubkey).await?;

    let session_id = client
        .create_new_session(&api::CreateNewSessionArgs {
            pubkeys: signers.keys().cloned().collect(),
            message_count: 1,
        })
        .await?
        .session_id;
    let _ = events
        .send(CoordinatorEvent::SessionCreated { session_id })
        .await;

    let result = coordinator_rounds(
        &client,
        session_id,
        &params,
        &public_key_package,
        signers,
        num_signers,
        &events,
        &cancel,
    )
    .await;

    // Always try to close the session; the server also expires it after 24h.
    let _ = client
        .close_session(&api::CloseSessionArgs { session_id })
        .await;
    let _ = client.logout().await;
    result
}

#[allow(clippy::too_many_arguments)]
async fn coordinator_rounds<C: RandomizedCiphersuite + 'static>(
    client: &FrostdClient,
    session_id: Uuid,
    params: &CoordinatorParams,
    public_key_package: &PublicKeyPackage<C>,
    signers: HashMap<PublicKey, Identifier<C>>,
    num_signers: usize,
    events: &mpsc::Sender<CoordinatorEvent>,
    cancel: &CancellationToken,
) -> Result<SigningOutput, CoreError> {
    let mut cipher = Cipher::new(
        params.comm_privkey.clone(),
        signers.keys().cloned().collect(),
    )
    .map_err(|e| CoreError::Crypto(e.to_string()))?;

    let mut state = CoordinatorSessionState::<C>::new(1, num_signers, signers);

    // Round 1: collect commitments from all selected signers.
    let _ = events.send(CoordinatorEvent::WaitingForCommitments).await;
    loop {
        let r = client
            .receive(&api::ReceiveArgs {
                session_id,
                as_coordinator: true,
            })
            .await?;
        for msg in r.msgs {
            let msg = cipher
                .decrypt(msg)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            state.recv(msg).map_err(cerr)?;
        }
        if state.has_commitments() {
            break;
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(CoreError::Cancelled),
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
        }
    }
    let (commitments, pubkeys) = state.commitments().map_err(cerr)?;

    // Build the signing package; RedPallas additionally needs a randomizer
    // (re-randomized FROST), generated here and distributed to participants.
    let signing_package = SigningPackage::<C>::new(commitments[0].clone(), &params.message);
    let randomizer = if C::ID == PallasBlake2b512::ID {
        Some(
            Randomizer::<C>::new(OsRng, &signing_package)
                .map_err(|e| CoreError::Ceremony(e.to_string()))?,
        )
    } else {
        None
    };

    let send_args = SendSigningPackageArgs::<C> {
        signing_package: vec![signing_package.clone()],
        aux_msg: Default::default(),
        randomizer: randomizer.map(|r| vec![r]).unwrap_or_default(),
    };
    // Encrypted separately per recipient (the Noise sessions are pairwise).
    let recipients: Vec<PublicKey> = pubkeys.keys().cloned().collect();
    for recipient in recipients {
        let msg = cipher
            .encrypt(
                Some(&recipient),
                serde_json::to_vec(&send_args).map_err(|e| CoreError::Ceremony(e.to_string()))?,
            )
            .map_err(|e| CoreError::Crypto(e.to_string()))?;
        client
            .send(&api::SendArgs {
                session_id,
                recipients: vec![recipient.clone()],
                msg,
            })
            .await?;
    }
    let _ = events.send(CoordinatorEvent::SigningPackageSent).await;

    // Round 2: collect signature shares.
    let _ = events.send(CoordinatorEvent::WaitingForShares).await;
    loop {
        let r = client
            .receive(&api::ReceiveArgs {
                session_id,
                as_coordinator: true,
            })
            .await?;
        for msg in r.msgs {
            let msg = cipher
                .decrypt(msg)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            state.recv(msg).map_err(cerr)?;
        }
        if state.has_signature_shares() {
            break;
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(CoreError::Cancelled),
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
        }
    }
    let _ = events.send(CoordinatorEvent::Aggregating).await;
    let shares = state.signature_shares().map_err(cerr)?;

    // Aggregate (rerandomized for RedPallas); aggregation verifies the
    // result against the (randomized) group verifying key internally.
    let signature = if !send_args.randomizer.is_empty() {
        let randomizer_params = frost_rerandomized::RandomizedParams::<C>::from_randomizer(
            public_key_package.verifying_key(),
            send_args.randomizer[0],
        );
        frost_rerandomized::aggregate(
            &signing_package,
            &shares[0],
            public_key_package,
            &randomizer_params,
        )
        .map_err(|e| CoreError::Ceremony(e.to_string()))?
    } else {
        frost::aggregate::<C>(&signing_package, &shares[0], public_key_package)
            .map_err(|e| CoreError::Ceremony(e.to_string()))?
    };

    Ok(SigningOutput {
        signature: signature
            .serialize()
            .map_err(|e| CoreError::Ceremony(e.to_string()))?,
    })
}

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

pub struct ParticipantParams {
    pub server_url: String,
    pub trust: ServerTrust,
    pub comm_privkey: PrivateKey,
    pub comm_pubkey: PublicKey,
    /// Postcard-encoded `KeyPackage` from the group config.
    pub key_package: Vec<u8>,
    /// The session to join.
    pub session_id: Uuid,
    /// Comm pubkeys of the group members; the session coordinator must be
    /// one of them.
    pub group_pubkeys: Vec<PublicKey>,
}

pub async fn run_participant(
    suite: Suite,
    params: ParticipantParams,
    approval: oneshot::Receiver<bool>,
    events: mpsc::Sender<ParticipantEvent>,
    cancel: CancellationToken,
) -> Result<(), CoreError> {
    match suite {
        Suite::Ed25519 => {
            run_participant_generic::<Ed25519Sha512>(params, approval, events, cancel).await
        }
        Suite::RedPallas => {
            run_participant_generic::<PallasBlake2b512>(params, approval, events, cancel).await
        }
    }
}

async fn run_participant_generic<C: RandomizedCiphersuite + 'static>(
    params: ParticipantParams,
    approval: oneshot::Receiver<bool>,
    events: mpsc::Sender<ParticipantEvent>,
    cancel: CancellationToken,
) -> Result<(), CoreError> {
    let key_package: KeyPackage<C> = postcard::from_bytes(&params.key_package)
        .map_err(|e| CoreError::Config(format!("bad key package: {e}")))?;

    let mut client = FrostdClient::new(format!("https://{}", params.server_url), &params.trust)?;
    let _ = events.send(ParticipantEvent::Connecting).await;
    client.login(&params.comm_privkey, &params.comm_pubkey).await?;

    let session_id = params.session_id;

    // The coordinator must be a member of the group we're signing for;
    // otherwise someone unknown is asking us to sign.
    let session_info = client
        .get_session_info(&api::GetSessionInfoArgs { session_id })
        .await?;
    if !params.group_pubkeys.contains(&session_info.coordinator_pubkey) {
        return Err(CoreError::Ceremony(
            "session coordinator is not a member of this group".into(),
        ));
    }

    let mut cipher = Cipher::new(
        params.comm_privkey.clone(),
        vec![session_info.coordinator_pubkey.clone()],
    )
    .map_err(|e| CoreError::Crypto(e.to_string()))?;

    // Round 1 (message-independent): commit and send.
    let (nonces, commitments) = frost::round1::commit(key_package.signing_share(), &mut OsRng);
    let msg = cipher
        .encrypt(
            None,
            serde_json::to_vec(&vec![commitments])
                .map_err(|e| CoreError::Ceremony(e.to_string()))?,
        )
        .map_err(|e| CoreError::Crypto(e.to_string()))?;
    client
        .send(&api::SendArgs {
            session_id,
            recipients: vec![], // empty = the coordinator
            msg,
        })
        .await?;
    let _ = events.send(ParticipantEvent::CommitmentsSent).await;

    // Wait for the signing package.
    let send_args: SendSigningPackageArgs<C> = loop {
        let r = client
            .receive(&api::ReceiveArgs {
                session_id,
                as_coordinator: false,
            })
            .await?;
        if let Some(msg) = r.msgs.into_iter().next() {
            let msg = cipher
                .decrypt(msg)
                .map_err(|e| CoreError::Crypto(e.to_string()))?;
            break serde_json::from_slice(&msg.msg)
                .map_err(|e| CoreError::Ceremony(e.to_string()))?;
        }
        tokio::select! {
            _ = cancel.cancelled() => return Err(CoreError::Cancelled),
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
        }
    };

    let signing_package = send_args
        .signing_package
        .first()
        .ok_or_else(|| CoreError::Ceremony("empty signing package".into()))?;

    // Approval gate: surface the message and wait for the user. No secret
    // material has been revealed yet — only nonce commitments.
    let _ = events
        .send(ParticipantEvent::AwaitingApproval {
            message_hex: hex::encode(signing_package.message()),
        })
        .await;
    let approved = tokio::select! {
        _ = cancel.cancelled() => return Err(CoreError::Cancelled),
        r = approval => r.unwrap_or(false),
    };
    if !approved {
        let _ = client.logout().await;
        return Err(CoreError::Ceremony("signing rejected by user".into()));
    }

    // Round 2: produce and send the signature share.
    let share = if !send_args.randomizer.is_empty() {
        frost_rerandomized::sign::<C>(
            signing_package,
            &nonces,
            &key_package,
            send_args.randomizer[0],
        )
        .map_err(|e| CoreError::Ceremony(e.to_string()))?
    } else {
        frost::round2::sign(signing_package, &nonces, &key_package)
            .map_err(|e| CoreError::Ceremony(e.to_string()))?
    };

    let msg = cipher
        .encrypt(
            None,
            serde_json::to_vec(&vec![share]).map_err(|e| CoreError::Ceremony(e.to_string()))?,
        )
        .map_err(|e| CoreError::Crypto(e.to_string()))?;
    client
        .send(&api::SendArgs {
            session_id,
            recipients: vec![],
            msg,
        })
        .await?;
    let _ = events.send(ParticipantEvent::ShareSent).await;
    let _ = client.logout().await;
    Ok(())
}
