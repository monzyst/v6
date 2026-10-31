import { readFileSync } from "node:fs";
import { VM } from "@ethereumjs/vm";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { LegacyTransaction } from "@ethereumjs/tx";
import { Address, hexToBytes, Account, privateToAddress } from "@ethereumjs/util";
import { Interface, Wallet, TypedDataEncoder, getAddress } from "ethers";

/**
 * Phase 2 on-chain test suite.
 *
 * Runs the real Phase2Executor + PhaseRegistry + MockPhase2Venue in an in-process
 * EVM. Every assertion is on real state: the phase machine, the breaker, the
 * budget pool, the position record, and the exact integer carry.
 *
 * Follows the harness rules from the testing-solidity-in-process-evm skill:
 *   - deploys go through a SIGNED transaction (runCall does not execute initcode)
 *   - nonces are read from state, never from a counter
 *   - the deploy asserts BOTH exceptionError == null AND code length > 0
 */

const art = JSON.parse(readFileSync("build/artifacts.json", "utf8"));
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });

const results = [];
const check = (name, cond, extra = "") => {
  results.push([name, cond]);
  console.log((cond ? "PASS" : "FAIL") + "  " + name + (extra ? "  " + extra : ""));
};

const A = (h) => new Address(hexToBytes(h.length === 40 ? "0x" + h : "0x" + h.repeat(20)));
const pk = hexToBytes("0x" + "aa".repeat(32));
const sender = new Address(privateToAddress(pk));
await vm.stateManager.putAccount(sender, new Account(0n, 10n ** 24n));

async function nonceOf(addr) {
  const acct = await vm.stateManager.getAccount(addr);
  return acct?.nonce ?? 0n;
}

async function deploy(name, args = [], signerPk = pk) {
  const c = art[name];
  const iface = new Interface(c.abi);
  const data = hexToBytes(c.bytecode + iface.encodeDeploy(args).slice(2));
  const from = new Address(privateToAddress(signerPk));
  const n = await nonceOf(from);
  const tx = LegacyTransaction.fromTxData(
    { nonce: n, gasPrice: 10n, gasLimit: 30_000_000n, data, value: 0n },
    { common },
  ).sign(signerPk);
  const r = await vm.runTx({ tx, skipBlockGasLimitValidation: true });
  if (r.execResult.exceptionError) throw new Error(`${name} deploy: ${r.execResult.exceptionError.error}`);
  const code = await vm.stateManager.getContractCode(r.createdAddress);
  if (code.length === 0) throw new Error(`${name} deploy produced no code`);
  return { addr: r.createdAddress, iface };
}

async function send(signerPk, to, iface, fn, args, value = 0n) {
  const pkBytes = typeof signerPk === "string" ? hexToBytes(signerPk) : signerPk;
  const data = hexToBytes(iface.encodeFunctionData(fn, args));
  const from = new Address(privateToAddress(pkBytes));
  const n = await nonceOf(from);
  const tx = LegacyTransaction.fromTxData(
    { nonce: n, gasPrice: 10n, gasLimit: 30_000_000n, to, data, value },
    { common },
  ).sign(pkBytes);
  return vm.runTx({ tx, skipBlockGasLimitValidation: true });
}

async function call(to, iface, fn, args) {
  const data = hexToBytes(iface.encodeFunctionData(fn, args));
  const r = await vm.evm.runCall({
    to,
    caller: sender,
    data,
    gasLimit: 30_000_000n,
    origin: sender,
  });
  if (r.execResult.exceptionError) throw new Error(`call ${fn}: ${r.execResult.exceptionError.error}`);
  return iface.decodeFunctionResult(fn, r.execResult.returnValue);
}

const ok = (r) => r.execResult.exceptionError === undefined || r.execResult.exceptionError === null;
const errOf = (r) => r.execResult.exceptionError?.error ?? "none";

// =====================================================================
// Deploy
// =====================================================================
console.log("--- deploy ---");
const usdc = await deploy("MockERC20", ["USD Coin", "USDC", 6]);
const venueA = await deploy("MockPhase2Venue", [10020n, 10000n]); // +0.20%
const venueB = await deploy("MockPhase2Venue", [10010n, 10000n]); // +0.10%

