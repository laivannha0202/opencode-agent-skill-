import assert from "node:assert/strict"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const workspace = process.env.UES_EVAL_WORKSPACE
const task = process.env.UES_EVAL_TASK
if (!workspace || !task) {
  console.error("UES_EVAL_WORKSPACE and UES_EVAL_TASK are required")
  process.exit(2)
}

const load = async (file) =>
  import(pathToFileURL(path.join(workspace, "src", file)).href + "?eval=" + Date.now() + "-" + Math.random())

const throws = (fn, Type) => assert.throws(fn, Type)

switch (task) {
  case "long-checkout-integration": {
    const { calculateTotal } = await load("money.mjs")
    const { reserveAll } = await load("inventory.mjs")
    const { applyCharge } = await load("payment.mjs")
    const { checkout } = await load("checkout.mjs")

    const lines = [
      { sku: "a", unitPriceCents: 250, quantity: 2 },
      { sku: "a", unitPriceCents: 100, quantity: 1 },
      { sku: "b", unitPriceCents: 50, quantity: 3 },
    ]
    assert.equal(calculateTotal(lines), 750)
    throws(() => calculateTotal("x"), TypeError)
    throws(() => calculateTotal([{ sku: "a", unitPriceCents: 1.5, quantity: 1 }]), TypeError)
    throws(() => calculateTotal([{ sku: "a", unitPriceCents: -1, quantity: 1 }]), RangeError)
    throws(() => calculateTotal([{ sku: "a", unitPriceCents: 100, quantity: 0 }]), RangeError)

    const stock = { a: 5, b: 4 }
    const reserved = reserveAll(stock, lines)
    assert.deepEqual(reserved, { a: 2, b: 1 })
    assert.deepEqual(stock, { a: 5, b: 4 })
    throws(() => reserveAll(stock, [...lines, { sku: "b", unitPriceCents: 1, quantity: 3 }]), RangeError)
    assert.deepEqual(stock, { a: 5, b: 4 })
    throws(() => reserveAll(stock, [{ sku: "missing", unitPriceCents: 1, quantity: 1 }]), RangeError)

    const order = {
      id: "o1",
      status: "pending",
      totalCents: 750,
      currency: "USD",
      processedEvents: [],
      lines,
    }
    const paid = applyCharge(order, { id: "evt1", status: "succeeded", amountCents: 750, currency: "USD" })
    assert.equal(order.status, "pending")
    assert.deepEqual(order.processedEvents, [])
    assert.equal(paid.status, "paid")
    assert.deepEqual(paid.processedEvents, ["evt1"])
    assert.deepEqual(applyCharge(paid, { id: "evt1", status: "succeeded", amountCents: 750, currency: "USD" }), paid)
    throws(() => applyCharge(order, { id: "evt2", status: "succeeded", amountCents: 749, currency: "USD" }), RangeError)

    const result = checkout(order, stock, { id: "evt3", status: "succeeded", amountCents: 750, currency: "USD" })
    assert.equal(result.order.status, "paid")
    assert.deepEqual(result.stock, { a: 2, b: 1 })
    assert.deepEqual(stock, { a: 5, b: 4 })
    assert.equal(order.status, "pending")
    throws(() => checkout({ ...order, totalCents: 999 }, stock, { id: "evt4", status: "succeeded", amountCents: 750, currency: "USD" }), RangeError)
    break
  }

  case "long-tenant-security-integration": {
    const { canEditProject } = await load("auth.mjs")
    const { updateProject } = await load("project-service.mjs")
    const { handleProjectUpdate } = await load("project-api.mjs")

    const project = { id: "p1", tenantId: "t1", ownerId: "u1", title: "Old", description: "D" }
    const member = { id: "u1", tenantId: "t1", role: "member" }
    assert.equal(canEditProject(member, project), true)
    assert.equal(canEditProject({ ...member, tenantId: "t2" }, project), false)
    assert.equal(canEditProject({ ...member, id: "u2" }, project), false)
    assert.equal(canEditProject({ id: "a", tenantId: "t1", role: "admin" }, project), true)
    assert.equal(canEditProject({ id: "a", tenantId: "t2", role: "admin" }, project), false)
    assert.equal(canEditProject({ ...member, suspended: true }, project), false)

    const updated = updateProject(member, project, { title: "New" })
    assert.deepEqual(project, { id: "p1", tenantId: "t1", ownerId: "u1", title: "Old", description: "D" })
    assert.deepEqual(updated, { id: "p1", tenantId: "t1", ownerId: "u1", title: "New", description: "D" })

    assert.throws(
      () => updateProject({ ...member, tenantId: "t2" }, project, { title: "X" }),
      (error) => error && error.code === "FORBIDDEN",
    )

    const forbidden = handleProjectUpdate({
      user: { ...member, tenantId: "t2" },
      project,
      patch: { title: "X" },
    })
    assert.deepEqual(forbidden, { status: 403, body: { error: { code: "FORBIDDEN", message: "Forbidden" } } })

    const invalid = handleProjectUpdate({ user: member, project, patch: { tenantId: "evil" } })
    assert.deepEqual(invalid, { status: 400, body: { error: { code: "VALIDATION", message: "Invalid request" } } })

    const success = handleProjectUpdate({ user: member, project, patch: { description: "New D" } })
    assert.equal(success.status, 200)
    assert.equal(success.body.project.description, "New D")
    assert.equal(success.body.project.tenantId, "t1")
    break
  }

  case "long-user-contract-migration": {
    const { migrateUser } = await load("user-migration.mjs")
    const { serializeUser } = await load("user-serializer.mjs")
    const { validateSerializedUser } = await load("user-validation.mjs")
    const { userLabel } = await load("user-consumer.mjs")

    const legacy = { id: 1, fullName: "  Ada   Lovelace  ", name: "Legacy Ada", extra: true }
    const migrated = migrateUser(legacy)
    assert.deepEqual(legacy, { id: 1, fullName: "  Ada   Lovelace  ", name: "Legacy Ada", extra: true })
    assert.deepEqual(migrated, { id: 1, name: "Legacy Ada", extra: true, firstName: "Ada", lastName: "Lovelace" })

    const existing = migrateUser({ id: 2, fullName: "Ignore Me", firstName: "Existing", lastName: "Name", x: 1 })
    assert.deepEqual(existing, { id: 2, firstName: "Existing", lastName: "Name", x: 1 })

    const serialized = serializeUser(migrated)
    assert.deepEqual(serialized, { id: 1, name: "Legacy Ada", displayName: "Ada Lovelace" })
    assert.deepEqual(
      serializeUser({ id: 3, name: "Legacy", displayName: "Preferred", firstName: "A", lastName: "B" }),
      { id: 3, name: "Legacy", displayName: "Preferred" },
    )
    assert.deepEqual(serializeUser({ id: 4, name: "Only Legacy" }), { id: 4, name: "Only Legacy", displayName: "Only Legacy" })

    assert.equal(validateSerializedUser(serialized), true)
    assert.equal(validateSerializedUser({ id: 1, displayName: "" }), false)
    assert.equal(validateSerializedUser({ id: null, displayName: "X" }), false)
    assert.equal(validateSerializedUser({ id: 1, displayName: "X", name: "" }), false)

    assert.equal(userLabel({ id: 1, displayName: "Preferred", name: "Legacy" }), "Preferred")
    assert.equal(userLabel({ id: 1, name: "Legacy" }), "Legacy")
    break
  }

  case "long-product-race-cache": {
    const { initialProductState, productReducer } = await load("product-state.mjs")
    const { tagsForProduct } = await load("product-cache.mjs")
    const { updateProduct } = await load("product-service.mjs")
    const { handleProductUpdate } = await load("product-api.mjs")

    const started = productReducer(initialProductState, { type: "start", requestId: 2 })
    const stale = productReducer(started, { type: "success", requestId: 1, data: { id: "old" } })
    assert.equal(stale, started)
    assert.deepEqual(
      productReducer(started, { type: "success", requestId: 2, data: { id: "new" } }),
      { requestId: 2, loading: false, data: { id: "new" }, error: null },
    )
    const staleError = productReducer(started, { type: "error", requestId: 1, error: "old" })
    assert.equal(staleError, started)

    assert.deepEqual(
      tagsForProduct({ id: "p1", categoryId: "c1", sellerId: "s1" }),
      ["products", "product:p1", "category:c1", "seller:s1"],
    )
    assert.deepEqual(tagsForProduct({ id: "p1", categoryId: "", sellerId: null }), ["products", "product:p1"])
    throws(() => tagsForProduct({ id: "" }), TypeError)

    const product = { id: "p1", title: "Old", categoryId: "c1", sellerId: "s1", immutable: 7 }
    const result = updateProduct(product, { title: "New", categoryId: "c2" })
    assert.equal(product.title, "Old")
    assert.deepEqual(result.product, { id: "p1", title: "New", categoryId: "c2", sellerId: "s1", immutable: 7 })
    assert.deepEqual(result.tags, ["products", "product:p1", "category:c2", "seller:s1"])
    throws(() => updateProduct(product, { id: "evil" }), TypeError)

    const response = handleProductUpdate({ product, patch: { title: "API" } })
    assert.equal(response.status, 200)
    assert.equal(response.body.product.title, "API")
    assert.deepEqual(response.revalidate, ["products", "product:p1", "category:c1", "seller:s1"])

    const invalid = handleProductUpdate({ product, patch: { unknown: true } })
    assert.deepEqual(invalid, { status: 400, body: { error: { code: "VALIDATION", message: "Invalid request" } } })
    break
  }

  case "long-full-system-integration": {
    const graderFile = fileURLToPath(import.meta.url)
    const subtasks = [
      "long-checkout-integration",
      "long-tenant-security-integration",
      "long-user-contract-migration",
      "long-product-race-cache",
    ]
    for (const subtask of subtasks) {
      const run = spawnSync(process.execPath, [graderFile], {
        cwd: workspace,
        env: { ...process.env, UES_EVAL_WORKSPACE: workspace, UES_EVAL_TASK: subtask },
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      })
      assert.equal(
        run.status,
        0,
        subtask + " failed inside full-system grader:\n" + (run.stderr || run.stdout || ""),
      )
    }
    break
  }

  default:
    throw new Error("Unknown long-horizon task: " + task)
}

console.log("long-horizon hidden grader passed:", task)
