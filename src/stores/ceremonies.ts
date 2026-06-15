import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface CeremonyEventPayload {
  ceremony_id: string;
  event?: { phase: string; [key: string]: unknown };
  group_id?: string;
  signature_hex?: string | null;
  error?: string;
}

export interface CeremonyState {
  kind: "dkg" | "signing";
  phase: string;
  detail?: Record<string, unknown>;
  done: boolean;
  failed: boolean;
  error?: string;
  groupId?: string;
  signatureHex?: string | null;
}

interface CeremoniesStore {
  ceremonies: Record<string, CeremonyState>;
  /** The DKG ceremony the user is currently following, if any. Tracked in
   *  the store (not screen-local state) so navigating away and back — or even
   *  reloading — keeps the in-progress ceremony attached to the wizard. */
  activeDkgId: string | null;
  activeSigningId: string | null;
  setActiveDkg: (id: string | null) => void;
  setActiveSigning: (id: string | null) => void;
  onProgress: (kind: "dkg" | "signing", payload: CeremonyEventPayload) => void;
  onComplete: (kind: "dkg" | "signing", payload: CeremonyEventPayload) => void;
  onFailed: (kind: "dkg" | "signing", payload: CeremonyEventPayload) => void;
  clear: (ceremonyId: string) => void;
}

export const useCeremonies = create<CeremoniesStore>()(
  persist(
    (set) => ({
      ceremonies: {},
      activeDkgId: null,
      activeSigningId: null,
      setActiveDkg: (id) => set({ activeDkgId: id }),
      setActiveSigning: (id) => set({ activeSigningId: id }),
      onProgress: (kind, payload) =>
        set((s) => ({
          ceremonies: {
            ...s.ceremonies,
            [payload.ceremony_id]: {
              ...s.ceremonies[payload.ceremony_id],
              kind,
              phase: payload.event?.phase ?? "working",
              detail: payload.event,
              done: false,
              failed: false,
            },
          },
        })),
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
              groupId: payload.group_id,
              signatureHex: payload.signature_hex,
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
          return {
            ceremonies: rest,
            activeDkgId: s.activeDkgId === ceremonyId ? null : s.activeDkgId,
            activeSigningId:
              s.activeSigningId === ceremonyId ? null : s.activeSigningId,
          };
        }),
    }),
    {
      name: "frost-ceremonies",
      partialize: (s) => ({
        ceremonies: s.ceremonies,
        activeDkgId: s.activeDkgId,
        activeSigningId: s.activeSigningId,
      }),
    }
  )
);

/** True when a DKG ceremony is running (tracked active id, not yet done). */
export function selectDkgInProgress(s: CeremoniesStore): boolean {
  const id = s.activeDkgId;
  return !!id && !!s.ceremonies[id] && !s.ceremonies[id].done;
}
