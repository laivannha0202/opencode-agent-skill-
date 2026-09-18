import { describe, expect, test } from "bun:test"
import { parseMarkdown } from "../src/assets.ts"

describe("parseMarkdown", () => {
  test("parses frontmatter and body", () => {
    const parsed = parseMarkdown(`---
name: repo-explorer
description: Inspect a repository
---

# Body
Read files first.
`)

    expect(parsed.meta.name).toBe("repo-explorer")
    expect(parsed.meta.description).toBe("Inspect a repository")
    expect(parsed.body).toContain("Read files first.")
  })

  test("accepts markdown without frontmatter", () => {
    const parsed = parseMarkdown("# Plain")
    expect(parsed.meta).toEqual({})
    expect(parsed.body).toBe("# Plain")
  })
})
