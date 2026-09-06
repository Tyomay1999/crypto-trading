import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function resolveRequestId(candidate: string | undefined): string {
  if (candidate !== undefined && REQUEST_ID_PATTERN.test(candidate)) {
    return candidate;
  }

  return randomUUID();
}

export function getRequestId(response: Response): string {
  const requestId: unknown = response.locals.requestId;

  return typeof requestId === "string" ? requestId : "unknown";
}

export function requestContextMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const requestId = resolveRequestId(request.header("x-request-id"));
  const startedAt = process.hrtime.bigint();

  const requestPath = request.originalUrl.split("?", 1)[0];

  response.locals.requestId = requestId;
  response.setHeader("x-request-id", requestId);

  response.on("finish", () => {
    const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
    const durationMs = Number(elapsedNanoseconds) / 1_000_000;

    console.log(
      JSON.stringify({
        event: "http_request_completed",
        requestId,
        method: request.method,
        path: requestPath,
        statusCode: response.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
      }),
    );
  });

  next();
}
