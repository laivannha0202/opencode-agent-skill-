import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertActivePlanScope, persistPlanScope } from "../lib/work-plan-scope.mjs"
test("V12 plan scope persists hash-keyed snapshot and fences mismatches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"ues-plan-scope-"))
  try {
    const dir = path.join(root,".ues-work","demo")
    const paths = {root,dir,plans:path.join(dir,"plans"),activePlan:path.join(dir,"ACTIVE_PLAN.json")}
    await mkdir(paths.plans,{recursive:true})
    const hash = "a".repeat(64)
    await persistPlanScope(paths,hash,{schemaVersion:1,goal:"demo",tasks:[]})
    assert.equal((await assertActivePlanScope(paths,hash)).planHash,hash)
    await assert.rejects(assertActivePlanScope(paths,"b".repeat(64)),/scope mismatch/)
  } finally { await rm(root,{recursive:true,force:true}) }
})