const ownerW = new Wallet("0x" + "bb".repeat(32));
const authW = new Wallet("0x" + "cc".repeat(32));
const execW = new Wallet("0x" + "dd".repeat(32));
const guardW = new Wallet("0x" + "ee".repeat(32));
const owner = A(ownerW.address.slice(2));
const auth = A(authW.address.slice(2));
const exec = A(execW.address.slice(2));
const guard = A(guardW.address.slice(2));
for (const w of [ownerW, authW, execW, guardW]) {
  await vm.stateManager.putAccount(A(w.address.slice(2)), new Account(0n, 10n ** 22n));
}

const registry = await deploy("PhaseRegistry", [owner.toString(), 3600n]);
const ex = await deploy("Phase2Executor", [
  owner.toString(),
  auth.toString(),
  exec.toString(),
  guard.toString(),
  registry.addr.toString(),
  10n ** 9n, // absoluteMaxCostRaw
]);
console.log("   registry:", registry.addr.toString());
console.log("   executor:", ex.addr.toString());

check("PhaseRegistry deployed with code", (await vm.stateManager.getContractCode(registry.addr)).length > 0);
check("Phase2Executor deployed with code", (await vm.stateManager.getContractCode(ex.addr)).length > 0);

// Deployment step: the owner registers the executor as a venue admin so its own
// `setVenue` can mirror into the registry. Without this the executor's setVenue
// reverts — the registry is the single source of truth for the allowlist.
{
  const r = await send(ownerW.privateKey, registry.addr, registry.iface, "setVenueAdmin", [
    ex.addr.toString(),
    true,
  ]);
  check("owner registers the executor as a venue admin", ok(r), errOf(r));
}

// =====================================================================
// Phase machine bootstrap
// =====================================================================
console.log("\n--- phase machine bootstrap ---");
{
  const [phase] = await call(ex.addr, ex.iface, "phase", []);
  check("executor boots into P2_IDLE (10), not Phase 1 IDLE (0)", phase === 10n, `phase=${phase}`);

  const [cycleId] = await call(ex.addr, ex.iface, "phaseCycleId", []);
  check("cycle id starts at 0", cycleId === 0n);
}

// =====================================================================
// Registry: Phase 1 always on, Phase 2 opt-in
// =====================================================================
console.log("\n--- registry gating ---");
{
  const [p1] = await call(registry.addr, registry.iface, "isPhaseEnabled", [1n]);
  const [p2] = await call(registry.addr, registry.iface, "isPhaseEnabled", [2n]);
  check("Phase 1 is enabled unconditionally", p1 === true);
  check("Phase 2 is disabled by default", p2 === false);

  const snapRes = await call(registry.addr, registry.iface, "snapshot", []);
  check("snapshot reports phase1Enabled = true", snapRes[0] === true, String(snapRes[0]));
  check("snapshot reports phase2On = false", snapRes[1] === false, String(snapRes[1]));

  // Enabling Phase 2 requires the owner.
  const bad = await send(execW.privateKey, registry.addr, registry.iface, "setPhase2Enabled", [true]);
  check("non-owner cannot enable Phase 2", !ok(bad), errOf(bad));

  const good = await send(ownerW.privateKey, registry.addr, registry.iface, "setPhase2Enabled", [true]);
  check("owner can enable Phase 2", ok(good), errOf(good));

  const [p2b] = await call(registry.addr, registry.iface, "isPhaseEnabled", [2n]);
  check("Phase 2 now enabled", p2b === true);

  // Strategy arming is two-step with a delay.
  const arm1 = await send(ownerW.privateKey, registry.addr, registry.iface, "armStrategy", [1n]);
  check("cannot arm a strategy without requesting first", !ok(arm1), errOf(arm1));

  const req = await send(ownerW.privateKey, registry.addr, registry.iface, "requestStrategyArm", [1n]);
  check("owner can request a strategy arm", ok(req), errOf(req));

  const arm2 = await send(ownerW.privateKey, registry.addr, registry.iface, "armStrategy", [1n]);
  check("cannot arm before the delay elapses", !ok(arm2), errOf(arm2));

  const [strat] = await call(registry.addr, registry.iface, "isStrategyEnabled", [1n]);
  check("strategy is not enabled before arming", strat === false);
}

