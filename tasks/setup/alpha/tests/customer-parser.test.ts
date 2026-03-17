import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseCustomerMd, parseCustomerEnv } from "../customer-parser";

const FIXTURES = join(import.meta.dir, "../fixtures/customers");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

// ---------------------------------------------------------------------------
// parseCustomerMd
// ---------------------------------------------------------------------------

describe("parseCustomerMd — Christopher's actual file", () => {
  const profile = parseCustomerMd(fixture("valid.md"));

  test("extracts name", () => {
    expect(profile.name).toBe("Christopher James Lüscher");
  });

  test("extracts language", () => {
    expect(profile.language).toContain("Danish");
  });

  test("extracts timezone", () => {
    expect(profile.timezone).toBe("Europe/Copenhagen");
  });

  test("extracts technical level", () => {
    expect(profile.technicalLevel).toContain("Non-technical");
  });

  test("parses all 6 email accounts", () => {
    expect(profile.emails).toHaveLength(6);
  });

  test("first email is lyscher@gmail.com / Gmail", () => {
    const first = profile.emails[0];
    expect(first?.email).toBe("lyscher@gmail.com");
    expect(first?.provider).toBe("Gmail");
  });

  test("email rows have oauthStatus and action fields", () => {
    for (const account of profile.emails) {
      expect(typeof account.email).toBe("string");
      expect(typeof account.provider).toBe("string");
      expect(typeof account.oauthStatus).toBe("string");
      expect(typeof account.action).toBe("string");
    }
  });

  test("parses ventures (6 expected)", () => {
    expect(profile.ventures.length).toBeGreaterThanOrEqual(6);
    const names = profile.ventures.join(" ");
    expect(names).toContain("Curcle");
    expect(names).toContain("Patentopia");
    expect(names).toContain("LeapCraft");
  });

  test("parses personality summary bullets", () => {
    expect(profile.personalitySummary.length).toBeGreaterThan(0);
    const joined = profile.personalitySummary.join(" ");
    expect(joined).toContain("Danish");
  });

  test("parses known issues", () => {
    expect(profile.knownIssues.length).toBeGreaterThan(0);
    const joined = profile.knownIssues.join(" ");
    expect(joined).toContain("Shadow Mind");
  });

  test("unified inbox is set", () => {
    expect(profile.unifiedInbox).toContain("christopher@hekla.is");
  });
});

describe("parseCustomerMd — minimal file", () => {
  const profile = parseCustomerMd(fixture("minimal.md"));

  test("extracts name from Customer: header", () => {
    expect(profile.name).toBe("Test User");
  });

  test("returns empty arrays for missing sections", () => {
    expect(profile.emails).toHaveLength(0);
    expect(profile.ventures).toHaveLength(0);
    expect(profile.personalitySummary).toHaveLength(0);
    expect(profile.knownIssues).toHaveLength(0);
  });

  test("returns empty strings for missing fields", () => {
    expect(profile.language).toBe("");
    expect(profile.timezone).toBe("");
    expect(profile.technicalLevel).toBe("");
  });
});

describe("parseCustomerMd — malformed input", () => {
  const profile = parseCustomerMd(fixture("malformed.md"));

  test("does not throw", () => {
    expect(() => parseCustomerMd(fixture("malformed.md"))).not.toThrow();
  });

  test("name falls back to first non-empty line", () => {
    // No Customer: or ## heading → uses first non-empty line
    expect(profile.name.length).toBeGreaterThan(0);
  });

  test("emails is empty array", () => {
    expect(profile.emails).toHaveLength(0);
  });
});

describe("parseCustomerMd — empty string", () => {
  test("does not throw on empty input", () => {
    expect(() => parseCustomerMd("")).not.toThrow();
  });

  test("returns empty/falsy fields", () => {
    const profile = parseCustomerMd("");
    expect(profile.name).toBe("");
    expect(profile.emails).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseCustomerEnv
// ---------------------------------------------------------------------------

describe("parseCustomerEnv", () => {
  test("parses KEY=VALUE pairs", () => {
    const env = parseCustomerEnv("FOO=bar\nBAZ=qux");
    expect(env["FOO"]).toBe("bar");
    expect(env["BAZ"]).toBe("qux");
  });

  test("skips comment lines", () => {
    const env = parseCustomerEnv("# this is a comment\nKEY=value");
    expect(Object.keys(env)).not.toContain("# this is a comment");
    expect(env["KEY"]).toBe("value");
  });

  test("skips blank lines", () => {
    const env = parseCustomerEnv("\n\nKEY=value\n\n");
    expect(Object.keys(env)).toHaveLength(1);
  });

  test("strips double-quoted values", () => {
    const env = parseCustomerEnv('KEY="hello world"');
    expect(env["KEY"]).toBe("hello world");
  });

  test("strips single-quoted values", () => {
    const env = parseCustomerEnv("KEY='hello world'");
    expect(env["KEY"]).toBe("hello world");
  });

  test("handles value with = sign inside", () => {
    const env = parseCustomerEnv("URL=http://example.com?a=1&b=2");
    expect(env["URL"]).toBe("http://example.com?a=1&b=2");
  });

  test("handles empty value", () => {
    const env = parseCustomerEnv("EMPTY=");
    expect(env["EMPTY"]).toBe("");
  });

  test("returns empty object for empty input", () => {
    expect(parseCustomerEnv("")).toEqual({});
  });

  test("returns empty object for comment-only input", () => {
    expect(parseCustomerEnv("# comment\n# another")).toEqual({});
  });
});
