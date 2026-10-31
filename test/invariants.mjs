import { readFileSync } from "node:fs";
import { VM } from "@ethereumjs/vm";
import { Common, Chain, Hardfork } from "@ethereumjs/common";
import { LegacyTransaction } from "@ethereumjs/tx";
import { Address, hexToBytes, Account, privateToAddress, bytesToHex } from "@ethereumjs/util";
import { Interface, Wallet, TypedDataEncoder, keccak256 } from "ethers";

const art = JSON.parse(readFileSync("build/artifacts.json","utf8"));
const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const vm = await VM.create({ common });
const A = (h)=> new Address(hexToBytes(h.length===40 ? "0x"+h : "0x"+h.repeat(20)));
const pk = hexToBytes("0x"+"aa".repeat(32));
const nonces = new Map();
const ownerPk = hexToBytes("0x"+"bb".repeat(32));
const execPk  = hexToBytes("0x"+"cc".repeat(32));
const roguePk = hexToBytes("0x"+"dd".repeat(32));
for (const k of [pk, ownerPk, execPk, roguePk]) {
  await vm.stateManager.putAccount(new Address(privateToAddress(k)), new Account(0n, 10n**22n));
}
async function deploy(name, args=[]) {
  const c = art[name]; const iface = new Interface(c.abi);
  const data = hexToBytes(c.bytecode + iface.encodeDeploy(args).slice(2));
  const from = new Address(privateToAddress(pk));
  const acct = await vm.stateManager.getAccount(from);
  const n = acct?.nonce ?? 0n;
  const tx = LegacyTransaction.fromTxData({ nonce:n, gasPrice:10n, gasLimit:30_000_000n, data, value:0n }, { common }).sign(pk);
  const r = await vm.runTx({ tx, skipBlockGasLimitValidation:true });
  if (r.execResult.exceptionError) throw new Error(name+" deploy: "+r.execResult.exceptionError.error);
  return { addr: r.createdAddress, iface };
}
async function send(signerPk, to, iface, fn, args, value=0n) {
  const data = hexToBytes(iface.encodeFunctionData(fn, args));
  const from = new Address(privateToAddress(signerPk));
  const acct = await vm.stateManager.getAccount(from);
  const n = acct?.nonce ?? 0n;
  const tx = LegacyTransaction.fromTxData({ nonce:n, gasPrice:10n, gasLimit:30_000_000n, to, data, value }, { common }).sign(signerPk);
  return vm.runTx({ tx, skipBlockGasLimitValidation:true });
}
async function call(addr, iface, fn, args=[]) {
  const data = hexToBytes(iface.encodeFunctionData(fn, args));
  const rr = await vm.evm.runCall({ caller: A("aa"), origin: A("aa"), to: addr, gasLimit: 10_000_000n, data, value: 0n, skipBalance: true });
  if (rr.execResult.exceptionError) throw new Error(fn+": "+rr.execResult.exceptionError.error);
  return iface.decodeFunctionResult(fn, bytesToHex(rr.execResult.returnValue));
}

const usdc = await deploy("MockERC20", ["USD Coin","USDC",6]);
const weth = await deploy("MockERC20", ["Wrapped Ether","WETH",18]);
const morpho = await deploy("MockMorpho", [0n]);
const rA = await deploy("MockRouterV2", [1n, 1n]);
const rB = await deploy("MockRouterV2", [10008n, 10000n]);

const ownerW = new Wallet("0x"+"bb".repeat(32));
const authW  = Wallet.createRandom();
const execW  = new Wallet("0x"+"cc".repeat(32));
const guardW = Wallet.createRandom();

const ex = await deploy("BaseFlashExecutor", [
  A(ownerW.address.slice(2)).toString(), A(authW.address.slice(2)).toString(),
  A(execW.address.slice(2)).toString(), A(guardW.address.slice(2)).toString(),
  morpho.addr.toString(), weth.addr.toString(), 10n**6n,
]);

