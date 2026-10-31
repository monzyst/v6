import { readFileSync } from "node:fs";
import { VM } from "@ethereumjs/vm";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { LegacyTransaction } from "@ethereumjs/tx";
import { Address, hexToBytes, Account, privateToAddress, bytesToHex } from "@ethereumjs/util";
import { Interface, Wallet, TypedDataEncoder, getAddress } from "ethers";

const art = JSON.parse(readFileSync("build/artifacts.json","utf8"));
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });
const A = (h)=> new Address(hexToBytes(h.length===40 ? "0x"+h : "0x"+h.repeat(20)));
const pk = hexToBytes("0x"+"aa".repeat(32));
const sender = new Address(privateToAddress(pk));
await vm.stateManager.putAccount(sender, new Account(0n, 10n**22n));
const ownerPk = hexToBytes("0x"+"bb".repeat(32));
const ownerAddr = new Address(privateToAddress(ownerPk));
await vm.stateManager.putAccount(ownerAddr, new Account(0n, 10n**22n));
const nonces = new Map();

async function deploy(name, args=[]) {
  const c = art[name];
  const iface = new Interface(c.abi);
  const data = hexToBytes(c.bytecode + iface.encodeDeploy(args).slice(2));
  const from = new Address(privateToAddress(pk));
  const n = nonces.get(from.toString()) ?? 0n;
  nonces.set(from.toString(), n + 1n);
  const tx = LegacyTransaction.fromTxData({ nonce: n, gasPrice:10n, gasLimit:30_000_000n, data, value:0n }, { common }).sign(pk);
  const r = await vm.runTx({ tx, skipBlockGasLimitValidation:true });
  if (r.execResult.exceptionError) throw new Error(`${name} deploy: ${r.execResult.exceptionError.error}`);
  return { addr: r.createdAddress, iface };
}

async function send(signerPk, to, iface, fn, args, value=0n) {
  const data = hexToBytes(iface.encodeFunctionData(fn, args));
  const from = new Address(privateToAddress(signerPk));
  const n = nonces.get(from.toString()) ?? 0n;
  nonces.set(from.toString(), n + 1n);
  const tx = LegacyTransaction.fromTxData({ nonce: n, gasPrice:10n, gasLimit:30_000_000n, to, data, value }, { common }).sign(signerPk);
  const r = await vm.runTx({ tx, skipBlockGasLimitValidation:true });
  return r;
}

// ---- deploy mocks ----
const usdc = await deploy("MockERC20", ["USD Coin","USDC",6]);
const weth = await deploy("MockERC20", ["Wrapped Ether","WETH",18]);
const morpho = await deploy("MockMorpho", [0n]); // zero fee
const routerA = await deploy("MockRouterV2", [1n, 1n]);          // 1:1
const routerB = await deploy("MockRouterV2", [10008n, 10000n]);  // +0.08%

// ---- keys ----
const ownerW = new Wallet("0x"+"bb".repeat(32));
const authW  = Wallet.createRandom();
const execW  = new Wallet("0x"+"cc".repeat(32));
const guardW = Wallet.createRandom();
const owner = A(ownerW.address.slice(2)), auth = A(authW.address.slice(2)), exec = A(execW.address.slice(2)), guard = A(guardW.address.slice(2));

const ex = await deploy("BaseFlashExecutor", [
  owner.toString(), auth.toString(), exec.toString(), guard.toString(),
  morpho.addr.toString(), weth.addr.toString(), 10n**6n,
]);
console.log("executor:", ex.addr.toString());

// ---- fund & configure ----
const L = 100_000n * 10n**6n;
await send(pk, usdc.addr, usdc.iface, "mint", [morpho.addr.toString(), L]);
await send(pk, usdc.addr, usdc.iface, "mint", [ex.addr.toString(), 0n]);
// Router A must hold WETH inventory to pay out leg 1; router B must hold USDC.
await send(pk, weth.addr, weth.iface, "mint", [routerA.addr.toString(), L]);
await send(pk, usdc.addr, usdc.iface, "mint", [routerB.addr.toString(), (L*10008n)/10000n]);
let rr1 = await send(ownerPk, ex.addr, ex.iface, "setRouter", [routerA.addr.toString(), true]); console.log("setRouterA:", rr1.execResult.exceptionError?.error ?? "ok");
let rr2 = await send(ownerPk, ex.addr, ex.iface, "setRouter", [routerB.addr.toString(), true]); console.log("setRouterB:", rr2.execResult.exceptionError?.error ?? "ok");
let rr3 = await send(ownerPk, ex.addr, ex.iface, "setLoanAsset", [usdc.addr.toString(), true]); console.log("setLoanAsset:", rr3.execResult.exceptionError?.error ?? "ok");
let rr4 = await send(ownerPk, ex.addr, ex.iface, "fundGasBudget", [10n**18n], 10n**18n); console.log("fundGasBudget:", rr4.execResult.exceptionError?.error ?? "ok");

