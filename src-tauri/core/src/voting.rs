//! Coinholder polling (protocol voting): building a **Vote Cast Memo** and
//! casting it as a shielded payment to a poll's reception address.
//!
//! Follows the zec-coin-polling *Vote Cast Memo Format v1*. A vote is a shielded
//! transaction whose memo is:
//!
//! ```json
//! { "zec-coin-polling-vote": "v1",
//!   "poll-hash": "<hex sha256 of the ballot definition>",
//!   "votes": [ <entry>, … ] }
//! ```
//!
//! sent to the poll's reception Z-address. Each `votes[]` entry is one of:
//! - `null` — abstain,
//! - a number — the zero-based index into that question's fixed responses,
//! - a string — a free-form answer (only where the question permits one).
//!
//! Per the standard, a memo that breaks *any* rule is discarded and counted as
//! all-abstain, so this module validates strictly before a vote is ever cast.
//!
//! # A note on vote *weight*
//!
//! Format v1 tallies results from a snapshot of **transparent** address balances
//! at a cutoff height. A Cyze FROST group's treasury is **shielded** (Orchard /
//! Ironwood), so under a strict v1 poll its vote carries weight only if the group
//! also holds transparent ZEC at the cutoff — the shielded-weighting poll variant
//! is what makes a shielded treasury's vote count. This module builds a correct
//! vote memo either way; whether a specific poll *counts* a shielded group's vote
//! is a property of that poll's rules, not of the memo. Casting is done through
//! the existing shielded-send + FROST path (recipient = the poll address, memo =
//! the encoded vote).

use serde::{Deserialize, Serialize};

use crate::error::CoreError;

/// The memo identifier tag and version this module speaks.
pub const VOTE_MEMO_TAG: &str = "zec-coin-polling-vote";
pub const VOTE_MEMO_VERSION: &str = "v1";

/// Zcash memo field capacity in bytes. A vote memo that does not fit cannot be
/// carried on-chain, so encoding refuses it rather than producing a memo the
/// send path would silently truncate (which would make the vote malformed and,
/// per the standard, count as all-abstain).
pub const MEMO_MAX_BYTES: usize = 512;

/// One question's answer within a vote.
///
/// Serialization matches the memo wire format directly: `Abstain` → JSON `null`,
/// `Choice(i)` → the number `i`, `FreeForm(s)` → the string `s`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoteEntry {
    /// Abstain on this question (JSON `null`).
    Abstain,
    /// Select the fixed response at this zero-based index.
    Choice(usize),
    /// Provide a free-form answer (only valid when the question allows one).
    FreeForm(String),
}

impl VoteEntry {
    fn to_json(&self) -> serde_json::Value {
        match self {
            VoteEntry::Abstain => serde_json::Value::Null,
            VoteEntry::Choice(i) => serde_json::Value::from(*i),
            VoteEntry::FreeForm(s) => serde_json::Value::from(s.as_str()),
        }
    }
}

/// The shape of one ballot question, as far as vote validation cares: how many
/// fixed responses it offers and whether a free-form answer is permitted.
///
/// Kept deliberately independent of any concrete ballot-definition JSON schema
/// (whose exact field names are still being finalized upstream): a caller derives
/// this from whatever ballot representation it has, and the memo rules are
/// enforced against it here.
#[derive(Debug, Clone, Copy)]
pub struct QuestionShape {
    /// Number of entries in the question's fixed-response list. A `Choice(i)` is
    /// valid only when `i < num_fixed_responses`.
    pub num_fixed_responses: usize,
    /// Whether the question permits a free-form answer (its `other-prompt` is set).
    pub allows_freeform: bool,
}

/// The `poll-hash` for a ballot: the hex-encoded SHA-256 of the ballot definition
/// **exactly as published**. The hash is over the raw bytes, never a re-serialized
/// copy — re-encoding could change whitespace or key order and break the hash the
/// poll's publisher expects.
pub fn poll_hash(ballot_definition_bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(ballot_definition_bytes))
}

