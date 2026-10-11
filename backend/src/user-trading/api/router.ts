import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import type { UserTradingLedgerService } from "../ledger/service.js";
import type { UserTradingApiReadRepository } from "./types.js";

type StopMoveBasis = "ENTRY" | "TP1" | "TP2";

function isStopMoveBasis(value: string): value is StopMoveBasis {
  return value === "ENTRY" || value === "TP1" || value === "TP2";
}

export interface TrustedAuthenticatedUserContext { userId: string; }
export interface UserTradingApiDependencies {
  readRepository: UserTradingApiReadRepository;
  ledgerService: UserTradingLedgerService;
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

export function createUserTradingRouter(d: UserTradingApiDependencies): Router {
  const router = createRouter();
  const now = d.now ?? (() => new Date().toISOString());
  const nextIdentity = d.eventIdentity ?? (() => `http:${randomUUID()}`);

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
      exactKeys(body,["basis","price","idempotencyKey"]);
      const {userId} = d.resolveTrustedContext(res);
      const positionId = opaque(req.params.positionId,"positionId",128);
      const basisValue = opaque(body.basis,"basis",16);
      if (!isStopMoveBasis(basisValue)) throw new TypeError("invalid stop basis");
      const basis: StopMoveBasis = basisValue;
      const price = opaque(body.price,"price",128);
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
      exactKeys(body,["price","idempotencyKey"]);
      const {userId} = d.resolveTrustedContext(res);
      const positionId = opaque(req.params.positionId,"positionId",128);
      const price = opaque(body.price,"price",128);
      const eventIdentity = body.idempotencyKey === undefined
        ? nextIdentity() : opaque(body.idempotencyKey,"idempotencyKey",256);
      const at = now();
      sendResult(res,await d.ledgerService.manualExit({
        userId,positionId,eventIdentity,observedAt:at,exit:{price,occurredAt:at},
      }));
    } catch (e) { next(e); }
  });

  return router;
}
