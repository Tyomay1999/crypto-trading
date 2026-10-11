import assert from "node:assert/strict";
import test from "node:test";
import express from "express";

/*
 * DELTA U7 test-only native HTTP client.
 *
 * Why this exists:
 * - U7 must not add/modify application dependencies just to run this test.
 * - It implements the small Supertest-style surface used by this test file
 *   on top of Node 20 built-ins.
 * - It is test harness code only; no application/auth/domain behavior lives here.
 */
class __DeltaNativeHttpRequest {
  constructor(app, method, path, cookieJar) {
    this.app = app;
    this.method = method;
    this.path = path;
    this.cookieJar = cookieJar;
    this.headers = {};
    this.payload = undefined;
    this.queryParams = [];
    this.expectations = [];
    this.redirectMode = "manual";
    this.bodyEncoding = "json";
  }

  set(name, value) {
    if (name && typeof name === "object" && !Array.isArray(name)) {
      for (const [key, item] of Object.entries(name)) {
        this.headers[String(key).toLowerCase()] = String(item);
      }
      return this;
    }
    this.headers[String(name).toLowerCase()] = String(value);
    return this;
  }

  unset(name) {
    delete this.headers[String(name).toLowerCase()];
    return this;
  }

  query(value) {
    if (typeof value === "string") {
      this.queryParams.push(value);
      return this;
    }
    if (value && typeof value === "object") {
      const params = new URLSearchParams();
      for (const [key, item] of Object.entries(value)) {
        if (Array.isArray(item)) {
          for (const v of item) params.append(key, String(v));
        } else if (item !== undefined && item !== null) {
          params.append(key, String(item));
        }
      }
      this.queryParams.push(params.toString());
    }
    return this;
  }

  send(value) {
    this.payload = value;
    return this;
  }

  type(value) {
    const v = String(value).toLowerCase();
    if (v === "form" || v === "urlencoded") {
      this.bodyEncoding = "form";
      this.headers["content-type"] = "application/x-www-form-urlencoded";
    } else if (v === "json") {
      this.bodyEncoding = "json";
      this.headers["content-type"] = "application/json";
    } else {
      this.headers["content-type"] = String(value);
    }
    return this;
  }

  accept(value) {
    this.headers["accept"] =
      String(value).toLowerCase() === "json" ? "application/json" : String(value);
    return this;
  }

  auth(user, password) {
    this.headers["authorization"] =
      `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    return this;
  }

  redirects(count) {
    this.redirectMode = Number(count) > 0 ? "follow" : "manual";
    return this;
  }

  expect(a, b) {
    this.expectations.push([a, b]);
    return this;
  }

  then(resolve, reject) {
    return this.__run().then(resolve, reject);
  }

  catch(reject) {
    return this.__run().catch(reject);
  }

  async __run() {
    const { createServer } = await import("node:http");
    const assert = await import("node:assert/strict");

    const server = createServer(this.app);
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("native test server did not expose a TCP address");
      }

      const url = new URL(this.path, `http://127.0.0.1:${address.port}`);

      for (const q of this.queryParams) {
        if (!q) continue;
        const extra = new URLSearchParams(q);
        for (const [key, value] of extra.entries()) {
          url.searchParams.append(key, value);
        }
      }

      const headers = { ...this.headers };

      if (this.cookieJar && this.cookieJar.size > 0 && headers.cookie === undefined) {
        headers.cookie = [...this.cookieJar.entries()]
          .map(([key, value]) => `${key}=${value}`)
          .join("; ");
      }

      let body;
      if (this.payload !== undefined && this.method !== "GET" && this.method !== "HEAD") {
        if (
          typeof this.payload === "string" ||
          Buffer.isBuffer(this.payload) ||
          this.payload instanceof Uint8Array
        ) {
          body = this.payload;
        } else if (this.bodyEncoding === "form") {
          body = new URLSearchParams(
            Object.entries(this.payload).map(([k, v]) => [k, String(v)]),
          ).toString();
        } else {
          if (headers["content-type"] === undefined) {
            headers["content-type"] = "application/json";
          }
          body = JSON.stringify(this.payload);
        }
      }

      const response = await fetch(url, {
        method: this.method,
        headers,
        body,
        redirect: this.redirectMode,
      });

      const text = await response.text();
      const responseHeaders = {};
      for (const [key, value] of response.headers.entries()) {
        responseHeaders[key.toLowerCase()] = value;
      }

      let setCookies = [];
      if (typeof response.headers.getSetCookie === "function") {
        setCookies = response.headers.getSetCookie();
      } else {
        const combined = response.headers.get("set-cookie");
        if (combined) setCookies = [combined];
      }

      if (setCookies.length > 0) {
        responseHeaders["set-cookie"] = setCookies;
      }

      if (this.cookieJar) {
        for (const cookie of setCookies) {
          const first = cookie.split(";", 1)[0];
          const eq = first.indexOf("=");
          if (eq <= 0) continue;
          const key = first.slice(0, eq).trim();
          const value = first.slice(eq + 1).trim();
          if (value === "") this.cookieJar.delete(key);
          else this.cookieJar.set(key, value);
        }
      }

      let parsedBody = {};
      if (text.length > 0) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = {};
        }
      }

      const result = {
        status: response.status,
        statusCode: response.status,
        headers: responseHeaders,
        text,
        body: parsedBody,
        get(name) {
          return responseHeaders[String(name).toLowerCase()];
        },
      };

      for (const [a, b] of this.expectations) {
        if (typeof a === "number") {
          assert.equal(
            result.status,
            a,
            `expected HTTP ${a}, received ${result.status}: ${result.text}`,
          );
          continue;
        }

        if (typeof a === "function" && b === undefined) {
          await a(result);
          continue;
        }

        if (b !== undefined && typeof a === "string") {
          const actual = result.get(a);
          if (b instanceof RegExp) {
            assert.match(String(actual ?? ""), b);
          } else {
            assert.equal(actual, String(b));
          }
          continue;
        }

        if (a instanceof RegExp) {
          assert.match(result.text, a);
          continue;
        }

        if (typeof a === "string") {
          assert.equal(result.text, a);
          continue;
        }

        if (a !== undefined) {
          assert.deepEqual(result.body, a);
        }
      }

      return result;
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }
}

