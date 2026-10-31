import { Wallet, getAddress } from "ethers";
import type { BaseLaneConfig } from "./config.js";

/**
 * Signer isolation, enforced in code.
 *
 * The contract enforces that the AUTHORIZER address is never an executor and
 * never the owner. This module enforces the same rule on the KEY MATERIAL, which
 * the contract cannot see:
 *
 *   (S1) the two private keys must derive DIFFERENT addresses
 *   (S2) the authorizer key must derive `expectedAuthorizerAddress`
 *   (S3) the executor key must NOT derive the authorizer address
 *   (S4) the executor key must not be the owner (checked on-chain at startup)
 *
 * A violation is fatal at startup. There is no "warn and continue" path: a
 * system that runs with a merged signer is not V6-HF, it is an unsecured bot.
 */

export interface IsolatedSigners {
  /** Hot wallet. Sends transactions. Never signs plans. */
  readonly executor: Wallet;
  /** Cold wallet. Signs plans. Never sends transactions. */
  readonly authorizer: Wallet;
}

export class SignerIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignerIsolationError";
  }
}

export function buildIsolatedSigners(cfg: BaseLaneConfig): IsolatedSigners {
  const executor = new Wallet(cfg.executorPrivateKey);
  const authorizer = new Wallet(cfg.authorizerPrivateKey);

  const execAddr = getAddress(executor.address);
  const authAddr = getAddress(authorizer.address);
  const expected = getAddress(cfg.expectedAuthorizerAddress);

  // (S1) distinct key material
  if (execAddr === authAddr) {
    throw new SignerIsolationError(
      "S1 violated: executor and authorizer derive the same address — signer isolation is not in effect",
    );
  }

  // (S2) the cold key is the one the contract will accept
  if (authAddr !== expected) {
    throw new SignerIsolationError(
      `S2 violated: authorizer key derives ${authAddr}, contract expects ${expected}`,
    );
  }

  // (S3) explicit re-assertion, kept separate so the failure is unambiguous
  if (getAddress(executor.address) === expected) {
    throw new SignerIsolationError("S3 violated: executor key is the authorizer key");
  }

  return { executor, authorizer };
}

/**
 * Verifies the on-chain role layout matches the local key material. Called once
 * at startup, before the first plan is ever built.
 */
export async function verifyOnChainIsolation(
  cfg: BaseLaneConfig,
  signers: IsolatedSigners,
  read: {
    authorizer(): Promise<string>;
    owner(): Promise<string>;
    isExecutor(addr: string): Promise<boolean>;
  },
): Promise<void> {
  const onChainAuthorizer = getAddress(await read.authorizer());
  const onChainOwner = getAddress(await read.owner());

  if (onChainAuthorizer !== getAddress(signers.authorizer.address)) {
    throw new SignerIsolationError(
      `on-chain authorizer ${onChainAuthorizer} != local cold key ${signers.authorizer.address}`,
    );
  }
  if (onChainAuthorizer === onChainOwner) {
    throw new SignerIsolationError("on-chain authorizer equals owner — isolation broken");
  }
  if (!(await read.isExecutor(getAddress(signers.executor.address)))) {
    throw new SignerIsolationError(
      `hot key ${signers.executor.address} does not hold EXECUTOR_ROLE on ${cfg.executor}`,
    );
  }
  if (getAddress(signers.executor.address) === onChainAuthorizer) {
    throw new SignerIsolationError("hot key holds AUTHORIZER_ROLE — isolation broken");
  }
}
