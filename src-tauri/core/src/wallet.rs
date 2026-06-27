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
use zcash_client_backend::data_api::wallet::{
    create_pczt_from_proposal, propose_standard_transfer_to_address, ConfirmationsPolicy,
};
use zcash_client_backend::data_api::{AccountBirthday, AccountPurpose, WalletRead, WalletWrite};
use zcash_client_backend::fees::StandardFeeRule;
use zcash_client_backend::wallet::OvkPolicy;
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
use zcash_protocol::memo::{Memo, MemoBytes};

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

/// A single shielded/transparent pool's balance, broken into spendable now,
/// pending (maturing or unconfirmed), and total.
#[derive(Debug, Clone, Serialize, Default)]
pub struct PoolBalance {
    /// Confirmed and spendable right now.
    pub spendable_zatoshis: u64,
    /// Received but not yet spendable (awaiting confirmations / maturity).
    pub pending_zatoshis: u64,
    /// spendable + pending.
    pub total_zatoshis: u64,
}

/// Balance + sync status for a group's wallet.
#[derive(Debug, Clone, Serialize)]
pub struct WalletStatus {
    /// Whether the view-only account has been imported yet.
    pub initialized: bool,
    /// Receiving unified address (from the UFVK), for the configured network.
    pub address: Option<String>,
    /// Aggregate totals (kept for back-compat; equal to the Orchard pool since
    /// the group's UFVK is Orchard-only).
    pub total_zatoshis: u64,
    pub spendable_zatoshis: u64,
    /// Per-pool breakdown. With an Orchard-only group UFVK, `sapling` and
    /// `transparent` are zero — the group cannot hold/spend those pools.
    pub orchard: PoolBalance,
    pub sapling: PoolBalance,
    pub transparent: PoolBalance,
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
            orchard: PoolBalance::default(),
            sapling: PoolBalance::default(),
            transparent: PoolBalance::default(),
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
            orchard: PoolBalance::default(),
            sapling: PoolBalance::default(),
            transparent: PoolBalance::default(),
            synced_height: 0,
            chain_tip_height: 0,
        });
    }
    let summary = db
        .get_wallet_summary(ConfirmationsPolicy::default())
        .map_err(|e| CoreError::Crypto(format!("wallet summary: {e}")))?;
    let (total, spendable, orchard, sapling, transparent, synced, tip) = match summary {
        Some(s) => {
            let bal = s.account_balances().values().next();
            let total = bal.map(|b| u64::from(b.total())).unwrap_or(0);
            let spendable = bal.map(|b| u64::from(b.spendable_value())).unwrap_or(0);
            // Per-pool breakdown. Orchard is the only pool the group can hold;
            // sapling/transparent read 0 with an Orchard-only UFVK.
            let orchard = bal.map(|b| pool_balance(b.orchard_balance())).unwrap_or_default();
            let sapling = bal.map(|b| pool_balance(b.sapling_balance())).unwrap_or_default();
            let transparent = bal
                .map(|b| {
                    // Transparent (unshielded) has no maturity concept; treat the
                    // whole unshielded balance as spendable/total.
                    let t = u64::from(b.unshielded_balance().total());
                    PoolBalance {
                        spendable_zatoshis: t,
                        pending_zatoshis: 0,
                        total_zatoshis: t,
                    }
                })
                .unwrap_or_default();
            (
                total,
                spendable,
                orchard,
                sapling,
                transparent,
                u64::from(s.fully_scanned_height()),
                u64::from(s.chain_tip_height()),
            )
        }
        None => (
            0,
            0,
            PoolBalance::default(),
            PoolBalance::default(),
            PoolBalance::default(),
            0,
            0,
        ),
    };
    Ok(WalletStatus {
        initialized: true,
        address,
        total_zatoshis: total,
        spendable_zatoshis: spendable,
        orchard,
        sapling,
        transparent,
        synced_height: synced,
        chain_tip_height: tip,
    })
}

