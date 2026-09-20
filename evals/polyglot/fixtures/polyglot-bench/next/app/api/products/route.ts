export async function GET() {
  try {
    return Response.json({ products: [] }, { status: 200 })
  } catch (error: any) {
    return Response.json({ error: String(error), stack: error?.stack }, { status: 500 })
  }
}