/// Check a set of votes against the ballot's questions, enforcing the v1 rules:
/// one entry per question, fixed-response indices in range, and free-form answers
/// only where allowed. Returns the first violation. Callers MUST validate before
/// casting, because an invalid memo is counted as all-abstain on-chain.
pub fn validate_votes(votes: &[VoteEntry], questions: &[QuestionShape]) -> Result<(), CoreError> {
    if votes.len() != questions.len() {
        return Err(CoreError::Config(format!(
            "vote has {} answer(s) but the ballot has {} question(s)",
            votes.len(),
            questions.len()
        )));
    }
    for (i, (vote, q)) in votes.iter().zip(questions).enumerate() {
        match vote {
            VoteEntry::Abstain => {}
            VoteEntry::Choice(idx) => {
                if *idx >= q.num_fixed_responses {
                    return Err(CoreError::Config(format!(
                        "question {i}: response index {idx} is out of range (0..{})",
                        q.num_fixed_responses
                    )));
                }
            }
            VoteEntry::FreeForm(s) => {
                if !q.allows_freeform {
                    return Err(CoreError::Config(format!(
                        "question {i}: a free-form answer is not allowed"
                    )));
                }
                if s.is_empty() {
                    return Err(CoreError::Config(format!(
                        "question {i}: free-form answer is empty"
                    )));
                }
            }
        }
    }
    Ok(())
}

/// Encode a Vote Cast Memo (format v1) as the exact JSON string to place in the
/// transaction memo. `poll_hash_hex` is the ballot's [`poll_hash`]; `votes` is one
/// entry per ballot question (validate them first with [`validate_votes`]).
///
/// Fails if the result would exceed [`MEMO_MAX_BYTES`].
pub fn encode_vote_memo(poll_hash_hex: &str, votes: &[VoteEntry]) -> Result<String, CoreError> {
    let votes_json: Vec<serde_json::Value> = votes.iter().map(VoteEntry::to_json).collect();
    let memo = serde_json::json!({
        VOTE_MEMO_TAG: VOTE_MEMO_VERSION,
        "poll-hash": poll_hash_hex,
        "votes": votes_json,
    });
    let s = serde_json::to_string(&memo)
        .map_err(|e| CoreError::Config(format!("encode vote memo: {e}")))?;
    if s.len() > MEMO_MAX_BYTES {
        return Err(CoreError::Config(format!(
            "vote memo is {} bytes, over the {MEMO_MAX_BYTES}-byte on-chain limit \
             (too many questions or a long free-form answer)",
            s.len()
        )));
    }
    Ok(s)
}

/// A minimal, permissive view of a published ballot definition, parsed only to
/// drive the voting UI and derive [`QuestionShape`]s — never to recompute the
/// `poll-hash` (that must hash the original bytes). Unknown fields are ignored so
/// this keeps working as the upstream schema gains fields; the field names cover
/// the shapes seen in the zec-coin-polling reference and are matched leniently.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BallotQuestion {
    /// The question text shown to the voter.
    #[serde(alias = "question", alias = "text")]
    pub prompt: String,
    /// The selectable fixed responses, in order (a `Choice(i)` indexes this).
    #[serde(rename = "fixed-responses", alias = "responses", default)]
    pub fixed_responses: Vec<String>,
    /// Prompt for a free-form answer; `None`/absent means free-form is disallowed.
    #[serde(rename = "other-prompt", alias = "other_prompt", default)]
    pub other_prompt: Option<String>,
}

impl BallotQuestion {
    /// The validation shape for this question.
    pub fn shape(&self) -> QuestionShape {
        QuestionShape {
            num_fixed_responses: self.fixed_responses.len(),
            allows_freeform: self.other_prompt.is_some(),
        }
    }
}

/// A published ballot definition, parsed leniently from its JSON. Only used to
/// render the questions and derive [`QuestionShape`]s — the `poll-hash` is always
/// taken from the original bytes via [`poll_hash`], never from a re-serialization
/// of this. Unknown top-level fields are ignored so it survives schema additions.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BallotDefinition {
    #[serde(default, alias = "poll-title", alias = "name")]
    pub title: Option<String>,
    pub questions: Vec<BallotQuestion>,
}

impl BallotDefinition {
    /// Parse a ballot definition from its JSON text.
    pub fn parse(json: &str) -> Result<Self, CoreError> {
        serde_json::from_str(json).map_err(|e| {
            CoreError::Config(format!(
                "could not parse ballot definition (expected an object with a \
                 \"questions\" array): {e}"
            ))
        })
    }

