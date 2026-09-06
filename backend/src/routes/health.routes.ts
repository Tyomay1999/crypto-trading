import { Router } from "express";

import type {
  ApplicationState,
} from "../runtime/application-state.js";
import type {
  ApiHealthCheckResponse,
  ApiHealthResponse,
} from "../types/api.js";

export function createHealthRouter(
  applicationState: ApplicationState,
) {
  const router = Router();

  /*
   * Legacy compatibility endpoint.
   *
   * This preserves the initial Delta frontend/backend contract.
   * Runtime dependency readiness is exposed separately via /ready.
   */
  router.get("/", (_request, response) => {
    const payload: ApiHealthResponse = {
      status: "ok",
      service: "delta-backend",
      version: "v1",
      timestamp: new Date().toISOString(),
    };

    response.status(200).json(payload);
  });

  router.get("/live", (_request, response) => {
    const payload: ApiHealthCheckResponse = {
      status: "ok",
      service: "delta-backend",
      version: "v1",
      check: "live",
      phase: applicationState.getPhase(),
      timestamp: new Date().toISOString(),
    };

    response.status(200).json(payload);
  });

  router.get("/ready", (_request, response) => {
    const ready = applicationState.isReady();

    const payload: ApiHealthCheckResponse = {
      status: ready ? "ok" : "not_ready",
      service: "delta-backend",
      version: "v1",
      check: "ready",
      phase: applicationState.getPhase(),
      timestamp: new Date().toISOString(),
    };

    response.status(ready ? 200 : 503).json(payload);
  });

  return router;
}
