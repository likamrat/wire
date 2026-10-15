import { SEARCH_MATCH_POLICY_ID, SEARCH_TYPES } from "./search-text.mjs";

// Serialized consumers receive this factory and explicit policy values, not Node imports.
export function createSearchWireContract({ matchPolicyId, types }) {
    const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (!hash(matchPolicyId) || !Array.isArray(types) || !types.length
        || types.some(type => typeof type !== "string" || !type) || new Set(types).size !== types.length) {
        throw new TypeError("Text Search policy identity and types are required.");
    }
    const schemaVersion = 3, allTypes = Object.freeze([...types].sort());
    const fields = (value, keys) => value !== null && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => value === b[i]);
    const canonicalTypes = values => values === undefined || Array.isArray(values)
        && values.every(value => allTypes.includes(value)) && new Set(values).size === values.length
        ? values?.length ? [...values].sort() : [...allTypes] : null;
    const queryPurpose = value => value === "navigation" || value === "analysis";
    const receiptKeys = ["schemaVersion", "panelId", "epoch", "requestId", "generation", "indexId", "mode",
        "revision", "queryPurpose", "queryTypes", "purpose", "matchPolicyId"];
    const fail = (code, message, status = 422) => {
        const error = new TypeError(message);
        error.code = code; error.status = status;
        throw error;
    };
    function version(value) {
        if (value?.schemaVersion !== schemaVersion) fail("search-protocol-changed",
            "Search now uses local text matching. Reload this panel; no old search receipt was reused.", 409);
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
            || !integer(value.requestId) || !effective) fail("invalid-search-input", "Search requires an explicit purpose and supported types.");
        return { query: value.query, requestId: value.requestId, purpose: value.purpose, types: effective };
    }
    function validReceipt(value) {
        return fields(value, receiptKeys) && value.schemaVersion === schemaVersion
            && typeof value.panelId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.panelId)
            && ["epoch", "requestId", "generation", "revision"].every(key => integer(value[key]))
            && hash(value.indexId) && value.mode === "text" && queryPurpose(value.queryPurpose)
            && value.purpose === "strict-match-population" && value.matchPolicyId === matchPolicyId
            && Array.isArray(value.queryTypes) && value.queryTypes.length > 0
            && sameList(value.queryTypes, canonicalTypes(value.queryTypes));
    }
    function receipt(value) {
        version(value);
        if (!validReceipt(value)) fail("invalid-search-receipt", "A current text-search receipt with its original purpose, policy and types is required.");
        return value;
    }
    const analysisReceipt = value => validReceipt(value) && value.queryPurpose === "analysis"
        && ["interaction", "context", "reply", "action"].every(type => value.queryTypes.includes(type));
    function completeCoverage(corpus, requestedTypes) {
        const requested = canonicalTypes(requestedTypes);
        if (!requested || !Array.isArray(requestedTypes) || !requestedTypes.length) return false;
        if (corpus?.state === "ready") return corpus.issues === undefined || Array.isArray(corpus.issues) && !corpus.issues.length;
        return corpus?.state === "partial" && Array.isArray(corpus.issues) && corpus.issues.length > 0
            && corpus.issues.every(issue => Array.isArray(issue?.types) && issue.types.length > 0
                && canonicalTypes(issue.types) !== null && !issue.types.some(type => requested.includes(type)));
    }
    const sameReceipt = (a, b) => validReceipt(a) && validReceipt(b)
        && receiptKeys.filter(key => key !== "queryTypes").every(key => a[key] === b[key]) && sameList(a.queryTypes, b.queryTypes);
    function validTextMatch(hit) {
        const match = hit.textMatch;
        if (!fields(match, ["field", "start", "end", "excerptStart"]) || !["title", "content", "source"].includes(match.field)
            || !["start", "end", "excerptStart"].every(key => integer(match[key]))
            || match.start < match.excerptStart || match.end <= match.start
            || match.end - match.excerptStart > hit.excerpt.length) return false;
        const original = match.field === "title" ? hit.title : match.field === "source" ? hit.source?.label : null;
        return match.field === "content" || typeof original === "string"
            && original.slice(match.excerptStart, match.excerptStart + hit.excerpt.length) === hit.excerpt;
    }
    function validResults(event) {
        if (!fields(event, ["schemaVersion", "panelId", "epoch", "event", "purpose", "requestId", "matches", "status"])
            || event.schemaVersion !== schemaVersion || event.event !== "results" || !queryPurpose(event.purpose)) return false;
        const match = event.matches, stamp = match?.receipt, status = event.status;
        if (!fields(match, ["receipt", "hits", "total"]) || !validReceipt(stamp) || stamp.queryPurpose !== event.purpose
            || stamp.panelId !== event.panelId || stamp.epoch !== event.epoch || stamp.requestId !== event.requestId
            || status?.mode !== "text" || status.indexId !== stamp.indexId
            || ["modelId", "model", "linguistics", "chunks", "related"].some(key => Object.hasOwn(status, key))
            || status.corpus?.generation !== stamp.generation || !["ready", "partial"].includes(status.corpus.state)
            || !Array.isArray(match.hits) || match.total !== match.hits.length) return false;
        const seen = new Set();
        for (const hit of match.hits) {
            if (!hit || typeof hit.id !== "string" || !hit.id || seen.has(hit.id) || !hash(hit.revision)
                || !stamp.queryTypes.includes(hit.type) || typeof hit.title !== "string" || typeof hit.source?.label !== "string"
                || typeof hit.excerpt !== "string" || hit.match !== "text" || Object.hasOwn(hit, "purpose")
                || !validTextMatch(hit)) return false;
            seen.add(hit.id);
        }
        return true;
    }
    return Object.freeze({ schemaVersion, allTypes, matchPolicyId, canonicalTypes,
        handshake, query, receipt, validReceipt, analysisReceipt, completeCoverage, sameReceipt, validResults });
}

export const searchWireContract = createSearchWireContract({ matchPolicyId: SEARCH_MATCH_POLICY_ID, types: SEARCH_TYPES });
