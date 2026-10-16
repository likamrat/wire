import { uxIcons } from "./ux-icons.mjs";

export function searchHitPresentation(hit) {
    const invalid = () => { throw new TypeError("Search match text or range is invalid. Search again."); };
    if (![hit?.title, hit?.excerpt, hit?.source?.label].every(value => typeof value === "string")
        || !hit.textMatch || Object.keys(hit.textMatch).sort().join(",") !== "end,excerptStart,field,start") invalid();
    const { field, start, end, excerptStart } = hit.textMatch;
    if (!["title", "content", "source"].includes(field)
        || ![start, end, excerptStart].every(Number.isSafeInteger) || excerptStart < 0 || start < excerptStart || end <= start) invalid();
    function boundary(text, index) {
        return !(index > 0 && index < text.length && text.charCodeAt(index - 1) >= 0xd800
            && text.charCodeAt(index - 1) <= 0xdbff && text.charCodeAt(index) >= 0xdc00 && text.charCodeAt(index) <= 0xdfff);
    }
    const from = start - excerptStart, to = end - excerptStart;
    if (to > hit.excerpt.length || !boundary(hit.excerpt, from) || !boundary(hit.excerpt, to)) invalid();
    if (field !== "content") {
        const original = field === "title" ? hit.title : hit.source.label;
        if (end > original.length || !boundary(original, start) || !boundary(original, end)
            || original.slice(start, end) !== hit.excerpt.slice(from, to)) invalid();
    }
    const plain = text => [{ text, match: false }];
    const marked = (text, from, to) => [
        { text: text.slice(0, from), match: false },
        { text: text.slice(from, to), match: true },
        { text: text.slice(to), match: false },
    ].filter(part => part.text);
    const shown = {
        title: field === "title" ? marked(hit.title, start, end) : plain(hit.title),
        excerpt: field === "content" ? marked(hit.excerpt, from, to) : [],
        source: field === "source" ? marked(hit.source.label, start, end) : hit.source.label.trim() ? plain(hit.source.label) : [],
    };
    if (shown.excerpt.length && hit.excerpt === hit.title) {
        shown.title = shown.excerpt; shown.excerpt = [];
    }
    if (hit.source.label === hit.title) {
        if (field === "source") shown.title = [];
        else shown.source = [];
    } else if (shown.excerpt.length && hit.source.label === hit.excerpt) shown.source = [];
    if (field !== "source" && ["interaction", "context"].includes(hit.type) && hit.source.kind === "retained-activity") {
        const caption = text => text.trim().replace(/\s+/gu, " ").replace(/[.!?\u3002\uff01\uff1f]+$/u, "").trim();
        if (caption(hit.title) && caption(hit.title) === caption(hit.source.label)) shown.source = [];
    }
    if (shown.excerpt.length) {
        const prefix = hit.excerpt.slice(0, from), suffix = hit.excerpt.slice(to);
        const graphemes = new Intl.Segmenter("und", { granularity: "grapheme" });
        function context(text, before) {
            const paragraphs = text.split(/\r\n|[\r\n]/u), paragraph = before ? paragraphs.at(-1) : paragraphs[0];
            const units = [...graphemes.segment(paragraph)].map(part => part.segment);
            let value = (before ? units.slice(-32) : units.slice(0, 56)).join("");
            if (value.length < paragraph.length) value = before ? value.replace(/^\S+\s/u, "") : value.replace(/\s+\S*$/u, "");
            return value;
        }
        const left = context(prefix, true), right = context(suffix, false);
        shown.excerpt = [
            { text: ((left.length < prefix.length ? "... " : "") + left).replace(/\s+/gu, " "), match: false },
            { text: hit.excerpt.slice(from, to), match: true },
            { text: (right + (right.length < suffix.length ? " ..." : "")).replace(/\s+/gu, " "), match: false },
        ].filter(part => part.text);
    }
    if (field !== "source" && hit.type === "view" && hit.target?.kind === "route" && typeof hit.target.href === "string") {
        const names = { analyze: "Analyze", reports: "Reports", settings: "Settings", "collection-status": "Collection status" };
        const view = hit.target.href.slice(1).split("?")[0];
        if (Object.hasOwn(names, view)) shown.source = names[view] === hit.title ? [] : plain(names[view]);
    }
    return shown;
}

