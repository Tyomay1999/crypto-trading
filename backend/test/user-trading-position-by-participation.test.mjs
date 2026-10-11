import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";

const {createUserTradingRouter}=await import("../dist/user-trading/api/index.js");

function detail(){
  return {
    position:{
      positionId:"position-a",
      participationId:"participation-a",
      userId:"user-a",
      signalId:"signal-a",
      direction:"LONG",
      state:"OPEN",
      actualEntryPrice:"100",
      enteredAt:"2026-10-11T17:00:00.000Z",
      initialQuantity:"10",
      initialNotional:"1000",
      remainingFraction:"1",
      realizedFraction:"0",
      realizedPnl:"0",
      selectedStopPrice:"90",
      stopBasis:"ORIGINAL",
      lastGlobalSequence:"2",
      lastGlobalState:"ENTRY_REACHED",
      version:"1",
      terminalAt:null,
    },
    events:[],
    outcome:null,
  };
}

function harness(found=true){
  const calls=[];
  const d={
    readRepository:{
      async listParticipations(){return[];},
      async getPositionDetail(){return null;},
      async getPositionDetailByParticipation(userId,participationId){
        calls.push([userId,participationId]);
        return found?detail():null;
      },
    },
    ledgerService:{
      async moveStop(){throw new Error("unused");},
      async manualExit(){throw new Error("unused");},
    },
    resolveTrustedContext(){return{userId:"user-a"};},
  };

  const app=express();
  app.use(express.json());
  app.use("/api/v1/me/trading",createUserTradingRouter(d));
  return{app,calls};
}

async function getJson(app,path){
  const server=createServer(app);
  await new Promise((resolve,reject)=>{
    const onError=(error)=>{
      server.off("listening",onListening);
      reject(error);
    };
    const onListening=()=>{
      server.off("error",onError);
      resolve();
    };
    server.once("error",onError);
    server.once("listening",onListening);
    server.listen(0,"127.0.0.1");
  });

  try{
    const address=server.address();
    if(!address || typeof address==="string"){
      throw new Error("test server address unavailable");
    }
    const response=await fetch(`http://127.0.0.1:${address.port}${path}`);
    const text=await response.text();
    const body=text.length===0?{}:JSON.parse(text);
    return{status:response.status,body,text};
  }finally{
    await new Promise((resolve,reject)=>{
      server.close((error)=>error?reject(error):resolve());
    });
  }
}

test("position lookup is scoped by trusted user and participation",async()=>{
  const h=harness(true);
  const r=await getJson(
    h.app,
    "/api/v1/me/trading/participations/participation-a/position",
  );
  assert.equal(r.status,200,r.text);
  assert.equal(r.body.position.positionId,"position-a");
  assert.deepEqual(h.calls,[["user-a","participation-a"]]);
});

test("missing or foreign participation position is generic 404",async()=>{
  const h=harness(false);
  const r=await getJson(
    h.app,
    "/api/v1/me/trading/participations/foreign/position",
  );
  assert.equal(r.status,404,r.text);
  assert.equal(r.body.error.code,"NOT_FOUND");
  assert.deepEqual(h.calls,[["user-a","foreign"]]);
});
