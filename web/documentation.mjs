// Documentation page: guides from the repository's docs, read in WIRE with a guide tree and an outline.
// Repository HTML is parsed in an inert template and only allow-listed elements and attributes survive.
const ELEMENTS = new Set(["a", "abbr", "b", "blockquote", "br", "code", "dd", "del", "details", "div", "dl", "dt", "em",
    "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "input", "kbd", "li", "ol", "p", "picture", "pre", "q", "s",
    "samp", "section", "small", "source", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot",
    "th", "thead", "tr", "ul"]);
const ATTRIBUTES = new Set(["href", "src", "srcset", "media", "alt", "title", "width", "height", "id", "name", "class", "align",
    "colspan", "rowspan", "start", "type", "checked", "open", "lang", "dir", "aria-label"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "select", "button", "form",
    "svg", "math", "frame", "frameset", "link", "meta", "base", "video", "audio", "canvas"]);
const ALERTS = { NOTE: ["Note", "doc-note"], TIP: ["Tip", "doc-tip"], IMPORTANT: ["Important", "doc-important"], WARNING: ["Warning", "doc-warning"], CAUTION: ["Caution", "doc-caution"] };
const SOURCE_KEY = "wire.documentationSource";

export const documentationMarkup = `<section id="documentationView" class="wire-docs" aria-label="Documentation" hidden></section>`;

