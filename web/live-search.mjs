export const liveSearchMarkup = `
<div class="wire-search-entry">
  <label for="wireSearch">Search WIRE</label>
  <input id="wireSearch" type="search" placeholder="Find meaning, tools, paths..." autocomplete="off" spellcheck="false" aria-controls="wireSearchPanel" aria-expanded="false">
</div>`;

export const liveSearchPanel = `
<section id="wireSearchPanel" class="wire-search-panel" aria-labelledby="wireSearchTitle" hidden>
  <div class="wire-search-heading"><h2 id="wireSearchTitle">Search WIRE</h2><button id="wireSearchHide" type="button" class="quiet">Close results</button></div>
  <div class="wire-search-filters">
    <label>Search scope<select id="wireSearchScope"><option value="everywhere">Everywhere</option><option value="analysis">Current Analyze scope</option></select></label>
    <label>Result type<select id="wireSearchType"><option value="">All types</option><option value="interaction">Interactions</option><option value="context">Conversation context</option><option value="reply">Retained replies</option><option value="action">Recorded actions</option><option value="tool">Tools</option><option value="service">Services</option><option value="report">Saved reports</option><option value="comparison">Saved comparisons</option><option value="view">Views</option><option value="setting">Settings</option></select></label>
    <button id="wireSearchClear" type="button" class="quiet">Clear search</button><button id="wireSearchRetry" type="button" class="quiet" hidden>Reconnect search</button>
  </div>
  <p id="wireSearchScopeNote" class="muted">Find existing local items. Typing never collects, runs tools or changes permissions.</p>
  <p id="wireSearchStatus" role="status" aria-live="polite"></p>
  <p id="wireSearchCoverage" class="muted"></p>
  <ol id="wireSearchResults" class="wire-search-results" aria-label="Search results"></ol>
  <div id="wireSearchPaging" class="wire-search-paging"></div>
</section>
<p id="wireAnalysisSearchNotice" class="notice" role="status" hidden></p>`;

