import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

function moduleSource(packageIndex, moduleIndex) {
  const previous = moduleIndex > 0
    ? 'import { value as previous } from "./mod' + String(moduleIndex - 1).padStart(3, "0") + '.mjs"\n'
    : ""
  return previous + "export const value = " + (moduleIndex > 0 ? "previous + 1" : packageIndex * 1000) +
    "\nexport function compute(input) { return value + Number(input || 0) }\n"
}

export async function generateRepoScaleFixture(root, options = {}) {
  const packageCount = Math.max(2, Number(options.packageCount || 6))
  const modulesPerPackage = Math.max(5, Number(options.modulesPerPackage || 50))
  await mkdir(root, { recursive: true })
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "ues-repo-scale-fixture", private: true, type: "module", workspaces: ["packages/*", "apps/*"],
  }, null, 2) + "\n")

  let generatedModules = 0
  for (let p = 0; p < packageCount; p += 1) {
    const pkgRoot = path.join(root, "packages", "pkg-" + p)
    const src = path.join(pkgRoot, "src")
    await mkdir(src, { recursive: true })
    await writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({
      name: "@fixture/pkg-" + p, private: true, type: "module", exports: "./src/index.mjs",
    }, null, 2) + "\n")
    for (let m = 0; m < modulesPerPackage; m += 1) {
      await writeFile(path.join(src, "mod" + String(m).padStart(3, "0") + ".mjs"), moduleSource(p, m))
      generatedModules += 1
    }
    await writeFile(path.join(src, "index.mjs"),
      'export { value, compute } from "./mod' + String(modulesPerPackage - 1).padStart(3, "0") + '.mjs"\n')
  }

  const apiRoot = path.join(root, "apps", "api", "src")
  const webRoot = path.join(root, "apps", "web", "src")
  const contracts = path.join(root, "contracts")
  await mkdir(apiRoot, { recursive: true }); await mkdir(webRoot, { recursive: true }); await mkdir(contracts, { recursive: true })
  await writeFile(path.join(contracts, "public-api.json"), JSON.stringify({ version: 1, fields: ["id", "name", "status"] }, null, 2) + "\n")
  await writeFile(path.join(apiRoot, "service.mjs"), 'export function serialize(row) { return { id: row.id, name: row.name, status: row.status } }\n')
  await writeFile(path.join(webRoot, "consumer.mjs"), 'export function render(item) { return item.name + ":" + item.status }\n')
  await writeFile(path.join(root, "AGENTS.md"), "# Fixture instructions\n\nPreserve public contracts and update focused tests.\n")
  return { root, packageCount, modulesPerPackage, generatedModules, totalPrimaryFiles: generatedModules + packageCount + 5 }
}