/// Convert a zcash_client_backend shielded-pool `Balance` into our `PoolBalance`.
/// Pending = value awaiting spendability + change awaiting confirmation.
fn pool_balance(b: &zcash_client_backend::data_api::Balance) -> PoolBalance {
    let spendable = u64::from(b.spendable_value());
    let pending = u64::from(b.value_pending_spendability())
        + u64::from(b.change_pending_confirmation());
    PoolBalance {
        spendable_zatoshis: spendable,
        pending_zatoshis: pending,
        total_zatoshis: u64::from(b.total()),
    }
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
        // FsBlockDb stores its compact-block files in `<root>/blocks`, so the
        // cache must read/write there (not the root we passed to `for_path`).
        blocks_dir: blocks_dir.join("blocks"),
    };

    let mut client = connect(lightwalletd_url).await?;
    zcash_client_backend::sync::run(&mut client, &network.params(), &cache, &mut db, 1000)
        .await
        .map_err(|e| CoreError::Connection(format!("sync: {e}")))?;
    Ok(())
}

/// One Orchard spend that the group must FROST-sign: its action index and the
/// per-spend re-randomization value α (hex of the canonical scalar encoding),
/// which becomes the FROST coordinator's `randomizer` for that signature.
#[derive(Debug, Clone, Serialize)]
pub struct SpendToSign {
    pub index: usize,
    pub alpha_hex: String,
}

/// A draft transaction: a built, unsigned PCZT plus the data the FROST signing
/// step needs (the shielded sighash to sign, and each spend's α). Building
/// moves no funds.
#[derive(Debug, Clone, Serialize)]
pub struct DraftTransaction {
    /// Hex of the serialized PCZT, carried into the signing/broadcast step.
    pub pczt_hex: String,
    /// The shielded sighash the group must FROST-sign (hex).
    pub sighash_hex: String,
    /// The Orchard spends to authorize (each FROST-signed with its own α).
    pub spends: Vec<SpendToSign>,
    pub fee_zatoshis: u64,
    pub amount_zatoshis: u64,
    pub recipient: String,
    /// True when the recipient is a transparent address, i.e. this transfer
    /// moves funds out of the group's shielded Orchard pool into the
    /// transparent pool (an "unshield"). The group's Orchard spend is still
    /// FROST-signed exactly as a normal shielded send; only the output differs.
    pub is_unshield: bool,
    /// Optional memo attached to the recipient's shielded output. Encrypted
    /// on-chain; only the recipient's viewing key can decrypt it. Always None
    /// for unshield transfers (transparent outputs carry no memo).
    pub memo: Option<String>,
}

