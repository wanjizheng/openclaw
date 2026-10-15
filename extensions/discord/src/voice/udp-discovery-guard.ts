// The SDK may reject IP discovery after its UDP socket closes during reconnect.
const CLOSED_DISCOVERY_MESSAGE = "Cannot perform IP discovery - socket closed";

type RejectionListener = (reason: unknown, promise: Promise<unknown>) => void;
type RejectionEvents = {
  on(event: "unhandledRejection", listener: RejectionListener): unknown;
  off(event: "unhandledRejection", listener: RejectionListener): unknown;
};

/** Keep the known reconnect race inside its audio worker's lifetime. */
export function installUdpDiscoveryGuard(
  onFailure: (reason: unknown) => void,
  warn: (message: string) => void,
  events: RejectionEvents = process,
): () => void {
  const listener: RejectionListener = (reason) => {
    if (reason instanceof Error && reason.message === CLOSED_DISCOVERY_MESSAGE) {
      warn("[discord-voice] suppressed UDP discovery rejection after socket close");
      return;
    }
    // Unrelated failures still flow through the worker's error/stop owner.
    onFailure(reason);
  };
  events.on("unhandledRejection", listener);
  return () => events.off("unhandledRejection", listener);
}
