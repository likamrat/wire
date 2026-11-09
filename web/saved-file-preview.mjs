// Serialized into the shell; file contents never become executable page code.
export function createSavedFilePreview(host, value, { frozenFrame, isCurrent, onError, toolbar, icon, title, brand, readingDocument }) {
    const doc = host.ownerDocument, win = doc.defaultView;
    const state = { value, json: null, scalars: null, bytes: null };
    value = null;
    let disposed = false, loading, pdf, renderTask, textLayer, resize, frame, pdfControls, renderVersion = 0;
    const thumbnailTasks = new Set();
    const listeners = [];
    // A publication check can synchronously retire its view.
    const live = () => !disposed && host.isConnected && isCurrent() && !disposed && host.isConnected;
    const el = (tag, text, className) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const listen = (node, type, handler) => {
        node.addEventListener(type, handler);
        listeners.push(() => node.removeEventListener(type, handler));
    };
    function erase(node) {
        const walker = doc.createTreeWalker(node, win.NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) walker.currentNode.data = "";
        node.replaceChildren();
    }
    function dispose() {
        if (disposed) return;
        disposed = true; renderVersion++;
        resize?.disconnect(); renderTask?.cancel(); textLayer?.cancel();
        for (const task of thumbnailTasks) task.cancel();
        thumbnailTasks.clear();
        for (const remove of listeners.splice(0)) remove();
        state.bytes?.fill(0); state.bytes = state.value = state.json = state.scalars = null;
        host.querySelectorAll("canvas").forEach(canvas => { canvas.width = canvas.height = 0; });
        if (frame) { frame.srcdoc = ""; frame.title = ""; frame.remove(); frame = null; }
        pdfControls?.remove();
        if (loading) void loading.destroy().catch(error => console.error("Local PDF preview cleanup failed.", error));
        pdf = loading = renderTask = textLayer = null;
        erase(host);
    }
    function fail(error) {
        if (live()) { dispose(); onError(error); }
    }
    function markdown(parsed) {
        const template = doc.createElement("template");
        template.innerHTML = parsed;
        const ids = new Map(), prefix = "saved-markdown-" + win.crypto.randomUUID() + "-";
        const anchorId = name => { if (!ids.has(name)) ids.set(name, prefix + ids.size); return ids.get(name); };
        const allowed = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "TABLE", "THEAD", "TBODY",
            "TR", "TH", "TD", "BLOCKQUOTE", "PRE", "CODE", "EM", "STRONG", "DEL", "HR", "BR", "A", "DETAILS", "SUMMARY", "DL", "DT", "DD", "DIV"]);
        for (const node of template.content.querySelectorAll("*")) {
            if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "META", "LINK", "BASE", "SVG", "MATH"].includes(node.tagName)) {
                node.remove(); continue;
            }
            if (node.tagName === "IMG") {
                node.replaceWith(doc.createTextNode(node.getAttribute("alt") || "[Image not previewed]")); continue;
            }
            if (node.tagName === "INPUT") {
                node.replaceWith(doc.createTextNode(node.hasAttribute("checked") ? "[x] " : "[ ] ")); continue;
            }
            if (!allowed.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
            const id = node.getAttribute("id"), href = node.getAttribute("href"), start = node.getAttribute("start");
            const align = node.style.textAlign || node.getAttribute("align")?.trim().toLowerCase();
            for (const attribute of [...node.attributes]) node.removeAttribute(attribute.name);
            if (id && /^[A-Za-z0-9_-]+$/.test(id)) node.id = anchorId(id);
            if (node.tagName === "A" && href && /^#[A-Za-z0-9_-]+$/.test(href)) node.setAttribute("href", "#" + anchorId(href.slice(1)));
            if (node.tagName === "OL" && start && /^\d{1,9}$/.test(start)) node.setAttribute("start", start);
            if (["TH", "TD", "DIV"].includes(node.tagName) && ["left", "right", "center"].includes(align)) node.style.textAlign = align;
        }
        const surface = el("article", undefined, "saved-markdown");
        surface.append(template.content);
        if (brand) {
            const header = el("header", undefined, "saved-markdown-header"), heading = surface.querySelector(":scope > h1");
            if (heading) header.append(heading);
            header.append(brand()); surface.prepend(header);
        }
        for (const paragraph of surface.querySelectorAll("p")) {
            if (paragraph.children.length > 1 && [...paragraph.childNodes].every(node =>
                node.nodeType === win.Node.TEXT_NODE ? !node.textContent.trim() : node.nodeName === "A")) paragraph.classList.add("saved-document-links");
        }
        for (const table of surface.querySelectorAll("table")) {
            const scroll = el("div", undefined, "saved-markdown-table");
            scroll.tabIndex = 0; scroll.setAttribute("role", "region"); scroll.setAttribute("aria-label", "Report table");
            table.before(scroll); scroll.append(table);
        }
        listen(surface, "click", event => {
            const link = event.target.closest("a[href]");
            if (!link || !live()) return;
            event.preventDefault(); event.stopPropagation();
            const target = surface.querySelector("#" + win.CSS.escape(link.getAttribute("href").slice(1)));
            if (!target) return;
            for (let parent = target.parentElement; parent && parent !== surface; parent = parent.parentElement)
                if (parent.tagName === "DETAILS") parent.open = true;
            target.scrollIntoView({ block: "start" });
        });
        host.replaceChildren(surface);
    }
    function jsonView() {
        state.scalars = new WeakMap();
        state.json = JSON.parse(state.value.text, (_key, data, context) => {
            if (data !== null && typeof data === "object") return data;
            if (typeof data === "number" && !context?.source && !Number.isSafeInteger(data))
                throw new Error("This browser cannot show this JSON number without losing precision.");
            const leaf = {};
            state.scalars.set(leaf, typeof data === "number" ? context?.source ?? (Object.is(data, -0) ? "-0" : String(data)) : JSON.stringify(data));
            return leaf;
        });
        state.value = null;
        const tree = el("div", undefined, "saved-json-tree");
        tree.setAttribute("aria-label", "JSON document");
        tree.append(el("h2", "Structured data"), el("p", "Expand properties to inspect the saved fields.", "saved-json-intro"));
        const at = path => path.reduce((parent, key) => parent[key], state.json);
        function property(parent, path, name) {
            const data = at(path);
            if (!state.scalars.has(data)) {
                const group = el("details"), summary = el("summary");
                const count = Object.keys(data).length;
                const type = Array.isArray(data) ? count === 1 ? "item" : "items" : count === 1 ? "property" : "properties";
                summary.append(el("span", name, "saved-json-key"), el("span", `${count} ${type}`, "saved-json-count"));
                group.append(summary); parent.append(group);
                let filled = false;
                listen(group, "toggle", () => {
                    if (!live() || !group.open || filled) return;
                    filled = true;
                    const children = el("div", undefined, "saved-json-children");
                    group.append(children); properties(children, path);
                });
            } else {
                const row = el("div", undefined, "saved-json-row");
                row.append(el("span", name, "saved-json-key"), el("span", state.scalars.get(data), "saved-json-scalar"));
                parent.append(row);
            }
        }
        function properties(parent, path) {
            const keys = Object.keys(at(path));
            let offset = 0;
            const more = el("button", "Show more", "quiet"); more.type = "button";
            function append() {
                if (!live()) return;
                for (const key of keys.slice(offset, offset + 100)) property(parent, [...path, key], key);
                offset += 100; more.remove();
                if (offset < keys.length) {
                    more.textContent = `Show next ${Math.min(100, keys.length - offset)} of ${keys.length - offset} remaining`;
                    parent.append(more);
                }
            }
            listen(more, "click", append); append();
        }
        host.replaceChildren(tree);
        if (!state.scalars.has(state.json)) properties(tree, []);
        else tree.append(el("p", state.scalars.get(state.json), "saved-json-scalar"));
    }
    async function pdfView() {
        const library = await import("/assets/pdf.mjs");
        if (!live()) return;
        library.GlobalWorkerOptions.workerSrc = "/assets/pdf.worker.mjs";
        state.bytes = Uint8Array.from(atob(state.value.data), character => character.charCodeAt(0));
        state.value = null;
        class LocalPdfResources {
            async fetch({ kind, filename }) {
                const directory = { standardFontDataUrl: "fonts", cMapUrl: "cmaps" }[kind];
                if (!directory || !/^[A-Za-z0-9_-]+\.(?:pfb|ttf|bcmap)$/.test(filename))
                    throw new Error("This PDF requires an unsupported resource.");
                const response = await fetch(`/assets/pdf-${directory}/${filename}`, { credentials: "omit" });
                if (!response.ok) throw new Error("A bundled PDF resource could not be loaded.");
                return new Uint8Array(await response.arrayBuffer());
            }
        }
        loading = library.getDocument({
            data: new Uint8Array(state.bytes), useWorkerFetch: false, BinaryDataFactory: LocalPdfResources,
            disableFontFace: true, useSystemFonts: false, useWasm: false, enableXfa: false,
            disableAutoFetch: true, disableRange: true, disableStream: true, stopAtErrors: true,
        });
        state.bytes.fill(0); state.bytes = null;
        pdf = await loading.promise;
        if (!live()) return;
        pdfControls = el("div", undefined, "saved-pdf-toolbar");
        const layout = el("div", undefined, "saved-pdf-layout"), index = el("nav", undefined, "saved-pdf-index"), pages = el("div", undefined, "saved-pdf-pages");
        index.setAttribute("aria-label", "PDF pages");
        layout.append(index, pages);
        const previous = el("button", "Previous", "quiet"), next = el("button", "Next", "quiet");
        previous.type = next.type = "button";
        previous.setAttribute("aria-label", "Previous PDF page"); next.setAttribute("aria-label", "Next PDF page");
        if (icon) {
            previous.classList.add("icon-only"); next.classList.add("icon-only");
            previous.replaceChildren(icon("previous")); next.replaceChildren(icon("next"));
        }
        const pageLabel = el("label"), input = el("input");
        pageLabel.append(el("span", "Page", "saved-pdf-page-label"));
        input.type = "number"; input.min = "1"; input.max = String(pdf.numPages); input.value = "1";
        input.style.width = Math.max(3.2, String(pdf.numPages).length + 1.2) + "ch";
        input.setAttribute("aria-label", "PDF page");
        const total = el("span", undefined, "saved-pdf-page-total");
        total.append(el("span", `of ${pdf.numPages}`, "saved-pdf-total-full"), el("span", `/${pdf.numPages}`, "saved-pdf-total-short"));
        pageLabel.append(input, total);
        const zoom = el("select");
        zoom.id = "savedPdfZoom"; zoom.setAttribute("aria-label", "PDF zoom");
        const scales = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];
        for (const [value, label] of [["fit", "Fit width"], ...scales.map(scale => [String(scale), scale * 100 + "%"])]) {
            const option = el("option", label); option.value = value; zoom.append(option);
        }
        const zoomOut = el("button", "-", "quiet saved-pdf-zoom-step"), zoomIn = el("button", "+", "quiet saved-pdf-zoom-step");
        zoomOut.type = zoomIn.type = "button";
        zoomOut.setAttribute("aria-label", "Zoom out"); zoomIn.setAttribute("aria-label", "Zoom in");
        if (icon) {
            zoomOut.classList.add("icon-only"); zoomIn.classList.add("icon-only");
            zoomOut.replaceChildren(icon("zoom-out")); zoomIn.replaceChildren(icon("zoom-in"));
        }
        pdfControls.append(previous, pageLabel, next, zoomOut, zoom, zoomIn);
        host.classList.add("saved-pdf-preview"); host.replaceChildren(layout);
        if (toolbar) toolbar.append(pdfControls);
        else host.prepend(pdfControls);
        let pageNumber = 1, previousWidth = 0, currentScale = 1;
        async function thumbnails(version) {
            for (const task of thumbnailTasks) task.cancel();
            thumbnailTasks.clear();
            index.querySelectorAll("canvas").forEach(canvas => { canvas.width = canvas.height = 0; });
            erase(index);
            if (win.matchMedia("(max-width:1000px)").matches) return;
            const start = Math.max(1, Math.min(pageNumber - 3, pdf.numPages - 6));
            for (let number = start; number <= Math.min(pdf.numPages, start + 6); number++) {
                if (!live() || version !== renderVersion) return;
                const button = el("button", undefined, "quiet saved-pdf-page-choice"), canvas = el("canvas");
                button.type = "button"; button.dataset.page = String(number);
                button.setAttribute("aria-label", "Go to PDF page " + number);
                if (number === pageNumber) button.setAttribute("aria-current", "page");
                canvas.setAttribute("aria-hidden", "true");
                button.append(canvas, el("span", "Page " + number)); index.append(button);
                let page, task;
                try {
                    page = await pdf.getPage(number);
                    if (!live() || version !== renderVersion) return;
                    const natural = page.getViewport({ scale: 1 }), viewport = page.getViewport({ scale: 72 / natural.width });
                    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
                    task = page.render({ canvasContext: canvas.getContext("2d"), viewport });
                    thumbnailTasks.add(task); await task.promise;
                } catch (error) {
                    if (live() && version === renderVersion) {
                        canvas.width = canvas.height = 0;
                        canvas.replaceWith(el("span", "Preview unavailable: " + error.message, "saved-pdf-thumbnail-error"));
                    }
                } finally { thumbnailTasks.delete(task); page?.cleanup(); }
            }
        }
        async function renderPage() {
            const version = ++renderVersion;
            renderTask?.cancel(); textLayer?.cancel();
            input.value = String(pageNumber); input.setCustomValidity("");
            previous.disabled = pageNumber === 1; next.disabled = pageNumber === pdf.numPages;
            pages.setAttribute("aria-busy", "true");
            let page;
            try {
                page = await pdf.getPage(pageNumber);
                if (!live() || version !== renderVersion) return;
                const natural = page.getViewport({ scale: 1 });
                const scale = zoom.value === "fit" ? Math.max(0.1, Math.min(760, pages.clientWidth - 48) / natural.width) : Number(zoom.value);
                currentScale = scale;
                zoomOut.disabled = scale <= scales[0]; zoomIn.disabled = scale >= scales.at(-1);
                const viewport = page.getViewport({ scale }), ratio = Math.min(win.devicePixelRatio || 1, 2);
                const sheet = el("div", undefined, "saved-pdf-sheet"), canvas = el("canvas"), text = el("div", undefined, "saved-pdf-text");
                sheet.style.width = viewport.width + "px"; sheet.style.height = viewport.height + "px";
                sheet.style.setProperty("--total-scale-factor", String(viewport.scale));
                canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
                canvas.style.width = viewport.width + "px"; canvas.style.height = viewport.height + "px";
                canvas.setAttribute("aria-hidden", "true");
                sheet.append(canvas, text);
                pages.querySelectorAll("canvas").forEach(old => { old.width = old.height = 0; });
                erase(pages); pages.append(sheet); pages.scrollTop = 0;
                renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
                await renderTask.promise;
                if (!live() || version !== renderVersion) return;
                textLayer = new library.TextLayer({ textContentSource: page.streamTextContent(), container: text, viewport });
                await textLayer.render();
                await thumbnails(version);
                if (live() && version === renderVersion) pages.setAttribute("aria-busy", "false");
            } catch (error) {
                if (!live() || version !== renderVersion) return;
                fail(error);
            } finally { page?.cleanup(); }
        }
        listen(previous, "click", () => { if (live() && pageNumber > 1) { pageNumber--; void renderPage(); } });
        listen(next, "click", () => { if (live() && pageNumber < pdf.numPages) { pageNumber++; void renderPage(); } });
        listen(input, "change", () => {
            if (!live()) return;
            const selected = Number(input.value);
            if (!Number.isInteger(selected) || selected < 1 || selected > pdf.numPages) {
                input.setCustomValidity(`Choose a page from 1 to ${pdf.numPages}.`); input.reportValidity(); return;
            }
            input.setCustomValidity(""); pageNumber = selected; void renderPage();
        });
        listen(zoom, "change", () => { if (live()) void renderPage(); });
        listen(zoomOut, "click", () => {
            if (live() && !zoomOut.disabled) { zoom.value = String(scales.findLast(scale => scale < currentScale)); zoom.dispatchEvent(new win.Event("change", { bubbles: true })); }
        });
        listen(zoomIn, "click", () => {
            if (live() && !zoomIn.disabled) { zoom.value = String(scales.find(scale => scale > currentScale)); zoom.dispatchEvent(new win.Event("change", { bubbles: true })); }
        });
        listen(index, "click", event => {
            const choice = event.target.closest("[data-page]");
            if (live() && choice) { pageNumber = Number(choice.dataset.page); void renderPage(); }
        });
        resize = new win.ResizeObserver(() => {
            if (!live() || zoom.value !== "fit" || pages.clientWidth === previousWidth) return;
            previousWidth = pages.clientWidth; void renderPage();
        });
        previousWidth = pages.clientWidth; resize.observe(pages);
        await renderPage();
    }
    async function start() {
        try {
            if (!live()) return;
            if (state.value.kind === "html") {
                let html = state.value.text;
                if (readingDocument) {
                    const source = doc.implementation.createHTMLDocument("");
                    source.documentElement.innerHTML = html;
                    readingDocument(source);
                    html = "<!doctype html>" + source.documentElement.outerHTML;
                }
                frame = frozenFrame(html, doc);
                frame.title = title || typeof state.value.artifact?.title === "string" && state.value.artifact.title.trim() || "HTML report";
                state.value = null; host.replaceChildren(frame);
            } else if (state.value.kind === "markdown") {
                const { marked } = await import("/assets/marked.mjs");
                if (!live()) return;
                const html = marked.parse(state.value.text, { gfm: true, breaks: false, async: false });
                state.value = null; markdown(html);
            } else if (["json", "manifest"].includes(state.value.kind)) jsonView();
            else if (state.value.kind === "pdf") await pdfView();
            else throw new Error("This file format cannot be previewed.");
        } catch (error) { fail(error); }
    }
    host.classList.remove("saved-pdf-preview");
    host.classList.add("saved-file-preview");
    const ready = start();
    return { ready, dispose };
}

