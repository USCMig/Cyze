//! Zcash light-client wallet (feature `wallet`).
//!
//! Phase 5.1, layer 1: lightwalletd connectivity. Connects to a configurable
//! lightwalletd endpoint over gRPC/TLS and fetches chain info — the foundation
//! the per-group sync + balance build on. Network is selectable (testnet for
//! testing, mainnet once the pipeline is complete).
//!
//! Compact-block sync, account import, and balance reads layer on top of this
//! `CompactTxStreamerClient` in the next increment.

use serde::{Deserialize, Serialize};
use tonic::transport::{Channel, ClientTlsConfig};
use zcash_client_backend::proto::service::{
    compact_tx_streamer_client::CompactTxStreamerClient, Empty,
};
use zcash_protocol::consensus::Network;

use crate::error::CoreError;

/// Which Zcash network the wallet operates on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WalletNetwork {
    Test,
    Main,
}

impl WalletNetwork {
    pub fn from_str(s: &str) -> Self {
        match s {
            "main" => WalletNetwork::Main,
            _ => WalletNetwork::Test,
        }
    }

    /// The consensus parameters for this network (used by sync/address logic).
    pub fn params(self) -> Network {
        match self {
            WalletNetwork::Test => Network::TestNetwork,
            WalletNetwork::Main => Network::MainNetwork,
        }
    }

    /// The address/key encoding network type.
    pub fn network_type(self) -> zcash_protocol::consensus::NetworkType {
        match self {
            WalletNetwork::Test => zcash_protocol::consensus::NetworkType::Test,
            WalletNetwork::Main => zcash_protocol::consensus::NetworkType::Main,
        }
    }

    /// A sensible default public lightwalletd endpoint for this network.
    pub fn default_lightwalletd(self) -> &'static str {
        match self {
            WalletNetwork::Test => "https://lightwalletd.testnet.electriccoin.co:9067",
            WalletNetwork::Main => "https://zec.rocks:443",
        }
    }
}

/// Chain info reported by a lightwalletd server (a connectivity probe).
#[derive(Debug, Clone, Serialize)]
pub struct LightwalletdInfo {
    pub chain_name: String,
    pub block_height: u64,
    pub estimated_height: u64,
    pub vendor: String,
    pub version: String,
}

/// Connect a gRPC client to a lightwalletd endpoint (TLS for `https://`).
async fn connect(url: &str) -> Result<CompactTxStreamerClient<Channel>, CoreError> {
    let mut endpoint = Channel::from_shared(url.to_string())
        .map_err(|e| CoreError::Connection(format!("invalid lightwalletd URL: {e}")))?;
    if url.starts_with("https://") {
        endpoint = endpoint
            .tls_config(ClientTlsConfig::new().with_webpki_roots())
            .map_err(|e| CoreError::Connection(format!("TLS config: {e}")))?;
    }
    let channel = endpoint
        .connect()
        .await
        .map_err(|e| CoreError::Connection(format!("connecting to {url}: {e}")))?;
    Ok(CompactTxStreamerClient::new(channel))
}

/// Fetch chain info from a lightwalletd endpoint — used to verify reachability
/// and show the current chain height before syncing.
pub async fn lightwalletd_info(url: &str) -> Result<LightwalletdInfo, CoreError> {
    let mut client = connect(url).await?;
    let info = client
        .get_lightd_info(Empty {})
        .await
        .map_err(|e| CoreError::Connection(format!("get_lightd_info: {e}")))?
        .into_inner();
    Ok(LightwalletdInfo {
        chain_name: info.chain_name,
        block_height: info.block_height,
        estimated_height: info.estimated_height,
        vendor: info.vendor,
        version: info.version,
    })
}

// ---------------------------------------------------------------------------
// Per-group wallet: sqlite-backed account, sync, and balance.
//
// Each FROST group is one view-only Orchard account, stored in its own sqlite
// wallet under `<data_dir>/wallets/<group_id>/`. The group's UFVK (derived from
// its `ak`) is imported as a watch-only account; sync trial-decrypts compact
// blocks locally; balance is read from the wallet db.
// ---------------------------------------------------------------------------