export const liveSearchPanel = `
<section id="wireSearchPanel" class="wire-search-panel" aria-labelledby="wireSearchTitle" hidden>
  <h2 id="wireSearchTitle" class="visually-hidden">Search results</h2>
  <p id="wireSearchScopeNote" hidden>Search your saved activity and reports. This does not collect new data.</p>
  <p id="wireSearchStatus" role="status" aria-live="polite"></p>
  <button id="wireSearchRetry" type="button" class="quiet" hidden>Reconnect search</button>
  <div class="wire-search-health">
    <p id="wireSearchCoverage" class="muted"></p>
  </div>
  <section id="wireSearchMatches" class="wire-search-set" aria-labelledby="wireSearchMatchesTitle" hidden>
    <h3 id="wireSearchMatchesTitle">Matches</h3>
    <ol id="wireSearchResults" class="wire-search-results" aria-label="Search results"></ol>
    <div id="wireSearchPaging" class="wire-search-paging"></div>
  </section>
  <details id="wireSearchOptions" class="wire-search-options">
    <summary id="wireSearchFilterSummary"><span class="wire-search-filter-icon" aria-hidden="true">${uxIcons.filter}</span><span id="wireSearchFilterLabel">Filters</span></summary>
    <div class="wire-search-filters">
      <label>Search scope<select id="wireSearchScope" data-select-presentation="filter"><option value="everywhere">Everywhere</option><option value="analysis">Current Analyze scope</option></select></label>
      <label>Result type<select id="wireSearchType" data-select-presentation="filter"><option value="">All types</option><option value="interaction">Interactions</option><option value="context">Conversation context</option><option value="reply">Retained replies</option><option value="action">Recorded actions</option><option value="tool">Tools</option><option value="service">Services</option><option value="report">Saved reports</option><option value="comparison">Saved comparisons</option><option value="view">Views</option><option value="setting">Settings</option></select></label>
    </div>
  </details>
</section>`;

export const liveSearchMarkup = `
<div id="wireSearchHome" class="wire-search-entry">
  <label for="wireSearch" class="visually-hidden">Search</label>
  <span class="wire-search-icon">${uxIcons.search}</span>
  <input id="wireSearch" type="search" placeholder="Search" autocomplete="off" spellcheck="false" aria-controls="wireSearchPanel" aria-expanded="false">
  <button id="wireSearchClear" type="button" class="quiet" hidden>Clear search</button>
  ${liveSearchPanel}
</div>`;

