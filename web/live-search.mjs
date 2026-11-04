import { searchFieldMarkup } from "./search-field.mjs";

export function searchHitPresentation(hit, { showSource = true } = {}) {
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
    const saved = ["report", "comparison"].includes(hit.type) && hit.source.kind === "saved-" + hit.type;
    if (saved && field !== "source" && hit.source.label === "Approved frozen " + hit.type) shown.source = [];
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
        const leftText = left.replace(/\s+/gu, " "), rightText = right.replace(/\s+/gu, " ");
        // Keep each omission mark attached to its context rather than on a line of its own.
        shown.excerpt = [
            { text: left.length < prefix.length ? "\u2026\u00a0" + leftText.trimStart() : leftText, match: false },
            { text: hit.excerpt.slice(from, to), match: true },
            { text: right.length < suffix.length ? rightText.trimEnd() + "\u00a0\u2026" : rightText, match: false },
        ].filter(part => part.text);
    }
    if (field !== "source" && hit.type === "view" && hit.target?.kind === "route" && typeof hit.target.href === "string") {
        const names = { analyze: "Analyze", reports: "Reports", settings: "Settings", "collection-status": "Collection status" };
        const view = hit.target.href.slice(1).split("?")[0];
        if (Object.hasOwn(names, view)) shown.source = names[view] === hit.title ? [] : plain(names[view]);
    }
    if (!showSource && field !== "source") shown.source = [];
    return shown;
}

export const liveSearchPanel = `
<section id="wireSearchPanel" class="wire-search-panel" aria-labelledby="wireSearchTitle" hidden>
  <h2 id="wireSearchTitle" class="visually-hidden">Search results</h2>
  <div class="wire-search-filters" role="group" aria-label="Search filters">
    <label for="wireSearchScope" class="visually-hidden">Search scope</label>
    <select id="wireSearchScope" data-select-presentation="filter"><option value="everywhere">Everywhere</option><option value="analysis">Current Analyze scope</option></select>
    <label for="wireSearchType" class="visually-hidden">Result type</label>
    <select id="wireSearchType" data-select-presentation="filter"><option value="">All types</option><option value="interaction">Interactions</option><option value="context">Conversation context</option><option value="reply">Retained replies</option><option value="action">Recorded actions</option><option value="tool">Tools</option><option value="service">Services</option><option value="report">Saved reports</option><option value="comparison">Saved comparisons</option><option value="view">Views</option><option value="setting">Settings</option></select>
  </div>
  <p id="wireSearchScopeNote" hidden>Search your saved activity and reports. This does not collect new data.</p>
  <p id="wireSearchStatus" role="status" aria-live="polite"></p>
  <button id="wireSearchRetry" type="button" class="quiet" hidden>Reconnect search</button>
  <section id="wireSearchMatches" class="wire-search-set" aria-labelledby="wireSearchMatchesTitle" hidden>
    <h3 id="wireSearchMatchesTitle"><span id="wireSearchCount">Matches</span> <span id="wireSearchCoverage"></span></h3>
    <ol id="wireSearchResults" class="wire-search-results" aria-label="Search results"></ol>
    <div id="wireSearchPaging" class="wire-search-paging"></div>
  </section>
</section>`;

export const liveSearchMarkup = `
<div id="wireSearchHome" class="wire-search-entry">
  <label for="wireSearch" class="visually-hidden">Search</label>
  ${searchFieldMarkup({ id: "wireSearch", clearId: "wireSearchClear", controls: "wireSearchPanel" })}
  ${liveSearchPanel}
</div>`;

