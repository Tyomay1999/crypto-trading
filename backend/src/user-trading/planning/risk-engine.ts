import {
  absExact,
  ceilPositiveInteger,
  compareExact,
  divideExact,
  formatPositiveDecimal,
  isPositive,
  minExact,
  multiplyExact,
  parseExactDecimal,
  subtractExact,
} from "./decimal.js";
import type {
  ExchangeAccountSnapshot,
  RiskPolicy,
  SignalPlanningInput,
  TradeRecommendation,
  UserPlanOverride,
} from "./types.js";

const MONEY_SCALE = 8;
const FRACTION_SCALE = 10;

function positive(value: string, field: string) {
  const parsed = parseExactDecimal(value);
  if (!isPositive(parsed)) {
    throw new RangeError(`${field} must be positive`);
  }
  return parsed;
}

function nonNegativeFraction(value: string, field: string) {
  const parsed = parseExactDecimal(value);
  const zero = parseExactDecimal("0");
  const one = parseExactDecimal("1");
  if (compareExact(parsed, zero) < 0 || compareExact(parsed, one) >= 0) {
    throw new RangeError(`${field} must be >= 0 and < 1`);
  }
  return parsed;
}

function positiveFraction(value: string, field: string) {
  const parsed = nonNegativeFraction(value, field);
  if (!isPositive(parsed)) {
    throw new RangeError(`${field} must be > 0`);
  }
  return parsed;
}

function integerLeverage(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${field} must be a positive canonical integer string`);
  }
  return BigInt(value);
}

export function calculateTradeRecommendation(input: {
  account: ExchangeAccountSnapshot;
  signal: SignalPlanningInput;
  policy: RiskPolicy;
  override?: UserPlanOverride;
}): TradeRecommendation {
  const available = positive(input.account.availableBalance, "availableBalance");
  const entry = positive(input.signal.entryPrice, "entryPrice");
  const stop = positive(input.signal.stopPrice, "stopPrice");
  const targetRiskFraction = positiveFraction(
    input.policy.targetRiskFraction,
    "targetRiskFraction",
  );
  const reserveFraction = nonNegativeFraction(
    input.policy.reserveFraction,
    "reserveFraction",
  );
  const maxLeverage = integerLeverage(input.policy.maxLeverage, "maxLeverage");

  const one = parseExactDecimal("1");
  const stopDelta = subtractExact(entry, stop);

  if (
    (input.signal.direction === "LONG" && stopDelta.numerator <= 0n) ||
    (input.signal.direction === "SHORT" && stopDelta.numerator >= 0n)
  ) {
    throw new RangeError("stopPrice must be on the loss side of entryPrice");
  }

  const stopDistance = divideExact(absExact(stopDelta), entry);
  const targetRiskAmount = multiplyExact(available, targetRiskFraction);
  const riskBasedNotional = divideExact(targetRiskAmount, stopDistance);
  const usableMargin = multiplyExact(
    available,
    subtractExact(one, reserveFraction),
  );
  const maxLeverageDecimal = parseExactDecimal(maxLeverage.toString());
  const marginLimitedNotional = multiplyExact(usableMargin, maxLeverageDecimal);
  const suggestedNotional = minExact(riskBasedNotional, marginLimitedNotional);

  const suggestedLeverageRaw = ceilPositiveInteger(
    divideExact(suggestedNotional, usableMargin),
  );
  const suggestedLeverage =
    suggestedLeverageRaw > maxLeverage ? maxLeverage : suggestedLeverageRaw;

  const suggestedRequiredMargin = divideExact(
    suggestedNotional,
    parseExactDecimal(suggestedLeverage.toString()),
  );

  const selectedNotional = input.override?.selectedPositionNotional
    ? positive(input.override.selectedPositionNotional, "selectedPositionNotional")
    : suggestedNotional;

  if (compareExact(selectedNotional, marginLimitedNotional) > 0) {
    throw new RangeError("selectedPositionNotional exceeds margin/leverage capacity");
  }

  const selectedLeverage = input.override?.selectedLeverage
    ? integerLeverage(input.override.selectedLeverage, "selectedLeverage")
    : suggestedLeverage;

  if (selectedLeverage > maxLeverage) {
    throw new RangeError("selectedLeverage exceeds maxLeverage");
  }

  const selectedRequiredMargin = divideExact(
    selectedNotional,
    parseExactDecimal(selectedLeverage.toString()),
  );

  if (compareExact(selectedRequiredMargin, usableMargin) > 0) {
    throw new RangeError("selectedLeverage requires more margin than policy permits");
  }

  const selectedRiskAmount = multiplyExact(selectedNotional, stopDistance);
  const selectedRiskFraction = divideExact(selectedRiskAmount, available);

  if (compareExact(selectedRiskFraction, targetRiskFraction) > 0) {
    throw new RangeError("selected position exceeds target risk policy");
  }

  const marginMode = input.override?.marginMode ?? input.policy.marginMode;
  const overridden =
    input.override?.selectedPositionNotional !== undefined ||
    input.override?.selectedLeverage !== undefined ||
    input.override?.marginMode !== undefined;

  return {
    availableBalance: formatPositiveDecimal(available, MONEY_SCALE, "DOWN"),
    targetRiskAmount: formatPositiveDecimal(targetRiskAmount, MONEY_SCALE, "DOWN"),
    stopDistanceFraction: formatPositiveDecimal(
      stopDistance,
      FRACTION_SCALE,
      "UP",
    ),
    usableMargin: formatPositiveDecimal(usableMargin, MONEY_SCALE, "DOWN"),
    riskBasedNotional: formatPositiveDecimal(
      riskBasedNotional,
      MONEY_SCALE,
      "DOWN",
    ),
    marginLimitedNotional: formatPositiveDecimal(
      marginLimitedNotional,
      MONEY_SCALE,
      "DOWN",
    ),
    suggestedPositionNotional: formatPositiveDecimal(
      suggestedNotional,
      MONEY_SCALE,
      "DOWN",
    ),
    suggestedLeverage: suggestedLeverage.toString(),
    suggestedRequiredMargin: formatPositiveDecimal(
      suggestedRequiredMargin,
      MONEY_SCALE,
      "UP",
    ),
    selectedPositionNotional: formatPositiveDecimal(
      selectedNotional,
      MONEY_SCALE,
      "DOWN",
    ),
    selectedLeverage: selectedLeverage.toString(),
    selectedRequiredMargin: formatPositiveDecimal(
      selectedRequiredMargin,
      MONEY_SCALE,
      "UP",
    ),
    selectedRiskAmount: formatPositiveDecimal(
      selectedRiskAmount,
      MONEY_SCALE,
      "UP",
    ),
    selectedRiskFraction: formatPositiveDecimal(
      selectedRiskFraction,
      FRACTION_SCALE,
      "UP",
    ),
    marginMode,
    valueSource: overridden ? "USER_OVERRIDE" : "SYSTEM_SUGGESTED",
  };
}
