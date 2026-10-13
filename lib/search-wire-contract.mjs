import { SEARCH_MATCH_POLICY_ID, SEARCH_RELATED, SEARCH_LEXICAL_POLICIES, SEARCH_TYPES } from "./search-ranking.mjs";

// Serialized consumers receive this factory and explicit policy values, not Node imports.
export function createSearchWireContract({ matchPolicyId, relatedPolicyId, types, lexicalPolicies = null }) {
    const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (!hash(matchPolicyId) || !hash(relatedPolicyId) || !Array.isArray(types) || !types.length
        || types.some(type => typeof type !== "string" || !type) || new Set(types).size !== types.length) {
        throw new TypeError("Search wire policy identities and types are required.");
    }
    const allTypes = Object.freeze([...types].sort());
    const fields = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    if (lexicalPolicies !== null && (!fields(lexicalPolicies, ["matchPolicyId", "relatedPolicyId"])
        || !hash(lexicalPolicies.matchPolicyId) || !hash(lexicalPolicies.relatedPolicyId)
        || lexicalPolicies.matchPolicyId === matchPolicyId || lexicalPolicies.relatedPolicyId === relatedPolicyId)) {
        throw new TypeError("Explicit distinct lexical policy identities are required.");
    }
    lexicalPolicies = lexicalPolicies && Object.freeze({ ...lexicalPolicies });
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]);
    const canonicalTypes = values => values === undefined || Array.isArray(values)
        && values.every(value => allTypes.includes(value)) && new Set(values).size === values.length
        ? values?.length ? [...values].sort() : [...allTypes] : null;
    const queryPurpose = value => value === "navigation" || value === "analysis";
    const commonKeys = ["schemaVersion", "panelId", "epoch", "requestId", "generation", "indexId", "modelId", "mode",
        "revision", "queryPurpose", "queryTypes", "purpose"];
    const fail = (code, message, status = 422) => {
        const error = new TypeError(message);
        error.code = code; error.status = status;
        throw error;
    };
    function version(value) {
        if (value?.schemaVersion !== 2) fail("search-protocol-changed",
            "Search protocol changed. Reload this panel before searching or opening a result; no old receipt was reused.", 409);
    }
    function handshake(value) {
        version(value);
        if (!fields(value, ["schemaVersion"])) fail("invalid-search-input", "Invalid search connection request.");
    }
    function query(value) {
        version(value);
        const keys = ["schemaVersion", "purpose", "query", "requestId", ...(Object.hasOwn(value, "types") ? ["types"] : [])];
        const effective = canonicalTypes(value.types);
        if (!fields(value, keys) || !queryPurpose(value.purpose) || typeof value.query !== "string"
            || !integer(value.requestId) || !effective) fail("invalid-search-input", "Search requires an explicit navigation or analysis purpose and supported types.");
        return { query: value.query, requestId: value.requestId, purpose: value.purpose, types: effective };
    }
    function validReceipt(value) {
        const strict = value?.purpose === "strict-match-population", related = value?.purpose === "related-navigation";
        if ((!strict && !related) || !fields(value, [...commonKeys, strict ? "matchPolicyId" : "relatedPolicyId"])
            || value.schemaVersion !== 2 || typeof value.panelId !== "string"
            || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.panelId)
            || !["epoch", "requestId", "generation", "revision"].every(key => integer(value[key]))
            || !["indexId", "modelId"].every(key => hash(value[key]))
            || !["hybrid", "lexical-only"].includes(value.mode) || !queryPurpose(value.queryPurpose)
            || !Array.isArray(value.queryTypes) || !value.queryTypes.length
            || !sameList(value.queryTypes, canonicalTypes(value.queryTypes))) return false;
        return strict ? value.matchPolicyId === matchPolicyId || Boolean(lexicalPolicies && value.matchPolicyId === lexicalPolicies.matchPolicyId)
            : value.queryPurpose === "navigation" && value.mode === "hybrid"
                && (value.relatedPolicyId === relatedPolicyId || Boolean(lexicalPolicies && value.relatedPolicyId === lexicalPolicies.relatedPolicyId));
    }
    function receipt(value) {
        version(value);
        if (!validReceipt(value)) fail("invalid-search-receipt", "A current search receipt with its original purpose, policy and types is required.");
        return value;
    }
    const analysisReceipt = value => validReceipt(value) && value.purpose === "strict-match-population"
        && value.queryPurpose === "analysis"
        && ["interaction", "context", "reply", "action"].every(type => value.queryTypes.includes(type));
    function sameReceipt(a, b) {
        if (!validReceipt(a) || !validReceipt(b) || a.purpose !== b.purpose) return false;
        return commonKeys.filter(key => key !== "queryTypes").every(key => a[key] === b[key])
            && sameList(a.queryTypes, b.queryTypes)
            && (a.purpose === "strict-match-population" ? a.matchPolicyId === b.matchPolicyId : a.relatedPolicyId === b.relatedPolicyId);
    }
    function validResults(event) {
        const hasRelated = event?.purpose === "navigation" && event?.matches?.receipt?.mode === "hybrid";
        if (!fields(event, ["schemaVersion", "panelId", "epoch", "event", "purpose", "requestId", "matches", "status", ...(hasRelated ? ["related"] : [])])
            || event.schemaVersion !== 2 || event.event !== "results" || !queryPurpose(event.purpose)) return false;
        const match = event.matches, stamp = match?.receipt, status = event.status;
        if (!validReceipt(stamp) || stamp.purpose !== "strict-match-population" || stamp.queryPurpose !== event.purpose
            || stamp.panelId !== event.panelId || stamp.epoch !== event.epoch || stamp.requestId !== event.requestId
            || status?.mode !== stamp.mode || status.indexId !== stamp.indexId || status.modelId !== stamp.modelId
            || status.corpus?.generation !== stamp.generation || !["ready", "partial"].includes(status.corpus.state)) return false;
        const seen = new Set();
        function set(value, related) {
            if (!fields(value, ["receipt", "hits", "total", ...(related ? ["coverage"] : [])])
                || !validReceipt(value.receipt) || !Array.isArray(value.hits) || value.total !== value.hits.length) return false;
            const token = value.receipt;
            if (token.purpose !== (related ? "related-navigation" : "strict-match-population")
                || commonKeys.filter(key => key !== "purpose" && key !== "queryTypes").some(key => token[key] !== stamp[key])
                || !sameList(token.queryTypes, stamp.queryTypes)) return false;
            if (related && token.relatedPolicyId !== (stamp.matchPolicyId === matchPolicyId
                ? relatedPolicyId : lexicalPolicies?.relatedPolicyId)) return false;
            if (related && (!fields(value.coverage, ["evaluatedItems", "corpusState", "retrieval", "populationComplete"])
                || !integer(value.coverage.evaluatedItems) || value.coverage.corpusState !== status.corpus.state
                || value.coverage.retrieval !== "policy-selected-candidates" || value.coverage.populationComplete !== false)) return false;
            for (const hit of value.hits) {
                if (!hit || typeof hit.id !== "string" || !hit.id || seen.has(hit.id) || !hash(hit.revision)
                    || !stamp.queryTypes.includes(hit.type) || typeof hit.excerpt !== "string"
                    || (related ? hit.match !== "related" || hit.purpose !== "navigate-only"
                        : !["exact", "prefix", "semantic"].includes(hit.match) || Object.hasOwn(hit, "purpose"))) return false;
                seen.add(hit.id);
            }
            return true;
        }
        return set(match, false) && (!hasRelated || set(event.related, true));
    }
    return Object.freeze({ schemaVersion: 2, allTypes, matchPolicyId, relatedPolicyId, lexicalPolicies, canonicalTypes,
        handshake, query, receipt, validReceipt, analysisReceipt, sameReceipt, validResults });
}

export const searchWireContract = createSearchWireContract({
    matchPolicyId: SEARCH_MATCH_POLICY_ID, relatedPolicyId: SEARCH_RELATED.id, types: SEARCH_TYPES, lexicalPolicies: SEARCH_LEXICAL_POLICIES,
});
