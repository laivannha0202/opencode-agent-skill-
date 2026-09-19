export const initialProductState = { requestId: null, loading: false, data: null, error: null }

export function productReducer(state = initialProductState, action) {
  if (action.type === "start") return { ...state, requestId: action.requestId, loading: true, error: null }
  if (action.type === "success") return { ...state, data: action.data, loading: false, error: null }
  if (action.type === "error") return { ...state, error: action.error, loading: false }
  return state
}