export const liveSearchStyles = `
/* The sticky field is above the page reading inset; don't apply that inset to native caret scrolling. */
html:has(.wire-search-entry:focus-within) {scroll-padding-top:0}
.wire-search-entry {position:relative;display:grid;grid-template-columns:minmax(0,1fr);align-items:center;flex:1 1 280px;min-width:180px;max-width:480px}
.wire-search-entry>label {font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-medium);white-space:nowrap}
.wire-search-icon {position:absolute;inset-inline-start:14px;top:50%;transform:translateY(-50%);display:flex;pointer-events:none;color:var(--muted)}
.wire-search-icon .wire-icon {width:20px;height:20px}
#wireSearch {grid-area:1/1;width:100%;min-width:0;min-height:var(--pill-height);border-radius:var(--radius-pill);padding-inline:42px calc(var(--pill-height) + 12px);background:var(--paper);box-shadow:var(--surface-shadow)}
#wireSearch::-webkit-search-cancel-button {display:none}
#wireSearchClear {grid-area:1/1;align-self:center;justify-self:end;margin-inline-end:2px;border-radius:var(--radius-pill);z-index:1}
.wire-search-panel {--wire-search-match:#006580;position:absolute;inset-inline:0;top:calc(100% + 8px);margin:0;min-width:0;padding:8px;background:var(--paper);border:1px solid var(--rule);border-radius:16px;box-shadow:var(--surface-shadow);font:var(--type-body)/var(--leading-ui) var(--font);max-height:min(30rem,calc(100dvh - var(--app-header-height,148px) - 24px));overflow-y:auto;overscroll-behavior:contain;scroll-padding:8px}
@media(prefers-color-scheme:dark) {
 :root:not([data-evidence-theme]) .wire-search-panel {--wire-search-match:#67c9df}
}
:root[data-evidence-theme=dark] .wire-search-panel {--wire-search-match:#67c9df}
.wire-search-options {border-top:1px solid var(--rule);margin-top:4px;padding-inline:6px}
.wire-search-options>summary {display:grid;grid-template-columns:20px minmax(0,1fr) 16px;align-items:center;gap:8px;min-height:44px;padding-block:12px;cursor:pointer;overflow-wrap:anywhere;font:inherit;color:var(--ink)}
.wire-search-filter-icon {display:flex;grid-column:1;grid-row:1}
#wireSearchFilterLabel {grid-column:2;grid-row:1}
.wire-search-options>summary>.disclosure-icon {grid-column:3;grid-row:1;margin:0}
.wire-search-filters,.wire-search-paging {display:flex;align-items:center;flex-wrap:wrap;gap:12px}
/* Shared selects already inset their labels and values; reserve the rest of the glyph lane. */
.wire-search-filters {padding-block:4px 12px;padding-inline-start:max(0px,calc(28px - var(--select-value-inset)))}
.wire-search-filters label {display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:4px;font:inherit}
.wire-search-panel > p:not(.visually-hidden):not(:empty) {margin:8px}
.wire-search-health {font:inherit}
.wire-search-health p:not(:empty):not([hidden]) {margin:6px 6px 10px;padding:0;font:inherit;color:var(--muted)}
.wire-search-set {margin:0;min-width:0}
.wire-search-set>h3:not(.visually-hidden),.wire-search-set>p:not(.visually-hidden) {margin:8px;font-size:var(--type-caption)}
.wire-search-results {padding:0;margin:0;list-style:none}
.wire-search-results>li+li {border-top:1px solid var(--rule);margin-top:6px;padding-top:6px}
#wireSearchPanel .wire-search-hit {display:grid;grid-template-columns:20px minmax(0,1fr);align-items:start;gap:8px;width:100%;min-height:44px;text-align:start;border:0;border-radius:var(--radius-small);background:transparent;color:var(--ink);font:inherit;padding:12px 6px}
#wireSearchPanel .wire-search-hit::before {content:none;background:transparent;border:0;box-shadow:none}
#wireSearchPanel .wire-search-hit:is(:hover,:focus-visible):not(:disabled) .wire-search-title {text-decoration:underline;text-underline-offset:.18em}
#wireSearchPanel .wire-search-hit:active:not(:disabled) .wire-search-title {text-decoration-thickness:2px}
.wire-search-body {grid-column:2;display:grid;gap:4px;min-width:0}
.wire-search-title {font:inherit;min-width:0;overflow-wrap:anywhere}
.wire-search-hit mark {background:var(--accent-soft);color:var(--wire-search-match);text-decoration:underline;text-underline-offset:.15em}
.wire-search-excerpt {margin-top:4px;padding-inline-start:10px;border-inline-start:2px solid var(--rule);white-space:normal;overflow-wrap:anywhere;font-size:var(--type-body);font-weight:var(--weight-regular);line-height:var(--leading-reading)}
.wire-search-meta,.wire-search-source,.wire-search-limitation {font:inherit;color:var(--muted);min-width:0;overflow-wrap:anywhere}
.wire-search-meta {display:flex;gap:4px 12px;flex-wrap:wrap;align-items:center}
.wire-search-type-icon {grid-column:1;grid-row:1;display:flex;align-items:center;justify-content:center;margin-top:calc((1lh - 16px) / 2)}
.wire-search-type-icon .wire-icon {width:16px;height:16px;margin:0}
.wire-search-outcome {display:inline-flex;align-items:center;gap:4px;color:var(--cue-color)}
.wire-search-outcome .wire-icon {width:16px;height:16px;margin:0}
.wire-search-source {display:block}
.wire-search-title.wire-search-source {color:var(--ink)}
.wire-search-paging:not(:empty) {padding:8px 10px;font:inherit}
@media(max-width:600px) {
 .wire-search-entry {flex-basis:100%;max-width:none}
 .wire-search-filters {align-items:stretch}
 .wire-search-filters>label,.wire-search-filters>.select-field {flex:1 1 240px}
}
@media(forced-colors:active) {
 .wire-search-panel,#wireSearch {box-shadow:none;border-color:CanvasText}
 .wire-search-results>li+li,.wire-search-excerpt {border-color:CanvasText}
 .wire-search-hit mark {color:HighlightText;background:Highlight;forced-color-adjust:none}
 #wireSearchPanel .wire-search-hit:focus-visible {outline-color:Highlight}
}
`;

