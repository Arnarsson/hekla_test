// Inference modes
export type InferenceMode = "local" | "cloud" | "hybrid";

// Platform detection
export type OSType = "darwin" | "linux" | "win32";
export type GPUType = "cuda" | "metal" | "none";
export type PkgManager = "brew" | "apt" | "dnf" | "winget" | "choco";
export type Scheduler = "launchd" | "systemd" | "taskschd";

export interface PlatformInfo {
  os: OSType;
  arch: string;          // x64, arm64
  cpuModel: string;
  gpuType: GPUType;
  gpuVram: number;       // MB, 0 if none. For Apple Silicon, unified memory
  totalRam: number;      // MB
  diskFree: number;      // MB
  pkgManager: PkgManager;
  scheduler: Scheduler;
  dockerRuntime: "desktop" | "engine"; // Docker Desktop vs Engine
  isWSL: boolean;
  isAppleSilicon: boolean;
  isDGXSpark: boolean;
}

export interface HardwareProfile extends PlatformInfo {
  hostname: string;
  username: string;
  existingInstalls: ExistingInstalls;
}

export interface ExistingInstalls {
  docker: boolean;
  dockerVersion?: string;
  ollama: boolean;
  ollamaVersion?: string;
  ollamaModels: string[];
  bun: boolean;
  bunVersion?: string;
  tailscale: boolean;
  tailscaleVersion?: string;
}

export interface DirtyStateReport {
  oldOllama: boolean;
  oldDockerContainers: string[];
  utmVMs: string[];
  shadowMindRemnants: string[];
  oldConfigs: string[];
  staleEnvFiles: string[];
}

// Customer profile
export interface CustomerProfile {
  name: string;
  language: string;
  timezone: string;
  technicalLevel: string;
  emails: EmailAccount[];
  unifiedInbox?: string;
  calendarProvider?: string;
  calendarEmail?: string;
  chatInterface: string;
  ventures: string[];
  personalitySummary: string[];
  knownIssues: string[];
}

export interface EmailAccount {
  email: string;
  provider: string;
  oauthStatus: string;
  action: string;
}

// Environment / secrets
export interface CustomerEnv {
  [key: string]: string;
}

// Phase system
export type PhaseID =
  | "00-preflight" | "01-user-account" | "02-dependencies"
  | "03-ollama-model" | "04-environment" | "05-docker-stack"
  | "06-database" | "07-agents" | "08-telegram" | "09-email"
  | "10-scheduling" | "11-tailscale" | "12-final-qa";

export type PhaseStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export interface PhaseResult {
  id: PhaseID;
  status: PhaseStatus;
  startedAt: string;
  completedAt?: string;
  output: Record<string, unknown>;
  error?: string;
  warnings: string[];
}

export interface PhaseDefinition {
  id: PhaseID;
  name: string;
  description: string;
  dependencies: PhaseID[];
  skipWhen?: (ctx: PipelineContext) => boolean;
  run: (ctx: PipelineContext) => Promise<PhaseResult>;
}

// Pipeline context passed to all phases
export interface PipelineContext {
  customer: CustomerProfile;
  customerEnv: CustomerEnv;
  customerDir: string;
  hardware: HardwareProfile;
  dirtyState: DirtyStateReport;
  mode: InferenceMode;
  target: ExecutionTarget;
  dryRun: boolean;
  verbose: boolean;
  sequential: boolean;
  results: Map<PhaseID, PhaseResult>;
  logger: Logger;
}

// Execution target
export type ExecutionTarget =
  | { type: "local" }
  | { type: "ssh"; host: string; user: string; port: number };

// Logger interface
export interface Logger {
  info(phase: string, msg: string, data?: Record<string, unknown>): void;
  warn(phase: string, msg: string, data?: Record<string, unknown>): void;
  error(phase: string, msg: string, data?: Record<string, unknown>): void;
  debug(phase: string, msg: string, data?: Record<string, unknown>): void;
}

// CLI options
export interface CLIOptions {
  customer: string;
  mode: InferenceMode;
  target: ExecutionTarget;
  dryRun: boolean;
  fromPhase?: PhaseID;
  onlyPhase?: PhaseID;
  resume: boolean;
  sequential: boolean;
  verbose: boolean;
}
