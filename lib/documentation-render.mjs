import { Marked, Parser } from "marked";
import path from "node:path";

// Guides are the repository's own Markdown: the root project documents and the files directly in docs/.
export const isGuideFile = file => /^(?:README|CONTRIBUTING|SECURITY)\.md$/.test(file) || /^docs\/[A-Za-z0-9._-]+\.md$/.test(file);
export const isImageFile = file => /\.(?:png|jpe?g|gif|webp|svg)$/i.test(file);
// Images a guide can show come only from these folders, so a page cannot pull arbitrary files into WIRE.
export const isDocumentationAsset = file => isImageFile(file) && /^(?:docs|assets)\/[A-Za-z0-9._/-]+$/.test(file)
    && !file.split("/").some(part => part === "" || part === "." || part === "..");
export const guideSlug = file => file === "docs/README.md" ? "" : file === "README.md" ? "readme" : path.posix.basename(file, ".md").toLowerCase();

// GitHub emoji shortcodes, as code points so authored sources stay free of literal glyphs.
const shortcodes = Object.fromEntries(Object.entries({ warning: [0x26a0, 0xfe0f], bulb: [0x1f4a1], white_check_mark: [0x2705], x: [0x274c],
    rocket: [0x1f680], tada: [0x1f389], memo: [0x1f4dd], information_source: [0x2139, 0xfe0f], lock: [0x1f512], mag: [0x1f50d],
    heavy_check_mark: [0x2714, 0xfe0f], construction: [0x1f6a7], point_right: [0x1f449], sparkles: [0x2728] })
    .map(([name, points]) => [name, String.fromCodePoint(...points)]));
const escapeHtml = value => value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const decodeEntities = value => value.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|#39));/gi, (match, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
        : { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }[name.toLowerCase()] ?? match);
// The heading slug GitHub assigns (github-slugger): lowercase, drop punctuation, spaces become hyphens.
export const githubSlug = text => text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");

