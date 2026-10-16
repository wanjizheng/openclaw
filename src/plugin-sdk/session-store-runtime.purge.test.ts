import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import { deleteSessionEntry, getSessionEntry } from "./session-store-runtime.js";

const directories = useSessionStoreTempDirs(afterAll, "openclaw-sdk-session-purge-");
type Target = { agentId: string; sessionKey: string; sessionId: string; storePath: string };

describe("SDK exact session history deletion", () => {
  let directory: string;
  let storePath: string;
  beforeEach(() => {
    directory = directories.make();
    storePath = path.join(directory, "sessions.json");
  });
  const target = (id: string): Target => ({
    agentId: "main",
    sessionKey: `agent:main:voice:call:${id}`,
    sessionId: id,
    storePath,
  });
  function database() {
    const resolved = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
    if (!resolved.path) {
      throw new Error("Expected SQLite fixture path");
    }
    return openOpenClawAgentDatabase({ agentId: "main", path: resolved.path });
  }
  async function seed(id: string) {
    const scope = target(id);
    await replaceSessionEntry(scope, { sessionId: id, updatedAt: Date.now() });
    await replaceTranscriptEvents(scope, [
      {
        type: "message",
        id: `message-${id}`,
        parentId: null,
        timestamp: Date.now(),
        message: {
          role: "user",
          content: [{ type: "text", text: `private synthetic call ${id}` }],
        },
      },
    ]);
    appendSqliteTrajectoryRuntimeEvents(scope, [
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: id,
        source: "runtime",
        type: "test.session-purge",
        ts: new Date().toISOString(),
        seq: 1,
        sessionId: id,
      },
    ]);
    await waitForSessionTranscriptProjection(scope);
    return scope;
  }
  function counts(scope: Target) {
    const owner = database();
    const db = getNodeSqliteKysely<DB>(owner.db);
    const count = (
      table:
        | "session_windows"
        | "transcript_events"
        | "trajectory_runtime_events"
        | "session_transcript_fts"
        | "session_transcript_fts_rows"
        | "session_transcript_index_state"
        | "session_transcript_active_events"
        | "session_transcript_archives",
    ) =>
      tableExists(owner.db, table)
        ? (executeSqliteQuerySync(
            owner.db,
            db
              .selectFrom(table)
              .select(({ fn }) => fn.countAll<number>().as("count"))
              .where("session_id", "=", scope.sessionId),
          ).rows[0]?.count ?? 0)
        : 0;
    return {
      node:
        executeSqliteQuerySync(
          owner.db,
          db
            .selectFrom("session_nodes")
            .select(({ fn }) => fn.countAll<number>().as("count"))
            .where("session_key", "=", scope.sessionKey),
        ).rows[0]?.count ?? 0,
      windows: count("session_windows"),
      transcript: count("transcript_events"),
      trajectory: count("trajectory_runtime_events"),
      fts: count("session_transcript_fts"),
      ftsRows: count("session_transcript_fts_rows"),
      index: count("session_transcript_index_state"),
      active: count("session_transcript_active_events"),
      archive: count("session_transcript_archives"),
    };
  }
  const purge = (scope: Target, expectedSessionId = scope.sessionId) =>
    deleteSessionEntry({
      ...scope,
      expectedSessionId,
      archiveTranscript: false,
      deleteTranscriptWithoutArchive: true,
    });

  it("removes only the exact call's SQLite window, transcript, trajectory and FTS without an archive", async () => {
    const call = await seed("purge-owned");
    const foreign = await seed("foreign-call");
    const foreignBefore = counts(foreign);
    expect(counts(call)).toMatchObject({
      node: 1,
      windows: 1,
      transcript: 1,
      trajectory: 1,
      fts: 1,
    });
    await expect(purge(call)).resolves.toBe(true);
    expect(getSessionEntry(call)).toBeUndefined();
    expect(counts(call)).toEqual({
      node: 0,
      windows: 0,
      transcript: 0,
      trajectory: 0,
      fts: 0,
      ftsRows: 0,
      index: 0,
      active: 0,
      archive: 0,
    });
    expect(counts(foreign)).toEqual(foreignBefore);
    expect(getSessionEntry(foreign)?.sessionId).toBe(foreign.sessionId);
    expect(
      fs
        .readdirSync(directory, { recursive: true })
        .filter((name) => String(name).includes(".deleted.") || String(name).includes(".reset.")),
    ).toEqual([]);
  });

  it("keeps a same-key replacement and both histories when the captured session id is stale", async () => {
    const old = await seed("old-call");
    const replacement = { ...old, sessionId: "replacement-call" };
    await replaceSessionEntry(replacement, {
      sessionId: replacement.sessionId,
      updatedAt: Date.now(),
    });
    await replaceTranscriptEvents(replacement, [{ type: "session", id: replacement.sessionId }]);
    await waitForSessionTranscriptProjection(replacement);
    const before = counts(old);
    const nextBefore = counts(replacement);
    await expect(purge(old)).resolves.toBe(false);
    expect(getSessionEntry(old)?.sessionId).toBe(replacement.sessionId);
    expect(counts(old)).toEqual(before);
    expect(counts(replacement)).toEqual(nextBefore);
  });

  it("preserves shared history referenced by another session while removing only the call entry", async () => {
    const call = await seed("shared-call");
    const shared = { ...call, sessionKey: "agent:main:shared-owner" };
    await replaceSessionEntry(shared, { sessionId: call.sessionId, updatedAt: Date.now() });
    const before = counts(call);
    await expect(purge(call)).resolves.toBe(true);
    expect(getSessionEntry(call)).toBeUndefined();
    expect(getSessionEntry(shared)?.sessionId).toBe(call.sessionId);
    expect(counts(shared)).toEqual(before);
  });

  it("preserves state when canonical schema admission rejects and safely retries", async () => {
    const call = await seed("retry-call");
    const before = counts(call);
    const owner = database();
    const options = { agentId: "main", path: owner.path };
    runOpenClawAgentWriteTransaction(
      (db) =>
        db.db.exec(
          "CREATE TRIGGER reject_fixture_purge BEFORE DELETE ON transcript_events BEGIN SELECT RAISE(ABORT, 'injected purge failure'); END;",
        ),
      options,
    );
    try {
      await expect(purge(call)).rejects.toThrow("unexpected trigger reject_fixture_purge");
      expect(counts(call)).toEqual(before);
      expect(getSessionEntry(call)?.sessionId).toBe(call.sessionId);
    } finally {
      runOpenClawAgentWriteTransaction(
        (db) => db.db.exec("DROP TRIGGER reject_fixture_purge"),
        options,
      );
    }
    await expect(purge(call)).resolves.toBe(true);
    expect(counts(call)).toEqual({
      node: 0,
      windows: 0,
      transcript: 0,
      trajectory: 0,
      fts: 0,
      ftsRows: 0,
      index: 0,
      active: 0,
      archive: 0,
    });
  });

  it("rejects conflicting archive and no-archive deletion before changing any row", async () => {
    const call = await seed("conflicting-policy");
    const before = counts(call);
    await expect(
      deleteSessionEntry({
        ...call,
        expectedSessionId: call.sessionId,
        archiveTranscript: true,
        deleteTranscriptWithoutArchive: true,
      }),
    ).rejects.toThrow("Cannot combine archiveTranscript and deleteTranscriptWithoutArchive");
    expect(counts(call)).toEqual(before);
    expect(getSessionEntry(call)?.sessionId).toBe(call.sessionId);
  });

  it("preserves existing default logical-entry deletion semantics", async () => {
    const call = await seed("preserve-default");
    const before = counts(call);
    await expect(deleteSessionEntry({ ...call, expectedSessionId: call.sessionId })).resolves.toBe(
      true,
    );
    expect(getSessionEntry(call)).toBeUndefined();
    expect(counts(call)).toEqual(before);
  });
});
