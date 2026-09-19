import { detectStack } from "../lib/repo-inspect.mjs"
console.log(JSON.stringify(await detectStack(process.argv[2] || process.cwd()), null, 2))
