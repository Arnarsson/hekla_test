import { test, expect, describe } from "bun:test";
import { detectHardware } from "../hardware";
import type { HardwareProfile } from "../types";

// ---------------------------------------------------------------------------
// Live hardware detection — runs on the actual machine
// These tests validate the shape and sanity of the returned profile.
// ---------------------------------------------------------------------------

describe("detectHardware (live)", () => {
  // Detect once and share across all tests in this describe block.
  // Using a module-level promise avoids repeated expensive detection.
  let hw: HardwareProfile;

  // Bun:test doesn't have a describe-scoped beforeAll, so we run detection
  // inline in the first test and share via module scope.
  async function getHw(): Promise<HardwareProfile> {
    if (!hw) hw = await detectHardware();
    return hw;
  }

  test("returns a HardwareProfile object", async () => {
    const profile = await getHw();
    expect(typeof profile).toBe("object");
    expect(profile).not.toBeNull();
  }, 30_000);

  test("os is darwin on this macOS machine", async () => {
    const profile = await getHw();
    expect(profile.os).toBe("darwin");
  }, 30_000);

  test("arch is arm64 on Apple Silicon", async () => {
    const profile = await getHw();
    expect(profile.arch).toBe("arm64");
  }, 30_000);

  test("isAppleSilicon is true", async () => {
    const profile = await getHw();
    expect(profile.isAppleSilicon).toBe(true);
  }, 30_000);

  test("gpuType is metal", async () => {
    const profile = await getHw();
    expect(profile.gpuType).toBe("metal");
  }, 30_000);

  test("totalRam > 0", async () => {
    const profile = await getHw();
    expect(profile.totalRam).toBeGreaterThan(0);
  }, 30_000);

  test("diskFree > 0", async () => {
    const profile = await getHw();
    expect(profile.diskFree).toBeGreaterThan(0);
  }, 30_000);

  test("gpuVram equals totalRam (unified memory)", async () => {
    const profile = await getHw();
    // Apple Silicon: gpuVram is set to ramMB (unified memory)
    expect(profile.gpuVram).toBe(profile.totalRam);
  }, 30_000);

  test("pkgManager is brew on macOS", async () => {
    const profile = await getHw();
    expect(profile.pkgManager).toBe("brew");
  }, 30_000);

  test("scheduler is launchd on macOS", async () => {
    const profile = await getHw();
    expect(profile.scheduler).toBe("launchd");
  }, 30_000);

  test("dockerRuntime is desktop on macOS", async () => {
    const profile = await getHw();
    expect(profile.dockerRuntime).toBe("desktop");
  }, 30_000);

  test("isWSL is false on macOS", async () => {
    const profile = await getHw();
    expect(profile.isWSL).toBe(false);
  }, 30_000);

  test("hostname is a non-empty string", async () => {
    const profile = await getHw();
    expect(typeof profile.hostname).toBe("string");
    expect(profile.hostname.length).toBeGreaterThan(0);
  }, 30_000);

  test("username is a non-empty string", async () => {
    const profile = await getHw();
    expect(typeof profile.username).toBe("string");
    expect(profile.username.length).toBeGreaterThan(0);
  }, 30_000);

  test("cpuModel is a non-empty string", async () => {
    const profile = await getHw();
    expect(typeof profile.cpuModel).toBe("string");
    expect(profile.cpuModel.length).toBeGreaterThan(0);
  }, 30_000);

  test("existingInstalls has required shape", async () => {
    const profile = await getHw();
    const installs = profile.existingInstalls;
    expect(typeof installs.docker).toBe("boolean");
    expect(typeof installs.ollama).toBe("boolean");
    expect(typeof installs.bun).toBe("boolean");
    expect(typeof installs.tailscale).toBe("boolean");
    expect(Array.isArray(installs.ollamaModels)).toBe(true);
  }, 30_000);

  test("bun is detected as installed (we're running under bun)", async () => {
    const profile = await getHw();
    expect(profile.existingInstalls.bun).toBe(true);
  }, 30_000);
});
