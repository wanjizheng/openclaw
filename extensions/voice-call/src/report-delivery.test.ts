import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { normalizeDiscordReportTarget } from "./report-config.js";
import { deliverPostCallReport } from "./report-delivery.js";

type DeliveryParams = Parameters<typeof deliverPostCallReport>[0];
type OutboundRuntime = NonNullable<DeliveryParams["outboundRuntime"]>;
type Adapter = NonNullable<Awaited<ReturnType<OutboundRuntime["loadAdapter"]>>>;

function fixture() {
  const sendText = vi.fn<NonNullable<Adapter["sendText"]>>(async () => ({
    channel: "discord",
    messageId: "synthetic-report",
  }));
  const loadAdapter = vi.fn<OutboundRuntime["loadAdapter"]>(async () => ({
    deliveryMode: "direct",
    sendText,
  }));
  return { sendText, loadAdapter, outboundRuntime: { loadAdapter } };
}

const allowFromForms = [
  "*",
  "123456789012345678",
  "user:123456789012345678",
  "discord:123456789012345678",
  "discord:user:123456789012345678",
  "<@123456789012345678>",
  "<@!123456789012345678>",
  "access-group:operators",
];

describe("explicit post-call report delivery", () => {
  it.each(allowFromForms)(
    "keeps reports local with allowFrom=%s and no report target",
    async (allowed) => {
      const { loadAdapter, sendText, outboundRuntime } = fixture();
      expect(
        await deliverPostCallReport({
          config: undefined,
          outboundRuntime,
          coreConfig: { channels: { discord: { allowFrom: [allowed] } } },
          text: "private call report",
          isCurrent: () => true,
        }),
      ).toBe(false);
      expect(loadAdapter).not.toHaveBeenCalled();
      expect(sendText).not.toHaveBeenCalled();
    },
  );

  it.each(allowFromForms)(
    "never substitutes allowFrom=%s for an explicit target",
    async (allowed) => {
      const { sendText, outboundRuntime } = fixture();
      const coreConfig = { channels: { discord: { allowFrom: [allowed] } } };
      const config = VoiceCallConfigSchema.parse({
        postCallReport: {
          discord: { target: "discord:channel:987654321098765432", accountId: "reports" },
        },
      }).postCallReport;
      expect(
        await deliverPostCallReport({
          config,
          outboundRuntime,
          coreConfig,
          text: "report",
          isCurrent: () => true,
        }),
      ).toBe(true);
      expect(sendText).toHaveBeenCalledWith({
        cfg: coreConfig,
        to: "channel:987654321098765432",
        accountId: "reports",
        text: "report",
      });
    },
  );

  it.each(["user:123", "channel:123", "discord:user:123", "discord:channel:123"])(
    "canonicalizes %s without duplicating prefixes",
    async (target) => {
      const { sendText, outboundRuntime } = fixture();
      const config = VoiceCallConfigSchema.parse({
        postCallReport: { discord: { target } },
      }).postCallReport;
      expect(
        await deliverPostCallReport({
          config,
          outboundRuntime,
          coreConfig: {},
          text: "report",
          isCurrent: () => true,
        }),
      ).toBe(true);
      expect(sendText).toHaveBeenCalledWith({
        cfg: {},
        to: target.replace(/^discord:/, ""),
        text: "report",
      });
    },
  );

  it("revalidates service generation after loading the adapter", async () => {
    const { sendText, loadAdapter, outboundRuntime } = fixture();
    let current = true;
    loadAdapter.mockImplementationOnce(async () => {
      current = false;
      return { deliveryMode: "direct", sendText };
    });
    expect(
      await deliverPostCallReport({
        config: { discord: { target: "user:123" } },
        outboundRuntime,
        coreConfig: {},
        text: "report",
        isCurrent: () => current,
      }),
    ).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
  });

  it.each([
    "*",
    "user:*",
    "channel:*",
    "123",
    "discord:123",
    "access-group:operators",
    "user:123,user:456",
    "user:123 user:456",
    "user:alice",
    "channel:general",
    "<@123>",
    "<@!123>",
    "<#123>",
    "discord:discord:user:123",
    "",
  ])("rejects ambiguous or policy-like report target %s", (target) => {
    expect(normalizeDiscordReportTarget(target)).toBeUndefined();
    expect(
      VoiceCallConfigSchema.safeParse({ postCallReport: { discord: { target } } }).success,
    ).toBe(false);
  });

  it("rejects recipient lists, access policy fields and invalid explicit accounts", () => {
    for (const discord of [
      { target: ["user:123", "user:456"] },
      { target: "user:123", allowFrom: ["*"] },
      { target: "user:123", accountId: "*" },
      { target: "user:123", accountId: "" },
    ]) {
      expect(VoiceCallConfigSchema.safeParse({ postCallReport: { discord } }).success).toBe(false);
    }
  });
});
