import type { PhaseDefinition, PipelineContext, PhaseResult } from "../types";
import { exec } from "../exec";
import { getModelTier } from "../config";

const PHASE = "03-ollama-model";

/**
 * Placeholder model names by tier.
 * IMPORTANT: These are SUGGESTIONS ONLY. Always web-search for current Ollama
 * model availability before committing to a model. Availability changes frequently.
 */
const PLACEHOLDER_MODELS: Record<ReturnType<typeof getModelTier>, string> = {
  high:    "llama3:70b",   // suggested, verify current models
  mid:     "llama3:13b",   // suggested, verify current models
  low:     "llama3:8b",    // suggested, verify current models
  minimal: "llama3:3b",    // suggested, verify current models
};

export const phase: PhaseDefinition = {
  id: "03-ollama-model",
  name: "Ollama Model",
  description: "Pull and validate a local Ollama model",
  dependencies: ["02-dependencies"],

  skipWhen: (ctx: PipelineContext) => ctx.mode === "cloud",

  run: async (ctx: PipelineContext): Promise<PhaseResult> => {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];

    const hw = ctx.hardware;
    // getModelTier takes vramMB; for Apple Silicon use totalRam as effective VRAM
    const effectiveVram = hw.isAppleSilicon ? hw.totalRam : hw.gpuVram;
    const tier = getModelTier(effectiveVram);
    const suggestedModel = PLACEHOLDER_MODELS[tier];

    // IMPORTANT: model name must be confirmed via web search before use in production.
    // The placeholder below is based on VRAM tier but may not reflect current availability.
    ctx.logger.warn(
      PHASE,
      `Model selection requires operator confirmation. ` +
      `Suggested model for tier="${tier}" (${(effectiveVram / 1024).toFixed(1)} GB VRAM): ` +
      `"${suggestedModel}" — this is a placeholder; web search current Ollama models before proceeding.`
    );

    if (tier === "minimal") {
      warnings.push(
        `Minimal VRAM tier (<8 GB). Local inference will be very slow. ` +
        `Consider cloud or hybrid mode.`
      );
      ctx.logger.warn(PHASE, warnings[warnings.length - 1]!);
    }

    // Determine the model to use: prefer operator-supplied via customerEnv
    const model: string = ctx.customerEnv["OLLAMA_MODEL"] ?? suggestedModel;

    if (ctx.dryRun) {
      ctx.logger.info(PHASE, `[dry-run] Would pull model: ${model}`);
      ctx.logger.info(PHASE, `[dry-run] Would validate with: ollama list && ollama run ${model} "hello" --format json`);
      return {
        id: "03-ollama-model",
        status: "completed",
        startedAt,
        completedAt: new Date().toISOString(),
        warnings,
        output: { model, tier, pullTime: 0, dryRun: true },
      };
    }

    // Check if the model is already pulled
    const listBefore = await exec(ctx.target, "ollama", ["list"], {
      logger: ctx.logger,
      phase: PHASE,
    });
    const alreadyPulled =
      listBefore.ok &&
      listBefore.stdout.split("\n").some((line) => line.startsWith(model));

    if (alreadyPulled) {
      ctx.logger.info(PHASE, `Model "${model}" already present — skipping pull`);
    } else {
      ctx.logger.info(PHASE, `Pulling model: ${model}`);
      const pullStart = Date.now();

      const pullResult = await exec(ctx.target, "ollama", ["pull", model], {
        logger: ctx.logger,
        phase: PHASE,
        timeout: 3_600_000, // 1 hour — large models take time
        retries: 2,
      });

      const pullTime = Date.now() - pullStart;

      if (!pullResult.ok) {
        return {
          id: "03-ollama-model",
          status: "failed",
          startedAt,
          completedAt: new Date().toISOString(),
          warnings,
          error: `ollama pull ${model} failed: ${pullResult.stderr}`,
          output: { model, tier, pullTime },
        };
      }

      ctx.logger.info(PHASE, `Model pulled in ${(pullTime / 1000).toFixed(1)}s`);
    }

    // Validate: check ollama list shows the model
    const listAfter = await exec(ctx.target, "ollama", ["list"], {
      logger: ctx.logger,
      phase: PHASE,
    });

    const listedModels = listAfter.stdout
      .split("\n")
      .slice(1) // skip header
      .map((l) => l.split(/\s+/)[0])
      .filter(Boolean);

    if (!listedModels.some((m) => m === model || m?.startsWith(model.split(":")[0]!))) {
      return {
        id: "03-ollama-model",
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        warnings,
        error: `Model "${model}" not found in ollama list after pull`,
        output: { model, tier, pullTime: 0, listedModels },
      };
    }

    // Validate: smoke-test inference
    ctx.logger.info(PHASE, `Running inference smoke test: ollama run ${model} "hello"`);
    const testResult = await exec(
      ctx.target,
      "ollama",
      ["run", model, "hello", "--format", "json"],
      { logger: ctx.logger, phase: PHASE, timeout: 120_000 }
    );

    if (!testResult.ok) {
      const msg = `Inference smoke test failed for "${model}": ${testResult.stderr}`;
      ctx.logger.warn(PHASE, msg);
      warnings.push(msg);
    } else {
      ctx.logger.info(PHASE, `Smoke test passed for "${model}"`);
    }

    return {
      id: "03-ollama-model",
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      warnings,
      output: {
        model,
        tier,
        pullTime: alreadyPulled ? 0 : undefined,
        smokeTestPassed: testResult.ok,
      },
    };
  },
};