/// Build an unsigned Orchard transfer as a PCZT and return its sighash. Uses
/// the standard ZIP-317 fee and greedy input selection. No signing, no
/// broadcast — this only constructs the transaction.
///
/// Before building, the wallet's chain tip is refreshed from lightwalletd so the
/// transaction's expiry height is anchored to the *current* tip. Otherwise a
/// stale tip yields an expiry that may already be in the past by broadcast time,
/// and the node rejects the tx ("must not be mined at a block height greater
/// than its expiry"). The signing ceremony must still complete within the
/// ~40-block expiry window (≈50 min on testnet) of the build.
pub async fn prepare_send(
    data_dir: &Path,
    group_id: &str,
    network: WalletNetwork,
    recipient: &str,
    amount_zatoshis: u64,
    memo: Option<String>,
    lightwalletd_url: &str,
) -> Result<DraftTransaction, CoreError> {
    use zcash_keys::address::Address;
    use zcash_protocol::value::Zatoshis;
    use zcash_protocol::ShieldedProtocol;

    let params = network.params();
    let (db_path, _) = wallet_paths(data_dir, group_id);
    let mut db = open_db(&db_path, network)?;

    // Anchor the expiry to the live chain tip, not whatever sync last recorded.
    let mut client = connect(lightwalletd_url).await?;
    let tip_height = client
        .get_latest_block(ChainSpec {})
        .await
        .map_err(|e| CoreError::Connection(format!("get_latest_block: {e}")))?
        .into_inner()
        .height;
    db.update_chain_tip(BlockHeight::from_u32(tip_height as u32))
        .map_err(|e| CoreError::Crypto(format!("update chain tip: {e}")))?;

    let account_id = *db
        .get_account_ids()
        .map_err(|e| CoreError::Crypto(format!("wallet accounts: {e}")))?
        .first()
        .ok_or_else(|| CoreError::Crypto("wallet not initialized".into()))?;

    let r = recipient.trim();
    let to = Address::decode(&params, r).ok_or_else(|| {
        // Give a network-mismatch hint when the address prefix clearly belongs
        // to the other network — saves a confusing round-trip for the user.
        let hint = match network {
            WalletNetwork::Main if r.starts_with("utest") || r.starts_with("ztestsapling") =>
                " — this looks like a testnet address but you are on mainnet",
            WalletNetwork::Test if (r.starts_with("u1") || r.starts_with("zs1") || r.starts_with("t1"))
                && !r.starts_with("utest") =>
                " — this looks like a mainnet address but you are on testnet",
            _ => "",
        };
        CoreError::Crypto(format!("invalid recipient address{hint}"))
    })?;
    // A transparent recipient means this is an unshield (Orchard → transparent).
    let is_unshield = matches!(to, Address::Transparent(_));
    let amount =
        Zatoshis::from_u64(amount_zatoshis).map_err(|e| CoreError::Crypto(format!("amount: {e}")))?;

    // Memos are only valid for shielded (Orchard) outputs; transparent outputs
    // carry no memo. Silently drop any memo supplied for an unshield.
    let memo_bytes: Option<MemoBytes> = if is_unshield {
        None
    } else {
        memo.as_deref().filter(|s| !s.is_empty()).map(|s| {
            s.parse::<Memo>()
                .map(|m| m.encode())
                .unwrap_or_else(|_| MemoBytes::empty())
        })
    };

    let proposal = propose_standard_transfer_to_address::<_, _, std::convert::Infallible>(
        &mut db,
        &params,
        StandardFeeRule::Zip317,
        account_id,
        ConfirmationsPolicy::default(),
        &to,
        amount,
        memo_bytes,
        None, // change memo
        ShieldedProtocol::Orchard,
        None, // proposed tx version
    )
    .map_err(|e| CoreError::Ceremony(format!("propose transfer: {e:?}")))?;

    let fee = u64::from(proposal.steps().last().balance().fee_required());

    let pczt = create_pczt_from_proposal::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
        &mut db,
        &params,
        account_id,
        OvkPolicy::Sender,
        &proposal,
    )
    .map_err(|e| CoreError::Ceremony(format!("create pczt: {e:?}")))?;

    let pczt_hex = hex::encode(pczt.serialize());

    let sighash = pczt::roles::signer::Signer::new(pczt.clone())
        .map_err(|e| CoreError::Ceremony(format!("signer: {e:?}")))?
        .shielded_sighash();

    // Read each real Orchard spend's α (the re-randomization the FROST signers
    // must use). Dummy padding actions have zero value and are skipped.
    let spends = orchard_spends_to_sign(pczt)?;

    Ok(DraftTransaction {
        pczt_hex,
        sighash_hex: hex::encode(sighash),
        spends,
        fee_zatoshis: fee,
        amount_zatoshis,
        recipient: recipient.to_string(),
        is_unshield,
        memo: if is_unshield { None } else { memo.filter(|s| !s.is_empty()) },
    })
}

/// Extract the (index, α) of each real Orchard spend in a PCZT. Requires
/// orchard's `unstable-frost` feature (which exposes `spend().alpha()`).
fn orchard_spends_to_sign(pczt: pczt::Pczt) -> Result<Vec<SpendToSign>, CoreError> {
    use ff::PrimeField;
    use orchard::value::NoteValue;

    let mut spends = Vec::new();
    let mut parse_err: Option<String> = None;
    pczt::roles::low_level_signer::Signer::new(pczt)
        .sign_orchard_with(|_pczt, bundle, _| {
            for (index, action) in bundle.actions().iter().enumerate() {
                let is_real = action.spend().value().is_some_and(|v| v != NoteValue::default());
                if let (true, Some(alpha)) = (is_real, action.spend().alpha()) {
                    spends.push(SpendToSign {
                        index,
                        alpha_hex: hex::encode(alpha.to_repr()),
                    });
                }
            }
            Ok::<_, orchard::pczt::ParseError>(())
        })
        .map_err(|e: orchard::pczt::ParseError| {
            parse_err = Some(format!("{e:?}"));
        })
        .ok();
    if let Some(e) = parse_err {
        return Err(CoreError::Ceremony(format!("read orchard spends: {e}")));
    }
    Ok(spends)
}