const L = 100_000n * 10n**6n;
await send(pk, usdc.addr, usdc.iface, "mint", [morpho.addr.toString(), L]);
await send(pk, weth.addr, weth.iface, "mint", [rA.addr.toString(), L]);
await send(pk, usdc.addr, usdc.iface, "mint", [rB.addr.toString(), (L*10008n)/10000n]);
await send(ownerPk, ex.addr, ex.iface, "setRouter", [rA.addr.toString(), true]);
await send(ownerPk, ex.addr, ex.iface, "setRouter", [rB.addr.toString(), true]);
await send(ownerPk, ex.addr, ex.iface, "setLoanAsset", [usdc.addr.toString(), true]);
await send(ownerPk, ex.addr, ex.iface, "fundGasBudget", [10n**18n], 10n**18n);

const deadline = 2_000_000_000n;
const mkPlan = (over={}) => ({
  loanAsset: usdc.addr.toString(), loanAmount: L, minNetProfitRaw: 5n*10n**6n,
  maxFlashFeeRaw: 10n**6n, gasBudgetWei: 10n**15n, nonce: 1n, deadline,
  profitRecipient: ownerW.address,
  legs: [
    { router: rA.addr.toString(), tokenIn: usdc.addr.toString(), tokenOut: weth.addr.toString(), amountIn: 0n, amountInBps: 10000n, minAmountOut: L, poolFee: 0, dexKind: 0, stable: false, deadline },
    { router: rB.addr.toString(), tokenIn: weth.addr.toString(), tokenOut: usdc.addr.toString(), amountIn: 0n, amountInBps: 10000n, minAmountOut: (L*10008n)/10000n, poolFee: 0, dexKind: 0, stable: false, deadline },
  ],
  ...over,
});
const domain = { name:"V6-HF", version:"1", chainId:1n, verifyingContract: ex.addr.toString() };
const types = { ExecutionPlan: [
  {name:"loanAsset",type:"address"},{name:"loanAmount",type:"uint256"},{name:"minNetProfitRaw",type:"uint256"},
  {name:"maxFlashFeeRaw",type:"uint256"},{name:"gasBudgetWei",type:"uint256"},{name:"nonce",type:"uint256"},
  {name:"deadline",type:"uint256"},{name:"profitRecipient",type:"address"},{name:"legsHash",type:"bytes32"}]};
const legTypes = { Leg: [
  {name:"router",type:"address"},{name:"tokenIn",type:"address"},{name:"tokenOut",type:"address"},
  {name:"amountIn",type:"uint256"},{name:"amountInBps",type:"uint256"},{name:"minAmountOut",type:"uint256"},
  {name:"poolFee",type:"uint24"},{name:"dexKind",type:"uint8"},{name:"stable",type:"bool"},{name:"deadline",type:"uint256"}]};
async function sign(plan, signer) {
  const lh = plan.legs.map(l => TypedDataEncoder.hashStruct("Leg", legTypes, l));
  const legsHash = keccak256("0x" + lh.map(h=>h.slice(2)).join(""));
  return signer.signTypedData(domain, types, { ...plan, legsHash });
}
const topUp = async () => {
  await send(pk, usdc.addr, usdc.iface, "mint", [rB.addr.toString(), (L*10008n)/10000n]);
};
const results = [];
const check = (name, cond, extra="") => { results.push([name, cond]); console.log((cond?"PASS":"FAIL")+"  "+name+(extra?"  "+extra:"")); };

