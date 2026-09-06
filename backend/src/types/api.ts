import type {
  ApplicationPhase,
} from "../runtime/application-state.js";

export type ApiHealthResponse = {
  status: "ok";
  service: "delta-backend";
  version: "v1";
  timestamp: string;
};

export type ApiHealthCheckResponse = {
  status: "ok" | "not_ready";
  service: "delta-backend";
  version: "v1";
  check: "live" | "ready";
  phase: ApplicationPhase;
  timestamp: string;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};
