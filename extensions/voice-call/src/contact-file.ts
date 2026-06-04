/**
 * File-based contacts loader for CONTACT_LIST.md.
 *
 * Format expected in the markdown file:
 *
 *   # 联系人列表
 *
 *   ## 基正
 *   - 电话: +447393866686
 *   - 邮箱: someone@example.com
 *   - 问候语: 宝贝～是{name}来啦！岚岚好想你～
 *
 *   基正是林若岚的主人和男友。喜欢编程、音乐。
 *
 *   ---
 *
 *   ## 朋友
 *   - 电话: +447544852225
 *
 * Each `## Name` section becomes one contact.  The optional `- 电话:`,
 * `- 邮箱:`, and `- 问候语:` bullet lines are parsed as structured metadata.
 * Any remaining non-blank text below the metadata is treated as free-form
 * `info` and will be injected verbatim into the LLM system prompt when that
 * caller connects.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePhoneNumber } from "./allowlist.js";

export type ParsedContact = {
  /** Display name taken from the `## Heading` */
  name: string;
  /** E.164 (or any) phone number */
  phone: string;
  /** Email address */
  email?: string;
  /** Per-contact greeting template (supports {name} placeholder) */
  greeting?: string;
  /** Free-form personal info to inject into the LLM system prompt */
  info?: string;
};

const DEFAULT_CONTACTS_PATH = path.join(os.homedir(), ".openclaw", "workspace", "CONTACT_LIST.md");

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse the text of a CONTACT_LIST.md file into an array of contacts.
 */
export function parseContactsFile(content: string): ParsedContact[] {
  const contacts: ParsedContact[] = [];

  // Split on level-2 headings (## …).  The leading \n is consumed as part of
  // the lookahead so each chunk starts with the heading itself.
  const sections = content.split(/\n(?=## )/);

  for (const section of sections) {
    const lines = section.split("\n");

    // Find the ## heading line
    const headingLine = lines.find((l) => l.startsWith("## "));
    if (!headingLine) continue;

    const name = headingLine.slice(3).trim();
    if (!name) continue;

    let phone = "";
    let email: string | undefined;
    let greeting: string | undefined;
    const infoLines: string[] = [];

    // State: have we finished parsing the bullet-list metadata?
    let pastMeta = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;

      // Horizontal rule separating contacts — skip
      if (/^-{3,}$/.test(line.trim())) continue;

      if (!pastMeta) {
        if (line.startsWith("- ")) {
          // Structured metadata bullet
          const phoneMatch = line.match(/^- 电话[:：]\s*(.+)/);
          const emailMatch = line.match(/^- 邮箱[:：]\s*(.+)/);
          const greetingMatch = line.match(/^- 问候语[:：]\s*(.+)/);
          if (phoneMatch) {
            phone = phoneMatch[1]!.trim();
          } else if (emailMatch) {
            email = emailMatch[1]!.trim();
          } else if (greetingMatch) {
            greeting = greetingMatch[1]!.trim();
          }
          continue;
        }

        // First non-bullet, non-blank line after metadata → free-text info
        if (line.trim() === "") continue;
        pastMeta = true;
      }

      infoLines.push(line);
    }

    // Trim trailing blank lines from info block
    while (infoLines.length > 0 && infoLines[infoLines.length - 1]!.trim() === "") {
      infoLines.pop();
    }

    const info = infoLines.join("\n").trim() || undefined;

    if (phone || email) {
      contacts.push({ name, phone, email, greeting, info });
    }
  }

  return contacts;
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Synchronously load contacts from CONTACT_LIST.md.
 * Returns an empty array if the file is missing or unreadable.
 */
export function loadContactsFileSync(filePath = DEFAULT_CONTACTS_PATH): ParsedContact[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return parseContactsFile(content);
  } catch {
    return [];
  }
}

/**
 * Asynchronously load contacts from CONTACT_LIST.md.
 * Returns an empty array if the file is missing or unreadable.
 */
export async function loadContactsFileAsync(
  filePath = DEFAULT_CONTACTS_PATH,
): Promise<ParsedContact[]> {
  try {
    const content = await fsp.readFile(filePath, "utf-8");
    return parseContactsFile(content);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Find a contact by phone number using digit-normalised comparison so that
 * formatting differences (+44 vs 0044 vs local) don't matter.
 */
export function findContactByPhone(
  from: string | undefined,
  contacts: ParsedContact[],
): ParsedContact | undefined {
  if (!from) return undefined;
  const normalizedFrom = normalizePhoneNumber(from);
  if (!normalizedFrom) return undefined;
  return contacts.find((c) => normalizePhoneNumber(c.phone) === normalizedFrom);
}

/**
 * Resolve the inbound greeting text for a caller.
 *
 * Priority:
 *   1. Contact's own `greeting` template (with {name} substituted)
 *   2. `globalGreeting` template (with {name} substituted)
 *   3. Built-in English fallback
 */
export function resolveInboundGreeting(
  from: string | undefined,
  globalGreeting: string | undefined,
  contacts: ParsedContact[],
): { greeting: string; callerName: string | undefined } {
  const contact = findContactByPhone(from, contacts);
  const name = contact?.name;

  const template = contact?.greeting ?? globalGreeting ?? "Hello! How can I help you today?";

  const greeting = name
    ? template.replace(/\{name\}/g, name)
    : template.replace(/\s*\{name\}\s*/g, " ").trim();

  return { greeting, callerName: name };
}
