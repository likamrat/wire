import { uxIcons } from "./ux-icons.mjs";

export const liveSearchPanel = `
<section id="wireSearchPanel" class="wire-search-panel" aria-labelledby="wireSearchTitle" hidden>
  <h2 id="wireSearchTitle" class="visually-hidden">Search results</h2>
  <p id="wireSearchScopeNote" hidden>Search your saved activity and reports. This does not collect new data.</p>
  <p id="wireSearchStatus" role="status" aria-live="polite"></p>
  <button id="wireSearchRetry" type="button" class="quiet" hidden>Reconnect search</button>
  <div class="wire-search-health">
    <p id="wireSearchCoverage" class="muted"></p>
    <a id="wireSearchTroubleshooting" class="text-link" href="#settings?section=troubleshooting&amp;setting=settings-search" hidden>Search troubleshooting</a>
  </div>
  <section id="wireSearchMatches" class="wire-search-set" aria-labelledby="wireSearchMatchesTitle" hidden>
    <h3 id="wireSearchMatchesTitle">Matches</h3>
    <ol id="wireSearchResults" class="wire-search-results" aria-label="Search results"></ol>
    <div id="wireSearchPaging" class="wire-search-paging"></div>
  </section>
  <section id="wireSearchRelated" class="wire-search-set" aria-labelledby="wireSearchRelatedTitle" hidden>
    <h3 id="wireSearchRelatedTitle">Related results</h3>
    <p class="muted">Similar topics, possibly different work. These do not change your charts or report selection.</p>
    <p id="wireSearchRelatedCount" class="visually-hidden"></p>
    <ol id="wireSearchRelatedResults" class="wire-search-results" aria-label="Related results"></ol>
    <div id="wireSearchRelatedPaging" class="wire-search-paging"></div>
  </section>
  <details id="wireSearchOptions" class="wire-search-options">
    <summary id="wireSearchFilterSummary">Filters</summary>
    <div class="wire-search-filters">
      <label>Search scope<select id="wireSearchScope"><option value="everywhere">Everywhere</option><option value="analysis">Current Analyze scope</option></select></label>
      <label>Result type<select id="wireSearchType"><option value="">All types</option><option value="interaction">Interactions</option><option value="context">Conversation context</option><option value="reply">Retained replies</option><option value="action">Recorded actions</option><option value="tool">Tools</option><option value="service">Services</option><option value="report">Saved reports</option><option value="comparison">Saved comparisons</option><option value="view">Views</option><option value="setting">Settings</option></select></label>
      <button id="wireSearchClear" type="button" class="quiet">Clear search</button>
    </div>
  </details>
</section>`;

export const liveSearchMarkup = `
<div id="wireSearchHome" class="wire-search-entry">
  <label for="wireSearch" class="visually-hidden">Search</label>
  <span class="wire-search-icon">${uxIcons.search}</span>
  <input id="wireSearch" type="search" placeholder="Search" autocomplete="off" spellcheck="false" aria-controls="wireSearchPanel" aria-expanded="false">
  ${liveSearchPanel}
</div>`;

