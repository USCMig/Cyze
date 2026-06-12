//! Passphrase-encrypted keystore.
//!
//! File format (little-endian integers):
//!
//! ```text
//! magic "FROSTKS1" (8) | version u8 | m_cost_kib u32 | t_cost u32 | p u8 |
//! salt (16) | nonce (24) | AEAD ciphertext
//! ```
//!
//! The key is derived with Argon2id and the payload sealed with
//! XChaCha20-Poly1305, using everything before the ciphertext as AAD.
//! The plaintext is an upstream-format credentials TOML (see [`crate::config`]),
//! so importing `~/.config/frost/credentials.toml` is read-then-encrypt and a
//! decrypted keystore is a valid upstream config.

use std::path::{Path, PathBuf};

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use rand::RngCore;
use zeroize::Zeroizing;

use crate::error::CoreError;

const MAGIC: &[u8; 8] = b"FROSTKS1";
const VERSION: u8 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 8 + 1 + 4 + 4 + 1 + SALT_LEN + NONCE_LEN;

/// Argon2id parameters, stored in the file header so they can be raised later
/// without breaking existing keystores.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u8,
}

impl Default for KdfParams {
    fn default() -> Self {
        // 64 MiB, 3 iterations, 1 lane.
        Self {
            m_cost_kib: 64 * 1024,
            t_cost: 3,
            p_cost: 1,
        }
    }
}

fn derive_key(passphrase: &str, salt: &[u8], params: &KdfParams) -> Result<Zeroizing<[u8; 32]>, CoreError> {
    let argon_params = Params::new(params.m_cost_kib, params.t_cost, params.p_cost as u32, Some(32))
        .map_err(|e| CoreError::Crypto(e.to_string()))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, argon_params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|e| CoreError::Crypto(e.to_string()))?;
    Ok(key)
}

/// Encrypt `plaintext` into the keystore envelope format.
pub fn seal(plaintext: &[u8], passphrase: &str, params: &KdfParams) -> Result<Vec<u8>, CoreError> {
    let mut rng = rand::thread_rng();
    let mut salt = [0u8; SALT_LEN];
    rng.fill_bytes(&mut salt);
    let mut nonce = [0u8; NONCE_LEN];
    rng.fill_bytes(&mut nonce);

    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.push(VERSION);
    header.extend_from_slice(&params.m_cost_kib.to_le_bytes());
    header.extend_from_slice(&params.t_cost.to_le_bytes());
    header.push(params.p_cost);
    header.extend_from_slice(&salt);
    header.extend_from_slice(&nonce);

    let key = derive_key(passphrase, &salt, params)?;
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &header,
            },
        )
        .map_err(|e| CoreError::Crypto(e.to_string()))?;

    let mut out = header;
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a keystore envelope. Returns [`CoreError::InvalidPassphrase`] on
/// AEAD authentication failure.
pub fn open(data: &[u8], passphrase: &str) -> Result<Zeroizing<Vec<u8>>, CoreError> {
    if data.len() < HEADER_LEN {
        return Err(CoreError::MalformedKeystore("file too short".into()));
    }
    if &data[..8] != MAGIC {
        return Err(CoreError::MalformedKeystore("bad magic".into()));
    }
    let version = data[8];
    if version != VERSION {
        return Err(CoreError::UnsupportedKeystoreVersion(version));
    }
    let params = KdfParams {
        m_cost_kib: u32::from_le_bytes(data[9..13].try_into().unwrap()),
        t_cost: u32::from_le_bytes(data[13..17].try_into().unwrap()),
        p_cost: data[17],
    };
    let salt = &data[18..18 + SALT_LEN];
    let nonce = &data[18 + SALT_LEN..HEADER_LEN];
    let header = &data[..HEADER_LEN];
    let ciphertext = &data[HEADER_LEN..];

    let key = derive_key(passphrase, salt, &params)?;
    let cipher = XChaCha20Poly1305::new(key.as_ref().into());
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad: header,
            },
        )
        .map_err(|_| CoreError::InvalidPassphrase)?;
    Ok(Zeroizing::new(plaintext))
}

/// Atomically write `data` to `path` (temp file in the same directory, then
/// rename), mirroring upstream frost-client's write_atomic behavior.
pub fn write_atomic(path: &Path, data: &[u8]) -> Result<(), CoreError> {
    let dir = path
        .parent()
        .ok_or_else(|| CoreError::Config("keystore path has no parent".into()))?;
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// On-disk keystore handle: knows its path, seals/opens on demand.
pub struct Keystore {
    path: PathBuf,
}

impl Keystore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Create a new keystore file with the given plaintext. Fails if one
    /// already exists.
    pub fn create(&self, plaintext: &[u8], passphrase: &str) -> Result<(), CoreError> {
        if self.exists() {
            return Err(CoreError::KeystoreExists);
        }
        self.save_with_params(plaintext, passphrase, &KdfParams::default())
    }

    /// Re-encrypt and save (for any config mutation while unlocked).
    pub fn save(&self, plaintext: &[u8], passphrase: &str) -> Result<(), CoreError> {
        self.save_with_params(plaintext, passphrase, &KdfParams::default())
    }

    fn save_with_params(
        &self,
        plaintext: &[u8],
        passphrase: &str,
        params: &KdfParams,
    ) -> Result<(), CoreError> {
        let sealed = seal(plaintext, passphrase, params)?;
        write_atomic(&self.path, &sealed)
    }

    /// Decrypt the keystore file.
    pub fn unlock(&self, passphrase: &str) -> Result<Zeroizing<Vec<u8>>, CoreError> {
        if !self.exists() {
            return Err(CoreError::KeystoreNotFound);
        }
        let data = std::fs::read(&self.path)?;
        open(&data, passphrase)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cheap params so tests don't spend seconds in Argon2.
    fn test_params() -> KdfParams {
        KdfParams {
            m_cost_kib: 8,
            t_cost: 1,
            p_cost: 1,
        }
    }

    #[test]
    fn roundtrip() {
        let sealed = seal(b"hello frost", "pass", &test_params()).unwrap();
        let opened = open(&sealed, "pass").unwrap();
        assert_eq!(opened.as_slice(), b"hello frost");
    }

    #[test]
    fn wrong_passphrase() {
        let sealed = seal(b"hello frost", "pass", &test_params()).unwrap();
        assert!(matches!(
            open(&sealed, "wrong"),
            Err(CoreError::InvalidPassphrase)
        ));
    }

    #[test]
    fn tampered_header_fails() {
        let mut sealed = seal(b"hello frost", "pass", &test_params()).unwrap();
        // Flip a bit in the KDF params; AAD binding must reject it.
        sealed[9] ^= 1;
        // Either the KDF params now derive a different key, or AAD check fails;
        // both must surface as InvalidPassphrase or Crypto, never success.
        assert!(open(&sealed, "pass").is_err());
    }

    #[test]
    fn not_a_keystore() {
        assert!(matches!(
            open(b"definitely not a keystore", "pass"),
            Err(CoreError::MalformedKeystore(_))
        ));
    }

    #[test]
    fn file_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let ks = Keystore::new(dir.path().join("keystore.frost"));
        assert!(!ks.exists());
        let sealed = seal(b"data", "pw", &test_params()).unwrap();
        write_atomic(ks.path(), &sealed).unwrap();
        assert!(ks.exists());
        assert_eq!(ks.unlock("pw").unwrap().as_slice(), b"data");
        assert!(matches!(
            ks.create(b"x", "pw"),
            Err(CoreError::KeystoreExists)
        ));
    }
}
