import type { CustomerProfile, CustomerEnv, EmailAccount } from "./types";

// ---------------------------------------------------------------------------
// Markdown parser
// ---------------------------------------------------------------------------

export function parseCustomerMd(content: string): CustomerProfile {
  const lines = content.split("\n");

  // Helper: extract a labelled value — handles "Label: val", "**Label:** val", "- **Label:** val"
  const extractField = (label: string): string => {
    const re = new RegExp(`(?:^|[-*•]\\s*)\\**${label}\\**\\s*:\\**\\s*(.+)`, "i");
    for (const line of lines) {
      const m = line.trim().match(re);
      if (m) return m[1].trim();
    }
    return "";
  };

  // Helper: get all lines that belong to a section heading (## Section)
  const getSectionLines = (heading: string): string[] => {
    const re = new RegExp(`^#+\\s+${heading}`, "i");
    let inSection = false;
    const result: string[] = [];
    for (const line of lines) {
      if (/^#+\s+/.test(line)) {
        inSection = re.test(line);
        continue;
      }
      if (inSection) result.push(line);
    }
    return result;
  };

  // Helper: parse bullet lines from a section into string[]
  const parseBullets = (heading: string): string[] =>
    getSectionLines(heading)
      .filter((l) => /^\s*[-*•]\s+/.test(l))
      .map((l) => l.replace(/^\s*[-*•]\s+/, "").trim())
      .filter(Boolean);

  // Name: first "Customer: ..." line, or first ## heading, or first non-empty line
  let name = extractField("Customer");
  if (!name) {
    const headingLine = lines.find((l) => /^#+\s+/.test(l));
    name = headingLine ? headingLine.replace(/^#+\s+/, "").trim() : "";
  }
  if (!name) {
    name = lines.find((l) => l.trim().length > 0)?.trim() ?? "";
  }

  const language = extractField("Language");
  const timezone = extractField("Timezone");
  const technicalLevel = extractField("Technical level");

  // Email table — parse markdown table rows
  const emails = parseEmailTable(lines);

  // Unified inbox
  const unifiedInbox = extractField("hekla\\.is address") || extractField("Unified inbox") || undefined;

  // Calendar
  const calendarLines = getSectionLines("Calendar");
  const calendarProvider = extractLabelFromLines(calendarLines, "Provider");
  const calendarEmail = extractLabelFromLines(calendarLines, "Email");

  // Chat interface
  const chatInterface = extractField("Chat interface") || extractFirstBullet(getSectionLines("Chat interface"));

  // Ventures
  const ventures = parseBullets("Ventures");

  // Personality summary
  const personalitySummary =
    parseBullets("PA agent personality summary").length > 0
      ? parseBullets("PA agent personality summary")
      : parseBullets("Personality summary");

  // Known issues
  const knownIssues = parseBullets("Known issues");

  return {
    name,
    language,
    timezone,
    technicalLevel,
    emails,
    unifiedInbox,
    calendarProvider: calendarProvider || undefined,
    calendarEmail: calendarEmail || undefined,
    chatInterface,
    ventures,
    personalitySummary,
    knownIssues,
  };
}

// Parse a markdown table of email accounts.
// Expected columns (order may vary): Email | Provider | OAuth | Action
function parseEmailTable(lines: string[]): EmailAccount[] {
  const accounts: EmailAccount[] = [];
  let headerIndices: { email: number; provider: number; oauth: number; action: number } | null =
    null;

  for (const line of lines) {
    if (!line.trim().startsWith("|")) continue;

    const cells = line
      .split("|")
      .slice(1, -1) // drop leading/trailing empty from split
      .map((c) => c.trim());

    // Separator row
    if (cells.every((c) => /^[-: ]+$/.test(c))) continue;

    // Header row
    if (!headerIndices) {
      const lower = cells.map((c) => c.toLowerCase());
      const emailIdx = lower.findIndex((c) => c.includes("email"));
      const providerIdx = lower.findIndex((c) => c.includes("provider"));
      const oauthIdx = lower.findIndex((c) => c.includes("oauth") || c.includes("status"));
      const actionIdx = lower.findIndex((c) => c.includes("action"));

      if (emailIdx !== -1) {
        headerIndices = {
          email: emailIdx,
          provider: providerIdx !== -1 ? providerIdx : -1,
          oauth: oauthIdx !== -1 ? oauthIdx : -1,
          action: actionIdx !== -1 ? actionIdx : -1,
        };
      }
      continue;
    }

    // Data row
    const get = (idx: number) => (idx !== -1 && idx < cells.length ? cells[idx] : "");
    const emailVal = get(headerIndices.email);
    if (emailVal && emailVal.length > 0) {
      accounts.push({
        email: emailVal,
        provider: get(headerIndices.provider),
        oauthStatus: get(headerIndices.oauth),
        action: get(headerIndices.action),
      });
    }
  }

  return accounts;
}

function extractLabelFromLines(lines: string[], label: string): string {
  const re = new RegExp(`^\\s*${label}\\s*:\\s*(.+)`, "i");
  for (const line of lines) {
    const m = line.match(re);
    if (m) return m[1].trim();
  }
  return "";
}

function extractFirstBullet(lines: string[]): string {
  const bullet = lines.find((l) => /^\s*[-*•]\s+/.test(l));
  return bullet ? bullet.replace(/^\s*[-*•]\s+/, "").trim() : "";
}

// ---------------------------------------------------------------------------
// .env parser
// ---------------------------------------------------------------------------

export function parseCustomerEnv(content: string): CustomerEnv {
  const env: CustomerEnv = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadCustomer(customerDir: string): Promise<{
  profile: CustomerProfile;
  env: CustomerEnv;
}> {
  const mdPath = `${customerDir}/customer.md`;
  const envPath = `${customerDir}/customer.env`;

  const mdFile = Bun.file(mdPath);
  if (!(await mdFile.exists())) {
    throw new Error(`customer.md not found at ${mdPath}`);
  }
  const mdContent = await mdFile.text();
  const profile = parseCustomerMd(mdContent);

  let env: CustomerEnv = {};
  const envFile = Bun.file(envPath);
  if (await envFile.exists()) {
    const envContent = await envFile.text();
    env = parseCustomerEnv(envContent);
  } else {
    console.warn(`[loadCustomer] customer.env not found at ${envPath} — continuing without secrets`);
  }

  return { profile, env };
}