/** Renders one guide the way GitHub does for the constructs WIRE's documentation uses. The browser still sanitizes the result. */
export function renderGuide(source) {
    const counts = new Map(), headings = [], anchors = new Set();
    const notes = new Map(), order = [], uses = new Map();
    let title = null;
    const marked = new Marked({ gfm: true, breaks: false });
    marked.use({
        extensions: [{
            name: "footnoteDef", level: "block",
            start: src => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
            tokenizer(src) {
                const m = /^\[\^([^\]\s]+)\]:[ \t]*([^\n]*(?:\n(?:[ ]{2,}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
                if (!m) return undefined;
                if (!notes.has(m[1])) notes.set(m[1], this.lexer.inlineTokens(m[2].replace(/\n[ \t]+/g, " ")));
                return { type: "footnoteDef", raw: m[0] };
            },
            renderer: () => "",
        }, {
            name: "footnoteRef", level: "inline",
            start: src => src.indexOf("[^"),
            tokenizer(src) {
                const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
                return m ? { type: "footnoteRef", raw: m[0], label: m[1] } : undefined;
            },
            renderer({ label, raw }) {
                if (!notes.has(label)) return escapeHtml(raw);
                if (!order.includes(label)) order.push(label);
                const n = order.indexOf(label) + 1, id = githubSlug(label), use = (uses.get(label) ?? 0) + 1;
                uses.set(label, use);
                return `<sup><a href="#fn-${id}" id="fnref-${id}${use > 1 ? `-${use}` : ""}" class="doc-footnote-ref">${n}</a></sup>`;
            },
        }],
        walkTokens(token) {
            if (token.type === "text" && !token.tokens) token.text = token.text.replace(/:([a-z_]+):/g, (m, k) => shortcodes[k] ?? m);
        },
        renderer: {
            heading({ tokens, depth }) {
                const inner = this.parser.parseInline(tokens);
                const plain = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
                const base = githubSlug(plain), n = counts.get(base) ?? 0;
                counts.set(base, n + 1);
                const id = n ? `${base}-${n}` : base;
                anchors.add(id);
                if (depth === 1) title ??= plain;
                else headings.push({ depth, id, text: plain });
                return `<h${depth} id="${id}">${inner}${depth > 1 ? `<a class="doc-permalink" href="#${id}" aria-label="Link to ${escapeHtml(plain)}"></a>` : ""}</h${depth}>\n`;
            },
            code({ text, lang }) {
                const language = (lang ?? "").split(/\s/)[0].replace(/[^\w-]/g, "");
                // GitHub draws these fences. WIRE shows the exact source and says so rather than drawing a guess.
                const drawn = { mermaid: "diagram", math: "formula", geojson: "map", topojson: "map", stl: "3D model" }[language];
                const label = drawn ? `<p class="doc-code-label">${escapeHtml(language)} source. GitHub shows this as a ${drawn}.</p>` : "";
                return `<div class="doc-code${drawn ? " doc-code-drawn" : ""}">${label}<pre><code${language ? ` class="language-${language}"` : ""}>${escapeHtml(text)}</code></pre></div>\n`;
            },
        },
    });
    let html = marked.parse(source.replace(/\r\n?/g, "\n"));
    if (order.length) {
        const items = order.map((label, index) => {
            const id = githubSlug(label), body = Parser.parseInline(notes.get(label), { gfm: true });
            const backs = Array.from({ length: uses.get(label) }, (_, i) => `<a href="#fnref-${id}${i ? `-${i + 1}` : ""}" class="doc-footnote-back" aria-label="Back to reference ${index + 1}${i ? `-${i + 1}` : ""}">↩${i ? `<sup>${i + 1}</sup>` : ""}</a>`).join(" ");
            anchors.add(`fn-${id}`);
            return `<li id="fn-${id}"><p>${body} ${backs}</p></li>`;
        }).join("");
        html += `<section class="doc-footnotes" aria-label="Footnotes"><ol>${items}</ol></section>\n`;
        for (const [label, count] of uses) for (let i = 0; i < count; i++) anchors.add(`fnref-${githubSlug(label)}${i ? `-${i + 1}` : ""}`);
    }
    // Explicit anchors kept for older links, such as <a id="read-the-overview"></a>.
    for (const m of source.matchAll(/<a\s[^>]*\b(?:id|name)\s*=\s*["']([A-Za-z0-9_-]+)["']/gi)) anchors.add(m[1]);
    return { html, headings, anchors, title };
}

/** Groups and orders guides from the maintained index (docs/README.md), then lists anything the index doesn't mention. */
export function guideCatalog(guideFiles, read) {
    const index = guideFiles.includes("docs/README.md") ? read("docs/README.md") : "";
    const groups = [], seen = new Set(), tasks = [];
    let current = null;
    for (const line of index.split(/\r?\n/)) {
        const heading = /^## (.+)$/.exec(line);
        if (heading) { current = { name: heading[1].trim(), files: [] }; groups.push(current); continue; }
        if (!current || !line.startsWith("|") || /^\|\s*:?-/.test(line)) continue;
        const cells = line.split("|").slice(1, -1).map(cell => cell.trim());
        const link = /\[([^\]]+)\]\(([^)#\s]+)(#[^)\s]*)?\)/.exec(cells.at(-1) ?? "");
        if (!link) continue;
        const file = path.posix.normalize(path.posix.join("docs", link[2]));
        if (!guideFiles.includes(file)) continue;
        if (current.name === "Guides") tasks.push({ task: cells[0].replace(/[*`]/g, ""), label: link[1], guide: guideSlug(file), fragment: link[3]?.slice(1) ?? "" });
        if (!seen.has(file)) { seen.add(file); current.files.push(file); }
    }
    const rest = guideFiles.filter(file => !seen.has(file) && file !== "docs/README.md").sort();
    const project = rest.filter(file => !file.startsWith("docs/")), other = rest.filter(file => file.startsWith("docs/"));
    if (other.length) groups.push({ name: "More references", files: other });
    groups.unshift({ name: "Start here", files: project.filter(file => file === "README.md") });
    groups.push({ name: "Project", files: project.filter(file => file !== "README.md") });
    return { groups: groups.filter(group => group.files.length), tasks };
}

export function guideSummary(source) {
    const body = source.replace(/\r/g, "").replace(/^# .*$/m, "");
    const paragraph = body.split(/\n\s*\n/).map(part => part.trim())
        .find(part => part && !/^[<#|!*[\-`>]/.test(part) && !/^\*\*Contents/.test(part)) ?? "";
    return paragraph.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`_]/g, "").replace(/\s+/g, " ").slice(0, 240);
}

function imageSize(bytes, file) {
    if (/\.png$/i.test(file) && bytes.length > 24 && bytes.readUInt32BE(12) === 0x49484452) return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
    if (/\.svg$/i.test(file)) {
        const box = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/.exec(bytes.toString("utf8", 0, Math.min(bytes.length, 4096)));
        if (box) return [Number(box[1]), Number(box[2])];
    }
    return null;
}

/**
 * Resolves every link and image address in rendered HTML against one revision's files.
 * The browser receives only these decisions, never the revision's file list.
 * @param {{ file: string, guides: Map<string, string>, anchors: Map<string, Set<string>>, exists: (file: string) => "file" | "folder" | null,
 *   read: (file: string) => Buffer | null, webUrl: (kind: "blob" | "tree", file: string, fragment: string) => string | null }} revision
 */
export function resolveTargets(html, revision) {
    const targets = {}, sizes = {};
    const resolveRepo = (file, fragment) => {
        const clean = file.replace(/\/+$/, "");
        if (revision.guides.has(clean)) {
            const guide = revision.guides.get(clean);
            return fragment && !/^gh-(?:dark|light)-mode-only$/.test(fragment) && !revision.anchors.get(clean)?.has(fragment)
                ? { kind: "missing", reason: `No section “${fragment}” in this guide`, guide } : { kind: "guide", guide, fragment };
        }
        const found = revision.exists(clean);
        if (found === "file" && isDocumentationAsset(clean)) {
            if (!Object.hasOwn(sizes, clean)) { const bytes = revision.read(clean); sizes[clean] = bytes ? imageSize(bytes, clean) : null; }
            return { kind: "asset", path: clean, size: sizes[clean] ?? null };
        }
        if (found) {
            const url = revision.webUrl(found === "folder" ? "tree" : "blob", clean, fragment);
            return url ? { kind: "repository", url, image: isImageFile(clean) } : { kind: "missing", reason: `${clean} is not available on GitHub from this checkout` };
        }
        return { kind: "missing", reason: `Not found in this revision: ${clean}` };
    };
    const resolveOne = raw => {
        const value = raw.trim();
        if (!value) return { kind: "missing", reason: "Empty link" };
        if (value.startsWith("#")) {
            let fragment = value.slice(1);
            try { fragment = decodeURIComponent(fragment); } catch { /* keep the literal fragment */ }
            return { kind: "fragment", fragment };
        }
        let absolute = null;
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
            try { absolute = new URL(value, "https://github.com/"); } catch { return { kind: "missing", reason: "Not a valid address" }; }
        }
        if (absolute) {
            if (absolute.protocol === "mailto:") return { kind: "external", url: absolute.href, host: "email" };
            if (!["http:", "https:"].includes(absolute.protocol)) return { kind: "unsafe" };
            const blob = /^\/likamrat\/wire\/(?:blob|tree|raw)\/[^/]+\/(.+)$/i.exec(absolute.pathname);
            const raw = /^\/likamrat\/wire\/[^/]+\/(.+)$/i.exec(absolute.pathname);
            try {
                if (absolute.hostname === "github.com" && blob) return resolveRepo(decodeURIComponent(blob[1]), decodeURIComponent(absolute.hash.slice(1)));
                if (absolute.hostname === "raw.githubusercontent.com" && raw) return resolveRepo(decodeURIComponent(raw[1]), "");
            } catch { return { kind: "missing", reason: "Not a valid address" }; }
            return { kind: "external", url: absolute.href, host: absolute.hostname };
        }
        // Relative and root-absolute paths resolve inside the repository, as they do on GitHub.
        const url = new URL(value, `https://repository.invalid/${revision.file}`);
        try {
            const file = decodeURIComponent(url.pathname.slice(1)), fragment = decodeURIComponent(url.hash.slice(1));
            return file === revision.file && fragment ? { kind: "fragment", fragment } : resolveRepo(file, fragment);
        } catch { return { kind: "missing", reason: "Not a valid address" }; }
    };
    for (const m of html.matchAll(/\s(href|src|srcset)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
        const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
        if (Object.hasOwn(targets, value)) continue;
        // A srcset can list several candidates; WIRE keeps only the first image.
        const address = m[1].toLowerCase() === "srcset" ? value.trim().split(/\s+/)[0] : value;
        targets[value] = resolveOne(address.replace(/\?raw=true(?=#|$)/, ""));
    }
    return targets;
}
