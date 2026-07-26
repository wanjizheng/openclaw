// Discord plugin module filters the @discordjs/voice UDP discovery race.
// Upstream UDPDiscovery.performIPDiscovery() can reject its Promise with this exact
// message in a microtask window where the consumer's .then() has not been attached.
// Node 15+ treats such rejections as unhandled and terminates the process, which
// drops in-progress Twilio calls. Anything else is re-raised to preserve the
// default unhandledRejection behavior (process exit) for unrelated failures.
const BENIGN_REJECTION_MESSAGE = "Cannot perform IP discovery - socket closed";

export type UdpDiscoveryRejectionVerdict = "suppress" | "exit";

export function judgeUdpDiscoveryRejection(reason: unknown): UdpDiscoveryRejectionVerdict {
  if (reason instanceof Error && reason.message === BENIGN_REJECTION_MESSAGE) {
    return "suppress";
  }
  return "exit";
}

let installed = false;

export function installUdpDiscoveryGuard(): void {
  if (installed) {
    return;
  }
  installed = true;
  process.on("unhandledRejection", (reason) => {
    if (judgeUdpDiscoveryRejection(reason) === "suppress") {
      console.warn(
        "[discord-voice] suppressed benign UDP discovery rejection:",
        reason instanceof Error ? reason.message : reason,
      );
      return;
    }
    // Replicate Node's default unhandledRejection behavior (terminate) for unrelated failures.
    console.error("[unhandledRejection]", reason);
    process.exit(1);
  });
}
