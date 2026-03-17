import { test, expect, describe } from "bun:test";
import { validateGraph, getReadyPhases, getExecutionOrder, generatePlan } from "../parallel";
import type { PhaseDefinition, PhaseID, PipelineContext, PhaseResult } from "../types";

// ---------------------------------------------------------------------------
// Helpers to build minimal PhaseDefinition stubs
// ---------------------------------------------------------------------------

function makePhase(
  id: string,
  deps: string[] = [],
  skipWhen?: (ctx: PipelineContext) => boolean
): PhaseDefinition {
  return {
    id: id as PhaseID,
    name: `Phase ${id}`,
    description: `Description for ${id}`,
    dependencies: deps as PhaseID[],
    skipWhen,
    run: async (_ctx) => ({
      id: id as PhaseID,
      status: "completed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      output: {},
      warnings: [],
    }),
  };
}

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    customer: {
      name: "Test",
      language: "",
      timezone: "",
      technicalLevel: "",
      emails: [],
      ventures: [],
      personalitySummary: [],
      knownIssues: [],
      chatInterface: "",
    },
    customerEnv: {},
    customerDir: "/tmp",
    hardware: {
      os: "darwin",
      arch: "arm64",
      cpuModel: "Test CPU",
      gpuType: "metal",
      gpuVram: 24576,
      totalRam: 24576,
      diskFree: 50000,
      pkgManager: "brew",
      scheduler: "launchd",
      dockerRuntime: "desktop",
      isWSL: false,
      isAppleSilicon: true,
      isDGXSpark: false,
      hostname: "test-host",
      username: "testuser",
      existingInstalls: {
        docker: false,
        ollama: false,
        ollamaModels: [],
        bun: true,
        tailscale: false,
      },
    },
    dirtyState: {
      oldOllama: false,
      oldDockerContainers: [],
      utmVMs: [],
      shadowMindRemnants: [],
      oldConfigs: [],
      staleEnvFiles: [],
    },
    mode: "local",
    target: { type: "local" },
    dryRun: false,
    verbose: false,
    sequential: false,
    results: new Map(),
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    ...overrides,
  } as PipelineContext;
}

// ---------------------------------------------------------------------------
// validateGraph
// ---------------------------------------------------------------------------

