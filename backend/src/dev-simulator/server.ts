import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import type { DevSignalController } from "./control.js";
import {
  DEV_AUTOPLAY_SCENARIOS,
  DevAutoplayService,
  type DevAutoplayScenario,
} from "./autoplay.js";
import { createDemoProjection } from "./scenarios.js";

const MAX_BODY_BYTES = 16 * 1024;

type ControlServerOptions = Readonly<{
  host: string;
  port: number;
}>;

type CreateSignalBody = Readonly<{
  signalId: string;
  symbol?: string;
  direction?: "LONG" | "SHORT";
}>;

type AutoplayBody = Readonly<{
  scenario: DevAutoplayScenario;
  delayMs: number;
}>;

function sendJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function sendNoContent(response: ServerResponse, statusCode = 204): void {
  response.statusCode = statusCode;
  response.setHeader("cache-control", "no-store");
  response.end();
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let received = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > MAX_BODY_BYTES) {
      throw new ControlHttpError(413, "request_too_large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new ControlHttpError(400, "invalid_json");
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ControlHttpError(400, "invalid_body");
  }
  return value as Record<string, unknown>;
}

function parseCreateSignalBody(value: unknown): CreateSignalBody {
  const raw = requireObject(value);
  const allowed = new Set(["signalId", "symbol", "direction"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ControlHttpError(400, "unexpected_field");
    }
  }

  if (typeof raw.signalId !== "string" || raw.signalId.trim().length === 0) {
    throw new ControlHttpError(400, "invalid_signal_id");
  }
  const signalId = raw.signalId.trim();
  if (signalId.length > 128 || /[\u0000-\u001f\u007f]/u.test(signalId)) {
    throw new ControlHttpError(400, "invalid_signal_id");
  }

  let symbol: string | undefined;
  if (raw.symbol !== undefined) {
    if (
      typeof raw.symbol !== "string" ||
      raw.symbol.trim().length === 0 ||
      raw.symbol.trim().length > 32 ||
      !/^[A-Z0-9_-]+$/u.test(raw.symbol.trim())
    ) {
      throw new ControlHttpError(400, "invalid_symbol");
    }
    symbol = raw.symbol.trim();
  }

  let direction: "LONG" | "SHORT" | undefined;
  if (raw.direction !== undefined) {
    if (raw.direction !== "LONG" && raw.direction !== "SHORT") {
      throw new ControlHttpError(400, "invalid_direction");
    }
    direction = raw.direction;
  }

  return { signalId, symbol, direction };
}

function parseAutoplayBody(value: unknown): AutoplayBody {
  const raw = requireObject(value);
  const allowed = new Set(["scenario", "delayMs"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ControlHttpError(400, "unexpected_field");
    }
  }

  if (
    typeof raw.scenario !== "string" ||
    !DEV_AUTOPLAY_SCENARIOS.includes(raw.scenario as DevAutoplayScenario)
  ) {
    throw new ControlHttpError(400, "invalid_autoplay_scenario");
  }

  if (
    typeof raw.delayMs !== "number" ||
    !Number.isSafeInteger(raw.delayMs) ||
    raw.delayMs < 0 ||
    raw.delayMs > 60_000
  ) {
    throw new ControlHttpError(400, "invalid_autoplay_delay");
  }

  return {
    scenario: raw.scenario as DevAutoplayScenario,
    delayMs: raw.delayMs,
  };
}

class ControlHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = "ControlHttpError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function pathSegments(request: IncomingMessage): string[] {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  return url.pathname.split("/").filter(Boolean);
}

function mapControllerError(error: unknown): ControlHttpError {
  if (!(error instanceof Error)) return new ControlHttpError(500, "internal_error");

  if (/already exists/u.test(error.message)) {
    return new ControlHttpError(409, "signal_already_exists");
  }
  if (/Unknown DEV signal/u.test(error.message)) {
    return new ControlHttpError(404, "signal_not_found");
  }
  if (/terminal/u.test(error.message)) {
    return new ControlHttpError(409, "signal_terminal");
  }
  if (/not allowed/u.test(error.message)) {
    return new ControlHttpError(409, "transition_not_allowed");
  }
  if (/Autoplay already running/u.test(error.message)) {
    return new ControlHttpError(409, "autoplay_already_running");
  }
  if (/Autoplay requires PUBLISHED/u.test(error.message)) {
    return new ControlHttpError(409, "autoplay_requires_published");
  }

  return new ControlHttpError(500, "internal_error");
}

export function createDevControlServer(
  controller: DevSignalController,
  options: ControlServerOptions,
): Server {
  if (!isLoopbackHost(options.host)) {
    throw new Error("DEV control server must bind to loopback only.");
  }

  const autoplay = new DevAutoplayService(controller);

  return createServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const segments = pathSegments(request);

      if (method === "GET" && segments.length === 1 && segments[0] === "status") {
        sendJson(response, 200, {
          status: "ok",
          signals: controller.list(),
        });
        return;
      }

      if (method === "POST" && segments.length === 1 && segments[0] === "signals") {
        const body = parseCreateSignalBody(await readJsonBody(request));
        const projection = createDemoProjection(
          body.signalId,
          body.symbol ?? "BTCUSDT",
          body.direction ?? "LONG",
        );
        const record = await controller.publish(body.signalId, projection);
        sendJson(response, 201, { signal: record });
        return;
      }

      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "signals" &&
        segments[2] === "next"
      ) {
        await readJsonBody(request).then((body) => {
          if (Object.keys(requireObject(body)).length !== 0) {
            throw new ControlHttpError(400, "body_must_be_empty");
          }
        });
        const record = await controller.next(decodeURIComponent(segments[1]));
        sendJson(response, 200, { signal: record });
        return;
      }

      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "signals" &&
        segments[2] === "autoplay"
      ) {
        const body = parseAutoplayBody(await readJsonBody(request));
        const signalId = decodeURIComponent(segments[1]);

        if (autoplay.isRunning(signalId)) {
          throw new ControlHttpError(409, "autoplay_already_running");
        }

        const record = await autoplay.run(signalId, body.scenario, {
          delayMs: body.delayMs,
        });
        sendJson(response, 200, { signal: record });
        return;
      }

      if (
        method === "POST" &&
        segments.length === 3 &&
        segments[0] === "signals" &&
        segments[2] === "stop"
      ) {
        await readJsonBody(request).then((body) => {
          if (Object.keys(requireObject(body)).length !== 0) {
            throw new ControlHttpError(400, "body_must_be_empty");
          }
        });
        const record = await controller.stop(decodeURIComponent(segments[1]));
        sendJson(response, 200, { signal: record });
        return;
      }

      if (method === "GET" && segments.length === 0) {
        sendNoContent(response);
        return;
      }

      throw new ControlHttpError(404, "not_found");
    } catch (error) {
      const mapped =
        error instanceof ControlHttpError ? error : mapControllerError(error);

      sendJson(response, mapped.statusCode, {
        error: {
          code: mapped.code,
        },
      });
    }
  });
}

export async function listenDevControlServer(
  server: Server,
  options: ControlServerOptions,
): Promise<AddressInfo> {
  if (!isLoopbackHost(options.host)) {
    throw new Error("DEV control server must bind to loopback only.");
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("DEV control server did not expose a TCP address.");
  }
  return address;
}
