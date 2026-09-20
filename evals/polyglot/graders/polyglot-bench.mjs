import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"

const root = process.env.UES_EVAL_WORKSPACE || process.cwd()
const task = process.env.UES_EVAL_TASK

const text = async (file) => readFile(path.join(root, file), "utf8")
const sha = (value) => createHash("sha256").update(value).digest("hex")
const noDangerousSql = (value) => assert.doesNotMatch(value, /\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b/i)

switch (task) {
  case "polyglot-python-tenant-auth": {
    const source = await text("python/tenant_auth.py")
    assert.match(source, /def\s+can_edit\s*\(/)
    assert.match(source, /suspended/i)
    assert.match(source, /tenant/i)
    assert.match(source, /owner_id/)
    assert.match(source, /user(?:\.|\[).*id|user\.id/)
    assert.match(source, /admin/i)
    assert.doesNotMatch(source, /return\s+True\s*$/m)
    break
  }
  case "polyglot-java-money-validation": {
    const source = await text("java/PriceService.java")
    assert.match(source, /long\s+totalCents\s*\(/)
    assert.match(source, /IllegalArgumentException/)
    assert.match(source, /unitPriceCents\s*\*\s*quantity/)
    assert.match(source, /discountCents/)
    assert.match(source, /discountCents\s*>\s*(?:gross|unitPriceCents\s*\*\s*quantity)/)
    assert.doesNotMatch(source, /\b(?:double|float)\b/)
    break
  }
  case "polyglot-dotnet-order-authorization": {
    const source = await text("dotnet/OrderService.cs")
    assert.match(source, /bool\s+CanUpdate\s*\(/)
    assert.match(source, /Suspended/)
    assert.match(source, /TenantId/)
    assert.match(source, /Admin/)
    assert.match(source, /OwnerId\s*==\s*user\.Id|order\.OwnerId\s*==\s*user\.Id/)
    assert.doesNotMatch(source, /return\s+true\s*;/i)
    break
  }
  case "polyglot-nextjs-api-errors": {
    const source = await text("next/app/api/products/route.ts")
    assert.match(source, /export\s+async\s+function\s+GET/)
    assert.match(source, /NOT_FOUND/)
    assert.match(source, /status\s*:\s*404/)
    assert.match(source, /INTERNAL/)
    assert.match(source, /status\s*:\s*500/)
    assert.doesNotMatch(source, /error\.stack|stack\s*:/)
    break
  }
  case "polyglot-react-native-keyboard": {
    const source = await text("react-native/keyboard.ts")
    assert.match(source, /platform\s*===\s*["']ios["']/)
    assert.match(source, /safeAreaTop\s*\+\s*headerHeight/)
    assert.match(source, /return\s+headerHeight/)
    assert.match(source, /Number\.isFinite/)
    assert.match(source, /android/)
    break
  }
  case "polyglot-safe-sql-migration": {
    const source = await text("db/migrations/20260920_add_order_key.sql")
    noDangerousSql(source)
    const add = source.search(/ADD\s+COLUMN\s+order_key/i)
    const backfill = source.search(/UPDATE\s+orders[\s\S]*order_key/i)
    const notNull = source.search(/order_key[\s\S]*SET\s+NOT\s+NULL/i)
    const unique = source.search(/CREATE\s+UNIQUE\s+INDEX/i)
    assert.ok(add >= 0 && backfill > add && notNull > backfill && unique > notNull)
    assert.match(source, /order_key\s*=\s*(?:CAST\s*\(\s*id|id\s*::|CONCAT\s*\([^)]*id)/i)
    break
  }
  case "polyglot-monorepo-workspace-boundary": {
    const rootPkg = JSON.parse(await text("monorepo/package.json"))
    const webPkg = JSON.parse(await text("monorepo/packages/web/package.json"))
    assert.ok(Array.isArray(rootPkg.workspaces))
    assert.ok(rootPkg.workspaces.includes("packages/*"))
    assert.equal(webPkg.dependencies?.["@demo/api"], "workspace:*")
    const lock = await text("monorepo/pnpm-lock.yaml")
    assert.equal(sha(lock), "f624bed824f43a0e1cc43183bda09d58c25042509fcf10f89f4f6a2e09ce55d5")
    break
  }
  case "polyglot-generated-contract-discipline": {
    const api = JSON.parse(await text("api/openapi.json"))
    const user = api.components?.schemas?.User
    assert.ok(user?.properties?.id)
    assert.ok(user?.properties?.name)
    assert.ok(user?.properties?.displayName)
    assert.ok(user.required?.includes("id"))
    assert.ok(user.required?.includes("displayName"))
    const generated = await text("api/generated/client.ts")
    assert.equal(sha(generated), "REPLACE_GENERATED_SHA")
    break
  }
  default:
    throw new Error("Unknown polyglot task: " + task)
}

console.log("polyglot grader PASS: " + task)
