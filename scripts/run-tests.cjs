#!/usr/bin/env node
/**
 * Test runner.
 *
 * Each suite is a standalone `.mjs` script that prints its own assertion lines
 * and exits non-zero on the first failure. This runner executes them in a fixed
 * order (Phase 1 first, then Phase 2, then the separation proof), streams their
 * output, and exits non-zero if any suite fails.
 *
 * Usage:
 *   node scripts/run-tests.cjs                 # all suites
 *   node scripts/run-tests.cjs accounting ...  # a subset, in the given order
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const ALL = [
  // Phase 1 — must stay green; these are the regression gate.
  "accounting",
  "eip712_parity",
  "e2e_cycle",
  "invariants",
  // Phase 1, lane ii (Solana) — shared economics with F = 0
  "solana_accounting",
  // Phase 2
  "phase2_strategies",
  "phase2_contracts",
  // Phase separation proof
  "phase_separation",
];

const requested = process.argv.slice(2);
const suites = requested.length > 0 ? requested : ALL;

const root = join(__dirname, "..");
const results = [];

for (const name of suites) {
  const file = join(root, "test", `${name}.mjs`);
  if (!existsSync(file)) {
    console.error(`\n  MISSING  ${name} (no such file: test/${name}.mjs)`);
    results.push({ name, ok: false, summary: "missing" });
    continue;
  }

  process.stdout.write(`\n${"=".repeat(64)}\n  ${name}\n${"=".repeat(64)}\n`);
  const r = spawnSync(process.execPath, [file], { stdio: "inherit", cwd: root });
  const ok = r.status === 0;
  results.push({ name, ok, summary: ok ? "pass" : `exit ${r.status}` });
}

const failed = results.filter((r) => !r.ok);
const width = Math.max(...results.map((r) => r.name.length));

console.log(`\n${"=".repeat(64)}\n  SUMMARY\n${"=".repeat(64)}`);
for (const r of results) {
  console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.summary}`);
}
console.log(
  `\n  ${results.length - failed.length}/${results.length} suites passed` +
    (failed.length ? ` — FAILED: ${failed.map((f) => f.name).join(", ")}` : ""),
);

process.exit(failed.length === 0 ? 0 : 1);
