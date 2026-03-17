import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import path from "path";
import {
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  hardwareFingerprint,
  restoreFromCheckpoint,
} from "../state";
import type { PipelineContext, PhaseID, PhaseResult } from "../types";

function makeCtx(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    customer: {
      name: "test-customer",
      language: "en",
      timezone: "UTC",
      technicalLevel: "advanced",
      emails: [],
      ventures: [],
      personalitySummary: [],
      knownIssues: [],
      chatInterface: "telegram",
    },
    customerEnv: {},
    customerDir: "/tmp/test",
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
    mode: "hybrid",
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

function makeResult(id: string, status: "completed" | "failed" | "skipped" = "completed"): PhaseResult {
  return {
    id: id as PhaseID,
    status,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    output: {},
    warnings: [],
  };
}

// Clean up checkpoint files before/after tests
const CHECKPOINT_PATH = path.join("logs", "test-customer-checkpoint.json");

beforeEach(() => {
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
});

afterEach(() => {
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);
  // Clean up any completed files
  const logsDir = "logs";
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir)) {
      if (f.startsWith("test-customer-completed-")) {
        fs.unlinkSync(path.join(logsDir, f));
      }
    }
  }
});

describe("hardwareFingerprint", () => {
  test("produces consistent hash for same hardware", () => {
    const ctx = makeCtx();
    const fp1 = hardwareFingerprint(ctx);
    const fp2 = hardwareFingerprint(ctx);
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(16);
  });

  test("produces different hash for different hardware", () => {
    const ctx1 = makeCtx();
    const ctx2 = makeCtx({
      hardware: {
        ...ctx1.hardware,
        hostname: "different-host",
      },
    });
    expect(hardwareFingerprint(ctx1)).not.toBe(hardwareFingerprint(ctx2));
  });
});

describe("saveCheckpoint / loadCheckpoint", () => {
  test("round-trips checkpoint data", () => {
    const ctx = makeCtx();
    ctx.results.set("00-preflight" as PhaseID, makeResult("00-preflight"));
    ctx.results.set("01-user-account" as PhaseID, makeResult("01-user-account"));

    saveCheckpoint(ctx);

    const loaded = loadCheckpoint("test-customer");
    expect(loaded).not.toBeNull();
    expect(loaded!.customer).toBe("test-customer");
    expect(loaded!.mode).toBe("hybrid");
    expect(Object.keys(loaded!.phases)).toHaveLength(2);
    expect(loaded!.phases["00-preflight"]!.status).toBe("completed");
  });

  test("returns null when no checkpoint exists", () => {
    expect(loadCheckpoint("nonexistent-customer")).toBeNull();
  });
});

describe("clearCheckpoint", () => {
  test("renames checkpoint to completed file", () => {
    const ctx = makeCtx();
    ctx.results.set("00-preflight" as PhaseID, makeResult("00-preflight"));
    saveCheckpoint(ctx);

    expect(fs.existsSync(CHECKPOINT_PATH)).toBe(true);
    clearCheckpoint("test-customer");
    expect(fs.existsSync(CHECKPOINT_PATH)).toBe(false);

    // Should have a completed file
    const completedFiles = fs.readdirSync("logs").filter((f) => f.startsWith("test-customer-completed-"));
    expect(completedFiles.length).toBeGreaterThanOrEqual(1);
  });

  test("no-op when no checkpoint exists", () => {
    clearCheckpoint("nonexistent-customer"); // should not throw
  });
});

describe("restoreFromCheckpoint", () => {
  test("restores completed and skipped phases", () => {
    const ctx = makeCtx();
    ctx.results.set("00-preflight" as PhaseID, makeResult("00-preflight"));
    ctx.results.set("01-user-account" as PhaseID, makeResult("01-user-account", "skipped"));
    ctx.results.set("02-dependencies" as PhaseID, makeResult("02-dependencies", "failed"));
    saveCheckpoint(ctx);

    const checkpoint = loadCheckpoint("test-customer")!;
    const freshCtx = makeCtx();
    const restored = restoreFromCheckpoint(checkpoint, freshCtx);

    expect(restored).toBe(2); // completed + skipped, not failed
    expect(freshCtx.results.has("00-preflight" as PhaseID)).toBe(true);
    expect(freshCtx.results.has("01-user-account" as PhaseID)).toBe(true);
    expect(freshCtx.results.has("02-dependencies" as PhaseID)).toBe(false);
  });

  test("warns on hardware fingerprint mismatch", () => {
    const ctx = makeCtx();
    ctx.results.set("00-preflight" as PhaseID, makeResult("00-preflight"));
    saveCheckpoint(ctx);

    const checkpoint = loadCheckpoint("test-customer")!;

    const warnings: string[] = [];
    const logger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (_phase: string, msg: string) => { warnings.push(msg); },
    };

    const differentCtx = makeCtx({
      hardware: { ...ctx.hardware, hostname: "different-machine" },
    });

    restoreFromCheckpoint(checkpoint, differentCtx, logger);
    expect(warnings.some((w) => w.includes("Hardware fingerprint changed"))).toBe(true);
  });

  test("warns on mode mismatch", () => {
    const ctx = makeCtx({ mode: "hybrid" });
    ctx.results.set("00-preflight" as PhaseID, makeResult("00-preflight"));
    saveCheckpoint(ctx);

    const checkpoint = loadCheckpoint("test-customer")!;

    const warnings: string[] = [];
    const logger = {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (_phase: string, msg: string) => { warnings.push(msg); },
    };

    const differentCtx = makeCtx({ mode: "cloud" });
    restoreFromCheckpoint(checkpoint, differentCtx, logger);
    expect(warnings.some((w) => w.includes("Inference mode changed"))).toBe(true);
  });
});
