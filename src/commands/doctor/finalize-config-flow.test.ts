// Doctor finalize config-flow tests cover final repair summaries and config mutation completion.
import { describe, expect, it, vi } from "vitest";
import { finalizeDoctorConfigFlow } from "./finalize-config-flow.js";

describe("doctor finalize config flow", () => {
  it("writes the candidate when preview changes are confirmed", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      shouldRepair: false,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      confirm: async () => true,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
      allowConfigSizeDropOnWrite: false,
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("emits fix hints when preview changes are declined", async () => {
    const note = vi.fn();
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: {} },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: true,
      shouldRepair: false,
      fixHints: ['Run "openclaw doctor --fix" to apply these changes.'],
      confirm: async () => false,
      note,
    });

    expect(result).toEqual({
      cfg: { channels: {} },
      shouldWriteConfig: false,
      allowConfigSizeDropOnWrite: false,
    });
    expect(note).toHaveBeenCalledWith(
      'Run "openclaw doctor --fix" to apply these changes.',
      "Doctor",
    );
  });

  it("writes automatically in repair mode when changes exist", async () => {
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: false } } },
      pendingChanges: true,
      shouldRepair: true,
      fixHints: [],
      confirm: async () => true,
      note: vi.fn(),
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
      allowConfigSizeDropOnWrite: false,
    });
  });

  it("propagates allowConfigSizeDropOnWrite to the write decision in repair mode", async () => {
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: false } } },
      pendingChanges: true,
      shouldRepair: true,
      fixHints: [],
      confirm: async () => true,
      note: vi.fn(),
      allowConfigSizeDropOnWrite: true,
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: true,
      allowConfigSizeDropOnWrite: true,
    });
  });

  it("does not propagate allowConfigSizeDropOnWrite when there are no pending changes", async () => {
    const result = await finalizeDoctorConfigFlow({
      cfg: { channels: { signal: { enabled: true } } },
      candidate: { channels: { signal: { enabled: true } } },
      pendingChanges: false,
      shouldRepair: true,
      fixHints: [],
      confirm: async () => true,
      note: vi.fn(),
      allowConfigSizeDropOnWrite: true,
    });

    expect(result).toEqual({
      cfg: { channels: { signal: { enabled: true } } },
      shouldWriteConfig: false,
      allowConfigSizeDropOnWrite: false,
    });
  });
});
