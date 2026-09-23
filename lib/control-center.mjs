import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { readLearningState } from "./learning-engine.mjs"
import { readRuntimeEvents } from "./runtime-events.mjs"
import { evidenceStoreStatus } from "./evidence-store.mjs"
import { memoryStatus } from "./memory-engine.mjs"
import { capabilityFabricStatus } from "./capability-fabric.mjs"

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, "utf8")) } catch { return fallback }
}

async function collectWork(root) {
  const workRoot = path.join(root, ".ues-work")
  const entries = await readdir(workRoot, { withFileTypes: true }).catch(() => [])
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(workRoot, entry.name)
    const [state, plan, evidence, events] = await Promise.all([
      readJson(path.join(dir, "STATE.json"), {}),
      readJson(path.join(dir, "PLAN.json"), {}),
      readJson(path.join(dir, "EVIDENCE.json"), {}),
      readRuntimeEvents(path.join(dir, "EVENTS.jsonl"), { limit: 30 }),
    ])
    items.push({
      slug: entry.name,
      status: state.status || "unknown",
      goal: state.goal || plan.goal || "",
      nextAction: state.nextAction || "",
      blockers: state.blockers || [],
      tasks: (plan.tasks || []).map((task) => ({
        id: task.id,
        title: task.title,
        risk: task.risk || "medium",
        state: state.tasks?.[task.id] || {},
      })),
      receipts: evidence.receipts || [],
      recentEvents: events,
      updatedAt: state.updatedAt || null,
    })
  }
  return items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

async function collectEvalSummary(root) {
  const evalRoot = path.join(root, ".ues-evals")
  const entries = await readdir(evalRoot, { withFileTypes: true }).catch(() => [])
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name).sort().slice(-20)
  const rows = []
  for (const name of files) {
    const payload = await readJson(path.join(evalRoot, name), null)
    if (!payload) continue
    rows.push({ file: name, model: payload.model, suite: payload.suite, summary: payload.summary || {} })
  }
  return rows.reverse()
}

export async function collectControlCenterData(root = process.cwd()) {
  root = path.resolve(root)
  const [work, learning, evals, evidenceStore, memory, capabilityFabric] = await Promise.all([
    collectWork(root),
    readLearningState(root),
    collectEvalSummary(root),
    evidenceStoreStatus(root),
    memoryStatus(root),
    capabilityFabricStatus(root),
  ])
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    root,
    work,
    learning,
    evals,
    v11: {
      evidenceStore,
      runtime: "perception-adaptive-execution",
    },
    v14: {
      memory,
      capabilityFabric: {
        healthyCapabilities: capabilityFabric.healthyCapabilities,
        totalCapabilities: capabilityFabric.totalCapabilities,
        rows: capabilityFabric.rows,
        observationState: capabilityFabric.observationState,
      },
      runtime: "context-memory-capability-fabric",
    },
  }
}

