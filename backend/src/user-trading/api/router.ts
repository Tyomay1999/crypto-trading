import type { UserTradingReportService } from "../reports/service.js";
import type { UserTradingReportFilter } from "../reports/types.js";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { UserTradingLedgerService } from "../ledger/service.js";
import type { UserTradingApiReadRepository } from "./types.js";
import type { UserSignalParticipationService } from "../participation/service.js";
import type { UserTradePlanningService } from "../planning/service.js";
import type {
  MarginMode,
  RiskPolicy,
  UserPlanOverride,
} from "../planning/types.js";
import type { PlanningSignalResolver } from "./planning-signal-resolver.js";
import type { UserTradingStopPriceResolver } from "./stop-price-resolver.js";


type StopMoveBasis = "ENTRY" | "TP1" | "TP2";

function isStopMoveBasis(value: string): value is StopMoveBasis {
  return value === "ENTRY" || value === "TP1" || value === "TP2";
}

export interface TrustedAuthenticatedUserContext { userId: string; }
export interface UserTradingApiDependencies {
  readRepository: UserTradingApiReadRepository;
  ledgerService: UserTradingLedgerService;
  participationService?: UserSignalParticipationService;
  planningService?: UserTradePlanningService;
  planningSignalResolver?: PlanningSignalResolver;
  stopPriceResolver?: UserTradingStopPriceResolver;
  reports?: UserTradingReportService;
  resolveTrustedContext(response: Response): TrustedAuthenticatedUserContext;
  now?(): string;
  eventIdentity?(): string;
}