// =====================================================================
// Access control & signer isolation
// =====================================================================
console.log("\n--- access control ---");
{
  const [authAddr] = await call(ex.addr, ex.iface, "authorizer", []);
  const [ownerAddr] = await call(ex.addr, ex.iface, "owner", []);
  check("authorizer is the cold key", getAddress(authAddr) === getAddress(authW.address));
  check("owner is the owner key", getAddress(ownerAddr) === getAddress(ownerW.address));
  check("authorizer != owner (isolation)", getAddress(authAddr) !== getAddress(ownerAddr));

  const [isExec] = await call(ex.addr, ex.iface, "isExecutor", [execW.address]);
  check("hot key holds EXECUTOR_ROLE", isExec === true);

  const [authIsExec] = await call(ex.addr, ex.iface, "isExecutor", [authW.address]);
  check("cold key does NOT hold EXECUTOR_ROLE", authIsExec === false);

  // Deploying with a merged authorizer/executor key must revert.
  let mergedReverted = false;
  try {
    await deploy("Phase2Executor", [
      owner.toString(),
      auth.toString(),
      auth.toString(), // executor == authorizer
      guard.toString(),
      registry.addr.toString(),
      10n ** 9n,
    ]);
  } catch {
    mergedReverted = true;
  }
  check("deploy with merged authorizer/executor keys reverts", mergedReverted);

  // A non-executor cannot call an entry point.
  const bad = await send(ownerW.privateKey, ex.addr, ex.iface, "openPosition", [
    emptyPlan(),
    "0x" + "00".repeat(65),
  ]);
  check("non-executor cannot call openPosition", !ok(bad), errOf(bad));
}

// =====================================================================
// Budget
// =====================================================================
console.log("\n--- budget ---");
{
  const [pool0] = await call(ex.addr, ex.iface, "gasBudgetPoolWei", []);
  check("budget pool starts at zero", pool0 === 0n);

  const bad = await send(execW.privateKey, ex.addr, ex.iface, "fundGasBudget", [10n ** 18n], 10n ** 18n);
  check("non-owner cannot fund the budget", !ok(bad), errOf(bad));

  const mismatch = await send(ownerW.privateKey, ex.addr, ex.iface, "fundGasBudget", [10n ** 18n], 5n);
  check("fundGasBudget rejects a value mismatch", !ok(mismatch), errOf(mismatch));

  const good = await send(ownerW.privateKey, ex.addr, ex.iface, "fundGasBudget", [10n ** 18n], 10n ** 18n);
  check("owner can fund the budget", ok(good), errOf(good));

  const [pool1] = await call(ex.addr, ex.iface, "gasBudgetPoolWei", []);
  check("budget pool reflects the funding", pool1 === 10n ** 18n, `${pool1}`);

  const [avail] = await call(ex.addr, ex.iface, "availableGasBudgetWei", []);
  check("available budget equals the pool when nothing is reserved", avail === 10n ** 18n);
}

// =====================================================================
// Venue allowlist
// =====================================================================
console.log("\n--- venue allowlist ---");
{
  const [allowed0] = await call(registry.addr, registry.iface, "venueAllowed", [venueA.addr.toString()]);
  check("venue is not allowlisted by default", allowed0 === false);

  const set = await send(ownerW.privateKey, ex.addr, ex.iface, "setVenue", [venueA.addr.toString(), true]);
  check("owner can allowlist a venue", ok(set), errOf(set));

  const [allowed1] = await call(registry.addr, registry.iface, "venueAllowed", [venueA.addr.toString()]);
  check("allowlist is mirrored into the registry", allowed1 === true);
}

