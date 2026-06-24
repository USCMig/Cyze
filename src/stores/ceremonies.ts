import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CeremonyKind = "dkg" | "signing" | "send";

export interface CeremonyEventPayload {
  ceremony_id: string;
  event?: { phase: string; session_id?: string; [key: string]: unknown };
  group_id?: string;
  signature_hex?: string | null;
  signed_pczt_hex?: string;
  txid?: string;
  error?: string;
}

/** Context for a wallet send, captured when it starts so the UI can show what
 *  the group is signing even after navigating away and back. */
export interface SendMeta {
  groupId: string;
  recipient: string;
  amountZatoshis: number;
  feeZatoshis: number;
  sighashHex: string;
}

export interface CeremonyState {
  kind: CeremonyKind;
  phase: string;
  detail?: Record<string, unknown>;
  done: boolean;
  failed: boolean;
  error?: string;
  groupId?: string;
  signatureHex?: string | null;
  /** frostd session id — sticky once seen, so it survives later phases that
   *  no longer carry it. Coordinators share this; participants find it in
   *  their inbox. */
  sessionId?: string;
  /** Send-only: the signed PCZT produced once the group signature is applied. */
  signedPcztHex?: string;
  /** Send-only: the broadcast transaction id, once on-chain. */
  txid?: string;
  /** Send-only: what is being sent. */
  send?: SendMeta;
  /** When the ceremony was started (ms epoch), for ordering history. */
  startedAt?: number;
}

interface CeremoniesStore {
  ceremonies: Record<string, CeremonyState>;
  /** The DKG ceremony the user is currently following, if any. Tracked in
   *  the store (not screen-local state) so navigating away and back — or even
   *  reloading — keeps the in-progress ceremony attached to the wizard. */
  activeDkgId: string | null;
  activeSigningId: string | null;
  /** Active send ceremony per group id, so the wallet screen reattaches to an
   *  in-flight send after navigation. */
  activeSendByGroup: Record<string, string>;
  setActiveDkg: (id: string | null) => void;
  setActiveSigning: (id: string | null) => void;
  /** Register a freshly-started send so it persists and can be reattached. */
  startSend: (ceremonyId: string, meta: SendMeta) => void;
  /** Drop the active send for a group (e.g. to start a new transaction). */
  clearSend: (groupId: string) => void;
  onProgress: (kind: CeremonyKind, payload: CeremonyEventPayload) => void;
  onComplete: (kind: CeremonyKind, payload: CeremonyEventPayload) => void;
  onFailed: (kind: CeremonyKind, payload: CeremonyEventPayload) => void;
  clear: (ceremonyId: string) => void;
}

export const useCeremonies = create<CeremoniesStore>()(
  persist(
    (set) => ({
      ceremonies: {},
      activeDkgId: null,
      activeSigningId: null,
      activeSendByGroup: {},
      setActiveDkg: (id) => set({ activeDkgId: id }),
      setActiveSigning: (id) => set({ activeSigningId: id }),
      startSend: (ceremonyId, meta) =>
        set((s) => ({
          activeSendByGroup: { ...s.activeSendByGroup, [meta.groupId]: ceremonyId },
          ceremonies: {
            ...s.ceremonies,
            [ceremonyId]: {
              kind: "send",
              phase: "connecting",
              done: false,
              failed: false,
              groupId: meta.groupId,
              send: meta,
              startedAt: Date.now(),
            },
          },
        })),
      clearSend: (groupId) =>
        set((s) => {
          const { [groupId]: _removed, ...rest } = s.activeSendByGroup;
          return { activeSendByGroup: rest };
        }),
      onProgress: (kind, payload) =>
        set((s) => {
          const prev = s.ceremonies[payload.ceremony_id];
          return {
            ceremonies: {
              ...s.ceremonies,
              [payload.ceremony_id]: {
                ...prev,
                kind,
                phase: payload.event?.phase ?? "working",
                detail: payload.event,
                // Keep the session id once it appears; later phases omit it.
                sessionId: payload.event?.session_id ?? prev?.sessionId,
                done: false,
                failed: false,
              },
            },
          };
        }),
      onComplete: (kind, payload) =>
        set((s) => ({
          ceremonies: {
            ...s.ceremonies,
            [payload.ceremony_id]: {
              ...s.ceremonies[payload.ceremony_id],
              kind,
              phase: "complete",
              done: true,
              failed: false,
              groupId: payload.group_id ?? s.ceremonies[payload.ceremony_id]?.groupId,
              signatureHex: payload.signature_hex,
              signedPcztHex:
                payload.signed_pczt_hex ??
                s.ceremonies[payload.ceremony_id]?.signedPcztHex,
              txid: payload.txid ?? s.ceremonies[payload.ceremony_id]?.txid,
            },
          },
        })),
      onFailed: (kind, payload) =>
        set((s) => ({
          ceremonies: {
            ...s.ceremonies,
            [payload.ceremony_id]: {
              ...s.ceremonies[payload.ceremony_id],
              kind,
              phase: "failed",
              done: true,
              failed: true,
              error: payload.error,
            },
          },
        })),
      clear: (ceremonyId) =>
        set((s) => {
          const { [ceremonyId]: _removed, ...rest } = s.ceremonies;
          const activeSendByGroup = Object.fromEntries(
            Object.entries(s.activeSendByGroup).filter(([, id]) => id !== ceremonyId)
          );
          return {
            ceremonies: rest,
            activeDkgId: s.activeDkgId === ceremonyId ? null : s.activeDkgId,
            activeSigningId:
              s.activeSigningId === ceremonyId ? null : s.activeSigningId,
            activeSendByGroup,
          };
        }),
    }),
    {
      name: "frost-ceremonies",
      partialize: (s) => ({
        ceremonies: s.ceremonies,
        activeDkgId: s.activeDkgId,
        activeSigningId: s.activeSigningId,
        activeSendByGroup: s.activeSendByGroup,
      }),
    }
  )
);

/** True when a DKG ceremony is running (tracked active id, not yet done). */
export function selectDkgInProgress(s: CeremoniesStore): boolean {
  const id = s.activeDkgId;
  return !!id && !!s.ceremonies[id] && !s.ceremonies[id].done;
}

/** The active send ceremony for a group, if one is registered. */
export function selectActiveSend(
  s: CeremoniesStore,
  groupId: string
): CeremonyState | undefined {
  const id = s.activeSendByGroup[groupId];
  return id ? s.ceremonies[id] : undefined;
}
