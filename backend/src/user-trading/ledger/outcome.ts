import {
  divideExact,
  parseExactDecimal,
} from "../planning/decimal.js";
import {
  formatSigned,
} from "../accounting/math.js";
import type {
  UserPositionSnapshot,
} from "../accounting/types.js";
import type {
  TerminalOutcomeDraft,
  UserPositionOutcomeRecord,
} from "./types.js";

export function buildTerminalOutcome(
  position: UserPositionSnapshot,
  draft: TerminalOutcomeDraft,
): UserPositionOutcomeRecord {
  if (!["EXITED_EARLY", "COMPLETED", "STOPPED", "CANCELLED"].includes(position.state)) {
    throw new Error(`position is not terminal: ${position.state}`);
  }

  if (position.terminalAt === null) {
    throw new Error("terminal position requires terminalAt");
  }

  const notional = parseExactDecimal(position.initialNotional);
  if (notional.numerator <= 0n) {
    throw new RangeError("initialNotional must be positive");
  }

  const realizedPnl = parseExactDecimal(position.realizedPnl);
  const realizedReturn = divideExact(realizedPnl, notional);

  return {
    positionId: position.positionId,
    participationId: position.participationId,
    userId: position.userId,
    signalId: position.signalId,
    terminalReason: draft.terminalReason,
    userTerminalState: position.state as
      | "EXITED_EARLY"
      | "COMPLETED"
      | "STOPPED"
      | "CANCELLED",
    actualExitPrice: draft.actualExitPrice,
    realizedPnl: position.realizedPnl,
    realizedReturn: formatSigned(realizedReturn, 12),
    realizedFraction: position.realizedFraction,
    fees: "0",
    completedAt: draft.completedAt,
  };
}
