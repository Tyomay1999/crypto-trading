import { loadEnv } from "../config/env.js";

import { loadAuthEnv } from "./config.js";
import {
  createDeltaAuth,
} from "./core.js";
import {
  createAuthDatabasePool,
} from "./database.js";
import type {
  AuthEmailDelivery,
} from "./email-delivery.js";

const appEnv = loadEnv();
const authEnv = loadAuthEnv();

export const authDatabasePool =
  createAuthDatabasePool(appEnv);

/*
 * Schema generation must never deliver email.
 */
const schemaEmailDelivery:
  AuthEmailDelivery = {
    verify: () =>
      Promise.resolve(),

    send: () =>
      Promise.resolve(),
  };

export const auth = createDeltaAuth(
  authDatabasePool,
  authEnv,
  schemaEmailDelivery,
);
