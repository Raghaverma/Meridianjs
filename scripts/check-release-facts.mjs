#!/usr/bin/env node
// Verifies that hardcoded numbers in docs (provider count, contract test
// count, total test count, supported-version table) match reality. Run it
// after any adapter/test change, or let CI catch the drift on every PR.
//
//   node scripts/check-release-facts.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

function countTests(testFile) {
  const args = ["vitest", "list"];
  if (testFile) args.push(testFile);
  const out = execFileSync("npx", args, { cwd: root, encoding: "utf8" });
  return out.split("\n").filter((line) => line.trim().length > 0).length;
}

const { version } = JSON.parse(read("package.json"));
const [major, minor] = version.split(".");
const supportedRange = `${major}.${minor}.x`;

const providers = JSON.parse(
  execFileSync("node", ["scripts/list-providers.mjs"], { cwd: root, encoding: "utf8" }),
);
const providerCount = providers.length;

const contractTestCount = countTests("src/providers/contract.test.ts");
const totalTestCount = countTests();

const failures = [];

// Checks every occurrence of `pattern` (must be global) against `expected`,
// since the same fact (e.g. provider count) is often quoted more than once.
function checkAllOccurrences(file, label, pattern, expected) {
  const content = read(file);
  const matches = [...content.matchAll(pattern)];
  if (matches.length === 0) {
    failures.push(`${file}: could not find pattern for "${label}"`);
    return;
  }
  for (const match of matches) {
    if (match[1] !== String(expected)) {
      failures.push(`${file}: "${label}" says ${match[1]}, expected ${expected}`);
    }
  }
}

checkAllOccurrences("README.md", "version badge", /version-(\d+\.\d+\.\d+)-blue/g, version);
checkAllOccurrences("README.md", "adapters badge", /adapters-(\d+)-blueviolet/g, providerCount);
checkAllOccurrences(
  "README.md",
  "contract tests badge",
  /contract%20tests-(\d+)-brightgreen/g,
  contractTestCount,
);
checkAllOccurrences("README.md", "total tests badge", /tests-(\d+)%20passing/g, totalTestCount);
checkAllOccurrences("README.md", "adapters prose", /\*\*(\d+) adapters\*\*/g, providerCount);
checkAllOccurrences(
  "README.md",
  "contract tests prose",
  /\((\d+) contract tests\)/g,
  contractTestCount,
);
checkAllOccurrences("README.md", "providers mentions", /all (\d+) providers/g, providerCount);
checkAllOccurrences(
  "clients/python/README.md",
  "providers mention",
  /all (\d+) providers/g,
  providerCount,
);
checkAllOccurrences(
  "SECURITY.md",
  "supported version",
  /\| (\d+\.\d+\.x)\s*\| :white_check_mark: \|/g,
  supportedRange,
);
checkAllOccurrences(
  "docs/what-is-meridian.md",
  "adapters count",
  /contains\*? (\d+) adapters/g,
  providerCount,
);
checkAllOccurrences(
  "docs/what-is-meridian.md",
  "adapters count (across all)",
  /across all (\d+)\*/g,
  providerCount,
);

if (failures.length > 0) {
  console.error("Release facts drifted from reality:\n");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nCanonical facts: version=${version} adapters=${providerCount} contractTests=${contractTestCount} totalTests=${totalTestCount} supported=${supportedRange}`,
  );
  process.exit(1);
}

console.log(
  `Release facts OK: version=${version} adapters=${providerCount} contractTests=${contractTestCount} totalTests=${totalTestCount} supported=${supportedRange}`,
);
