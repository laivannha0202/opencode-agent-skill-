export const initialState = { requestId: 0, loading: false, data: null, error: null }

export function reducer(state, action) {
  if (action.type === "start") return { ...state, loading: true, requestId: action.requestId }
  if (action.type === "success") return { ...state, loading: false, data: action.data }
  if (action.type === "error") return { ...state, loading: false, error: action.error }
  return state
}
