import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  suggestInferenceMode,
  getModelTier,
  getOllamaDockerUrl,
  generateEnvVars,
} from "../config";
import type { HardwareProfile } from "../types";

const FIXTURES = join(import.meta.dir, "../fixtures/hardware");

function loadHw(name: string): HardwareProfile {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as HardwareProfile;
}

// ---------------------------------------------------------------------------
// suggestInferenceMode
// ---------------------------------------------------------------------------

describe("suggestInferenceMode", () => {
  test("Apple Silicon 24GB → local", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const result = suggestInferenceMode(hw);
    expect(result.recommended).toBe("local");
    expect(result.reason).toContain("Apple Silicon");
  });

  test("Linux NVIDIA A4000 16GB → local (VRAM >= 16GB)", () => {
    const hw = loadHw("linux-nvidia-a4000.json");
    const result = suggestInferenceMode(hw);
    expect(result.recommended).toBe("local");
    expect(result.reason).toContain("16GB");
  });

  test("Linux no GPU → cloud", () => {
    const hw = loadHw("linux-no-gpu.json");
    const result = suggestInferenceMode(hw);
    expect(result.recommended).toBe("cloud");
    expect(result.reason).toContain("No GPU");
  });

  test("DGX Spark 128GB CUDA → local", () => {
    const hw = loadHw("dgx-spark.json");
    const result = suggestInferenceMode(hw);
    expect(result.recommended).toBe("local");
  });

  test("Windows WSL CUDA 12GB → hybrid (8GB <= VRAM < 16GB)", () => {
    const hw = loadHw("windows-wsl.json");
    const result = suggestInferenceMode(hw);
    expect(result.recommended).toBe("hybrid");
  });

  test("always returns alternatives array", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const result = suggestInferenceMode(hw);
    expect(Array.isArray(result.alternatives)).toBe(true);
    expect(result.alternatives.length).toBeGreaterThan(0);
  });

  test("mid VRAM (12GB CUDA) → hybrid", () => {
    const hw: HardwareProfile = {
      ...loadHw("linux-nvidia-a4000.json"),
      gpuVram: 12288,
    };
    const result = suggestInferenceMode(hw);
    expect(result.recommended).toBe("hybrid");
  });

  test("low VRAM (4GB CUDA) → cloud", () => {
    const hw: HardwareProfile = {
      ...loadHw("linux-nvidia-a4000.json"),
      gpuVram: 4096,
      totalRam: 8192,
      isAppleSilicon: false,
    };
    const result = suggestInferenceMode(hw);
    expect(result.recommended).toBe("cloud");
  });
});

// ---------------------------------------------------------------------------
// getModelTier
// ---------------------------------------------------------------------------

describe("getModelTier", () => {
  test("48000 MB → high", () => {
    expect(getModelTier(48_000)).toBe("high");
  });

  test("48001 MB → high", () => {
    expect(getModelTier(48_001)).toBe("high");
  });

  test("47999 MB → mid", () => {
    expect(getModelTier(47_999)).toBe("mid");
  });

  test("16000 MB → mid", () => {
    expect(getModelTier(16_000)).toBe("mid");
  });

  test("15999 MB → low", () => {
    expect(getModelTier(15_999)).toBe("low");
  });

  test("8000 MB → low", () => {
    expect(getModelTier(8_000)).toBe("low");
  });

  test("7999 MB → minimal", () => {
    expect(getModelTier(7_999)).toBe("minimal");
  });

  test("4096 MB → minimal", () => {
    expect(getModelTier(4_096)).toBe("minimal");
  });

  test("0 MB → minimal", () => {
    expect(getModelTier(0)).toBe("minimal");
  });
});

// ---------------------------------------------------------------------------
// getOllamaDockerUrl
// ---------------------------------------------------------------------------