/// Apply FROST-produced Orchard spend-auth signatures to a draft PCZT, returning
/// the signed PCZT (hex). `signatures` are (spend index, 64-byte sig hex).
pub fn apply_orchard_signatures(
    pczt_hex: &str,
    sighash_hex: &str,
    signatures: Vec<(usize, String)>,
) -> Result<String, CoreError> {
    use orchard::primitives::redpallas::{Signature, SpendAuth};

    let pczt = pczt::Pczt::parse(
        &hex::decode(pczt_hex.trim()).map_err(|e| CoreError::Ceremony(format!("pczt hex: {e}")))?,
    )
    .map_err(|e| CoreError::Ceremony(format!("parse pczt: {e:?}")))?;
    let sighash: [u8; 32] = hex::decode(sighash_hex.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| CoreError::Ceremony("sighash must be 32 bytes hex".into()))?;

    let sigs: Vec<(usize, Signature<SpendAuth>)> = signatures
        .into_iter()
        .map(|(idx, sig_hex)| {
            let bytes: [u8; 64] = hex::decode(sig_hex.trim())
                .ok()
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| CoreError::Ceremony("signature must be 64 bytes hex".into()))?;
            Ok((idx, Signature::<SpendAuth>::from(bytes)))
        })
        .collect::<Result<_, CoreError>>()?;

    let mut apply_err: Option<String> = None;
    let signer = pczt::roles::low_level_signer::Signer::new(pczt)
        .sign_orchard_with(|_pczt, bundle, _| {
            for (idx, sig) in sigs {
                if let Err(e) = bundle.actions_mut()[idx].apply_signature(sighash, sig) {
                    apply_err = Some(format!("spend {idx}: {e:?}"));
                    break;
                }
            }
            Ok::<_, orchard::pczt::ParseError>(())
        })
        .map_err(|e: orchard::pczt::ParseError| CoreError::Ceremony(format!("apply: {e:?}")))?;
    if let Some(e) = apply_err {
        return Err(CoreError::Ceremony(format!("invalid signature for {e}")));
    }
    Ok(hex::encode(signer.finish().serialize()))
}

/// Prove, finalize, and broadcast a fully spend-auth-signed PCZT, returning the
/// transaction id. The Orchard proof step is CPU-heavy (building the proving
/// key takes several seconds), so it runs on a blocking thread.
///
/// This is the final leg of the send pipeline: the group has already applied
/// its threshold signature to every spend ([`apply_orchard_signatures`]); here
/// we attach the zero-knowledge proof, finalize, extract the transaction (which
/// creates the binding signature), and submit it to lightwalletd.
pub async fn broadcast_signed(
    signed_pczt_hex: &str,
    _network: WalletNetwork,
    url: &str,
) -> Result<String, CoreError> {
    let pczt = pczt::Pczt::parse(
        &hex::decode(signed_pczt_hex.trim())
            .map_err(|e| CoreError::Ceremony(format!("pczt hex: {e}")))?,
    )
    .map_err(|e| CoreError::Ceremony(format!("parse pczt: {e:?}")))?;

    // Proving + finalize + extract is synchronous, CPU-bound work; keep it off
    // the async runtime so progress events and other tasks stay responsive.
    let (raw, txid) = tokio::task::spawn_blocking(move || -> Result<(Vec<u8>, String), CoreError> {
        use orchard::circuit::{ProvingKey, VerifyingKey};
        use pczt::roles::{
            prover::Prover, spend_finalizer::SpendFinalizer, tx_extractor::TransactionExtractor,
        };

        // 1. Orchard zero-knowledge proof.
        let pk = ProvingKey::build();
        let pczt = Prover::new(pczt)
            .create_orchard_proof(&pk)
            .map_err(|e| CoreError::Ceremony(format!("orchard proof: {e:?}")))?
            .finish();

        // 2. Finalize spends (spend-auth signatures are already applied).
        let pczt = SpendFinalizer::new(pczt)
            .finalize_spends()
            .map_err(|e| CoreError::Ceremony(format!("finalize spends: {e:?}")))?;

        // 3. Extract the final transaction (creates the binding signature).
        let vk = VerifyingKey::build();
        let tx = TransactionExtractor::new(pczt)
            .with_orchard(&vk)
            .extract()
            .map_err(|e| CoreError::Ceremony(format!("extract transaction: {e:?}")))?;

        let txid = format!("{}", tx.txid());
        let mut raw = Vec::new();
        tx.write(&mut raw)
            .map_err(|e| CoreError::Ceremony(format!("serialize transaction: {e}")))?;
        Ok((raw, txid))
    })
    .await
    .map_err(|e| CoreError::Ceremony(format!("proving task panicked: {e}")))??;

    // 4. Submit to lightwalletd.
    let mut client = connect(url).await?;
    let resp = client
        .send_transaction(zcash_client_backend::proto::service::RawTransaction { data: raw, height: 0 })
        .await
        .map_err(|e| CoreError::Connection(format!("send_transaction: {e}")))?
        .into_inner();
    if resp.error_code != 0 {
        return Err(CoreError::Connection(format!(
            "lightwalletd rejected the transaction (code {}): {}",
            resp.error_code, resp.error_message
        )));
    }
    Ok(txid)
}

