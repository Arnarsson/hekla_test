import { hostname, userInfo, homedir } from "os";
import { accessSync, readFileSync, readdirSync } from "fs";
import type {
  HardwareProfile,
  DirtyStateReport,
  ExistingInstalls,
  GPUType,
  PkgManager,
  Scheduler,
  OSType,
} from "./types.ts";

async function runCmd(
  cmd: string,
  args: string[]
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { ok: exitCode === 0, stdout: stdout.trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

async function getCpuModel(platform: string): Promise<string> {
  if (platform === "darwin") {
    const { stdout } = await runCmd("sysctl", ["-n", "machdep.cpu.brand_string"]);
    return stdout || "Unknown CPU";
  }

  if (platform === "linux") {
    try {
      const cpuinfo = readFileSync("/proc/cpuinfo", "utf8");
      for (const line of cpuinfo.split("\n")) {
        if (line.startsWith("model name")) {
          return line.split(":")[1]?.trim() ?? "Unknown CPU";
        }
      }
    } catch {
      // fall through
    }
    return "Unknown CPU";
  }

  if (platform === "win32") {
    const { stdout } = await runCmd("wmic", ["cpu", "get", "name"]);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    // First line is header "Name", second is value
    return lines[1] ?? "Unknown CPU";
  }

  return "Unknown CPU";
}

async function getRamMB(platform: string): Promise<number> {
  if (platform === "darwin") {
    const { stdout } = await runCmd("sysctl", ["hw.memsize"]);
    // "hw.memsize: 17179869184"
    const bytes = parseInt(stdout.split(":")[1]?.trim() ?? "0", 10);
    return Math.floor(bytes / 1024 / 1024);
  }

  if (platform === "linux") {
    try {
      const meminfo = readFileSync("/proc/meminfo", "utf8");
      for (const line of meminfo.split("\n")) {
        if (line.startsWith("MemTotal:")) {
          const kb = parseInt(line.split(/\s+/)[1] ?? "0", 10);
          return Math.floor(kb / 1024);
        }
      }
    } catch {
      // fall through
    }
    return 0;
  }

  if (platform === "win32") {
    const { stdout } = await runCmd("wmic", ["OS", "get", "TotalVisibleMemorySize"]);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const kb = parseInt(lines[1] ?? "0", 10);
    return Math.floor(kb / 1024);
  }

  return 0;
}

async function getDiskFreeMB(platform: string): Promise<number> {
  if (platform === "darwin" || platform === "linux") {
    const { stdout } = await runCmd("df", ["-m", "/"]);
    // Header: Filesystem 1M-blocks Used Available Use% Mounted
    const lines = stdout.split("\n").filter(Boolean);
    const dataLine = lines[1];
    if (dataLine) {
      const parts = dataLine.split(/\s+/);
      // Available is index 3
      return parseInt(parts[3] ?? "0", 10);
    }
    return 0;
  }

  if (platform === "win32") {
    const { stdout } = await runCmd("wmic", ["logicaldisk", "get", "freespace"]);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const bytes = parseInt(lines[1] ?? "0", 10);
    return Math.floor(bytes / 1024 / 1024);
  }

  return 0;
}

async function detectGPU(
  platform: string,
  arch: string,
  ramMB: number
): Promise<{ gpuType: GPUType; gpuVram: number }> {
  // Try NVIDIA first (any platform)
  const nvidia = await runCmd("nvidia-smi", [
    "--query-gpu=name,memory.total",
    "--format=csv,noheader",
  ]);
  if (nvidia.ok && nvidia.stdout) {
    // "NVIDIA A100, 81920 MiB" or "NVIDIA RTX 4090, 24576 MiB"
    const line = nvidia.stdout.split("\n")[0] ?? "";
    const match = line.match(/(\d+)\s*MiB/);
    const vram = match ? parseInt(match[1], 10) : 0;
    return { gpuType: "cuda", gpuVram: vram };
  }

  // Apple Silicon — Metal + unified memory
  if (platform === "darwin" && arch === "arm64") {
    return { gpuType: "metal", gpuVram: ramMB };
  }

  // macOS x64 — check for eGPU via system_profiler
  if (platform === "darwin" && arch === "x64") {
    const sp = await runCmd("system_profiler", ["SPDisplaysDataType"]);
    if (sp.ok && sp.stdout.toLowerCase().includes("nvidia")) {
      // External NVIDIA GPU
      return { gpuType: "cuda", gpuVram: 0 };
    }
    return { gpuType: "none", gpuVram: 0 };
  }

  return { gpuType: "none", gpuVram: 0 };
}

async function isWSL(): Promise<boolean> {
  try {
    const content = readFileSync("/proc/version", "utf8").toLowerCase();
    return content.includes("microsoft") || content.includes("wsl");
  } catch {
    return false;
  }
}

async function detectExistingInstalls(): Promise<ExistingInstalls> {
  const [dockerWhich, ollamaWhich, bunWhich, tailscaleWhich] =
    await Promise.all([
      runCmd("which", ["docker"]),
      runCmd("which", ["ollama"]),
      runCmd("which", ["bun"]),
      runCmd("which", ["tailscale"]),
    ]);

  const dockerInstalled = dockerWhich.ok;
  const ollamaInstalled = ollamaWhich.ok;
  const bunInstalled = bunWhich.ok;
  const tailscaleInstalled = tailscaleWhich.ok;

  let dockerVersion: string | undefined;
  let ollamaVersion: string | undefined;
  let bunVersion: string | undefined;
  let tailscaleVersion: string | undefined;
  let ollamaModels: string[] = [];

  if (dockerInstalled) {
    const v = await runCmd("docker", ["--version"]);
    dockerVersion = v.stdout || undefined;
  }

  if (ollamaInstalled) {
    const v = await runCmd("ollama", ["--version"]);
    ollamaVersion = v.stdout || undefined;

    const list = await runCmd("ollama", ["list"]);
    if (list.ok && list.stdout) {
      // Skip header line, parse model names (first column)
      const lines = list.stdout.split("\n").slice(1).filter(Boolean);
      ollamaModels = lines
        .map((l) => l.split(/\s+/)[0])
        .filter((name): name is string => Boolean(name));
    }
  }

  if (bunInstalled) {
    const v = await runCmd("bun", ["--version"]);
    bunVersion = v.stdout || undefined;
  }

  if (tailscaleInstalled) {
    const v = await runCmd("tailscale", ["--version"]);
    tailscaleVersion = v.stdout.split("\n")[0] || undefined;
  }

  return {
    docker: dockerInstalled,
    dockerVersion,
    ollama: ollamaInstalled,
    ollamaVersion,
    ollamaModels,
    bun: bunInstalled,
    bunVersion,
    tailscale: tailscaleInstalled,
    tailscaleVersion,
  };
}

function getPkgManager(platform: string, wsl: boolean): PkgManager {
  if (platform === "darwin") return "brew";
  if (platform === "linux" || wsl) {
    try {
      accessSync("/usr/bin/apt");
      return "apt";
    } catch {
      // fall through
    }
    try {
      accessSync("/usr/bin/dnf");
      return "dnf";
    } catch {
      // fall through
    }
    return "apt"; // sensible default for Linux
  }
  return "winget";
}

function getScheduler(platform: string, wsl: boolean): Scheduler {
  if (platform === "darwin") return "launchd";
  if (platform === "linux" || wsl) return "systemd";
  return "taskschd";
}

export async function detectHardware(): Promise<HardwareProfile> {
  const platform = process.platform as OSType;
  const arch = process.arch;

  const [cpuModel, ramMB, diskFreeMB, wsl] = await Promise.all([
    getCpuModel(platform),
    getRamMB(platform),
    getDiskFreeMB(platform),
    isWSL(),
  ]);

  const { gpuType, gpuVram } = await detectGPU(platform, arch, ramMB);
  const existingInstalls = await detectExistingInstalls();

  const isAppleSilicon = platform === "darwin" && arch === "arm64";
  const cpuUpper = cpuModel.toUpperCase();
  const isDGXSpark =
    cpuUpper.includes("DGX") ||
    cpuUpper.includes("GRACE") ||
    (existingInstalls.dockerVersion?.toUpperCase().includes("DGX") ?? false);

  const pkgManager = getPkgManager(platform, wsl);
  const scheduler = getScheduler(platform, wsl);
  const dockerRuntime =
    platform === "darwin" || platform === "win32" ? "desktop" : "engine";

  return {
    os: platform,
    arch,
    cpuModel,
    gpuType,
    gpuVram,
    totalRam: ramMB,
    diskFree: diskFreeMB,
    pkgManager,
    scheduler,
    dockerRuntime,
    isWSL: wsl,
    isAppleSilicon,
    isDGXSpark,
    hostname: hostname(),
    username: userInfo().username,
    existingInstalls,
  };
}

export async function detectDirtyState(
  hw: HardwareProfile
): Promise<DirtyStateReport> {
  const heklaContainerPatterns = ["hekla", "shadow"];

  // Old Docker containers
  let oldDockerContainers: string[] = [];
  if (hw.existingInstalls.docker) {
    const { ok, stdout } = await runCmd("docker", [
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
    ]);
    if (ok && stdout) {
      oldDockerContainers = stdout
        .split("\n")
        .filter((name) =>
          heklaContainerPatterns.some((pat) =>
            name.toLowerCase().includes(pat)
          )
        );
    }
  }

  // UTM VMs (macOS only)
  let utmVMs: string[] = [];
  if (hw.os === "darwin") {
    const utmDir = `${homedir()}/Library/Containers/com.utmapp.UTM`;
    try {
      accessSync(utmDir);
      // List VM bundles if the directory exists
      const entries = readdirSync(utmDir).filter((e) => e.endsWith(".utm"));
      utmVMs = entries;
    } catch {
      // UTM not installed
    }
  }

  // Shadow Mind remnants
  const shadowPaths = [
    `${homedir()}/.shadow-mind`,
    `${homedir()}/shadow-mind`,
    "/opt/shadow-mind",
    "/usr/local/shadow-mind",
  ];
  const shadowMindRemnants: string[] = [];
  for (const p of shadowPaths) {
    try {
      accessSync(p);
      shadowMindRemnants.push(p);
    } catch {
      // not found
    }
  }

  // Old configs — .env files in common HEKLA paths
  const heklaPaths = [
    `${homedir()}/.hekla`,
    `${homedir()}/hekla`,
    "/opt/hekla",
    "/usr/local/hekla",
  ];
  const oldConfigs: string[] = [];
  for (const dir of heklaPaths) {
    const envFile = `${dir}/.env`;
    try {
      accessSync(envFile);
      oldConfigs.push(envFile);
    } catch {
      // not found
    }
  }

  // Stale env files in project root (cwd)
  const staleEnvFiles: string[] = [];
  const cwdEnv = `${process.cwd()}/.env`;
  try {
    accessSync(cwdEnv);
    staleEnvFiles.push(cwdEnv);
  } catch {
    // not found
  }

  const oldOllama =
    hw.existingInstalls.ollama && hw.existingInstalls.ollamaModels.length > 0;

  return {
    oldOllama,
    oldDockerContainers,
    utmVMs,
    shadowMindRemnants,
    oldConfigs,
    staleEnvFiles,
  };
}
