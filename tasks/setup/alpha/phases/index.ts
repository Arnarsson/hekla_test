import { phase as preflight } from "./00-preflight";
import { phase as userAccount } from "./01-user-account";
import { phase as dependencies } from "./02-dependencies";
import { phase as ollamaModel } from "./03-ollama-model";
import { phase as environment } from "./04-environment";
import { phase as dockerStack } from "./05-docker-stack";
import { phase as database } from "./06-database";
import { phase as agents } from "./07-agents";
import { phase as telegram } from "./08-telegram";
import { phase as email } from "./09-email";
import { phase as scheduling } from "./10-scheduling";
import { phase as tailscale } from "./11-tailscale";
import { phase as finalQa } from "./12-final-qa";
import type { PhaseDefinition } from "../types";

export const allPhases: PhaseDefinition[] = [
  preflight, userAccount, dependencies, ollamaModel,
  environment, dockerStack, database, agents,
  telegram, email, scheduling, tailscale, finalQa,
];

export function getPhase(id: string): PhaseDefinition | undefined {
  return allPhases.find((p) => p.id === id);
}
