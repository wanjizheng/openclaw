// Discord plugin module implements sdk runtime behavior.
import { createRequire } from "node:module";
import { installUdpDiscoveryGuard } from "./udp-discovery-guard.js";

// Install guard before loadDiscordVoiceSdk() can surface the upstream UDP discovery race.
installUdpDiscoveryGuard();

type DiscordVoiceSdk = typeof import("@discordjs/voice");

let cachedDiscordVoiceSdk: DiscordVoiceSdk | null = null;

export function loadDiscordVoiceSdk(): DiscordVoiceSdk {
  if (cachedDiscordVoiceSdk) {
    return cachedDiscordVoiceSdk;
  }
  const req = createRequire(import.meta.url);
  cachedDiscordVoiceSdk = req("@discordjs/voice") as DiscordVoiceSdk;
  return cachedDiscordVoiceSdk;
}