// ---- build plan ----
const deadline = 2_000_000_000n;
const plan = {
  loanAsset: usdc.addr.toString(), loanAmount: L, minNetProfitRaw: 5n*10n**6n,
  maxFlashFeeRaw: 10n**6n, gasBudgetWei: 10n**15n, nonce: 1n, deadline,
  profitRecipient: ownerW.address,
  legs: [
    { router: routerA.addr.toString(), tokenIn: usdc.addr.toString(), tokenOut: weth.addr.toString(), amountIn: 0n, amountInBps: 10000n, minAmountOut: L, poolFee: 0, dexKind: 0, stable: false, deadline },
    { router: routerB.addr.toString(), tokenIn: weth.addr.toString(), tokenOut: usdc.addr.toString(), amountIn: 0n, amountInBps: 10000n, minAmountOut: (L*10008n)/10000n, poolFee: 0, dexKind: 0, stable: false, deadline },
  ],
};

// ---- sign with the COLD key ----
const domain = { name:"V6-HF", version:"1", chainId:1n, verifyingContract: ex.addr.toString() };
const types = { ExecutionPlan: [
  {name:"loanAsset",type:"address"},{name:"loanAmount",type:"uint256"},{name:"minNetProfitRaw",type:"uint256"},
  {name:"maxFlashFeeRaw",type:"uint256"},{name:"gasBudgetWei",type:"uint256"},{name:"nonce",type:"uint256"},
  {name:"deadline",type:"uint256"},{name:"profitRecipient",type:"address"},{name:"legsHash",type:"bytes32"}]};

const legTypes = { Leg: [
  {name:"router",type:"address"},{name:"tokenIn",type:"address"},{name:"tokenOut",type:"address"},
  {name:"amountIn",type:"uint256"},{name:"amountInBps",type:"uint256"},{name:"minAmountOut",type:"uint256"},
  {name:"poolFee",type:"uint24"},{name:"dexKind",type:"uint8"},{name:"stable",type:"bool"},{name:"deadline",type:"uint256"}]};

const { keccak256 } = await import("ethers");
const legHashes = plan.legs.map(l => TypedDataEncoder.hashStruct("Leg", legTypes, l));
const legsHash = keccak256("0x" + legHashes.map(h=>h.slice(2)).join(""));
const value = { ...plan, legsHash };
const sig = await authW.signTypedData(domain, types, value);

// ---- execute as the HOT key ----
const execPk = hexToBytes("0x"+"cc".repeat(32));
const execAddr = new Address(privateToAddress(execPk));
await vm.stateManager.putAccount(execAddr, new Account(0n, 10n**22n));
const r = await send(execPk, ex.addr, ex.iface, "execute", [plan, sig]);
console.log("execute err:", r.execResult.exceptionError?.error ?? null);
console.log("gasUsed:", r.execResult.executionGasUsed);
for (const lg of r.execResult.logs ?? []) {
  try {
    const parsed = ex.iface.parseLog({ topics: lg[1].map(t=>"0x"+Buffer.from(t).toString("hex")), data: "0x"+Buffer.from(lg[2]).toString("hex") });
    if (parsed) console.log("EVENT", parsed.name, parsed.args.reason?.toString?.() ?? "", parsed.args.revertData ?? "");
  } catch(e) { }
}

// ---- inspect ----
async function call(fn, args=[]) {
  const data = hexToBytes(ex.iface.encodeFunctionData(fn, args));
  const rr = await vm.evm.runCall({ caller: sender, origin: sender, to: ex.addr, gasLimit: 10_000_000n, data, value: 0n, skipBalance: true });
  if (rr.execResult.exceptionError) throw new Error(fn+": "+rr.execResult.exceptionError.error);
  return ex.iface.decodeFunctionResult(fn, bytesToHex(rr.execResult.returnValue));
}
console.log("cyclesSucceeded:", (await call("cyclesSucceeded"))[0].toString());
console.log("cyclesFailed   :", (await call("cyclesFailed"))[0].toString());
console.log("cumNetProfit   :", (await call("cumulativeNetProfitRaw"))[0].toString());
console.log("breakerOpen    :", (await call("breakerOpen"))[0]);
console.log("phase          :", (await call("phase"))[0].toString());
console.log("poolWei        :", (await call("gasBudgetPoolWei"))[0].toString());
console.log("reservedWei    :", (await call("gasReservedWei"))[0].toString());

// profit recipient balance
const bal = await vm.evm.runCall({ caller: sender, origin: sender, to: usdc.addr, gasLimit: 5_000_000n, data: hexToBytes(usdc.iface.encodeFunctionData("balanceOf",[ownerW.address])), value:0n, skipBalance:true });
console.log("profitRecipient USDC:", usdc.iface.decodeFunctionResult("balanceOf", bytesToHex(bal.execResult.returnValue))[0].toString());
