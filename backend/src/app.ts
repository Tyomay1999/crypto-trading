import express from "express";
import {
  toNodeHandler,
} from "better-auth/node";

import type {
  DeltaAuth,
} from "./auth/core.js";
import {
  errorHandlerMiddleware,
} from "./middleware/error-handler.js";
import {
  notFoundMiddleware,
} from "./middleware/not-found.js";
import {
  requestContextMiddleware,
} from "./middleware/request-context.js";
import {
  createHealthRouter,
  type HealthDependencies,
} from "./routes/health.routes.js";
import type {
  ApplicationState,
} from "./runtime/application-state.js";

export function createApp(
  applicationState: ApplicationState,
  healthDependencies: HealthDependencies,
  auth?: DeltaAuth,
) {
  const app = express();

  app.disable("x-powered-by");

  /*
   * Request context does not consume the body,
   * therefore it can safely precede Better Auth.
   */
  app.use(requestContextMiddleware);

  /*
   * Better Auth MUST be mounted before
   * express.json(). Express 5 uses the named
   * catch-all parameter syntax "*splat".
   */
  if (auth !== undefined) {
    app.all(
      "/api/auth/*splat",
      toNodeHandler(auth),
    );
  }

  /*
   * All normal Delta JSON routes are parsed
   * only after the Better Auth request stream
   * has had the opportunity to consume it.
   */
  app.use(express.json());

  const healthRouter =
    createHealthRouter(
      applicationState,
      healthDependencies,
    );

  app.use(
    "/health",
    healthRouter,
  );

  app.use(
    "/api/v1/health",
    healthRouter,
  );

  app.get("/", (_request, response) => {
    response.status(200).json({
      service: "delta-backend",
      version: "v1",
      message: "Delta Backend API",
    });
  });

  app.use(notFoundMiddleware);
  app.use(errorHandlerMiddleware);

  return app;
}
