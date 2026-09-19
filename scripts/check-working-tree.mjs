import { checkWorkingTree } from "../lib/repo-inspect.mjs"
console.log(JSON.stringify(await checkWorkingTree(process.argv[2] || process.cwd()), null, 2))
