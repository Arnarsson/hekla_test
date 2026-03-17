import type { HardwareProfile, InferenceMode } from "./types";

export function suggestInferenceMode(hw: HardwareProfile): {
  recommended: InferenceMode;
  reason: string;
  alternatives: { mode: InferenceMode; reason: string }[];
} {
  const vram = hw.gpuVram;
  const hasCapableGpu = hw.gpuType !== "none";

  // Apple Silicon: unified memory serves as GPU VRAM
  const effectiveVram = hw.isAppleSilicon ? hw.totalRam : vram;

  if (effectiveVram >= 16_000 && (hasCapableGpu || hw.isAppleSilicon)) {
    return {
      recommended: "local",
      reason: hw.isAppleSilicon
        ? `Apple Silicon with ${Math.round(effectiveVram / 1024)}GB unified memory — fully local inference possible`
        : `GPU VRAM ${Math.round(vram / 1024)}GB >= 16GB — fully local inference possible`,
      alternatives: [
        { mode: "hybrid", reason: "Use cloud for overflow or specific high-demand tasks" },
        { mode: "cloud", reason: "Offload all inference to API providers" },
      ],
    };
  }

  if (effectiveVram >= 8_000 && (hasCapableGpu || hw.isAppleSilicon)) {
    return {
      recommended: "hybrid",
      reason: hw.isAppleSilicon
        ? `Apple Silicon with ${Math.round(effectiveVram / 1024)}GB unified memory — local for lighter models, cloud for larger`
        : `GPU VRAM ${Math.round(vram / 1024)}GB between 8–16GB — hybrid balances local capability with cloud headroom`,
      alternatives: [
        { mode: "local", reason: "Fully local with smaller models (quantized)" },
        { mode: "cloud", reason: "Offload all inference to API providers" },
      ],
    };
  }

  return {
    recommended: "cloud",
    reason: !hasCapableGpu && !hw.isAppleSilicon
      ? "No GPU detected — cloud inference recommended"
      : `Effective VRAM ${Math.round(effectiveVram / 1024)}GB < 8GB — insufficient for local inference`,
    alternatives: [
      { mode: "hybrid", reason: "Run tiny quantized models locally, cloud for everything else" },
    ],
  };
}

export function getModelTier(vramMB: number): "high" | "mid" | "low" | "minimal" {
  if (vramMB >= 48_000) return "high";
  if (vramMB >= 16_000) return "mid";
  if (vramMB >= 8_000) return "low";
  return "minimal";
}

export function getOllamaDockerUrl(hw: HardwareProfile): string {
  if (hw.os === "darwin" || hw.isWSL) {
    return "http://host.docker.internal:11434";
  }
  // Linux (non-WSL): use the Docker bridge gateway
  return "http://172.17.0.1:11434";
}

export function generateEnvVars(
  hw: HardwareProfile,
  mode: InferenceMode,
  customerEnv: Record<string, string>,
  customerName: string
): Record<string, string> {
  const env: Record<string, string> = {};

  // Postgres password: use supplied or generate
  env["POSTGRES_PASSWORD"] =
    customerEnv["POSTGRES_PASSWORD"] ?? crypto.randomUUID();

  // Inference mode
  env["INFERENCE_MODE"] = mode;

  // Ollama URL only relevant for local/hybrid
  if (mode === "local" || mode === "hybrid") {
    env["OLLAMA_URL"] = customerEnv["OLLAMA_URL"] ?? getOllamaDockerUrl(hw);
  }

  // Active model must be determined by web search at setup time
  env["ACTIVE_MODEL"] = customerEnv["ACTIVE_MODEL"] ?? "PLACEHOLDER__web_search_required";

  // Cloud API keys (pass through if present)
  if (mode === "cloud" || mode === "hybrid") {
    if (customerEnv["ANTHROPIC_API_KEY"]) {
      env["ANTHROPIC_API_KEY"] = customerEnv["ANTHROPIC_API_KEY"];
    }
    if (customerEnv["OPENAI_API_KEY"]) {
      env["OPENAI_API_KEY"] = customerEnv["OPENAI_API_KEY"];
    }
  }

  // Auth / observability secrets
  env["NEXTAUTH_SECRET"] =
    customerEnv["NEXTAUTH_SECRET"] ?? crypto.randomUUID();
  env["LANGFUSE_SALT"] =
    customerEnv["LANGFUSE_SALT"] ?? crypto.randomUUID();

  // Device identity
  env["DEVICE_NAME"] = hw.hostname;

  // Customer name (useful for labelling)
  env["CUSTOMER_NAME"] = customerName;

  // Merge remaining customer-supplied vars (do not overwrite keys already set)
  for (const [k, v] of Object.entries(customerEnv)) {
    if (!(k in env)) {
      env[k] = v;
    }
  }

  return env;
}