export const liveSearchStyles = `
/* The sticky field is above the page reading inset; don't apply that inset to native caret scrolling. */
html:has(.wire-search-entry:focus-within) {scroll-padding-top:0}
.wire-search-entry {position:relative;display:grid;grid-template-columns:minmax(0,1fr);align-items:center;flex:1 1 280px;min-width:180px;max-width:480px}
.wire-search-entry>label {font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-medium);white-space:nowrap}
.wire-search-icon {position:absolute;inset-inline-start:14px;top:50%;transform:translateY(-50%);display:flex;pointer-events:none;color:var(--muted)}
.wire-search-icon .fluent-icon {width:20px;height:20px}
#wireSearch {width:100%;min-width:0;min-height:var(--pill-height);border-radius:var(--radius-pill);padding-inline:42px var(--pill-inset);background:var(--paper);box-shadow:var(--surface-shadow)}
.wire-search-panel {position:absolute;inset-inline:0;top:calc(100% + 8px);margin:0;min-width:0;padding:8px;background:var(--paper);border:1px solid var(--rule);border-radius:16px;box-shadow:var(--surface-shadow);max-height:min(30rem,calc(100dvh - var(--app-header-height,148px) - 24px));overflow-y:auto;overscroll-behavior:contain;scroll-padding:8px}
.wire-search-options {border-top:1px solid var(--rule);margin-top:4px;padding-inline:8px}
.wire-search-options>summary {min-height:44px;padding-block:12px;cursor:pointer;overflow-wrap:anywhere;font-size:var(--type-caption);color:var(--muted)}
.wire-search-filters,.wire-search-paging {display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.wire-search-filters label {display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:4px;font-size:var(--type-caption)}
.wire-search-filters .select-trigger .select-value {white-space:normal;overflow-wrap:anywhere;text-overflow:clip}
.wire-search-panel > p:not(.visually-hidden):not(:empty) {margin:8px}
.wire-search-health {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;padding-inline:8px;font-size:var(--type-caption)}
.wire-search-health p {margin:8px 0}
.wire-search-set {margin:0;min-width:0}
.wire-search-set>h3:not(.visually-hidden),.wire-search-set>p:not(.visually-hidden) {margin:8px;font-size:var(--type-caption)}
.wire-search-results {padding:4px;margin:0;list-style:none}
.wire-search-results .wire-search-hit {display:grid;gap:4px;width:100%;text-align:start;border:0;border-radius:var(--radius-small);background:transparent;color:var(--ink);padding:10px 8px}
#wireSearchPanel .wire-search-hit::before {content:none}
#wireSearchPanel .wire-search-hit:is(:hover,:active):not(:disabled)::before {content:"";inset:0;border:0}
.wire-search-hit strong {font-size:var(--type-body);font-weight:var(--weight-medium)}
.wire-search-excerpt {white-space:pre-wrap;overflow-wrap:anywhere;font-weight:var(--weight-regular);line-height:var(--leading-ui)}
.wire-search-meta,.wire-search-limitation {font-size:var(--type-caption);font-weight:var(--weight-regular);color:var(--muted);overflow-wrap:anywhere}
.wire-search-meta {display:flex;gap:4px 6px;flex-wrap:wrap;align-items:center}
.wire-search-kind {color:var(--muted)}
.wire-search-paging:not(:empty) {padding:8px;font-size:var(--type-caption)}
.wire-search-document pre {white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font);line-height:var(--leading-ui)}
.wire-search-document .report-frame {width:100%;min-height:65vh;border:1px solid var(--rule)}
@media(max-width:600px) {
 .wire-search-entry {flex-basis:100%;max-width:none}
 .wire-search-filters {align-items:stretch}
 .wire-search-filters>label,.wire-search-filters>.select-field {flex:1 1 240px}
}
@media(forced-colors:active) {
 .wire-search-panel,#wireSearch {box-shadow:none;border-color:CanvasText}
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

export function mountLiveSearch({ api, createState, frozenFrame, navigate, getAnalysis, onAnalysis, onInvalidateOpen, contract }) {
    const $ = id => document.getElementById(id);
    const input = $("wireSearch"), panel = $("wireSearchPanel"), list = $("wireSearchResults");
    const home = $("wireSearchHome");
    const scope = $("wireSearchScope"), category = $("wireSearchType"), state = createState();
    const lists = { matches: list, related: $("wireSearchRelatedResults") };
    const pagers = { matches: $("wireSearchPaging"), related: $("wireSearchRelatedPaging") };
    const returns = new Map();
    let stream, timer, heartbeat, sequence = 0, openId = 0, restore, analysisKey = null, dialog;
    let pages = { matches: 0, related: 0 }, drawnKeys = { matches: null, related: null };
    let connected = false, connecting = false, disposed = false;
    let hidden = document.hidden, resumeVisibleQuery = false;
    const purpose = () => scope.value === "analysis" ? "analysis" : "navigation";
    const types = () => scope.value === "analysis" ? ["interaction", "context", "reply", "action"] : category.value ? [category.value] : [];
    const ownedReceipt = receipt => state.snapshot()[receipt?.purpose === "related-navigation" ? "related" : "matches"]?.receipt;
    function eraseLists() {
        for (const key of ["matches", "related"]) { lists[key].replaceChildren(); pagers[key].replaceChildren(); drawnKeys[key] = null; }
        $("wireSearchMatches").hidden = $("wireSearchRelated").hidden = true;
        $("wireSearchRelatedCount").textContent = "";
    }
    function el(tag, text, cls) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(text, action) {
        const node = el("button", text, "quiet"); node.type = "button"; node.addEventListener("click", action); return node;
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
        onInvalidateOpen();
        if (dialog) dialog.querySelector(".assessment-dialog-body").replaceChildren(el("p",
            "The available content changed. Return to Search and open this item again."));
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
        $("wireSearchTroubleshooting").hidden = true;
        $("wireSearchRetry").hidden = false;
        onAnalysis({ state: "unavailable", query: scope.value === "analysis" ? input.value : null });
    }
    function restoreResultFocus() {
        const current = state.snapshot(), context = getAnalysis();
        if (!restore || panel.hidden || !current.matches.receipt || context?.pending || current.matches.receipt.revision !== context?.revision
            || scope.value === "analysis" && analysisKey !== context?.key) return;
        for (const key of ["matches", "related"]) lists[key].scrollTop = restore.scroll[key];
        panel.scrollTop = restore.panelScroll;
        const focused = [...lists[restore.set].querySelectorAll("button")].find(node => node.dataset.searchId === restore.focus);
        (focused || input).focus({ preventScroll: true }); restore = null;
    }
    function paint() {
        if (document.hidden) return;
        const current = state.snapshot(), status = current.status;
        const partial = status?.corpus?.state === "partial"
            && (current.purpose !== "analysis" || !contract.completeCoverage(status.corpus, current.matches.receipt?.queryTypes));
        const wordSearchAvailable = Boolean(current.matches.receipt && status?.mode === "lexical-only");
        const labels = { queued: "Searching...",
            building: "Preparing search...",
            searching: "Searching...", stale: "Saved content changed. Search again.",
            changing: "Saved content changed. Search again.",
            unavailable: "Search is unavailable. Try again.",
            disconnected: "Connect local search to begin.", closed: "Local search closed.", superseded: "A newer query replaced this read.",
            "no-match": "No matches. Try different words." };
        $("wireSearchStatus").textContent = !input.value.trim() ? ""
            : current.matches.receipt ? current.matches.total
                ? `${current.matches.total} ${partial ? "available " : ""}match${current.matches.total === 1 ? "" : "es"}`
                : current.related?.total ? "No matches. Related results may help you find the saved item."
                    : "No matches. Try different words."
                : labels[current.state] || "Ready for a local search.";
        $("wireSearchStatus").classList.toggle("visually-hidden", Boolean(current.matches.total || current.related?.total));
        $("wireSearchFilterSummary").textContent = ["Filters",
            scope.value === "analysis" ? "Current Analyze scope" : "",
            category.value ? category.selectedOptions[0].textContent : "",
        ].filter(Boolean).join(" · ");
        $("wireSearchCoverage").textContent = [
            wordSearchAvailable ? "Word search only." : "",
            partial ? "Some saved content is unavailable." : "",
        ].filter(Boolean).join(" ");
        $("wireSearchCoverage").hidden = !$("wireSearchCoverage").textContent;
        $("wireSearchTroubleshooting").hidden = !wordSearchAvailable;
        $("wireSearchRetry").hidden = !input.value.trim() || !["disconnected", "stale", "unavailable", "closed", "changing"].includes(current.state);
        $("wireSearchRetry").textContent = connected ? "Retry search" : "Reconnect search";
        $("wireSearchMatches").hidden = !current.matches.total;
        $("wireSearchMatchesTitle").classList.toggle("visually-hidden", !current.related?.total);
        $("wireSearchRelated").hidden = current.purpose !== "navigation" || !current.related?.total;
        $("wireSearchRelatedCount").textContent = current.related?.total
            ? `${current.related.total} suggestion${current.related.total === 1 ? "" : "s"}` : "";
        for (const key of ["matches", "related"]) paintSet(key, current[key]);
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
            const row = el("li"), target = button("", () => open(hit, key));
            target.className = "wire-search-hit"; target.dataset.searchId = hit.id;
            target.dataset.searchSet = key;
            if (hit.target.bundleId) target.dataset.searchBundle = hit.target.bundleId;
            const meta = el("span", undefined, "wire-search-meta");
            const lines = hit.excerpt.trim().split("\n");
            while (lines[0]?.trim() === hit.title) lines.shift();
            if (lines.at(-1)?.trim() === hit.source.label) lines.pop();
            const shorten = value => {
                const chars = Array.from(value.trim());
                return chars.length > 220 ? chars.slice(0, 220).join("") + "..." : value.trim();
            };
            const interaction = ["interaction", "context", "reply"].includes(hit.type);
            const title = interaction && lines[0]?.trim() ? lines.shift().trim() : hit.title;
            const excerpt = interaction || ["tool", "service", "view", "setting"].includes(hit.type) ? ""
                : hit.type === "action" ? lines.find(line => /\p{L}.*\s.*\p{L}/u.test(line)
                    && !/^\s*(?:[{\[]|(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s|https?:|\/)/i.test(line)) || ""
                    : lines.find(line => line.trim() && line.trim() !== title) || "";
            target.append(el("strong", shorten(title)));
            if (excerpt) target.append(el("span", shorten(excerpt), "wire-search-excerpt"));
            const outcome = ({ success: "Succeeded", failure: "Failed", partial: "Partial result", transport: "No response" })[hit.coverage?.outcome];
            const sourceLabel = hit.type === "setting" && hit.source.label.startsWith("Settings / ") ? hit.source.label.slice(11)
                : hit.type === "view" && hit.target.kind === "route"
                    ? ({ analyze: "Analyze", reports: "Reports", settings: "Settings", "collection-status": "Collection status" })[hit.target.href.slice(1).split("?")[0]] || hit.source.label
                    : hit.source.label;
            meta.append(el("span", hit.category, "wire-search-kind"), el("span", "·"), el("span", sourceLabel),
                ...(outcome ? [el("span", "·"), el("span", outcome)] : []));
            target.append(meta);
            const call = hit.target.kind === "route" && hit.target.href.startsWith("#request?")
                && new URLSearchParams(hit.target.href.split("?")[1]).has("call") && hit.coverage?.layer !== "code-reference";
            const destination = interaction ? "Open interaction" : ["action", "tool", "service"].includes(hit.type)
                ? call ? "Open recorded call" : "Open in Analyze"
                : ({ report: "Open saved report", comparison: "Open saved comparison", setting: "Open setting", view: "Open view" })[hit.type];
            const limitation = hit.coverage?.completeness === "partial" || hit.coverage?.completeness === "bounded-fragment" ? "Only part of this text was saved."
                : hit.coverage?.completeness === "unavailable" ? "Saved text is unavailable." : "";
            target.setAttribute("aria-label", [`${destination}: ${shorten(title)}; ${hit.category}; ${sourceLabel}`,
                outcome, limitation].filter(Boolean).join("; "));
            if (limitation) target.append(el("span", limitation, "wire-search-limitation"));
            row.append(target); list.append(row);
        }
        paging.replaceChildren();
        if (pageCount > 1) {
            const noun = key === "related" ? "suggestions" : "results";
            const previous = button("Previous " + noun, () => { restore = null; pages[key]--; paint(); list.querySelector("button")?.focus(); });
            const next = button("Next " + noun, () => { restore = null; pages[key]++; paint(); list.querySelector("button")?.focus(); });
            previous.disabled = !pages[key]; next.disabled = pages[key] >= pageCount - 1;
            paging.append(previous, el("span", `Page ${pages[key] + 1} of ${pageCount}; ${hits.length} ${key === "related" ? "suggestions" : "total"}`), next);
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
        if (event.event === "opened" && event.openId === openId && contract.sameReceipt(event.receipt, ownedReceipt(event.receipt))) {
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
        }, { signal: owned.signal }).catch(error => {
            if (!owned.signal.aborted && stream === owned) fail(failureMessage(error));
        });
    }
    function schedule(resetPage = true) {
        clearTimeout(timer);
        if (!input.value.trim()) resumeVisibleQuery = false;
        openId++;
        const requestId = ++sequence;
        state.query(requestId, purpose(), types());
        if (resetPage && !restore) pages = { matches: 0, related: 0 };
        analysisKey = getAnalysis()?.key ?? null;
        onAnalysis({ state: "pending", query: scope.value === "analysis" ? input.value : null, scopeKey: analysisKey });
        paint();
        if (document.hidden && input.value.trim()) return;
        if (!connected) { connect(); return; }
        timer = setTimeout(async () => {
            try {
                await api("/api/search/query", { schemaVersion: 2, purpose: purpose(), query: input.value, requestId, types: types() }, { signal: stream.signal });
            } catch (error) { if (requestId === sequence && error.reason !== "search_cancelled") fail(failureMessage(error)); }
        }, 120);
    }
    function remember() {
        const key = crypto.randomUUID();
        returns.set(key, { query: input.value, scope: scope.value, category: category.value, pages: { ...pages },
            panelScroll: panel.scrollTop,
            scroll: { matches: lists.matches.scrollTop, related: lists.related.scrollTop },
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
        hide();
        await navigate(value.kind === "route" ? value : { kind: "route", href: "#reports" });
        if (id !== openId || !contract.sameReceipt(receipt, ownedReceipt(receipt))) return;
        const { wireSearchReturn, ...next } = history.state || {};
        history.replaceState(next, "");
        if (value.kind === "route") return;
        if (!["html", "json", "markdown", "pdf"].includes(value.kind)) throw new Error("Unsupported verified saved-file format.");
        const label = value.artifact?.kind === "comparison" ? "Saved comparison"
            : value.artifact?.reportType === "period-comparison" ? "Saved period comparison report" : "Saved report";
        dialog?.close();
        dialog = el("dialog", undefined, "assessment-dialog saved-report-dialog wire-search-document");
        dialog.setAttribute("aria-label", label);
        const heading = el("div", undefined, "dialog-head"), body = el("div", undefined, "assessment-dialog-body");
        heading.append(el("h2", label + " / " + value.kind.toUpperCase()),
            button("Back to search", () => history.back()));
        body.append(el("p", "Verified frozen saved copy. Nothing was regenerated."));
        if (value.artifact?.sourceReports?.some(source => !source.available)) body.append(el("p",
            "An original report is no longer available. This independently reviewed saved copy is unchanged."));
        if (value.kind === "html") {
            const frame = frozenFrame(value.text);
            frame.title = "Frozen " + label.toLowerCase();
            body.append(frame);
        }
        else if (["json", "markdown"].includes(value.kind)) body.append(el("pre", value.text));
        else if (value.kind === "pdf") {
            const bytes = Uint8Array.from(atob(value.data), character => character.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
            const anchor = el("a"); anchor.href = url; anchor.download = value.name ?? "product-report.pdf"; anchor.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            body.append(el("p", "The verified PDF was downloaded by your explicit Open action. No PDF scripting or external resources run in WIRE."));
        }
        dialog.append(heading, body); document.body.append(dialog);
        dialog.addEventListener("cancel", event => { event.preventDefault(); history.back(); });
        dialog.addEventListener("close", () => { dialog?.remove(); dialog = null; }, { once: true });
        dialog.showModal(); heading.querySelector("button").focus();
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
    $("wireSearchClear").addEventListener("click", () => { restore = null; input.value = ""; schedule(); input.focus(); });
    $("wireSearchRetry").addEventListener("click", () => { connected ? schedule() : connect(); });
    $("wireSearchTroubleshooting").addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); hide();
        void navigate({ kind: "route", href: "#settings?section=troubleshooting&setting=settings-search" });
    });
    input.addEventListener("keydown", event => {
        if (event.isComposing) return;
        if (event.key === "ArrowDown") { event.preventDefault(); show(); (lists.matches.querySelector("button") || lists.related.querySelector("button"))?.focus(); }
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
        if (dialog) dialog.close();
        const saved = !disposed && returns.get(key);
        if (!saved) { hide(); return false; }
        input.value = saved.query; scope.value = saved.scope; category.value = saved.category;
        syncScope();
        pages = { ...saved.pages }; restore = saved; show(); schedule(false);
        return true;
    }
    window.addEventListener("popstate", () => restoreSearch(history.state?.wireSearchReturn));
    panel.addEventListener("keydown", event => {
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
    window.addEventListener("pagehide", () => { disposed = true; returns.clear(); input.value = ""; fail(); });
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
