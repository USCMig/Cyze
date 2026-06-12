import { invoke } from "@tauri-apps/api/core";

export interface AppError {
  code: string;
  message: string;
}

export interface KeystoreStatus {
  exists: boolean;
  unlocked: boolean;
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

// Keystore
export const keystoreStatus = () => invoke<KeystoreStatus>("keystore_status");
export const createKeystore = (passphrase: string) =>
  invoke<void>("create_keystore", { passphrase });
export const importUpstreamConfig = (path: string | null, passphrase: string) =>
  invoke<void>("import_upstream_config", { path, passphrase });
export const unlockKeystore = (passphrase: string) =>
  invoke<void>("unlock_keystore", { passphrase });
export const lockKeystore = () => invoke<void>("lock_keystore");
export const changePassphrase = (oldPassphrase: string, newPassphrase: string) =>
  invoke<void>("change_passphrase", { oldPassphrase, newPassphrase });

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
