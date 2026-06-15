import { useQueryClient } from "@tanstack/react-query";
import { useTauriEvent } from "./ipc/events";
import { useCeremonies, CeremonyEventPayload } from "./stores/ceremonies";

/**
 * Subscribes to ceremony progress events at the app root, so updates land in
 * the global store no matter which screen is mounted. Previously the DKG and
 * signing screens each owned their listeners, so navigating away dropped the
 * subscription and the (still-running) backend ceremony appeared to die.
 *
 * Renders nothing; mounted once inside the unlocked layout.
 */
export default function CeremonyListener() {
  const queryClient = useQueryClient();
  const { onProgress, onComplete, onFailed } = useCeremonies();

  useTauriEvent<CeremonyEventPayload>("dkg:progress", (p) => onProgress("dkg", p));
  useTauriEvent<CeremonyEventPayload>("dkg:complete", (p) => {
    onComplete("dkg", p);
    queryClient.invalidateQueries({ queryKey: ["groups"] });
  });
  useTauriEvent<CeremonyEventPayload>("dkg:failed", (p) => onFailed("dkg", p));

  useTauriEvent<CeremonyEventPayload>("signing:progress", (p) =>
    onProgress("signing", p)
  );
  useTauriEvent<CeremonyEventPayload>("signing:complete", (p) =>
    onComplete("signing", p)
  );
  useTauriEvent<CeremonyEventPayload>("signing:failed", (p) =>
    onFailed("signing", p)
  );

  return null;
}
