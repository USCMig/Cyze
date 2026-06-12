import { create } from "zustand";

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
  onProgress: (kind: "dkg" | "signing", payload: CeremonyEventPayload) => void;
  onComplete: (kind: "dkg" | "signing", payload: CeremonyEventPayload) => void;
  onFailed: (kind: "dkg" | "signing", payload: CeremonyEventPayload) => void;
  clear: (ceremonyId: string) => void;
}

export const useCeremonies = create<CeremoniesStore>((set) => ({
  ceremonies: {},
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
      const { [ceremonyId]: _, ...rest } = s.ceremonies;
      return { ceremonies: rest };
    }),
}));