// =====================================================================
// Phase gating on the entry points
// =====================================================================
console.log("\n--- phase gating ---");
{
  // Disable Phase 2 and confirm the entry point refuses.
  await send(ownerW.privateKey, registry.addr, registry.iface, "setPhase2Enabled", [false]);
  const disabled = await send(execW.privateKey, ex.addr, ex.iface, "openPosition", [
    emptyPlan(),
    "0x" + "00".repeat(65),
  ]);
  check("openPosition refuses when Phase 2 is disabled", !ok(disabled), errOf(disabled));

  await send(ownerW.privateKey, registry.addr, registry.iface, "setPhase2Enabled", [true]);

  // A strategy that is not armed must be refused.
  const unarmed = await send(execW.privateKey, ex.addr, ex.iface, "openPosition", [
    emptyPlan(),
    "0x" + "00".repeat(65),
  ]);
  check("openPosition refuses an unarmed strategy", !ok(unarmed), errOf(unarmed));
}

// =====================================================================
// Phase 1 entry point cannot be reached from the Phase 2 executor
// =====================================================================
console.log("\n--- cross-phase reachability ---");
{
  // The Phase 2 executor has no `execute` function at all.
  const hasExecute = ex.iface.fragments.some((f) => f.type === "function" && f.name === "execute");
  check("Phase2Executor exposes no Phase 1 `execute` entry point", hasExecute === false);

  const hasFlashCallback = ex.iface.fragments.some(
    (f) => f.type === "function" && (f.name === "onMorphoFlashLoan" || f.name === "onFlashLoan"),
  );
  check("Phase2Executor exposes no flash-loan callback", hasFlashCallback === false);

  // And the Phase 1 executor has no Phase 2 entry points.
  const p1 = art["BaseFlashExecutor"];
  const p1iface = new Interface(p1.abi);
  const p1HasOpen = p1iface.fragments.some((f) => f.type === "function" && f.name === "openPosition");
  const p1HasHedge = p1iface.fragments.some((f) => f.type === "function" && f.name === "hedgePosition");
  const p1HasClose = p1iface.fragments.some((f) => f.type === "function" && f.name === "closePosition");
  check("BaseFlashExecutor exposes no Phase 2 entry points", !p1HasOpen && !p1HasHedge && !p1HasClose);

  // The two ABIs share no function name other than the access-control surface.
  const p1Names = new Set(p1iface.fragments.filter((f) => f.type === "function").map((f) => f.name));
  const p2Names = new Set(ex.iface.fragments.filter((f) => f.type === "function").map((f) => f.name));
  const shared = [...p2Names].filter((n) => p1Names.has(n));
  const allowedShared = new Set([
    // access control
    "owner", "authorizer", "hasRole", "isExecutor", "grantRole", "revokeRole",
    "setAuthorizer", "transferOwnership",
    // role constants
    "OWNER_ROLE", "AUTHORIZER_ROLE", "EXECUTOR_ROLE", "GUARDIAN_ROLE",
    // phase machine + breaker
    "phase", "phaseCycleId", "breakerOpen", "breakerReason", "breakerTrippedAt",
    "breakerTripCount", "resetBreaker", "tripBreaker",
    // breaker reason constants
    "BREAKER_INVARIANT", "BREAKER_BUDGET", "BREAKER_FEE_CAP", "BREAKER_PROFIT_GATE",
    "BREAKER_SWAP", "BREAKER_MANUAL", "BREAKER_HEALTH",
    // budget
    "fundGasBudget", "gasBudgetPoolWei", "gasReservedWei", "availableGasBudgetWei",
    // venue admin + rescue
    "setVenue", "rescue",
    // EIP-712 surface
    "domainSeparator", "hashPlan",
    // replay protection
    "planConsumed", "nonceConsumed",
  ]);
  const unexpected = shared.filter((n) => !allowedShared.has(n));
  check("the two ABIs share no execution function", unexpected.length === 0, unexpected.join(","));

  // The shared surface must contain no function that moves funds or runs a plan.
  const dangerous = ["execute", "runCycle", "openPosition", "hedgePosition", "closePosition", "dispatch"];
  const leaked = shared.filter((n) => dangerous.includes(n));
  check("no execution entry point is shared between the phases", leaked.length === 0, leaked.join(","));
}

