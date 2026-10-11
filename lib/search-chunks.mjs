export const SEARCH_CHUNKER = "unicode-source-slices-256-overlap24-v1";

function safeEnd(text, end) {
    return end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
}
function boundary(text, start, end) {
    if (end === text.length) return end;
    const portion = text.slice(start, end), matches = [...portion.matchAll(/(?:[.!?。！？]\s+|\n+|\s+)/gu)];
    const last = matches.at(-1);
    return last && last.index > portion.length / 2 ? start + last.index + last[0].length : end;
}
export function chunkSearchText(text, tokenizer, maxTokens = 256) {
    if (typeof text !== "string") throw new TypeError("Search text must be a string.");
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let end = boundary(text, start, safeEnd(text, Math.min(text.length, start + 2048)));
        let encoded = tokenizer.encode(text.slice(start, end), { return_token_type_ids: true });
        while (encoded.ids.length > maxTokens) {
            end = boundary(text, start, safeEnd(text, start + Math.max(1, Math.floor((end - start) * 0.75))));
            if (end <= start) throw new RangeError("Search chunk cannot fit the encoder.");
            encoded = tokenizer.encode(text.slice(start, end), { return_token_type_ids: true });
        }
        chunks.push({ start, end, encoded });
        if (end === text.length) break;
        let overlap = end;
        // Original offsets, not decoded tokens: normalization must never rewrite excerpts.
        for (const match of text.slice(Math.max(start + 1, end - 240), end).matchAll(/\s+/gu)) {
            const candidate = Math.max(start + 1, end - 240) + match.index + match[0].length;
            if (candidate < end && tokenizer.encode(text.slice(candidate, end)).ids.length <= 26) {
                overlap = candidate;
                break;
            }
        }
        start = overlap;
    }
    return chunks;
}

export function permittedSearchText(entry) {
    return [entry.title, entry.content, entry.source.label].filter(text => text.length > 0).join("\n");
}
