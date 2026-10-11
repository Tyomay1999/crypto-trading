import { randomUUID } from "node:crypto";
import type { Response, Router } from "express";
import type { Pool } from "pg";
import { getCurrentSessionContext } from "../../middleware/require-session.js";
import { PostgresUserTradingLedgerRepository } from "../ledger/postgres-repository.js";
import { UserTradingLedgerService } from "../ledger/service.js";
import { PostgresUserTradingApiReadRepository } from "./postgres-read-repository.js";
import { createUserTradingRouter } from "./router.js";

export function createPostgresUserTradingRouter(pool: Pool): Router {
  const repository = new PostgresUserTradingLedgerRepository(pool);
  const ledgerService = new UserTradingLedgerService({
    repository,
    idFactory:{createEventId:()=>randomUUID()},
  });
  return createUserTradingRouter({
    readRepository:new PostgresUserTradingApiReadRepository(pool),
    ledgerService,
    resolveTrustedContext:(response:Response)=>({
      userId:getCurrentSessionContext(response).userId,
    }),
  });
}
