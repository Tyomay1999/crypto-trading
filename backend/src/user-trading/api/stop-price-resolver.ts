import type { Pool } from "pg";
import type { StopBasis } from "../accounting/types.js";

export interface UserTradingStopPriceResolver {
  resolveStopPrice(input: Readonly<{
    userId: string;
    positionId: string;
    basis: Exclude<StopBasis, "ORIGINAL">;
  }>): Promise<string | null>;
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

export class PostgresUserTradingStopPriceResolver
implements UserTradingStopPriceResolver {
  constructor(
    private readonly pool: Pick<Pool, "query">,
  ) {}

  async resolveStopPrice(
    input: Readonly<{
      userId: string;
      positionId: string;
      basis: "ENTRY" | "TP1" | "TP2";
    }>,
  ): Promise<string | null> {
    const result =
      await this.pool.query<{
        actual_entry_price: string;
        projection_payload: unknown;
      }>(
        `
          SELECT
            p.actual_entry_price,
            s.projection_payload
          FROM app.user_position p
          JOIN projection.published_signals s
            ON s.signal_id = p.signal_id
          WHERE p.user_id = $1
            AND p.position_id = $2
          LIMIT 1
        `,
        [
          input.userId,
          input.positionId,
        ],
      );

    const row = result.rows[0];
    if (!row) return null;

    if (input.basis === "ENTRY") {
      return text(
        row.actual_entry_price,
        "user_position.actual_entry_price",
      );
    }

    const projection =
      object(
        row.projection_payload,
        "projection_payload",
      );
    const tradePlan =
      object(
        projection.tradePlan,
        "projection.tradePlan",
      );

    if (!Array.isArray(tradePlan.takeProfits)) {
      throw new TypeError(
        "projection.tradePlan.takeProfits must be an array",
      );
    }

    const target =
      tradePlan.takeProfits
        .map((value) =>
          object(
            value,
            "projection.tradePlan.takeProfits[]",
          ),
        )
        .find((value) =>
          value.label === input.basis,
        );

    if (!target) {
      throw new Error(
        `projection ${input.basis} target is missing`,
      );
    }

    return text(
      target.price,
      `projection.tradePlan.takeProfits[${input.basis}].price`,
    );
  }
}
