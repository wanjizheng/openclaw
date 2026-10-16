import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findContactByPhone, loadContactsFileAsync } from "./contact-file.js";

const contactText = `# 联系人列表

## 演示联系人
- 电话: +15550000001
- 邮箱： someone@example.test
- 问候语: 你好{name}

来自有效代理工作区的背景。
`;
const legacyText = contactText.replaceAll("演示联系人", "旧全局联系人");
const workspaceDir = "/synthetic/effective-agent-workspace";
const workspaceFile = path.join(workspaceDir, "CONTACT_LIST.md");
const legacyFile = path.join(os.homedir(), ".openclaw", "workspace", "CONTACT_LIST.md");
const missing = () =>
  Object.assign(new Error("synthetic missing contact file"), { code: "ENOENT" });

afterEach(() => vi.restoreAllMocks());

describe("agent workspace contact file", () => {
  it("parses the retained Markdown fields and normalized caller lookup", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(contactText);
    const contacts = await loadContactsFileAsync({ workspaceDir });
    expect(findContactByPhone("+1 (555) 000-0001", contacts)).toEqual({
      name: "演示联系人",
      phone: "+15550000001",
      email: "someone@example.test",
      greeting: "你好{name}",
      info: "来自有效代理工作区的背景。",
    });
    expect(findContactByPhone("+15550000002", contacts)).toBeUndefined();
  });

  it("uses effective workspace contacts instead of a different legacy contact", async () => {
    vi.spyOn(fsp, "readFile").mockImplementation(async (file) => {
      if (file === workspaceFile) {
        return contactText;
      }
      if (file === legacyFile) {
        return legacyText;
      }
      throw missing();
    });
    const contacts = await loadContactsFileAsync({ workspaceDir });
    expect(findContactByPhone("+15550000001", contacts)?.name).toBe("演示联系人");
  });

  it("falls back to retained legacy contacts only when the workspace file is absent", async () => {
    const read = vi.spyOn(fsp, "readFile").mockImplementation(async (file) => {
      if (file === legacyFile) {
        return legacyText;
      }
      throw missing();
    });
    const contacts = await loadContactsFileAsync({ workspaceDir });
    expect(findContactByPhone("+15550000001", contacts)?.name).toBe("旧全局联系人");
    expect(read.mock.calls.map(([file]) => file)).toEqual([workspaceFile, legacyFile]);
  });

  it.each(["empty", "EACCES", "EIO"] as const)(
    "does not borrow another workspace's contacts after %s",
    async (failure) => {
      const read = vi.spyOn(fsp, "readFile").mockImplementation(async (file) => {
        if (file === legacyFile) {
          return legacyText;
        }
        if (failure === "empty") {
          return "";
        }
        throw Object.assign(new Error("synthetic workspace contact failure"), { code: failure });
      });
      expect(await loadContactsFileAsync({ workspaceDir })).toEqual([]);
      expect(read).toHaveBeenCalledOnce();
    },
  );

  it("keeps explicit legacy file paths supported", async () => {
    vi.spyOn(fsp, "readFile").mockResolvedValue(contactText);
    const contacts = await loadContactsFileAsync("/synthetic/explicit-contacts.md");
    expect(findContactByPhone("+15550000001", contacts)?.name).toBe("演示联系人");
  });
});
