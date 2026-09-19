export function tagsForProduct(product) {
  return ["products", "product:" + product.id, "category:" + product.categoryId, "seller:" + product.sellerId]
}
