export const SKILL_PREFIX = "ues-"

const RESOURCE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MANAGED_SKILL_PATTERN = /^ues-[a-z0-9]+(?:-[a-z0-9]+)*$/
const MANAGED_MARKDOWN_PATTERN = /^ues-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/

function testPattern(pattern, value) {
  return typeof value === "string" && pattern.test(value)
}

export function validResourceID(value) {
  return testPattern(RESOURCE_ID_PATTERN, value)
}

export function validSkillID(value) {
  return testPattern(MANAGED_SKILL_PATTERN, value)
}

export function validManagedMarkdown(value) {
  return testPattern(MANAGED_MARKDOWN_PATTERN, value)
}