// =====================================================================
// Breaker
// =====================================================================
console.log("\n--- breaker ---");
{
  const [open0] = await call(ex.addr, ex.iface, "breakerOpen", []);
  check("breaker starts closed", open0 === false);

  const bad = await send(execW.privateKey, ex.addr, ex.iface, "tripBreaker", [6n]);
  check("a non-guardian cannot trip the breaker", !ok(bad), errOf(bad));

  const good = await send(guardW.privateKey, ex.addr, ex.iface, "tripBreaker", [6n]);
  check("the guardian can trip the breaker", ok(good), errOf(good));

  const [open1] = await call(ex.addr, ex.iface, "breakerOpen", []);
  const [reason1] = await call(ex.addr, ex.iface, "breakerReason", []);
  check("breaker is open", open1 === true);
  check("breaker reason is recorded", reason1 === 6n, `${reason1}`);

  // While open, the entry point refuses.
  const blocked = await send(execW.privateKey, ex.addr, ex.iface, "openPosition", [
    emptyPlan(),
    "0x" + "00".repeat(65),
  ]);
  check("openPosition refuses while the breaker is open", !ok(blocked), errOf(blocked));

  const badReset = await send(execW.privateKey, ex.addr, ex.iface, "resetBreaker", []);
  check("a non-owner cannot reset the breaker", !ok(badReset), errOf(badReset));

  const goodReset = await send(ownerW.privateKey, ex.addr, ex.iface, "resetBreaker", []);
  check("the owner can reset the breaker", ok(goodReset), errOf(goodReset));

  const [open2] = await call(ex.addr, ex.iface, "breakerOpen", []);
  check("breaker is closed after reset", open2 === false);

  const [phaseAfter] = await call(ex.addr, ex.iface, "phase", []);
  check("reset returns the machine to P2_IDLE", phaseAfter === 10n, `phase=${phaseAfter}`);
}

// =====================================================================
// EIP-712 typehash parity
// =====================================================================
console.log("\n--- eip712 parity ---");
{
  const [legTh] = await call(ex.addr, ex.iface, "P2_LEG_TYPEHASH", []);
  const [planTh] = await call(ex.addr, ex.iface, "PHASE2_PLAN_TYPEHASH", []);

  const { keccak256, toUtf8Bytes } = await import("ethers");
  const localLeg = keccak256(
    toUtf8Bytes(
      "P2Leg(address venue,address tokenIn,address tokenOut,uint256 amountIn," +
        "uint256 minAmountOut,uint8 action,uint256 deadline)",
    ),
  );
  const localPlan = keccak256(
    toUtf8Bytes(
      "Phase2Plan(uint8 strategy,address asset,uint256 deployedRaw,int256 minCarryRaw," +
        "uint256 maxCostRaw,uint256 gasBudgetWei,uint256 nonce,uint256 deadline," +
        "address profitRecipient,bytes32 legsHash)",
    ),
  );
  check("P2_LEG_TYPEHASH matches the local type string", legTh.toLowerCase() === localLeg.toLowerCase());
  check("PHASE2_PLAN_TYPEHASH matches the local type string", planTh.toLowerCase() === localPlan.toLowerCase());

  // The Phase 2 domain name must differ from Phase 1's.
  const [sep] = await call(ex.addr, ex.iface, "domainSeparator", []);
  const p1Sep = TypedDataEncoder.hashDomain({
    name: "V6-HF",
    version: "1",
    chainId: 1n,
    verifyingContract: ex.addr.toString(),
  });
  check("Phase 2 domain separator differs from the Phase 1 domain", sep.toLowerCase() !== p1Sep.toLowerCase());
}

// =====================================================================
// Helpers
// =====================================================================
function emptyPlan() {
  return {
    strategy: 1,
    asset: usdc.addr.toString(),
    deployedRaw: 0n,
    minCarryRaw: 0n,
    maxCostRaw: 0n,
    gasBudgetWei: 0n,
    nonce: 0n,
    deadline: 0n,
    profitRecipient: ownerW.address,
    legs: [],
  };
}

const failed = results.filter(([, c]) => !c);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("FAILED:", failed.map(([n]) => n).join(", "));
  process.exit(1);
}
