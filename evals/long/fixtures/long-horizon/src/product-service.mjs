import { tagsForProduct } from "./product-cache.mjs"

export function updateProduct(product, patch) {
  Object.assign(product, patch)
  return { product, tags: tagsForProduct(product) }
}