export const liveSearchStyles = `
/* The sticky field is above the page reading inset; don't apply that inset to native caret scrolling. */
html:has(.wire-search-entry:focus-within) {scroll-padding-top:0}
.wire-search-entry {position:relative;display:grid;grid-template-columns:minmax(0,1fr);align-items:center;flex:1 1 280px;min-width:180px;max-width:480px}
.wire-search-entry>label {font-size:var(--type-control);line-height:var(--leading-control);font-weight:var(--weight-medium);white-space:nowrap}
.wire-search-panel {--wire-search-match:#006580;position:absolute;inset-inline:0;top:calc(100% + 8px);margin:0;min-width:0;padding:8px;background:var(--paper);border:1px solid var(--surface-edge);border-radius:16px;box-shadow:var(--surface-shadow);font:var(--type-body)/var(--leading-ui) var(--font);max-height:min(30rem,calc(100dvh - var(--app-header-height,148px) - 24px));overflow-y:auto;overscroll-behavior:contain;scroll-padding:8px}
@media(prefers-color-scheme:dark) {
 :root:not([data-evidence-theme]) .wire-search-panel {--wire-search-match:#67c9df}
}
:root[data-evidence-theme=dark] .wire-search-panel {--wire-search-match:#67c9df}
.wire-search-filters,.wire-search-paging {display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.wire-search-filters {gap:8px;padding:4px 6px 8px}
.wire-search-panel > p:not(.visually-hidden):not(:empty) {margin:8px}
#wireSearchMatchesTitle {display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-xs) var(--space-md)}
#wireSearchMatchesTitle>span {min-width:0;overflow-wrap:anywhere}
#wireSearchCount {color:var(--ink)}
.wire-search-set {margin:0;min-width:0}
.wire-search-set>h3:not(.visually-hidden),.wire-search-set>p:not(.visually-hidden) {margin:8px 6px 4px 34px;font:inherit;color:var(--muted)}
.wire-search-results {padding:0;margin:0;list-style:none}
.wire-search-results>li+li {margin-top:2px}
.wire-search-group-label {margin:10px 6px 2px 34px;font:inherit;color:var(--search-category)}
#wireSearchPanel .wire-search-hit {display:grid;grid-template-columns:20px minmax(0,1fr);align-items:start;gap:8px;width:100%;min-height:44px;text-align:start;border:0;border-radius:var(--radius-small);background:transparent;color:var(--ink);font:inherit;padding:10px 6px}
#wireSearchPanel .wire-search-hit::before {content:none;background:transparent;border:0;box-shadow:none}
#wireSearchPanel .wire-search-hit:is(:hover,:focus-visible):not(:disabled) .wire-search-title {color:var(--accent)}
#wireSearchPanel .wire-search-hit:active:not(:disabled) .wire-search-title {color:var(--ink)}
.wire-search-body {grid-column:2;display:grid;gap:4px;min-width:0}
.wire-search-heading {min-width:0;overflow-wrap:anywhere}
.wire-search-title {font:inherit;min-width:0;overflow-wrap:anywhere}
.wire-search-hit mark {background:var(--accent-soft);color:var(--wire-search-match);font-weight:600;text-decoration:none}
.wire-search-excerpt {white-space:normal;overflow-wrap:anywhere;font:inherit;color:var(--muted)}
.wire-search-meta,.wire-search-source,.wire-search-limitation {font:inherit;color:var(--muted);min-width:0;overflow-wrap:anywhere}
.wire-search-meta {display:flex;gap:4px 8px;flex-wrap:wrap;align-items:baseline}
.wire-search-results>[data-search-category=interaction] {--search-category:var(--search-interaction)}
.wire-search-results>[data-search-category=context] {--search-category:var(--search-context)}
.wire-search-results>[data-search-category=reply] {--search-category:var(--search-reply)}
.wire-search-results>[data-search-category=action] {--search-category:var(--search-action)}
.wire-search-results>[data-search-category=tool] {--search-category:var(--search-tool)}
.wire-search-results>[data-search-category=service] {--search-category:var(--search-service)}
.wire-search-results>[data-search-category=report] {--search-category:var(--search-report)}
.wire-search-results>[data-search-category=comparison] {--search-category:var(--search-comparison)}
.wire-search-results>[data-search-category=view] {--search-category:var(--search-view)}
.wire-search-results>[data-search-category=setting] {--search-category:var(--search-setting)}
.wire-search-kind,.wire-search-type-icon {color:var(--search-category)}
.wire-search-type-icon {grid-column:1;grid-row:1;display:flex;align-items:center;justify-content:center;height:1lh}
.wire-search-outcome {display:inline-flex;align-items:center;gap:4px;color:var(--cue-color)}
.wire-search-source {display:block}
.wire-search-title.wire-search-source {color:var(--ink)}
.wire-search-paging:not(:empty) {padding:8px 10px;font:inherit}
@media(max-width:600px) {
 .wire-search-entry {flex-basis:100%;max-width:none}
 .wire-search-filters>.select-control {max-width:100%}
}
@media(forced-colors:active) {
 .wire-search-panel {box-shadow:none;border-color:CanvasText;background:Canvas}
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
    // Keep body styling in a document without a browsing context.
    const parsed = doc.implementation.createHTMLDocument("");
    parsed.documentElement.innerHTML = html;
    parsed.querySelectorAll("base,iframe,frame,object,embed,script").forEach(node => node.remove());
    parsed.querySelectorAll("meta[http-equiv]").forEach(node => {
        if (node.getAttribute("http-equiv").trim().toLowerCase() !== "content-security-policy") node.remove();
    });
    parsed.querySelectorAll("[href],[xlink\\:href]").forEach(node => {
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
    frame.srcdoc = "<!doctype html>" + root.outerHTML.replace("</html>", () => isolation + parsed.head.outerHTML + parsed.body.outerHTML + "</html>");
    return frame;
}

export function mountLiveSearch({ api, createState, navigate, presentDocument, getAnalysis, onAnalysis, onInvalidateOpen, contract, ux, searchFields, results, presentHit, serviceIcon, nativeSearch }) {
    if (typeof api.publicationToken !== "function" || typeof api.isCurrent !== "function" || typeof api.accessState !== "function") {
        throw new TypeError("Search requires the shared access publication fence.");
    }
    const $ = id => document.getElementById(id);
    const input = $("wireSearch"), panel = $("wireSearchPanel"), list = $("wireSearchResults");
    const home = $("wireSearchHome");
    const scope = $("wireSearchScope"), category = $("wireSearchType"), state = createState();
    const lists = { matches: list };
    const pagers = { matches: $("wireSearchPaging") };
    const returns = new Map();
    const preparations = new Set();
    let stream, timer, heartbeat, sequence = 0, openId = 0, restore, analysisKey = null, documentReturn = null;
    let pages = { matches: 0 }, drawnKeys = { matches: null };
    let connected = false, connecting = false, disposed = false, queryActive = false;
    let hidden = document.hidden, resumeVisibleQuery = false, returnRecovery = false, failure = null;
    let suspendedPresentation = null, windowAway = false, ownerReleased = false, releaseFence = null;
    let accessWithdrawn = false, accessVersion = 0, streamAuthority = null;
    const inactive = () => accessWithdrawn || disposed || document.hidden || windowAway;
    function currentToken(token, version) {
        if (version !== accessVersion || token === null || token === undefined) return false;
        if (typeof token.then === "function" || version !== accessVersion) return false;
        return api.isCurrent(token) === true && version === accessVersion;
    }
    function isPublished(authority) {
        if (accessWithdrawn || !authority || authority.version !== accessVersion) return false;
        const { token, version } = authority, current = currentToken(token, version);
        if (accessWithdrawn || version !== accessVersion || authority.token !== token) return false;
        if (current) return true;
        withdrawAccess();
        return false;
    }
    function publication() {
        if (accessWithdrawn) return null;
        const version = accessVersion, authority = { token: api.publicationToken(), version };
        return isPublished(authority) ? authority : null;
    }
    function clearPreparations() {
        for (const prepared of preparations) prepared.value = prepared.receipt = prepared.authority = null;
        preparations.clear();
    }
    function withdrawAccess() {
        const notify = !accessWithdrawn;
        accessWithdrawn = true;
        accessVersion++;
        nativeSearch?.withdraw();
        if (notify) { sequence++; openId++; }
        connected = connecting = queryActive = resumeVisibleQuery = returnRecovery = ownerReleased = false;
        restore = suspendedPresentation = releaseFence = streamAuthority = analysisKey = documentReturn = failure = null;
        clearTimeout(timer); clearTimeout(heartbeat);
        const retired = stream; stream = null;
        retired?.abort();
        returns.clear(); clearPreparations(); state.disconnect(); eraseLists();
        pages = { matches: 0 };
        input.disabled = scope.disabled = category.disabled = true;
        field.sync("");
        hide();
        panel.scrollTop = list.scrollTop = 0;
        delete panel.dataset.searchState;
        for (const id of ["wireSearchStatus", "wireSearchCount", "wireSearchCoverage"]) replaceSearchText($(id), "");
        $("wireSearchStatus").classList.remove("visually-hidden");
        $("wireSearchCoverage").hidden = $("wireSearchRetry").hidden = true;
        if (notify) onInvalidateOpen({ accessWithdrawn: true });
    }
    const knownOwnerRelease = reason => ["idle", "session-released", "runtime-stopped"].includes(reason);
    const purpose = () => scope.value === "analysis" ? "analysis" : "navigation";
    const types = () => scope.value === "analysis" ? ["interaction", "context", "reply", "action"] : category.value ? [category.value] : [];
    const ownedReceipt = () => state.snapshot().matches?.receipt;
    const releasedCurrentOwner = () => Boolean(releaseFence && releaseFence.stream === stream
        && releaseFence.panelId === state.snapshot().panelId && releaseFence.epoch === state.snapshot().epoch);
    function eraseSearchContent(root) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) text.data = "";
        for (const node of root.querySelectorAll("*")) {
            for (const name of ["aria-label", "title", "data-search-id", "data-search-bundle"]) {
                const attribute = node.getAttributeNode(name);
                if (attribute) { attribute.value = ""; node.removeAttributeNode(attribute); }
            }
        }
        root.replaceChildren();
    }
    function replaceSearchText(root, text) {
        eraseSearchContent(root);
        if (text) root.append(document.createTextNode(text));
    }
    function eraseLists() {
        eraseSearchContent(list); eraseSearchContent(pagers.matches); drawnKeys.matches = null;
        $("wireSearchMatches").hidden = true;
    }
    function el(tag, text, cls) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(text, action) {
        const authority = publication(), node = el("button", text, "quiet");
        node.type = "button"; node.addEventListener("click", () => { if (isPublished(authority)) action(); });
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
    function coverageMessage(corpus, requestedTypes) {
        const issues = corpus?.issues?.filter(issue => !Array.isArray(issue.types)
            || issue.types.some(type => requestedTypes.includes(type))) ?? [];
        if (issues.length && issues.every(issue => issue.types?.length === 1 && issue.types[0] === "reply"
            && ["not-authorized", "revoked", "not-retained", "source-unavailable"].includes(issue.code))) {
            return "Saved GitHub replies are unavailable for Search.";
        }
        const reports = issues.length && issues.every(issue => issue.types?.length === 1 && issue.types[0] === "report");
        if (reports && issues.every(issue => issue.code === "missing")) {
            return issues.length === 1 ? "A saved report file is missing." : "Some saved report files are missing.";
        }
        if (reports && issues.every(issue => issue.code === "stale-or-integrity")) return "Changed report files could not be verified.";
        if (reports) return "Some saved reports could not be read.";
        return "Some saved content could not be searched.";
    }
    function show() {
        if (!publication()) return;
        field.sync();
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
    function syncNativeSearch() {
        nativeSearch?.changed({ query: input.value, scope: scope.value, types: types() });
    }
    function eraseDocument() {
        clearPreparations();
        if (documentReturn) returns.delete(documentReturn);
        documentReturn = null;
        onInvalidateOpen();
    }
    function fail(message = "Search disconnected. Results were cleared; reconnect to read current items.", { released = false } = {}) {
        const authority = publication();
        if (!authority) return;
        const recover = released && returnRecovery && !inactive() && queryActive;
        if (!released) { queryActive = resumeVisibleQuery = false; suspendedPresentation = null; }
        ownerReleased = released && queryActive;
        releaseFence = null;
        returnRecovery = false;
        connected = connecting = false;
        failure = message;
        clearTimeout(timer);
        stream?.abort(); stream = null;
        clearTimeout(heartbeat);
        state.disconnect(); eraseLists(); eraseDocument();
        if (!isPublished(authority)) return;
        replaceSearchText($("wireSearchStatus"), message);
        $("wireSearchStatus").classList.remove("visually-hidden");
        replaceSearchText($("wireSearchCoverage"), "");
        $("wireSearchRetry").hidden = false;
        onAnalysis({ state: "unavailable", query: scope.value === "analysis" ? input.value : null });
        if (recover && isPublished(authority)) connect();
    }
    function restoreResultFocus() {
        const restoration = restore, authority = restoration?.authority;
        if (!isPublished(authority)) return;
        const current = state.snapshot(), context = getAnalysis();
        if (restore !== restoration || !isPublished(authority) || panel.hidden || !current.matches.receipt || context?.pending || context?.returnPending || current.matches.receipt.revision !== context?.revision
            || scope.value === "analysis" && analysisKey !== context?.key) return;
        lists.matches.scrollTop = restoration.scroll.matches;
        panel.scrollTop = restoration.panelScroll;
        const focused = [...lists[restoration.set].querySelectorAll("button")].find(node => node.dataset.searchId === restoration.focus);
        if (!isPublished(authority)) return;
        if (!restoration.retainFocus) (focused || input).focus({ preventScroll: true });
        restore = null;
    }
    function paint() {
        const authority = publication();
        if (inactive() || !authority) return;
        const current = state.snapshot(), status = current.status;
        panel.dataset.searchState = current.state;
        const partial = Boolean(current.matches.receipt && !contract.completeCoverage(status?.corpus, current.matches.receipt.queryTypes));
        const coverage = coverageMessage(status?.corpus, current.matches.receipt?.queryTypes ?? types());
        const labels = { queued: "Searching...",
            refreshing: "Updating search...",
            building: "Preparing search...",
            searching: "Searching...", stale: "Saved content changed. Search again.",
            changing: "Saved content changed. Search again.",
            unavailable: "Search is unavailable. Try again.",
            disconnected: failure || "Search disconnected. Reconnect to read current items.", closed: "Local search closed.", superseded: "A newer query replaced this read.",
            incomplete: coverage === "Saved GitHub replies are unavailable for Search."
                ? coverage : "Search is incomplete. " + coverage,
            "no-match": nativeSearch?.active() ? "No GitHub, saved or navigation matches. Microsoft results are separate." : "No matches. Try different words." };
        replaceSearchText($("wireSearchStatus"), !input.value.trim() ? ""
            : current.matches.receipt ? current.matches.total
                ? `${current.matches.total} ${partial ? "available " : ""}match${current.matches.total === 1 ? "" : "es"}`
                : partial ? labels.incomplete : labels["no-match"]
                : labels[current.state] || "Ready for a local search.");
        $("wireSearchStatus").classList.toggle("visually-hidden", Boolean(current.matches.total));
        replaceSearchText($("wireSearchCoverage"), partial && current.matches.total ? coverage : "");
        $("wireSearchCoverage").hidden = !$("wireSearchCoverage").textContent;
        $("wireSearchRetry").hidden = !input.value.trim() || !["disconnected", "stale", "unavailable", "closed", "changing"].includes(current.state);
        $("wireSearchRetry").textContent = connected ? "Retry search" : "Reconnect search";
        $("wireSearchMatches").hidden = !current.matches.total;
        replaceSearchText($("wireSearchCount"), `${current.matches.total} ${nativeSearch?.active() ? "GitHub / saved / navigation " : ""}match${current.matches.total === 1 ? "" : "es"}`);
        paintSet("matches", current.matches, authority);
        if (!isPublished(authority)) return;
        restoreResultFocus();
    }
    function paintSet(key, value, authority) {
        if (!isPublished(authority)) return;
        const hits = value?.hits ?? [], size = 20, pageCount = Math.ceil(hits.length / size);
        if (value?.receipt) pages[key] = Math.min(pages[key], Math.max(0, pageCount - 1));
        const draw = JSON.stringify([value?.receipt ?? null, pages[key]]);
        if (draw === drawnKeys[key]) return;
        drawnKeys[key] = draw;
        const list = lists[key], paging = pagers[key];
        eraseSearchContent(list);
        const contexts = new Map(), byType = new Map();
        const reportFormat = hit => hit.type === "report" && ["html", "json", "markdown", "pdf"].includes(hit.coverage?.format)
            ? hit.coverage.format === "markdown" ? "Markdown" : hit.coverage.format.toUpperCase() : null;
        for (const hit of hits) {
            if (!byType.has(hit.type)) byType.set(hit.type, []);
            byType.get(hit.type).push(hit);
            const titleKey = JSON.stringify([hit.type, hit.title]);
            if (!contexts.has(titleKey)) contexts.set(titleKey, { sources: new Set(), formats: new Set() });
            contexts.get(titleKey).sources.add(hit.source.label);
            if (reportFormat(hit)) contexts.get(titleKey).formats.add(reportFormat(hit));
        }
        const groupedHits = [...byType.values()].flat();
        let previousType = null;
        for (const hit of groupedHits.slice(pages[key] * size, (pages[key] + 1) * size)) {
            const context = contexts.get(JSON.stringify([hit.type, hit.title]));
            const shown = presentHit(hit, { showSource: context.sources.size > 1 });
            const hitId = hit.id, row = el("li"), target = button("", () => open(hitId, key));
            row.dataset.searchCategory = hit.type;
            if (previousType !== hit.type) {
                const group = ({ interaction: "Interactions", context: "Conversation context", reply: "Replies", action: "Recorded actions",
                    tool: "Tools", service: "Services", report: "Reports", comparison: "Comparisons", view: "Views", setting: "Settings" })[hit.type];
                row.append(el("h4", group, "wire-search-kind wire-search-group-label"));
            }
            previousType = hit.type;
            target.className = "wire-search-hit"; target.dataset.searchId = hit.id;
            target.dataset.searchSet = key; target.dataset.searchType = hit.type;
            if (hit.target.bundleId) target.dataset.searchBundle = hit.target.bundleId;
            const meta = el("span", undefined, "wire-search-meta"), body = el("span", undefined, "wire-search-body");
            const heading = el("span", undefined, "wire-search-heading");
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
            const format = reportFormat(hit);
            const categoryLabel = ({ interaction: "Interaction", context: "Prompt context", reply: "Reply", action: "Recorded action",
                tool: "Tool", service: "Service", report: "Report", comparison: "Comparison", view: "View", setting: "Setting" })[hit.type];
            const kindLabel = layer ? results.unit(layer, 1) : categoryLabel;
            const icon = hit.type === "service" ? serviceIcon(hit.target) : ux.icon("search-" + hit.type);
            if (icon?.localName !== "svg") throw new TypeError("Search result icon is unavailable.");
            const slot = el("span", undefined, "wire-search-type-icon");
            slot.setAttribute("aria-hidden", "true"); slot.append(icon); target.append(slot);
            if (layer) meta.append(el("span", kindLabel, "wire-search-kind"));
            if (format && context.formats.size > 1) meta.append(el("span", format, "wire-search-format"));
            if (outcome) {
                const cue = el("span", undefined, "wire-search-outcome result-tone-" + outcome.key);
                cue.append(ux.icon(outcome.icon + "-compact"), document.createTextNode(outcome.label)); meta.append(cue);
            }
            const sourceTitle = !shown.title.length;
            const title = textParts(el("strong", undefined, "wire-search-title" + (sourceTitle ? " wire-search-source" : "")), sourceTitle ? shown.source : shown.title);
            title.dir = "auto";
            heading.append(title);
            body.append(heading);
            if (meta.hasChildNodes()) body.append(meta);
            for (const field of ["source", "excerpt"]) if (shown[field].length && !(field === "source" && sourceTitle)) {
                const text = textParts(el("span", undefined, "wire-search-" + field), shown[field]);
                text.dir = "auto"; body.append(text);
            }
            const call = hit.target.kind === "route" && hit.target.href.startsWith("#request?")
                && new URLSearchParams(hit.target.href.split("?")[1]).has("call") && hit.coverage?.layer !== "code-reference";
            const destination = ["interaction", "context", "reply"].includes(hit.type) ? "Open interaction" : ["action", "tool", "service"].includes(hit.type)
                ? call ? "Open recorded call" : "Open in Analyze"
                : ({ report: "Open saved report", comparison: "Open saved comparison", setting: "Open setting", view: "Open view" })[hit.type];
            const limitation = hit.coverage?.availabilityNote ?? (hit.coverage?.completeness === "partial" || hit.coverage?.completeness === "bounded-fragment" ? "Only part of this text was saved."
                : hit.coverage?.completeness === "unavailable" ? "Saved text is unavailable." : "");
            const primary = sourceTitle ? hit.title : shown.title.map(part => part.text).join("");
            target.setAttribute("aria-label", [`${destination}: ${shorten(primary)}; ${kindLabel}`,
                sourceTitle ? "Source match" : shown.source.map(part => part.text).join(""),
                shown.excerpt.map(part => part.text).join("").replace(/\s+/gu, " "),
                format, outcome?.label, limitation].filter(Boolean).join("; "));
            if (limitation) body.append(el("span", limitation, "wire-search-limitation"));
            target.append(body);
            if (!isPublished(authority)) return;
            row.append(target); list.append(row);
        }
        if (!isPublished(authority)) return;
        eraseSearchContent(paging);
        if (pageCount > 1) {
            const noun = "results";
            const previous = button("Previous " + noun, () => {
                restore = null; pages[key]--; paint();
                if (isPublished(authority)) list.querySelector("button")?.focus();
            });
            const next = button("Next " + noun, () => {
                restore = null; pages[key]++; paint();
                if (isPublished(authority)) list.querySelector("button")?.focus();
            });
            previous.disabled = !pages[key]; next.disabled = pages[key] >= pageCount - 1;
            if (!isPublished(authority)) return;
            paging.append(previous, el("span", `Page ${pages[key] + 1} of ${pageCount}; ${hits.length} total`), next);
        }
    }
    function receive(event, authority) {
        if (!isPublished(authority)) return;
        const before = state.snapshot();
        if (inactive() && ["results", "opened"].includes(event.event)) return;
        if (event.event === "connected") {
            releaseFence = null;
            connected = true; connecting = false;
            state.receive(event);
            if (!inactive()) schedule(false);
        } else state.receive(event);
        if (event.panelId !== state.snapshot().panelId) return;
        clearTimeout(heartbeat);
        if (!inactive()) heartbeat = setTimeout(() => {
            if (isPublished(authority)) fail("Search disconnected. Results were cleared. Reconnect to continue.");
        }, 5000);
        if (event.event === "heartbeat") return;
        if (event.event === "fence" && event.epoch > before.epoch) {
            releaseFence = knownOwnerRelease(event.reason) ? { stream, panelId: event.panelId, epoch: event.epoch, reason: event.reason } : null;
            if (["read-failed", "state-unavailable"].includes(event.reason)) {
                fail("Search is unavailable. Try again."); return;
            }
            if (["cancelled", "closed"].includes(event.reason)) {
                queryActive = resumeVisibleQuery = returnRecovery = ownerReleased = false; suspendedPresentation = null;
            }
            eraseDocument();
            if (!isPublished(authority)) return;
            onAnalysis({ state: "stale", query: scope.value === "analysis" ? input.value : null, revoked: true });
            if (event.reason === "collected" && purpose() === "navigation") {
                nativeSearch?.withdraw();
                if (isPublished(authority) && queryActive && !inactive() && !panel.hidden) {
                    schedule();
                    return;
                }
            }
        }
        if (event.event === "status" && event.epoch === state.snapshot().epoch
            && (event.requestId === state.snapshot().requestId || event.requestId === undefined && event.state === "unavailable")
            && ["unavailable", "closed"].includes(event.state)) {
            fail(event.state === "closed" ? "Local search closed." : "Search is unavailable. Try again."); return;
        }
        if (!isPublished(authority)) return;
        if (event.event === "results" && state.snapshot().matches === event.matches && scope.value === "analysis"
            && contract.analysisReceipt(event.matches.receipt)) {
            onAnalysis({ state: "ready", query: input.value, hits: event.matches.hits, receipt: event.matches.receipt,
                complete: contract.completeCoverage(event.status?.corpus, event.matches.receipt.queryTypes), scopeKey: analysisKey });
        }
        if (event.event === "results" && state.snapshot().matches === event.matches) returnRecovery = false;
        if (event.event === "opened" && event.openId === openId && contract.sameReceipt(event.receipt, ownedReceipt())) {
            const prepared = { value: event.document, receipt: event.receipt, id: event.openId, authority };
            preparations.add(prepared);
            void showOpened(prepared).catch(() => {
                if (isPublished(authority) && prepared.id === openId) fail("The current item could not be displayed. Return to search and read it again.");
            });
        }
        paint();
    }
    function connect() {
        const authority = publication();
        if (!authority || connected || connecting || inactive()) return;
        connecting = true;
        queryActive = Boolean(input.value.trim());
        ownerReleased = false; releaseFence = null;
        failure = null;
        state.query(++sequence, purpose(), types());
        paint();
        if (!isPublished(authority)) return;
        stream = new AbortController();
        streamAuthority = authority;
        const owned = stream;
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => {
            if (isPublished(authority) && stream === owned) fail("The local search connection did not become ready. No results were retained.");
        }, 10000);
        api.searchEvents(event => {
            if (isPublished(authority) && stream === owned && !owned.signal.aborted) receive(event, authority);
        }, { signal: owned.signal, schemaVersion: contract.schemaVersion }).catch(error => {
            if (isPublished(authority) && !owned.signal.aborted && stream === owned) {
                const released = error.reason === "search-stream-ended" && releasedCurrentOwner();
                fail(released && releaseFence.reason === "idle" ? "Search paused after inactivity." : failureMessage(error), { released });
            }
        });
    }
    function schedule(resetPage = true) {
        const authority = publication();
        if (!authority) return;
        syncNativeSearch();
        if (documentReturn) eraseDocument();
        if (!isPublished(authority)) return;
        clearTimeout(timer);
        queryActive = Boolean(input.value.trim());
        if (!queryActive) resumeVisibleQuery = false;
        openId++;
        const requestId = ++sequence;
        state.query(requestId, purpose(), types());
        if (resetPage && !restore) pages = { matches: 0 };
        const analysis = getAnalysis();
        if (!isPublished(authority)) return;
        analysisKey = analysis?.key ?? null;
        onAnalysis({ state: "pending", query: scope.value === "analysis" ? input.value : null, scopeKey: analysisKey });
        if (!isPublished(authority)) return;
        paint();
        if (!isPublished(authority)) return;
        if (inactive() && input.value.trim()) return;
        if (!connected) { connect(); return; }
        const owned = stream;
        timer = setTimeout(async () => {
            if (!isPublished(authority) || stream !== owned || owned.signal.aborted || requestId !== sequence) return;
            try {
                await api("/api/search/query", { schemaVersion: contract.schemaVersion, purpose: purpose(), query: input.value, requestId, types: types() }, { signal: owned.signal });
            } catch (error) {
                if (isPublished(authority) && stream === owned && requestId === sequence && error.reason !== "search_cancelled") {
                    fail(failureMessage(error), { released: error.reason === "search-disconnected" && releasedCurrentOwner() });
                }
            }
        }, 120);
    }
    function remember(authority) {
        const key = crypto.randomUUID();
        returns.set(key, { authority, query: input.value, scope: scope.value, category: category.value, pages: { ...pages },
            panelScroll: panel.scrollTop,
            scroll: { matches: lists.matches.scrollTop },
            set: document.activeElement?.dataset.searchSet || "matches", focus: document.activeElement?.dataset.searchId });
        // Only an opaque local navigation marker enters history, never global text or hits.
        history.replaceState({ ...history.state, wireSearchReturn: key }, "");
        return key;
    }
    function open(hitId, set) {
        const authority = publication();
        if (!authority) return;
        const receipt = state.snapshot()[set]?.receipt, id = ++openId;
        if (!receipt || !connected) return;
        remember(authority);
        replaceSearchText($("wireSearchStatus"), "Opening the exact current item...");
        void api("/api/search/open", { id: hitId, receipt, openId: id }, { signal: stream.signal }).catch(error => {
            if (!isPublished(authority) || id !== openId) return;
            state.query(++sequence, purpose(), types()); eraseLists(); paint();
            replaceSearchText($("wireSearchStatus"), failureMessage(error));
            $("wireSearchRetry").textContent = connected ? "Retry search" : "Reconnect search";
            $("wireSearchRetry").hidden = false;
        });
    }
    async function showOpened(prepared) {
        const returnKey = history.state?.wireSearchReturn;
        const isCurrent = () => isPublished(prepared.authority) && !inactive() && connected && prepared.id === openId
            && contract.sameReceipt(prepared.receipt, ownedReceipt());
        let retainedDocument = false;
        try {
            if (!isCurrent()) return;
            hide();
            if (prepared.value.kind === "route") await navigate(prepared.value, { isCurrent });
            else {
                documentReturn = returnKey;
                if (!await presentDocument(prepared.value, { isCurrent, returnKey })) return;
                retainedDocument = isCurrent();
            }
            if (!isCurrent()) return;
            const { wireSearchReturn, ...next } = history.state || {};
            history.replaceState(next, "");
        } finally {
            prepared.value = null;
            if (!retainedDocument) {
                prepared.receipt = prepared.authority = null;
                preparations.delete(prepared);
            }
        }
    }
    input.addEventListener("focus", () => {
        show();
        if (state.snapshot().state === "refreshing" && queryActive && purpose() === "navigation") schedule();
        else paint();
    });
    input.addEventListener("click", () => { if (panel.hidden) { show(); paint(); } });
    const field = searchFields.mount(input, {
        clearLabel: "Clear search",
        onInput: () => {
            const authority = publication();
            if (authority) { restore = null; panel.scrollTop = 0; show(); if (isPublished(authority)) schedule(); }
        },
        onClear: () => {
            const authority = publication();
            if (authority) { restore = null; show(); if (isPublished(authority)) schedule(); }
        },
    });
    scope.addEventListener("change", () => {
        if (!publication()) return;
        restore = null;
        syncScope();
        schedule();
    });
    category.addEventListener("change", () => { restore = null; schedule(); });
    $("wireSearchRetry").addEventListener("click", () => { connected ? schedule() : connect(); });
    input.addEventListener("keydown", event => {
        const authority = publication();
        if (event.isComposing || !authority) return;
        if (event.key === "ArrowDown") {
            event.preventDefault(); show();
            if (isPublished(authority)) lists.matches.querySelector("button")?.focus();
        }
        if (event.key === "Escape") { event.preventDefault(); hide(); }
    });
    for (const list of Object.values(lists)) list.addEventListener("keydown", event => {
        if (!publication()) return;
        const nodes = Object.values(lists).flatMap(list => [...list.querySelectorAll("button")]), index = nodes.indexOf(document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
            (nodes[next] || input).focus();
        }
    });
    function restoreSearch(key) {
        if (!publication()) return false;
        documentReturn = null;
        const saved = !disposed && returns.get(key);
        const authority = saved?.authority;
        if (!saved || !isPublished(authority)) { hide(); return false; }
        input.value = saved.query; scope.value = saved.scope; category.value = saved.category;
        syncScope();
        pages = { ...saved.pages }; restore = saved; show();
        if (!isPublished(authority)) return false;
        schedule(false);
        return true;
    }
    window.addEventListener("popstate", () => restoreSearch(history.state?.wireSearchReturn));
    home.addEventListener("keydown", event => {
        if (event.key === "Escape" && !event.isComposing && publication()) {
            event.preventDefault(); input.focus({ preventScroll: true }); hide();
        }
    });
    for (const type of ["pointerdown", "focusin"]) document.addEventListener(type, event => {
        if (!home.contains(event.target) && !event.target.closest(".select-popup")) hide();
    });
    for (const type of ["pointerdown", "keydown", "wheel", "touchmove"]) {
        document.addEventListener(type, event => { if (event.isTrusted) restore = null; }, { capture: true, passive: true });
    }
    function suspend() {
        const authority = publication();
        if (!authority) return;
        resumeVisibleQuery ||= queryActive && (connected || connecting || ownerReleased);
        if (!panel.hidden && resumeVisibleQuery) suspendedPresentation = {
            authority: streamAuthority, panelScroll: panel.scrollTop, scroll: { matches: list.scrollTop }, set: "matches",
            focus: document.activeElement?.dataset.searchId, retainFocus: !document.activeElement?.dataset.searchId,
        };
        returnRecovery = false;
        clearTimeout(timer); clearTimeout(heartbeat); openId++;
        // Retain bounded owned preparation, not disclosure or admission.
        // The visible return must submit a fresh sequence against current sources.
        if (resumeVisibleQuery) state.query(++sequence, purpose(), types());
        eraseLists(); eraseDocument(); hide();
        if (!isPublished(authority)) return;
        onAnalysis({ state: resumeVisibleQuery ? "pending" : "unavailable",
            query: scope.value === "analysis" ? input.value : null, scopeKey: analysisKey });
    }
    function resume() {
        const authority = publication();
        if (!authority || inactive()) return;
        if (resumeVisibleQuery) {
            resumeVisibleQuery = false;
            if (suspendedPresentation) {
                restore = suspendedPresentation; suspendedPresentation = null; show();
            }
            if (!isPublished(authority)) return;
            returnRecovery = connected || connecting;
            heartbeat = setTimeout(() => {
                if (isPublished(authority)) fail("Search disconnected. Results were cleared. Reconnect to continue.");
            }, connecting ? 10000 : 5000);
            if (connected) schedule(false);
            else if (!connecting) connect();
        } else if (connected) paint();
    }
    window.addEventListener("pagehide", () => {
        suspend(); disposed = true; returns.clear();
        fail(queryActive || !failure ? "Search paused while this page is away." : failure, { released: queryActive });
    });
    window.addEventListener("pageshow", () => { disposed = windowAway = false; hidden = document.hidden; resume(); });
    window.addEventListener("blur", () => {
        if (disposed || windowAway || document.hasFocus()) return;
        windowAway = true; suspend();
    });
    window.addEventListener("focus", () => {
        if (!windowAway) return;
        windowAway = false; resume();
    });
    document.addEventListener("visibilitychange", () => {
        if (disposed || hidden === document.hidden) return;
        hidden = document.hidden;
        if (hidden) suspend();
        else resume();
    });
    const canPrepareAnalysis = query => Boolean(publication()) && (!input.value || scope.value === "analysis" && input.value === query);
    paint();
    return {
        hide,
        invalidate: fail,
        withdrawAccess,
        resumeAccess() {
            const version = accessVersion, token = api.publicationToken(), current = currentToken(token, version);
            if (version !== accessVersion) return false;
            if (!current) { withdrawAccess(); return false; }
            accessWithdrawn = false;
            input.disabled = scope.disabled = false;
            syncScope(); field.sync();
            return true;
        },
        restore: restoreSearch,
        canRestore: key => !disposed && isPublished(returns.get(key)?.authority),
        returnKey: () => !disposed && isPublished(returns.get(history.state?.wireSearchReturn)?.authority) ? history.state.wireSearchReturn : null,
        sessionChanged() {
            const version = accessVersion, mode = api.accessState().mode;
            if (version !== accessVersion) return;
            if (mode !== "unbound" || accessWithdrawn) { withdrawAccess(); return; }
            const token = api.publicationToken(), current = currentToken(token, version);
            if (version !== accessVersion) return;
            if (!current) { withdrawAccess(); return; }
            const renew = queryActive && (connected || connecting || resumeVisibleQuery || returnRecovery || ownerReleased);
            accessVersion++; sequence++; openId++;
            returns.clear(); returnRecovery = false; streamAuthority = null;
            const authority = { token, version: accessVersion };
            if (restore) restore.authority = authority;
            if (suspendedPresentation) suspendedPresentation.authority = authority;
            fail("The local connection changed. Reading current Search items.", { released: true });
            if (!isPublished(authority)) return;
            if (renew) {
                if (inactive()) resumeVisibleQuery = true;
                else connect();
            }
        },
        analysisScope() {
            const authority = publication();
            if (!authority) return;
            if (scope.value !== "analysis") { scope.value = "analysis"; scope.dispatchEvent(new Event("change")); }
            show();
            if (isPublished(authority)) input.focus();
        },
        analysisPreparation() {
            return publication() && scope.value === "analysis" && input.value.trim() ? input.value : null;
        },
        canPrepareAnalysis,
        prepareAnalysis(query) {
            const authority = publication();
            if (!authority) throw new Error("Search access is unavailable. Start a new search after access returns.");
            if (typeof query !== "string" || !query.trim()) throw new TypeError("Private Search preparation requires a nonempty query.");
            if (!canPrepareAnalysis(query) || !isPublished(authority)) throw new Error("Search changed while the private view was opening.");
            input.value = query; scope.value = "analysis";
            syncScope();
            field.sync();
            resumeVisibleQuery = inactive();
            schedule();
        },
        changed() {
            const authority = publication();
            if (!authority) return;
            syncNativeSearch();
            const context = getAnalysis();
            if (!isPublished(authority)) return;
            if (queryActive && (connected || connecting || resumeVisibleQuery) && scope.value === "analysis" && input.value && context?.active && !context.pending
                && (analysisKey !== context.key || context.needsRebind && state.snapshot().matches.receipt)) {
                schedule(!restore);
            } else if (restore) paint();
        },
    };
}
