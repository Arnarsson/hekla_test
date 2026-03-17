import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  getInstallCommand,
  getSchedulerPaths,
  getOllamaUrl,
  getUserCreateCommand,
  getDockerComposeGPUConfig,
  needsNvidiaToolkit,
} from "../platform";
import type { PlatformInfo } from "../types";

const FIXTURES = join(import.meta.dir, "../fixtures/hardware");

function loadPlatform(name: string): PlatformInfo {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as PlatformInfo;
}

// ---------------------------------------------------------------------------
// getInstallCommand
// ---------------------------------------------------------------------------

describe("getInstallCommand", () => {
  test("brew on darwin", () => {
    const p = loadPlatform("mac-m4-24gb.json");
    expect(getInstallCommand("git", p)).toEqual(["brew", "install", "git"]);
  });

  test("apt on linux", () => {
    const p = loadPlatform("linux-nvidia-a4000.json");
    expect(getInstallCommand("git", p)).toEqual(["apt", "install", "-y", "git"]);
  });

  test("winget on windows", () => {
    const p: PlatformInfo = {
      ...loadPlatform("windows-wsl.json"),
      pkgManager: "winget",
    };
    expect(getInstallCommand("git", p)).toEqual(["winget", "install", "git"]);
  });

  test("dnf on linux with dnf", () => {
    const p: PlatformInfo = {
      ...loadPlatform("linux-nvidia-a4000.json"),
      pkgManager: "dnf",
    };
    expect(getInstallCommand("git", p)).toEqual(["dnf", "install", "-y", "git"]);
  });

  test("choco on windows with choco", () => {
    const p: PlatformInfo = {
      ...loadPlatform("windows-wsl.json"),
      pkgManager: "choco",
    };
    expect(getInstallCommand("git", p)).toEqual(["choco", "install", "-y", "git"]);
  });
});

// ---------------------------------------------------------------------------
// getSchedulerPaths
// ---------------------------------------------------------------------------

describe("getSchedulerPaths", () => {
  test("launchd on darwin returns Library/LaunchAgents dir", () => {
    const p = loadPlatform("mac-m4-24gb.json");
    const paths = getSchedulerPaths(p);
    expect(paths.dir).toContain("LaunchAgents");
    expect(paths.listCmd).toEqual(["launchctl", "list"]);
  });

  test("systemd on linux returns .config/systemd/user dir", () => {
    const p = loadPlatform("linux-nvidia-a4000.json");
    const paths = getSchedulerPaths(p);
    expect(paths.dir).toContain("systemd");
    expect(paths.listCmd).toContain("systemctl");
  });

  test("taskschd on windows returns schtasks command", () => {
    const p = loadPlatform("windows-wsl.json");
    const paths = getSchedulerPaths(p);
    expect(paths.listCmd).toContain("schtasks");
  });
});

// ---------------------------------------------------------------------------
// getOllamaUrl
// ---------------------------------------------------------------------------

describe("getOllamaUrl", () => {
  test("darwin → host.docker.internal", () => {
    const p = loadPlatform("mac-m4-24gb.json");
    expect(getOllamaUrl(p)).toBe("http://host.docker.internal:11434");
  });

  test("linux (non-WSL) → docker bridge gateway", () => {
    const p = loadPlatform("linux-nvidia-a4000.json");
    expect(getOllamaUrl(p)).toBe("http://172.17.0.1:11434");
  });

  test("WSL → host.docker.internal", () => {
    const p = loadPlatform("windows-wsl.json");
    expect(getOllamaUrl(p)).toBe("http://host.docker.internal:11434");
  });

  test("win32 (non-WSL) → host.docker.internal", () => {
    const p: PlatformInfo = {
      ...loadPlatform("windows-wsl.json"),
      isWSL: false,
    };
    expect(getOllamaUrl(p)).toBe("http://host.docker.internal:11434");
  });
});

// ---------------------------------------------------------------------------
// getUserCreateCommand
// ---------------------------------------------------------------------------

describe("getUserCreateCommand", () => {
  test("darwin → sysadminctl", () => {
    const p = loadPlatform("mac-m4-24gb.json");
    const cmd = getUserCreateCommand("hekla", p);
    expect(cmd[0]).toBe("sysadminctl");
    expect(cmd).toContain("-addUser");
    expect(cmd).toContain("hekla");
  });

  test("linux → useradd", () => {
    const p = loadPlatform("linux-nvidia-a4000.json");
    const cmd = getUserCreateCommand("hekla", p);
    expect(cmd[0]).toBe("useradd");
    expect(cmd).toContain("hekla");
  });

  test("WSL → useradd (linux path)", () => {
    const p = loadPlatform("windows-wsl.json");
    const cmd = getUserCreateCommand("hekla", p);
    expect(cmd[0]).toBe("useradd");
  });
});

// ---------------------------------------------------------------------------
// getDockerComposeGPUConfig
// ---------------------------------------------------------------------------

describe("getDockerComposeGPUConfig", () => {
  test("cuda → returns nvidia deploy config object", () => {
    const p = loadPlatform("linux-nvidia-a4000.json");
    const config = getDockerComposeGPUConfig(p);
    expect(config).not.toBeNull();
    expect(JSON.stringify(config)).toContain("nvidia");
  });

  test("metal (Apple Silicon) → returns null", () => {
    const p = loadPlatform("mac-m4-24gb.json");
    expect(getDockerComposeGPUConfig(p)).toBeNull();
  });

  test("none (no GPU) → returns null", () => {
    const p = loadPlatform("linux-no-gpu.json");
    expect(getDockerComposeGPUConfig(p)).toBeNull();
  });

  test("DGX Spark CUDA → returns nvidia config", () => {
    const p = loadPlatform("dgx-spark.json");
    const config = getDockerComposeGPUConfig(p);
    expect(config).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// needsNvidiaToolkit
// ---------------------------------------------------------------------------

describe("needsNvidiaToolkit", () => {
  test("cuda → true", () => {
    const p = loadPlatform("linux-nvidia-a4000.json");
    expect(needsNvidiaToolkit(p)).toBe(true);
  });

  test("metal → false", () => {
    const p = loadPlatform("mac-m4-24gb.json");
    expect(needsNvidiaToolkit(p)).toBe(false);
  });

  test("none → false", () => {
    const p = loadPlatform("linux-no-gpu.json");
    expect(needsNvidiaToolkit(p)).toBe(false);
  });

  test("DGX Spark CUDA → true", () => {
    const p = loadPlatform("dgx-spark.json");
    expect(needsNvidiaToolkit(p)).toBe(true);
  });
});
