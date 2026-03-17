import type { PlatformInfo, Scheduler } from "./types.ts";

export function getInstallCommand(pkg: string, platform: PlatformInfo): string[] {
  switch (platform.pkgManager) {
    case "brew":
      return ["brew", "install", pkg];
    case "apt":
      return ["apt", "install", "-y", pkg];
    case "dnf":
      return ["dnf", "install", "-y", pkg];
    case "winget":
      return ["winget", "install", pkg];
    case "choco":
      return ["choco", "install", "-y", pkg];
  }
}

export function getSchedulerPaths(
  platform: PlatformInfo
): { dir: string; listCmd: string[] } {
  switch (platform.scheduler) {
    case "launchd":
      return {
        dir: `${process.env.HOME}/Library/LaunchAgents`,
        listCmd: ["launchctl", "list"],
      };
    case "systemd":
      return {
        dir: `${process.env.HOME}/.config/systemd/user`,
        listCmd: ["systemctl", "--user", "list-units"],
      };
    case "taskschd":
      return {
        dir: "N/A",
        listCmd: ["schtasks", "/query"],
      };
  }
}

export function getOllamaUrl(platform: PlatformInfo): string {
  // WSL: host.docker.internal routes to the Windows host where Ollama runs natively
  if (platform.isWSL) return "http://host.docker.internal:11434";

  switch (platform.os) {
    case "darwin":
      // Ollama runs natively on macOS; Docker containers reach it via host gateway
      return "http://host.docker.internal:11434";
    case "linux":
      // Docker bridge gateway — standard docker0 IP
      return "http://172.17.0.1:11434";
    case "win32":
      return "http://host.docker.internal:11434";
  }
}

export function getUserCreateCommand(
  username: string,
  platform: PlatformInfo
): string[] {
  if (platform.isWSL || platform.os === "linux") {
    return ["useradd", "--system", username];
  }

  switch (platform.os) {
    case "darwin":
      return ["sysadminctl", "-addUser", username, "-password", "", "-admin"];
    case "win32":
      return ["net", "user", username, "/add"];
  }
}

export function getDockerComposeGPUConfig(
  platform: PlatformInfo
): object | null {
  if (platform.gpuType !== "cuda") {
    // Metal has no Docker GPU passthrough; Apple Silicon containers run via Rosetta/native arm
    return null;
  }

  return {
    deploy: {
      resources: {
        reservations: {
          devices: [
            {
              driver: "nvidia",
              count: "all",
              capabilities: ["gpu"],
            },
          ],
        },
      },
    },
  };
}

export function needsNvidiaToolkit(platform: PlatformInfo): boolean {
  return platform.gpuType === "cuda";
}

export function getServiceManager(platform: PlatformInfo): Scheduler {
  return platform.scheduler;
}
