import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConstitutionError, loadConstitution } from "../src/constitution.js";

const realDir = fileURLToPath(new URL("../../../constitution", import.meta.url));

function tempConstitution(): string {
  const dir = mkdtempSync(join(tmpdir(), "derek-const-"));
  copyFileSync(join(realDir, "CONSTITUTION.md"), join(dir, "CONSTITUTION.md"));
  copyFileSync(join(realDir, "LIMITS.json"), join(dir, "LIMITS.json"));
  return dir;
}

describe("constitution loader", () => {
  it("loads the repo constitution and reports a content hash", () => {
    const c = loadConstitution(realDir);
    expect(c.limits.max_award_gbp).toBe(980);
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.text.length).toBeGreaterThan(500);
  });

  it("refuses to boot when LIMITS.json is corrupted", () => {
    const dir = tempConstitution();
    writeFileSync(join(dir, "LIMITS.json"), "{ not json");
    expect(() => loadConstitution(dir)).toThrow(ConstitutionError);
  });

  it("refuses to boot when LIMITS.json fails validation", () => {
    const dir = tempConstitution();
    const limits = JSON.parse(readFileSync(join(dir, "LIMITS.json"), "utf8"));
    limits.fee_split.burn = 0.9; // split no longer sums to 1
    writeFileSync(join(dir, "LIMITS.json"), JSON.stringify(limits));
    expect(() => loadConstitution(dir)).toThrow(ConstitutionError);
  });

  it("refuses to boot when the prose stops matching the limits", () => {
    const dir = tempConstitution();
    const limits = JSON.parse(readFileSync(join(dir, "LIMITS.json"), "utf8"));
    limits.max_award_gbp = 1200; // prose still says £980
    writeFileSync(join(dir, "LIMITS.json"), JSON.stringify(limits));
    expect(() => loadConstitution(dir)).toThrow(/max award/);
  });

  it("refuses to boot when the constitution file is missing", () => {
    expect(() => loadConstitution(join(tmpdir(), "no-such-dir"))).toThrow(ConstitutionError);
  });
});
