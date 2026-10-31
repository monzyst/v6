#!/usr/bin/env node
/**
 * Deterministic solc build. Emits ABI + bytecode into build/ so the off-chain
 * packages can import a single source of truth for the executor ABI.
 */
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const CONTRACTS = path.join(ROOT, "contracts");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".sol")) out.push(p);
  }
  return out;
}

const sources = {};
for (const f of walk(CONTRACTS)) {
  sources[path.relative(ROOT, f)] = { content: fs.readFileSync(f, "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    viaIR: true,
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] },
    },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));

let hard = 0;
for (const e of out.errors || []) {
  const line = `${e.severity.toUpperCase()}: ${e.formattedMessage}`;
  if (e.severity === "error") { hard++; console.error(line); }
  else console.warn(line);
}
if (hard) { console.error(`\n${hard} error(s)`); process.exit(1); }

const buildDir = path.join(ROOT, "build");
fs.mkdirSync(buildDir, { recursive: true });

const index = {};
for (const [file, contracts] of Object.entries(out.contracts || {})) {
  for (const [name, c] of Object.entries(contracts)) {
    if (!c.evm.bytecode.object) continue; // interfaces / libraries without code
    index[name] = {
      file,
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,
      deployedBytecode: "0x" + c.evm.deployedBytecode.object,
    };
  }
}
fs.writeFileSync(path.join(buildDir, "artifacts.json"), JSON.stringify(index, null, 2));
console.log(`compiled ${Object.keys(index).length} contract(s): ${Object.keys(index).join(", ")}`);