    /// The validation shapes for every question, in order.
    pub fn question_shapes(&self) -> Vec<QuestionShape> {
        self.questions.iter().map(BallotQuestion::shape).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(n: usize, freeform: bool) -> QuestionShape {
        QuestionShape { num_fixed_responses: n, allows_freeform: freeform }
    }

    #[test]
    fn poll_hash_is_stable_hex_sha256_of_the_bytes() {
        // sha256("") is a known vector; hashing bytes (not a re-serialized copy)
        // is what keeps the hash matching the published ballot.
        assert_eq!(
            poll_hash(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_ne!(poll_hash(b"{\"a\":1}"), poll_hash(b"{ \"a\": 1 }"));
    }

    #[test]
    fn encodes_the_v1_memo_shape() {
        let memo = encode_vote_memo("abcd", &[VoteEntry::Choice(1), VoteEntry::Abstain]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&memo).unwrap();
        assert_eq!(v["zec-coin-polling-vote"], "v1");
        assert_eq!(v["poll-hash"], "abcd");
        assert_eq!(v["votes"][0], 1);
        assert!(v["votes"][1].is_null());
    }

    #[test]
    fn free_form_serializes_as_a_string() {
        let memo = encode_vote_memo("h", &[VoteEntry::FreeForm("more research".into())]).unwrap();
        let v: serde_json::Value = serde_json::from_str(&memo).unwrap();
        assert_eq!(v["votes"][0], "more research");
    }

    #[test]
    fn validation_enforces_one_answer_per_question() {
        assert!(validate_votes(&[VoteEntry::Abstain], &[q(2, false), q(2, false)]).is_err());
        assert!(validate_votes(&[VoteEntry::Abstain, VoteEntry::Choice(0)], &[q(2, false), q(1, false)]).is_ok());
    }

    #[test]
    fn validation_rejects_out_of_range_and_disallowed_freeform() {
        assert!(validate_votes(&[VoteEntry::Choice(2)], &[q(2, false)]).is_err()); // index 2 not in 0..2
        assert!(validate_votes(&[VoteEntry::Choice(1)], &[q(2, false)]).is_ok());
        assert!(validate_votes(&[VoteEntry::FreeForm("x".into())], &[q(2, false)]).is_err()); // freeform disallowed
        assert!(validate_votes(&[VoteEntry::FreeForm("x".into())], &[q(2, true)]).is_ok());
        assert!(validate_votes(&[VoteEntry::FreeForm(String::new())], &[q(2, true)]).is_err()); // empty
    }

    #[test]
    fn oversized_memo_is_refused() {
        let votes: Vec<VoteEntry> = vec![VoteEntry::FreeForm("x".repeat(600))];
        assert!(encode_vote_memo("h", &votes).is_err());
    }

    #[test]
    fn ballot_question_shape_and_lenient_parse() {
        let j = r#"{"question":"Fund X?","responses":["Yes","No"]}"#;
        let bq: BallotQuestion = serde_json::from_str(j).unwrap();
        assert_eq!(bq.prompt, "Fund X?");
        let shape = bq.shape();
        assert_eq!(shape.num_fixed_responses, 2);
        assert!(!shape.allows_freeform);
    }

    #[test]
    fn ballot_definition_parses_and_yields_shapes() {
        let j = r#"{
            "title": "NU7 sentiment",
            "questions": [
              {"prompt":"Approve NU7?","fixed-responses":["Yes","No","Unsure"]},
              {"prompt":"Comments","fixed-responses":[],"other-prompt":"Say more"}
            ]
        }"#;
        let b = BallotDefinition::parse(j).unwrap();
        assert_eq!(b.title.as_deref(), Some("NU7 sentiment"));
        let shapes = b.question_shapes();
        assert_eq!(shapes.len(), 2);
        assert_eq!(shapes[0].num_fixed_responses, 3);
        assert!(!shapes[0].allows_freeform);
        assert!(shapes[1].allows_freeform);
        // A valid vote against this ballot passes validation.
        assert!(validate_votes(
            &[VoteEntry::Choice(1), VoteEntry::FreeForm("ok".into())],
            &shapes
        )
        .is_ok());
    }

    #[test]
    fn ballot_definition_rejects_non_ballot_json() {
        assert!(BallotDefinition::parse("not json").is_err());
        assert!(BallotDefinition::parse(r#"{"foo":1}"#).is_err()); // no questions
    }
}
