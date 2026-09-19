import assert from "node:assert/strict"
import path from "node:path"
import { pathToFileURL } from "node:url"

const workspace = process.env.UES_EVAL_WORKSPACE
const task = process.env.UES_EVAL_TASK
if (!workspace || !task) {
  console.error("UES_EVAL_WORKSPACE and UES_EVAL_TASK are required")
  process.exit(2)
}

const load = async (file) => import(pathToFileURL(path.join(workspace, "src", file)).href + `?eval=${Date.now()}-${Math.random()}`)
const throws = (fn, ErrorType) => assert.throws(fn, ErrorType)
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} ~= ${expected}`)

switch (task) {
  case "js-discount-regression": {
    const { calculateDiscount } = await load("discount.mjs")
    assert.equal(calculateDiscount(100, 20), 80)
    close(calculateDiscount(199.99, 15), 169.9915)
    assert.equal(calculateDiscount(42, 0), 42)
    assert.equal(calculateDiscount(42, 100), 0)
    for (const args of [[NaN, 10], [100, Infinity], ["100", 10]]) throws(() => calculateDiscount(...args), TypeError)
    for (const percent of [-1, 101]) throws(() => calculateDiscount(100, percent), RangeError)
    break
  }
  case "auth-resource-ownership": {
    const { canEditResource } = await load("authz.mjs")
    const own = { id: "u1", tenantId: "t1", role: "member" }
    const resource = { ownerId: "u1", tenantId: "t1" }
    assert.equal(canEditResource(own, resource), true)
    assert.equal(canEditResource({ ...own, id: "u2" }, resource), false)
    assert.equal(canEditResource({ ...own, tenantId: "t2" }, resource), false)
    assert.equal(canEditResource({ ...own, role: "admin", id: "x", tenantId: "x" }, resource), true)
    assert.equal(canEditResource({ ...own, role: "admin", suspended: true }, resource), false)
    assert.equal(canEditResource(null, resource), false)
    assert.equal(canEditResource(own, null), false)
    break
  }
  case "api-pagination-contract": {
    const { paginate } = await load("pagination.mjs")
    const items = Array.from({ length: 23 }, (_, i) => i + 1)
    assert.deepEqual(paginate(items, { page: 2, pageSize: 5 }), { items: [6,7,8,9,10], total: 23, page: 2, pageSize: 5, totalPages: 5 })
    assert.deepEqual(paginate(items, {}), { items: items.slice(0,10), total: 23, page: 1, pageSize: 10, totalPages: 3 })
    assert.deepEqual(paginate(items, { page: 99, pageSize: 10 }).items, [])
    throws(() => paginate("x", {}), TypeError)
    throws(() => paginate(items, { page: 0 }), RangeError)
    throws(() => paginate(items, { pageSize: 1.5 }), TypeError)
    break
  }
  case "inventory-reservation": {
    const { reserveStock } = await load("inventory.mjs")
    assert.equal(reserveStock(10, 3), 7)
    assert.equal(reserveStock(1, 1), 0)
    throws(() => reserveStock(2, 3), RangeError)
    throws(() => reserveStock(-1, 1), RangeError)
    throws(() => reserveStock(2, 0), RangeError)
    throws(() => reserveStock(2.5, 1), TypeError)
    throws(() => reserveStock("2", 1), TypeError)
    break
  }
  case "payment-idempotency": {
    const { applyPaymentEvent } = await load("payment.mjs")
    const order = { status: "pending", totalCents: 1500, currency: "USD", processedEvents: [] }
    const paid = applyPaymentEvent(order, { id: "evt1", status: "succeeded", amountCents: 1500, currency: "USD" })
    assert.equal(order.status, "pending")
    assert.deepEqual(order.processedEvents, [])
    assert.equal(paid.status, "paid")
    assert.deepEqual(paid.processedEvents, ["evt1"])
    const duplicate = applyPaymentEvent(paid, { id: "evt1", status: "succeeded", amountCents: 1500, currency: "USD" })
    assert.deepEqual(duplicate, paid)
    const failed = applyPaymentEvent(order, { id: "evt2", status: "failed", amountCents: 1500, currency: "USD" })
    assert.equal(failed.status, "pending")
    assert.deepEqual(failed.processedEvents, ["evt2"])
    throws(() => applyPaymentEvent(order, { id: "evt3", status: "succeeded", amountCents: 1499, currency: "USD" }), RangeError)
    throws(() => applyPaymentEvent(order, { id: "", status: "failed" }), TypeError)
    break
  }
  case "webhook-ordering": {
    const { advancePaymentState } = await load("webhook.mjs")
    const pending = { status: "pending", lastSequence: 1 }
    assert.deepEqual(advancePaymentState(pending, { status: "authorized", sequence: 2 }), { status: "authorized", lastSequence: 2 })
    assert.equal(advancePaymentState(pending, { status: "paid", sequence: 1 }), pending)
    const paid = advancePaymentState({ status: "authorized", lastSequence: 2 }, { status: "paid", sequence: 3 })
    assert.deepEqual(paid, { status: "paid", lastSequence: 3 })
    assert.deepEqual(advancePaymentState(paid, { status: "refunded", sequence: 4 }), { status: "refunded", lastSequence: 4 })
    throws(() => advancePaymentState(pending, { status: "refunded", sequence: 2 }), RangeError)
    break
  }
  case "secure-file-upload": {
    const { validateUpload } = await load("upload.mjs")
    const opts = { maxBytes: 1024, allowedTypes: ["image/png", "image/jpeg"] }
    assert.equal(validateUpload({ name: "photo.png", type: "image/png", size: 100 }, opts), true)
    throws(() => validateUpload({ name: "../x.png", type: "image/png", size: 100 }, opts), TypeError)
    throws(() => validateUpload({ name: "a/b.png", type: "image/png", size: 100 }, opts), TypeError)
    throws(() => validateUpload({ name: "x.exe", type: "application/octet-stream", size: 100 }, opts), TypeError)
    throws(() => validateUpload({ name: "x.png", type: "image/png", size: 2048 }, opts), RangeError)
    throws(() => validateUpload({ name: "x.png", type: "image/png", size: 1.2 }, opts), TypeError)
    break
  }
  case "path-traversal-defense": {
    const { safeJoin } = await load("path-safe.mjs")
    const root = path.resolve(workspace, "uploads")
    assert.equal(safeJoin(root, "user/file.txt"), path.resolve(root, "user/file.txt"))
    throws(() => safeJoin(root, "../secret.txt"), RangeError)
    throws(() => safeJoin(root, path.resolve(root, "..", "secret.txt")), RangeError)
    throws(() => safeJoin(root, "x\0y"), RangeError)
    throws(() => safeJoin(root, 42), TypeError)
    break
  }
  case "stable-api-errors": {
    const { toHttpError } = await load("api-errors.mjs")
    assert.deepEqual(toHttpError({ code: "NOT_FOUND", message: "Missing", stack: "secret" }), { status: 404, body: { error: { code: "NOT_FOUND", message: "Missing" } } })
    assert.equal(toHttpError({ code: "VALIDATION", message: "Bad" }).status, 400)
    assert.equal(toHttpError({ code: "FORBIDDEN", message: "No" }).status, 403)
    assert.equal(toHttpError({ code: "CONFLICT", message: "Dup" }).status, 409)
    assert.deepEqual(toHttpError(new Error("db secret")), { status: 500, body: { error: { code: "INTERNAL", message: "Internal server error" } } })
    break
  }
  case "http-retry-policy": {
    const { shouldRetry } = await load("retry.mjs")
    assert.equal(shouldRetry({ status: 429, attempt: 1, maxAttempts: 3 }), true)
    assert.equal(shouldRetry({ status: 503, attempt: 2, maxAttempts: 3 }), true)
    assert.equal(shouldRetry({ status: 500, attempt: 3, maxAttempts: 3 }), false)
    assert.equal(shouldRetry({ status: 400, attempt: 1, maxAttempts: 3 }), false)
    throws(() => shouldRetry({ status: 500, attempt: 0, maxAttempts: 3 }), RangeError)
    throws(() => shouldRetry({ status: "500", attempt: 1, maxAttempts: 3 }), TypeError)
    break
  }
  case "dedupe-stable-order": {
    const { dedupeById } = await load("dedupe.mjs")
    const input = [{id:1,v:"a"},{id:1,v:"b"},{id:"1",v:"c"},{id:2,v:"d"}]
    const out = dedupeById(input)
    assert.deepEqual(out, [{id:1,v:"a"},{id:"1",v:"c"},{id:2,v:"d"}])
    assert.equal(input.length, 4)
    throws(() => dedupeById([{id:null}]), TypeError)
    throws(() => dedupeById("x"), TypeError)
    break
  }
  case "legacy-user-migration": {
    const { migrateUsers } = await load("migration.mjs")
    const rows = [
      { id: 1, fullName: "  Ada   Lovelace  ", extra: true },
      { id: 2, fullName: "Prince" },
      { id: 3, fullName: "", x: 1 },
      { id: 4, fullName: "Ignored", firstName: "Existing", lastName: "Name" },
    ]
    const out = migrateUsers(rows)
    assert.deepEqual(out, [
      { id: 1, firstName: "Ada", lastName: "Lovelace", extra: true },
      { id: 2, firstName: "Prince", lastName: "" },
      { id: 3, firstName: "", lastName: "", x: 1 },
      { id: 4, firstName: "Existing", lastName: "Name" },
    ])
    assert.equal(rows[0].fullName.trim().startsWith("Ada"), true)
    break
  }
  case "money-integer-invariants": {
    const { orderTotal } = await load("money.mjs")
    assert.equal(orderTotal([{ unitPriceCents: 250, quantity: 2 }, { unitPriceCents: 100, quantity: 3, discountCents: 50 }]), 750)
    assert.equal(orderTotal([]), 0)
    throws(() => orderTotal([{ unitPriceCents: 100, quantity: 1, discountCents: 101 }]), RangeError)
    throws(() => orderTotal([{ unitPriceCents: 1.5, quantity: 1 }]), TypeError)
    throws(() => orderTotal([{ unitPriceCents: 100, quantity: 0 }]), RangeError)
    break
  }
  case "sql-sort-allowlist": {
    const { buildSort } = await load("query-sort.mjs")
    assert.equal(buildSort({ field: "createdAt", direction: "desc" }), "ORDER BY created_at DESC")
    assert.equal(buildSort({ field: "name", direction: "ASC" }), "ORDER BY name ASC")
    assert.equal(buildSort({ field: "price", direction: "asc" }), "ORDER BY price_cents ASC")
    throws(() => buildSort({ field: "name; DROP TABLE users", direction: "asc" }), RangeError)
    throws(() => buildSort({ field: "name", direction: "sideways" }), RangeError)
    throws(() => buildSort("name"), TypeError)
    break
  }
  case "react-stale-request": {
    const { reducer, initialState } = await load("react-state.mjs")
    const started = reducer(initialState, { type: "start", requestId: 2 })
    assert.deepEqual(started, { requestId: 2, loading: true, data: null, error: null })
    const stale = reducer(started, { type: "success", requestId: 1, data: "old" })
    assert.equal(stale, started)
    assert.deepEqual(reducer(started, { type: "success", requestId: 2, data: "new" }), { requestId: 2, loading: false, data: "new", error: null })
    assert.deepEqual(reducer(started, { type: "error", requestId: 2, error: "boom" }), { requestId: 2, loading: false, data: null, error: "boom" })
    break
  }
  case "react-native-keyboard-offset": {
    const { keyboardOffset } = await load("rn-platform.mjs")
    assert.equal(keyboardOffset("ios", 44, 56), 100)
    assert.equal(keyboardOffset("android", 24, 56), 56)
    throws(() => keyboardOffset("windows", 0, 0), RangeError)
    throws(() => keyboardOffset("ios", -1, 10), RangeError)
    throws(() => keyboardOffset("ios", "1", 10), TypeError)
    break
  }
  case "dependency-caret-range": {
    const { satisfiesCaret } = await load("dependency.mjs")
    assert.equal(satisfiesCaret("1.2.3", "^1.2.3"), true)
    assert.equal(satisfiesCaret("1.9.9", "^1.2.3"), true)
    assert.equal(satisfiesCaret("2.0.0", "^1.2.3"), false)
    assert.equal(satisfiesCaret("0.2.9", "^0.2.3"), true)
    assert.equal(satisfiesCaret("0.3.0", "^0.2.3"), false)
    assert.equal(satisfiesCaret("0.0.3", "^0.0.3"), true)
    assert.equal(satisfiesCaret("0.0.4", "^0.0.3"), false)
    assert.equal(satisfiesCaret("bad", "^1.2.3"), false)
    break
  }
  case "strict-env-boolean": {
    const { readBooleanEnv } = await load("config.mjs")
    for (const value of ["true"," TRUE ","1","yes","On"]) assert.equal(readBooleanEnv(value), true)
    for (const value of ["false"," FALSE ","0","no","off"]) assert.equal(readBooleanEnv(value, true), false)
    assert.equal(readBooleanEnv(undefined, true), true)
    assert.equal(readBooleanEnv("", false), false)
    assert.equal(readBooleanEnv(true), true)
    throws(() => readBooleanEnv("maybe"), TypeError)
    throws(() => readBooleanEnv(1), TypeError)
    break
  }
  case "cache-invalidation-tags": {
    const { tagsForProductMutation } = await load("cache-tags.mjs")
    assert.deepEqual(tagsForProductMutation({ id: "p1", categoryId: "c1", sellerId: "s1" }), ["products","product:p1","category:c1","seller:s1"])
    assert.deepEqual(tagsForProductMutation({ id: "p1", categoryId: "", sellerId: null }), ["products","product:p1"])
    throws(() => tagsForProductMutation({ id: "" }), TypeError)
    break
  }
  case "multi-file-contract-compatibility": {
    const { serializeUser } = await load("contract-producer.mjs")
    const { userLabel } = await load("contract-consumer.mjs")
    assert.deepEqual(serializeUser({ id: 1, name: "Legacy" }), { id: 1, name: "Legacy", displayName: "Legacy" })
    assert.deepEqual(serializeUser({ id: 2, name: "Legacy", displayName: "Preferred" }), { id: 2, name: "Legacy", displayName: "Preferred" })
    assert.equal(userLabel({ id: 3, name: "Legacy" }), "Legacy")
    assert.equal(userLabel({ id: 4, name: "Legacy", displayName: "Preferred" }), "Preferred")
    break
  }
  default:
    throw new Error("Unknown live eval task: " + task)
}

console.log("hidden grader passed:", task)