export function createPreparedFileInspection(host, files, { id, createPreview, isCurrent, selection, toolbar: externalToolbar, icon, onInfo, title, brand, hideRail = false } = {}) {
    const doc = host.ownerDocument, win = doc.defaultView, sources = new Map();
    let disposed = false, mounted = null, sourceMode = selection?.source === true, shownName, shownValue;
    const el = (tag, text, cls) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    };
    const viewer = el("section", undefined, "document-file-view");
    const toolbar = externalToolbar || el("div", undefined, "document-file-toolbar");
    const controls = el("div", undefined, "document-file-controls"), modes = el("div", undefined, "document-file-modes");
    const rendered = el("button", "Preview", "quiet document-view-mode"), source = el("button", "Source", "quiet document-view-mode");
    rendered.type = source.type = "button";
    modes.setAttribute("role", "group"); modes.setAttribute("aria-label", "File view");
    modes.append(rendered, source);
    const filename = el("span", undefined, "document-file-name"), fileControls = el("div", undefined, "document-format-controls");
    if (externalToolbar) controls.append(modes, filename, fileControls);
    else controls.append(filename, modes, fileControls);
    const info = onInfo ? el("button", undefined, "quiet icon-only document-file-info") : null;
    if (info) { info.type = "button"; info.setAttribute("aria-label", "About this file"); info.append(icon("info")); controls.append(info); }
    toolbar.append(controls);
    const preview = el("div", undefined, "prepared-file-preview"), originals = el("div", undefined, "prepared-file-source");
    preview.tabIndex = 0; preview.setAttribute("role", "region"); preview.setAttribute("aria-label", externalToolbar ? "Saved file preview" : "Prepared file preview");
    const rail = el("nav", undefined, "prepared-file-rail"), choices = new Map();
    rail.id = id; rail.setAttribute("aria-label", "Files to be saved");
    rail.append(el("h3", "Files to be saved"));
    const format = name => name === "coverage-and-redaction-manifest.json" ? "manifest"
        : name.endsWith(".md") ? "markdown" : name.split(".").at(-1);
    const labels = { html: "HTML", pdf: "PDF", markdown: "Markdown", json: "JSON", manifest: "Manifest" };
    const hidden = (node, value) => { if (node.hidden !== value) node.hidden = value; };
    for (const [name, contents] of Object.entries(files).sort(([a], [b]) =>
        Number(a === "coverage-and-redaction-manifest.json") - Number(b === "coverage-and-redaction-manifest.json"))) {
        const choice = el("button", undefined, "quiet prepared-file-choice"), label = el("span");
        choice.type = "button"; choice.dataset.fileName = name;
        label.append(el("strong", labels[format(name)] || name), el("span", name, "prepared-file-choice-name"));
        if (icon) choice.append(icon(["json", "manifest"].includes(format(name)) ? "code" : "reports"));
        choice.append(label); rail.append(choice); choices.set(name, choice);
        if (typeof contents === "string") {
            const text = el("pre", contents, "report-exact-text");
            text.tabIndex = 0; text.hidden = true; text.setAttribute("aria-label", name);
            sources.set(name, text); originals.append(text);
        }
    }
    let selectedName = selection?.name && Object.hasOwn(files, selection.name) ? selection.name : choices.keys().next().value;
    viewer.append(...(externalToolbar ? [] : [toolbar]), preview, originals);
    host.classList.add(externalToolbar ? "saved-file-inspection" : "prepared-file-reader");
    if (hideRail) { rail.hidden = true; host.classList.add("prepared-file-reader-single"); }
    host.replaceChildren(...(externalToolbar ? [] : [rail]), viewer);
    const live = () => !disposed && host.isConnected && isCurrent() && !disposed && host.isConnected;
    function refresh() {
        if (disposed || !host.isConnected) return;
        if (!isCurrent()) { dispose(); return; }
        if (disposed || !host.isConnected) return;
        if (!host.checkVisibility()) {
            mounted?.dispose(); mounted = null; shownName = shownValue = undefined; return;
        }
        const name = selectedName, raw = sources.get(name), bytes = files[name];
        if (!raw) sourceMode = false;
        const value = raw ? raw.textContent : bytes?.data;
        hidden(modes, !raw);
        hidden(filename, format(name) === "pdf");
        const label = ["json", "manifest"].includes(format(name)) ? "Tree" : "Preview";
        if (rendered.textContent !== label) rendered.textContent = label;
        if (filename.textContent !== name) filename.textContent = name;
        for (const [key, choice] of choices) choice.setAttribute("aria-current", String(key === name));
        rendered.setAttribute("aria-pressed", String(!sourceMode));
        source.setAttribute("aria-pressed", String(sourceMode));
        for (const [key, node] of sources) hidden(node, key !== name);
        hidden(originals, !sourceMode); hidden(preview, sourceMode);
        if (sourceMode) {
            mounted?.dispose(); mounted = null; shownName = shownValue = undefined; return;
        }
        if (mounted && name === shownName && value === shownValue) return;
        mounted?.dispose(); mounted = null; shownName = name; shownValue = value;
        preview.replaceChildren();
        const active = () => live() && !sourceMode && selectedName === name && shownValue === value && host.checkVisibility();
        mounted = createPreview(preview, { kind: format(name), ...(raw ? { text: value } : { data: value }) }, {
            isCurrent: active, toolbar: fileControls, icon, title, brand,
            onError(error) {
                if (active()) preview.replaceChildren(el("p", `This file could not be previewed. ${error.message}`, "notice error"));
            },
        });
    }
    function choose(event) {
        const choice = event.target.closest("[data-file-name]");
        if (live() && choice && choices.has(choice.dataset.fileName)) {
            selectedName = choice.dataset.fileName; sourceMode = false; refresh();
        }
    }
    function showSource() { if (live()) { sourceMode = true; refresh(); } }
    function showPreview() { if (live()) { sourceMode = false; refresh(); } }
    function about() { if (live()) onInfo(selectedName, labels[format(selectedName)], info); }
    rail.addEventListener("click", choose); source.addEventListener("click", showSource); rendered.addEventListener("click", showPreview);
    info?.addEventListener("click", about);
    const changes = new win.MutationObserver(records => {
        if (!host.isConnected) {
            if (records.some(record => [...record.removedNodes].some(node => node === host || node.contains?.(host)))) dispose();
            return;
        }
        refresh();
    });
    changes.observe(doc.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "class"] });
    function dispose() {
        if (disposed) return;
        disposed = true; changes.disconnect(); mounted?.dispose(); mounted = null;
        rail.removeEventListener("click", choose); source.removeEventListener("click", showSource); rendered.removeEventListener("click", showPreview);
        info?.removeEventListener("click", about);
        for (const root of [host, controls]) {
            const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) walker.currentNode.data = "";
        }
        controls.remove(); sources.clear(); choices.clear(); files = null; selectedName = shownName = shownValue = undefined; host.replaceChildren();
    }
    return { refresh, dispose, selection: () => ({ name: selectedName, source: sourceMode }),
        select(name) {
            if (!live()) return false;
            if (!choices.has(name)) throw new TypeError("That prepared file is not available.");
            selectedName = name; sourceMode = false; refresh(); return true;
        } };
}