function opaque(value: unknown, field: string, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${field} must be a bounded opaque string`);
  }
  return value;
}
function bodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TypeError("request body must be an object");
  }
  return body as Record<string, unknown>;
}
function rejectIdentity(req: Request, body: Record<string, unknown> | null): void {
  for (const key of ["userId","user_id","ownerId","accountUserId","sessionUserId"]) {
    if (Object.prototype.hasOwnProperty.call(req.query,key) ||
        (body && Object.prototype.hasOwnProperty.call(body,key))) {
      throw new TypeError("client identity hints are forbidden");
    }
  }
}
function exactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const set = new Set(allowed);
  for (const key of Object.keys(body)) {
    if (!set.has(key)) throw new TypeError(`unexpected field: ${key}`);
  }
}

function optionalOpaque(
  value: unknown,
  field: string,
  max = 256,
): string | undefined {
  return value === undefined
    ? undefined
    : opaque(value, field, max);
}

function nullableOpaque(
  value: unknown,
  field: string,
  max = 256,
): string | null {
  return value === null
    ? null
    : opaque(value, field, max);
}

function marginMode(
  value: unknown,
  field: string,
): MarginMode {
  const parsed = opaque(value, field, 16);
  if (parsed !== "ISOLATED" && parsed !== "CROSS") {
    throw new TypeError(`${field} is invalid`);
  }
  return parsed;
}

function parsePlanBody(
  body: Record<string, unknown>,
): {
  accountReference: string | null;
  currency: string;
  policy: RiskPolicy;
  override?: UserPlanOverride;
} {
  exactKeys(
    body,
    [
      "accountReference",
      "currency",
      "policy",
      "override",
    ],
  );

  const accountReference =
    body.accountReference === undefined
      ? null
      : nullableOpaque(
          body.accountReference,
          "accountReference",
          128,
        );

  const currency =
    body.currency === undefined
      ? "USDT"
      : opaque(body.currency, "currency", 16);

  const rawPolicy =
    bodyObject(body.policy);

  exactKeys(
    rawPolicy,
    [
      "targetRiskFraction",
      "reserveFraction",
      "maxLeverage",
      "marginMode",
    ],
  );

  const policy: RiskPolicy = {
    targetRiskFraction:
      opaque(
        rawPolicy.targetRiskFraction,
        "policy.targetRiskFraction",
        64,
      ),
    reserveFraction:
      opaque(
        rawPolicy.reserveFraction,
        "policy.reserveFraction",
        64,
      ),
    maxLeverage:
      opaque(
        rawPolicy.maxLeverage,
        "policy.maxLeverage",
        32,
      ),
    marginMode:
      marginMode(
        rawPolicy.marginMode,
        "policy.marginMode",
      ),
  };

  if (body.override === undefined) {
    return {
      accountReference,
      currency,
      policy,
    };
  }

  const rawOverride =
    bodyObject(body.override);

  exactKeys(
    rawOverride,
    [
      "selectedPositionNotional",
      "selectedLeverage",
      "marginMode",
    ],
  );

  const selectedPositionNotional =
    optionalOpaque(
      rawOverride.selectedPositionNotional,
      "override.selectedPositionNotional",
      128,
    );
  const selectedLeverage =
    optionalOpaque(
      rawOverride.selectedLeverage,
      "override.selectedLeverage",
      32,
    );
  const overrideMarginMode =
    rawOverride.marginMode === undefined
      ? undefined
      : marginMode(
          rawOverride.marginMode,
          "override.marginMode",
        );

  const override: UserPlanOverride = {
    ...(selectedPositionNotional === undefined
      ? {}
      : { selectedPositionNotional }),
    ...(selectedLeverage === undefined
      ? {}
      : { selectedLeverage }),
    ...(overrideMarginMode === undefined
      ? {}
      : { marginMode: overrideMarginMode }),
  };

  return {
    accountReference,
    currency,
    policy,
    override,
  };
}
function sendResult(res: Response, result: any): void {
  if (result?.kind === "APPLIED" || result?.kind === "IDEMPOTENT_REPLAY") {
    res.status(200).json(result); return;
  }
  if (result?.kind === "NOT_FOUND") {
    res.status(404).json({error:{code:"NOT_FOUND",message:"Resource not found."}}); return;
  }
  if (["CONCURRENT_CONFLICT","TERMINAL_CONFLICT","NOT_ELIGIBLE","NON_MONOTONIC"]
      .includes(result?.kind)) {
    res.status(409).json({error:{code:"CONFLICT",message:"Request conflicts with current trading state."}}); return;
  }
  if (result?.kind === "STALE_OR_DUPLICATE") {
    res.status(409).json({error:{code:"STALE_STATE",message:"Request is stale."}}); return;
  }
  throw new Error("unexpected user-trading domain result");
}


function reportText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return opaque(value, field, max);
}

function reportFilter(query: Request["query"]): UserTradingReportFilter {
  const allowed = new Set(["direction","terminalReason","symbol","strategy","globalTerminalStatus","from","to"]);
  for (const key of Object.keys(query)) {
    if (["userId","user_id","ownerId","accountUserId","sessionUserId"].includes(key)) {
      throw new TypeError("client identity hints are forbidden");
    }
    if (!allowed.has(key)) throw new TypeError(`unexpected report filter: ${key}`);
  }
  const direction=reportText(query.direction,"direction",8);
  if (direction!==undefined && direction!=="LONG" && direction!=="SHORT") throw new TypeError("invalid direction");
  const globalTerminalStatus=reportText(query.globalTerminalStatus,"globalTerminalStatus",8);
  if (globalTerminalStatus!==undefined && globalTerminalStatus!=="STOP" && globalTerminalStatus!=="TP3") throw new TypeError("invalid globalTerminalStatus");
  const filter: {
    direction?: "LONG" | "SHORT";
    terminalReason?: UserTradingReportFilter["terminalReason"];
    symbol?: string;
    strategy?: string;
    globalTerminalStatus?: "STOP" | "TP3";
    from?: string;
    to?: string;
  } = {};
  if (direction!==undefined) filter.direction=direction;
  const terminalReason=reportText(query.terminalReason,"terminalReason",128);
  if (terminalReason!==undefined) filter.terminalReason=terminalReason as UserTradingReportFilter["terminalReason"];
  const symbol=reportText(query.symbol,"symbol",64); if (symbol!==undefined) filter.symbol=symbol;
  const strategy=reportText(query.strategy,"strategy",128); if (strategy!==undefined) filter.strategy=strategy;
  if (globalTerminalStatus!==undefined) filter.globalTerminalStatus=globalTerminalStatus;
  const from=reportText(query.from,"from",64); if (from!==undefined) filter.from=from;
  const to=reportText(query.to,"to",64); if (to!==undefined) filter.to=to;
  return filter;
}

export function createUserTradingRouter(d: UserTradingApiDependencies): Router {
  const router = createRouter();
  const now = d.now ?? (() => new Date().toISOString());
  const nextIdentity = d.eventIdentity ?? (() => `http:${randomUUID()}`);

  if (d.participationService !== undefined) {
    router.post(
      "/signals/:signalId/follow",
      async (req,res,next) => {
        try {
          const body = bodyObject(req.body ?? {});
          rejectIdentity(req,body);
          exactKeys(body,[]);
          const {userId} =
            d.resolveTrustedContext(res);
          const signalId =
            opaque(
              req.params.signalId,
              "signalId",
              128,
            );
          const result =
            await d.participationService!
              .followSignal(
                userId,
                signalId,
              );

          if (
            result.kind === "CREATED" ||
            result.kind === "EXISTING"
          ) {
            res.status(200).json(result);
            return;
          }

          if (
            result.kind ===
            "SIGNAL_NOT_FOUND"
          ) {
            res.status(404).json({
              error:{
                code:"NOT_FOUND",
                message:"Resource not found.",
              },
            });
            return;
          }

          throw new Error(
            "unexpected follow result",
          );
        } catch (e) {
          next(e);
        }
      },
    );

    router.post(
      "/participations/:participationId/unfollow",
      async (req,res,next) => {
        try {
          const body = bodyObject(req.body ?? {});
          rejectIdentity(req,body);
          exactKeys(body,[]);
          const {userId} =
            d.resolveTrustedContext(res);
          const participationId =
            opaque(
              req.params.participationId,
              "participationId",
              128,
            );
          const result =
            await d.participationService!
              .unfollowParticipation(
                userId,
                participationId,
              );

          if (
            result.kind === "CANCELLED" ||
            result.kind === "ALREADY_TERMINAL"
          ) {
            res.status(200).json(result);
            return;
          }

          if (result.kind === "NOT_FOUND") {
            res.status(404).json({
              error:{
                code:"NOT_FOUND",
                message:"Resource not found.",
              },
            });
            return;
          }

          if (
            result.kind ===
            "ACTIVE_CONFLICT"
          ) {
            res.status(409).json({
              error:{
                code:"CONFLICT",
                message:
                  "Request conflicts with current trading state.",
              },
            });
            return;
          }

          throw new Error(
            "unexpected unfollow result",
          );
        } catch (e) {
          next(e);
        }
      },
    );
  }

  if (
    d.planningService !== undefined &&
    d.planningSignalResolver !== undefined
  ) {
    router.post(
      "/participations/:participationId/plan",
      async (req,res,next) => {
        try {
          const body = bodyObject(req.body);
          rejectIdentity(req,body);

          for (
            const forbidden of [
              "signal",
              "signalId",
              "direction",
              "entryPrice",
              "stopPrice",
              "exchange",
              "availableBalance",
              "equity",
            ]
          ) {
            if (
              Object.prototype.hasOwnProperty.call(
                body,
                forbidden,
              )
            ) {
              throw new TypeError(
                `${forbidden} is server-authoritative`,
              );
            }
          }

          const {
            accountReference,
            currency,
            policy,
            override,
          } =
            parsePlanBody(body);

          const {userId} =
            d.resolveTrustedContext(res);
          const participationId =
            opaque(
              req.params.participationId,
              "participationId",
              128,
            );

          const participations =
            await d.readRepository
              .listParticipations(
                userId,
                100,
              );

          const participation =
            participations.find(
              (item) =>
                item.participationId ===
                participationId,
            );

          if (!participation) {
            res.status(404).json({
              error:{
                code:"NOT_FOUND",
                message:"Resource not found.",
              },
            });
            return;
          }

          const facts =
            await d.planningSignalResolver!
              .getSignalFacts(
                participation.signalId,
              );

          if (!facts) {
            res.status(404).json({
              error:{
                code:"NOT_FOUND",
                message:"Resource not found.",
              },
            });
            return;
          }

          const result =
            await d.planningService!
              .buildPlan({
                userId,
                participationId,
                signal:facts.signal,
                account:{
                  exchange:facts.exchange,
                  accountReference,
                  currency,
                },
                policy,
                ...(override === undefined
                  ? {}
                  : {override}),
              });

          if (result.kind === "PLANNED") {
            res.status(200).json(result);
            return;
          }

          if (result.kind === "NOT_FOUND") {
            res.status(404).json({
              error:{
                code:"NOT_FOUND",
                message:"Resource not found.",
              },
            });
            return;
          }

          if (
            result.kind ===
            "STATE_CONFLICT"
          ) {
            res.status(409).json({
              error:{
                code:"CONFLICT",
                message:
                  "Request conflicts with current trading state.",
              },
            });
            return;
          }

          throw new Error(
            "unexpected planning result",
          );
        } catch (e) {
          next(e);
        }
      },
    );
  }

  router.get("/participations", async (req, res, next) => {
    try {
      rejectIdentity(req,null);
      const {userId} = d.resolveTrustedContext(res);
      const raw = req.query.limit;
      const limit = raw === undefined ? 50 : Number.parseInt(opaque(raw,"limit",3),10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("limit must be an integer from 1 to 100");
      }
      res.status(200).json({items:await d.readRepository.listParticipations(userId,limit)});
    } catch (e) { next(e); }
  });

  router.get(
    "/participations/:participationId/position",
    async (req,res,next) => {
      try {
        rejectIdentity(req,null);
        const {userId} = d.resolveTrustedContext(res);
        const participationId = opaque(
          req.params.participationId,
          "participationId",
          128,
        );
        const detail = await d.readRepository
          .getPositionDetailByParticipation(userId,participationId);
        if (!detail) {
          res.status(404).json({
            error:{code:"NOT_FOUND",message:"Resource not found."},
          });
          return;
        }
        res.status(200).json(detail);
      } catch (e) { next(e); }
    },
  );

  router.get("/positions/:positionId", async (req,res,next) => {
    try {
      rejectIdentity(req,null);
      const {userId} = d.resolveTrustedContext(res);
      const positionId = opaque(req.params.positionId,"positionId",128);
      const detail = await d.readRepository.getPositionDetail(userId,positionId);
      if (!detail) {
        res.status(404).json({error:{code:"NOT_FOUND",message:"Resource not found."}});
        return;
      }
      res.status(200).json(detail);
    } catch (e) { next(e); }
  });

  router.post("/positions/:positionId/stop", async (req,res,next) => {
    try {
      const body = bodyObject(req.body);
      rejectIdentity(req,body);
      exactKeys(body,["basis","idempotencyKey"]);
      const {userId} = d.resolveTrustedContext(res);
      const positionId = opaque(req.params.positionId,"positionId",128);
      const basisValue = opaque(body.basis,"basis",16);
      if (!isStopMoveBasis(basisValue)) throw new TypeError("invalid stop basis");
      const basis: StopMoveBasis = basisValue;
      if (d.stopPriceResolver === undefined) {
        throw new Error("server stop price resolver is unavailable");
      }
      const price = await d.stopPriceResolver.resolveStopPrice({
        userId,positionId,basis,
      });
      if (price === null) {
        res.status(404).json({
          error:{code:"NOT_FOUND",message:"Resource not found."},
        });
        return;
      }
      const eventIdentity = body.idempotencyKey === undefined
        ? nextIdentity() : opaque(body.idempotencyKey,"idempotencyKey",256);
      sendResult(res,await d.ledgerService.moveStop({
        userId,positionId,eventIdentity,observedAt:now(),move:{basis,price},
      }));
    } catch (e) { next(e); }
  });

  router.post("/positions/:positionId/exit", async (req,res,next) => {
    try {
      const body = bodyObject(req.body);
      rejectIdentity(req,body);
      exactKeys(body,["idempotencyKey"]);
      const {userId} = d.resolveTrustedContext(res);
      const positionId = opaque(req.params.positionId,"positionId",128);
      const detail = await d.readRepository.getPositionDetail(userId,positionId);
      if (!detail) {
        res.status(404).json({
          error:{code:"NOT_FOUND",message:"Resource not found."},
        });
        return;
      }
      res.status(503).json({
        error:{
          code:"PRICE_SOURCE_UNAVAILABLE",
          message:"Manual exit is unavailable until a trusted current market price source is configured.",
        },
      });
    } catch (e) { next(e); }
  });


  if (d.reports !== undefined) {
    router.get("/reports/summary", async (req,res,next) => {
      try {
        rejectIdentity(req,null);
        const {userId}=d.resolveTrustedContext(res);
        res.status(200).json(await d.reports!.summary(userId,reportFilter(req.query)));
      } catch (e) { next(e); }
    });
    router.get("/reports/history", async (req,res,next) => {
      try {
        rejectIdentity(req,null);
        const {userId}=d.resolveTrustedContext(res);
        res.status(200).json({items:await d.reports!.history(userId,reportFilter(req.query))});
      } catch (e) { next(e); }
    });
  }

  return router;
}
