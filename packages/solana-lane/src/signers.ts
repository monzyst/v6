import { createHash, sign, verify, createPublicKey, createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import type { SolanaLaneConfig } from "./config.js";

/**
 * Solana lane signer isolation.
 *
 * Solana has no EIP-712 and no contract-level role system, so the isolation
 * boundary is enforced entirely off-chain and must be structural:
 *
 *   AUTHORIZER (cold)  signs a canonical INTENT message. Never signs a
 *                      transaction, never pays a fee, never touches the chain.
 *   EXECUTOR  (hot)    is the fee payer and the only transaction signer.
 *
 * The intent is an Ed25519 signature over a deterministic serialisation of the
 * plan. The submitter refuses to build a transaction unless the intent verifies
 * against `expectedAuthorizer`. Because the hot key cannot produce that
 * signature, a compromised hot key cannot authorise a new trade — it can only
 * replay an intent that is still inside its TTL and nonce window.
 */

export interface SolanaSigners {
  readonly executor: Keypair;
  readonly authorizerPublicKey: string;
  readonly authorizerPrivateKey: KeyObject;
}

export class SolanaSignerIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SolanaSignerIsolationError";
  }
}

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(new Uint8Array(secret));
}

/**
 * Loads an Ed25519 keypair from a 32-byte seed file (JSON array of 32 bytes).
 * We build a PKCS#8 DER wrapper so Node's crypto can sign with it directly.
 */
function loadEd25519(path: string): { publicKey: KeyObject; privateKey: KeyObject; base58: string } {
  const seed = new Uint8Array(JSON.parse(readFileSync(path, "utf8")) as number[]);
  if (seed.length !== 32) {
    throw new SolanaSignerIsolationError(`authorizer seed must be 32 bytes, got ${seed.length}`);
  }
  // PKCS#8 prefix for Ed25519 private keys.
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const der = Buffer.concat([prefix, Buffer.from(seed)]);
  const privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return { publicKey, privateKey, base58: base58Encode(rawPub) };
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export function buildSolanaSigners(cfg: SolanaLaneConfig): SolanaSigners {
  const executor = loadKeypair(cfg.executorKeypairPath);
  const authorizer = loadEd25519(cfg.authorizerKeypairPath);

  const execPub = executor.publicKey.toBase58();

  // (S1) distinct key material
  if (execPub === authorizer.base58) {
    throw new SolanaSignerIsolationError(
      "S1 violated: executor and authorizer are the same key — isolation is not in effect",
    );
  }
  // (S2) the cold key is the one the lane expects
  if (authorizer.base58 !== cfg.expectedAuthorizer) {
    throw new SolanaSignerIsolationError(
      `S2 violated: authorizer derives ${authorizer.base58}, config expects ${cfg.expectedAuthorizer}`,
    );
  }

  return {
    executor,
    authorizerPublicKey: authorizer.base58,
    authorizerPrivateKey: authorizer.privateKey,
  };
}

/**
 * Canonical intent serialisation. Field order is fixed and every numeric field
 * is a decimal string, so the digest is stable across JS engines and versions.
 */
export function intentDigest(intent: {
  lane: "solana";
  loanAssetMint: string;
  loanAmount: bigint;
  minNetProfitRaw: bigint;
  nonce: bigint;
  deadline: bigint;
  profitRecipient: string;
  routeHash: string;
}): Buffer {
  const canonical = [
    "V6-HF/SOLANA-INTENT/v1",
    intent.lane,
    intent.loanAssetMint,
    intent.loanAmount.toString(),
    intent.minNetProfitRaw.toString(),
    intent.nonce.toString(),
    intent.deadline.toString(),
    intent.profitRecipient,
    intent.routeHash,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest();
}

export function signIntent(signers: SolanaSigners, digest: Buffer): Buffer {
  return sign(null, digest, signers.authorizerPrivateKey);
}

export function verifyIntent(
  authorizerPublicKey: KeyObject,
  digest: Buffer,
  signature: Buffer,
): boolean {
  try {
    return verify(null, digest, authorizerPublicKey, signature);
  } catch {
    return false;
  }
}
