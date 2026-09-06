import { Router } from "express";

import type { ApiHealthResponse } from "../types/api.js";

export const healthRouter = Router();

healthRouter.get("/", (_request, response) => {
  const payload: ApiHealthResponse = {
    status: "ok",
    service: "delta-backend",
    version: "v1",
    timestamp: new Date().toISOString(),
  };

  response.status(200).json(payload);
});