describe("getOllamaDockerUrl", () => {
  test("darwin → host.docker.internal", () => {
    const hw = loadHw("mac-m4-24gb.json");
    expect(getOllamaDockerUrl(hw)).toBe("http://host.docker.internal:11434");
  });

  test("linux (non-WSL) → docker bridge gateway", () => {
    const hw = loadHw("linux-nvidia-a4000.json");
    expect(getOllamaDockerUrl(hw)).toBe("http://172.17.0.1:11434");
  });

  test("linux no-gpu (non-WSL) → docker bridge gateway", () => {
    const hw = loadHw("linux-no-gpu.json");
    expect(getOllamaDockerUrl(hw)).toBe("http://172.17.0.1:11434");
  });

  test("WSL → host.docker.internal", () => {
    const hw = loadHw("windows-wsl.json");
    expect(getOllamaDockerUrl(hw)).toBe("http://host.docker.internal:11434");
  });
});

// ---------------------------------------------------------------------------
// generateEnvVars
// ---------------------------------------------------------------------------

describe("generateEnvVars", () => {
  test("local mode includes OLLAMA_URL", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", {}, "Test Customer");
    expect(env["OLLAMA_URL"]).toBeDefined();
    expect(env["INFERENCE_MODE"]).toBe("local");
  });

  test("hybrid mode includes OLLAMA_URL", () => {
    const hw = loadHw("linux-nvidia-a4000.json");
    const env = generateEnvVars(hw, "hybrid", {}, "Test Customer");
    expect(env["OLLAMA_URL"]).toBeDefined();
    expect(env["INFERENCE_MODE"]).toBe("hybrid");
  });

  test("cloud mode does not include OLLAMA_URL", () => {
    const hw = loadHw("linux-no-gpu.json");
    const env = generateEnvVars(hw, "cloud", {}, "Test Customer");
    expect(env["OLLAMA_URL"]).toBeUndefined();
    expect(env["INFERENCE_MODE"]).toBe("cloud");
  });

  test("always includes POSTGRES_PASSWORD", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", {}, "Test");
    expect(env["POSTGRES_PASSWORD"]).toBeDefined();
  });

  test("always includes NEXTAUTH_SECRET", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "cloud", {}, "Test");
    expect(env["NEXTAUTH_SECRET"]).toBeDefined();
  });

  test("always includes LANGFUSE_SALT", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "cloud", {}, "Test");
    expect(env["LANGFUSE_SALT"]).toBeDefined();
  });

  test("DEVICE_NAME equals hw.hostname", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", {}, "Test");
    expect(env["DEVICE_NAME"]).toBe("test-mac");
  });

  test("CUSTOMER_NAME is set", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", {}, "Christopher");
    expect(env["CUSTOMER_NAME"]).toBe("Christopher");
  });

  test("ACTIVE_MODEL defaults to placeholder", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", {}, "Test");
    expect(env["ACTIVE_MODEL"]).toContain("PLACEHOLDER");
  });

  test("passes through ANTHROPIC_API_KEY in cloud mode", () => {
    const hw = loadHw("linux-no-gpu.json");
    const env = generateEnvVars(hw, "cloud", { ANTHROPIC_API_KEY: "sk-test" }, "Test");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
  });

  test("passes through OPENAI_API_KEY in hybrid mode", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "hybrid", { OPENAI_API_KEY: "sk-oai" }, "Test");
    expect(env["OPENAI_API_KEY"]).toBe("sk-oai");
  });

  test("ANTHROPIC_API_KEY in local mode is passed through via the catch-all merge", () => {
    // The source does not filter extra customer env vars in local mode —
    // all unset keys from customerEnv are merged at the end of generateEnvVars.
    // This test documents that behaviour explicitly.
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", { ANTHROPIC_API_KEY: "sk-test" }, "Test");
    expect(env["ANTHROPIC_API_KEY"]).toBe("sk-test");
  });

  test("respects customer-supplied POSTGRES_PASSWORD", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", { POSTGRES_PASSWORD: "my-secret" }, "Test");
    expect(env["POSTGRES_PASSWORD"]).toBe("my-secret");
  });

  test("passes through extra customer env vars not already set", () => {
    const hw = loadHw("mac-m4-24gb.json");
    const env = generateEnvVars(hw, "local", { CUSTOM_FLAG: "yes" }, "Test");
    expect(env["CUSTOM_FLAG"]).toBe("yes");
  });
});
