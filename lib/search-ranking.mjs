import { setImmediate } from "node:timers/promises";
import { SearchError, SEARCH_MODEL_ID, searchHash } from "./search-model-assets.mjs";
import { SEARCH_INTENT_POLICY_ID } from "./search-linguistics-assets.mjs";
import { searchDenialEvidence } from "./search-intent.mjs";

export const SEARCH_RANKING = Object.freeze({ version: "exact-prefix-cosine-complete-denial-v4", semanticFloor: 0.5 });
export const SEARCH_MATCH_POLICY_ID = searchHash(JSON.stringify(SEARCH_RANKING));
const relatedPolicy = {
    version: "related-navigation-minilm-original-projection-v3", modelId: SEARCH_MODEL_ID, strictPolicy: SEARCH_RANKING,
    floor: 0.35, band: 0.02,
    selection: "related=remaining non-strict anchor/type-eligible scores>=floor and within band of strongest eligible score; no topN",
    purpose: "navigate-only", indexProjection: "unchanged title/content/source", noMembership: true,
};
export const SEARCH_RELATED = Object.freeze({ ...relatedPolicy, id: searchHash(JSON.stringify(relatedPolicy)) });
export const SEARCH_LEXICAL_POLICIES = Object.freeze({
    matchPolicyId: searchHash(JSON.stringify([SEARCH_RANKING, SEARCH_INTENT_POLICY_ID])),
    relatedPolicyId: searchHash(JSON.stringify({ ...relatedPolicy,
        version: "related-navigation-minilm-original-projection-v4", lexicalIntentPolicyId: SEARCH_INTENT_POLICY_ID,
        selection: "related=remaining non-strict anchor/type-eligible scores>=floor and within band of strongest eligible score; no topN; no lexical promotion from Related",
    })),
});
export const SEARCH_TYPES = Object.freeze(["interaction", "context", "reply", "action", "tool", "service", "report", "comparison", "view", "setting"]);
const normalize = text => text.normalize("NFKC").toLowerCase();
const words = text => normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [];
const anchors = (query, prefixes) => query.split(/\s+/u).filter(word => /[/_]|^\d{3}$/u.test(word)
    || /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/u.test(word)
    || prefixes.some(prefix => normalize(word).startsWith(prefix))).map(normalize);
function occurrence(text, needle, whole = false) {
    let at = text.indexOf(needle);
    while (at !== -1) {
        if ((at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]))
            && (!whole || at + needle.length === text.length || !/[\p{L}\p{N}]/u.test(text[at + needle.length]))) return at;
        at = text.indexOf(needle, at + 1);
    }
    return -1;
}
export function lexicalMatch(query, item, prefixes = []) {
    const text = normalize(item.text), title = normalize(item.title), needle = normalize(query.trim());
    const required = anchors(query, prefixes);
    if (required.some(anchor => occurrence(text, anchor, /^\d{3}$|^(?:get|post|put|patch|delete|head|options)$/u.test(anchor)) < 0)) {
        return { tier: 0, blocked: true };
    }
    if (title === needle) return { tier: 4, blocked: false };
    const at = occurrence(text, needle);
    if (at >= 0 && (at + needle.length === text.length || !/[\p{L}\p{N}]/u.test(text[at + needle.length]))) {
        return { tier: 3, blocked: false };
    }
    const queryWords = words(query), textWords = words(item.text);
    if (queryWords.length && queryWords.every(word => textWords.some(value => value === word))) return { tier: 2, blocked: false };
    if (queryWords.length && queryWords.every(word => textWords.some(value => value.startsWith(word)))) return { tier: 1, blocked: false };
    return { tier: 0, blocked: false };
}
export function hasSearchContradiction(query, item, prefixes = []) {
    if (!["interaction", "context", "reply"].includes(item.type) || anchors(query, prefixes).length) return false;
    if (item.completeness !== (item.type === "reply" ? "full-record" : "full")) return false;
    const content = item.content ?? (item.title ? null : item.text);
    if (content === null || content === undefined) return false;
    const metadata = [item.title, item.sourceLabel].filter(Boolean).join("\n");
    if (metadata && lexicalMatch(query, { title: item.title, text: metadata }).tier) return false;
    return searchDenialEvidence(query, content).state === "contradicted";
}
function cosine(a, b) {
    let result = 0;
    for (let i = 0; i < 384; i++) result += a[i] * b[i];
    return result;
}
async function rank(items, query, queryChunks, types, signal, discovery) {
    const hits = [], allowed = new Set(types);
    const candidates = [];
    let comparisons = 0, evaluatedItems = 0, strongest = -1;
    const prefixes = [...new Set(items.filter(item => item.type === "tool").flatMap(item =>
        normalize(item.title).match(/^[\p{L}\p{N}]+[-_]/u) ?? []))];
    for (let i = 0; i < items.length; i++) {
        if (i % 32 === 0) {
            await setImmediate();
            if (signal.aborted) throw new SearchError("query-cancelled");
        }
        const item = items[i];
        if (allowed.size && !allowed.has(item.type)) continue;
        const lexical = lexicalMatch(query, item, prefixes);
        if (lexical.blocked) continue;
        evaluatedItems++;
        let similarity = -1, best = null;
        for (const chunk of item.chunks) for (const needle of queryChunks) {
            if (++comparisons % 4096 === 0) {
                await setImmediate();
                if (signal.aborted) throw new SearchError("query-cancelled");
            }
            const value = cosine(chunk.vector, needle.vector);
            if (value > similarity) { similarity = value; best = chunk; }
        }
        strongest = Math.max(strongest, similarity);
        if (hasSearchContradiction(query, item, prefixes) || !lexical.tier && similarity < SEARCH_RANKING.semanticFloor) {
            if (discovery && best && similarity >= SEARCH_RELATED.floor) candidates.push({
                id: item.id, revision: item.revision, similarity, start: best.start, end: best.end, match: "related",
            });
            continue;
        }
        if (lexical.tier) {
            best = item.chunks.find(chunk => lexicalMatch(query, { title: "", text: item.text.slice(chunk.start, chunk.end) }).tier > 0) ?? best;
        }
        hits.push({ id: item.id, revision: item.revision, tier: lexical.tier, similarity,
            start: best?.start ?? 0, end: best?.end ?? item.text.length,
            match: lexical.tier >= 2 ? "exact" : lexical.tier ? "prefix" : "semantic" });
    }
    hits.sort((a, b) => b.tier - a.tier || b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.start - b.start));
    const related = candidates.filter(hit => hit.similarity >= strongest - SEARCH_RELATED.band);
    related.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.start - b.start));
    return { matches: hits, related, evaluatedItems };
}
export async function rankSearch(items, query, queryChunks, types, signal) {
    return (await rank(items, query, queryChunks, types, signal, false)).matches;
}
export function rankDiscovery(items, query, queryChunks, types, signal) {
    return rank(items, query, queryChunks, types, signal, true);
}