export function renderControlCenter(data) {
  const payload = JSON.stringify(data).replaceAll("<", "\\u003c")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UES Control Center</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color-scheme:dark;background:#0b1020;color:#e7ecf5}
body{margin:0}.shell{max-width:1200px;margin:auto;padding:28px}.top{display:flex;justify-content:space-between;gap:20px;align-items:end}
h1{margin:0;font-size:30px}.muted{color:#9da9bd}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:20px}
.card{background:#121a2c;border:1px solid #26324a;border-radius:14px;padding:16px}.pill{display:inline-block;padding:3px 8px;border:1px solid #3b4966;border-radius:999px;font-size:12px}
.task{display:grid;grid-template-columns:1fr auto;gap:8px;border-top:1px solid #243049;padding:9px 0}.ok{color:#7ee787}.warn{color:#f2cc60}.bad{color:#ff7b72}
table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px;border-bottom:1px solid #26324a;font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;background:#0a0f1c;padding:10px;border-radius:10px}.section{margin-top:28px}
button{margin-top:10px;border:1px solid #3b4966;border-radius:8px;background:#18233a;color:#e7ecf5;padding:7px 10px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}
details{margin-top:10px;border-top:1px solid #243049;padding-top:8px}summary{cursor:pointer;color:#c9d4e7}
</style>
</head>
<body><div class="shell">
<div class="top"><div><h1>UES Control Center</h1><div class="muted" id="root"></div></div><div class="muted" id="generated"></div></div>
<div class="section"><h2>Long-horizon work</h2><div class="grid" id="work"></div></div>
<div class="section"><h2>Learning loop</h2><div class="grid" id="learning"></div></div>
<div class="section"><h2>V11 runtime efficiency</h2><div class="grid" id="v11"></div></div>
<div class="section"><h2>V14 context & memory fabric</h2><div class="grid" id="v14"></div></div>
<div class="section"><h2>Recent runtime events</h2><div class="card"><table><thead><tr><th>Work</th><th>Event</th><th>Task</th><th>Time</th></tr></thead><tbody id="events"></tbody></table></div></div>
<div class="section"><h2>Recent evaluations</h2><div class="card"><table><thead><tr><th>Suite</th><th>Model</th><th>Baseline</th><th>UES</th></tr></thead><tbody id="evals"></tbody></table></div></div>
</div>
<script>
let data=${payload};
const esc=(v)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function render(next){
 data=next;
 document.querySelector("#root").textContent=data.root;
 document.querySelector("#generated").textContent="Generated "+data.generatedAt;
 const work=document.querySelector("#work");
 work.innerHTML="";
 for(const item of data.work){
  const tasks=item.tasks.map(t=>'<div class="task"><span>'+esc(t.id)+' · '+esc(t.title||'')+'</span><span class="pill">'+esc(t.state.status||'pending')+'</span></div>').join('');
  const recover=(item.tasks||[]).some(t=>t.state?.status==="running")?'<button data-recover="'+esc(item.slug)+'">Recover stale</button>':'';
  const receipts=(item.receipts||[]).length
    ? '<details><summary>Inspect receipts ('+item.receipts.length+')</summary><pre>'+esc(JSON.stringify(item.receipts,null,2))+'</pre></details>'
    : '';
  work.insertAdjacentHTML("beforeend",'<div class="card"><div><span class="pill">'+esc(item.status)+'</span></div><h3>'+esc(item.slug)+'</h3><div class="muted">'+esc(item.goal)+'</div><p>'+esc(item.nextAction)+'</p>'+tasks+'<div class="muted">receipts: '+item.receipts.length+' · blockers: '+item.blockers.length+'</div>'+recover+receipts+'</div>');
 }
 if(!data.work.length) work.innerHTML='<div class="card muted">No .ues-work items found.</div>';
 const learning=document.querySelector("#learning");
 learning.innerHTML='<div class="card"><h3>Accepted lessons</h3><strong>'+data.learning.accepted.length+'</strong></div><div class="card"><h3>Proposals</h3><strong>'+data.learning.proposals.length+'</strong></div>';
 const v11=document.querySelector("#v11");
 const store=data.v11?.evidenceStore||{};
 v11.innerHTML='<div class="card"><h3>Evidence store</h3><strong>'+esc(store.entries||0)+'</strong><div class="muted">'+esc(store.bytes||0)+' bytes externalized</div></div><div class="card"><h3>Runtime</h3><strong>V11</strong><div class="muted">'+esc(data.v11?.runtime||'adaptive')+'</div></div>';
 const v14=document.querySelector("#v14");
 const memory=data.v14?.memory||{};
 v14.innerHTML='<div class="card"><h3>Verified memory</h3><strong>'+esc(memory.byStatus?.verified||0)+'</strong><div class="muted">'+esc(memory.entries||0)+' total entries</div></div><div class="card"><h3>Runtime</h3><strong>V14</strong><div class="muted">'+esc(data.v14?.runtime||'context-memory-fabric')+'</div></div>';
 const eventBody=document.querySelector("#events");
 eventBody.innerHTML="";
 for(const item of data.work){
  for(const event of (item.recentEvents||[]).slice(-10).reverse()){
   eventBody.insertAdjacentHTML("beforeend",'<tr><td>'+esc(item.slug)+'</td><td>'+esc(event.type)+'</td><td>'+esc(event.task||"—")+'</td><td>'+esc(event.at||"")+'</td></tr>');
  }
 }
 const tbody=document.querySelector("#evals");
 tbody.innerHTML="";
 for(const row of data.evals){
  const fmt=(x)=>x?((x.passed||0)+'/'+(x.total||0)):'—';
  tbody.insertAdjacentHTML("beforeend",'<tr><td>'+esc(row.suite)+'</td><td>'+esc(row.model)+'</td><td>'+fmt(row.summary.baseline)+'</td><td>'+fmt(row.summary.ues)+'</td></tr>');
 }
}
document.addEventListener("click",async(event)=>{
 const button=event.target.closest?.("[data-recover]");
 if(!button) return;
 button.disabled=true;
 try{
  const response=await fetch("/api/recover",{
   method:"POST",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({slug:button.dataset.recover})
  });
  if(!response.ok) throw new Error(await response.text());
  const refreshed=await fetch("/data.json",{cache:"no-store"});
  if(refreshed.ok) render(await refreshed.json());
 }catch(error){ alert(String(error?.message||error)); }
 finally{ button.disabled=false; }
});
render(data);
if(location.protocol==="http:" || location.protocol==="https:"){
 setInterval(async()=>{
  try{
   const response=await fetch("/data.json",{cache:"no-store"});
   if(response.ok) render(await response.json());
  }catch{}
 },3000);
}
</script></body></html>`
}

export async function writeControlCenter(root = process.cwd(), outputDir = null) {
  root = path.resolve(root)
  const dir = path.resolve(outputDir || path.join(root, ".ues-dashboard"))
  await mkdir(dir, { recursive: true })
  const data = await collectControlCenterData(root)
  const html = renderControlCenter(data)
  const file = path.join(dir, "index.html")
  await writeFile(file, html, "utf8")
  await writeFile(path.join(dir, "data.json"), JSON.stringify(data, null, 2) + "\n", "utf8")
  return { dir, file, data }
}