use std::path::{Path, PathBuf};

use rand::rngs::OsRng;
use zcash_client_backend::data_api::wallet::ConfirmationsPolicy;
use zcash_client_backend::data_api::{AccountBirthday, AccountPurpose, WalletRead, WalletWrite};
use zcash_client_backend::proto::service::{BlockId, ChainSpec};
use zcash_client_sqlite::util::SystemClock;
use zcash_client_sqlite::wallet::init::init_wallet_db;
use zcash_client_sqlite::WalletDb;
use zcash_keys::keys::UnifiedFullViewingKey;

type GroupDb = WalletDb<rusqlite::Connection, Network, SystemClock, OsRng>;

/// `(wallet.sqlite path, fsblockdb dir)` for a group.
fn wallet_paths(data_dir: &Path, group_id: &str) -> (PathBuf, PathBuf) {
    let base = data_dir.join("wallets").join(group_id);
    (base.join("wallet.sqlite"), base.join("blocks"))
}

fn open_db(db_path: &Path, network: WalletNetwork) -> Result<GroupDb, CoreError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut db = WalletDb::for_path(db_path, network.params(), SystemClock, OsRng)
        .map_err(|e| CoreError::Crypto(format!("open wallet db: {e}")))?;
    init_wallet_db(&mut db, None)
        .map_err(|e| CoreError::Crypto(format!("init wallet db: {e}")))?;
    Ok(db)
}

/// Balance + sync status for a group's wallet.
#[derive(Debug, Clone, Serialize)]
pub struct WalletStatus {
    /// Whether the view-only account has been imported yet.
    pub initialized: bool,
    /// Receiving unified address (from the UFVK), for the configured network.
    pub address: Option<String>,
    pub total_zatoshis: u64,
    pub spendable_zatoshis: u64,
    /// Highest fully-scanned block, and the chain tip the wallet knows about.
    pub synced_height: u64,
    pub chain_tip_height: u64,
}

/// Read a group's wallet status from its local db (no network).
pub fn group_status(
    data_dir: &Path,
    group_id: &str,
    network: WalletNetwork,
    ufvk: &str,
) -> Result<WalletStatus, CoreError> {
    let (db_path, _) = wallet_paths(data_dir, group_id);
    let address = ufvk_default_address(network, ufvk).ok();
    if !db_path.exists() {
        return Ok(WalletStatus {
            initialized: false,
            address,
            total_zatoshis: 0,
            spendable_zatoshis: 0,
            synced_height: 0,
            chain_tip_height: 0,
        });
    }
    let db = open_db(&db_path, network)?;
    let account_ids = db
        .get_account_ids()
        .map_err(|e| CoreError::Crypto(format!("wallet accounts: {e}")))?;
    if account_ids.is_empty() {
        return Ok(WalletStatus {
            initialized: false,
            address,
            total_zatoshis: 0,
            spendable_zatoshis: 0,
            synced_height: 0,
            chain_tip_height: 0,
        });
    }
    let summary = db
        .get_wallet_summary(ConfirmationsPolicy::default())
        .map_err(|e| CoreError::Crypto(format!("wallet summary: {e}")))?;
    let (total, spendable, synced, tip) = match summary {
        Some(s) => {
            let bal = s.account_balances().values().next();
            let total = bal.map(|b| u64::from(b.total())).unwrap_or(0);
            let spendable = bal.map(|b| u64::from(b.spendable_value())).unwrap_or(0);
            (
                total,
                spendable,
                u64::from(s.fully_scanned_height()),
                u64::from(s.chain_tip_height()),
            )
        }
        None => (0, 0, 0, 0),
    };
    Ok(WalletStatus {
        initialized: true,
        address,
        total_zatoshis: total,
        spendable_zatoshis: spendable,
        synced_height: synced,
        chain_tip_height: tip,
    })
}

