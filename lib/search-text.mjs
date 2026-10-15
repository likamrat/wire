import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";

export const SEARCH_TYPES = Object.freeze(["interaction", "context", "reply", "action", "tool", "service", "report", "comparison", "view", "setting"]);
export const SEARCH_TEXT_POLICY = Object.freeze({
    version: "literal-field-substring-v1",
    normalization: "NFKC then locale-independent lowercase and Greek sigma folding; trim query ends only",
    fields: Object.freeze(["title", "content", "source.label"]),
    ordering: "whole title, title substring, other fields; canonical ID ties",
    ranges: "original UTF-16 grapheme-aligned; end-exclusive; first matching field",
});
export const SEARCH_MATCH_POLICY_ID = createHash("sha256").update(JSON.stringify(SEARCH_TEXT_POLICY)).digest("hex");
export const normalizeSearchText = text => text.normalize("NFKC").toLowerCase().replace(/\u03c2/gu, "\u03c3");
const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
const fields = entry => [
    { field: "title", text: entry.title },
    { field: "content", text: entry.content },
    { field: "source", text: entry.source.label },
];

export function indexSearchText(entry) {
    return { id: entry.id, revision: entry.revision, type: entry.type,
        fields: fields(entry).map(value => ({ ...value, normalized: normalizeSearchText(value.text) })) };
}

function alignedRange(text, start, end) {
    const segments = graphemes.segment(text), first = segments.containing(start), last = segments.containing(end - 1);
    if (!first || !last) throw new TypeError("Text Search range is outside its original field.");
    return { start: first.index, end: last.index + last.segment.length };
}

async function originalRange(text, normalized, at, length, signal) {
    if (text.normalize("NFKC") === text && normalized.length === text.length) return alignedRange(text, at, at + length);
    // NFKD preserves decomposition lengths across canonical reordering. Its
    // graphemes also join compatibility characters before recomposition.
    function* sourceSpans() {
        let sourceAt = 0, decomposedEnd = 0;
        for (const character of text) {
            decomposedEnd += character.normalize("NFKD").length;
            yield { start: sourceAt, end: sourceAt + character.length, decomposedEnd };
            sourceAt += character.length;
        }
    }
    const spans = sourceSpans();
    let span = spans.next().value, normalizedAt = 0, start, end, steps = 0;
    for (const segment of graphemes.segment(text.normalize("NFKD"))) {
        if (++steps % 2048 === 0) { await setImmediate(); signal.throwIfAborted(); }
        while (span && span.decomposedEnd <= segment.index) span = spans.next().value;
        if (!span) throw new TypeError("Text Search decomposition has no original span.");
        const sourceStart = span.start;
        while (span.decomposedEnd < segment.index + segment.segment.length) {
            span = spans.next().value;
            if (!span) throw new TypeError("Text Search decomposition is incomplete.");
        }
        const next = normalizedAt + normalizeSearchText(segment.segment).length;
        if (next > at && normalizedAt < at + length) { start ??= sourceStart; end = span.end; }
        normalizedAt = next;
        if (normalizedAt >= at + length && start !== undefined) return alignedRange(text, start, end);
    }
    throw new TypeError("Text Search could not map its normalized match.");
}

function excerptRange(text, range, needle) {
    let radius = 96;
    while (true) {
        const slice = alignedRange(text, Math.max(0, range.start - radius), Math.min(text.length, range.end + radius));
        const excerpt = text.slice(slice.start, slice.end);
        const before = normalizeSearchText(excerpt.slice(0, range.start - slice.start)).length;
        const through = normalizeSearchText(excerpt.slice(0, range.end - slice.start)).length;
        // Contextual case conversion can differ on an isolated marked letter.
        if (normalizeSearchText(excerpt).slice(before, through).includes(needle)) return slice;
        if (slice.start === 0 && slice.end === text.length) throw new TypeError("Text Search match lost its original context.");
        radius *= 2;
    }
}

export async function rankTextSearch(items, query, types, signal) {
    const needle = normalizeSearchText(query.trim()), allowed = new Set(types), hits = [];
    if (!needle) return hits;
    for (const [index, item] of items.entries()) {
        if (index % 32 === 0) { await setImmediate(); signal.throwIfAborted(); }
        if (allowed.size && !allowed.has(item.type)) continue;
        for (const field of item.fields) {
            const at = field.normalized.indexOf(needle);
            if (at < 0) continue;
            const range = await originalRange(field.text, field.normalized, at, needle.length, signal);
            const excerpt = excerptRange(field.text, range, needle);
            hits.push({ id: item.id, revision: item.revision,
                tier: field.field === "title" ? field.normalized === needle ? 2 : 1 : 0,
                textMatch: { field: field.field, ...range, excerptStart: excerpt.start }, excerptEnd: excerpt.end });
            break;
        }
    }
    hits.sort((a, b) => b.tier - a.tier || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return hits;
}

export function textSearchHit(entry, selection) {
    const { textMatch, excerptEnd } = selection;
    const field = fields(entry).find(value => value.field === textMatch.field);
    if (!field || textMatch.start < textMatch.excerptStart || textMatch.end > excerptEnd || excerptEnd > field.text.length) {
        throw new TypeError("Text Search excerpt is outside its authorized field.");
    }
    return { ...entry, match: "text", textMatch, excerpt: field.text.slice(textMatch.excerptStart, excerptEnd) };
}
