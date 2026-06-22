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
            WalletNetwork::Test => "https://testnet.zec.rocks:443",
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

/// Normalize an endpoint: a bare `host:port` (e.g. `tz.ombie.cash:443`) is
/// assumed to be TLS and gets an `https://` scheme.
fn normalize_endpoint(url: &str) -> String {
    let url = url.trim();
    if url.contains("://") {
        url.to_string()
    } else {
        format!("https://{url}")
    }
}

/// Connect a gRPC client to a lightwalletd endpoint (TLS for `https://`).
async fn connect(url: &str) -> Result<CompactTxStreamerClient<Channel>, CoreError> {
    let url = normalize_endpoint(url);
    let mut endpoint = Channel::from_shared(url.clone())
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
use async_trait::async_trait;
use prost::Message;
use zcash_client_backend::data_api::chain::error::Error as ChainError;
use zcash_client_backend::data_api::chain::{BlockCache, BlockSource};
use zcash_client_backend::data_api::scanning::ScanRange;
use zcash_client_backend::data_api::wallet::ConfirmationsPolicy;
use zcash_client_backend::data_api::{AccountBirthday, AccountPurpose, WalletRead, WalletWrite};
use zcash_client_backend::proto::compact_formats::CompactBlock;
use zcash_client_backend::proto::service::{BlockId, ChainSpec};
use zcash_client_sqlite::chain::init::init_blockmeta_db;
use zcash_client_sqlite::chain::BlockMeta;
use zcash_client_sqlite::util::SystemClock;
use zcash_client_sqlite::wallet::init::init_wallet_db;
use zcash_client_sqlite::{FsBlockDb, WalletDb};
use zcash_keys::keys::UnifiedFullViewingKey;
use zcash_primitives::block::BlockHash;
use zcash_protocol::consensus::BlockHeight;

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

/// A `BlockCache` over `FsBlockDb`. `FsBlockDb` ships only `BlockSource`, so we
/// wrap it and add the cache-management methods `sync::run` requires (cache
/// downloaded compact blocks as files on disk, read them back, prune them).
///
/// `FsBlockDb` holds a rusqlite `Connection` (not `Sync`), but `BlockCache`
/// requires `Sync`, so the inner db is behind a `Mutex`. The cache error type is
/// `io::Error` because `FsBlockDbError` does not implement `std::error::Error`,
/// which `sync::run` requires.
struct FsCache {
    inner: std::sync::Mutex<FsBlockDb>,
    blocks_dir: PathBuf,
}

fn io_err(e: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(e.to_string())
}

impl FsCache {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, FsBlockDb>, std::io::Error> {
        self.inner.lock().map_err(|_| io_err("block cache lock poisoned"))
    }
}

impl BlockSource for FsCache {
    type Error = std::io::Error;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let db = self.lock().map_err(ChainError::BlockSource)?;
        let mut height = from_height.unwrap_or_else(|| BlockHeight::from_u32(0));
        let mut remaining = limit.unwrap_or(usize::MAX);
        while remaining > 0 {
            let meta = match db.find_block(height).map_err(|e| ChainError::BlockSource(io_err(e)))? {
                Some(m) => m,
                None => break, // contiguous run ended
            };
            let bytes = std::fs::read(meta.block_file_path(&self.blocks_dir))
                .map_err(ChainError::BlockSource)?;
            let block =
                CompactBlock::decode(&bytes[..]).map_err(|e| ChainError::BlockSource(io_err(e)))?;
            with_block(block)?;
            height = height + 1;
            remaining -= 1;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for FsCache {
    fn get_tip_height(
        &self,
        _range: Option<&ScanRange>,
    ) -> Result<Option<BlockHeight>, Self::Error> {
        self.lock()?.get_max_cached_height().map_err(io_err)
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let range = range.block_range().clone();
        let db = self.lock()?;
        let mut blocks = Vec::new();
        let mut height = range.start;
        while height < range.end {
            match db.find_block(height).map_err(io_err)? {
                Some(meta) => {
                    let bytes = std::fs::read(meta.block_file_path(&self.blocks_dir))?;
                    blocks.push(CompactBlock::decode(&bytes[..]).map_err(io_err)?);
                }
                None => break,
            }
            height = height + 1;
        }
        Ok(blocks)
    }

    async fn insert(&self, compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        let mut metas = Vec::with_capacity(compact_blocks.len());
        for cb in &compact_blocks {
            let meta = BlockMeta {
                height: BlockHeight::from_u32(cb.height as u32),
                block_hash: BlockHash::from_slice(&cb.hash),
                block_time: cb.time,
                sapling_outputs_count: cb.vtx.iter().map(|tx| tx.outputs.len() as u32).sum(),
                orchard_actions_count: cb.vtx.iter().map(|tx| tx.actions.len() as u32).sum(),
            };
            std::fs::write(meta.block_file_path(&self.blocks_dir), cb.encode_to_vec())?;
            metas.push(meta);
        }
        self.lock()?.write_block_metadata(&metas).map_err(io_err)
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        // Remove cached blocks at/above the range start (keep everything below).
        let start = u32::from(range.block_range().start);
        self.lock()?
            .truncate_to_height(BlockHeight::from_u32(start.saturating_sub(1)))
            .map_err(io_err)
    }
}

/// Sync the group's wallet: download and trial-decrypt compact blocks from
/// lightwalletd into the local db. Long-running; touches the network.
pub async fn sync_group(
    data_dir: &Path,
    group_id: &str,
    network: WalletNetwork,
    lightwalletd_url: &str,
) -> Result<(), CoreError> {
    let (db_path, blocks_dir) = wallet_paths(data_dir, group_id);
    std::fs::create_dir_all(&blocks_dir)?;
    let mut db = open_db(&db_path, network)?;

    let mut inner = FsBlockDb::for_path(&blocks_dir)
        .map_err(|e| CoreError::Crypto(format!("block cache: {e}")))?;
    init_blockmeta_db(&mut inner)
        .map_err(|e| CoreError::Crypto(format!("init block cache: {e}")))?;
    let cache = FsCache {
        inner: std::sync::Mutex::new(inner),
        blocks_dir: blocks_dir.clone(),
    };

    let mut client = connect(lightwalletd_url).await?;
    zcash_client_backend::sync::run(&mut client, &network.params(), &cache, &mut db, 1000)
        .await
        .map_err(|e| CoreError::Connection(format!("sync: {e}")))?;
    Ok(())
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
