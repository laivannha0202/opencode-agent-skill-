import { createServer } from "node:http"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return fallback
  }
}

async function collectWorkItems(root) {
  const workRoot = path.join(root, ".ues-work")
  const entries = await readdir(workRoot, { withFileTypes: true }).catch(() => [])
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(workRoot, entry.name)
    const [state, plan, evidence, eventsText] = await Promise.all([
      readJson(path.join(dir, "STATE.json"), {}),
      readJson(path.join(dir, "PLAN.json"), {}),
      readJson(path.join(dir, "EVIDENCE.json"), {}),
      readFile(path.join(dir, "EVENTS.jsonl"), "utf8").catch(() => ""),
    ])
    const events = eventsText.split(/\r?\n/).filter(Boolean).slice(-50).map((line) => {
      try { return JSON.parse(line) } catch { return { type: "invalid-event", raw: line } }
    })
    items.push({
      slug: entry.name,
      status: state.status || "unknown",
      goal: state.goal || plan.goal || "",
      updatedAt: state.updatedAt || null,
      tasks: state.tasks || {},
      blockers: state.blockers || [],
      planApproval: state.planApproval || null,
      integrationVerification: state.integrationVerification || null,
      evidencePolicy: state.evidencePolicy || null,
      events,
      planTaskCount: Array.isArray(plan.tasks) ? plan.tasks.length : 0,
      evidenceCount: Array.isArray(evidence.entries) ? evidence.entries.length : 0,
    })
  }
  return items.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
}

async function collectEvals(root) {
  const dir = path.join(root, ".ues-evals")
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const rows = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const parsed = await readJson(path.join(dir, entry.name))
    if (!parsed) continue
    rows.push({
      file: entry.name,
      suite: parsed.suite,
      model: parsed.model,
      summary: parsed.summary,
      opencodeVersion: parsed.opencodeVersion || null,
    })
  }
  return rows.slice(-30).reverse()
}

export async function collectControlCenterState(root = process.cwd()) {
  root = path.resolve(root)
  const learning = await readJson(path.join(root, ".ues-learning", "PROPOSALS.json"), null)
  return {
    schemaVersion: 1,
    collectedAt: new Date().toISOString(),
    root,
    workItems: await collectWorkItems(root),
    evals: await collectEvals(root),
    learning,
  }
}

export function controlCenterHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UES Control Center</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#e8edf7;background:#0b1020}body{margin:0}header{padding:20px 28px;border-bottom:1px solid #24304a;position:sticky;top:0;background:#0b1020ee;backdrop-filter:blur(10px)}h1{margin:0;font-size:22px}small{color:#9fb0cc}.wrap{padding:24px;display:grid;gap:20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px}.card{background:#121a2f;border:1px solid #263451;border-radius:14px;padding:16px;box-shadow:0 8px 30px #0003}.row{display:flex;justify-content:space-between;gap:12px;align-items:center}.badge{padding:4px 8px;border-radius:999px;background:#233557;font-size:12px}.tasks{display:grid;gap:8px;margin-top:12px}.task{padding:9px 10px;background:#0f1729;border-radius:8px;font-size:13px}.muted{color:#8b9bb8}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#0d1425;padding:10px;border-radius:8px;max-height:220px;overflow:auto}button{background:#203457;color:#e8edf7;border:1px solid #38527f;border-radius:8px;padding:7px 10px}</style>
</head>
<body>
<header><div class="row"><div><h1>UES 7.7 Control Center</h1><small id="meta">loading...</small></div><button onclick="load()">Refresh</button></div></header>
<div class="wrap">
<section><h2>Work items</h2><div id="work" class="grid"></div></section>
<section><h2>Evaluation runs</h2><div id="evals" class="grid"></div></section>
<section><h2>Learning proposals</h2><div id="learning" class="grid"></div></section>
</div>
<script>
function esc(value){return String(value==null?"":value).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function card(html){return '<div class="card">'+html+'</div>'}
async function load(){
  var data=await fetch("/api/state",{cache:"no-store"}).then(function(r){return r.json()})
  document.getElementById("meta").textContent=data.root+" | "+data.collectedAt
  var work=data.workItems.map(function(w){
    var tasks=Object.entries(w.tasks).map(function(entry){
      var id=entry[0],t=entry[1]
      return '<div class="task row"><span>'+esc(id)+'</span><span>'+esc(t.status)+' | attempts '+esc(t.attempts)+'</span></div>'
    }).join("")
    return card('<div class="row"><b>'+esc(w.slug)+'</b><span class="badge">'+esc(w.status)+'</span></div><p class="muted">'+esc(w.goal)+'</p><div class="tasks">'+tasks+'</div><p>Evidence: '+w.evidenceCount+' | Events: '+w.events.length+'</p><pre>'+esc(JSON.stringify(w.events.slice(-8),null,2))+'</pre>')
  }).join("")
  document.getElementById("work").innerHTML=work||card('<span class="muted">No .ues-work items</span>')

  var evals=data.evals.map(function(e){
    return card('<b>'+esc(e.suite)+' | '+esc(e.model)+'</b><p class="muted">'+esc(e.file)+'</p><pre>'+esc(JSON.stringify(e.summary,null,2))+'</pre>')
  }).join("")
  document.getElementById("evals").innerHTML=evals||card('<span class="muted">No eval runs</span>')

  var proposals=(data.learning&&data.learning.proposals)||[]
  var learning=proposals.map(function(p){
    return card('<div class="row"><b>'+esc(p.signature)+'</b><span class="badge">'+esc(p.confidence)+'</span></div><p>'+esc(p.recommendation)+'</p><small>'+p.evidenceCount+' evidence samples | proposal only</small>')
  }).join("")
  document.getElementById("learning").innerHTML=learning||card('<span class="muted">No learning proposals</span>')
}
load();setInterval(load,2000)
</script>
</body></html>`
}

export async function startControlCenter(root = process.cwd(), options = {}) {
  root = path.resolve(root)
  const host = options.host || "127.0.0.1"
  const port = Number(options.port) || 4317
  const server = createServer(async (req, res) => {
    if (req.url === "/api/state") {
      const body = JSON.stringify(await collectControlCenterState(root))
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
      res.end(body)
      return
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(controlCenterHtml())
      return
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    res.end("Not found")
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, host, resolve)
  })
  return { server, host, port, url: "http://" + host + ":" + port + "/" }
}
