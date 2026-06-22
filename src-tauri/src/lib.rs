pub mod commands;
pub mod error;
pub mod sidecar;
pub mod state;
pub mod tunnel;

use state::AppState;
use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::keystore::keystore_status,
            commands::keystore::create_keystore,
            commands::keystore::import_upstream_config,
            commands::keystore::unlock_keystore,
            commands::keystore::recover_keystore,
            commands::keystore::lock_keystore,
            commands::keystore::change_passphrase,
            commands::keystore::generate_recovery_code,
            commands::keystore::get_identity,
            commands::keystore::set_username,
            commands::contacts::list_contacts,
            commands::contacts::add_contact,
            commands::contacts::remove_contact,
            commands::contacts::set_contact_alias,
            commands::contacts::export_my_contact,
            commands::groups::list_groups,
            commands::groups::group_orchard_keys,
            commands::groups::remove_group,
            commands::wallet::get_wallet_config,
            commands::wallet::set_wallet_config,
            commands::wallet::lightwalletd_info,
            commands::wallet::wallet_group_status,
            commands::wallet::wallet_init_account,
            commands::server::get_settings,
            commands::server::set_server_url,
            commands::server::test_server_connection,
            commands::server::trust_server_cert,
            commands::server::cert_fingerprint_of,
            commands::server::start_sidecar,
            commands::server::stop_sidecar,
            commands::server::sidecar_status,
            commands::server::export_sidecar_cert,
            commands::server::start_tunnel,
            commands::server::stop_tunnel,
            commands::server::tunnel_status,
            commands::dkg::start_dkg,
            commands::dkg::cancel_ceremony,
            commands::signing::create_signing_session,
            commands::signing::join_signing_session,
            commands::signing::respond_to_signing,
            commands::signing::list_pending_sessions,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Make sure the frostd child does not outlive the app.
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut guard) = state.sidecar.try_lock() {
                        if let Some(handle) = guard.take() {
                            let _ = handle.child.kill();
                        }
                    }
                    if let Ok(mut guard) = state.tunnel.try_lock() {
                        if let Some(mut handle) = guard.take() {
                            let _ = handle.child.start_kill();
                        }
                    }
                }
            }
        });
}
