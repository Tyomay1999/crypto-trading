import type { NextFunction, Request, Response } from "express";

import { AppError } from "../errors/app-error.js";

export function notFoundMiddleware(
  _request: Request,
  _response: Response,
  next: NextFunction,
): void {
  next(
    new AppError(
      404,
      "ROUTE_NOT_FOUND",
      "The requested API route does not exist.",
    ),
  );
}
