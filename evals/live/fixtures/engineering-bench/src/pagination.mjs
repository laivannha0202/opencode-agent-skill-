export function paginate(items, options = {}) {
  const page = options.page || 0
  const pageSize = options.pageSize || 10
  return { items: items.slice(page * pageSize, page * pageSize + pageSize) }
}
