import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute, resolve } from "node:path";

export type DrSourceBundle = Readonly<Record<string, unknown>>;

export interface DrSourceOptions {
  readonly databasePath: string;
  readonly helperPath?: string;
  readonly pythonExecutable?: string;
}

function requireAbsolutePath(value: string, label: string): string {
  if (value.length === 0 || !isAbsolute(value)) {
    throw new TypeError(`${label} must be an absolute path`);
  }
  return value;
}

function requireJsonObject(value: unknown): DrSourceBundle {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError("DR source helper emitted a non-object JSON value");
  }

  return value as DrSourceBundle;
}

export async function* readDrSourceBundles(
  options: DrSourceOptions,
): AsyncGenerator<DrSourceBundle> {
  const databasePath = requireAbsolutePath(
    options.databasePath,
    "DR SQLite database path",
  );

  const helperPath = requireAbsolutePath(
    options.helperPath ??
      resolve(process.cwd(), "tools/dr-sqlite-export.py"),
    "DR SQLite helper path",
  );

  const pythonExecutable =
    options.pythonExecutable ?? "python3";

  const child = spawn(
    pythonExecutable,
    [helperPath, databasePath],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "",
        PYTHONUNBUFFERED: "1",
      },
    },
  );

  if (child.stdout === null || child.stderr === null) {
    throw new Error("DR source helper stdio was not created");
  }

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) {
      stderr += chunk.slice(
        0,
        16_384 - stderr.length,
      );
    }
  });

  const completion = new Promise<number>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code) => resolveExit(code ?? -1));
  });

  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let fullyConsumed = false;

  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          "DR source helper emitted invalid JSON",
        );
      }

      yield requireJsonObject(parsed);
    }

    fullyConsumed = true;
    const code = await completion;

    if (code !== 0) {
      throw new Error(
        stderr.trim().length > 0
          ? `DR source helper failed: ${stderr.trim()}`
          : `DR source helper exited with code ${code}`,
      );
    }
  } finally {
    lines.close();

    if (!fullyConsumed && child.exitCode === null) {
      child.kill("SIGTERM");
      await completion.catch(() => undefined);
    }
  }
}