// Shared by both saved-copy entry points. No companion links or active resources survive.
export function createFrozenReportFrame(html, doc = document) {
    const frame = doc.createElement("iframe");
    frame.className = "report-frame"; frame.title = "Frozen saved report";
    frame.setAttribute("sandbox", ""); frame.setAttribute("referrerpolicy", "no-referrer");
    const template = doc.createElement("template");
    template.innerHTML = html;
    template.content.querySelectorAll("base,iframe,frame,object,embed,script").forEach(node => node.remove());
    template.content.querySelectorAll("meta[http-equiv]").forEach(node => {
        if (node.getAttribute("http-equiv").trim().toLowerCase() !== "content-security-policy") node.remove();
    });
    template.content.querySelectorAll("[href],[xlink\\:href]").forEach(node => {
        for (const attribute of ["href", "xlink:href"]) {
            const value = node.getAttribute(attribute);
            if (value !== null && !/^#[a-zA-Z0-9_-]+$/.test(value)) node.removeAttribute(attribute);
            else if (value !== null && ["a", "area"].includes(node.localName)) node.setAttribute(attribute, "about:srcdoc" + value);
        }
        for (const attribute of ["target", "ping", "download"]) node.removeAttribute(attribute);
    });
    const root = doc.createElement("html"), rootTemplate = doc.createElement("template");
    const prefix = html.match(/^\s*(?:<!doctype html>\s*)?<html\b([^>]*)>/i);
    if (prefix) {
        rootTemplate.innerHTML = "<div" + prefix[1] + "></div>";
        for (const attribute of ["lang", "data-evidence-theme"]) {
            const value = rootTemplate.content.firstElementChild?.getAttribute(attribute);
            if (value !== null && value !== undefined) root.setAttribute(attribute, value);
        }
    }
    const isolation = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; font-src data:; base-uri &#39;none&#39;; form-action &#39;none&#39;">';
    frame.srcdoc = "<!doctype html>" + root.outerHTML.replace("</html>", () => isolation + template.innerHTML + "</html>");
    return frame;
}

export function mountLiveSearch({ api, createState, navigate, presentDocument, getAnalysis, onAnalysis, onInvalidateOpen, contract, ux, results, presentHit }) {
    const $ = id => document.getElementById(id);
    const input = $("wireSearch"), panel = $("wireSearchPanel"), list = $("wireSearchResults");
    const home = $("wireSearchHome");
    const scope = $("wireSearchScope"), category = $("wireSearchType"), state = createState();
    const lists = { matches: list };
    const pagers = { matches: $("wireSearchPaging") };
    const returns = new Map();
    let stream, timer, heartbeat, sequence = 0, openId = 0, restore, analysisKey = null, documentReturn = null;
    let pages = { matches: 0 }, drawnKeys = { matches: null };
    let connected = false, connecting = false, disposed = false;
    let hidden = document.hidden, resumeVisibleQuery = false;
    const purpose = () => scope.value === "analysis" ? "analysis" : "navigation";
    const types = () => scope.value === "analysis" ? ["interaction", "context", "reply", "action"] : category.value ? [category.value] : [];
    const ownedReceipt = () => state.snapshot().matches?.receipt;
    function eraseLists() {
        list.replaceChildren(); pagers.matches.replaceChildren(); drawnKeys.matches = null;
        $("wireSearchMatches").hidden = true;
    }
    function el(tag, text, cls) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(text, action) {
        const node = el("button", text, "quiet"); node.type = "button"; node.addEventListener("click", action);
        const role = text.startsWith("Previous ") ? "previous" : text.startsWith("Next ") ? "next" : text === "Back to search" ? "back" : null;
        if (role) ux?.utility(node, role, text);
        return node;
    }
    function failureMessage(error) {
        if (error.reason === "search-protocol-changed") return "Search changed. Reload this panel.";
        if (error.reason === "stale-search-target") return "Saved content changed. Search again.";
        if (error.reason === "search-busy") return "Search is busy in another panel. Try again.";
        if (error.reason === "search-open-busy") return "An item is already opening. Try again.";
        if (error.reason === "search-disconnected") return "Search disconnected. Reconnect to continue.";
        if (error.reason === "runtime_unavailable") return "Search is unavailable. Try again.";
        return error.message;
    }
    function show() {
        $("wireSearchClear").hidden = !input.value;
        panel.hidden = !input.value.trim();
        input.setAttribute("aria-expanded", String(!panel.hidden));
    }
    function hide() {
        restore = null;
        panel.hidden = true;
        input.setAttribute("aria-expanded", "false");
    }
    function syncScope() {
        const analytical = scope.value === "analysis";
        category.disabled = analytical;
        category.options[0].textContent = analytical ? "Interactions and calls" : "All types";
        if (analytical) category.value = "";
        $("wireSearchScopeNote").textContent = analytical
            ? "Find matching activity within your current filters. Results update the charts and report scope."
            : "Search your saved activity and reports. This does not collect new data.";
    }
    function eraseDocument() {
        if (documentReturn) returns.delete(documentReturn);
        documentReturn = null;
        onInvalidateOpen();
    }
    function fail(message = "Search disconnected. Results were cleared; reconnect to read current items.") {
        connected = connecting = resumeVisibleQuery = false;
        clearTimeout(timer);
        stream?.abort(); stream = null;
        clearTimeout(heartbeat);
        state.disconnect(); eraseLists(); eraseDocument();
        $("wireSearchStatus").textContent = message;
        $("wireSearchStatus").classList.remove("visually-hidden");
        $("wireSearchCoverage").textContent = "";
        $("wireSearchRetry").hidden = false;
        onAnalysis({ state: "unavailable", query: scope.value === "analysis" ? input.value : null });
    }
    function restoreResultFocus() {
        const current = state.snapshot(), context = getAnalysis();
        if (!restore || panel.hidden || !current.matches.receipt || context?.pending || current.matches.receipt.revision !== context?.revision
            || scope.value === "analysis" && analysisKey !== context?.key) return;
        lists.matches.scrollTop = restore.scroll.matches;
        panel.scrollTop = restore.panelScroll;
        const focused = [...lists[restore.set].querySelectorAll("button")].find(node => node.dataset.searchId === restore.focus);
        (focused || input).focus({ preventScroll: true }); restore = null;
    }
    function paint() {
        if (document.hidden) return;
        const current = state.snapshot(), status = current.status;
        panel.dataset.searchState = current.state;
        const partial = Boolean(current.matches.receipt && !contract.completeCoverage(status?.corpus, current.matches.receipt.queryTypes));
        const labels = { queued: "Searching...",
            building: "Preparing search...",
            searching: "Searching...", stale: "Saved content changed. Search again.",
            changing: "Saved content changed. Search again.",
            unavailable: "Search is unavailable. Try again.",
            disconnected: "Connect local search to begin.", closed: "Local search closed.", superseded: "A newer query replaced this read.",
            incomplete: "Search is incomplete. Some saved content could not be searched.",
            "no-match": "No matches. Try different words." };
        $("wireSearchStatus").textContent = !input.value.trim() ? ""
            : current.matches.receipt ? current.matches.total
                ? `${current.matches.total} ${partial ? "available " : ""}match${current.matches.total === 1 ? "" : "es"}`
                : partial ? labels.incomplete : labels["no-match"]
                : labels[current.state] || "Ready for a local search.";
        $("wireSearchStatus").classList.toggle("visually-hidden", Boolean(current.matches.total));
        $("wireSearchFilterLabel").textContent = ["Filters",
            scope.value === "analysis" ? "Current Analyze scope" : "",
            category.value ? category.selectedOptions[0].textContent : "",
        ].filter(Boolean).join(" · ");
        $("wireSearchCoverage").textContent = partial && current.matches.total ? "Some saved content is unavailable." : "";
        $("wireSearchCoverage").hidden = !$("wireSearchCoverage").textContent;
        $("wireSearchRetry").hidden = !input.value.trim() || !["disconnected", "stale", "unavailable", "closed", "changing"].includes(current.state);
        $("wireSearchRetry").textContent = connected ? "Retry search" : "Reconnect search";
        $("wireSearchMatches").hidden = !current.matches.total;
        $("wireSearchMatchesTitle").classList.add("visually-hidden");
        paintSet("matches", current.matches);
        restoreResultFocus();
    }
    function paintSet(key, value) {
        const hits = value?.hits ?? [], size = 20, pageCount = Math.ceil(hits.length / size);
        if (value?.receipt) pages[key] = Math.min(pages[key], Math.max(0, pageCount - 1));
        const draw = JSON.stringify([value?.receipt ?? null, pages[key]]);
        if (draw === drawnKeys[key]) return;
        drawnKeys[key] = draw;
        const list = lists[key], paging = pagers[key];
        list.replaceChildren();
        for (const hit of hits.slice(pages[key] * size, (pages[key] + 1) * size)) {
            const shown = presentHit(hit);
            const row = el("li"), target = button("", () => open(hit, key));
            target.className = "wire-search-hit"; target.dataset.searchId = hit.id;
            target.dataset.searchSet = key;
            if (hit.target.bundleId) target.dataset.searchBundle = hit.target.bundleId;
            const meta = el("span", undefined, "wire-search-meta"), body = el("span", undefined, "wire-search-body");
            const shorten = value => {
                const chars = Array.from(value.trim());
                return chars.length > 220 ? chars.slice(0, 220).join("") + "..." : value.trim();
            };
            const textParts = (node, parts) => {
                for (const part of parts) node.append(part.match ? el("mark", part.text) : document.createTextNode(part.text));
                return node;
            };
            const layer = hit.type === "action" && results.layers.includes(hit.coverage?.layer) ? hit.coverage.layer : null;
            const outcome = layer ? results.entries(layer, results.summarize([{ id: hit.id, outcome: hit.coverage.outcome }]))?.[0] : null;
            const format = hit.type === "report" && ["html", "json", "markdown", "pdf"].includes(hit.coverage?.format)
                ? hit.coverage.format === "markdown" ? "Markdown" : hit.coverage.format.toUpperCase() : null;
            const categoryLabel = ({ interaction: "Interaction", context: "Prompt context", reply: "Reply", action: "Recorded action",
                tool: "Tool", service: "Service", report: "Report", comparison: "Comparison", view: "View", setting: "Setting" })[hit.type];
            const kindLabel = layer ? results.unit(layer, 1) : categoryLabel;
            const iconRole = ({ interaction: "activity", context: "activity", reply: "activity", action: "activity",
                tool: "connection", service: "connection", report: "reports", comparison: "search-analysis",
                view: "search-analysis", setting: "settings" })[hit.type];
            const icon = ux?.icon?.(iconRole);
            if (icon) {
                const slot = el("span", undefined, "wire-search-type-icon");
                slot.setAttribute("aria-hidden", "true"); slot.append(icon); target.append(slot);
            }
            meta.append(el("span", kindLabel, "wire-search-kind"));
            if (format) meta.append(el("span", format, "wire-search-format"));
            if (outcome) {
                const cue = el("span", undefined, "wire-search-outcome result-tone-" + outcome.key);
                cue.append(ux.icon(outcome.icon), document.createTextNode(outcome.label)); meta.append(cue);
            }
            const sourceTitle = !shown.title.length;
            const title = textParts(el("strong", undefined, "wire-search-title" + (sourceTitle ? " wire-search-source" : "")), sourceTitle ? shown.source : shown.title);
            title.dir = "auto";
            body.append(title, meta);
            for (const field of ["source", "excerpt"]) if (shown[field].length && !(field === "source" && sourceTitle)) {
                const text = textParts(el("span", undefined, "wire-search-" + field), shown[field]);
                text.dir = "auto"; body.append(text);
            }
            const call = hit.target.kind === "route" && hit.target.href.startsWith("#request?")
                && new URLSearchParams(hit.target.href.split("?")[1]).has("call") && hit.coverage?.layer !== "code-reference";
            const destination = ["interaction", "context", "reply"].includes(hit.type) ? "Open interaction" : ["action", "tool", "service"].includes(hit.type)
                ? call ? "Open recorded call" : "Open in Analyze"
                : ({ report: "Open saved report", comparison: "Open saved comparison", setting: "Open setting", view: "Open view" })[hit.type];
            const limitation = hit.coverage?.completeness === "partial" || hit.coverage?.completeness === "bounded-fragment" ? "Only part of this text was saved."
                : hit.coverage?.completeness === "unavailable" ? "Saved text is unavailable." : "";
            target.setAttribute("aria-label", [`${destination}: ${shorten(hit.title)}; ${kindLabel}`,
                sourceTitle ? "Source match" : shown.source.map(part => part.text).join(""),
                shown.excerpt.map(part => part.text).join("").replace(/\s+/gu, " "),
                format, outcome?.label, limitation].filter(Boolean).join("; "));
            if (limitation) body.append(el("span", limitation, "wire-search-limitation"));
            target.append(body);
            row.append(target); list.append(row);
        }
        paging.replaceChildren();
        if (pageCount > 1) {
            const noun = "results";
            const previous = button("Previous " + noun, () => { restore = null; pages[key]--; paint(); list.querySelector("button")?.focus(); });
            const next = button("Next " + noun, () => { restore = null; pages[key]++; paint(); list.querySelector("button")?.focus(); });
            previous.disabled = !pages[key]; next.disabled = pages[key] >= pageCount - 1;
            paging.append(previous, el("span", `Page ${pages[key] + 1} of ${pageCount}; ${hits.length} total`), next);
        }
    }
    function receive(event) {
        const before = state.snapshot();
        if (document.hidden && ["results", "opened"].includes(event.event)) return;
        if (event.event === "connected") {
            connected = true; connecting = false;
            state.receive(event);
            if (!document.hidden) schedule(false);
        } else state.receive(event);
        if (event.panelId !== state.snapshot().panelId) return;
        clearTimeout(heartbeat);
        if (!document.hidden) heartbeat = setTimeout(() => fail("Search disconnected. Results were cleared. Reconnect to continue."), 5000);
        if (event.event === "heartbeat") return;
        if (event.event === "fence" && event.epoch > before.epoch) {
            if (["cancelled", "closed", "idle", "disconnected"].includes(event.reason)) resumeVisibleQuery = false;
            eraseDocument();
            onAnalysis({ state: "stale", query: scope.value === "analysis" ? input.value : null, revoked: true });
        }
        if (document.hidden && event.event === "status" && event.epoch === state.snapshot().epoch
            && ["unavailable", "closed"].includes(event.state)) { fail(); return; }
        if (event.event === "results" && state.snapshot().matches === event.matches && scope.value === "analysis"
            && contract.analysisReceipt(event.matches.receipt)) {
            onAnalysis({ state: "ready", query: input.value, hits: event.matches.hits, receipt: event.matches.receipt,
                complete: contract.completeCoverage(event.status?.corpus, event.matches.receipt.queryTypes), scopeKey: analysisKey });
        }
        if (event.event === "opened" && event.openId === openId && contract.sameReceipt(event.receipt, ownedReceipt())) {
            void showOpened(event.document, event.receipt, event.openId).catch(() => fail("The current item could not be displayed. Return to search and read it again."));
        }
        paint();
    }
    function connect() {
        if (connected || connecting || disposed || document.hidden) return;
        connecting = true;
        stream = new AbortController();
        const owned = stream;
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => fail("The local search connection did not become ready. No results were retained."), 10000);
        api.searchEvents(event => {
            if (stream === owned && !owned.signal.aborted) receive(event);
        }, { signal: owned.signal, schemaVersion: contract.schemaVersion }).catch(error => {
            if (!owned.signal.aborted && stream === owned) fail(failureMessage(error));
        });
    }
    function schedule(resetPage = true) {
        if (documentReturn) eraseDocument();
        clearTimeout(timer);
        if (!input.value.trim()) resumeVisibleQuery = false;
        openId++;
        const requestId = ++sequence;
        state.query(requestId, purpose(), types());
        if (resetPage && !restore) pages = { matches: 0 };
        analysisKey = getAnalysis()?.key ?? null;
        onAnalysis({ state: "pending", query: scope.value === "analysis" ? input.value : null, scopeKey: analysisKey });
        paint();
        if (document.hidden && input.value.trim()) return;
        if (!connected) { connect(); return; }
        timer = setTimeout(async () => {
            try {
                await api("/api/search/query", { schemaVersion: contract.schemaVersion, purpose: purpose(), query: input.value, requestId, types: types() }, { signal: stream.signal });
            } catch (error) { if (requestId === sequence && error.reason !== "search_cancelled") fail(failureMessage(error)); }
        }, 120);
    }
    function remember() {
        const key = crypto.randomUUID();
        returns.set(key, { query: input.value, scope: scope.value, category: category.value, pages: { ...pages },
            panelScroll: panel.scrollTop,
            scroll: { matches: lists.matches.scrollTop },
            set: document.activeElement?.dataset.searchSet || "matches", focus: document.activeElement?.dataset.searchId });
        // Only an opaque local navigation marker enters history, never global text or hits.
        history.replaceState({ ...history.state, wireSearchReturn: key }, "");
        return key;
    }
    async function open(hit, set) {
        const receipt = state.snapshot()[set]?.receipt, id = ++openId;
        if (!receipt || !connected) return;
        remember();
        $("wireSearchStatus").textContent = "Opening the exact current item...";
        try { await api("/api/search/open", { id: hit.id, receipt, openId: id }, { signal: stream.signal }); }
        catch (error) {
            if (id !== openId) return;
            state.query(++sequence, purpose(), types()); eraseLists(); paint();
            $("wireSearchStatus").textContent = failureMessage(error);
            $("wireSearchRetry").textContent = connected ? "Retry search" : "Reconnect search";
            $("wireSearchRetry").hidden = false;
        }
    }
    async function showOpened(value, receipt, id) {
        const returnKey = history.state?.wireSearchReturn;
        const isCurrent = () => !disposed && !document.hidden && connected && id === openId && contract.sameReceipt(receipt, ownedReceipt());
        hide();
        if (value.kind === "route") await navigate(value);
        else if (isCurrent()) {
            documentReturn = returnKey;
            if (!await presentDocument(value, { isCurrent, returnKey })) return;
        }
        if (!isCurrent()) return;
        const { wireSearchReturn, ...next } = history.state || {};
        history.replaceState(next, "");
    }
    input.addEventListener("focus", () => { show(); paint(); });
    input.addEventListener("click", () => { if (panel.hidden) { show(); paint(); } });
    input.addEventListener("input", () => { restore = null; panel.scrollTop = 0; show(); schedule(); });
    scope.addEventListener("change", () => {
        restore = null;
        syncScope();
        schedule();
    });
    category.addEventListener("change", () => { restore = null; schedule(); });
    $("wireSearchClear").addEventListener("click", () => { restore = null; input.value = ""; show(); schedule(); input.focus(); });
    $("wireSearchRetry").addEventListener("click", () => { connected ? schedule() : connect(); });
    input.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (event.key === "ArrowDown") { event.preventDefault(); show(); lists.matches.querySelector("button")?.focus(); }
        if (event.key === "Escape") { event.preventDefault(); hide(); }
    });
    for (const list of Object.values(lists)) list.addEventListener("keydown", event => {
        const nodes = Object.values(lists).flatMap(list => [...list.querySelectorAll("button")]), index = nodes.indexOf(document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
            (nodes[next] || input).focus();
        }
    });
    function restoreSearch(key) {
        documentReturn = null;
        const saved = !disposed && returns.get(key);
        if (!saved) { hide(); return false; }
        input.value = saved.query; scope.value = saved.scope; category.value = saved.category;
        syncScope();
        pages = { ...saved.pages }; restore = saved; show(); schedule(false);
        return true;
    }
    window.addEventListener("popstate", () => restoreSearch(history.state?.wireSearchReturn));
    home.addEventListener("keydown", event => {
        if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault(); input.focus({ preventScroll: true }); hide();
        }
    });
    for (const type of ["pointerdown", "focusin"]) document.addEventListener(type, event => {
        if (!home.contains(event.target) && !event.target.closest(".select-popup")) hide();
    });
    for (const type of ["pointerdown", "keydown", "wheel", "touchmove"]) {
        document.addEventListener(type, event => { if (event.isTrusted) restore = null; }, { capture: true, passive: true });
    }
    window.addEventListener("pagehide", () => { disposed = true; returns.clear(); input.value = ""; show(); fail(); });
    window.addEventListener("pageshow", () => { disposed = false; });
    document.addEventListener("visibilitychange", () => {
        if (disposed || hidden === document.hidden) return;
        hidden = document.hidden;
        if (hidden) {
            resumeVisibleQuery = Boolean(input.value.trim()) && (connected || connecting);
            clearTimeout(timer); clearTimeout(heartbeat); openId++;
            // Retain bounded owned preparation, not disclosure or admission.
            // The visible return must submit a fresh sequence against current sources.
            if (resumeVisibleQuery) state.query(++sequence, purpose(), types());
            eraseLists(); eraseDocument(); hide();
            onAnalysis({ state: resumeVisibleQuery ? "pending" : "unavailable",
                query: scope.value === "analysis" ? input.value : null, scopeKey: analysisKey });
        } else if (resumeVisibleQuery) {
            resumeVisibleQuery = false;
            heartbeat = setTimeout(() => fail("Search disconnected. Results were cleared. Reconnect to continue."), connecting ? 10000 : 5000);
            if (connected) schedule(false);
        } else if (connected) paint();
    });
    paint();
    return {
        invalidate: fail,
        restore: restoreSearch,
        canRestore: key => !disposed && returns.has(key),
        returnKey: () => !disposed && returns.has(history.state?.wireSearchReturn) ? history.state.wireSearchReturn : null,
        sessionChanged() {
            returns.clear();
            if (!connecting) { fail(); return; }
            state.disconnect(); eraseLists(); eraseDocument();
            onAnalysis({ state: "stale", query: scope.value === "analysis" ? input.value : null, revoked: true });
        },
        analysisScope() {
            if (scope.value !== "analysis") { scope.value = "analysis"; scope.dispatchEvent(new Event("change")); }
            show(); input.focus();
        },
        changed() {
            const context = getAnalysis();
            if (scope.value === "analysis" && input.value && context?.active && !context.pending
                && (analysisKey !== context.key || context.needsRebind && state.snapshot().matches.receipt)) {
                schedule(!restore);
            } else if (restore) paint();
        },
    };
}
