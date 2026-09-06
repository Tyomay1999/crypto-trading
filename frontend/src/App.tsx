import { useState } from "react";

type HealthResponse = {
  status: string;
  service: string;
  timestamp: string;
};

type ConnectionState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success"; data: HealthResponse }
  | { type: "error"; message: string };

export default function App() {
  const [connection, setConnection] =
    useState<ConnectionState>({ type: "idle" });

  const checkBackend = async () => {
    setConnection({ type: "loading" });

    try {
      const response = await fetch("/api/health", {
        method: "GET",
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`Backend returned HTTP ${response.status}`);
      }

      const data = (await response.json()) as HealthResponse;

      if (data.status !== "ok") {
        throw new Error("Backend returned an unexpected health status");
      }

      setConnection({
        type: "success",
        data
      });
    } catch (error) {
      setConnection({
        type: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown backend connection error"
      });
    }
  };

  return (
    <main className="page">
      <section className="card">
        <div className="badge">DELTA</div>

        <h1>Delta Control Center</h1>

        <p className="description">
          Initial frontend ↔ backend connectivity test.
        </p>

        <button
          className="health-button"
          onClick={checkBackend}
          disabled={connection.type === "loading"}
        >
          {connection.type === "loading"
            ? "Checking..."
            : "Check Backend Connection"}
        </button>

        {connection.type === "idle" && (
          <div className="status neutral">
            Backend status has not been checked yet.
          </div>
        )}

        {connection.type === "loading" && (
          <div className="status neutral">
            Connecting to Delta Backend...
          </div>
        )}

        {connection.type === "success" && (
          <div className="status success">
            <strong>BACKEND CONNECTION: LIVE</strong>

            <span>Service: {connection.data.service}</span>
            <span>Status: {connection.data.status}</span>
            <span>Checked: {connection.data.timestamp}</span>
          </div>
        )}

        {connection.type === "error" && (
          <div className="status error">
            <strong>BACKEND CONNECTION: FAILED</strong>
            <span>{connection.message}</span>
          </div>
        )}
      </section>
    </main>
  );
}
