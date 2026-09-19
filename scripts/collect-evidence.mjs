import { collectEvidence } from "../lib/repo-inspect.mjs"
console.log(JSON.stringify(await collectEvidence(process.argv[2] || process.cwd()), null, 2))
