import {
  addFractions,
  addText,
  canonicalFraction,
  canonicalPositive,
  canonicalSequence,
  comparePrices,
  formatSigned,
  pnlForFraction,
  quantityFromNotional,
  subtractFractions,
} from "./math.js";
import type {
  AccountingMutationResult,
  GlobalLifecycleState,
  GlobalStopInput,
  GlobalTargetInput,
  ManualExitInput,
  OpenPositionInput,
  StopBasis,
  StopMoveInput,
  StopMoveResult,
  UserPositionSnapshot,
} from "./types.js";

const STATE_RANK: Readonly<Record<GlobalLifecycleState, number>> = {
  PUBLISHED: 0,
  WAITING_FOR_ENTRY: 1,
  ENTRY_REACHED: 2,
  TP1_REACHED: 3,
  TP2_REACHED: 4,
  TP3_REACHED: 5,
  STOP_REACHED: 6,
};

const BASIS_RANK: Readonly<Record<StopBasis, number>> = {
  ORIGINAL: 0,
  ENTRY: 1,
  TP1: 2,
  TP2: 3,
};

function targetState(target: GlobalTargetInput["target"]): GlobalLifecycleState {
  return `${target}_REACHED` as GlobalLifecycleState;
}

function assertActive(position: UserPositionSnapshot): void {
  if (!["OPEN", "PARTIALLY_REALIZED"].includes(position.state)) {
    throw new Error(`position is not active: ${position.state}`);
  }
}

function advanceVersion(version: string): string {
  return (canonicalSequence(version, "version") + 1n).toString();
}

export function openUserPosition(input: OpenPositionInput): UserPositionSnapshot {
  canonicalPositive(input.actualEntryPrice, "actualEntryPrice");
  canonicalPositive(input.initialNotional, "initialNotional");
  canonicalPositive(input.originalStopPrice, "originalStopPrice");
  const quantity = quantityFromNotional(
    input.initialNotional,
    input.actualEntryPrice,
  );
  const sequence = canonicalSequence(input.globalSequence, "globalSequence");

  return {
    positionId: input.positionId,
    participationId: input.participationId,
    userId: input.userId,
    signalId: input.signalId,
    direction: input.direction,
    state: "OPEN",
    actualEntryPrice: input.actualEntryPrice,
    enteredAt: input.enteredAt,
    initialQuantity: formatSigned(quantity),
    initialNotional: input.initialNotional,
    remainingFraction: "1",
    realizedFraction: "0",
    realizedPnl: "0",
    selectedStopPrice: input.originalStopPrice,
    stopBasis: "ORIGINAL",
    lastGlobalSequence: sequence.toString(),
    lastGlobalState: "ENTRY_REACHED",
    version: "1",
    terminalAt: null,
  };
}

export function applyGlobalTarget(
  position: UserPositionSnapshot,
  input: GlobalTargetInput,
): AccountingMutationResult {
  assertActive(position);

  const incomingSequence = canonicalSequence(input.globalSequence, "globalSequence");
  const currentSequence = canonicalSequence(
    position.lastGlobalSequence,
    "lastGlobalSequence",
  );

  if (incomingSequence <= currentSequence) {
    return { kind: "STALE_OR_DUPLICATE", position };
  }

  const allocation = canonicalFraction(
    input.allocationFraction,
    "allocationFraction",
  );
  if (allocation.numerator <= 0n) {
    throw new RangeError("allocationFraction must be > 0");
  }

  const pnl = pnlForFraction({
    direction: position.direction,
    initialQuantity: position.initialQuantity,
    fraction: input.allocationFraction,
    entryPrice: position.actualEntryPrice,
    exitPrice: input.price,
  });

  const remainingFraction = subtractFractions(
    position.remainingFraction,
    input.allocationFraction,
  );
  const realizedFraction = addFractions(
    position.realizedFraction,
    input.allocationFraction,
  );

  const terminal = remainingFraction === "0";
  if (input.target === "TP3" && !terminal) {
    throw new Error("TP3 must consume the full remaining user position");
  }

  return {
    kind: "APPLIED",
    position: {
      ...position,
      state: terminal ? "COMPLETED" : "PARTIALLY_REALIZED",
      remainingFraction,
      realizedFraction,
      realizedPnl: addText(position.realizedPnl, pnl),
      lastGlobalSequence: incomingSequence.toString(),
      lastGlobalState: targetState(input.target),
      version: advanceVersion(position.version),
      terminalAt: terminal ? input.occurredAt : null,
    },
  };
}