export const liveSearchStyles = `
.wire-search-entry {display:flex;align-items:center;gap:8px;flex:1 1 280px;min-width:180px;max-width:480px}
.wire-search-entry label {font-size:var(--type-caption);font-weight:var(--weight-strong);white-space:nowrap}
.wire-search-entry input {width:100%;background:var(--paper)}
.wire-search-panel {background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius);padding:16px;margin-block:12px}
.wire-search-heading,.wire-search-filters,.wire-search-paging {display:flex;align-items:center;flex-wrap:wrap;gap:12px}
.wire-search-heading {justify-content:space-between;margin-bottom:12px}
.wire-search-filters label {display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start;gap:4px;font-size:var(--type-caption)}
.wire-search-filters .select-trigger .select-value {white-space:normal;overflow-wrap:anywhere;text-overflow:clip}
.wire-search-panel > p {margin-top:8px}
.wire-search-results {padding:6px;margin:12px 0;list-style:none;max-height:55vh;overflow:auto;scroll-padding:6px}
.wire-search-results li {border-top:1px solid var(--rule)}
.wire-search-results .wire-search-hit {display:grid;gap:5px;width:100%;text-align:start;border:0;border-radius:0;background:transparent;color:var(--ink);padding:12px 8px}
.wire-search-results .wire-search-hit:hover {background:var(--pill-hover)}
.wire-search-hit strong {font-size:var(--type-body)}
.wire-search-excerpt {white-space:pre-wrap;overflow-wrap:anywhere;font-weight:var(--weight-regular);line-height:var(--leading-ui)}
.wire-search-meta,.wire-search-destination,.wire-search-limitation {font-size:var(--type-caption);font-weight:var(--weight-regular);color:var(--muted);overflow-wrap:anywhere}
.wire-search-meta {display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.wire-search-kind {border:1px solid var(--rule);border-radius:var(--radius-control);padding:2px 8px;color:var(--accent)}
.wire-search-document pre {white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--font);line-height:var(--leading-ui)}
.wire-search-document .report-frame {width:100%;min-height:65vh;border:1px solid var(--rule)}
@media(max-width:600px) {.wire-search-entry {flex-basis:100%;max-width:none}.wire-search-panel {padding:12px}.wire-search-filters {align-items:stretch}.wire-search-filters>label,.wire-search-filters>.select-field {flex:1 1 240px}.wire-search-results {max-height:60vh}}
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

export function mountLiveSearch({ api, createState, frozenFrame, navigate, getAnalysis, onAnalysis, onInvalidateOpen }) {
    const $ = id => document.getElementById(id);
    const input = $("wireSearch"), panel = $("wireSearchPanel"), list = $("wireSearchResults");
    const scope = $("wireSearchScope"), category = $("wireSearchType"), state = createState();
    const returns = new Map();
    let stream, timer, heartbeat, sequence = 0, openId = 0, page = 0, restore, analysisKey = null, dialog;
    let connected = false, connecting = false, disposed = false, drawnKey = null;
    function el(tag, text, cls) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(text, action) {
        const node = el("button", text, "quiet"); node.type = "button"; node.addEventListener("click", action); return node;
    }
    function show() { panel.hidden = false; input.setAttribute("aria-expanded", "true"); }
    function hide() { panel.hidden = true; input.setAttribute("aria-expanded", "false"); }
    function syncScope() {
        const analytical = scope.value === "analysis";
        category.disabled = analytical;
        category.options[0].textContent = analytical ? "Interactions and calls" : "All types";
        if (analytical) category.value = "";
        $("wireSearchScopeNote").textContent = analytical
            ? "Refines the accepted Analyze population across all pages using interactions, context, replies and exact calls. Navigation and saved-artifact hits never become analytical membership."
            : "Find existing local items. Typing never collects, runs tools or changes permissions.";
    }
    function eraseDocument() {
        onInvalidateOpen();
        if (dialog) dialog.querySelector(".assessment-dialog-body").replaceChildren(el("p",
            "The local search generation changed. This copy was cleared; return to search and open its current verified saved copy."));
    }
    function fail(message = "Search disconnected. Results were cleared; reconnect to read current items.") {
        connected = connecting = false;
        clearTimeout(timer);
        stream?.abort(); stream = null;
        clearTimeout(heartbeat);
        state.disconnect(); list.replaceChildren(); drawnKey = null; eraseDocument();
        $("wireSearchStatus").textContent = message;
        $("wireSearchCoverage").textContent = "";
        $("wireSearchPaging").replaceChildren();
        $("wireSearchRetry").hidden = false;
        onAnalysis({ state: "unavailable", query: scope.value === "analysis" ? input.value : null });
    }
    function sameReceipt(a, b) {
        return a && b && ["panelId", "epoch", "requestId", "generation", "indexId", "modelId", "mode", "revision"].every(key => a[key] === b[key]);
    }
    function restoreResultFocus() {
        const current = state.snapshot(), context = getAnalysis();
        if (!restore || !current.receipt || context?.pending || current.receipt.revision !== context?.revision
            || scope.value === "analysis" && analysisKey !== context?.key) return;
        list.scrollTop = restore.scroll;
        const focused = [...list.querySelectorAll("button")].find(node => node.dataset.searchId === restore.focus);
        (focused || input).focus({ preventScroll: true }); restore = null;
    }
    function paint() {
        const current = state.snapshot(), status = current.status, partial = status?.corpus?.state === "partial";
        const labels = { queued: "Waiting for the current verified read; only your latest query is queued.",
            building: "Preparing the local search index from authorized saved content...",
            searching: "Searching and verifying current sources...", stale: "Sources changed. Search again to read current results.",
            changing: "Local evidence is changing. Search resumes only against a current generation.",
            unavailable: "Local search is unavailable. Retry reads local state only.",
            disconnected: "Connect local search to begin.", closed: "Local search closed.", superseded: "A newer query replaced this read.",
            "no-match": "No current matches. Try another phrase or an exact tool, path or status." };
        $("wireSearchStatus").textContent = !input.value.trim() ? "Start typing. Results appear here without Submit."
            : current.receipt ? `${current.hits.length} ${partial ? "available " : ""}match${current.hits.length === 1 ? "" : "es"} across all result pages.`
                + (!current.hits.length ? " No current matches." : "")
                : labels[current.state] || "Ready for a local search.";
        const issues = [...new Set(status?.corpus?.issues?.map(issue => issue.code) ?? [])];
        $("wireSearchCoverage").textContent = [
            status?.mode === "lexical-only" ? `Exact/prefix search only. Semantic model unavailable (${status.model?.code || "local-model-unavailable"}). Explicit local setup: npm run search:model:provision. Typing never downloads it; corrupt files require operator repair first.`
                : status?.mode === "hybrid" ? "On-device semantic + exact/prefix matching." : "",
            partial ? "Partial coverage: " + issues.join(", ") + ". Missing content is not a negative result." : "",
        ].filter(Boolean).join(" ");
        $("wireSearchRetry").hidden = !["disconnected", "stale", "unavailable", "closed", "changing"].includes(current.state);
        $("wireSearchRetry").textContent = connected ? "Retry search" : "Reconnect search";
        const size = 20, pages = Math.ceil(current.hits.length / size);
        if (current.receipt) page = Math.min(page, Math.max(0, pages - 1));
        const key = JSON.stringify([current.receipt, page]);
        if (key === drawnKey) { restoreResultFocus(); return; }
        drawnKey = key;
        list.replaceChildren();
        for (const hit of current.hits.slice(page * size, (page + 1) * size)) {
            const row = el("li"), target = button("", () => open(hit));
            target.className = "wire-search-hit"; target.dataset.searchId = hit.id;
            const meta = el("span", undefined, "wire-search-meta");
            meta.append(el("span", hit.category, "wire-search-kind"), el("span", hit.source.label));
            const excerpt = hit.excerpt.replace(new RegExp("^" + hit.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\n"), "")
                .split("\n").filter((line, index, lines) => line !== hit.source.label && (index === 0 || line !== lines[index - 1])).join("\n");
            target.append(meta, el("strong", hit.title), el("span", excerpt, "wire-search-excerpt"));
            target.append(el("span", "Opens: " + (hit.target.kind === "route" ? hit.target.href
                : `${hit.type === "comparison" ? "Frozen comparison" : "Frozen " + (hit.coverage.format || "report")} / ${hit.target.bundleId}`), "wire-search-destination"));
            const coverage = hit.coverage;
            const limits = [coverage.completeness, coverage.finality ? "Reply finality unverified" : "",
                coverage.textMode ? `${coverage.textMode} text` : "", coverage.representation, ...(coverage.gaps || [])].filter(Boolean);
            if (limits.length) target.append(el("span", limits.join(" / "), "wire-search-limitation"));
            row.append(target); list.append(row);
        }
        const paging = $("wireSearchPaging"); paging.replaceChildren();
        if (pages > 1) {
            const previous = button("Previous results", () => { restore = null; page--; paint(); list.querySelector("button")?.focus(); });
            const next = button("Next results", () => { restore = null; page++; paint(); list.querySelector("button")?.focus(); });
            previous.disabled = !page; next.disabled = page >= pages - 1;
            paging.append(previous, el("span", `Page ${page + 1} of ${pages}; ${current.hits.length} total`), next);
        }
        restoreResultFocus();
    }
    function receive(event) {
        const before = state.snapshot();
        if (event.event === "connected") {
            connected = true; connecting = false;
            state.receive(event); schedule(false);
        } else state.receive(event);
        if (event.panelId !== state.snapshot().panelId) return;
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => fail("Search heartbeat was missed. Results and targets were cleared."), 5000);
        if (event.event === "heartbeat") return;
        if (event.event === "fence" && event.epoch > before.epoch) {
            eraseDocument();
            onAnalysis({ state: "stale", query: scope.value === "analysis" ? input.value : null, revoked: true });
        }
        if (event.event === "results" && state.snapshot().receipt === event.receipt && scope.value === "analysis") {
            onAnalysis({ state: "ready", query: input.value, hits: event.hits, receipt: event.receipt,
                complete: event.status?.corpus?.state === "ready", scopeKey: analysisKey });
        }
        if (event.event === "opened" && event.openId === openId && sameReceipt(event.receipt, state.snapshot().receipt)) {
            void showOpened(event.document, event.receipt, event.openId).catch(() => fail("The current item could not be displayed. Return to search and read it again."));
        }
        paint();
    }
    function connect() {
        if (connected || connecting || disposed) return;
        connecting = true;
        stream = new AbortController();
        const owned = stream;
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => fail("The local search connection did not become ready. No results were retained."), 10000);
        api.searchEvents(receive, { signal: owned.signal }).catch(error => {
            if (!owned.signal.aborted && stream === owned) fail(error.message);
        });
    }
    function schedule(resetPage = true) {
        clearTimeout(timer);
        openId++;
        const requestId = ++sequence;
        state.query(requestId);
        if (resetPage && !restore) page = 0;
        analysisKey = getAnalysis()?.key ?? null;
        onAnalysis({ state: "pending", query: scope.value === "analysis" ? input.value : null, scopeKey: analysisKey });
        paint();
        if (!connected) { connect(); return; }
        timer = setTimeout(async () => {
            const types = scope.value === "analysis" ? ["interaction", "context", "reply", "action"]
                : category.value ? [category.value] : [];
            try {
                await api("/api/search/query", { query: input.value, requestId, types }, { signal: stream.signal });
            } catch (error) { if (requestId === sequence && error.reason !== "search_cancelled") fail(error.message); }
        }, 120);
    }
    function remember() {
        const key = crypto.randomUUID();
        returns.set(key, { query: input.value, scope: scope.value, category: category.value, page,
            scroll: list.scrollTop, focus: document.activeElement?.dataset.searchId });
        // Only an opaque local navigation marker enters history, never global text or hits.
        history.replaceState({ ...history.state, wireSearchReturn: key }, "");
        return key;
    }
    async function open(hit) {
        const receipt = state.snapshot().receipt, id = ++openId;
        if (!receipt || !connected) return;
        remember();
        $("wireSearchStatus").textContent = "Opening the exact current item...";
        try { await api("/api/search/open", { id: hit.id, receipt, openId: id }, { signal: stream.signal }); }
        catch (error) {
            if (id !== openId) return;
            state.query(++sequence); drawnKey = null; paint();
            $("wireSearchStatus").textContent = error.message;
            $("wireSearchRetry").textContent = connected ? "Retry search" : "Reconnect search";
            $("wireSearchRetry").hidden = false;
        }
    }
    async function showOpened(value, receipt, id) {
        hide();
        await navigate(value.kind === "route" ? value : { kind: "route", href: "#reports" });
        if (id !== openId || !sameReceipt(receipt, state.snapshot().receipt)) return;
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
    input.addEventListener("input", () => { restore = null; show(); schedule(); });
    scope.addEventListener("change", () => {
        restore = null;
        syncScope();
        schedule();
    });
    category.addEventListener("change", () => { restore = null; schedule(); });
    $("wireSearchHide").addEventListener("click", () => { hide(); input.focus(); hide(); });
    $("wireSearchClear").addEventListener("click", () => { restore = null; input.value = ""; schedule(); input.focus(); });
    $("wireSearchRetry").addEventListener("click", () => { connected ? schedule() : connect(); });
    input.addEventListener("keydown", event => {
        if (event.key === "ArrowDown") { event.preventDefault(); list.querySelector("button")?.focus(); }
        if (event.key === "Escape") { event.preventDefault(); hide(); }
    });
    list.addEventListener("keydown", event => {
        const nodes = [...list.querySelectorAll("button")], index = nodes.indexOf(document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? nodes.length - 1 : index + (event.key === "ArrowDown" ? 1 : -1);
            (nodes[next] || input).focus();
        }
        if (event.key === "Escape") { input.focus(); hide(); }
    });
    window.addEventListener("popstate", () => {
        if (dialog) dialog.close();
        const saved = returns.get(history.state?.wireSearchReturn);
        if (!saved) { hide(); return; }
        input.value = saved.query; scope.value = saved.scope; category.value = saved.category;
        syncScope();
        page = saved.page; restore = saved; show(); schedule(false);
    });
    window.addEventListener("pagehide", () => { disposed = true; returns.clear(); input.value = ""; fail(); });
    window.addEventListener("pageshow", () => { disposed = false; });
    document.addEventListener("visibilitychange", () => { if (document.hidden) fail("Search paused while this panel was hidden. Reconnect for current results."); });
    paint();
    return {
        invalidate: fail,
        sessionChanged() {
            if (!connecting) { fail(); return; }
            state.disconnect(); list.replaceChildren(); drawnKey = null; eraseDocument();
            onAnalysis({ state: "stale", query: scope.value === "analysis" ? input.value : null, revoked: true });
        },
        analysisScope() {
            if (scope.value !== "analysis") { scope.value = "analysis"; scope.dispatchEvent(new Event("change")); }
            show(); input.focus();
        },
        changed() {
            const context = getAnalysis();
            if (scope.value === "analysis" && input.value && context?.active && !context.pending
                && (analysisKey !== context.key || context.needsRebind && state.snapshot().receipt)) {
                schedule(!restore);
            } else if (restore) paint();
        },
    };
}
