import { test } from "node:test";
import assert from "node:assert/strict";
import { startHelper } from "./chatgpt-connect.mjs";
const state="a".repeat(43);
await test("helper rejects unrelated requests and relays a single bounded authorization result to its stage",async()=>{
  const calls=[];
  const helper=await startHelper({stage:"next",fetcher:async(url,init)=>{calls.push({url,init});return Response.json({status:"connected",accountId:"account_1"});}});
  try {
    assert.equal((await fetch(helper.redirectUri+"?state=wrong&code=one")).status,400);
    assert.equal((await fetch(helper.redirectUri.replace("/auth/callback","/other"))).status,404);
    const result=await fetch(helper.redirectUri+`?state=${state}&code=one&client_id=oaiapp_one`,{redirect:"manual"});
    assert.equal(result.status,303);assert.equal(new URL(result.headers.get("Location")).origin,"https://next.kitties.rccpr.tech");
    assert.equal((await helper.done).ok,true);assert.equal(calls.length,1);assert.equal(calls[0].url,"https://auth-next.kitties.rccpr.tech/oauth/chatgpt/callback");
    assert.deepEqual(JSON.parse(calls[0].init.body),{state,code:"one",clientId:"oaiapp_one"});
  } finally {helper.close();}
});
await test("denied and duplicate callbacks expose no provider diagnostics and never return credentials",async()=>{
  const helper=await startHelper({stage:"prod",fetcher:async()=>Response.json({status:"failed",access_token:"never-display"},{status:400})});
  try {
    assert.equal((await fetch(helper.redirectUri+`?state=${state}&state=${state}&code=one`)).status,400);
    const result=await fetch(helper.redirectUri+`?state=${state}&error=access_denied`);assert.equal(result.status,400);assert.ok(!(await result.text()).includes("never-display"));assert.equal((await helper.done).ok,false);
  } finally {helper.close();}
});
await test("listener expires and unsupported stages fail before listening",async()=>{
  const helper=await startHelper({stage:"next",timeoutMs:10});assert.deepEqual(await helper.done,{ok:false,expired:true});await assert.rejects(startHelper({stage:"evil"}));
});
