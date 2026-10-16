import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "../api.js";
import type { VoiceCallConfig } from "./config.js";
import { normalizeDiscordReportTarget } from "./report-config.js";

export async function deliverPostCallReport(params: {
  config: VoiceCallConfig["postCallReport"];
  outboundRuntime?: OpenClawPluginApi["runtime"]["channel"]["outbound"];
  coreConfig: OpenClawConfig;
  text: string;
  isCurrent: () => boolean;
}): Promise<boolean> {
  const delivery = params.config?.discord;
  if (!delivery || !params.outboundRuntime || !params.isCurrent()) {
    return false;
  }
  const target = normalizeDiscordReportTarget(delivery.target);
  if (!target) {
    throw new Error(
      "Post-call Discord report requires an explicit user:<id> or channel:<id> target.",
    );
  }
  const adapter = await params.outboundRuntime.loadAdapter("discord");
  if (!adapter?.sendText || !params.isCurrent()) {
    return false;
  }
  await adapter.sendText({
    cfg: params.coreConfig,
    to: target,
    text: params.text,
    ...(delivery.accountId ? { accountId: delivery.accountId } : {}),
  });
  return true;
}
