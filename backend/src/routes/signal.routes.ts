import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { AppError } from "../errors/app-error.js";
import type {
  ProjectionReader,
} from "../projection/reader.js";

export interface SignalRoutesDependencies {
  readonly reader: ProjectionReader;
}

const DEFAULT_SIGNAL_LIST_LIMIT = 50;
const MAX_SIGNAL_LIST_LIMIT = 100;

function parseLimit(
  value: unknown,
): number {
  if (value === undefined) {
    return DEFAULT_SIGNAL_LIST_LIMIT;
  }

  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    throw new AppError(
      400,
      "INVALID_SIGNAL_QUERY",
      "Signal list query is invalid.",
    );
  }

  const parsed =
    Number(value);

  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_SIGNAL_LIST_LIMIT
  ) {
    throw new AppError(
      400,
      "INVALID_SIGNAL_QUERY",
      "Signal list query is invalid.",
    );
  }

  return parsed;
}

function requireRouteSignalId(
  request: Request,
): string {
  const signalId =
    request.params.signalId;

  if (
    typeof signalId !== "string" ||
    signalId.length < 1 ||
    signalId.length > 128 ||
    /[\u0000-\u001f\u007f]/u.test(
      signalId,
    )
  ) {
    throw new AppError(
      400,
      "INVALID_SIGNAL_ID",
      "Signal identifier is invalid.",
    );
  }

  return signalId;
}

function signalNotFound():
  AppError {
  return new AppError(
    404,
    "SIGNAL_NOT_FOUND",
    "Signal was not found.",
  );
}

function noStore(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader(
    "Cache-Control",
    "no-store",
  );
  next();
}

export function createSignalRouter(
  dependencies:
    SignalRoutesDependencies,
) {
  const router = Router();

  router.use(noStore);

  router.get(
    "/",
    async (
      request,
      response,
    ) => {
      const limit =
        parseLimit(
          request.query.limit,
        );

      const signals =
        await dependencies.reader
          .listSignals(limit);

      response.status(200).json({
        signals,
      });
    },
  );

  router.get(
    "/:signalId/events",
    async (
      request,
      response,
    ) => {
      const signalId =
        requireRouteSignalId(
          request,
        );

      const result =
        await dependencies.reader
          .getEvents(signalId);

      if (result === null) {
        throw signalNotFound();
      }

      response.status(200).json(
        result,
      );
    },
  );

  router.get(
    "/:signalId/outcome",
    async (
      request,
      response,
    ) => {
      const signalId =
        requireRouteSignalId(
          request,
        );

      const result =
        await dependencies.reader
          .getOutcome(signalId);

      if (result === null) {
        throw signalNotFound();
      }

      response.status(200).json(
        result,
      );
    },
  );

  router.get(
    "/:signalId",
    async (
      request,
      response,
    ) => {
      const signalId =
        requireRouteSignalId(
          request,
        );

      const signal =
        await dependencies.reader
          .getSignal(signalId);

      if (signal === null) {
        throw signalNotFound();
      }

      response.status(200).json({
        signal,
      });
    },
  );

  return router;
}