/// A single transaction as seen from this wallet's perspective.
#[derive(Debug, Clone, Serialize)]
pub struct TxRecord {
    /// Transaction ID, hex, in display order (bytes reversed vs. on-disk storage).
    pub txid: String,
    /// Block height when mined; `None` for pending/unconfirmed.
    pub block_height: Option<u64>,
    /// Unix timestamp (seconds since epoch) from the mined block; `None` when unconfirmed.
    pub timestamp: Option<i64>,
    /// `"receive"` or `"send"`.
    pub direction: String,
    /// Value in zatoshis (always positive; for sends this is the total value
    /// of the output(s) created, not including change returned to the wallet).
    pub amount_zatoshis: u64,
    /// Network fee paid, if known (only present for sends created by this wallet).
    pub fee_zatoshis: Option<u64>,
    /// Decoded memo text, if one was attached to this transaction.
    pub memo: Option<String>,
    /// Recipient unified address for sends; `None` for self-transfers (note consolidation).
    pub recipient: Option<String>,
}

/// Read on-chain transaction history for a group's wallet — received funds and
/// sent transactions, newest confirmed first.
///
/// Uses direct SQLite queries because `zcash_client_backend 0.23` exposes no
/// clean transaction-list API on `WalletRead`. The tables queried are stable
/// parts of `zcash_client_sqlite`'s schema: `transactions`, `accounts`,
/// `orchard_received_notes`, and `sent_notes`.
pub fn wallet_history(
    data_dir: &Path,
    group_id: &str,
) -> Result<Vec<TxRecord>, CoreError> {
    let (db_path, _) = wallet_paths(data_dir, group_id);
    if !db_path.exists() {
        return Ok(vec![]);
    }

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| CoreError::Crypto(format!("open wallet db: {e}")))?;

    // There is at most one account per group wallet.
    use rusqlite::OptionalExtension;
    let account_id: Option<i64> = conn
        .query_row("SELECT id FROM accounts LIMIT 1", [], |row| row.get(0))
        .optional()
        .map_err(|e| CoreError::Crypto(format!("get account id: {e}")))?;
    let Some(account_id) = account_id else {
        return Ok(vec![]);
    };

    let mut records: Vec<TxRecord> = Vec::new();

    // ── Received ────────────────────────────────────────────────────────────
    // Orchard notes for our account that are not change (is_change = 0 means
    // this note arrived in a transaction that we did NOT also spend from —
    // i.e., someone else sent us funds). Group by transaction so one tx = one
    // history entry, sum the note values, and pick the first real memo.
    {
        let mut stmt = conn
            .prepare(
                "SELECT t.txid, t.mined_height, b.time, SUM(orn.value), \
                 ( SELECT orn2.memo \
                   FROM orchard_received_notes orn2 \
                   WHERE orn2.transaction_id = t.id_tx \
                     AND orn2.account_id = ?1 \
                     AND orn2.is_change = 0 \
                     AND orn2.memo IS NOT NULL \
                   LIMIT 1 ) \
                 FROM orchard_received_notes orn \
                 JOIN transactions t ON orn.transaction_id = t.id_tx \
                 LEFT JOIN blocks b ON b.height = t.mined_height \
                 WHERE orn.account_id = ?1 AND orn.is_change = 0 \
                 GROUP BY t.id_tx \
                 HAVING SUM(orn.value) > 0 \
                 ORDER BY t.mined_height DESC NULLS LAST",
            )
            .map_err(|e| CoreError::Crypto(format!("prepare receive query: {e}")))?;

        let rows = stmt
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Option<u64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, u64>(3)?,
                    row.get::<_, Option<Vec<u8>>>(4)?,
                ))
            })
            .map_err(|e| CoreError::Crypto(format!("execute receive query: {e}")))?;

        for row in rows {
            let (mut txid_bytes, block_height, timestamp, amount, memo_bytes) =
                row.map_err(|e| CoreError::Crypto(format!("receive row: {e}")))?;
            // zcash_client_sqlite stores txid in internal byte order; the
            // conventional display representation (block explorers, CLI) is
            // byte-reversed.
            txid_bytes.reverse();
            records.push(TxRecord {
                txid: hex::encode(&txid_bytes),
                block_height,
                timestamp,
                direction: "receive".to_string(),
                amount_zatoshis: amount,
                fee_zatoshis: None,
                memo: memo_bytes.as_deref().and_then(decode_zcash_memo),
                recipient: None,
            });
        }
    }

    // ── Sent ────────────────────────────────────────────────────────────────
    // Rows in `sent_notes` where our account was the sender. Group by
    // transaction; summing values gives total sent (not including change, which
    // is modelled as a received note with is_change = 1 and never appears in
    // sent_notes). The recipient is `to_address`; NULL means the output went
    // back to this same wallet (self-transfer / consolidation).
    {
        let mut stmt = conn
            .prepare(
                "SELECT t.txid, t.mined_height, b.time, t.fee, SUM(sn.value), \
                 MAX(sn.to_address), \
                 MAX(CASE WHEN sn.to_account_id IS NULL THEN 1 ELSE 0 END) AS has_external, \
                 ( SELECT sn2.memo \
                   FROM sent_notes sn2 \
                   WHERE sn2.transaction_id = t.id_tx \
                     AND sn2.from_account_id = ?1 \
                     AND sn2.memo IS NOT NULL \
                   LIMIT 1 ) \
                 FROM sent_notes sn \
                 JOIN transactions t ON sn.transaction_id = t.id_tx \
                 LEFT JOIN blocks b ON b.height = t.mined_height \
                 WHERE sn.from_account_id = ?1 \
                 GROUP BY t.id_tx \
                 ORDER BY t.mined_height DESC NULLS LAST",
            )
            .map_err(|e| CoreError::Crypto(format!("prepare send query: {e}")))?;

        let rows = stmt
            .query_map([account_id], |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Option<u64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<u64>>(3)?,
                    row.get::<_, u64>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                ))
            })
            .map_err(|e| CoreError::Crypto(format!("execute send query: {e}")))?;

        for row in rows {
            let (mut txid_bytes, block_height, timestamp, fee, amount, to_address, has_external, memo_bytes) =
                row.map_err(|e| CoreError::Crypto(format!("send row: {e}")))?;
            txid_bytes.reverse();
            // has_external = 1 means at least one output went to an external recipient
            // (to_account_id IS NULL). When false with a null to_address it's a
            // true self-transfer (note consolidation within the same wallet).
            let is_self_transfer = has_external == 0 && to_address.is_none();
            records.push(TxRecord {
                txid: hex::encode(&txid_bytes),
                block_height,
                timestamp,
                direction: if is_self_transfer { "self".to_string() } else { "send".to_string() },
                amount_zatoshis: amount,
                fee_zatoshis: fee,
                memo: memo_bytes.as_deref().and_then(decode_zcash_memo),
                recipient: to_address,
            });
        }
    }

    // Merge and sort: confirmed newest first, then pending (no block).
    records.sort_by(|a, b| match (b.block_height, a.block_height) {
        (Some(bh), Some(ah)) => bh.cmp(&ah),
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });

    Ok(records)
}

/// Decode a raw Zcash memo blob (up to 512 bytes) to a UTF-8 string.
/// The 0xF6 sentinel byte signals an explicitly empty memo; all-zero padding
/// is also treated as absent. Returns `None` for either case.
fn decode_zcash_memo(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes[0] == 0xF6 {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_end_matches('\0').trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
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