export const savedFilePreviewStyles = `
.document-stage{display:flex;flex-direction:column;flex:1;min-height:200px;min-width:0;overflow:hidden;background:var(--paper);border:1px solid var(--surface-divider);border-radius:var(--radius-small);container:file-stage / size}
.document-file-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;min-height:60px;padding:8px 16px;border-bottom:1px solid var(--surface-divider);background:var(--paper);flex:none}
.document-file-toolbar>select{max-width:12rem}
.document-file-controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;flex:1;min-width:min-content}
.document-file-modes{display:flex;align-items:center;gap:2px;background:var(--canvas);border-radius:var(--radius-small);flex:none}
.document-file-modes button{min-height:44px;padding:4px 10px;border:0;background:transparent;color:var(--muted);font-size:var(--type-control);border-radius:var(--radius-small)}
.document-file-modes button[aria-pressed=true]{background:var(--hover);color:var(--ink)}
.document-file-name{flex:1;min-width:0;text-align:center;overflow-wrap:anywhere;font-size:var(--type-control);color:var(--muted)}
.document-file-info{display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;padding:0}
.document-format-controls{margin-inline:auto;min-width:0}.document-format-controls:empty{display:none}
.document-file-toolbar:has(.saved-pdf-toolbar) .document-file-controls{display:contents}
.document-file-view{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden}
.saved-file-inspection,.saved-reader-file{display:flex;flex:1;min-width:0;min-height:0}
.prepared-file-reader{display:flex;height:70dvh;min-height:240px;min-width:0;border:1px solid var(--surface-divider);border-radius:var(--radius-small);overflow:hidden}
.prepared-file-rail{flex:none;width:14.375rem;overflow:auto;overscroll-behavior:contain;padding:16px 12px;border-right:1px solid var(--surface-divider);background:var(--paper)}
.prepared-file-rail h3{margin:4px 10px 16px;font-size:var(--type-body);font-weight:var(--weight-medium)}
.prepared-file-choice{display:flex;align-items:start;justify-content:start;gap:12px;width:100%;padding:12px 10px;text-align:left;white-space:normal;border-radius:var(--radius-small)}
.prepared-file-choice>.wire-icon{flex:none;margin-top:3px}.prepared-file-choice>span{min-width:0}
.prepared-file-choice strong{display:block;font:var(--weight-medium) var(--type-body)/var(--leading-ui) var(--font)}
.prepared-file-choice-name{display:block;font-size:var(--type-control);color:var(--muted);overflow-wrap:anywhere;margin-top:2px}
.prepared-file-choice[aria-current=true]{background:var(--hover);border-color:var(--surface-edge)}
.prepared-file-reader .document-file-name{text-align:left;font-size:var(--type-body);font-weight:var(--weight-medium);color:var(--ink)}
.prepared-file-preview,.prepared-file-source{flex:1;min-height:0;min-width:0}
.prepared-file-source{overflow:hidden;background:var(--canvas)}
.prepared-file-source .report-exact-text{height:100%;max-height:none;margin:0;border:0;border-radius:0;padding:24px 32px;overflow:auto;font-size:.875rem;line-height:1.7;white-space:pre}
.prepared-file-reader[hidden],.prepared-file-preview[hidden],.prepared-file-source[hidden]{display:none!important}
.saved-file-preview{flex:1;min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;background:var(--canvas)}
.saved-file-preview:has(>.report-frame){overflow:hidden;background:#fff}
.saved-file-preview>.report-frame{display:block;width:100%;height:100%;min-height:0;margin:0;border:0;border-radius:0;background:#fff}
.saved-markdown{box-sizing:border-box;width:calc(100% - 48px);max-width:900px;min-height:calc(100% - 48px);margin:24px auto;padding:38px 52px 44px;background:var(--paper);font:var(--type-reading)/1.65 var(--font);color:var(--ink)}
.saved-markdown :is(h1,h2,h3,h4){line-height:1.3;font-weight:var(--weight-medium);scroll-margin-top:16px}
.saved-markdown h1{font-size:1.4375rem;margin:0 0 14px}.saved-markdown h2{font-size:1.125rem;margin:28px 0 12px}
.saved-markdown-header{display:flex;align-items:start;justify-content:space-between;gap:24px;margin-bottom:14px}
.saved-markdown-header h1{min-width:0;margin:0}.saved-report-mark{display:block;flex:none}
.saved-report-mark .brand-logo{display:block;width:7rem;height:auto}
.saved-report-mark .brand-logo[data-brand-theme=dark]{display:none}
:root[data-evidence-theme=dark] .saved-report-mark .brand-logo[data-brand-theme=light]{display:none}
:root[data-evidence-theme=dark] .saved-report-mark .brand-logo[data-brand-theme=dark]{display:block}
@media(prefers-color-scheme:dark){
 :root:not([data-evidence-theme]) .saved-report-mark .brand-logo[data-brand-theme=light]{display:none}
 :root:not([data-evidence-theme]) .saved-report-mark .brand-logo[data-brand-theme=dark]{display:block}
}
.saved-markdown h3{font-size:1rem;margin:20px 0 8px}
.saved-markdown :is(p,li){max-width:75ch}.saved-markdown p{margin:0 0 16px}
.saved-markdown .saved-document-links{display:flex;flex-wrap:wrap;gap:8px 16px}
.saved-markdown dl{display:flex;flex-wrap:wrap;gap:8px 24px;margin:8px 0 24px;font-size:var(--type-control);line-height:1.5}
.saved-markdown dl>div{display:flex;flex-wrap:wrap;gap:4px 8px;min-width:0;max-width:100%}
.saved-markdown dt{color:var(--muted)}.saved-markdown dd{margin:0;overflow-wrap:anywhere}
.saved-markdown pre{max-height:none;overflow:auto;white-space:pre-wrap;font-size:.875rem}
.saved-markdown code{font-family:var(--mono)}.saved-markdown :not(pre)>code{font-size:.9em}
.saved-markdown blockquote{margin:16px 0;padding-left:16px;border-left:2px solid var(--rule);color:var(--muted)}
.saved-markdown-table{overflow:auto;margin:16px 0;max-width:100%}
.saved-markdown table{width:100%;min-width:32rem;table-layout:auto;border-collapse:collapse;font-size:.875rem;font-variant-numeric:tabular-nums}
.saved-markdown :is(th,td){padding:12px 10px;border-bottom:1px solid var(--surface-divider);text-align:left;vertical-align:top;overflow-wrap:anywhere}
.saved-markdown tr>:first-child{padding-left:0}.saved-markdown tr>:last-child{padding-right:0}
.saved-markdown th{font-weight:var(--weight-medium);overflow-wrap:normal;white-space:nowrap}.saved-markdown thead{color:var(--muted)}
.saved-markdown a[href]{color:var(--accent);text-underline-offset:3px}.saved-markdown hr{border:0;border-top:1px solid var(--surface-divider);margin:24px 0}
.saved-json-tree{max-width:1080px;margin:0 auto;padding:24px 32px 40px;font:.8125rem/1.65 var(--mono)}
.saved-json-tree h2{font:var(--weight-medium) 1.125rem/1.35 var(--font);margin:0 0 8px}
.saved-json-intro{font:var(--type-control)/1.6 var(--font);color:var(--muted);margin:0 0 24px}
.saved-json-tree details{border:0;background:none;border-radius:0;padding:0;margin:0}
.saved-json-tree summary{padding:8px 0;cursor:pointer;overflow-wrap:anywhere}
.saved-json-key{color:var(--ink);overflow-wrap:anywhere}.saved-json-count{margin-left:12px;color:var(--muted);font:var(--type-control)/1.5 var(--font)}
.saved-json-children{margin-left:12px;padding-left:16px;border-left:1px solid var(--surface-divider)}
.saved-json-row{display:grid;grid-template-columns:minmax(9rem,22%) minmax(0,1fr);gap:20px;padding:8px 0}
.saved-json-scalar{white-space:pre-wrap;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.saved-pdf-preview{display:flex;flex-direction:column;overflow:hidden;background:var(--canvas)}
.saved-pdf-layout{display:flex;flex:1;min-width:0;min-height:0}
.saved-pdf-index{flex:none;width:132px;padding:16px;overflow:auto;border-right:1px solid var(--surface-divider);background:var(--paper)}
.saved-pdf-page-choice{display:flex;flex-direction:column;align-items:center;gap:8px;width:100%;padding:8px 4px;font-size:var(--type-control);border-radius:var(--radius-small)}
.saved-pdf-page-choice[aria-current=page]{outline:2px solid var(--surface-edge);outline-offset:-2px}
.saved-pdf-page-choice canvas{display:block;width:72px;height:auto;background:#fff}
.saved-pdf-thumbnail-error{font-size:var(--type-control);white-space:normal}
.saved-pdf-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;background:var(--paper);border-bottom:1px solid var(--surface-divider)}
.document-format-controls .saved-pdf-toolbar{padding:0;border:0}
.saved-pdf-toolbar .select-control{flex:none;width:max-content;max-width:none}
.saved-pdf-toolbar .select-value{white-space:nowrap}
.saved-pdf-page-total{white-space:nowrap}.saved-pdf-total-short{display:none}
.saved-pdf-toolbar label{display:flex;align-items:center;gap:8px;margin:0;flex:none}.saved-pdf-toolbar input{width:3.2ch;min-width:2ch;padding:4px;text-align:center;appearance:textfield}
.saved-pdf-toolbar input::-webkit-inner-spin-button{display:none}
.saved-pdf-pages{flex:1;min-width:0;min-height:0;overflow:auto;padding:24px;overscroll-behavior:contain}
.saved-pdf-sheet{position:relative;margin:0 auto;background:#fff;color:#000;isolation:isolate}
.saved-pdf-sheet canvas{display:block}
/* PDF.js text positioning; the painted page remains unchanged. */
.saved-pdf-text{position:absolute;inset:0;overflow:clip;line-height:1;letter-spacing:normal;word-spacing:normal;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor)*var(--min-font-size));--min-font-size-inv:calc(1/var(--min-font-size))}
.saved-pdf-text :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0 0;user-select:text}
.saved-pdf-text>:not(.markedContent),.saved-pdf-text .markedContent span:not(.markedContent){font-size:calc(var(--text-scale-factor)*var(--font-height));transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));--font-height:0;--scale-x:1;--rotate:0deg}
.saved-pdf-text .markedContent{display:contents}.saved-pdf-text ::selection{background:#3694ff66}
@container file-stage (max-height:20rem){
 .saved-pdf-page-label,.saved-pdf-total-full,.saved-pdf-toolbar .saved-pdf-zoom-step{display:none}
 .saved-pdf-total-short{display:inline}
 .saved-pdf-toolbar{flex-wrap:nowrap;gap:6px;overflow-x:auto;max-width:100%}
}
@media(max-width:1000px){.document-file-toolbar .document-file-name{display:none}.prepared-file-reader .document-file-name{display:block}.saved-markdown{padding:30px 38px}.saved-pdf-index{display:none}}
@media(max-width:700px){
 .document-file-toolbar{padding:8px;gap:8px;min-height:56px}.document-file-controls{gap:6px}.document-file-modes button{padding:4px 8px}
 .document-file-toolbar>select{max-width:10rem}.document-format-controls{flex-basis:100%;order:2}
 .prepared-file-reader{flex-direction:column}.prepared-file-rail{display:flex;width:100%;gap:4px;padding:8px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--surface-divider)}
 .prepared-file-rail h3,.prepared-file-choice-name{display:none}.prepared-file-choice{width:auto;min-width:7rem;min-height:48px;padding:8px;align-items:center;flex:none}
 .prepared-file-reader .document-file-name{flex-basis:100%}.prepared-file-source .report-exact-text{padding:20px 18px}
 .saved-markdown{width:100%;margin:0;min-height:100%;padding:26px 22px}.saved-json-tree{padding:22px 18px}.saved-json-row{grid-template-columns:minmax(0,1fr);gap:2px}.saved-json-tree summary{min-height:44px}
 .saved-markdown-header{flex-wrap:wrap;gap:12px}.saved-report-mark .brand-logo{width:5.5rem}
}
`;
