import { impactMap } from "../lib/repo-inspect.mjs"
const query = process.argv[2]
if (!query) { console.error("Usage: node scripts/impact-map.mjs <query> [dir]"); process.exit(2) }
console.log(JSON.stringify(await impactMap(process.argv[3] || process.cwd(), query), null, 2))