describe("validateGraph", () => {
  test("valid linear graph passes", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
      makePhase("02-dependencies", ["01-user-account"]),
    ];
    const result = validateGraph(phases);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("valid graph with parallel deps passes", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
      makePhase("02-dependencies", ["00-preflight"]),
      makePhase("03-ollama-model", ["01-user-account", "02-dependencies"]),
    ];
    const result = validateGraph(phases);
    expect(result.valid).toBe(true);
  });

  test("empty graph passes", () => {
    expect(validateGraph([]).valid).toBe(true);
  });

  test("cycle A→B→C→A is detected", () => {
    const phases = [
      makePhase("00-preflight", ["12-final-qa"]),
      makePhase("01-user-account", ["00-preflight"]),
      makePhase("12-final-qa", ["01-user-account"]),
    ];
    const result = validateGraph(phases);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Cycle"))).toBe(true);
  });

  test("self-loop is a cycle", () => {
    const phases = [makePhase("00-preflight", ["00-preflight"])];
    const result = validateGraph(phases);
    expect(result.valid).toBe(false);
  });

  test("missing dependency is flagged as an error", () => {
    const phases = [
      makePhase("01-user-account", ["00-preflight"]), // 00-preflight not in list
    ];
    const result = validateGraph(phases);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown phase"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getReadyPhases
// ---------------------------------------------------------------------------

describe("getReadyPhases", () => {
  const phases = [
    makePhase("00-preflight"),
    makePhase("01-user-account", ["00-preflight"]),
    makePhase("02-dependencies", ["00-preflight"]),
    makePhase("03-ollama-model", ["01-user-account", "02-dependencies"]),
  ];

  test("initially only phases with no deps are ready", () => {
    const ready = getReadyPhases(phases, new Set(), new Set(), new Set());
    expect(ready.map((p) => p.id)).toEqual(["00-preflight"]);
  });

  test("after completing 00, next two phases become ready", () => {
    const ready = getReadyPhases(
      phases,
      new Set(["00-preflight"] as PhaseID[]),
      new Set(),
      new Set()
    );
    const ids = ready.map((p) => p.id);
    expect(ids).toContain("01-user-account");
    expect(ids).toContain("02-dependencies");
    expect(ids).not.toContain("03-ollama-model");
  });

  test("phase with all deps complete becomes ready", () => {
    const ready = getReadyPhases(
      phases,
      new Set(["00-preflight", "01-user-account", "02-dependencies"] as PhaseID[]),
      new Set(),
      new Set()
    );
    expect(ready.map((p) => p.id)).toContain("03-ollama-model");
  });

  test("running phases are not returned as ready", () => {
    const ready = getReadyPhases(
      phases,
      new Set(["00-preflight"] as PhaseID[]),
      new Set(["01-user-account"] as PhaseID[]),
      new Set()
    );
    const ids = ready.map((p) => p.id);
    expect(ids).not.toContain("01-user-account");
    expect(ids).toContain("02-dependencies");
  });

  test("skipped phases count as done for dependency resolution", () => {
    const ready = getReadyPhases(
      phases,
      new Set(["00-preflight", "01-user-account"] as PhaseID[]),
      new Set(),
      new Set(["02-dependencies"] as PhaseID[]) // skipped
    );
    // 03 depends on 01 (completed) and 02 (skipped) → should be ready
    expect(ready.map((p) => p.id)).toContain("03-ollama-model");
  });
});

// ---------------------------------------------------------------------------
// getExecutionOrder
// ---------------------------------------------------------------------------

describe("getExecutionOrder", () => {
  test("linear graph preserves dependency order", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
      makePhase("02-dependencies", ["01-user-account"]),
    ];
    const order = getExecutionOrder(phases);
    expect(order.indexOf("00-preflight")).toBeLessThan(order.indexOf("01-user-account"));
    expect(order.indexOf("01-user-account")).toBeLessThan(order.indexOf("02-dependencies"));
  });

  test("diamond graph: 00 first, 03 last", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
      makePhase("02-dependencies", ["00-preflight"]),
      makePhase("03-ollama-model", ["01-user-account", "02-dependencies"]),
    ];
    const order = getExecutionOrder(phases);
    expect(order[0]).toBe("00-preflight");
    expect(order[order.length - 1]).toBe("03-ollama-model");
  });

  test("all phases are included in output", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
      makePhase("02-dependencies", ["00-preflight"]),
    ];
    const order = getExecutionOrder(phases);
    expect(order).toHaveLength(3);
    for (const p of phases) {
      expect(order).toContain(p.id);
    }
  });

  test("single phase graph returns that phase", () => {
    const phases = [makePhase("00-preflight")];
    const order = getExecutionOrder(phases);
    expect(order).toEqual(["00-preflight"]);
  });

  test("empty graph returns empty array", () => {
    expect(getExecutionOrder([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generatePlan
// ---------------------------------------------------------------------------

describe("generatePlan", () => {
  test("produces a non-empty string", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
    ];
    const ctx = makeCtx({ dryRun: true });
    const plan = generatePlan(phases, ctx);
    expect(typeof plan).toBe("string");
    expect(plan.length).toBeGreaterThan(0);
  });

  test("plan includes HEKLA header", () => {
    const phases = [makePhase("00-preflight")];
    const ctx = makeCtx({ dryRun: true });
    const plan = generatePlan(phases, ctx);
    expect(plan).toContain("HEKLA");
  });

  test("plan lists phase IDs", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
    ];
    const ctx = makeCtx({ dryRun: true });
    const plan = generatePlan(phases, ctx);
    expect(plan).toContain("00-preflight");
    expect(plan).toContain("01-user-account");
  });

  test("plan includes wave information", () => {
    const phases = [makePhase("00-preflight")];
    const ctx = makeCtx({ dryRun: true });
    const plan = generatePlan(phases, ctx);
    expect(plan).toContain("Wave");
  });

  test("plan flags skipped phases when skipWhen returns true", () => {
    const phases = [
      makePhase("00-preflight", [], () => true), // always skip
    ];
    const ctx = makeCtx({ dryRun: true });
    const plan = generatePlan(phases, ctx);
    expect(plan).toContain("SKIP");
  });

  test("plan shows cycle error for invalid graph", () => {
    const phases = [
      makePhase("00-preflight", ["12-final-qa"]),
      makePhase("12-final-qa", ["00-preflight"]),
    ];
    const ctx = makeCtx({ dryRun: true });
    const plan = generatePlan(phases, ctx);
    expect(plan).toContain("ERROR");
  });

  test("sequential mode produces one phase per wave", () => {
    const phases = [
      makePhase("00-preflight"),
      makePhase("01-user-account", ["00-preflight"]),
      makePhase("02-dependencies", ["00-preflight"]),
    ];
    const ctx = makeCtx({ dryRun: true, sequential: true });
    const plan = generatePlan(phases, ctx);
    // In sequential mode each wave has exactly one phase (no [parallel] markers)
    // We can verify there are exactly 3 wave entries
    const waveCount = (plan.match(/Wave \d+/g) ?? []).length;
    expect(waveCount).toBe(3);
  });
});
