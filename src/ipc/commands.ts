import { invoke } from "@tauri-apps/api/core";

export interface AppError {
  code: string;
  message: string;
}

export interface KeystoreStatus {
  exists: boolean;
  unlocked: boolean;
  recovery_enabled: boolean;
}

export interface ContactDto {
  name: string;
  pubkey: string;
  text: string;
}

export interface GroupSummary {
  id: string;
  description: string;
  ciphersuite: string;
  threshold: number;
  num_participants: number;
  server_url: string | null;
  participants: Record<string, string>;
}

export interface Settings {
  server_url: string | null;
  sidecar_port: number | null;
  trusted_certs: Record<string, string>;
}

export interface SidecarStatus {
  running: boolean;
  port: number | null;
  url: string | null;
  cert_fingerprint: string | null;
  lan_addresses: string[];
}

export interface ConnectionTestResult {
  ok: boolean;
  error: string | null;
}

export interface TunnelStatus {
  running: boolean;
  public_url: string | null;
  port: number | null;
}

// Keystore
export const keystoreStatus = () => invoke<KeystoreStatus>("keystore_status");
/** Returns the one-time 12-word recovery phrase to back up. */
export const createKeystore = (passphrase: string) =>
  invoke<string>("create_keystore", { passphrase });
/** Returns the one-time 12-word recovery phrase to back up. */
export const importUpstreamConfig = (path: string | null, passphrase: string) =>
  invoke<string>("import_upstream_config", { path, passphrase });
export const unlockKeystore = (passphrase: string) =>
  invoke<void>("unlock_keystore", { passphrase });
/** Forgotten-passphrase recovery: unlock with the recovery phrase and set a new passphrase. */
export const recoverKeystore = (recoveryPhrase: string, newPassphrase: string) =>
  invoke<void>("recover_keystore", { recoveryPhrase, newPassphrase });
export const lockKeystore = () => invoke<void>("lock_keystore");
export const changePassphrase = (oldPassphrase: string, newPassphrase: string) =>
  invoke<void>("change_passphrase", { oldPassphrase, newPassphrase });
/** Generate a recovery code for a keystore that lacks one. Returns the phrase. */
export const generateRecoveryCode = () =>
  invoke<string>("generate_recovery_code");

// Contacts
export const listContacts = () => invoke<ContactDto[]>("list_contacts");
export const addContact = (text: string) => invoke<ContactDto>("add_contact", { text });
export const removeContact = (pubkey: string) => invoke<void>("remove_contact", { pubkey });
export const exportMyContact = (name: string) =>
  invoke<ContactDto>("export_my_contact", { name });

// Groups
export const listGroups = () => invoke<GroupSummary[]>("list_groups");
export const removeGroup = (id: string) => invoke<void>("remove_group", { id });

// Server / sidecar
export const getSettings = () => invoke<Settings>("get_settings");
export const setServerUrl = (url: string) => invoke<void>("set_server_url", { url });
export const testServerConnection = (url: string) =>
  invoke<ConnectionTestResult>("test_server_connection", { url });
export const trustServerCert = (url: string, certPem: string) =>
  invoke<string>("trust_server_cert", { url, certPem });
export const startSidecar = (port: number | null) =>
  invoke<SidecarStatus>("start_sidecar", { port });
export const stopSidecar = () => invoke<void>("stop_sidecar");
export const sidecarStatus = () => invoke<SidecarStatus>("sidecar_status");
export const exportSidecarCert = () => invoke<string>("export_sidecar_cert");
export const startTunnel = () => invoke<TunnelStatus>("start_tunnel");
export const stopTunnel = () => invoke<void>("stop_tunnel");
export const tunnelStatus = () => invoke<TunnelStatus>("tunnel_status");

// Ceremonies
export type Ciphersuite = "ed25519" | "redpallas";

export interface StartDkgArgs {
  suite: Ciphersuite;
  description: string;
  threshold: number;
  participants: string[];
  server_url: string | null;
  session_id: string | null;
}

export interface PendingSession {
  session_id: string;
  coordinator: string | null;
  coordinator_pubkey: string;
  matching_groups: string[];
}

export const startDkg = (args: StartDkgArgs) => invoke<string>("start_dkg", { args });
export const cancelCeremony = (ceremonyId: string) =>
  invoke<void>("cancel_ceremony", { ceremonyId });
export const createSigningSession = (args: {
  group_id: string;
  message_hex: string;
  signers: string[];
  server_url: string | null;
}) => invoke<string>("create_signing_session", { args });
export const joinSigningSession = (args: {
  group_id: string;
  session_id: string;
  server_url: string | null;
}) => invoke<string>("join_signing_session", { args });
export const respondToSigning = (ceremonyId: string, approve: boolean) =>
  invoke<void>("respond_to_signing", { ceremonyId, approve });
export const listPendingSessions = (serverUrl: string | null) =>
  invoke<PendingSession[]>("list_pending_sessions", { serverUrl });
