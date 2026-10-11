import type { Pool } from "pg";
import type {
  UserTradingReportBaseRow,
  UserTradingReportFilter,
  UserTradingReportHistoryRow,
  UserTradingReportRepository,
} from "./types.js";

interface ReportRow {
  participation_id: string;
  signal_id: string;
  participation_status: string;
  followed_at: string | Date;
  position_id: string | null;
  direction: "LONG" | "SHORT" | null;
  position_state: string | null;
  terminal_at: string | Date | null;
  terminal_reason: string | null;
  user_terminal_state:
    | "EXITED_EARLY"
    | "COMPLETED"
    | "STOPPED"
    | "CANCELLED"
    | null;
  global_terminal_status: "STOP" | "TP3" | null;
  realized_pnl: string | null;
  realized_return: string | null;
  realized_fraction: string | null;
  completed_at: string | Date | null;
  symbol: string | null;
  strategy: string | null;
}

function iso(value: string | Date): string {
  return typeof value === "string"
    ? new Date(value).toISOString()
    : value.toISOString();
}

function boundedIdentity(value: string, label: string): string {
  if (
    value.length < 1 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`invalid ${label}`);
  }
  return value;
}

function timestamp(
  value: string | undefined,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError(`invalid ${label}`);
  }

  return parsed.toISOString();
}

export class PostgresUserTradingReportRepository
implements UserTradingReportRepository {
  constructor(private readonly pool: Pool) {}

  async listRows(
    userIdInput: string,
    filter: UserTradingReportFilter,
  ): Promise<readonly UserTradingReportHistoryRow[]> {
    const userId = boundedIdentity(userIdInput, "userId");
    const values: unknown[] = [userId];
    const predicates = ["p.user_id = $1"];

    if (filter.direction !== undefined) {
      values.push(filter.direction);
      predicates.push(`pos.direction = $${values.length}`);
    }

    if (filter.terminalReason !== undefined) {
      values.push(filter.terminalReason);
      predicates.push(`o.terminal_reason = $${values.length}`);
    }

    if (filter.symbol !== undefined) {
      values.push(filter.symbol);
      predicates.push(`gs.symbol = $${values.length}`);
    }

    if (filter.strategy !== undefined) {
      values.push(filter.strategy);
      predicates.push(
        `(gs.projection_payload->'strategy'->>'strategyId') = $${values.length}`,
      );
    }

    if (filter.globalTerminalStatus !== undefined) {
      values.push(filter.globalTerminalStatus);
      predicates.push(`o.global_terminal_status = $${values.length}`);
    }

    const from = timestamp(filter.from, "from");
    if (from !== undefined) {
      values.push(from);
      predicates.push(
        `COALESCE(o.completed_at, pos.terminal_at, p.updated_at) >= $${values.length}::timestamptz`,
      );
    }

    const to = timestamp(filter.to, "to");
    if (to !== undefined) {
      values.push(to);
      predicates.push(
        `COALESCE(o.completed_at, pos.terminal_at, p.updated_at) <= $${values.length}::timestamptz`,
      );
    }

    const result = await this.pool.query<ReportRow>(
      `SELECT
         p.participation_id,
         p.signal_id,
         p.status AS participation_status,
         p.subscribed_at AS followed_at,
         pos.position_id,
         pos.direction,
         pos.state AS position_state,
         pos.terminal_at,
         o.terminal_reason,
         o.user_terminal_state,
         o.global_terminal_status,
         o.realized_pnl,
         o.realized_return,
         o.realized_fraction,
         o.completed_at,
         gs.symbol,
         gs.projection_payload->'strategy'->>'strategyId' AS strategy
       FROM app.user_signal_participation p
       LEFT JOIN projection.published_signals gs
         ON gs.signal_id = p.signal_id
       LEFT JOIN app.user_position pos
         ON pos.participation_id = p.participation_id
        AND pos.user_id = p.user_id
        AND pos.signal_id = p.signal_id
       LEFT JOIN app.user_position_outcome o
         ON o.position_id = pos.position_id
        AND o.participation_id = p.participation_id
        AND o.user_id = p.user_id
        AND o.signal_id = p.signal_id
       WHERE ${predicates.join(" AND ")}
       ORDER BY
         COALESCE(o.completed_at, pos.terminal_at, p.updated_at) DESC,
         p.participation_id DESC`,
      values,
    );

    return Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          participationId: row.participation_id,
          signalId: row.signal_id,
          participationStatus: row.participation_status,
          followedAt: iso(row.followed_at),
          positionId: row.position_id,
          direction: row.direction,
          positionState: row.position_state,
          terminalAt:
            row.terminal_at === null
              ? null
              : iso(row.terminal_at),
          terminalReason:
            row.terminal_reason as
              UserTradingReportBaseRow["terminalReason"],
          userTerminalState: row.user_terminal_state,
          globalTerminalStatus:
            row.global_terminal_status,
          realizedPnl: row.realized_pnl,
          realizedReturn: row.realized_return,
          realizedFraction: row.realized_fraction,
          completedAt:
            row.completed_at === null
              ? null
              : iso(row.completed_at),
          symbol: row.symbol,
          strategy: row.strategy,
        }),
      ),
    );
  }
}
