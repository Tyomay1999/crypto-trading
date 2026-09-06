import { loadEnv } from "../config/env.js";

import { loadAuthEnv } from "./config.js";
import {
  createDeltaAuth,
} from "./core.js";
import {
  createAuthDatabasePool,
} from "./database.js";

const appEnv = loadEnv();
const authEnv = loadAuthEnv();

export const authDatabasePool =
  createAuthDatabasePool(appEnv);

export const auth = createDeltaAuth(
  authDatabasePool,
  authEnv,
);