/// Import the group's UFVK as a view-only account, with its birthday set to the
/// current chain tip (no prior funds). Idempotent: a no-op if already imported.
/// Returns the birthday height. Touches the network (fetches a treestate).
pub async fn init_group_account(
    data_dir: &Path,
    group_id: &str,
    network: WalletNetwork,
    ufvk_str: &str,
    lightwalletd_url: &str,
) -> Result<u64, CoreError> {
    let (db_path, _) = wallet_paths(data_dir, group_id);
    let mut db = open_db(&db_path, network)?;
    if !db
        .get_account_ids()
        .map_err(|e| CoreError::Crypto(format!("wallet accounts: {e}")))?
        .is_empty()
    {
        return Ok(0); // already imported
    }

    let params = network.params();
    let ufvk = UnifiedFullViewingKey::decode(&params, ufvk_str)
        .map_err(|e| CoreError::Crypto(format!("invalid UFVK: {e}")))?;

    // Birthday = current chain tip; the account starts watching from now.
    let mut client = connect(lightwalletd_url).await?;
    let tip = client
        .get_latest_block(ChainSpec {})
        .await
        .map_err(|e| CoreError::Connection(format!("get_latest_block: {e}")))?
        .into_inner();
    let treestate = client
        .get_tree_state(BlockId {
            height: tip.height,
            hash: vec![],
        })
        .await
        .map_err(|e| CoreError::Connection(format!("get_tree_state: {e}")))?
        .into_inner();
    let birthday = AccountBirthday::from_treestate(treestate, None)
        .map_err(|_| CoreError::Crypto("could not derive account birthday from treestate".into()))?;

    db.import_account_ufvk(group_id, &ufvk, &birthday, AccountPurpose::ViewOnly, None)
        .map_err(|e| CoreError::Crypto(format!("import account: {e}")))?;
    Ok(tip.height)
}

/// The receiving unified address for a UFVK string, encoded for `network`.
/// This is what the wallet's account would expose for receiving funds.
pub fn ufvk_default_address(network: WalletNetwork, ufvk: &str) -> Result<String, CoreError> {
    use zcash_keys::keys::{UnifiedAddressRequest, UnifiedFullViewingKey};
    let params = network.params();
    let ufvk = UnifiedFullViewingKey::decode(&params, ufvk)
        .map_err(|e| CoreError::Crypto(format!("invalid UFVK: {e}")))?;
    let (address, _) = ufvk
        .default_address(UnifiedAddressRequest::AllAvailableKeys)
        .map_err(|e| CoreError::Crypto(format!("address generation: {e}")))?;
    Ok(address.encode(&params))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_params_and_defaults() {
        assert_eq!(WalletNetwork::Test.params(), Network::TestNetwork);
        assert_eq!(WalletNetwork::Main.params(), Network::MainNetwork);
        assert!(WalletNetwork::Test.default_lightwalletd().starts_with("https://"));
        assert!(WalletNetwork::Main.default_lightwalletd().starts_with("https://"));
    }

    /// The receive address the wallet's key crate (`zcash_keys`) derives from
    /// our group UFVK must equal the address our derivation produced — proving
    /// our deterministically-derived keys are standard, wallet-usable Orchard
    /// keys, on both networks.
    #[test]
    fn ufvk_round_trips_to_our_address() {
        use orchard::keys::{FullViewingKey, SpendingKey};
        let sk = Option::<SpendingKey>::from(SpendingKey::from_bytes([9u8; 32])).unwrap();
        let ak: [u8; 32] = FullViewingKey::from(&sk).to_bytes()[..32].try_into().unwrap();

        for net in [WalletNetwork::Test, WalletNetwork::Main] {
            let keys = crate::zcash::derive_orchard_keys(&ak, net.network_type()).unwrap();
            let addr = ufvk_default_address(net, &keys.ufvk).unwrap();
            assert_eq!(addr, keys.address, "zcash_keys must agree on {net:?}");
        }
    }
}
