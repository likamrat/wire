// Display-only Markdown for message prose written by Copilot or another harness.
// Nodes are built from parser tokens, never from an HTML string: raw HTML stays literal,
// images are not loaded and only http(s)/mailto links navigate. Callers keep the original
// string for Copy, Search and reports. Serialized into the shell; keep this self-contained.
export function createMessageMarkdown(load = () => import("/assets/marked.mjs")) {
    let parser = null;
    const pending = new Map();
    const entities = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" };
    const decode = text => text.replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/giu, (match, decimal, hex, name) => {
        if (name) return entities[name.toLowerCase()];
        const code = decimal ? Number(decimal) : parseInt(hex, 16);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
    });
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    function destination(href) {
        try {
            const url = new URL(href);
            return ["http:", "https:", "mailto:"].includes(url.protocol) ? url : null;
        } catch { return null; }
    }
    // A bare address names its host and keeps the full destination available on hover.
    function bareLabel(url, label) {
        if (url.protocol === "mailto:") return url.pathname;
        if (label.length <= 48) return label;
        const host = url.host.replace(/^www\./u, ""), path = url.pathname.replace(/\/+$/u, "");
        return host + (path || url.search || url.hash ? "/\u2026" : "");
    }
    function inline(parent, tokens = []) {
        for (const token of tokens) {
            if (token.type === "text") parent.append(token.tokens ? inline(document.createDocumentFragment(), token.tokens) : decode(token.text));
            else if (token.type === "escape") parent.append(token.text);
            else if (["strong", "em", "del"].includes(token.type)) parent.append(inline(node(token.type), token.tokens));
            else if (token.type === "codespan") parent.append(node("code", token.text));
            else if (token.type === "br" || token.type === "html" && /^<br\s*\/?>$/iu.test(token.text.trim())) parent.append(node("br"));
            else if (token.type === "link") {
                const url = destination(token.href);
                const label = inline(document.createDocumentFragment(), token.tokens);
                if (!url) { parent.append(label); continue; }
                const link = node("a", undefined, "message-markdown-link");
                link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.referrerPolicy = "no-referrer";
                const text = label.textContent;
                if (token.autolink || text === token.href || text === url.href) {
                    const shown = bareLabel(url, text);
                    link.textContent = shown;
                    if (shown !== text) link.title = url.href;
                } else link.append(label);
                parent.append(link);
            } else if (token.type === "image") parent.append(node("span", token.text ? "Image: " + decode(token.text) : "Image not shown", "message-markdown-image"));
            else parent.append(token.raw ?? token.text ?? "");
        }
        return parent;
    }
    function blocks(parent, tokens, level) {
        for (const token of tokens) {
            if (token.type === "space" || token.type === "def" || token.type === "checkbox") continue;
            if (token.type === "paragraph") parent.append(inline(node("p"), token.tokens));
            else if (token.type === "text") parent.append(token.tokens ? inline(document.createDocumentFragment(), token.tokens) : decode(token.text));
            else if (token.type === "heading") parent.append(inline(node("h" + Math.min(6, level + token.depth - 1), undefined, "message-markdown-heading"), token.tokens));
            else if (token.type === "hr") parent.append(node("hr"));
            else if (token.type === "blockquote") parent.append(blocks(node("blockquote"), token.tokens, level));
            else if (token.type === "code") {
                const code = node("pre", undefined, "message-markdown-code");
                code.tabIndex = 0;
                code.setAttribute("aria-label", token.lang ? "Code: " + token.lang.split(/\s/u)[0] : "Code");
                code.append(node("code", token.text));
                parent.append(code);
            } else if (token.type === "list") {
                const list = node(token.ordered ? "ol" : "ul");
                if (token.ordered && Number.isSafeInteger(token.start) && token.start !== 1) list.start = token.start;
                for (const item of token.items) {
                    const entry = node("li");
                    if (item.task) {
                        const mark = node("span", undefined, "message-markdown-check");
                        mark.dataset.checked = String(Boolean(item.checked));
                        mark.setAttribute("role", "img");
                        mark.setAttribute("aria-label", item.checked ? "Done" : "Not done");
                        entry.className = "message-markdown-task";
                        entry.append(mark);
                    }
                    list.append(blocks(entry, item.tokens, level));
                }
                parent.append(list);
            } else if (token.type === "table") {
                const scroll = node("div", undefined, "message-markdown-table"), table = node("table");
                scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "Table");
                const cell = (tag, value, index) => {
                    const element = inline(node(tag), value.tokens);
                    if (tag === "th") element.scope = "col";
                    if (["left", "right", "center"].includes(token.align[index])) element.style.textAlign = token.align[index];
                    return element;
                };
                const head = node("thead"), heading = node("tr"), body = node("tbody");
                token.header.forEach((value, index) => heading.append(cell("th", value, index)));
                head.append(heading);
                for (const row of token.rows) {
                    const line = node("tr");
                    row.forEach((value, index) => line.append(cell("td", value, index)));
                    body.append(line);
                }
                table.append(head, ...(token.rows.length ? [body] : []));
                scroll.append(table);
                parent.append(scroll);
            } else parent.append(node("p", token.raw ?? token.text ?? "", "message-markdown-literal"));
        }
        return parent;
    }
    // Text without Markdown structure keeps its exact spacing and line breaks. A bare address or
    // raw HTML (painted literally either way) is not structure.
    const plainOnly = tokens => tokens.every(token => token.type === "space" || token.type === "html"
        || token.type === "paragraph" && token.tokens.every(part => part.type === "br" || part.type === "text" && !part.tokens
            || part.type === "html" && !/^<br\s*\/?>$/iu.test(part.text.trim()) || part.type === "link" && part.autolink && part.raw === part.text));
    function summary(tokens) {
        const parts = [];
        for (const token of tokens) {
            if (token.type === "table") parts.push(token.header.map(cell => summary(cell.tokens)).join(" \u00b7 "));
            else if (token.type === "list") parts.push(token.items.map(item => summary(item.tokens)).join(" "));
            else if (token.type === "image") parts.push(token.text);
            else if (["space", "def", "checkbox", "hr"].includes(token.type)) continue;
            else if (token.type === "br") parts.push(" ");
            else if (token.tokens) parts.push(summary(token.tokens));
            else if (token.type === "text") parts.push(decode(token.text));
            else parts.push(token.text ?? token.raw ?? "");
        }
        return parts.join(" ");
    }
    function lex(text) {
        try {
            return parser.lexer(text, { ...(parser.getDefaults?.() ?? parser.defaults), gfm: true, breaks: true, async: false });
        } catch (error) {
            console.error("Message formatting failed; showing the original text.", error);
            return null;
        }
    }
    // Plain text keeps the caller's exact element. Structured Markdown gets its own block.
    // Text without any Markdown-significant character is plain without loading the parser.
    const significant = /[*_`#|[\]<~\\&]|^ {0,3}(?:[-+]|\d{1,9}[.)])[ \t]|^ {0,3}>|^ {4,}\S|^ {0,3}(?:-{3,}|={3,})[ \t]*$/mu;
    function structured(text) {
        if (!significant.test(text)) return null;
        if (!parser) return undefined;
        const tokens = lex(text);
        return tokens && !plainOnly(tokens) ? tokens : null;
    }
    function formatted(text, tokens, { headingLevel = 4 } = {}) {
        const target = node("div", undefined, "message-markdown");
        target.dataset.messageFormat = "markdown";
        return blocks(target, tokens, headingLevel);
    }
    function exact(text, tag, format) {
        const target = node(tag, text, "message-markdown");
        target.dataset.messageFormat = format;
        return target;
    }
    // Deferred targets hold no copy of the text: it is read back from the element, so an
    // owner that erases or detaches its element leaves nothing to format or resurrect.
    function defer(target, options) {
        pending.set(target, options);
        ready();
        return target;
    }
    function render(text, options = {}) {
        const tokens = structured(text);
        if (tokens) return formatted(text, tokens, options);
        if (tokens === null || failed) return exact(text, options.plain ?? "pre", "plain");
        return defer(exact(text, options.plain ?? "pre", "pending"), options);
    }
    function upgrade(target, options) {
        const text = target.isConnected ? target.textContent : "";
        if (options.preview) {
            const tokens = text && structured(text), projected = tokens && summary(tokens).replace(/\s+/gu, " ").trim();
            if (projected) target.textContent = projected;
            return;
        }
        if (target.dataset.messageFormat !== "pending") return;
        const tokens = text && structured(text);
        target.dataset.messageFormat = "plain";
        if (!tokens) return;
        const next = formatted(text, tokens, options);
        for (const attribute of target.attributes) if (!["class", "data-message-format"].includes(attribute.name)) next.setAttribute(attribute.name, attribute.value);
        next.classList.add(...target.classList);
        target.replaceWith(next);
        options.onFormat?.(next, target);
    }
    // Load the parser only when a message needs it; a failed load keeps the original text.
    let loading = null, failed = false;
    const ready = () => loading ??= Promise.resolve().then(() => typeof load === "function" ? load() : load).then(module => {
        parser = module.marked;
        // Upgrade only text still showing; released, cleared or erased owners stay cleared.
        const waiting = [...pending];
        pending.clear();
        for (const [target, options] of waiting) upgrade(target, options);
    }, error => {
        failed = true;
        const waiting = [...pending.keys()];
        pending.clear();
        for (const target of waiting) if (target.dataset.messageFormat === "pending") target.dataset.messageFormat = "plain";
        console.error("Message formatting is unavailable; showing the original text.", error);
    });
    // A bundled parser is available immediately; the standalone shell loads it on first use.
    if (typeof load !== "function") parser = load.marked;
    const project = text => {
        const tokens = structured(text);
        if (tokens === undefined && !failed) ready();
        return tokens ? summary(tokens).replace(/\s+/gu, " ").trim() || null : null;
    };
    return {
        ready,
        render,
        // Display text for compact one-line previews, or null when the text has no Markdown structure.
        project,
        // Replaces a caller-painted exact preview only when the text proves to be structured.
        preview(target, text) {
            const tokens = structured(text);
            if (tokens === undefined && !failed) return defer(target, { preview: true });
            const projected = tokens ? summary(tokens).replace(/\s+/gu, " ").trim() : "";
            if (projected) target.textContent = projected;
            return target;
        },
        release(target) { pending.delete(target); },
        // Access withdrawal drops every deferred target, including while the parser load is still pending.
        clear() { pending.clear(); },
    };
}export const messageMarkdownStyles = `
.message-markdown[data-message-format] {min-width:0;overflow-wrap:break-word}
.message-markdown:is([data-message-format=plain],[data-message-format=pending]) {white-space:pre-wrap;overflow-wrap:anywhere}
:is(#contextSidebar,#requestContent) .message-markdown[data-message-format=markdown],.message-markdown[data-message-format=markdown] {white-space:normal}
.message-markdown[data-message-format] :is(p,li,blockquote) {font-size:inherit;line-height:inherit;color:inherit;max-width:none}
.message-markdown[data-message-format] :is(p,ul,ol,blockquote,.message-markdown-table,.message-markdown-code) {margin:0 0 var(--space-md)}
.message-markdown[data-message-format] .message-markdown-heading {margin:var(--space-lg) 0 var(--space-sm);font-size:inherit;line-height:var(--leading-heading);font-weight:var(--weight-strong);color:var(--ink)}
.message-markdown[data-message-format] h6.message-markdown-heading {color:var(--muted)}
.message-markdown[data-message-format] strong {font-weight:var(--weight-strong)}
.message-markdown[data-message-format] :is(ul,ol) {padding-inline-start:1.4em}
.message-markdown[data-message-format] ul {list-style:disc}
.message-markdown[data-message-format] ol {list-style:decimal}
.message-markdown[data-message-format] :is(ul,ol) ul {list-style:circle}
.message-markdown[data-message-format] li {margin-block:var(--space-xs)}
.message-markdown[data-message-format] li>:is(p,ul,ol,blockquote) {margin-block:var(--space-xs)}
.message-markdown[data-message-format] li.message-markdown-task {list-style:none}
.message-markdown-check {display:inline-block;box-sizing:border-box;inline-size:.875em;block-size:.875em;margin:0 var(--space-sm) 0 -1.4em;vertical-align:-.0625em;border:1.5px solid var(--control);border-radius:3px;position:relative}
.message-markdown-check[data-checked=true] {border-color:var(--accent);background:var(--accent)}
.message-markdown-check[data-checked=true]::after {content:"";position:absolute;inset-inline-start:28%;inset-block-start:8%;inline-size:30%;block-size:58%;border:solid var(--paper);border-width:0 2px 2px 0;transform:rotate(45deg)}
.message-markdown[data-message-format] blockquote {padding:0 0 0 var(--space-md);border-inline-start:2px solid var(--rule);color:var(--muted)}
.message-markdown[data-message-format] hr {border:0;border-top:1px solid var(--surface-divider);margin-block:var(--space-xl)}
.message-markdown[data-message-format] :not(pre)>code {font-family:var(--mono);font-size:.9em;overflow-wrap:anywhere}
.message-markdown[data-message-format] pre.message-markdown-code {max-height:none;overflow:auto;padding:var(--space-md);border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--canvas);font:.75rem/1.65 var(--mono)}
.message-markdown[data-message-format] pre.message-markdown-code>code {font:inherit}
.message-markdown[data-message-format] :is(a,.message-markdown-code,.message-markdown-table):focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.message-markdown[data-message-format] a.message-markdown-link {color:var(--accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}
.message-markdown[data-message-format] a.message-markdown-link:is(:hover,:active) {color:var(--ink)}
.message-markdown-image {color:var(--muted)}
.message-markdown-literal {white-space:pre-wrap;overflow-wrap:anywhere}
.message-markdown-table {max-width:100%;overflow-x:auto;container-type:inline-size}
.message-markdown[data-message-format] table {width:auto;min-width:min(100%,24rem);max-width:none;table-layout:auto;border-collapse:collapse;font-size:var(--type-small);line-height:1.5;font-variant-numeric:tabular-nums;color:var(--ink)}
.message-markdown[data-message-format] :is(th,td) {min-width:min(7rem,30cqi);padding:var(--space-md) 10px;border-bottom:1px solid var(--surface-divider);text-align:start;vertical-align:top;overflow-wrap:break-word}
.message-markdown[data-message-format] tr>:first-child {padding-inline-start:0}
.message-markdown[data-message-format] tr>:last-child {padding-inline-end:0}
.message-markdown[data-message-format] th {font-weight:var(--weight-medium);color:var(--muted)}
.message-markdown[data-message-format] tbody tr:last-child>td {border-bottom:0}
.message-markdown[data-message-format]>:first-child {margin-top:0}
.message-markdown[data-message-format]>:last-child {margin-bottom:0}
`;