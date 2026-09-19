import { updateProduct } from "./product-service.mjs"

export function handleProductUpdate(input) {
  try {
    const result = updateProduct(input.product, input.patch)
    return { status: 200, body: { product: result.product }, revalidate: result.tags }
  } catch (error) {
    return { status: 500, body: { error: { message: error.message, stack: error.stack } } }
  }
}
