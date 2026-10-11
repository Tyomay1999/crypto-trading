import { randomUUID } from "node:crypto";
import type { Response, Router } from "express";
import type { Pool } from "pg";
import { getCurrentSessionContext } from "../../middleware/require-session.js";
import { PostgresUserTradingLedgerRepository } from "../ledger/postgres-repository.js";
import { PostgresUserTradingReportRepository, UserTradingReportService } from "../reports/index.js";
import { UserTradingLedgerService } from "../ledger/service.js";
import { PostgresUserTradingApiReadRepository } from "./postgres-read-repository.js";
import { createUserTradingRouter } from "./router.js";
import {
  PostgresParticipationRepository,
  UserSignalParticipationService,
} from "../participation/index.js";
import {
  PostgresTradePlanningRepository,
  UserTradePlanningService,
  type ExchangeAccountSnapshotProvider,
} from "../planning/index.js";
import { PostgresPlanningSignalResolver } from "./planning-signal-resolver.js";


export function createPostgresUserTradingRouter(
  pool: Pool,
  options: Readonly<{
    accountSnapshotProvider?: ExchangeAccountSnapshotProvider;
  }> = {},
): Router {
  const repository = new PostgresUserTradingLedgerRepository(pool);
  const ledgerService = new UserTradingLedgerService({
    repository,
    idFactory:{createEventId:()=>randomUUID()},
  });
  const reports = new UserTradingReportService(
    new PostgresUserTradingReportRepository(pool),
  );
  const participationService =
    new UserSignalParticipationService({
      repository:
        new PostgresParticipationRepository(pool),
      clock:{
        nowIso:() =>
          new Date().toISOString(),
      },
      idFactory:{
        createParticipationId:() =>
          randomUUID(),
      },
    });

  const planningService =
    options.accountSnapshotProvider === undefined
      ? undefined
      : new UserTradePlanningService({
          repository:
            new PostgresTradePlanningRepository(pool),
          accountProvider:
            options.accountSnapshotProvider,
          clock:{
            nowIso:() =>
              new Date().toISOString(),
          },
          idFactory:{
            createTradePlanId:() =>
              randomUUID(),
            createBalanceSnapshotId:() =>
              randomUUID(),
          },
        });

  const planningSignalResolver =
    planningService === undefined
      ? undefined
      : new PostgresPlanningSignalResolver(pool);
  return createUserTradingRouter({
    readRepository:new PostgresUserTradingApiReadRepository(pool),
    ledgerService,
    participationService,
    ...(planningService === undefined ||
        planningSignalResolver === undefined
      ? {}
      : {
          planningService,
          planningSignalResolver,
        }),
    reports,
    resolveTrustedContext:(response:Response)=>({
      userId:getCurrentSessionContext(response).userId,
    }),
  });
}
