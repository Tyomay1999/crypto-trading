export type ApiHealthResponse = {
  status: "ok";
  service: "delta-backend";
  version: "v1";
  timestamp: string;
};

export type ApiErrorResponse = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};
