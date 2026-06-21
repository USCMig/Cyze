//! Zcash Orchard key/address derivation (feature `zcash`).
//!
//! A FROST group only produces the Orchard **spend validating key** (`ak`).
//! A full viewing key additionally needs the **nullifier key** (`nk`) and the
//! **commit-ivk randomness** (`rivk`); together they form the 96-byte FVK
//! encoding `ak || nk || rivk`. This module reconstructs the FVK from those
//! parts and derives a unified address — proving the orchard crate coexists
//! with the pinned FROST/reddsa stack (the spike), and laying the foundation
//! for full UFVK/address rendering once the group establishes `nk`/`rivk`.

use crate::error::CoreError;

/// Reconstruct an Orchard `FullViewingKey` from its three components and derive
/// the raw bytes of the first external unified address (43-byte Orchard
/// receiver). `ak`, `nk`, `rivk` are each 32 bytes.
pub fn orchard_address_from_parts(
    ak: &[u8; 32],
    nk: &[u8; 32],
    rivk: &[u8; 32],
) -> Result<[u8; 43], CoreError> {
    let mut fvk_bytes = [0u8; 96];
    fvk_bytes[..32].copy_from_slice(ak);
    fvk_bytes[32..64].copy_from_slice(nk);
    fvk_bytes[64..].copy_from_slice(rivk);

    let fvk = orchard::keys::FullViewingKey::from_bytes(&fvk_bytes)
        .ok_or_else(|| CoreError::Crypto("invalid Orchard FVK components".into()))?;
    let address = fvk.address_at(0u32, orchard::keys::Scope::External);
    Ok(address.to_raw_address_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use orchard::keys::{FullViewingKey, SpendingKey};

    #[test]
    fn fvk_parts_roundtrip_to_address() {
        // Derive a valid FVK from a spending key, split it into (ak, nk, rivk),
        // then rebuild from those parts and derive an address — exactly the
        // path a FROST group will take once it has a shared nk/rivk.
        let sk: SpendingKey = Option::<SpendingKey>::from(SpendingKey::from_bytes([7u8; 32]))
            .expect("valid spending key");
        let fvk = FullViewingKey::from(&sk);
        let bytes = fvk.to_bytes();

        let ak: [u8; 32] = bytes[..32].try_into().unwrap();
        let nk: [u8; 32] = bytes[32..64].try_into().unwrap();
        let rivk: [u8; 32] = bytes[64..].try_into().unwrap();

        let addr = orchard_address_from_parts(&ak, &nk, &rivk).unwrap();

        // Sanity: matches the address the FVK derives directly.
        let direct = fvk
            .address_at(0u32, orchard::keys::Scope::External)
            .to_raw_address_bytes();
        assert_eq!(addr, direct);
    }
}
