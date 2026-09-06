import type { ErrorRequestHandler } from "express";

import { AppError } from "../errors/app-error.js";
import type { ApiErrorResponse } from "../types/api.js";
import { getRequestId } from "./request-context.js";

type BodyParserError = Error & {
  status?: number;
  type?: string;
};

function isInvalidJsonError(error: unknown): error is BodyParserError {
  if (!(error instanceof SyntaxError)) {
    return false;
  }

  const candidate = error as BodyParserError;

  return (
    candidate.status === 400 &&
    candidate.type === "entity.parse.failed"
  );
}

export const errorHandlerMiddleware: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  const requestId = getRequestId(response);

  if (isInvalidJsonError(error)) {
    const payload: ApiErrorResponse = {
      error: {
        code: "INVALID_JSON",
        message: "Request body contains invalid JSON.",
        requestId,
      },
    };

    response.status(400).json(payload);
    return;
  }

  if (error instanceof AppError) {
    const payload: ApiErrorResponse = {
      error: {
        code: error.code,
        message: error.expose
          ? error.message
          : "An unexpected server error occurred.",
        requestId,
      },
    };

    response.status(error.statusCode).json(payload);
    return;
  }

  console.error(
    JSON.stringify({
      event: "unhandled_application_error",
      requestId,
      message:
        error instanceof Error
          ? error.message
          : "Unknown application error",
    }),
  );

  const payload: ApiErrorResponse = {
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected server error occurred.",
      requestId,
    },
  };

  response.status(500).json(payload);
};
