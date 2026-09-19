import { detectTestCommands } from "../lib/repo-inspect.mjs"
console.log(JSON.stringify(await detectTestCommands(process.argv[2] || process.cwd()), null, 2))
