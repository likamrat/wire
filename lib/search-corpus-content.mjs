import { createHash } from "node:crypto";
import { textFindings } from "./privacy.mjs";

export const corpusHash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const corpusId = (kind, identity) => `wire-search-v1:${kind}:${corpusHash(identity)}`;

const titleGraphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
export function retainedTextTitle(text, fallback) {
    const first = text.search(/\S/u);
    if (first < 0) return fallback;
    const start = titleGraphemes.segment(text).containing(first).index;
    let end = start, count = 0;
    for (const part of titleGraphemes.segment(text.slice(start))) {
        if (++count > 120) break;
        if (/\S/u.test(part.segment)) end = start + part.index + part.segment.length;
    }
    return text.slice(start, end);
}

// This is an additional derived-text projection, not permission to retain new fields.
export function corpusText(value) {
    if (typeof value !== "string") throw new TypeError("Corpus text must be a string.");
    const ranges = textFindings(value).filter(item => item.mandatory
        || ["local_paths", "opaque_identifiers", "private_urls"].includes(item.category));
    // The assessment contract's opaque reference format is shorter than the general scanner's long-token rule.
    for (const match of value.matchAll(/\b[a-z]+-[a-f0-9]{32}\b/g)) ranges.push({ start: match.index, end: match.index + match[0].length });
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    let end = 0, text = "";
    for (const range of ranges) {
        if (range.end <= end) continue;
        if (range.start >= end) text += value.slice(end, range.start) + "[private value removed]";
        end = range.end;
    }
    return (text + value.slice(end)).replace(/\u0000/g, "");
}

function entities(text) {
    const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
        if (entity[0] !== "#") return named[entity.toLowerCase()];
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        if (code < 1 || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff) throw new TypeError("Unsupported report character.");
        return String.fromCodePoint(code);
    });
}

const visibleTags = new Set("html body main article section header footer nav div span p h1 h2 h3 h4 h5 h6 table caption thead tbody tfoot tr th td ul ol li dl dt dd pre code strong em b i u s small sup sub a details summary blockquote br hr colgroup col".split(" "));
const voidTags = new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const rawTags = new Set(["script", "style", "textarea", "title"]);

