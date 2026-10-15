import { normalizeOptionalAccountId } from "openclaw/plugin-sdk/routing";
import { z } from "zod";

// Discord's public parser recognizes explicit user/channel and provider-prefixed targets.
// Require numeric IDs here so names, ambiguous IDs and access policies cannot select a recipient.
export function normalizeDiscordReportTarget(value: string): string | undefined {
  const match = /^(?:discord:)?(user|channel):(\d+)$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : undefined;
}

export const PostCallReportConfigSchema = z
  .object({
    discord: z
      .object({
        target: z.string().transform((value, ctx) => {
          const normalized = normalizeDiscordReportTarget(value);
          if (!normalized) {
            ctx.addIssue({
              code: "custom",
              message:
                "Expected user:<numeric-id> or channel:<numeric-id>, optionally prefixed with discord:.",
            });
            return z.NEVER;
          }
          return normalized;
        }),
        accountId: z
          .string()
          .transform((value, ctx) => {
            const normalized = normalizeOptionalAccountId(value);
            if (!normalized) {
              ctx.addIssue({
                code: "custom",
                message: "Expected a valid explicit Discord account ID.",
              });
              return z.NEVER;
            }
            return normalized;
          })
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