export function mountDocumentation({ host, api, icon, open, announce = () => {} }) {
    const doc = host.ownerDocument, win = doc.defaultView;
    const reduce = win.matchMedia("(prefers-reduced-motion: reduce)");
    let catalog = null, page = null, view = null, token = 0, spyFrame = 0, liveTimer = 0, liveVersion = null, visible = false, loading = null;
    let sourceChoice = (() => { try { return win.sessionStorage.getItem(SOURCE_KEY) === "checkout" ? "checkout" : "official"; } catch { return "official"; } })();
    const pages = new Map(), positions = new Map(), origins = new Map(), listeners = new AbortController();

    const el = (tag, props = {}, ...children) => {
        const node = doc.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (value === undefined || value === null || value === false) continue;
            if (key === "class") node.className = value;
            else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
            else node.setAttribute(key, value === true ? "" : value);
        }
        node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
        return node;
    };
    const glyph = role => { const span = el("span", { class: "docs-icon", "aria-hidden": "true" }); span.innerHTML = icon(role); return span; };
    const short = commit => commit?.slice(0, 7) ?? "";
    const relative = iso => {
        if (!iso) return "";
        const seconds = (Date.now() - Date.parse(iso)) / 1000, format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
        for (const [unit, size] of [["year", 31536e3], ["month", 2592e3], ["day", 86400], ["hour", 3600], ["minute", 60]])
            if (Math.abs(seconds) >= size) return format.format(-Math.round(seconds / size), unit);
        return "just now";
    };
    const hrefFor = (guide, fragment = "") => `/documentation${guide ? "?guide=" + encodeURIComponent(guide) : ""}${fragment ? "#" + encodeURIComponent(fragment) : ""}`;
    const guides = () => catalog?.groups.flatMap(group => group.items) ?? [];
    const base = () => catalog?.source.comparedWith === "main" ? "GitHub main" : "your last commit";
    const positionKey = () => `${win.location.pathname}${win.location.search}${win.location.hash}@${win.history.state?.evidenceView?.position ?? ""}`;
    let imageDialog = null, pendingGuide = null;

    function openImage(button, src, description) {
        if (imageDialog?.open) return;
        const image = el("img", { alt: description });
        const stage = el("div", { class: "docs-image-stage", tabindex: "0", "aria-label": "Image area", role: "region" }, image);
        const zoom = el("button", { type: "button", class: "quiet", onclick: () => {
            const actual = stage.toggleAttribute("data-actual-size");
            zoom.textContent = actual ? "Fit image" : "Actual size";
            stage.scrollTo(0, 0);
        } }, "Actual size");
        const close = el("button", { type: "button", class: "icon-only quiet", autofocus: true,
            title: "Close image", "aria-label": "Close image", onclick: () => dialog.close() }, glyph("close"));
        const dialog = el("dialog", { class: "docs-image-dialog", "aria-labelledby": "docsImageTitle" },
            el("header", { class: "dialog-head" }, el("h2", { id: "docsImageTitle" }, "Guide image"), zoom, close), stage);
        image.onerror = () => {
            zoom.disabled = true;
            stage.replaceChildren(el("p", { role: "status" }, "This image is unavailable. Close it and reopen the guide to try again."));
        };
        image.src = src;
        imageDialog = dialog;
        host.append(dialog);
        button.focus({ preventScroll: true });
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (imageDialog !== dialog) return;
            imageDialog = null;
            const route = pendingGuide;
            pendingGuide = null;
            if (visible && route) void render(route, { quiet: true });
        }, { once: true });
        dialog.showModal();
    }
    function dismissImage() {
        pendingGuide = null;
        if (imageDialog?.open) imageDialog.close();
        imageDialog = null;
    }

    async function loadCatalog() {
        catalog = await api("/api/documentation/catalog", { source: sourceChoice });
        if (catalog.source.kind !== "checkout" && sourceChoice === "checkout") sourceChoice = "official";
        return catalog;
    }
    async function loadPage(guide) {
        const key = `${catalog.source.revision}|${guide}`;
        if (!pages.has(key)) pages.set(key, api("/api/documentation/page", { revision: catalog.source.revision, guide })
            .catch(error => { pages.delete(key); throw error; }));
        return pages.get(key);
    }

    // ---------- sanitizing and resolving ----------
    function sanitize(html) {
        const template = doc.createElement("template");
        template.innerHTML = html;
        const walk = parent => {
            for (const node of [...parent.childNodes]) {
                if (node.nodeType === win.Node.COMMENT_NODE) { node.remove(); continue; }
                if (node.nodeType !== win.Node.ELEMENT_NODE) continue;
                const tag = node.localName;
                if (DROP.has(tag)) { node.remove(); continue; }
                walk(node);
                if (!ELEMENTS.has(tag)) { node.replaceWith(...node.childNodes); continue; }
                for (const attribute of [...node.attributes]) if (!ATTRIBUTES.has(attribute.name.toLowerCase())) node.removeAttribute(attribute.name);
            }
        };
        walk(template.content);
        return template.content;
    }
    function external(link, hint) {
        link.target = "_blank"; link.rel = "noopener noreferrer"; link.setAttribute("referrerpolicy", "no-referrer");
        link.classList.add("doc-external");
        link.append(el("span", { class: "visually-hidden" }, ` (${hint})`), glyph("doc-external"));
    }
    function missing(link, reason) {
        link.replaceWith(el("span", { class: "doc-missing-link", title: reason }, ...link.childNodes, el("span", { class: "visually-hidden" }, ` (${reason})`)));
    }
    function present(content, data) {
        const target = value => data.targets[value] ?? { kind: "missing", reason: "This address wasn't checked" };
        const asset = file => data.assetBase + file.split("/").map(encodeURIComponent).join("/");
        const imageLinks = new Set();
        for (const node of content.querySelectorAll("[id],[name]")) for (const name of ["id", "name"]) {
            const value = node.getAttribute(name);
            if (value) node.setAttribute(name, "user-content-" + value);
        }
        for (const node of content.querySelectorAll("[class]")) {
            const kept = [...node.classList].filter(name => /^(?:doc-|language-)/.test(name));
            kept.length ? node.setAttribute("class", kept.join(" ")) : node.removeAttribute("class");
        }
        for (const link of content.querySelectorAll("a")) {
            const raw = link.getAttribute("href");
            if (raw === null) continue;
            const themed = /#gh-(dark|light)-mode-only$/.exec(raw);
            if (themed) link.classList.add(`doc-theme-${themed[1]}-only`);
            const found = target(raw);
            link.removeAttribute("target");
            if (found.kind === "fragment") {
                if (themed) { link.removeAttribute("href"); continue; }
                if (!content.querySelector(`[id="user-content-${win.CSS.escape(found.fragment)}"]`)) missing(link, `No section “${found.fragment}” on this page`);
                else { link.setAttribute("href", "#" + encodeURIComponent(found.fragment)); link.dataset.fragment = found.fragment; }
            } else if (found.kind === "guide") {
                link.setAttribute("href", hrefFor(found.guide, found.fragment)); link.dataset.guide = found.guide;
                if (found.fragment) link.dataset.fragment = found.fragment;
            } else if (found.kind === "asset") {
                link.setAttribute("href", asset(found.path));
                if (link.querySelector("img")) imageLinks.add(link);
                else {
                    const button = el("button", { type: "button", class: "quiet docs-asset-link", "aria-haspopup": "dialog",
                        onclick: () => openImage(button, asset(found.path), button.textContent) }, ...link.childNodes, glyph("reader-maximize"));
                    link.replaceWith(button);
                }
            } else if (found.kind === "repository") { link.setAttribute("href", found.url); external(link, "opens on GitHub"); }
            else if (found.kind === "external") { link.setAttribute("href", found.url); external(link, found.host === "email" ? "opens your email app" : `opens ${found.host}`); }
            else if (found.kind === "missing") missing(link, found.reason);
            else link.replaceWith(...link.childNodes);
        }
        for (const image of content.querySelectorAll("img")) {
            const raw = image.getAttribute("src") ?? "";
            // Only the checked source may load, including on high-density displays.
            image.removeAttribute("srcset");
            const themed = /#gh-(dark|light)-mode-only$/.exec(raw);
            if (themed) image.classList.add(`doc-theme-${themed[1]}-only`);
            const found = target(raw);
            image.loading = "lazy"; image.decoding = "async";
            if (found.kind === "asset") {
                image.setAttribute("src", asset(found.path));
                if (found.size) {
                    const width = Number(image.getAttribute("width")) || found.size[0];
                    image.setAttribute("width", String(Math.round(width)));
                    image.setAttribute("height", String(Math.round(width * found.size[1] / found.size[0])));
                }
                const media = image.closest("picture") ?? image, link = media.closest("a");
                const frame = el("span", { class: "docs-image-frame" });
                const description = image.getAttribute("alt") || found.path.split("/").at(-1);
                const button = el("button", { type: "button", class: "icon-only docs-image-open", "aria-haspopup": "dialog",
                    "aria-label": `Enlarge image: ${description}`, title: "Enlarge image",
                    "data-doc-image": found.path, onclick: () => openImage(button, image.currentSrc || image.src, description) }, glyph("reader-maximize"));
                if (link && !imageLinks.has(link)) {
                    // A linked illustration may open another guide. Keep that destination and give enlargement its own control.
                    link.replaceWith(frame);
                    frame.append(link, button);
                } else {
                    const original = link ?? media;
                    original.replaceWith(frame);
                    frame.append(media, button);
                    frame.classList.add("docs-image-expandable");
                    media.addEventListener("click", () => button.click());
                }
                for (const node of [image, link]) for (const name of node?.classList ?? [])
                    if (/^doc-theme-(dark|light)-only$/.test(name)) frame.classList.add(name);
                continue;
            }
            const alt = image.getAttribute("alt") || "Image";
            const note = found.kind === "external"
                ? el("span", { class: "doc-image-note", role: "note" }, glyph("doc-image-off"), el("span", {}, `${alt}. `,
                    el("span", { class: "docs-quiet" }, `Hosted on ${found.host}. WIRE doesn't load outside images. `),
                    (() => { const link = el("a", { href: found.url }, "Open image"); external(link, `opens ${found.host}`); return link; })()))
                : el("span", { class: "doc-image-note doc-image-missing", role: "img", "aria-label": `Image unavailable: ${alt}` }, glyph("doc-image-off"),
                    el("span", {}, `${alt}. `, el("span", { class: "docs-quiet" }, found.reason ?? "Image unavailable.")));
            image.replaceWith(note);
        }
        for (const source of content.querySelectorAll("source")) {
            const found = target(source.getAttribute("srcset") ?? "");
            found.kind === "asset" ? source.setAttribute("srcset", asset(found.path)) : source.remove();
        }
        for (const input of content.querySelectorAll("input")) {
            if (input.getAttribute("type") !== "checkbox") { input.remove(); continue; }
            input.disabled = true; input.closest("li")?.classList.add("doc-task");
        }
        for (const table of content.querySelectorAll("table")) {
            const label = table.querySelector("th")?.textContent.trim();
            const wrap = el("div", { class: "doc-table", role: "region", tabindex: "0", "aria-label": label ? `Table: ${label}` : "Table" });
            table.replaceWith(wrap); wrap.append(table);
        }
        for (const pre of content.querySelectorAll(".doc-code pre")) {
            pre.tabIndex = 0;
            const copy = el("button", { type: "button", class: "doc-copy icon-only", "aria-label": "Copy code", title: "Copy code" }, glyph("doc-copy"));
            copy.addEventListener("click", async () => {
                try {
                    await win.navigator.clipboard.writeText(pre.textContent);
                    copy.replaceChildren(glyph("doc-copied")); copy.setAttribute("aria-label", "Code copied");
                    win.setTimeout(() => { copy.replaceChildren(glyph("doc-copy")); copy.setAttribute("aria-label", "Copy code"); }, 1600);
                } catch { announce("Couldn't copy. Select the code and copy it instead."); }
            });
            pre.parentElement.append(copy);
        }
        for (const link of content.querySelectorAll("a.doc-permalink")) link.replaceChildren(glyph("doc-link"));
        for (const quote of content.querySelectorAll("blockquote")) {
            const first = quote.querySelector(":scope > p"), kind = first && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/.exec(first.textContent);
            if (!kind) continue;
            const text = first.firstChild;
            if (text?.nodeType === win.Node.TEXT_NODE) text.data = text.data.replace(/^\s*\[!\w+\]\s*/, "");
            if (!first.textContent.trim() && !first.querySelector("img")) first.remove();
            const [title, role] = ALERTS[kind[1]];
            quote.replaceWith(el("div", { class: `doc-alert doc-alert-${kind[1].toLowerCase()}`, role: "note" },
                el("p", { class: "doc-alert-title" }, glyph(role), title), ...quote.childNodes));
        }
        return content;
    }

    // ---------- hierarchy ----------
    const nest = (headings, min, max) => {
        const roots = [], stack = [];
        for (const heading of headings.filter(h => h.depth >= min && h.depth <= max)) {
            const node = { ...heading, children: [] };
            while (stack.length && stack.at(-1).depth >= heading.depth) stack.pop();
            (stack.length ? stack.at(-1).children : roots).push(node);
            stack.push(node);
        }
        return roots;
    };
    const outlineList = (nodes, guide, depthClass = "") => el("ul", { class: `docs-outline-list${depthClass}` }, ...nodes.map(node =>
        el("li", { "data-heading": node.id },
            el("a", { href: hrefFor(guide, node.id), "data-fragment": node.id, "data-heading": node.id }, node.text),
            node.children.length ? outlineList(node.children, guide, " docs-outline-nested") : null)));
    function guideTree(current) {
        return el("nav", { class: "docs-tree", "aria-label": "Guides" }, ...catalog.groups.map(group => el("section", { class: "docs-tree-group" },
            el("h2", {}, group.name),
            el("ul", {}, ...group.items.map(item => {
                const isCurrent = item.guide === current, edited = catalog.source.changed?.[item.file];
                const link = el("a", { href: hrefFor(item.guide), "data-guide": item.guide, class: "docs-tree-guide", "aria-current": isCurrent ? "page" : null },
                    el("span", {}, item.title),
                    edited ? el("span", { class: `docs-badge docs-badge-${edited}`, title: edited === "new" ? `Not in ${base()} yet` : `Differs from ${base()}` }, edited === "new" ? "New" : "Edited") : null);
                const sections = isCurrent ? nest(item.headings, 2, 2) : [];
                return el("li", {}, link, sections.length ? el("ul", { class: "docs-tree-sections" }, ...sections.map(node =>
                    el("li", { "data-heading": node.id }, el("a", { href: hrefFor(item.guide, node.id), "data-fragment": node.id, "data-heading": node.id }, node.text)))) : null);
            })))));
    }

    function sourceLine() {
        const source = catalog.source, parts = [], sep = () => el("span", { class: "docs-sep", "aria-hidden": "true" }, "·");
        const commit = value => value ? el("span", { class: "docs-commit", title: value }, glyph("doc-commit"), short(value)) : null;
        const checkButton = label => el("button", { type: "button", class: "docs-text-button quiet", onclick: () => refresh({ force: true }) }, glyph("refresh"), label);
        if (source.kind === "official") {
            parts.push(el("span", {}, "From GitHub main"), sep(), commit(source.commit), sep(), el("span", {}, `published ${relative(source.published)}`));
            if (source.failedAt && (!source.checkedAt || source.failedAt > source.checkedAt))
                parts.push(el("span", { class: "docs-source-warning" }, glyph("doc-offline"), `${source.failure} Showing main as last fetched.`), checkButton("Try again"));
            else if (source.checkedAt) parts.push(sep(), el("span", {}, `checked ${relative(source.checkedAt)}`), sep(), checkButton("Check now"));
            else parts.push(sep(), el("span", { class: "docs-quiet" }, "checking GitHub…"));
        } else if (source.kind === "build") {
            parts.push(el("span", {}, "Guides included with this WIRE build"), sep(), commit(source.commit));
            if (source.canCheck) parts.push(source.failedAt
                ? el("span", { class: "docs-source-warning" }, glyph("doc-offline"), `${source.failure} These may not be the latest guides.`)
                : el("span", { class: "docs-quiet" }, "Not checked against GitHub main yet."), checkButton(source.failedAt ? "Try again" : "Check GitHub main"));
            else parts.push(el("span", { class: "docs-quiet" }, "This copy doesn't track the official WIRE repository, so it can't check GitHub main."));
        } else if (source.kind === "copy") {
            parts.push(el("span", {}, "Guides included with this copy of WIRE."), el("span", { class: "docs-quiet" }, "It has no Git history, so it can't check GitHub main."));
        } else {
            const changed = Object.keys(source.changed ?? {}).length;
            parts.push(el("span", { class: "docs-source-local" }, `Previewing this checkout${source.branch ? ` on ${source.branch}` : ""}`), sep(), commit(source.head), sep(),
                el("span", {}, source.compared ? changed ? `${changed} ${changed === 1 ? "guide differs" : "guides differ"} from ${base()}` : `Same as ${base()}` : "Not compared"),
                sep(), el("span", {}, "updates when you save"));
        }
        const choose = choice => () => { if (choice !== sourceChoice) switchSource(choice); };
        const switcher = source.checkout ? el("div", { class: "docs-source-switch", role: "group", "aria-label": "Documentation source" },
            el("button", { type: "button", "aria-pressed": String(sourceChoice === "official"), onclick: choose("official") }, "GitHub main"),
            el("button", { type: "button", "aria-pressed": String(sourceChoice === "checkout"), onclick: choose("checkout"), title: "Read the guides in this folder, including changes you haven't committed" }, "This checkout")) : null;
        return el("div", { class: `docs-source docs-source-${source.kind}` }, el("p", {}, ...parts), switcher);
    }

    function pager(guide) {
        const list = guides(), index = list.findIndex(item => item.guide === guide);
        if (index < 0) return null;
        const previous = list[index - 1], next = list[index + 1];
        const neighbor = (item, back) => item && el("a", { href: hrefFor(item.guide), "data-guide": item.guide,
            rel: back ? "prev" : "next", class: "navigation-action" }, back ? glyph("back") : null,
            el("span", {}, `${back ? "Previous" : "Next"}: ${item.title}`), back ? null : glyph("forward"));
        return el("nav", { class: "docs-pager", "aria-label": "Previous and next guide" }, neighbor(previous, true), neighbor(next, false));
    }

    function layout(data) {
        const content = present(sanitize(data.html), data);
        const article = el("article", { class: "docs-article", "aria-labelledby": "docTitle" }, content);
        let title = article.querySelector("h1");
        if (!title) { title = el("h1", {}, data.title); article.prepend(title); }
        title.id = "docTitle"; title.tabIndex = -1;
        title.after(sourceLine());
        // The guide's own "Contents" list repeats the outline beside it.
        for (const paragraph of article.querySelectorAll(":scope > p")) {
            if (paragraph.querySelector("strong")?.textContent.replace(":", "").trim() !== "Contents") continue;
            const list = paragraph.nextElementSibling?.matches("ul") ? paragraph.nextElementSibling : null;
            const links = [...paragraph.querySelectorAll("a"), ...(list?.querySelectorAll("a") ?? [])];
            if (links.length && links.every(link => link.dataset.fragment !== undefined)) { paragraph.classList.add("docs-inline-contents"); list?.classList.add("docs-inline-contents"); }
        }
        const sections = nest(data.headings, 2, 3);
        const summary = label => {
            const chevron = glyph("disclosure").firstElementChild;
            chevron.classList.add("disclosure-icon");
            return el("summary", {}, glyph("doc-contents"), label, chevron);
        };
        const inline = sections.length ? el("details", { class: "docs-outline-inline" }, summary("On this page"),
            el("nav", { class: "docs-outline", "aria-label": "On this page" }, outlineList(sections, data.guide))) : null;
        if (inline) article.querySelector(".docs-source").after(inline);
        const footer = el("footer", { class: "docs-article-footer" },
            data.sourceUrl ? (() => { const link = el("a", { href: data.sourceUrl, class: "navigation-action" }, "View this guide on GitHub"); external(link, "opens on GitHub"); return link; })()
                : catalog.source.kind === "checkout" ? el("p", { class: "docs-quiet" }, `Local file: ${data.file}${catalog.source.changed?.[data.file] ? catalog.source.changed[data.file] === "new" ? ` (new, not in ${base()})` : ` (edited, differs from ${base()})` : ""}`) : null,
            pager(data.guide));
        const wide = host.clientWidth > 880;
        return el("div", { class: "docs-grid" },
            el("div", { class: "docs-left" }, el("details", { class: "docs-left-toggle", open: wide }, summary("All guides"), guideTree(data.guide))),
            el("div", { class: "docs-center" }, el("div", { class: "docs-paper" }, article, footer)),
            el("div", { class: "docs-right" }, sections.length ? el("nav", { class: "docs-outline", "aria-label": "On this page" }, el("h2", {}, "On this page"), outlineList(sections, data.guide)) : null));
    }

    // ---------- reading position and the current section ----------
    function headerOffset() { return (doc.querySelector(".app-header")?.getBoundingClientRect().height ?? 76) + 8; }
    function setActive() {
        spyFrame = 0;
        if (!view) return;
        const heads = [...view.querySelectorAll(".docs-article :is(h2,h3)[id^='user-content-']")];
        const line = headerOffset() + win.innerHeight * 0.2;
        let active = null, parent = null;
        for (const head of heads) { if (head.getBoundingClientRect().top > line) break; active = head; if (head.localName === "h2") parent = head; }
        const id = active?.id.slice(13) ?? null, h2 = parent?.id.slice(13) ?? null;
        for (const link of view.querySelectorAll("a[data-heading]")) {
            const on = link.dataset.heading === id || link.closest(".docs-tree-sections") && link.dataset.heading === h2;
            on ? link.setAttribute("aria-current", "location") : link.removeAttribute("aria-current");
        }
        for (const rail of view.querySelectorAll(".docs-left, .docs-right")) {
            const link = rail.querySelector('a[aria-current="location"]');
            if (!link || win.getComputedStyle(rail).position !== "sticky") continue;
            const r = link.getBoundingClientRect(), box = rail.getBoundingClientRect();
            if (r.top < box.top + 24 || r.bottom > box.bottom - 24) rail.scrollTop += r.top - box.top - box.height / 3;
        }
        if (visible) positions.set(positionKey(), win.scrollY);
    }
    const onScroll = () => { spyFrame ||= win.requestAnimationFrame(setActive); };
    win.addEventListener("scroll", onScroll, { passive: true, signal: listeners.signal });
    win.addEventListener("resize", onScroll, { passive: true, signal: listeners.signal });

    function scrollToFragment(fragment, { focus = true, smooth = false } = {}) {
        const target = view && doc.getElementById("user-content-" + fragment);
        if (!target) return false;
        for (let parent = target.parentElement; parent && parent !== view; parent = parent.parentElement) if (parent.localName === "details") parent.open = true;
        target.scrollIntoView({ block: "start", behavior: smooth && !reduce.matches ? "smooth" : "instant" });
        if (focus && /^h[1-6]$/.test(target.localName)) { target.tabIndex = -1; target.focus({ preventScroll: true }); }
        return true;
    }
    function fragment() { try { return decodeURIComponent(win.location.hash.slice(1)); } catch { return ""; } }

    function focusSelector(node) {
        if (!view?.contains(node)) return null;
        if (node.id) return `#${win.CSS.escape(node.id)}`;
        if (node.dataset.docImage) return `button[data-doc-image="${win.CSS.escape(node.dataset.docImage)}"]`;
        const region = [".docs-left", ".docs-right", ".docs-outline-inline", ".docs-source-switch", ".docs-article", ".docs-pager"].find(selector => node.closest(selector));
        if (!region) return null;
        if (node.matches("a[href]")) return `${region} a[href="${win.CSS.escape(node.getAttribute("href"))}"]`;
        if (node.matches("summary")) return `${region} summary`;
        if (node.matches(".docs-text-button")) return ".docs-text-button";
        if (node.matches(".docs-source-switch button")) return `${region} button:nth-child(${[...node.parentElement.children].indexOf(node) + 1})`;
        return null;
    }
    function rememberLink(link) {
        origins.set(positionKey(), { selector: focusSelector(link), top: win.scrollY });
    }
    function restoreOrigin() {
        const origin = origins.get(positionKey()), link = origin && view?.querySelector(origin.selector);
        if (!link) return false;
        const fold = link.closest("details");
        if (fold) fold.open = true;
        if (!link.checkVisibility()) return false;
        win.scrollTo({ top: origin.top, behavior: "instant" });
        link.focus({ preventScroll: true });
        return true;
    }

    // ---------- rendering ----------
    async function render(route, { restore = false, quiet = false } = {}) {
        const mine = ++token, guide = route.guide ?? "";
        loading = guide;
        try {
            if (!catalog) await loadCatalog();
            if (mine !== token) return;
            if (guide && !guides().some(item => item.guide === guide)) throw Object.assign(new Error("There's no guide at this address in these guides. It may have been renamed."), { status: 404 });
            const data = await loadPage(guide);
            if (mine !== token || !visible) return;
            if (quiet && imageDialog?.open) { pendingGuide = route; return; }
            dismissImage();
            const previousFocus = quiet && focusSelector(doc.activeElement), previousTop = win.scrollY;
            const folds = quiet ? [...host.querySelectorAll(".docs-left-toggle[open], .docs-outline-inline[open]")].map(node => node.className) : [];
            view = layout(data);
            host.replaceChildren(view);
            page = data;
            if (quiet) {
                for (const name of folds) { const fold = view.querySelector(`.${name}`); if (fold) fold.open = true; }
                win.scrollTo({ top: previousTop, behavior: "instant" });
                if (previousFocus) (view.querySelector(previousFocus) ?? view.querySelector("#docTitle")).focus({ preventScroll: true });
            } else if (!(restore && restoreOrigin()) && !scrollToFragment(fragment())) {
                win.scrollTo({ top: restore ? positions.get(positionKey()) ?? 0 : 0, behavior: "instant" });
                view.querySelector("#docTitle")?.focus({ preventScroll: true });
            }
            setActive();
            watchCheckout();
        } catch (error) {
            if (mine !== token || !visible) return;
            if (quiet && imageDialog?.open) { pendingGuide = route; return; }
            if (error?.code === "documentation_revision_changed" || error?.status === 409) { catalog = null; pages.clear(); return render(route, { restore, quiet }); }
            page = null;
            view = el("div", { class: "docs-paper docs-error", role: "alert" },
                el("h1", { id: "docTitle", tabindex: "-1" }, error?.status === 404 ? "Guide not found" : "Couldn't load the guides"),
                el("p", {}, error?.status === 404 ? error.message : "WIRE couldn't read the documentation. Your activity and reports are unaffected."),
                el("p", {}, el("a", { href: hrefFor(""), "data-guide": "" }, "Go to the documentation index")));
            host.replaceChildren(view);
            if (!quiet) view.querySelector("#docTitle").focus({ preventScroll: true });
        } finally { if (mine === token) loading = null; }
    }

    async function refresh({ force = false } = {}) {
        if (!catalog || !catalog.source.canCheck || sourceChoice !== "official") return;
        const before = catalog.source.revision;
        if (force) announce("Checking GitHub main for newer guides…");
        try { await api("/api/documentation/check", { force }); } catch {
            if (visible && sourceChoice === "official") announce("Couldn't check for newer guides. Try again from Documentation.");
            return;
        }
        if (!visible || sourceChoice !== "official") return;
        try {
            const reloaded = await api("/api/documentation/catalog", { source: sourceChoice });
            if (!visible || sourceChoice !== "official") return;
            catalog = reloaded;
        } catch { return; /* access changed or WIRE stopped; the page on screen stays as it was */ }
        const changed = catalog.source.revision !== before;
        if (changed) { pages.clear(); await render({ guide: loading ?? page?.guide ?? "" }, { quiet: true }); }
        else {
            const line = view?.querySelector(".docs-source");
            const focus = line?.contains(doc.activeElement) && focusSelector(doc.activeElement);
            line?.replaceWith(sourceLine());
            if (focus) view.querySelector(focus)?.focus({ preventScroll: true });
        }
        if (changed) announce("Updated to the latest guides from GitHub main.");
        else if (force) announce(catalog.source.failedAt && catalog.source.failedAt > (catalog.source.checkedAt ?? "") ? "Couldn't reach GitHub main." : "These are the latest guides on GitHub main.");
    }

    function switchSource(choice) {
        sourceChoice = choice;
        try { win.sessionStorage.setItem(SOURCE_KEY, choice); } catch { /* the choice lasts for this view */ }
        catalog = null; pages.clear();
        void render({ guide: page?.guide ?? "" }, { quiet: true });
    }

    // A contributor's saved edits appear without reloading; the current reading position stays.
    function watchCheckout() {
        win.clearInterval(liveTimer); liveTimer = 0;
        if (!visible || catalog?.source.kind !== "checkout") return;
        liveVersion = catalog.source.revision;
        liveTimer = win.setInterval(async () => {
            if (doc.hidden || !visible) return;
            try {
                const { version } = await api("/api/documentation/version", {});
                if (version && version !== liveVersion && visible) {
                    liveVersion = version; catalog = null; pages.clear();
                    await render({ guide: page?.guide ?? "" }, { quiet: true });
                    announce("Updated from your saved changes.");
                }
            } catch { /* the next check retries */ }
        }, 2000);
    }

    host.addEventListener("click", event => {
        const link = event.target.closest("a[href]");
        if (!link || !host.contains(link) || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (link.dataset.guide !== undefined && link.dataset.guide !== (page?.guide ?? "")) {
            event.preventDefault();
            rememberLink(link);
            positions.set(positionKey(), win.scrollY);
            open(link.dataset.guide, link.dataset.fragment ?? "");
        } else if (link.dataset.fragment !== undefined && (link.dataset.guide === undefined || link.dataset.guide === (page?.guide ?? ""))) {
            // Same-guide sections use the browser's own fragment navigation, so Back returns to the earlier section.
            event.preventDefault();
            rememberLink(link);
            positions.set(positionKey(), win.scrollY);
            const url = hrefFor(page?.guide ?? "", link.dataset.fragment);
            if (win.location.pathname + win.location.search + win.location.hash !== url) win.location.hash = encodeURIComponent(link.dataset.fragment);
            else scrollToFragment(link.dataset.fragment, { smooth: true });
            const details = link.closest("details.docs-outline-inline");
            if (details) details.open = false;
        }
    }, { signal: listeners.signal });
    win.addEventListener("hashchange", () => { if (visible && page && !restoreOrigin()) scrollToFragment(fragment(), { smooth: true }); }, { signal: listeners.signal });
    // Rails fold below 880px. Only a width crossing changes them, so opening the fold (which adds height) stays open.
    let wideLayout = null;
    new win.ResizeObserver(([entry]) => {
        const wide = entry.contentRect.width > 880;
        if (wide === wideLayout) return;
        wideLayout = wide;
        for (const details of host.querySelectorAll(".docs-left-toggle")) if (details.open !== wide) details.open = wide;
    }).observe(host);

    return {
        show(route, { restore = false } = {}) {
            const first = !visible;
            visible = true;
            // The workspace re-renders often; a guide that is already loading keeps its request.
            if (loading !== null && loading === (route.guide ?? "")) return;
            if (page && page.guide === (route.guide ?? "") && catalog) {
                if (!first && !restore) return;
                const saved = positions.get(positionKey());
                if (restore && restoreOrigin()) { watchCheckout(); return; }
                if (fragment()) scrollToFragment(fragment());
                else if (restore && saved !== undefined) win.scrollTo({ top: saved, behavior: "instant" });
                watchCheckout();
                return;
            }
            void render(route, { restore }).then(() => { if (first) void refresh(); });
        },
        hide() { visible = false; dismissImage(); win.clearInterval(liveTimer); liveTimer = 0; token++; loading = null; },
        withdraw() { visible = false; dismissImage(); win.clearInterval(liveTimer); token++; loading = null; catalog = null; page = null; view = null; pages.clear(); positions.clear(); origins.clear(); host.replaceChildren(); },
        close() { this.withdraw(); listeners.abort(); },
    };
}
