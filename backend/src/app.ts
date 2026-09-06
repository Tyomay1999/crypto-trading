import express from "express";

import { errorHandlerMiddleware } from "./middleware/error-handler.js";
import { notFoundMiddleware } from "./middleware/not-found.js";
import { requestContextMiddleware } from "./middleware/request-context.js";
import { healthRouter } from "./routes/health.routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.use(requestContextMiddleware);
  app.use(express.json());

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
