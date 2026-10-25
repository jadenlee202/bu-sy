// Session-only choice state. An edit invalidates the result before debounced evaluation.
// Both the options and chosen timeline retain the exact shared-engine objects.
import { recommend } from "./recommend.js";

export function createPlanSession(campus, histories) {
  let result = null;
  let selected = null;
  return {
    get result() { return result; },
    get selected() { return selected; },
    invalidate() { result = null; selected = null; },
    update(request) {
      selected = null;
      result = recommend(request, campus, histories);
      return result;
    },
    choose(id) {
      if (!result?.ok) return null;
      const option = [...result.options, ...result.more].find(o => o.place.place_id === id);
      selected = option?.status === "fit" ? { option, request: result.request } : null;
      return selected;
    },
  };
}