// 1. wrong signer rejected
{
  const p = mkPlan({ nonce: 101n });
  const sig = await sign(p, roguePk ? new Wallet("0x"+"dd".repeat(32)) : authW);
  const r = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  check("wrong signer rejected", !!r.execResult.exceptionError);
}
// 2. expired plan rejected (evaluated against a block with a real timestamp)
{
  const p = mkPlan({ nonce: 102n, deadline: 1_000n });
  const sig = await sign(p, authW);
  const head = await vm.blockchain.getCanonicalHeadBlock();
  const futureBlock = { ...head, header: { ...head.header, timestamp: 2_000n } };
  const data = hexToBytes(ex.iface.encodeFunctionData("execute", [p, sig]));
  const rr = await vm.evm.runCall({
    caller: new Address(privateToAddress(execPk)), origin: new Address(privateToAddress(execPk)),
    to: ex.addr, gasLimit: 10_000_000n, data, value: 0n, skipBalance: true, block: futureBlock,
  });
  check("expired plan rejected", !!rr.execResult.exceptionError, rr.execResult.exceptionError?.error ?? "");
}
// 3. unlisted router rejected -> breaker trips
{
  const p = mkPlan({ nonce: 103n });
  p.legs[0].router = A("ee").toString();
  const sig = await sign(p, authW);
  const r = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  const open = (await call(ex.addr, ex.iface, "breakerOpen"))[0];
  check("unlisted router rejected + breaker latched", !r.execResult.exceptionError && open === true);
}
// 4. breaker blocks further execution
{
  const p = mkPlan({ nonce: 104n });
  const sig = await sign(p, authW);
  const r = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  check("breaker blocks execution", !!r.execResult.exceptionError);
}
// 5. only owner can reset
{
  const r = await send(execPk, ex.addr, ex.iface, "resetBreaker", []);
  check("non-owner cannot reset breaker", !!r.execResult.exceptionError);
  const r2 = await send(ownerPk, ex.addr, ex.iface, "resetBreaker", []);
  check("owner can reset breaker", !r2.execResult.exceptionError);
}
await topUp();
// 6. profit gate: floor above achievable -> invariant violation, breaker trips
{
  const p = mkPlan({ nonce: 105n, minNetProfitRaw: 200n*10n**6n }); // 200 USDC > 80 available
  const sig = await sign(p, authW);
  const r = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  const open = (await call(ex.addr, ex.iface, "breakerOpen"))[0];
  const reason = (await call(ex.addr, ex.iface, "breakerReason"))[0];
  for (const lg of r.execResult.logs ?? []) { try { const pl = ex.iface.parseLog({topics: lg[1].map(t=>"0x"+Buffer.from(t).toString("hex")), data:"0x"+Buffer.from(lg[2]).toString("hex")}); if(pl?.name==="CycleFailed") console.log("   revertData:", pl.args.revertData.slice(0,10), "msg:", Buffer.from(pl.args.revertData.slice(10),"hex").toString("utf8").replace(/\u0000/g,"")); } catch(e){} }
  check("invariant violation trips breaker(1)", !r.execResult.exceptionError && open === true && reason === 1n, "reason="+reason);
  await send(ownerPk, ex.addr, ex.iface, "resetBreaker", []);
}
await topUp();
// 7. replay protection
{
  const p = mkPlan({ nonce: 106n });
  const sig = await sign(p, authW);
  const r1 = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  const r2 = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  check("first execution ok", !r1.execResult.exceptionError);
  check("replay rejected", !!r2.execResult.exceptionError);
}
// 8. budget exhaustion
{
  const p = mkPlan({ nonce: 107n, gasBudgetWei: 10n**30n });
  const sig = await sign(p, authW);
  const r = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  check("budget over-reservation rejected", !!r.execResult.exceptionError);
}
await topUp();
// 9. fee cap: morpho charges 1% but plan caps at 1 USDC
{
  await send(pk, morpho.addr, morpho.iface, "setFee", [10n**16n]); // 1%
  const p = mkPlan({ nonce: 108n });
  const sig = await sign(p, authW);
  const r = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  const reason = (await call(ex.addr, ex.iface, "breakerReason"))[0];
  for (const lg of r.execResult.logs ?? []) { try { const pl = ex.iface.parseLog({topics: lg[1].map(t=>"0x"+Buffer.from(t).toString("hex")), data:"0x"+Buffer.from(lg[2]).toString("hex")}); if(pl?.name==="CycleFailed") console.log("   revertData:", pl.args.revertData.slice(0,10), "msg:", Buffer.from(pl.args.revertData.slice(10),"hex").toString("utf8").replace(/\u0000/g,"")); } catch(e){} }
  check("flash fee cap enforced (reason 3)", !r.execResult.exceptionError && reason === 3n, "reason="+reason);
}
await topUp();
// 10. phase machine returns to IDLE after success
{
  await send(ownerPk, ex.addr, ex.iface, "resetBreaker", []);
  await send(pk, morpho.addr, morpho.iface, "setFee", [0n]);
  const p = mkPlan({ nonce: 109n });
  const sig = await sign(p, authW);
  const r = await send(execPk, ex.addr, ex.iface, "execute", [p, sig]);
  const phase = (await call(ex.addr, ex.iface, "phase"))[0];
  check("successful cycle settles to IDLE", !r.execResult.exceptionError && phase === 0n);
}
const failed = results.filter(([,c])=>!c);
console.log(`\n${results.length-failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
