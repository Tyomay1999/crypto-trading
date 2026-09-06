import express from "express";

const app = express();

const port = Number(process.env.PORT ?? 3001);

app.disable("x-powered-by");
app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({
    status: "ok",
    service: "delta-backend",
    timestamp: new Date().toISOString()
  });
});

app.get("/", (_request, response) => {
  response.status(200).json({
    service: "delta-backend",
    message: "Delta Backend API"
  });
});

const server = app.listen(port, "0.0.0.0", () => {
  console.log(`delta-backend listening on 0.0.0.0:${port}`);
});

const shutdown = (signal: string) => {
  console.log(`Received ${signal}. Shutting down...`);

  server.close(() => {
    console.log("HTTP server stopped.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
