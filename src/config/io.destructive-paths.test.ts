import { describe, expect, it } from "vitest";
import { collectUnauthorizedDestructivePaths } from "./io.destructive-paths.js";

describe("migration destructive path authority", () => {
  it.each([
    {
      name: "dotted object keys do not authorize nested keys",
      before: { "agents.list": "long", agents: { list: "long" } },
      after: { "agents.list": "long", agents: { list: "x" } },
      authorizedPaths: [["agents.list"]],
      refused: ['["agents","list"]'],
    },
    {
      name: "UTF-8 shrink is detected despite UTF-16 growth",
      before: { prompt: "中文" },
      after: { prompt: "abc" },
      authorizedPaths: [],
      refused: ['["prompt"]'],
    },
    {
      name: "a leaf cannot authorize replacing its ancestor",
      before: { channels: { telegram: { enabled: true }, discord: { enabled: true } } },
      after: {},
      authorizedPaths: [["channels", "telegram"]],
      refused: ['["channels"]'],
    },
    {
      name: "canonical unsets allow pruning an empty parent",
      before: { plugins: { installs: { demo: { version: "1" } } } },
      after: {},
      authorizedPaths: [],
      refused: [],
    },
    {
      name: "canonical unsets do not authorize a sibling",
      before: { plugins: { installs: { demo: {} }, entries: { demo: { enabled: true } } } },
      after: {},
      authorizedPaths: [],
      refused: ['["plugins"]'],
    },
    {
      name: "array truncation preserves numeric identity",
      before: { allowFrom: ["first", "second"] },
      after: { allowFrom: ["first"] },
      authorizedPaths: [["allowFrom", "1"]],
      refused: ['["allowFrom",1]'],
    },
  ])("$name", ({ before, after, authorizedPaths, refused }) => {
    expect(collectUnauthorizedDestructivePaths({ before, after, authorizedPaths })).toEqual(
      refused,
    );
  });
});