function requiredGlobalRank(basis: StopMoveInput["basis"]): number {
  switch (basis) {
    case "ENTRY":
      return STATE_RANK.ENTRY_REACHED;
    case "TP1":
      return STATE_RANK.TP1_REACHED;
    case "TP2":
      return STATE_RANK.TP2_REACHED;
  }
}

export function moveUserStop(
  position: UserPositionSnapshot,
  input: StopMoveInput,
): StopMoveResult {
  assertActive(position);
  canonicalPositive(input.price, "stopPrice");

  if (STATE_RANK[position.lastGlobalState] < requiredGlobalRank(input.basis)) {
    return { kind: "NOT_ELIGIBLE", position };
  }

  if (BASIS_RANK[input.basis] <= BASIS_RANK[position.stopBasis]) {
    return { kind: "NON_MONOTONIC", position };
  }

  if (
    input.basis === "ENTRY" &&
    comparePrices(input.price, position.actualEntryPrice) !== 0
  ) {
    throw new Error("ENTRY stop basis must equal actual entry price");
  }

  const priceDirection = comparePrices(
    input.price,
    position.selectedStopPrice,
  );
  if (
    (position.direction === "LONG" && priceDirection <= 0) ||
    (position.direction === "SHORT" && priceDirection >= 0)
  ) {
    return { kind: "NON_MONOTONIC", position };
  }

  return {
    kind: "APPLIED",
    position: {
      ...position,
      selectedStopPrice: input.price,
      stopBasis: input.basis,
      version: advanceVersion(position.version),
    },
  };
}

export function applyGlobalStop(
  position: UserPositionSnapshot,
  input: GlobalStopInput,
): AccountingMutationResult {
  assertActive(position);

  const incomingSequence = canonicalSequence(input.globalSequence, "globalSequence");
  const currentSequence = canonicalSequence(
    position.lastGlobalSequence,
    "lastGlobalSequence",
  );

  if (incomingSequence <= currentSequence) {
    return { kind: "STALE_OR_DUPLICATE", position };
  }

  const remaining = canonicalFraction(
    position.remainingFraction,
    "remainingFraction",
  );
  if (remaining.numerator <= 0n) {
    throw new Error("active position has no remaining fraction");
  }

  const pnl = pnlForFraction({
    direction: position.direction,
    initialQuantity: position.initialQuantity,
    fraction: position.remainingFraction,
    entryPrice: position.actualEntryPrice,
    exitPrice: position.selectedStopPrice,
  });

  return {
    kind: "APPLIED",
    position: {
      ...position,
      state: "STOPPED",
      remainingFraction: "0",
      realizedFraction: "1",
      realizedPnl: addText(position.realizedPnl, pnl),
      lastGlobalSequence: incomingSequence.toString(),
      lastGlobalState: "STOP_REACHED",
      version: advanceVersion(position.version),
      terminalAt: input.occurredAt,
    },
  };
}

export function applyManualExit(
  position: UserPositionSnapshot,
  input: ManualExitInput,
): UserPositionSnapshot {
  assertActive(position);
  canonicalPositive(input.price, "exitPrice");

  const pnl = pnlForFraction({
    direction: position.direction,
    initialQuantity: position.initialQuantity,
    fraction: position.remainingFraction,
    entryPrice: position.actualEntryPrice,
    exitPrice: input.price,
  });

  return {
    ...position,
    state: "EXITED_EARLY",
    remainingFraction: "0",
    realizedFraction: "1",
    realizedPnl: addText(position.realizedPnl, pnl),
    version: advanceVersion(position.version),
    terminalAt: input.occurredAt,
  };
}
