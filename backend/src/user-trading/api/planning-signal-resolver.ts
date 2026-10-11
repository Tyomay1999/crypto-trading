import type { Pool } from "pg";
import type {
  SignalPlanningInput,
} from "../planning/types.js";

export type PlanningSignalFacts = Readonly<{
  signal: SignalPlanningInput;
  exchange: string;
}>;

export interface PlanningSignalResolver {
  getSignalFacts(
    signalId: string,
  ): Promise<PlanningSignalFacts | null>;
}

function object(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  label: string,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.trim() !== value
  ) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function direction(
  value: unknown,
): "LONG" | "SHORT" {
  if (value !== "LONG" && value !== "SHORT") {
    throw new TypeError("projection.direction is invalid");
  }
  return value;
}

export class PostgresPlanningSignalResolver
implements PlanningSignalResolver {
  constructor(
    private readonly pool: Pick<Pool, "query">,
  ) {}

  async getSignalFacts(
    signalId: string,
  ): Promise<PlanningSignalFacts | null> {
    const result =
      await this.pool.query<{
        signal_id: string;
        exchange: string;
        direction: string;
        projection_payload: unknown;
      }>(
        `
          SELECT
            signal_id,
            exchange,
            direction,
            projection_payload
          FROM projection.published_signals
          WHERE signal_id = $1
          LIMIT 1
        `,
        [signalId],
      );

    const row = result.rows[0];
    if (!row) return null;

    const projection =
      object(
        row.projection_payload,
        "projection_payload",
      );

    if (
      text(projection.signalId, "projection.signalId")
      !== row.signal_id
    ) {
      throw new Error(
        "projection signal identity mismatch",
      );
    }

    const tradePlan =
      object(
        projection.tradePlan,
        "projection.tradePlan",
      );

    const entry =
      object(
        tradePlan.entry,
        "projection.tradePlan.entry",
      );

    const stopLoss =
      object(
        tradePlan.stopLoss,
        "projection.tradePlan.stopLoss",
      );

    return Object.freeze({
      signal: Object.freeze({
        signalId: row.signal_id,
        direction:
          direction(row.direction),
        entryPrice:
          text(
            entry.referencePrice,
            "projection.tradePlan.entry.referencePrice",
          ),
        stopPrice:
          text(
            stopLoss.price,
            "projection.tradePlan.stopLoss.price",
          ),
      }),
      exchange:
        text(row.exchange, "exchange"),
    });
  }
}
