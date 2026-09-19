import { repoMap } from "../lib/repo-inspect.mjs"
console.log(JSON.stringify(await repoMap(process.argv[2] || process.cwd()), null, 2))