class __DeltaNativeHttpAgent {
  constructor(app) {
    this.app = app;
    this.cookieJar = new Map();
  }

  __request(method, path) {
    return new __DeltaNativeHttpRequest(this.app, method, path, this.cookieJar);
  }

  get(path) { return this.__request("GET", path); }
  post(path) { return this.__request("POST", path); }
  put(path) { return this.__request("PUT", path); }
  patch(path) { return this.__request("PATCH", path); }
  delete(path) { return this.__request("DELETE", path); }
  head(path) { return this.__request("HEAD", path); }
  options(path) { return this.__request("OPTIONS", path); }
}

function request(app) {
  return new __DeltaNativeHttpAgent(app);
}

request.agent = function agent(app) {
  return new __DeltaNativeHttpAgent(app);
};

const {createUserTradingRouter} = await import("../dist/user-trading/api/index.js");

function deps(userId="user-a"){
  const calls=[];
  return {
    calls,
    readRepository:{
      async listParticipations(u,l){calls.push(["list",u,l]);return [];},
      async getPositionDetail(u,p){calls.push(["detail",u,p]);return p==="missing"?null:{
        position:{positionId:p,participationId:"pa",userId:u,signalId:"s",direction:"LONG",
          state:"OPEN",actualEntryPrice:"100",enteredAt:"2026-10-11T17:00:00.000Z",
          initialQuantity:"10",initialNotional:"1000",remainingFraction:"1",
          realizedFraction:"0",realizedPnl:"0",selectedStopPrice:"90",stopBasis:"ORIGINAL",
          lastGlobalSequence:"2",lastGlobalState:"ENTRY_REACHED",version:"1",terminalAt:null},
        events:[],outcome:null};},
    },
    ledgerService:{
      async moveStop(i){calls.push(["stop",i]);return {kind:"APPLIED",position:{},event:{},outcome:null};},
      async manualExit(i){calls.push(["exit",i]);return {kind:"APPLIED",position:{},event:{},outcome:{}};},
    },
    resolveTrustedContext(){return {userId};},
  };
}
function app(d){
  const a=express(); a.use(express.json());
  a.use("/api/v1/me/trading",createUserTradingRouter({
    readRepository:d.readRepository,ledgerService:d.ledgerService,
    resolveTrustedContext:d.resolveTrustedContext,
    now:()=> "2026-10-11T18:00:00.000Z",
    eventIdentity:()=> "generated-id",
  }));
  return a;
}

test("trusted userId drives reads",async()=>{
  const d=deps(); await request(app(d)).get("/api/v1/me/trading/participations").expect(200);
  assert.deepEqual(d.calls[0],["list","user-a",50]);
});
test("client userId query is rejected",async()=>{
  const d=deps(); const r=await request(app(d)).get("/api/v1/me/trading/participations?userId=user-b");
  assert.notEqual(r.status,200); assert.equal(d.calls.length,0);
});
test("client userId body is rejected",async()=>{
  const d=deps(); const r=await request(app(d)).post("/api/v1/me/trading/positions/p/stop")
    .send({userId:"user-b",basis:"ENTRY",price:"100"});
  assert.notEqual(r.status,200); assert.equal(d.calls.length,0);
});
test("missing or foreign position is generic 404",async()=>{
  const d=deps(); const r=await request(app(d)).get("/api/v1/me/trading/positions/missing").expect(404);
  assert.equal(r.body.error.code,"NOT_FOUND");
});
test("stop passes trusted user and idempotency key",async()=>{
  const d=deps(); await request(app(d)).post("/api/v1/me/trading/positions/p/stop")
    .send({basis:"ENTRY",price:"100",idempotencyKey:"same-across-devices"}).expect(200);
  const [,i]=d.calls[0]; assert.equal(i.userId,"user-a"); assert.equal(i.eventIdentity,"same-across-devices");
});
test("manual exit passes trusted user",async()=>{
  const d=deps(); await request(app(d)).post("/api/v1/me/trading/positions/p/exit")
    .send({price:"105",idempotencyKey:"exit-1"}).expect(200);
  const [,i]=d.calls[0]; assert.equal(i.userId,"user-a");
  assert.equal(i.exit.occurredAt,"2026-10-11T18:00:00.000Z");
});
test("production composition uses supported session accessor",async()=>{
  const {readFileSync}=await import("node:fs");
  const s=readFileSync("src/user-trading/api/composition.ts","utf8");
  assert.match(s,/getCurrentSessionContext\(response\)\.userId/u);
  assert.doesNotMatch(s,/res\.locals|response\.locals|CURRENT_SESSION_CONTEXT/u);
});
test("all owned SQL reads are user scoped",async()=>{
  const {readFileSync}=await import("node:fs");
  const s=readFileSync("src/user-trading/api/postgres-read-repository.ts","utf8");
  assert.match(s,/user_signal_participation[\s\S]*WHERE user_id = \$1/u);
  assert.match(s,/user_position[\s\S]*WHERE user_id = \$1 AND position_id = \$2/u);
  assert.match(s,/user_position_event[\s\S]*WHERE user_id = \$1 AND position_id = \$2/u);
  assert.match(s,/user_position_outcome[\s\S]*WHERE user_id = \$1 AND position_id = \$2/u);
});
