import { SEARCH_MATCH_POLICY_ID, SEARCH_TYPES } from "./search-text.mjs";
import { createSearchWireContract } from "./search-wire-protocol.mjs";

export { createSearchWireContract } from "./search-wire-protocol.mjs";
export const searchWireContract = createSearchWireContract({ matchPolicyId: SEARCH_MATCH_POLICY_ID, types: SEARCH_TYPES });
