#!/usr/bin/env node
import { learnRuntimeWaste } from "../lib/runtime-waste-learner.mjs"

const args = process.argv.slice(2)
const positional = args.filter((value, index) => !value.startsWith("--") && (index === 0 || !String(args[index - 1] || "").startsWith("--")))
const root = positional[0] || process.cwd()
const limitIndex = args.indexOf("--limit")
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1] || 30) : 30
const report = await learnRuntimeWaste(root, { limit })
console.log(JSON.stringify(report, null, 2))
