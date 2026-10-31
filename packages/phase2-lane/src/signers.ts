import { Wallet, getAddress } from "ethers";
import type { Phase2LaneConfig } from "./config.js";

/**
 * Phase 2 signer isolation.
 *
 * Identical rules to `base-lane/src/signers.ts` (S1-S3), applied to the Phase 2
 * key set. The Phase 2 keys are a SEPARATE key set from Phase 1's: the same
 * physical key must not authorise both phases, because a single compromised cold
 * key would then be able to authorise a Phase 1 flash loan and a Phase 2 position
 * simultaneously. `assertDistinctFromPhase1` enforces that at startup.
 *
 *   (S1) the two private keys must derive DIFFERENT addresses
 *   (S2) the authorizer key must derive `expectedAuthorizerAddress`
 *   (S3) the executor key must NOT derive the authorizer address
 *   (S4) neither Phase 2 key may equal a Phase 1 key (checked when Phase 1
 *        addresses are supplied)
 */

export interface Phase2Signers {
  /** Hot wallet. Sends Phase 2 steps. Never signs plans. */
  readonly executor: Wallet;
  /** Cold wallet. Signs Phase2Plan digests. Never sends transactions. */
  readonly authorizer: Wallet;
}

export class Phase2SignerIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Phase2SignerIsolationError";
  }
}

export function buildPhase2Signers(cfg: Phase2LaneConfig): Phase2Signers {
  const executor = new Wallet(cfg.executorPrivateKey);
  const authorizer = new Wallet(cfg.authorizerPrivateKey);

  const execAddr = getAddress(executor.address);
  const authAddr = getAddress(authorizer.address);
  const expected = getAddress(cfg.expectedAuthorizerAddress);

  if (execAddr === authAddr) {
    throw new Phase2SignerIsolationError(
      "S1 violated: Phase 2 executor and authorizer derive the same address — isolation is not in effect",
    );
  }
  if (authAddr !== expected) {
    throw new Phase2SignerIsolationError(
      `S2 violated: Phase 2 authorizer key derives ${authAddr}, config expects ${expected}`,
    );
  }
  if (execAddr === expected) {
    throw new Phase2SignerIsolationError("S3 violated: Phase 2 executor key is the Phase 2 authorizer key");
  }

  return { executor, authorizer };
}

/**
 * (S4) Cross-phase key separation. Called at startup with the Phase 1 addresses
 * when both lanes run in the same process. A shared key across phases would make
 * the phase boundary a naming convention rather than a security boundary.
 */
export function assertDistinctFromPhase1(
  signers: Phase2Signers,
  phase1: { authorizerAddress: string; executorAddress: string },
): void {
  const p2Auth = getAddress(signers.authorizer.address);
  const p2Exec = getAddress(signers.executor.address);
  const p1Auth = getAddress(phase1.authorizerAddress);
  const p1Exec = getAddress(phase1.executorAddress);

  if (p2Auth === p1Auth) {
    throw new Phase2SignerIsolationError(
      "S4 violated: the Phase 2 authorizer key is also the Phase 1 authorizer key — a single cold-key compromise would span both phases",
    );
  }
  if (p2Exec === p1Exec) {
    throw new Phase2SignerIsolationError(
      "S4 violated: the Phase 2 executor key is also the Phase 1 executor key",
    );
  }
  if (p2Auth === p1Exec || p2Exec === p1Auth) {
    throw new Phase2SignerIsolationError(
      "S4 violated: a Phase 2 key is a Phase 1 key of the other role",
    );
  }
}

/**
 * Verifies the on-chain role layout matches the local key material, and that the
 * Phase 2 executor's machine really is in the Phase 2 domain. Called once at
 * startup, before the first plan is built.
 */
export async function verifyPhase2OnChainIsolation(
  cfg: Phase2LaneConfig,
  signers: Phase2Signers,
  read: {
    authorizer(): Promise<string>;
    owner(): Promise<string>;
    isExecutor(addr: string): Promise<boolean>;
    phase(): Promise<bigint>;
    domainOfPhase(phase: number): number;
  },
): Promise<void> {
  const onChainAuthorizer = getAddress(await read.authorizer());
  const onChainOwner = getAddress(await read.owner());

  if (onChainAuthorizer !== getAddress(signers.authorizer.address)) {
    throw new Phase2SignerIsolationError(
      `on-chain Phase 2 authorizer ${onChainAuthorizer} != local cold key ${signers.authorizer.address}`,
    );
  }
  if (onChainAuthorizer === onChainOwner) {
    throw new Phase2SignerIsolationError("on-chain Phase 2 authorizer equals owner — isolation broken");
  }
  if (!(await read.isExecutor(getAddress(signers.executor.address)))) {
    throw new Phase2SignerIsolationError(
      `hot key ${signers.executor.address} does not hold EXECUTOR_ROLE on ${cfg.phase2Executor}`,
    );
  }
  if (getAddress(signers.executor.address) === onChainAuthorizer) {
    throw new Phase2SignerIsolationError("hot key holds AUTHORIZER_ROLE — isolation broken");
  }

  // The executor must be in the Phase 2 domain. A Phase 2 executor reporting a
  // Phase 1 phase value means the deployment is misconfigured (or the address is
  // a Phase 1 executor), and every subsequent step would be gated wrongly.
  const phase = Number(await read.phase());
  if (read.domainOfPhase(phase) !== 2) {
    throw new Phase2SignerIsolationError(
      `Phase 2 executor reports phase ${phase}, which is not in the Phase 2 domain — refusing to start`,
    );
  }
}
