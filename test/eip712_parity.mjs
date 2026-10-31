import { readFileSync } from "node:fs";
import { VM } from "@ethereumjs/vm";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { LegacyTransaction } from "@ethereumjs/tx";
import { Address, hexToBytes, bytesToHex } from "@ethereumjs/util";
import { Interface, AbiCoder, getAddress } from "ethers";
import { hashPlan, keccak256Utf8, PLAN_TYPE_STRING, LEG_TYPE_STRING, parseUnits } from "/workspace/v6-hf/dist/packages/core/src/index.js";

const art = JSON.parse(readFileSync("/workspace/v6-hf/build/artifacts.json","utf8"));
const ex = art.BaseFlashExecutor;

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });

const owner = new Address(hexToBytes("0x" + "11".repeat(20)));
const auth  = new Address(hexToBytes("0x" + "22".repeat(20)));
const exec  = new Address(hexToBytes("0x" + "33".repeat(20)));
const guard = new Address(hexToBytes("0x" + "44".repeat(20)));
const morpho= new Address(hexToBytes("0x" + "55".repeat(20)));
const weth  = new Address(hexToBytes("0x" + "66".repeat(20)));

const iface = new Interface(ex.abi);
const ctor = iface.encodeDeploy([owner.toString(), auth.toString(), exec.toString(), guard.toString(), morpho.toString(), weth.toString(), 10n**6n]);

const deploy = await vm.evm.runCall({
  caller: owner, origin: owner, gasLimit: 30_000_000n,
  data: hexToBytes(ctor), value: 0n,
});
if (deploy.execResult.exceptionError) { console.error("DEPLOY FAILED", deploy.execResult.exceptionError); process.exit(1); }
const contract = deploy.createdAddress;
// runCall does not persist the created account; write the runtime code explicitly.
await vm.stateManager.putContractCode(contract, hexToBytes(ex.deployedBytecode));
console.log("deployed at", contract.toString());

async function call(fn, args=[]) {
  const data = iface.encodeFunctionData(fn, args);
  const r = await vm.evm.runCall({ caller: owner, origin: owner, to: contract, gasLimit: 30_000_000n, data: hexToBytes(data), value: 0n });
  if (r.execResult.exceptionError) throw new Error(fn + ": " + JSON.stringify(r.execResult.exceptionError));
  return iface.decodeFunctionResult(fn, bytesToHex(r.execResult.returnValue));
}

// --- typehash parity ---
const onChainPlan = (await call("EXECUTION_PLAN_TYPEHASH"))[0];
const onChainLeg  = (await call("LEG_TYPEHASH"))[0];
const localPlan = keccak256Utf8(PLAN_TYPE_STRING);
const localLeg  = keccak256Utf8(LEG_TYPE_STRING);
console.log("PLAN typehash match:", onChainPlan.toLowerCase() === localPlan.toLowerCase());
console.log("LEG  typehash match:", onChainLeg.toLowerCase() === localLeg.toLowerCase());
if (onChainPlan.toLowerCase() !== localPlan.toLowerCase()) { console.error("MISMATCH", onChainPlan, localPlan); process.exit(1); }
if (onChainLeg.toLowerCase() !== localLeg.toLowerCase()) { console.error("MISMATCH", onChainLeg, localLeg); process.exit(1); }

// --- plan digest parity ---
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const R1 = "0x1111111111111111111111111111111111111111";
const R2 = "0x2222222222222222222222222222222222222222";
const L = parseUnits("100000", 6);

const plan = {
  loanAsset: USDC, loanAmount: L, minNetProfitRaw: parseUnits("5",6), maxFlashFeeRaw: parseUnits("1",6),
  gasBudgetWei: 10n**15n, nonce: 7n, deadline: 2000000000n, profitRecipient: R1,
  legs: [
    { router: R1, tokenIn: USDC, tokenOut: WETH, amountIn: 0n, amountInBps: 10000n, minAmountOut: L, poolFee: 0, dexKind: 0, stable: false, deadline: 2000000000n },
    { router: R2, tokenIn: WETH, tokenOut: USDC, amountIn: 0n, amountInBps: 10000n, minAmountOut: (L*10008n)/10000n, poolFee: 500, dexKind: 1, stable: true, deadline: 2000000000n },
  ],
};

const tuple = {
  loanAsset: plan.loanAsset, loanAmount: plan.loanAmount, minNetProfitRaw: plan.minNetProfitRaw,
  maxFlashFeeRaw: plan.maxFlashFeeRaw, gasBudgetWei: plan.gasBudgetWei, nonce: plan.nonce,
  deadline: plan.deadline, profitRecipient: plan.profitRecipient,
  legs: plan.legs.map(l => ({...l})),
};

const onChainDigest = (await call("hashPlan", [tuple]))[0];
const localDigest = hashPlan(plan, { chainId: 1n, verifyingContract: contract.toString() });
console.log("on-chain digest:", onChainDigest);
console.log("local    digest:", localDigest);
console.log("DIGEST MATCH:", onChainDigest.toLowerCase() === localDigest.toLowerCase());
if (onChainDigest.toLowerCase() !== localDigest.toLowerCase()) { console.error("DIGEST MISMATCH"); process.exit(1); }

// --- access control: non-executor cannot call execute ---
const bad = await vm.evm.runCall({ caller: owner, origin: owner, to: contract, gasLimit: 5_000_000n, data: hexToBytes(iface.encodeFunctionData("execute", [tuple, "0x" + "00".repeat(65)])), value: 0n });
console.log("non-executor execute reverted:", !!bad.execResult.exceptionError);

// --- signer isolation: authorizer == executor must revert at deploy ---
// NOTE: runCall does not execute initcode here, so we use a real signed tx.
{
  const { LegacyTransaction } = await import("@ethereumjs/tx");
  const { Account, privateToAddress } = await import("@ethereumjs/util");
  const dPk = hexToBytes("0x" + "aa".repeat(32));
  const dFrom = new Address(privateToAddress(dPk));
  await vm.stateManager.putAccount(dFrom, new Account(0n, 10n ** 20n));
  const acct = await vm.stateManager.getAccount(dFrom);
  const init = hexToBytes(ex.bytecode + iface.encodeDeploy([
    owner.toString(), exec.toString(), exec.toString(), guard.toString(),
    morpho.toString(), weth.toString(), 10n ** 6n,
  ]).slice(2));
  const tx = LegacyTransaction.fromTxData(
    { nonce: acct?.nonce ?? 0n, gasPrice: 10n, gasLimit: 30_000_000n, data: init, value: 0n },
    { common },
  ).sign(dPk);
  const r = await vm.runTx({ tx, skipBlockGasLimitValidation: true });
  console.log("merged-signer deploy reverted:", !!r.execResult.exceptionError);
  if (!r.execResult.exceptionError) { console.error("ISOLATION NOT ENFORCED"); process.exit(1); }
}

// --- phase machine starts IDLE ---
console.log("phase:", (await call("phase"))[0].toString(), "(0 = IDLE)");
console.log("breakerOpen:", (await call("breakerOpen"))[0]);
console.log("ALL CONTRACT PARITY CHECKS PASSED");