function attributesOf(text) {
    const attributes = new Map();
    const pattern = /\s+([a-z_:][a-z0-9_.:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/iy;
    let position = 0;
    text = text.replace(/\/\s*$/, "");
    while (text.slice(position).trim()) {
        pattern.lastIndex = position;
        const match = pattern.exec(text);
        if (!match) throw new TypeError("Unsupported saved HTML attributes.");
        const name = match[1].toLowerCase();
        if (attributes.has(name)) throw new TypeError("Duplicate saved HTML attribute.");
        attributes.set(name, entities(match[2] ?? match[3] ?? match[4] ?? ""));
        position = pattern.lastIndex;
    }
    return attributes;
}

// A conservative tokenizer, not a browser: no DOM, script, CSS, URL or resource evaluation.
export function reportDocumentFields(html) {
    if (typeof html !== "string") throw new TypeError("A saved HTML document is required.");
    const stack = [], output = [];
    let position = 0, body = false, sawBody = false, title = "", sawTitle = false;
    while (position < html.length) {
        const parent = stack.at(-1);
        if (parent && rawTags.has(parent.tag)) {
            const close = new RegExp(`</${parent.tag}\\s*>`, "ig");
            close.lastIndex = position;
            const match = close.exec(html);
            if (!match) throw new TypeError("Incomplete saved HTML.");
            if (parent.tag === "title" && stack.at(-2)?.tag === "head") {
                if (sawTitle) throw new TypeError("Multiple saved HTML titles.");
                sawTitle = true;
                title = corpusText(entities(html.slice(position, match.index)).replace(/\s+/gu, " ").trim());
            }
            stack.pop(); position = close.lastIndex; continue;
        }
        if (html.startsWith("<!--", position)) {
            const end = html.indexOf("-->", position + 4);
            if (end < 0) throw new TypeError("Incomplete saved HTML comment.");
            position = end + 3; continue;
        }
        if (html[position] !== "<") {
            const next = html.indexOf("<", position), end = next < 0 ? html.length : next;
            if (body && !parent?.excluded) output.push(entities(html.slice(position, end)));
            position = end; continue;
        }
        const token = /^<(?:!doctype\s+[^>]+|\/?[a-z][a-z0-9:-]*(?:\s+(?:[^"'<>]|"[^"]*"|'[^']*')*)?\s*\/?)>/i.exec(html.slice(position));
        if (!token) throw new TypeError("Unsupported saved HTML structure.");
        position += token[0].length;
        if (/^<!doctype/i.test(token[0])) continue;
        const tag = /^<\/?([a-z0-9:-]+)/i.exec(token[0])[1].toLowerCase();
        if (token[0].startsWith("</")) {
            if (stack.at(-1)?.tag !== tag) throw new TypeError("Unbalanced saved HTML.");
            stack.pop();
            if (tag === "body") body = false;
            if (body) output.push("\n");
            continue;
        }
        const attributes = attributesOf(token[0].slice(tag.length + 1, -1));
        const hidden = attributes.has("hidden") || attributes.get("aria-hidden")?.toLowerCase() === "true"
            || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attributes.get("style") ?? "");
        const excluded = Boolean(parent?.excluded || !visibleTags.has(tag) || hidden);
        const foreign = parent?.foreign || ["svg", "math"].includes(tag);
        if (tag === "body") {
            if (sawBody) throw new TypeError("Multiple saved HTML bodies.");
            body = true; sawBody = true;
        }
        if (!voidTags.has(tag)) {
            if (/\/>$/.test(token[0]) && !foreign) throw new TypeError("Unsupported self-closing saved HTML.");
            if (!/\/>$/.test(token[0])) stack.push({ tag, excluded, foreign });
        }
        if (body && !excluded) output.push("\n");
    }
    if (stack.length || !sawBody) throw new TypeError("Incomplete saved HTML document.");
    return { title, content: corpusText(output.join("").replace(/[ \t\r\f]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim()) };
}

export const reportDocumentText = html => reportDocumentFields(html).content;

// Only the existing frozen comparison display fields; never sourceFacts, IDs or provenance handles.
const comparisonFields = new Set([
    "status", "reason", "metric", "basis", "unit", "boundary", "definitionId", "definitionVersion",
    "value", "numerator", "denominator", "coverage", "covered", "eligible", "counts", "pass", "fail",
    "unassessed", "evaluatorError", "baseline", "later", "delta", "absolute", "percentagePoints",
    "metrics", "toolComparison", "layerComparisons", "tool-call", "returned-api-entry", "owned-http",
    "graph-request-site", "graph-code-reference", "patternDisplays", "tool", "workload", "attribution",
    "targetShape", "endpoints", "pathTemplate", "method", "apiVersion", "queryKeys", "available",
    "scopeDifferences", "narrative", "heading", "detail", "note", "primaryEvidence", "scoreLabel",
    "unitLabel", "successVerb", "raw", "matched", "mixChanged", "patternCount", "count", "success",
    "failure", "partial", "unknown", "other", "transport", "successShare", "baselineCount", "laterCount",
]);
export function comparisonDocumentText(comparison) {
    const output = [];
    function visit(value, label = "") {
        if (value === null || value === undefined) return;
        if (["string", "number", "boolean"].includes(typeof value)) {
            output.push(`${label ? label + ": " : ""}${String(value)}`); return;
        }
        if (Array.isArray(value)) { for (const item of value) visit(item, label); return; }
        for (const [key, child] of Object.entries(value)) if (comparisonFields.has(key)) visit(child, key);
    }
    visit(comparison);
    return corpusText(output.join("\n"));
}

export function freezeCorpus(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) freezeCorpus(child);
        Object.freeze(value);
    }
    return value;
}
