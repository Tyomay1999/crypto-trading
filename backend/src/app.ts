import express from "express";

import { errorHandlerMiddleware } from "./middleware/error-handler.js";
import { notFoundMiddleware } from "./middleware/not-found.js";
import { requestContextMiddleware } from "./middleware/request-context.js";
import { createHealthRouter } from "./routes/health.routes.js";
import type {
  ApplicationState,
} from "./runtime/application-state.js";

export function createApp(
  applicationState: ApplicationState,
) {
  const app = express();

  app.disable("x-powered-by");

  app.use(requestContextMiddleware);
  app.use(express.json());

  const healthRouter = createHealthRouter(applicationState);

  app.use("/health", healthRouter);
  app.use("/api/v1/health", healthRouter);

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
