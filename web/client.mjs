// Shared route adapter, serialized with the shell. Matching stays in activity analytics.
export function createFilterState(results, authorship) {
    function canonical(route) {
        const next = { ...route };
        if (typeof next.services === "string") next.services = [...new Set(next.services.split(",").filter(Boolean))].sort().join(",") || undefined;
        if (typeof next.withinServices === "string") next.withinServices = [...new Set(next.withinServices.split(",").filter(Boolean))].sort().join(",") || undefined;
        if (!next.services) next.includeMissingService = undefined;
        else if (["true", "false"].includes(next.includeMissingService)) next.includeMissingService = next.includeMissingService === "true";
        return next;
    }
    function query(route) {
        const filters = { scope: route.scope || "history", includeMetadata: route.layer === "http" };
        if (route.project) filters.projectIds = [route.project === "unscoped" ? null : route.project];
        if (route.tool) filters.tools = [route.tool];
        if (route.service) filters.workloads = [route.service];
        if (route.services) {
            filters.services = route.services.split(",");
            if (route.includeMissingService !== undefined) filters.includeMissingService = route.includeMissingService;
        }
        if (route.result) filters.outcomes = results.selection(route.result);
        if (route.authors) filters.promptAuthors = authorship.selection(route.authors);
        if (route.endpoint) filters.endpoints = [route.endpoint];
        if (route.session) filters.sourceSessionIds = [route.session];
        if (route.from) filters.from = route.from;
        if (route.to) filters.to = route.to;
        return filters;
    }
    function scope(route, next) {
        const retained = Object.fromEntries(["layer", "range", "from", "to", "bucket", "tool", "service", "services", "includeMissingService",
            "withinServices", "scope", "authors", "result", "project", "endpoint"].filter(key => route[key] !== undefined).map(key => [key, route[key]]));
        return { ...retained, ...next };
    }
    return { canonical, query, scope };
}

// Refine only an accepted canonical snapshot. Private search never becomes a server filter.
export function createAnalysisSlice(localSearch, projection) {
    return function slice(snapshot, options, search = "", withinServices = []) {
        if (!Array.isArray(withinServices) || withinServices.some(service => typeof service !== "string" || !service)) {
            throw new TypeError("Service chart refinements require named services.");
        }
        const base = snapshot.analytics, records = new Map(snapshot.scenarios.map(scenario => [scenario.scenarioId, scenario]));
        const sources = new Map((snapshot.sessions || []).map(source => [source.sessionId, source]));
        const hasQuery = Boolean(search.trim());
        const matches = hasQuery ? new Set([...records.values()].filter(scenario => {
            const source = sources.get(scenario.sourceSessionId);
            return localSearch.phrase(search, [scenario.userPrompt?.text, scenario.title, source?.project, source?.name,
                scenario.project, scenario.sourceSessionName, scenario.sourceSessionId]);
        }).map(scenario => scenario.scenarioId)) : null;
        const searchRows = rows => hasQuery ? rows.filter(row => matches.has(row.scenarioId)) : rows;
        const refineRows = rows => searchRows(rows).filter(row => withinServices.every(service => row.serviceAssociation?.services.includes(service)));
        const rows = refineRows(base.rows), scenarioIds = [...new Set(rows.map(row => row.scenarioId).filter(id => records.has(id)))];
        let analytics = base;
        if (hasQuery || withinServices.length) {
            const facetRows = refineRows(base.resultFacet.rows);
            let parentCalls;
            if (base.layer === "reported-api") {
                parentCalls = searchRows(base.apiCoverage.calls);
                if (withinServices.length) {
                    const entries = snapshot.requestActivity?.["reported-api"];
                    if (!Array.isArray(entries)) throw new TypeError("Service-refined API parent coverage requires accepted returned-entry associations.");
                    const parents = new Set(refineRows(entries).map(row => row.parentCallId));
                    parentCalls = parentCalls.filter(call => parents.has(call.id));
                }
            }
            analytics = {
                ...base,
                ...projection.project(rows, { ...options, timeContext: base.timeContext, dateRange: base.dateRange }, snapshot.scenarios),
                resultFacet: { ...base.resultFacet, rows: facetRows, totals: projection.summarize(facetRows) },
                apiCoverage: base.layer === "reported-api"
                    ? projection.apiCoverage(parentCalls, rows) : base.apiCoverage,
                httpCoverage: base.layer === "http" ? {
                    observedResponseCount: rows.filter(row => row.observedGraphHttp).length,
                    noResponseRecordCount: rows.filter(row => !row.observedGraphHttp).length,
                } : base.httpCoverage,
                warnings: base.warnings.flatMap(warning => {
                    const count = warning.code === "undated-activity" ? rows.filter(row => !row.startedAt).length
                        : warning.code === "recorded-sites-not-wire-counts" ? rows.length : null;
                    return count === null ? [warning] : count ? [{ ...warning, count }] : [];
                }),
            };
        }
        return { analytics, rows, rowIds: rows.map(row => row.id), scenarioIds,
            scenarios: scenarioIds.map(id => records.get(id)), refineRows };
    };
}

export function mountEvidence(capability, createBoardTransport, theme, createReportDraft, createEvidenceUX, uxIcons, mountThemeControl, createTimeContext, createServiceCategories, createDimensionalCharts, dimensionalIcons, mountSidebarNavigation, createReportScope, createSelectControls, createInlineMetadata, createControlHelp, createRecordedResults, createLiveState, createDisclosureState, createCollectionStatus, createSessionJourney, createReportJourney, mountCollectionSettings, createTextAccess, createPeriodFlow, createChatCopy, mountDisplayTimeSettings, createLocalSearch, createSettingsNavigation, createFreshActivity, createPercentageCharts, createRequestTiming, mountRecorderDiagnostics, createDeletionFlow, mountDeletion, assessmentFactories, createPromptAuthorship, createFilterState, createAnalysisSlice, createActivityProjection, createRequestContext, createCallInvestigation) {
    const $ = (id) => document.getElementById(id);
    const time = createTimeContext();
    const authorship = createPromptAuthorship();
    const requestTiming = createRequestTiming(time, authorship);
    const localSearch = createLocalSearch(), settingsNavigation = createSettingsNavigation(localSearch);
    let compactSettings, settingsSearchSignature, issueRows, deletionUI, recollectionUI, assessmentUI, automaticUI;
    const chatCopy = createChatCopy();
    const periodFlow = createPeriodFlow(time, chatCopy);
    let viewerTime = time.detect();
    let displayTimeSettings;
    const draft = createReportDraft();
    const ux = createEvidenceUX(uxIcons);
    const metadata = createInlineMetadata(ux);
    const categories = createServiceCategories();
    const help = createControlHelp(categories);
    const dimensional = createDimensionalCharts();
    const reportScopes = createReportScope(authorship);
    const results = createRecordedResults();
    const filterState = createFilterState(results, authorship);
    const analysisSlice = createAnalysisSlice(localSearch, createActivityProjection(time, categories, Object.keys(results.labels("tool"))));
    const timingPresentation = assessmentFactories.timing;
    const percentageMath = createPercentageCharts({ dimensional, categories, results, ux, icons: dimensionalIcons,
        createLink: (kind, row) => kind === "outcomes" && applied.layer !== "code-reference" ? link("", "activity", { result: row.id, page: undefined })
            : kind === "services" ? link("", "activity", { withinServices: [...new Set([...(route.withinServices?.split(",") || []), row.id])].sort().join(","), page: undefined })
                : kind === "tools" && row.id !== "tool:unidentified" ? link("", "activity", { tool: row.id.slice(5), page: undefined }) : null });
    const percentages = percentageMath.mount($("percentageCharts"));
    const live = createLiveState();
    const sourceCheckKey = "workiq-evidence.source-check.v1";
    let sourcePending = false, sourceStorageWarning = "";
    try {
        const stored = sessionStorage.getItem(sourceCheckKey);
        sourcePending = stored !== null;
        if (stored !== null && stored !== "pending") sourceStorageWarning = "Stored source-check status is invalid. Source refresh stays read-only in this tab.";
    } catch {
        sourcePending = true;
        sourceStorageWarning = "This tab cannot read its source-check recovery state. Source refresh stays read-only.";
    }
    const fresh = createFreshActivity({ sourceUnknown: sourcePending, sourceWarning: sourceStorageWarning });
    let collectionReadGeneration = 0;
    const historyStatus = createCollectionStatus();
    const sessionJourney = createSessionJourney();
    let reportEntry = null, reportJourney, reportComparisonUI, savedArtifactUI, artifactRefreshRequired = false, contextReturnKey, savedReportView;
    const sessionReportButton = button("Create report for this Copilot chat", createSessionReport, "primary");
    sessionReportButton.id = "createSessionReport";
    sessionReportButton.hidden = true;
    $("pageAction").after(sessionReportButton);
    let issuesSignature, issuesLoading = false, issuesStatus;
    const issueAttempts = new Map();
    const presentation = createDisclosureState(), readingPositions = new Map();
    const textAccess = createTextAccess(ux, presentation, authorship, metadata);
    const requestContext = createRequestContext();
    const callInvestigation = createCallInvestigation();
    let detailOwner = "page";
    let collection, collectionSettings, collectionBusy = false, collectionReadError = "", collectionReadReason = "", connectionNeedsSnapshot = false, pollTimer, pageInactive = false;
    mountSidebarNavigation();
    let reportScope = "selected";
    let reportAuthors = authorship.selection();
    mountThemeControl(theme, ux);
    for (const [id, icon] of Object.entries({ refreshBtn: "refresh", checkActivity: "refresh", resetView: "reset", closeDialog: "close" })) {
        $(id).prepend(ux.icon(icon));
        $(id).classList.add("icon-action");
    }
    for (const [id, text] of Object.entries(help.actions)) if ($(id)) ux.tooltip($(id), text);
    for (const node of document.querySelectorAll("[data-chart]")) ux.tooltip(node, help.charts[node.dataset.chart]);
    for (const input of document.querySelectorAll("[name=reportScope]")) {
        input.closest("label").querySelector("span").append(el("span", "scope-choice-help", help.reportScopes[input.value]));
    }
    const units = {
        tool: "Work IQ tool calls",
        "reported-api": "tool-returned API results",
        "direct-request": "recorded Graph request sites",
        "recorded-http": "Graph request sites with visible status",
        http: "owned HTTP records",
        "code-reference": "Graph code references",
    };
    const explanations = help.layers;
    let resultLabels = results.labels("tool");
    const resultKeys = Object.keys(resultLabels);
    const resultSelection = value => results.selection(value);
    const resultNames = values => values.length ? values.map(key => resultLabels[key] || "Result unavailable").join(", ") : "All results";
    function inspectSelectedResults() {
        const values = resultSelection(route.result);
        return values.length === 1 ? results.canInspect(applied.layer, values[0])
            : values.length > 1 && applied.layer !== "code-reference" && values.every(key => resultKeys.includes(key));
    }
    const reviewLabels = { captured: "Not reviewed", reviewing: "In review", ready_to_export: "Ready for report", exported: "Previously exported" };
    const nextReview = { captured: "reviewing", reviewing: "ready_to_export" };
    const nextReviewLabel = { captured: "Start review", reviewing: "Mark ready" };
    const scopeLabels = { history: "Current activity", legacy: "Preserved earlier snapshot", all: "Both collections" };
    const selected = new Set();
    let state, analytics, slice, applied, appliedRoute, generation = 0, navigationGeneration = 0, activePreview = null;
    let selectControls;
    let isStale = false, isLoading = false, exportWriting = false, returnFocus = null, route = readRoute();
    let dateDraft = null;
    let search = route.search || "", activityPage = Math.max(0, Number.parseInt(route.page || "0", 10) || 0), restoring = false, mounted = false;
    const pageSize = 8;
    const homeCount = el("span"), homeUnit = el("span");
    homeCount.id = "activityCount";
    homeUnit.id = "activityUnit";
    let readingIntent = 0;
    for (const type of ["pointerdown", "wheel", "touchmove", "keydown"]) {
        document.addEventListener(type, event => { if (event.isTrusted) readingIntent++; }, { capture: true, passive: true });
    }

    function viewKey(node, key) { node.dataset.viewKey = key; return node; }
    function keyed(key) { return [...document.querySelectorAll("[data-view-key]")].find(node => node.dataset.viewKey === key); }
    function sliceKey() { return JSON.stringify([query(), search]); }
    function scrollOwner(node) {
        for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && (parent.scrollTop || parent.scrollHeight > parent.clientHeight)) return parent;
        }
        return null;
    }
    function capturePager(pager, direction) {
        return { id: pager.id, key: pager.dataset.viewKey, top: pager.getBoundingClientRect().top,
            direction: String(direction), intent: readingIntent, scroller: scrollOwner(pager) };
    }
    function restorePager(saved) {
        if (!saved || saved.intent !== readingIntent) return;
        const pager = saved.id ? $(saved.id) : keyed(saved.key);
        if (!pager?.checkVisibility()) return;
        const buttons = [...pager.querySelectorAll("button[data-page-direction]")];
        const target = buttons.find(node => node.dataset.pageDirection === saved.direction && !node.disabled)
            || buttons.find(node => !node.disabled) || pager.querySelector("[data-page-position]");
        if (target) ux.restoreFocus(target);
        const scroller = saved.scroller?.isConnected && saved.scroller.contains(pager) ? saved.scroller : scrollOwner(pager);
        const delta = pager.getBoundingClientRect().top - saved.top;
        if (scroller) scroller.scrollBy(0, delta);
        else window.scrollBy(0, delta);
    }
    function captureReading() {
        for (const node of document.querySelectorAll("details[data-disclosure-key]")) presentation.setOpen(node.dataset.disclosureKey, node.open);
        const active = document.activeElement, owner = active?.closest("[data-view-key]");
        const focus = active?.id ? { id: active.id } : owner ? {
            key: owner.dataset.viewKey, label: active.getAttribute("aria-label"), tag: active.tagName,
            text: active.textContent, type: active.getAttribute("type"), self: active === owner,
        } : null;
        const scrollers = [...document.querySelectorAll("#workspace *")].filter(node => node.checkVisibility() && (node.scrollLeft || node.scrollTop)).map(node => ({
            id: node.id, key: node.closest("[data-view-key]")?.dataset.viewKey,
            tag: node.tagName, label: node.getAttribute("aria-label"), cls: node.className,
            left: node.scrollLeft, top: node.scrollTop,
        }));
        const activeReader = active?.closest(".full-text");
        const anchor = activeReader?.querySelector(".full-text-body pre")?.checkVisibility() ? activeReader
            : [...document.querySelectorAll("[data-view-key]")].find(node => node.checkVisibility() && node.getBoundingClientRect().top >= 100 && node.getBoundingClientRect().top < innerHeight);
        const selection = window.getSelection(), selectedText = selection?.anchorNode;
        const reader = selectedText?.parentElement?.closest(".full-text-body pre");
        const textSelection = reader?.checkVisibility() && selectedText === reader.firstChild && selection.focusNode === selectedText ? {
            key: reader.closest("[data-view-key]")?.dataset.viewKey, text: reader.textContent,
            anchor: selection.anchorOffset, focus: selection.focusOffset,
        } : null;
        return { x: scrollX, y: scrollY, focus, scrollers, anchor: anchor?.dataset.viewKey, top: anchor?.getBoundingClientRect().top, textSelection };
    }
    function restoreReading(saved) {
        if (!saved) return;
        const root = saved.focus?.key ? keyed(saved.focus.key) : null;
        const focus = saved.focus?.id ? $(saved.focus.id) : root && saved.focus.self ? root : root ? [...root.querySelectorAll("button,a,input,summary,textarea,pre")].find(node =>
            node.tagName === saved.focus.tag && (saved.focus.tag === "SUMMARY" || (saved.focus.label ? node.getAttribute("aria-label") === saved.focus.label : node.textContent === saved.focus.text && node.getAttribute("type") === saved.focus.type))) : null;
        if (focus?.checkVisibility()) ux.restoreFocus(focus);
        for (const entry of saved.scrollers) {
            const owner = entry.key ? keyed(entry.key) : null;
            const node = entry.id ? $(entry.id) : owner ? [owner, ...owner.querySelectorAll("*")].find(node =>
                node.tagName === entry.tag && node.className === entry.cls && node.getAttribute("aria-label") === entry.label) : null;
            node?.scrollTo(entry.left, entry.top);
        }
        const anchor = saved.anchor ? keyed(saved.anchor) : null;
        window.scrollTo(saved.x, anchor?.checkVisibility() ? scrollY + anchor.getBoundingClientRect().top - saved.top : saved.y);
        if (saved.textSelection) {
            const { key, text, anchor, focus } = saved.textSelection;
            const reader = key ? keyed(key)?.querySelector(".full-text-body pre") : null;
            if (reader?.checkVisibility() && reader.textContent === text) {
                window.getSelection()?.setBaseAndExtent(reader.firstChild, anchor, reader.firstChild, focus);
            }
        }
    }
    function bindDetails(node, key, renderBody, initial = false) {
        viewKey(node, "disclosure:" + key);
        node.dataset.disclosureKey = key;
        node.open = presentation.isOpen(key, initial);
        let renderedOpen = node.open;
        const update = () => {
            if (!node.isConnected || renderedOpen === node.open) return;
            renderedOpen = node.open;
            presentation.setOpen(key, node.open);
            renderBody?.(node.open);
        };
        node.ontoggle = update;
        node.querySelector(":scope>summary").onclick = event => {
            event.preventDefault();
            node.open = !node.open;
            update();
        };
        renderBody?.(node.open);
        return node;
    }
    function pagedList(host, items, { key, size = 6, noun = "items", renderItem, listTag = "div", listClass = "", wrapList = list => list, jump = false }) {
        const paint = (position = null) => {
            const page = presentation.page(key, items.length, size), start = page * size;
            const pager = viewKey(el("div", "pager list-pager"), "pager:" + key);
            const label = viewKey(el("span", "", items.length ? `${count(start + 1)}-${count(Math.min(start + size, items.length))} of ${count(items.length)} ${noun}` : `0 ${noun}`), "position:" + key);
            label.tabIndex = -1;
            label.id = "pager-position-" + encodeURIComponent(key);
            label.dataset.pagePosition = "";
            pager.append(label);
            if (items.length > size) {
                for (const [name, offset] of [["Previous", -1], ["Next", 1]]) {
                    const control = button(name, () => {
                        captureReading();
                        const position = capturePager(pager, offset);
                        presentation.setPage(key, page + offset);
                        paint(position);
                    }, "quiet");
                    control.setAttribute("aria-label", `${name} ${noun}`);
                    control.setAttribute("aria-describedby", label.id);
                    control.dataset.pageDirection = String(offset);
                    control.disabled = offset < 0 ? page === 0 : start + size >= items.length;
                    pager.append(control);
                }
                if (jump) {
                    const pages = Math.ceil(items.length / size);
                    const form = el("form", "library-page-jump"), fieldLabel = el("label", "", "Page"), input = el("input");
                    input.type = "number"; input.min = "1"; input.max = String(pages); input.step = "1";
                    input.required = true; input.value = String(page + 1);
                    input.setAttribute("aria-label", "Saved library page");
                    fieldLabel.append(input, el("span", "", `of ${count(pages)}`));
                    const go = el("button", "quiet", "Go"); go.type = "submit"; go.setAttribute("aria-label", "Go to page");
                    form.append(fieldLabel, go);
                    form.addEventListener("submit", event => {
                        event.preventDefault();
                        if (!form.reportValidity()) return;
                        const position = capturePager(pager, 0);
                        presentation.setPage(key, input.valueAsNumber - 1);
                        paint(position);
                        keyed("pager:" + key)?.querySelector("input")?.focus({ preventScroll: true });
                    });
                    pager.append(form);
                }
            }
            const list = el(listTag, listClass);
            for (const item of items.slice(start, start + size)) list.append(renderItem(item));
            host.replaceChildren(pager, wrapList(list));
            if (position) restorePager(position);
        };
        paint();
    }

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }
    function button(text, action, cls = "") {
        const node = el("button", cls, text);
        node.type = "button";
        node.addEventListener("click", action);
        return node;
    }
    function option(value, label) { const node = el("option", "", label); node.value = value; return node; }
    function count(value) { return Number.isFinite(value) ? value.toLocaleString() : "Not recorded"; }
    function localQuery(id) { return route.localSearch?.[id] || ""; }
    const scopedSearches = {
        settingsSearch: "clearSettingsSearch", issueSearch: "clearIssueSearch",
        savedReportSearch: "clearSavedReportSearch", reportRequestSearch: "clearReportRequestSearch",
    };
    function syncLocalSearchFields() {
        for (const [id, clear] of Object.entries(scopedSearches)) {
            if ($(id).value !== localQuery(id)) $(id).value = localQuery(id);
            $(clear).hidden = !localQuery(id);
        }
        $("clearActivitySearch").hidden = !search;
    }
    function highlighted(node, text, query) {
        for (const part of localSearch.parts(text, query)) node.append(part.match ? el("mark", "", part.text) : document.createTextNode(part.text));
        return node;
    }
    function settingsTarget(entry) {
        const approved = collection?.config?.approved;
        if (entry.id === "source") return !$("sourceEditor").hidden ? "sourceDatabase" : approved ? "editSource" : "reviewSource";
        if (entry.id === "source-paths") return !$("sourceEditor").hidden ? "sourceDatabase" : approved ? "approvedSourceTitle" : "reviewSource";
        if (!approved && ["source-paths", "collection-state"].includes(entry.id)) return "reviewSource";
        if (entry.id === "save-preferences" && $("preferenceActions").hidden) return "settingsDraftStatus";
        return entry.target;
    }
    function renderSettingsSearch() {
        const query = localQuery("settingsSearch"), entries = settingsNavigation.find(query);
        const contexts = entries.map(entry => {
            const id = settingsTarget(entry), control = $(id);
            if (!collection?.config?.approved && entry.id === "collect-now") return "Refresh reads stored activity only. Approve a source separately to check history; opening this result does neither.";
            if (!collection?.config?.approved && ["source-paths", "collection-state"].includes(entry.id)) return "Requires an approved source. Open Connection to review permission; nothing is started.";
            if (entry.id === "source") return collectionSettings?.explain(id) || "Read the current connection before reviewing a source.";
            if (control?.disabled) return collectionSettings?.explain(id) || "Unavailable while the current update finishes.";
            if (entry.id === "save-preferences" && $("preferenceActions").hidden) return $("settingsDraftStatus").textContent;
            return entry.context;
        });
        const signature = JSON.stringify([query, contexts]);
        if (signature === settingsSearchSignature) return;
        settingsSearchSignature = signature;
        const list = $("settingsSearchResults"), status = $("settingsSearchCount");
        const focusedSetting = list.contains(document.activeElement) ? document.activeElement.dataset.setting : null;
        list.replaceChildren();
        list.hidden = !query.trim();
        status.hidden = !query.trim();
        setText(status, entries.length ? `${entries.length} setting${entries.length === 1 ? "" : "s"} found. Choose a result to locate it, not apply it.` : "No settings match. Try a setting name or purpose, such as time zone or history.");
        entries.forEach((entry, index) => {
            const item = el("li"), anchor = link("", entry.view || "settings", { section: entry.section, setting: entry.id });
            anchor.dataset.setting = entry.id;
            anchor.append(highlighted(el("strong"), entry.title, query), highlighted(el("span", "search-category"), entry.category, query), highlighted(el("span", "search-context"), contexts[index], query));
            item.append(anchor); list.append(item);
        });
        if (focusedSetting) [...list.querySelectorAll("a")].find(anchor => anchor.dataset.setting === focusedSetting)?.focus({ preventScroll: true });
    }
    function renderSettingsNavigation() {
        const section = route.view === "settings" ? settingsNavigation.resolve(route).section : "connection";
        collectionSettings?.setSection(route.view === "settings" ? section : null);
        for (const pane of document.querySelectorAll("[data-settings-section]")) pane.hidden = pane.dataset.settingsSection !== section;
        for (const anchor of $("settingsCategoryNav").children) {
            const selected = anchor.dataset.category === section;
            if (selected) anchor.setAttribute("aria-current", "page");
            else anchor.removeAttribute("aria-current");
            anchor.href = routeUrl(routeFor("settings", { section: anchor.dataset.category, setting: undefined, issues: undefined }));
        }
        setText($("settingsCategorySummary"), "Category: " + settingsNavigation.categories.find(category => category.id === section).title);
        setText($("settingsRouteNotice"), route.settingsWarning || "");
        $("settingsRouteNotice").hidden = !route.settingsWarning;
        renderSettingsSearch();
    }
    function revealSetting() {
        document.querySelector(".settings-target")?.classList.remove("settings-target");
        if (compactSettings) $("settingsCategories").open = false;
        const resolved = settingsNavigation.resolve(route), entry = settingsNavigation.entries.find(entry => entry.id === resolved.setting);
        let target = $(entry ? settingsTarget(entry) : settingsNavigation.categories.find(category => category.id === resolved.section).heading);
        if (target?.tagName === "DETAILS") {
            target.open = true;
            presentation.setOpen(target.id, true);
            target = target.querySelector("summary");
        } else if (target?.tagName === "SELECT") target = $(target.id + "-control");
        if (target?.disabled) target = target.closest(".ux-disabled-help") || $(settingsNavigation.categories.find(category => category.id === resolved.section).heading);
        if (!target?.checkVisibility()) target = $(settingsNavigation.categories.find(category => category.id === resolved.section).heading);
        if (!target.matches("button,input,summary,a,[tabindex]")) target.tabIndex = -1;
        if (entry) target.classList.add("settings-target");
        ux.restoreFocus(target);
        target.scrollIntoView({ block: "nearest" });
    }
    function revealCollectionStatus() {
        document.querySelector(".settings-target")?.classList.remove("settings-target");
        const entry = settingsNavigation.entries.find(entry => entry.view === "collection-status" && entry.id === route.setting);
        let target = $(entry?.target || "pageTitle");
        if (target.tagName === "DETAILS") {
            target.open = true;
            presentation.setOpen(target.id, true);
            target = target.querySelector("summary");
        }
        ux.restoreFocus(target);
        target.scrollIntoView({ block: route.setting ? "nearest" : "start" });
        refreshCollectionIssues();
    }
    function serviceLabel(value) { return categories.describe(value).label; }
    function categoryNoun(layer = applied?.layer || route.layer || "tool") { return layer === "tool" ? "Activity category" : "Service"; }
    function allCategories() { return categoryNoun() === "Service" ? "All services" : "All categories"; }
    function serviceCue(tag, value) {
        const entry = categories.describe(value), node = el(tag, `semantic-cue service-cue dimensional-tone-${dimensional.tone(entry.id)}`);
        node.dataset.service = entry.id;
        node.innerHTML = dimensionalIcons[entry.id];
        node.append(el("span", "", entry.label));
        return node;
    }
    function serviceHeading(tag, value) {
        const entry = categories.describe(value), heading = el(tag);
        const cue = serviceCue("span", value);
        cue.lastElementChild.replaceChildren(metadata.item(entry.label, { help: entry.description }));
        heading.append(cue);
        return heading;
    }
    function actionHeading(title, service, row, layer = "tool") {
        const heading = el("div", "action-heading");
        heading.append(el("h3", "", title));
        if (service) {
            const entry = categories.describe(service), identity = el("span", "action-service-heading");
            const operation = categories.operation(title), cue = serviceCue("span", service);
            const evidence = categories.serviceEvidence(row ? { ...row, tool: title } : row, layer);
            const label = service === "Discovery" || evidence?.reason === "hosted-routing" ? operation.label : entry.label;
            cue.lastElementChild.textContent = label;
            if (evidence) cue.querySelector("svg")?.remove();
            identity.append(cue, ux.helpButton(label, evidence?.description ?? (service === "Discovery" ? operation.description : entry.description)));
            heading.append(identity);
        }
        return heading;
    }
    function resultHelp(key) {
        return help.resultHelp(key, applied?.layer || route.layer || "tool");
    }
    function fieldHelp(id, labelText, text) {
        const control = $(id), label = control.closest("label"), field = el("div", "filter-field"), heading = el("div", "help-heading");
        label.replaceWith(field);
        label.replaceChildren(document.createTextNode(labelText));
        label.htmlFor = id;
        heading.append(label, ux.helpButton(labelText, text));
        field.append(heading, control);
    }
    fieldHelp("dateFilter", "Dates", "All dates uses retained evidence in this collection. Last 7/30 days include today. Custom dates include both boundary days in the display time zone. Changing dates does not collect history.");
    fieldHelp("toolFilter", "Tool", "The recorded tool name, not the prompt's author. Tools and all other filters narrow the same evidence rows.");
    fieldHelp("serviceAssociationFilter", "Service", "Match any recorded service target, including multi-service calls. Choosing a service also includes separately named missing-service context; remove its chip for strict matches. Category keeps the existing exclusive breakdowns.");
    fieldHelp("serviceFilter", "Category", () => {
        const layer = applied?.layer || route.layer || "tool";
        const selected = applied ? applied.filters.workloads?.[0] : route.service;
        return selected ? `${categories.describe(selected).label}: ${categories.describe(selected).description}`
            : help.categoryGuide([...$("serviceFilter").options].filter(option => option.value !== "all").map(option => option.value), layer);
    });
    fieldHelp("projectFilter", "Project", () => help.describeOption({ id: "projectFilter", value: route.project || "all" }));
    fieldHelp("chatFilter", "Chat", "Filter to a retained Copilot chat or recorder source. Dates, tools, services, outcomes, authors and other choices stay applied.");
    fieldHelp("layerFilter", "Activity", () => `${help.layers[applied?.layer || route.layer || "tool"]} ${help.fields.layerFilter}`);
    fieldHelp("scopeFilter", "Collection", () => `${help.fields.scopeFilter} ${help.describeOption({ id: "scopeFilter", value: route.scope || "history" })}`);
    $("filters").querySelector(".filter-scroll").addEventListener("focusin", event => {
        if (event.target instanceof HTMLElement && event.target.matches("button")) {
            (event.target.closest(".help-heading") || event.target).scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    });
    const authorHeading = el("div", "help-heading result-filter-heading"), authorLabel = $("promptAuthorFilterLabel");
    authorLabel.replaceWith(authorHeading);
    authorHeading.append(authorLabel, ux.helpButton("Prompt author", "Choose Your prompts, Agent prompts, or both, then Apply. All also includes unverified authors. This filters whole originating interactions, not which actor executed their calls."));
    const resultHeading = el("div", "help-heading result-filter-heading"), resultLabel = $("resultFilterLabel");
    resultLabel.replaceWith(resultHeading);
    resultHeading.append(resultLabel, ux.helpButton("Recorded result", () => {
        const layer = applied?.layer || route.layer || "tool", selected = resultSelection(applied?.filters.outcomes);
        if (layer === "code-reference") return help.resultHelp("unknown", layer);
        return selected.length !== 1 ? help.describeOption({ id: "outcomeFilter", value: "all" }, { layer })
            : `Menu counts are before result filtering; other filters still apply. ${help.resultHelp(selected[0], layer)}`;
    }));
    fieldHelp("activitySearch", "Search these interactions", help.fields.activitySearch);
    const activitySearchInput = $("activitySearch"), activitySearchRow = el("div", "search-input-row");
    activitySearchInput.replaceWith(activitySearchRow);
    activitySearchRow.append(activitySearchInput, $("clearActivitySearch"));
    $("clearActivitySearch").textContent = "Clear";
    $("clearActivitySearch").setAttribute("aria-label", "Clear activity search");
    $("clearResultFilter").append(ux.icon("close"));
    ux.tooltip($("clearResultFilter"), "Clear recorded result filter. Other filters stay applied.");
    $("clearPromptAuthorFilter").append(ux.icon("close"));
    ux.tooltip($("clearPromptAuthorFilter"), "Include all prompt authors, including unverified. Other filters stay applied.");
    for (const [id, label, text] of [
        ["promptOptions", "Prompts in this report", "Choose omitted, masked or original wording for report copies only. Originals stay unchanged; detected credentials are removed in every mode."],
        ["formatOptions", "Export formats", "Every selected format uses the same frozen, reviewed snapshot. Files are saved locally only after disclosure review and final confirmation."],
    ]) $(id).querySelector("legend").append(ux.helpButton(label, text));
    const formatHelp = {
        html: "A self-contained, readable report with charts and definitions. Opens locally in a browser without external resources.",
        pdf: "A print-ready copy rendered locally from the HTML report. Category definitions stay visible on the page, not in tooltips.",
        json: "Structured records, reviewed prompt copies and category definitions for technical use, from the same frozen report snapshot.",
        markdown: "A plain-text report with tables, category definitions and reviewed prompt copies, suitable for Markdown readers.",
    };
    for (const control of $("formatOptions").querySelectorAll("input[type=checkbox]")) {
        const label = control.closest("label"), row = el("div", "field-help-choice");
        label.replaceWith(row);
        row.append(label, ux.helpButton(control.value === "markdown" ? "Markdown" : control.value.toUpperCase(), formatHelp[control.value]));
    }
    function date(value, full = false) {
        return time.formatDate(value, applied?.timeContext || viewerTime, full);
    }
    function timestamp(value) { return time.formatTime(value, applied?.timeContext || viewerTime); }
    function dateInput(value) {
        if (!value) return "";
        try { return value.includes("T") ? time.day(value, (applied?.timeContext || viewerTime).timeZone) : time.calendar(value); }
        catch { announce("Invalid date filter. Choose real calendar dates or use Reset Analyze.", "error"); return ""; }
    }
    function dateSelection() {
        return { range: route.range || (route.from || route.to ? "custom" : "capture"), ...(route.from ? { from: route.from } : {}), ...(route.to ? { to: route.to } : {}) };
    }
    function syncTime() {
        const nextTime = displayTimeSettings.resolve();
        if (JSON.stringify(nextTime) !== JSON.stringify(viewerTime)) {
            deletionUI?.invalidate();
            recollectionUI?.invalidate();
            reportComparisonUI?.invalidate("Display time context changed. Prepare and review a new comparison copy.", false, { force: true });
        }
        viewerTime = nextTime;
        if (["7", "30"].includes(route.range)) {
            const to = time.day(new Date().toISOString(), viewerTime.timeZone);
            route = { ...route, from: time.addDays(to, 1 - Number(route.range)), to };
            rememberRoute(route, true);
        }
        if (draft.synchronizeTime(viewerTime, dateSelection())) invalidatePreview("The report time or date basis changed. Return to Setup and scan again.");
        renderTimeContext();
    }
    function renderTimeContext() {
        const context = applied?.timeContext || viewerTime, indicator = $("displayTimeZoneLink");
        setText(indicator, time.displayLabel(context));
        indicator.setAttribute("aria-label", `${time.displayLabel(context)}. Time zone: ${time.label(context)}. Open Time zone settings.`);
        ux.tooltip(indicator, `Time zone: ${time.label(context)}. Offsets follow each timestamp, including daylight saving. Open Time zone settings.`);
        displayTimeSettings.receive(context, { busy: exportWriting, pending: isLoading, stale: !isLoading && isStale && context.timeZone !== viewerTime.timeZone });
        const notice = $("timeZoneNotice");
        notice.textContent = [displayTimeSettings.warning(), context.timeZoneFallback ? "Browser timezone unavailable. Dates and reports use UTC, not an inferred local timezone." : "", context.localeFallback ? "Browser locale unavailable. Dates use en-US formatting." : ""].filter(Boolean).join(" ");
        notice.hidden = !notice.textContent;
        selectControls?.sync();
    }
    function timeChanged() { return JSON.stringify(displayTimeSettings.resolve()) !== JSON.stringify(viewerTime); }
    function ensureCurrentTime() {
        if (exportWriting) return false;
        if (!timeChanged()) return true;
        invalidatePreview();
        invalidateDialog("Your timezone or locale changed. Close and prepare a fresh report preview.");
        load();
        return false;
    }
    function shorten(value, length = 170) {
        const text = String(value ?? "").replace(/\s+/g, " ").trim();
        return text.length > length ? text.slice(0, length).trimEnd() + "..." : text;
    }
    function excerpt(scenario) {
        return textAccess.excerpt(scenario.userPrompt);
    }
    function facts(pairs, { inlineHelp = true, missing = {}, technical = false } = {}) {
        const list = el("dl", "facts");
        if (technical) list.classList.add("technical-facts");
        for (const [label, value] of pairs) {
            const cell = el("dd");
            if (value != null && ["Tool call ID", "Parent invocation", "Parallel group", "Copilot chat ID", "Source event"].includes(label)) cell.append(ux.inlineCode(String(value), { label: "Copy " + label.toLowerCase() }));
            else cell.textContent = value == null ? missing[label]?.label ?? "Not recorded" : String(value);
            const term = el("dt", "", label);
            const explanation = inlineHelp || label === "Snapshot revision" ? (value == null ? missing[label]?.help : null) ?? help.facts[label] : undefined;
            if (explanation) {
                if (inlineHelp) term.replaceChildren(metadata.item(label, { help: explanation }));
                else term.append(ux.helpButton(label, explanation));
            }
            list.append(term, cell);
        }
        return list;
    }
    function disclosure(title, content, cls = "", owner = detailOwner) {
        const node = el("details", "detail-disclosure " + cls);
        const copyLabel = /full original request/.test(title) ? "Copy original request" : /Exact recorded arguments/.test(title) ? "Copy recorded arguments" : "Copy " + title.toLowerCase();
        node.append(el("summary", "", title), typeof content === "string" ? ux.codeBlock(content, { label: title, copyLabel, prose: cls.includes("original-prompt") }) : content);
        return bindDetails(node, JSON.stringify([owner, title]));
    }
    function empty(title, text) {
        const node = el("div", "empty-state");
        node.append(el("h3", "", title), el("p", "", text));
        return node;
    }
    function announce(text, kind = "", retry = false) {
        const node = $("message");
        delete node.dataset.connectionFailure;
        node.replaceChildren(el("p", "", text));
        node.className = "notice " + kind;
        node.setAttribute("role", kind === "error" ? "alert" : "status");
        node.hidden = false;
        if (retry) {
            const control = button("Retry", refreshStoredData, "quiet");
            control.dataset.storedRefreshRetry = "";
            control.setAttribute("aria-describedby", "storedRefreshHelp");
            node.append(control);
            renderStoredRefresh();
        }
    }
    function clearMessage() { $("message").hidden = true; }

    const api = createBoardTransport(capability, () => {
        connectionNeedsSnapshot = true;
        assessmentUI?.invalidate("The local connection changed. Read current insights; no update was replayed.");
        automaticUI?.invalidate("The local connection changed. Read the original approval result; nothing was repeated.");
        deletionUI?.invalidate();
        recollectionUI?.invalidate();
        invalidatePreview();
        isStale = true;
        invalidateDialog("The local connection changed. Close and prepare a new report preview.");
        updateSelection();
    });
    deletionUI = mountDeletion({ api, flow: createDeletionFlow(), timeContext: () => viewerTime, ux,
        onCommitted: async () => {
            clearDeletedDraft("deleted");
            return load();
        },
    });
    recollectionUI = assessmentFactories.mountRecollection({ api, time, timeContext: () => viewerTime, search: localSearch, ux,
        pageSources: (host, sources, renderItem, reset) => {
            if (reset) presentation.setPage("recollection-chats", 0);
            pagedList(host, sources, { key: "recollection-chats", size: pageSize, noun: "chats", renderItem });
        },
        onCommitted: async () => {
            clearDeletedDraft("changed by explicit recollection");
            return load();
        },
    });
    assessmentUI = assessmentFactories.createExperience({
        ...assessmentFactories, api, ux, textAccess, glossary: help.glossary,
        bindDetails: (node, key) => {
            bindDetails(node, key);
            const saved = readingPositions.get(readingKey(route)), navigation = navigationGeneration, intent = readingIntent;
            if (saved?.focus?.key === node.dataset.viewKey) queueMicrotask(() => {
                const active = document.activeElement;
                if (node.isConnected && navigation === navigationGeneration && intent === readingIntent
                    && (active === document.body || active === $("pageTitle") || !active?.checkVisibility())) restoreReading(saved);
            });
        },
        refresh: () => load({ background: true }),
        onNotice: message => announce(message, "error"),
        onSaved: message => announce(message),
        onAutomaticSetup: trigger => automaticUI.open(trigger),
        onChanged: () => {
            invalidatePreview();
            invalidateDialog("Recorded evidence, permission or feedback changed. Prepare a new report preview.");
        },
    });
    automaticUI = assessmentFactories.createAutomaticExperience({
        root: $("automaticScoreSetup"), api, ux,
        onStatus: status => assessmentUI.scoringStatus(status),
        mountRow: assessmentFactories.mountAutomaticRow, mountApproval: assessmentFactories.mountAutomaticApproval,
        createClient: assessmentFactories.createAutomaticClient,
        formatTimestamp: value => timestamp(value),
        refresh: () => load({ background: true }),
        onNotice: message => announce(message, "error"),
        onChanged: () => { invalidatePreview(); invalidateDialog("Score-processing approval changed. Prepare a new report preview."); },
    });
    const periodComparisonUI = assessmentFactories.periodComparison.mount({
        root: $("periodComparison"), toggle: $("comparePeriods"), api, time, search: localSearch, categories, results,
        projection: createActivityProjection(time, categories, resultKeys),
        createState: assessmentFactories.periodComparison.createState, assessmentFactories, bindDetails,
        getContext: () => ({ snapshot: state, options: query(), route, search, isLoading, isStale }),
        navigate: changes => navigate(routeFor("analyze", changes), false, { keepFocus: true }),
        onSearch: value => { $("activitySearch").value = value; $("activitySearch").dispatchEvent(new Event("input")); },
        syncFilters: () => selectControls?.sync(),
        recordLink: (row, side, value) => link(row.tool, "request", {
            request: row.scenarioId, call: row.id, callRevision: value.definitions.layer === "reported-api" ? String(value.revision) : undefined,
            range: "custom", from: side.range.from, to: side.range.to,
        }, "text-link"),
    });
    function clearDeletedDraft(change = "changed") {
        assessmentUI.invalidate(`Collected activity or its optional evidence was ${change}. Read current insights.`);
        reportComparisonUI?.invalidate("Collected activity changed. The unfinished comparison was cleared.", true, { force: true });
        selected.clear();
        reportScope = "selected";
        reportEntry = null;
        draft.clearSelection();
        invalidatePreview();
        invalidateDialog(`Collected activity was ${change}. This report preview is no longer available.`);
        reportJourney?.clear();
        $("detail").replaceChildren();
    }
    function invalidatePreview(message) {
        if (exportWriting) return;
        draft.invalidate();
        if (message !== "") $("reportReviewBody")?.querySelector(".rebuild-preview")?.remove();
        reportJourney?.invalidate(message);
        const preview = activePreview;
        activePreview = null;
        if (preview?.previewId) api("/api/cancel-preview", { previewId: preview.previewId }).catch(() => announce("The previous preview could not be cancelled on the runtime. Do not reuse it; prepare a new preview before reviewing.", "error"));
    }
    function readRoute(hash = location.hash, navigationState = history.state) {
        const [rawView, rawQuery = ""] = hash.slice(1).split("?");
        const view = rawView === "report" ? "reports" : rawView || "analyze";
        const params = new URLSearchParams(rawQuery);
        const keys = ["layer", "chart", "bucket", "range", "from", "to", "tool", "services", "includeMissingService", "withinServices", "service", "project", "result", "authors", "scope", "endpoint", "session", "request", "page", "expanded", "origin", "issues", "section", "setting", "task", "mode", "call", "callSort", "callRevision", "compare", "aFrom", "aTo", "bFrom", "bTo"];
        const values = { view: ["analyze", "home", "overview", "activity", "calls", "request", "reports", "settings", "collection-status"].includes(view) ? view : "analyze" };
        for (const key of keys) if (params.has(key)) values[key] = params.get(key);
        if (rawView === "activity" && values.session && values.result && !values.mode) values.mode = "calls";
        if (view === "reports" && !params.has("task") && (rawView === "report" || values.request)) values.task = "create";
        if (navigationState?.evidenceView?.url === hash && typeof navigationState.evidenceView.search === "string") values.search = navigationState.evidenceView.search;
        if (navigationState?.evidenceView?.url === hash && navigationState.evidenceView.returnToSessions) values.returnToSessions = navigationState.evidenceView.returnToSessions;
        if (navigationState?.evidenceView?.url === hash) {
            values.localSearch = Object.fromEntries(["settingsSearch", "savedReportSearch", "reportRequestSearch", "issueSearch"]
                .filter(key => typeof navigationState.evidenceView.localSearch?.[key] === "string")
                .map(key => [key, navigationState.evidenceView.localSearch[key]]));
        }
        return canonicalRoute(values);
    }
    function canonicalRoute(next) {
        next = filterState.canonical(sessionJourney.canonical(next));
        if (next.view !== "request" && Object.hasOwn(next, "call")) next = { ...next, call: undefined };
        if ((next.view !== "request" || next.layer !== "reported-api" || next.call === undefined) && Object.hasOwn(next, "callRevision")) {
            next = { ...next, callRevision: undefined };
        }
        if (next.callSort && !["slowest", "fastest"].includes(next.callSort)) next = { ...next, callSort: undefined };
        if (Object.hasOwn(next, "task") && (next.task !== "create" || !["reports", "request"].includes(next.view))) {
            const { task, ...rest } = next;
            next = rest;
        }
        if (Object.hasOwn(next, "result")) next = { ...next, result: results.filterValue(next.result) };
        if (Object.hasOwn(next, "authors")) next = { ...next, authors: authorship.filterValue(next.authors) };
        if ((next.from || next.to) && (!next.range || next.range === "capture")) {
            const normalized = {};
            for (const [key, value] of Object.entries(next)) {
                if (key === "range") continue;
                if (["from", "to"].includes(key) && !Object.hasOwn(normalized, "range")) normalized.range = "custom";
                normalized[key] = value;
            }
            next = normalized;
        }
        if (!["settings", "collection-status"].includes(next.view)) return next;
        const { view, section, setting, warning } = settingsNavigation.resolve(next);
        return { ...next, view: view || "settings", section, setting, issues: undefined, settingsWarning: warning || next.settingsWarning };
    }
    function routeUrl(next) {
        next = canonicalRoute(next);
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries(next)) if (!["view", "search", "returnToSessions", "localSearch", "settingsWarning"].includes(key) && value !== null && value !== undefined && value !== "" && !(value === "all" && ["project", "service", "result"].includes(key))) params.set(key, value);
        return "#" + next.view + (params.size ? "?" + params.toString() : "");
    }
    function routeFor(view, changes = {}) {
        view = sessionJourney.canonical({ view }).view;
        return {
            ...route, view,
            request: ["request", "reports"].includes(view) ? route.request : undefined,
            call: view === "request" && (!changes.request || changes.request === route.request) ? route.call : undefined,
            callRevision: view === "request" && (!changes.request || changes.request === route.request) ? route.callRevision : undefined,
            origin: view === "request" ? (route.view === "reports" ? "reports" : route.origin || "analyze") : undefined,
            task: view === "reports" ? (route.view === "reports" ? route.task : route.origin === "reports" ? "create" : undefined)
                : view === "request" && route.view === "reports" ? route.task : undefined,
            issues: view === "settings" ? route.issues : undefined,
            section: view === "settings" ? route.section : undefined,
            setting: view === route.view && ["settings", "collection-status"].includes(view) ? route.setting : undefined,
            settingsWarning: undefined,
            ...changes,
        };
    }
    function readingKey(value) {
        const [view, query = ""] = routeUrl(value).split("?");
        const params = new URLSearchParams(query);
        params.sort();
        return JSON.stringify([view, params.toString(), value.search || ""]);
    }
    function go(view, changes = {}, replace = false) {
        if (view === "activity" && changes.session) presentation.setOpen("session:" + changes.session, true);
        return navigate(routeFor(view, changes), replace);
    }
    function rememberRoute(next, replace = false) {
        const url = routeUrl(next);
        // Private-text search belongs to this browser history entry, never a copied URL.
        const navigationState = { ...history.state, evidenceView: { url, search: next.search || "", returnToSessions: next.returnToSessions, localSearch: next.localSearch } };
        if (replace) history.replaceState(navigationState, "", url);
        else history.pushState(navigationState, "", url);
    }
    function navigate(next, replace = false, options = {}) {
        next = canonicalRoute(next);
        rememberRoute(next, replace);
        return applyRoute(next, options);
    }
    function link(label, view, changes = {}, cls = "") {
        const node = el("a", cls, label);
        node.href = routeUrl(routeFor(view, changes));
        node.addEventListener("click", (event) => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            go(view, changes);
        });
        return node;
    }
    function routeLink(label, next, cls = "text-link") {
        const node = el("a", cls, label);
        node.href = routeUrl(next);
        node.addEventListener("click", event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (next.session) presentation.setOpen("session:" + next.session, true);
            navigate(next, false, { restorePosition: next.view === "collection-status" && route.view === "analyze" && Boolean(route.session) });
        });
        return node;
    }
    function sessionsRoute() {
        return route.returnToSessions || { ...filterState.scope(route, sessionJourney.open(route, undefined)), search, session: undefined };
    }
    function sessionRoute(sessionId, result) {
        return { ...filterState.scope(route, sessionJourney.open(route, sessionId, result)), search, returnToSessions: route.returnToSessions || { ...route, session: undefined, request: undefined } };
    }
    function sessionSource(sessionId = route.session || state?.scenarios.find(s => s.scenarioId === route.request)?.sourceSessionId) {
        const source = state?.sessions?.find(s => s.sessionId === sessionId);
        if (source) return source;
        const scenario = state?.scenarios.find(s => s.sourceSessionId === sessionId);
        return sessionId ? { sessionId, name: scenario?.sourceSessionName || chatCopy.unnamed, projectId: scenario?.projectId, project: scenario?.project } : null;
    }
    function sourceReference(source) {
        if (!source) return null;
        const sources = new Map((state?.sessions || []).map(item => [item.sessionId, item.name]));
        for (const item of state?.scenarios || []) if (item.sourceSessionId && !sources.has(item.sourceSessionId)) {
            sources.set(item.sourceSessionId, item.sourceSessionName || chatCopy.unnamed);
        }
        if (source.name !== chatCopy.unnamed && ![...sources].some(([id, name]) => id !== source.sessionId && name === source.name)) return null;
        let length = Math.min(8, source.sessionId.length);
        while (length < source.sessionId.length && [...sources.keys()].some(id => id !== source.sessionId && id.endsWith(source.sessionId.slice(-length)))) length++;
        return `${applied.layer === "http" ? "Source" : "Chat"} ${length < source.sessionId.length ? "..." : ""}${source.sessionId.slice(-length)}`;
    }
    function createSessionReport() {
        const source = sessionSource(), requestIds = sessionJourney.reportIds(state?.exportCatalog, source?.sessionId);
        if (isLoading || isStale || requestIds === null) { announce("Copilot chat report scope is unavailable. Refresh before selecting request groups.", "error"); return; }
        if (!requestIds.length) { announce("No eligible collected request groups are available for this Copilot chat. Check its collection coverage or choose another Copilot chat."); return; }
        selected.clear();
        for (const id of requestIds) selected.add(id);
        reportScope = "selected";
        reportEntry = { scope: "selected", sessionId: source.sessionId, sessionName: source.name, projectId: source.projectId, projectName: source.project, requestIds, returnTo: { ...route, view: "activity", request: undefined } };
        draft.clearSelection();
        invalidatePreview();
        reportJourney?.clear();
        go("reports", { request: undefined, task: "create" });
    }
    function selectionRows() { return analytics?.rows || []; }
    function idsFor(row) { return Array.isArray(row?.scenarioIds) && row.scenarioIds.length ? row.scenarioIds : [row?.scenarioId]; }
    function rowsFor(scenarioId) {
        return selectionRows().filter(row => row.scenarioId === scenarioId);
    }
    function fullRowsFor(scenarioId, layer = applied.layer) {
        const rows = state.requestActivity?.[layer];
        return results.summarize(rows) ? rows.filter(row => idsFor(row).includes(scenarioId)) : undefined;
    }
    function sourceCallFor(row) {
        const scenario = state.scenarios.find(item => item.scenarioId === row?.scenarioId);
        return scenario?.toolCalls?.find(tool => tool.toolCallId ? tool.toolCallId === row.toolCallId
            : (row.parentCallId || row.id) === `event:${JSON.stringify([scenario.sourceSessionId, tool.startEventId])}`);
    }
    function resultLine(layer, summary, { total, scope = "Recorded results", label, help: explanation, sessionId, heading } = {}) {
        const node = el("div", "recorded-results");
        node.dataset.resultLayer = layer;
        node.setAttribute("role", "group");
        node.setAttribute("aria-label", scope);
        const entries = results.entries(layer, summary);
        if (!entries) {
            const unavailable = el("span", "result-unavailable");
            unavailable.append(metadata.item(`${label || results.unit(layer, 2)}: result counts unavailable`, explanation ? { help: explanation } : {}));
            node.append(unavailable);
            return node;
        }
        const unit = el("strong", "result-unit");
        unit.append(metadata.item(label || results.countLabel(layer, summary.count, total), explanation ? { helpLabel: "recorded tool result", help: explanation } : {}));
        const values = heading ? el("div", "result-values") : node;
        if (heading) {
            node.classList.add("result-with-heading");
            const description = el("div", "result-description");
            description.append(el("strong", "result-heading", heading), unit);
            node.append(description, values);
        } else node.append(unit);
        for (const entry of entries) {
            const actionable = sessionId && results.canInspect(layer, entry.key);
            const classes = `recorded-result ${entry.key} result-tone-${entry.key}`;
            const item = actionable ? routeLink("", sessionRoute(sessionId, entry.key), classes + " result-link") : el("span", classes);
            item.dataset.outcome = entry.key;
            item.dataset.count = entry.count;
            item.append(ux.icon(entry.icon), el("span", "recorded-result-label", `${count(entry.count)} ${entry.label}`));
            if (actionable) {
                viewKey(item, `session-result:${scope}:${sessionId}:${layer}:${entry.key}`);
                const label = layer === "tool" ? `View ${count(entry.count)} Work IQ tool call${entry.count === 1 ? "" : "s"} ${entry.key === "success" ? "that worked" : "needing attention"}` : `View ${count(entry.count)} ${results.unit(layer, entry.count)}: ${entry.label}`;
                item.setAttribute("aria-label", `${label} in ${layer === "http" ? "recorder source" : "GitHub Copilot chat"} ${sessionSource(sessionId)?.name}. Current date, service and request scope.`);
                ux.tooltip(item, `${label} in this ${layer === "http" ? "recorder source" : "Copilot chat"} and scope. ${help.resultHelp(entry.key, layer)} Nothing is retried or executed.`);
            }
            values.append(item);
        }
        if (!summary.count) values.append(el("span", "muted", "None in this scope"));
        return node;
    }
    function matchingResults(scenarioId) {
        const rows = rowsFor(scenarioId), full = results.summarize(fullRowsFor(scenarioId));
        return resultLine(applied.layer, results.summarize(rows), { total: full?.count ?? null, scope: "Matching results only" });
    }
    function fullResults(host, scenarioId, reportRequest) {
        let shown = false;
        for (const layer of results.layers.filter(layer => layer !== "recorded-http")) {
            const summary = reportRequest ? reportRequest.results?.[layer] : results.summarize(fullRowsFor(scenarioId, layer));
            if (summary?.count === 0) continue;
            host.append(resultLine(layer, summary, { scope: reportRequest ? "Full report request results" : "Full request results", help: !reportRequest && layer === "tool" ? explanations.tool : undefined, heading: reportRequest ? undefined : results.heading(layer) }));
            shown = true;
        }
        if (!reportRequest && results.summarize(fullRowsFor(scenarioId, "tool"))?.count) {
            host.append(el("p", "result-evidence-note", "Completion is not correctness. API status is tool-reported, not directly observed."));
            const calls = fullRowsFor(scenarioId, "tool");
            if (results.summarize(fullRowsFor(scenarioId, "reported-api"))?.count === 0
                && !calls?.every(row => row.workload === "Discovery")) host.append(el("p", "result-missing-api", "API metadata: None recorded."));
        }
        if (!shown) host.append(el("p", "muted", "No canonical activity recorded for this request."));
    }
    function pathField(list, label, path, missing = "Not recorded") {
        const value = el("dd", "api-path-value");
        value.append(path === null ? el("span", "muted", missing) : el("code", "api-path", path));
        list.append(el("dt", "", label), value);
    }
    function actionFields(call, row, { includeTool = true, includeService = true, includePurpose = true, returned = false } = {}) {
        const list = el("dl", "action-fields");
        const operation = !returned ? categories.operation(call?.tool || row?.tool) : null;
        const discovery = operation?.category === "Discovery";
        if (includeTool) list.append(el("dt", "", "Tool"), el("dd", "action-tool", call?.tool || row?.tool || "Not recorded"));
        if (includeService) {
            const service = el("dd", "action-service");
            if (returned) {
                const association = row?.serviceAssociation?.layer === "reported-api" ? row.serviceAssociation : null;
                for (const [index, name] of (association?.services ?? []).entries()) {
                    if (index) service.append(document.createTextNode(", "));
                    service.append(serviceCue("span", name));
                }
                for (const gap of association?.gaps ?? []) {
                    service.append(metadata.item(gap.label, { help: gap.description }));
                    if (includePurpose) service.append(el("p", "context-help-note", gap.description));
                }
                if (!service.childNodes.length) service.textContent = "Service association unavailable in this snapshot.";
            } else service.append(serviceCue("span", row?.workload));
            list.append(el("dt", "", returned ? "Service" : "Activity category"), service);
        }
        if (operation && includePurpose) {
            list.append(el("dt", "", "Purpose"), el("dd", "", operation.description));
            if (discovery) list.append(el("dt", "", "Data service"), el("dd", "", "Not applicable"));
        }
        const evidence = categories.serviceEvidence(row ? { ...row, tool: call?.tool || row.tool } : row, returned ? "reported-api" : "tool");
        if (evidence && includePurpose && !returned) {
            const value = el("dd");
            value.append(metadata.item(evidence.label, { help: evidence.description }));
            list.append(el("dt", "", "Data service"), value);
            list.append(el("dt", "", "Why this category"), el("dd", "", evidence.description));
        }
        if (returned) {
            const value = results.returnedPath(call, row, { discovery: categories.operation(call?.tool)?.category === "Discovery" });
            pathField(list, "API path", value.path, value.source === "unattributed" ? "Not attributed to a target in this batch" : "Not recorded");
            if (value.source === "call") {
                const note = el("dd", "path-attribution");
                note.textContent = "Call target; no separate path returned.";
                list.append(el("dt", "path-attribution", "Path source"), note);
            }
        } else if (evidence?.reason === "hosted-routing") {
            pathField(list, "Downstream API path", null, "Not recorded");
            list.append(el("dt", "", "HTTP method"), el("dd", "", "Not recorded"),
                el("dt", "", "API version"), el("dd", "", "Not recorded"));
        } else if (!discovery || operation.pathLabel) {
            const paths = results.callPaths(call);
            paths.forEach((path, index) => pathField(list, discovery ? operation.pathLabel : paths.length > 1 ? `API path ${index + 1}` : "API path", path));
        }
        return list;
    }
    function toolHeading(tool) {
        const heading = el("h3", "action-tool-heading");
        heading.append(el("span", "action-field-label", "Tool"), el("span", "", tool || "Not recorded"));
        return heading;
    }
    function returnedDetails(call, row, apiRows, selectedId) {
        if (!apiRows?.length) return null;
        const paths = results.callPaths(call);
        if (!selectedId && apiRows.length === 1 && paths.length === 1 && results.returnedPath(call, apiRows[0]).path === paths[0]) return null;
        const renderEntry = entry => {
            const item = viewKey(el("div", "api-result-entry"), "returned:" + entry.id);
            item.dataset.resultId = entry.id;
            item.append(resultLine("reported-api", results.summarize([entry]), { heading: "Returned API result" }),
                actionFields(call, entry, { includeTool: false, returned: true }));
            if (entry.id === selectedId) {
                item.id = "selectedCall";
                item.tabIndex = -1;
                item.setAttribute("aria-current", "true");
                item.prepend(el("h4", "context-selected-label", "Selected returned API result"));
                actionContext(item, [entry]);
            }
            return item;
        };
        const list = el("div", "returned-api-entries");
        const otherRows = selectedId ? apiRows.filter(entry => entry.id !== selectedId) : apiRows;
        pagedList(list, otherRows, {
            key: "returned:" + row.id, noun: "returned results",
            renderItem: renderEntry,
        });
        if (selectedId) {
            const section = el("section", "selected-api-result");
            section.append(renderEntry(apiRows.find(entry => entry.id === selectedId)),
                el("p", "context-help-note", "This returned entry belongs to the recorded tool call above. Its status is not a separate observed HTTP execution."));
            if (otherRows.length) section.append(disclosure("Other returned API results", list, "returned-api-details"));
            return section;
        }
        return disclosure("Returned API details", list, "returned-api-details");
    }
    function actionContext(item, rows) {
        const matching = rows?.filter(row => rowsFor(route.request).some(match => match.id === row.id)).length;
        item.append(el("p", "action-context", !rows ? "Matching context unavailable" : matching ? `${matching} matching ${results.unit(applied.layer, matching)} in current view` : "Outside current view"));
        if (rows?.some(row => analytics.serviceInvolvement?.selection.contextOnlyIds.includes(row.id))) {
            item.append(el("p", "service-context-label", "Includes missing-service context, not a known match to the selected service."));
        }
    }
    function query() {
        return { layer: route.layer || "tool", groupBy: route.chart === "endpoint" ? "endpoint" : "workload", bucket: route.bucket || "week", filters: filterState.query(route), limit: 8, timeContext: viewerTime };
    }
    function validateAnalytics(data, records) {
        if (!data || !Array.isArray(data.groups) || !Array.isArray(data.rows) || !data.coverage || !results.valid(data.totals)) throw new Error("Activity summaries are unavailable. No replacement counts were inferred.");
        const facet = data.resultFacet;
        if (facet?.scope !== "before-outcome" || !results.valid(facet.totals) || facet.totals.count < data.totals.count
            || resultKeys.some(key => facet.totals[key] < data.totals[key])) throw new Error("Available result counts do not match this snapshot.");
        const outcomes = query().filters.outcomes;
        const expected = outcomes?.length ? outcomes.reduce((sum, key) => sum + facet.totals[key], 0) : facet.totals.count;
        if (expected !== data.totals.count || outcomes?.length && data.rows.some(row => !outcomes.includes(row.outcome))) throw new Error("The result filter does not match the available counts.");
        const promptAuthors = query().filters.promptAuthors;
        if (promptAuthors) {
            const byId = new Map(records.map(record => [record.scenarioId, record]));
            if (data.rows.some(row => !promptAuthors.includes(row.promptAuthor)
                || row.promptAuthor !== authorship.read(byId.get(row.scenarioId)?.userPrompt).actor)) {
                throw new Error("The prompt author filter does not match the retained interaction authors.");
            }
        }
        const rows = results.summarize(data.rows);
        if (!rows || ["count", ...resultKeys].some(key => rows[key] !== data.totals[key])) throw new Error("Recorded action totals do not match this snapshot.");
        const beforeOutcome = results.summarize(facet.rows);
        const beforeOutcomeIds = new Set(Array.isArray(facet.rows) ? facet.rows.map(row => row.id) : []);
        if (!beforeOutcome || ["count", ...resultKeys].some(key => beforeOutcome[key] !== facet.totals[key])
            || data.rows.some(row => !beforeOutcomeIds.has(row.id))) {
            throw new Error("Available result membership does not match this snapshot.");
        }
        if (data.layer === "reported-api" && !Array.isArray(data.apiCoverage?.calls)) {
            throw new Error("API-result parent coverage is unavailable for this snapshot.");
        }
        if (query().filters.services?.length) {
            const involvement = data.serviceInvolvement, selection = involvement?.selection;
            const ids = Array.isArray(selection?.knownMatchIds) && Array.isArray(selection?.contextOnlyIds) && [...selection.knownMatchIds, ...selection.contextOnlyIds];
            if (involvement?.definition?.version !== 1 || involvement.denominator !== data.rows.length || !ids
                || new Set(ids).size !== ids.length || ids.length !== data.rows.length || data.rows.some(row => !ids.includes(row.id))
                || JSON.stringify(selection.services) !== JSON.stringify(query().filters.services)
                || selection.includeMissingService !== (query().filters.includeMissingService === true)
                || !selection.includeMissingService && selection.contextOnlyIds.length) {
                throw new Error("The service focus does not match its declared rows. No broader scope was substituted.");
            }
        }
        for (const group of data.groups) if (!Number.isFinite(group.total) || resultKeys.some((key) => !Number.isFinite(group[key]) || group[key] < 0)) throw new Error("Recorded group counts are incomplete.");
        if (data.timeSeries && (!Array.isArray(data.timeSeries.points) || data.timeSeries.points.some((point) => !Number.isFinite(point.total)))) throw new Error("Recorded time-series data is incomplete.");
        percentages.validate(data);
        return data;
    }
    async function load({ background = false, afterExport = false, refinement = false, expectedSource } = {}) {
        if (exportWriting && !afterExport) {
            announce("The confirmed local save is still running. This view will refresh when it finishes; the write is not replayed.");
            return false;
        }
        const request = ++generation;
        if (!background || fresh.snapshot().phase === "waiting") fresh.retryApply();
        syncTime();
        const config = query();
        isLoading = true;
        isStale = Boolean(analytics);
        $("deleteAllReports").disabled = true;
        syncResultFilter();
        syncAuthorFilter();
        renderTimeContext();
        if (!background) {
            if (!analytics) setText($("periodResult"), "Updating this period...");
            $("periodResult").setAttribute("aria-busy", "true");
            $("pageAction").setAttribute("aria-disabled", "true");
        }
        ux.pending($("loadingStatus"), true);
        ux.pending($("periodResult"), true);
        ux.pending($("refreshBtn"), true);
        updateSelection();
        renderTimeContext();
        $("refreshBtn").disabled = true;
        renderFreshActivity();
        $("workspace").setAttribute("aria-busy", "true");
        if (analytics && !background && !refinement) announce("Updating this view...");
        try {
            const next = await api("/api/snapshot", config);
            if (request !== generation) return false;
            const result = next.analytics;
            if (timeChanged()) return load({ background, afterExport, refinement, expectedSource });
            if (!Array.isArray(next.scenarios)) throw new Error("Recorded requests are unavailable.");
            if (result?.revision !== undefined && result.revision !== next.revision) throw new Error("Activity changed during the read. Try again.");
            if (result?.timeContext && JSON.stringify(result.timeContext) !== JSON.stringify(config.timeContext)) throw new Error("The runtime used a different timezone. Retry the stored-data read before continuing.");
            const validated = validateAnalytics(result, next.scenarios);
            if (route.withinServices) analysisSlice(next, config, search, route.withinServices.split(","));
            const checking = fresh.snapshot();
            if (expectedSource !== undefined && next.collection?.configVersion !== expectedSource) throw new Error("The approved source changed during the stored read. Retry current status and stored activity; no source check was repeated.");
            if (checking.phase === "applying" && checking.check && next.revision < checking.check.revision) throw new Error("The view read is older than the completed local check. Retry the stored read; no collection was repeated.");
            if (checking.phase === "applying" && checking.check && next.collection?.configVersion !== checking.check.configVersion) throw new Error("The approved source changed during this check. Review the current connection before checking again.");
            if (state && next.revision < state.revision) throw new Error("An older snapshot was rejected. The current view is kept.");
            if (next.sessionAnalysis && (next.sessionAnalysis.revision !== next.revision || !results.valid(next.sessionAnalysis.totals))) throw new Error("Source analysis does not match this snapshot. Retry the stored-data read before continuing.");
            const reading = captureReading();
            if (state && (next.deletionVersion ?? 0) !== (state.deletionVersion ?? 0)) clearDeletedDraft();
            assessmentUI.receive(next.assessment);
            automaticUI.observe();
            if (state && JSON.stringify((state.exports || []).map(item => [item.bundleId, item.manifestHash])) !== JSON.stringify((next.exports || []).map(item => [item.bundleId, item.manifestHash]))) savedArtifactUI?.invalidate();
            state = next;
            reportComparisonUI?.syncPresence(next.exports || []);
            reportJourney?.syncPresence(next.exports || []);
            if (savedReportView && !(next.exports || []).some(entry => entry.bundleId === savedReportView.bundleId && entry.manifestHash === savedReportView.manifestHash)) {
                savedReportView.body.replaceChildren(el("p", "error", "This saved report changed or is no longer available. Close this reader and refresh saved reports."));
                savedReportView.invalid = true;
            }
            analytics = validated;
            applied = config;
            appliedRoute = { ...route };
            connectionNeedsSnapshot = false;
            isStale = false;
            isLoading = false;
            syncResultFilter();
            syncAuthorFilter();
            $("loading").hidden = true;
            $("workspace").hidden = false;
            clearMessage();
            if (next.collection) renderCollection(next.collection);
            else collectionUnavailable("Collection status unavailable from this connection. Reconnect to the maintained runtime.");
            render();
            fresh.applied(state.revision, next.collection?.configVersion, analytics.rows);
            renderFreshActivity();
            restoreReading(reading);
            if (!mounted) revealSessionResult();
            $("newDataNotice").hidden = true;
            mounted = true;
            if (next.collection) { clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 5000); }
            return true;
        } catch (error) {
            if (request !== generation) return false;
            assessmentUI.clearPrivateText();
            isStale = Boolean(analytics);
            isLoading = false;
            if (error.reason === "runtime_unavailable") collectionUnavailable(error.message, error.reason);
            if (fresh.snapshot().phase === "applying") fresh.fail(fresh.snapshot().token, error.message);
            renderFreshActivity();
            $("loading").hidden = true;
            const offline = error.reason === "runtime_unavailable";
            announce(offline
                ? (analytics ? "Local runtime unavailable. Showing the last recorded snapshot. " : "Your activity could not load. ")
                    + "Start WIRE if it is stopped, then retry."
                : (analytics ? "This view could not update. The last recorded snapshot is shown. " : "Your activity could not load. ") + error.message,
            analytics ? "stale" : "error", true);
            if (offline) $("message").dataset.connectionFailure = "true";
            renderCollectionNotice();
            if (analytics) {
                const reading = captureReading();
                route = { ...appliedRoute, search };
                appliedRoute = { ...route };
                rememberRoute(route, true);
                render();
                restoreReading(reading);
            }
            return false;
        } finally {
            if (request === generation) {
                isLoading = false;
                $("refreshBtn").disabled = false;
                $("workspace").setAttribute("aria-busy", "false");
                $("periodResult").removeAttribute("aria-busy");
                $("pageAction").removeAttribute("aria-disabled");
                $("applyDates").removeAttribute("aria-disabled");
                ux.pending($("loadingStatus"), false);
                ux.pending($("periodResult"), false);
                ux.pending($("refreshBtn"), false);
                updateSelection();
                renderFreshActivity();
            }
        }
    }
    function applyRoute(next, { keepFocus = false, restorePosition = false, reset = false, paging = null } = {}) {
        if (exportWriting || collectionSettings?.isBusy()) {
            rememberRoute(route, true);
            announce("Wait for the current local save to finish before leaving this view.");
            return false;
        }
        const navigation = ++navigationGeneration;
        const intent = readingIntent;
        const previousRoute = route, clearingFilter = $("filterChips").contains(document.activeElement);
        const focusId = keepFocus ? document.activeElement?.id : null;
        savedArtifactUI?.leave();
        if (appliedRoute) readingPositions.set(readingKey(appliedRoute), captureReading());
        ux.hideTooltip();
        selectControls?.close();
        if ($("overlay").open) $("overlay").close();
        const before = JSON.stringify(query());
        if (["range", "from", "to"].some(key => route[key] !== next[key])) dateDraft = null;
        route = canonicalRoute(next);
        rememberRoute(route, true);
        search = route.search || "";
        activityPage = Math.max(0, Number.parseInt(route.page || "0", 10) || 0);
        syncControls();
        $("resetView").hidden = !viewChanged();
        const queryChanged = before !== JSON.stringify(query());
        // Navigation is not report consent. Reconcile the exact report basis after a verified read.
        if (reportJourney?.snapshot().phase === "scanning" || $("reportReviewBody")?.querySelector('[data-review-control][data-pending=true]')) invalidatePreview();
        const refinement = !reset && !restorePosition && Boolean(analytics)
            && route.view === "analyze" && route.view === previousRoute.view
            && route.session === previousRoute.session && route.request === previousRoute.request
            && (queryChanged || route.range !== previousRoute.range || route.chart !== previousRoute.chart || route.withinServices !== previousRoute.withinServices);
        const controlsOnly = refinement && !queryChanged && route.chart === previousRoute.chart && route.withinServices === previousRoute.withinServices;
        if (refinement && clearingFilter) {
            const controls = { tool: "toolFilter", services: "serviceAssociationFilter", includeMissingService: "serviceAssociationFilter", withinServices: "serviceAssociationFilter", service: "serviceFilter",
                project: "projectFilter", session: "chatFilter", layer: "layerFilter", scope: "scopeFilter", bucket: "bucketFilter", result: "outcomeFilter", authors: "promptAuthorFilter", from: "dateFilter", to: "dateFilter" };
            const changed = Object.keys(controls).find(key => route[key] !== previousRoute[key]);
            const trigger = changed ? $(controls[changed] + "-control") : null;
            const target = trigger?.checkVisibility() ? trigger : trigger?.closest("#moreFilters") ? $("moreFiltersToggle") : $("dateFilter-control");
            ux.restoreFocus(target);
            target?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        if (!controlsOnly) { assessmentUI.leave(); automaticUI.leave(); }
        let update = true;
        if (!analytics || queryChanged) update = load({ refinement });
        else {
            appliedRoute = { ...route };
            if (controlsOnly) { renderNavigation(); renderFilterChips(); updateSelection(); }
            else render();
        }
        const position = readingPositions.get(readingKey(route));
        const finishNavigation = (loaded = true) => {
            if (!loaded || navigation !== navigationGeneration || refinement || intent !== readingIntent) return;
            if (paging) { restorePager(paging); return; }
            if (route.view === "settings") {
                revealSetting();
                if (restorePosition && position && !route.setting) restoreReading(position);
            }
            else if (route.view === "collection-status") {
                revealCollectionStatus();
                if (restorePosition && position && !route.setting) restoreReading(position);
            }
            else if (keepFocus) ux.restoreFocus($(focusId));
            else if (position) restoreReading(position);
            else if (route.view === "analyze" && previousRoute.view === "analyze" && route.mode !== previousRoute.mode) revealResults();
            else if (mounted && !revealSessionResult()) { $("pageTitle").focus({ preventScroll: true }); window.scrollTo(0, 0); }
        };
        if (update instanceof Promise) update.then(finishNavigation);
        else finishNavigation();
        mounted = true;
        return update;
    }
    function syncControls() {
        restoring = true;
        const values = {
            layerFilter: route.layer || "tool", dateFilter: route.range || "capture",
            toolFilter: route.tool || "all", serviceAssociationFilter: route.services || "all", chatFilter: route.session || "all",
            serviceFilter: route.service || "all",
            projectFilter: route.project || "all", scopeFilter: route.scope || "history",
            bucketFilter: route.bucket || "week",
            fromFilter: dateDraft?.from ?? dateInput(route.from), toFilter: dateDraft?.to ?? dateInput(route.to),
        };
        for (const [id, value] of Object.entries(values)) {
            const control = $(id);
            if (control.tagName === "SELECT" && ![...control.options].some((item) => item.value === value)) control.append(option(value, value));
            control.value = value;
        }
        $("dateFields").hidden = $("dateFilter").value !== "custom";
        setText($("dateHint"), `Both dates included in ${time.displayLabel(viewerTime)}. For one day, use the same date twice. Filters retained evidence only.`);
        $("activitySearch").value = search;
        restoring = false;
        syncResultFilter();
        syncAuthorFilter();
        selectControls?.sync();
    }
    function syncResultFilter() {
        if (!applied) return;
        const accepted = resultSelection(applied.filters.outcomes), requested = resultSelection(route.result);
        for (const option of $("outcomeFilter").options) option.selected = !accepted.length || accepted.includes(option.value);
        if (isLoading) $("outcomeFilter").dataset.pendingValue = JSON.stringify([...$("outcomeFilter").options]
            .filter(option => !requested.length || requested.includes(option.value)).map(option => option.value));
        else delete $("outcomeFilter").dataset.pendingValue;
        $("clearResultFilter").hidden = !accepted.length && (!isLoading || !requested.length);
        const scope = "Analyze";
        const text = applied.layer === "code-reference"
            ? "Result filtering is unavailable: execution is not observed." + (accepted.length ? " Clear the previous result filter to include references." : "")
            : `${scope}: ${resultNames(accepted)}${accepted.length ? " only" : ""}. Option counts are before result filtering.`;
        setText($("resultFilterScope"), text + (isLoading ? " Updating view..." : ""));
        $("resultSummary").dataset.unavailable = String(applied.layer === "code-reference");
        ux.pending($("resultFilterScope"), isLoading);
        $("resultSummary").setAttribute("aria-busy", String(isLoading));
    }
    function syncAuthorFilter() {
        if (!applied) return;
        const control = $("promptAuthorFilter"), accepted = authorship.selection(applied.filters.promptAuthors);
        const requested = authorship.selection(route.authors);
        for (const option of control.options) option.selected = accepted.includes(option.value);
        if (isLoading) control.dataset.pendingValue = JSON.stringify(requested);
        else delete control.dataset.pendingValue;
        $("clearPromptAuthorFilter").hidden = !authorship.filterValue(accepted) && (!isLoading || !authorship.filterValue(requested));
        $("promptAuthorSummary").setAttribute("aria-busy", String(isLoading));
        $("promptAuthorSummary").dataset.revision = String(state?.revision ?? "");
        setText($("promptAuthorFilterHelp"), `${authorship.selectionLabel(accepted)}. Calls stay with their originating prompt.${isLoading ? " Updating view..." : ""}`);
    }
    function viewChanged() {
        const defaults = { view: "analyze", chart: "time", bucket: "week", range: "capture", layer: "tool", scope: "history", page: "0" };
        return Object.entries(route).some(([key, value]) => !["localSearch", "settingsWarning"].includes(key) && value !== undefined && value !== null && value !== "" && !(value === "all" && ["project", "service", "result"].includes(key)) && String(value) !== defaults[key]);
    }
    async function resetView() {
        const next = { view: "analyze" };
        await navigate(next, false, { reset: true });
    }
    function renderStoredRefresh() {
        const report = reportJourney?.snapshot();
        const reviewing = report?.hasPreview || report?.phase === "scanning";
        const editing = collectionSettings?.hasDraft() || collectionSettings?.isBusy();
        const blocked = isLoading || collectionBusy || exportWriting || reviewing || editing || ["checking", "applying"].includes(fresh.snapshot().phase);
        for (const control of [$("refreshBtn"), $("collectionRetry"), ...document.querySelectorAll("[data-stored-refresh-retry]")]) control.disabled = blocked;
        $("checkActivity").disabled = blocked || fresh.busy() || collectionSettings?.canRefresh() === false;
        ux.explainDisabled($("checkActivity"), editing ? "Save or cancel your Settings edits before refreshing."
            : reviewing ? "Finish this report, or change its choices in Setup, before refreshing."
            : collectionSettings?.canRefresh() === false ? collectionSettings.explain("collectNow")
            : "Wait for the current activity update to finish.", { compact: true });
        const phase = fresh.snapshot().phase;
        $("storedRefresh").hidden = !["error", "unconfirmed"].includes(phase) && !fresh.snapshot().sourceBlocked && !collectionReadError && !(isStale && !isLoading);
        setText($("storedRefreshHelp"), reviewing
            ? "Finish this report, or change its choices in Setup, before refreshing."
            : editing ? "Save or cancel your Settings edits before refreshing."
            : exportWriting ? "The saved report will be shown when its current write finishes."
            : "Retry reads stored activity and current status only. It never repeats a source check or save.");
    }
    async function refreshStoredData(event) {
        renderStoredRefresh();
        if ($("refreshBtn").disabled || ["checking", "applying"].includes(fresh.snapshot().phase)) return;
        const initiator = document.activeElement === event?.currentTarget ? event.currentTarget : null;
        const intent = readingIntent, navigation = navigationGeneration, context = route;
        fresh.retryApply();
        if (fresh.snapshot().phase !== "applying") fresh.begin({ checkSource: false });
        collectionReadGeneration++;
        const readGeneration = collectionReadGeneration;
        clearTimeout(pollTimer);
        $("workspace").setAttribute("aria-busy", "true");
        renderFreshActivity();
        let statusError, expectedSource;
        try {
            const status = await api("/api/collection/status", {});
            if (readGeneration !== collectionReadGeneration) return false;
            expectedSource = status.configVersion;
            fresh.retryApply({ configVersion: status.configVersion });
            renderCollection(status);
        } catch (error) { statusError = error; }
        if (readGeneration !== collectionReadGeneration) return false;
        if ($("overlay").open || reportJourney?.isReviewOpen() || collectionSettings?.hasDraft()) {
            fresh.defer();
            $("workspace").setAttribute("aria-busy", "false");
            $("newDataNotice").hidden = false;
            renderFreshActivity();
            pollTimer = setTimeout(pollCollection, 5000);
            return false;
        }
        const pending = load({ background: true, expectedSource }), request = generation;
        const loaded = await pending;
        if (statusError && (!loaded || !state?.collection)) collectionUnavailable(statusError.message, statusError.reason);
        // An unrelated lastCheck cannot confirm or unlock a source request whose response was lost.
        renderFreshActivity();
        if (loaded && request === generation && navigation === navigationGeneration && context === route
            && intent === readingIntent && initiator?.isConnected
            && (document.activeElement === document.body || document.activeElement === initiator)) {
            ux.restoreFocus(initiator.checkVisibility() && !initiator.disabled ? initiator : $("checkActivity"));
        }
        return loaded;
    }
    function renderNavigation() {
        const active = route.view === "request" ? "analyze" : route.view === "collection-status" ? "settings" : route.view;
        document.querySelectorAll("[data-nav]").forEach((node) => {
            const view = node.dataset.nav;
            node.href = routeUrl(routeFor(view, { request: undefined, task: undefined }));
            if (view === active && node.closest("nav")) node.setAttribute("aria-current", "page");
            else node.removeAttribute("aria-current");
        });
        const settings = route.view === "settings", operational = route.view === "collection-status", configurationOrStatus = settings || operational;
        for (const [view, ids] of Object.entries({ analyze: ["homeView", "activityView"], request: ["requestView"], reports: ["reportsView"], settings: ["settingsView"], "collection-status": ["collectionStatusView"] })) {
            for (const id of ids) $(id).hidden = route.view !== view;
        }
        $("resultsLink").hidden = route.view !== "analyze";
        $("filters").hidden = configurationOrStatus || route.view === "request" || route.view === "reports";
        $("projectContextHelp").hidden = configurationOrStatus || route.view === "reports";
        $("filterChips").hidden = configurationOrStatus || route.view === "reports";
        $("coverage").hidden = configurationOrStatus;
        $("coverageNotice").hidden = configurationOrStatus;
        $("activityCollectionLink").hidden = !["analyze", "request"].includes(route.view);
        $("settingsDraftNotice").hidden = settings || !collectionSettings?.hasDraft();
        renderSettingsNavigation();
        syncLocalSearchFields();
        renderCollectionNotice();
        renderFreshActivity();
        const titles = {
            analyze: ["Analyze", "Explore recorded interactions, calls and their results."],
            request: ["Request details", "Read the prompt and available response, then inspect the recorded evidence."],
            reports: route.task === "create" ? ["Create a report", "Set up scope and contents, review the actual copies, then save locally."]
                : ["Reports", "Find, open and manage your saved reports."],
            settings: ["Settings", "Manage connection, saved data, AI reviews and display preferences."],
            "collection-status": ["Collection status", "Check collection health and find gaps in local Copilot chat history."],
        };
        $("pageTitle").textContent = titles[route.view][0];
        $("pageTitle").tabIndex = -1;
        $("pageIntro").textContent = titles[route.view][1];
        $("pageIntro").hidden = !titles[route.view][1];
        const source = sessionSource();
        $("pageIdentity").hidden = true;
        $("pageIdentity").textContent = applied.layer === "http" ? "Recorder source" : chatCopy.nameLabel;
        $("sessionAnalysis").setAttribute("aria-label", applied.layer === "http" ? "Recorder source analysis" : "Copilot chat analysis");
        $("pageProject").replaceChildren();
        if (source && route.view === "analyze" && route.session) {
            $("pageProject").append(el("p", "context-source", (applied.layer === "http" ? "Recorder source: " : "Copilot chat: ") + source.name));
            if (source.projectId) $("pageProject").append(projectContext(source));
            const reference = sourceReference(source);
            if (reference) $("pageProject").append(el("span", "source-reference", reference));
            const hosts = [...new Set(state.scenarios.filter(item => item.sourceSessionId === source.sessionId).map(item => item.sourceHost).filter(Boolean))];
            $("pageProject").append(disclosure("Technical source record", facts([
                [applied.layer === "http" ? "Recorder source ID" : "Copilot chat ID", source.sessionId],
                ["Recorded name", source.name], ["Source host", hosts.length ? hosts.join(", ") : null],
                ["Project", source.projectId ? source.project || source.projectId : null], ["Project ID", source.projectId],
            ], { inlineHelp: false }), "source-header-details", "source:" + source.sessionId));
        }
        const actions = { analyze: ["Create report", "reports"], request: ["Review selection", "reports"], reports: ["Back to Analyze", "analyze"], settings: ["Back to Analyze", "analyze"], "collection-status": ["Back to Analyze", "analyze"] };
        const [label, target] = actions[route.view];
        $("pageAction").textContent = label;
        $("pageAction").href = routeUrl(routeFor(target, target === "reports" ? { task: "create" } : {}));
        const actionHost = route.view === "analyze" ? $("analyzeResultActions") : route.view === "reports" ? $("pageHeadingActions") : route.view === "request" ? $("activitySelectionContext") : $("pagePrimaryActions");
        if ($("pageAction").parentElement !== actionHost) {
            if (route.view === "reports") actionHost.prepend($("pageAction"));
            else actionHost.append($("pageAction"));
        }
        $("pageAction").hidden = configurationOrStatus || route.view === "request" && !reportSelection().requests.length;
        $("pageAction").classList.toggle("button-link", route.view !== "request");
        $("pageAction").classList.toggle("text-link", route.view === "request");
        sessionReportButton.hidden = route.view !== "analyze" || !route.session || applied.layer === "http";
        $("resetView").hidden = configurationOrStatus || route.view === "reports" || !viewChanged();
        const resetHost = route.view === "analyze" ? $("filterTools") : $("scopeResetActions");
        if ($("resetView").parentElement !== resetHost) resetHost.append($("resetView"));
        $("scopeResetActions").hidden = route.view !== "request";
        renderStoredRefresh();
        const requestAvailable = state.scenarios.some(scenario => scenario.scenarioId === route.request);
        const returnRoute = route.view === "analyze" && route.session ? sessionsRoute()
            : route.view === "request" ? routeFor(requestAvailable && route.origin === "reports" ? "reports" : "analyze", requestAvailable ? {} : { request: undefined }) : null;
        const returnLabel = returnRoute?.view === "collection-status" ? "Back to history gaps"
            : route.view === "analyze" ? "Back to Analyze"
            : route.origin === "reports" && requestAvailable ? "Back to report scope" : "Back to results";
        const returnKey = JSON.stringify([returnRoute, returnLabel]);
        if (returnKey !== contextReturnKey) {
            const back = returnRoute ? route.view === "analyze" ? routeLink(returnLabel, returnRoute, "button-link")
                : link(returnLabel, returnRoute.view, requestAvailable ? {} : { request: undefined }, "button-link") : null;
            if (back) back.id = "contextBack";
            $("contextReturn").replaceChildren(...(back ? [back] : []));
            contextReturnKey = returnKey;
        }
        $("contextReturn").hidden = !returnRoute;
        const reports = route.view === "reports";
        const inactiveClear = reports ? $("activityClearSelection") : $("reportClearSelection");
        const inactiveHost = reports ? $("reportSelectionBar") : $("reportSelectionActions");
        if (inactiveClear.parentElement !== inactiveHost) inactiveHost.append(inactiveClear);
        const contextHost = reports ? $("reportPreviewContext") : $("reportSelectionBar");
        if ($("pageHeadingActions").parentElement !== contextHost) contextHost.append($("pageHeadingActions"));
        const activeClear = reports ? $("reportClearSelection") : $("activityClearSelection");
        if (activeClear.parentElement !== $("pageHeadingActions")) $("pageHeadingActions").append(activeClear);
        const selectionHost = route.view === "analyze" ? $("analyzeResultActions") : document.querySelector(".page-heading");
        if ($("reportSelectionBar").parentElement !== selectionHost) {
            if (route.view === "analyze") selectionHost.prepend($("reportSelectionBar"));
            else selectionHost.append($("reportSelectionBar"));
        }
        const crumbs = $("breadcrumbs");
        crumbs.replaceChildren();
        if (route.view !== "analyze") {
            crumbs.append(link("Analyze", "analyze", { request: undefined }));
            crumbs.append(el("span", "", "/"), el("span", "", settings ? "Settings" : operational ? "Collection status" : route.view === "request" ? "Interaction" : "Reports"));
        }
        crumbs.hidden = !crumbs.childElementCount;
        $("exploreLink").href = routeUrl(routeFor("activity"));
        $("backToSelection").href = routeUrl(routeFor("activity"));
        renderReportTask();
    }
    function renderReportTask() {
        if (!$("reportCreatePanel")) return;
        const creating = route.task === "create";
        $("reportCreatePanel").hidden = !creating;
        $("savedReportsPanel").hidden = creating;
        const current = reportJourney?.snapshot();
        const unfinished = current && !["saved", "unavailable"].includes(current.phase)
            && (current.requestCount > 0 || current.step > 1 || current.promptMode !== "masked"
                || current.formats.join(",") !== "html" || $("manualTerms").value.trim());
        setText($("reportCreateLink"), current?.completed ? "Saved report details" : unfinished ? "Continue draft" : "Create a report");
        for (const [id, active, task] of [["reportLibraryLink", !creating, undefined], ["reportCreateLink", creating, "create"]]) {
            const control = $(id);
            control.href = routeUrl(routeFor("reports", { task, request: task ? route.request : undefined }));
            if (active) control.setAttribute("aria-current", "page");
            else control.removeAttribute("aria-current");
        }
    }
    function renderViewingContext() {
        const host = $("viewingContext");
        const collectionLink = $("activityCollectionLink");
        if (host.contains(collectionLink)) $("collectionNotice").after(collectionLink);
        host.hidden = route.view !== "request";
        const rows = selectionRows();
        const evidenceHost = $("serviceEvidenceSummary");
        const evidenceGroups = categories.evidenceGroups(rows, applied.layer);
        evidenceHost.hidden = route.view !== "analyze" || route.service !== "Unknown" || !evidenceGroups.length;
        evidenceHost.replaceChildren();
        if (!evidenceHost.hidden) {
            const heading = el("h2", "", "Why the service is not shown");
            heading.id = "serviceEvidenceTitle";
            const total = evidenceGroups.reduce((sum, group) => sum + group.count, 0);
            const description = el("p", "", `${count(total)} of ${count(rows.length)} ${results.unit(applied.layer, rows.length)} in this view. Recorded outcomes are shown separately.`);
            const groups = el("dl");
            for (const group of evidenceGroups) {
                const item = el("div"), term = el("dt");
                item.dataset.evidenceCount = group.count;
                term.append(document.createTextNode(`${count(group.count)} ${results.unit(applied.layer, group.count)}: `));
                if (group.purpose) term.append(document.createTextNode(group.purpose + " "), el("span", "muted", `(${group.tool})`));
                else term.append(document.createTextNode(group.tool));
                item.append(term, el("dd", "", `${group.evidence.label}. ${group.evidence.description}`));
                groups.append(item);
            }
            evidenceHost.append(heading, description, groups);
        }
        const label = route.view === "request" ? "Viewing full request from" : route.view === "reports" ? "Current activity view" : "Viewing";
        const project = route.project ? $("projectFilter").selectedOptions[0]?.textContent || "Project unavailable" : "All projects";
        const dates = route.from || route.to ? `${date(route.from)} to ${date(route.to)}` : "All retained dates";
        host.replaceChildren(metadata.row([
            { label },
            { label: `${count(rows.length)} ${results.unit(applied.layer, rows.length)}` },
            { label: resultNames(resultSelection(route.result)) },
            { label: authorship.selectionLabel(applied.filters.promptAuthors) },
            ...(route.tool ? [{ label: route.tool }] : []),
            ...(route.services ? [{ label: $("serviceFocusScope").textContent }] : []),
            { label: route.service ? serviceLabel(route.service) : allCategories() },
            { label: project },
            { label: dates },
            { label: scopeLabels[applied.filters.scope] || "Collection unavailable" },
            ...(search ? [{ label: "Private search applied" }] : []),
        ]));
        if (route.session && route.view !== "request") {
            const session = state.scenarios.find(s => s.sourceSessionId === route.session);
            host.append(el("p", "context-source", (applied.layer === "http" ? "Recorder source: " : "Copilot chat: ") + (session?.sourceSessionName || chatCopy.unnamed)));
        }
        if (route.endpoint) {
            const endpoint = analytics.filterOptions?.endpoints?.find(item => item.id === route.endpoint);
            const context = el("p", "context-source", "API path: ");
            context.append(endpoint?.label ? el("code", "api-path", endpoint.label) : document.createTextNode("Selected path"));
            host.append(context);
        }
        const unlinked = rows.filter(row => !state.scenarios.some(scenario => scenario.scenarioId === row.scenarioId)).length;
        if (unlinked) host.append(el("p", "context-source", `${count(unlinked)} records have no retained request details; they remain in the view total.`));
        if (["request", "reports"].includes(route.view) && route.request) {
            const scenario = state.scenarios.find(s => s.scenarioId === route.request);
            const back = el("div", "context-return");
            if (route.view === "reports" && scenario) back.append(link("From request: " + excerpt(scenario), "request", { request: scenario.scenarioId }, "request-link"));
            host.append(back);
        }
        if (route.view === "request") {
            const contents = el("div");
            contents.append(...host.childNodes);
            contents.append(collectionLink);
            const detail = el("details", "request-view-context");
            detail.append(el("summary", "", "Originating view and filters"), contents);
            bindDetails(detail, "request-view-context");
            host.replaceChildren(detail);
        }
    }
    function renderFilterChips() {
        const host = $("filterChips");
        host.replaceChildren();
        if (search) {
            const chip = button("Private search applied", () => go(route.view === "request" ? "activity" : route.view, { search: undefined, page: undefined }), "filter-chip");
            chip.setAttribute("aria-label", "Remove private search");
            chip.append(ux.icon("close"));
            host.append(chip);
        }
        for (const service of route.withinServices?.split(",") || []) {
            const chip = button(`${service} within current scope`, () => go(route.view === "request" ? "activity" : route.view, {
                withinServices: route.withinServices.split(",").filter(value => value !== service).join(",") || undefined,
                request: undefined, page: undefined,
            }), "filter-chip");
            chip.setAttribute("aria-label", `Remove service chart refinement: ${service}`);
            chip.append(ux.icon("close"));
            host.append(chip);
        }
        const labels = { tool: "Tool", services: "Service", service: "Category", result: "Outcome", authors: "Author", project: "Copilot project",
            endpoint: "API path", session: "Copilot chat", layer: "Activity", scope: "Collection", bucket: "Time scale" };
        const selectedLabel = id => $(id).selectedOptions[0]?.textContent;
        for (const [key, label] of Object.entries(labels)) {
            const selectedValue = key === "authors" && applied ? authorship.filterValue(applied.filters.promptAuthors) : route[key];
            if (!selectedValue || key === "scope" && selectedValue === "history" || key === "layer" && selectedValue === "tool" || key === "bucket" && selectedValue === "week") continue;
            const value = key === "authors" ? authorship.selectionLabel(selectedValue) : key === "result" ? resultNames(resultSelection(selectedValue))
                : key === "scope" ? scopeLabels[selectedValue] : key === "project" ? selectedLabel("projectFilter")
                    : key === "session" ? selectedLabel("chatFilter") : key === "layer" ? selectedLabel("layerFilter")
                        : key === "bucket" ? selectedLabel("bucketFilter") : key === "endpoint" ? "Selected path"
                            : key === "tool" ? selectedValue : key === "services" ? selectedValue.split(",").map(serviceLabel).join(", ") : serviceLabel(selectedValue);
            const chip = button(`${label}: ${value}`, () => go(route.view === "request" ? "activity" : route.view, { [key]: undefined, request: undefined, page: undefined }), "filter-chip");
            chip.setAttribute("aria-label", `Remove ${label.toLowerCase()} filter: ${value}`);
            chip.append(ux.icon("close"));
            ux.tooltip(chip, chip.getAttribute("aria-label"));
            host.append(chip);
        }
        if (route.from || route.to) {
            const label = `${date(route.from)} - ${date(route.to)}`;
            const chip = button(label, () => go(route.view === "request" ? "activity" : route.view, { from: undefined, to: undefined, range: undefined, request: undefined, page: undefined }), "filter-chip");
            chip.setAttribute("aria-label", "Remove date filter: " + label);
            chip.append(ux.icon("close"));
            host.append(ux.tooltip(chip, chip.getAttribute("aria-label")));
        }
        const activeMore = ["service", "project", "session", "layer", "scope"].filter(key => route[key] && route[key] !== ({ layer: "tool", scope: "history" })[key]).length;
        setText($("moreFilters").querySelector("summary"), `More filters${activeMore ? ` (${activeMore} active)` : ""}`);
        const focus = analytics.serviceInvolvement?.selection;
        const focused = Boolean(applied.filters.services?.length);
        $("serviceFocus").hidden = !focused || !["analyze", "request"].includes(route.view);
        const name = (applied.filters.services || []).map(serviceLabel).join(", ");
        const noun = applied.layer === "tool" ? "calls" : results.unit(applied.layer, 2);
        setText($("serviceFocusScope"), focused ? `${name}${focus.includeMissingService ? ` + ${noun} with missing service details` : " only"}. ${count(focus.knownMatchIds.length)} known matches${focus.includeMissingService ? `; ${count(focus.contextOnlyIds.length)} context-only` : ""}.${isStale ? " Previous results; refresh before using this scope." : ""}` : "");
        $("addServiceContext").hidden = !focused || focus.includeMissingService;
        $("addServiceContext").disabled = isStale || isLoading;
        setText($("addServiceContext"), `Include ${noun} with missing service details`);
        if (focused && focus.includeMissingService) {
            const chip = button(`${noun[0].toUpperCase() + noun.slice(1)} with missing service details (context)`,
                () => go(route.view === "request" ? "activity" : route.view, { includeMissingService: false, request: undefined, page: undefined }), "filter-chip");
            chip.setAttribute("aria-label", "Remove missing-service context");
            chip.append(ux.icon("close"));
            host.append(chip);
        }
    }
    function renderPeriodFeedback() {
        $("periodFeedback").hidden = route.view !== "analyze";
        if ($("periodFeedback").hidden) return;
        const rows = selectionRows();
        const model = periodFlow({ rows, filters: applied.filters, coverage: state.collection?.config?.approved ? state.collection.checkedWindow : state.coverage, timeContext: applied.timeContext, session: Boolean(route.session), stale: isStale, layer: applied.layer, unit: results.unit(applied.layer, rows.length) });
        $("periodFeedback").classList.add("home-period-summary");
        setText(homeCount, count(rows.length));
        setText(homeUnit, results.unit(applied.layer, rows.length));
        $("periodResult").replaceChildren(...(isStale ? ["Previous results: "] : []), homeCount, " ", homeUnit);
        $("periodResult").dataset.revision = String(state.revision);
        setText($("periodHint"), isStale ? "The update failed. The last applied period is still shown; retry before using these results."
            : !state.scenarios.length && !collection?.config ? "No activity has been collected."
                : model.requests ? `${count(model.requests)} ${applied.layer === "http" ? "record group" : "interaction"}${model.requests === 1 ? "" : "s"} · ${applied.filters.from || applied.filters.to ? `${applied.filters.from ? date(applied.filters.from, true) : "Beginning"} - ${applied.filters.to ? date(applied.filters.to, true) : "Latest retained"}` : "All retained dates"} · ${applied.layer === "http" ? `${count(model.sessions)} recorder sources` : chatCopy.count(model.sessions)}`
                    : model.next);
        setText($("periodCoverageText"), model.warning);
        $("periodCoverage").hidden = !model.warning;
        $("periodHistoryLink").hidden = !model.historyLink;
    }
    function renderControls() {
        resultLabels = results.labels(applied.layer);
        const projects = new Map(state.scenarios.map((scenario) => [scenario.projectId || "unscoped", scenario.projectId ? scenario.project || scenario.projectId : "Copilot chat without a project"]));
        $("projectFilter").replaceChildren(option("all", "All projects"), ...[...projects].map(([id, name]) => option(id, name)));
        const workloads = analytics.filterOptions?.workloads || analytics.filterOptions?.services || [];
        $("serviceFilter").closest(".filter-field").querySelector(".ux-help").setAttribute("aria-label", "About " + categoryNoun());
        $("serviceFilter").replaceChildren(option("all", allCategories()), ...workloads.map((item) => option(typeof item === "string" ? item : item.id, serviceLabel(typeof item === "string" ? item : item.label))));
        $("toolFilter").replaceChildren(option("all", "All tools"), ...(analytics.filterOptions?.tools || []).map(tool => option(tool, tool)));
        const services = (analytics.filterOptions?.services || []).filter(value => !["Discovery", "Multiple workloads", "Unknown"].includes(value));
        $("serviceAssociationFilter").replaceChildren(option("all", "All services"), ...services.map(value => option(value, serviceLabel(value))));
        const chats = new Map((state.sessions || []).map(source => [source.sessionId, source.name || chatCopy.unnamed]));
        for (const scenario of state.scenarios) if (scenario.sourceSessionId && !chats.has(scenario.sourceSessionId)) chats.set(scenario.sourceSessionId, scenario.sourceSessionName || chatCopy.unnamed);
        $("chatFilter").replaceChildren(option("all", "All chats"), ...[...chats].map(([id, name]) => {
            const reference = sourceReference({ sessionId: id, name });
            return option(id, reference ? `${name} (${reference})` : name);
        }));
        document.querySelector('[data-chart="workload"]').textContent = applied.layer === "tool" ? "By category" : "By service";
        document.querySelector('[data-chart="endpoint"]').textContent = applied.layer === "tool" ? "By path or operation" : "By API path";
        const selectedResults = resultSelection(applied.filters.outcomes);
        const choices = applied.layer === "code-reference" ? [...new Set(["unknown", ...selectedResults])] : resultKeys;
        const totals = analytics.resultFacet.totals;
        const resultOptions = choices.map(key => [key, applied.layer === "code-reference" && key !== "unknown" ? `Previous: ${results.labels("tool")[key]}` : resultLabels[key], totals[key]]);
        $("outcomeFilter").dataset.allLabel = `All results (${count(totals.count)})`;
        const signature = JSON.stringify([applied.layer, resultOptions]);
        if ($("outcomeFilter").dataset.optionsSignature !== signature) {
            $("outcomeFilter").replaceChildren(...resultOptions.map(([key, label, total]) => option(key, `${label} (${count(total)})`)));
            $("outcomeFilter").dataset.optionsSignature = signature;
        }
        $("outcomeFilter").disabled = applied.layer === "code-reference";
        $("resultSummary").dataset.revision = String(state.revision);
        syncControls();
    }
    function visibleResultKeys() { return applied.layer === "code-reference" ? [] : resultKeys.filter((key) => ["success", "failure", "unknown"].includes(key) || analytics.resultFacet.totals[key] > 0 || applied.filters.outcomes?.includes(key)); }
    function groupSummary(group) { return visibleResultKeys().map((key) => `${count(group[key])} ${resultLabels[key].toLowerCase()} (${percentageMath.percent(group[key], group.total)})`).join(", ") + ". Shares of this column"; }
    function inspectColumnSection(node, group, key) {
        ux.tooltip(node, `${resultLabels[key]}: ${count(group[key])} of ${count(group.total)} ${results.unit(applied.layer, group.total)} (${percentageMath.percent(group[key], group.total)}).`,
            { placement: "right", immediatePointer: true });
    }
    function renderHome() {
        const layer = applied.layer;
        $("homeView").dataset.revision = String(state.revision);
        const chartType = route.chart || "time";
        $("periodLabel").textContent = applied.filters.from || applied.filters.to || analytics.coverage.firstAt
            ? `${date(applied.filters.from || analytics.coverage.firstAt)} - ${date(applied.filters.to || analytics.coverage.lastAt)}`
            : "No dated activity in this view";
        $("meaningMatched").textContent = `${count(analytics.totals.count)} ${results.unit(layer, analytics.totals.count)}`;
        $("meaningSources").textContent = layer === "http" ? `${count(analytics.coverage.sessionCount)} recorder sources` : chatCopy.count(analytics.coverage.sessionCount);
        $("takeaway").textContent = "";
        if (layer === "reported-api" && analytics.apiCoverage) $("takeaway").textContent = `${count(analytics.apiCoverage.callsWithNumericStatus)} of ${count(analytics.apiCoverage.eligibleToolCalls)} Work IQ tool calls retained an API status; ${count(analytics.apiCoverage.callsWithoutNumericStatus)} did not. Parent-call coverage is before API-result outcome/path filters; private search applies.`;
        if (layer === "direct-request") $("takeaway").textContent = "Request sites found in recorded commands. A request is not proof of a returned response.";
        if (layer === "code-reference") $("takeaway").textContent = "Code references only. They do not establish a request or response.";
        if (layer === "http") $("takeaway").textContent = "Recorder diagnostics, including public metadata tests. Not counted as workplace use.";
        $("takeaway").hidden = !$("takeaway").textContent;
        const meaning = $("meaningBody"), intro = el("p", "", layer === "tool"
            ? "Tool completion is not answer correctness."
            : layer === "code-reference" ? explanations[layer] : "Recorded statuses do not establish whole-task correctness.");
        intro.id = "meaningText";
        meaning.replaceChildren(intro);
        if (layer !== "code-reference") {
            const definitions = el("dl", "result-definitions");
            for (const key of resultKeys) {
                const item = el("div");
                const label = el("dt", `semantic-cue result-tone-${key}`);
                label.dataset.outcome = key;
                label.append(ux.icon(results.icon(key)), el("span", "", resultLabels[key]));
                item.append(label, el("dd", "", help.resultMeaning(key, layer)));
                definitions.append(item);
            }
            meaning.append(definitions);
        }
        document.querySelectorAll("[data-chart]").forEach((node) => node.setAttribute("aria-pressed", String(node.dataset.chart === chartType)));
        $("chartTitle").textContent = chartType === "time" ? "Activity over time (" + [...$("bucketFilter").options].find(option => option.value === applied.bucket).textContent + ")" : chartType === "workload" ? layer === "tool" ? "Activity categories" : "Services involved" : layer === "tool" ? "Paths and operations" : "API paths requested";
        $("bucketControl").hidden = chartType !== "time";
        const notes = $("chartReadingNotes");
        const reading = el("dl");
        for (const [label, text] of [
            ["Chart scale", chartType === "time"
                ? "Time columns and their recorded-result sections use a linear count scale from zero; small values are not enlarged. Count links and the exact-data table remain usable when a section is too small to see. Percentage charts also preserve actual shares."
                : "Bars use a linear count scale from zero. Counts, shares and result sections are not enlarged. Full labels and exact-data links remain usable even for tiny values."],
            ["Chart colors", chartType === "workload" ? `Color identifies the ${layer === "tool" ? "activity category" : "service"}, not its result.` : "Colors match the recorded results."],
            ["Dates and grouping", chartType === "time"
                ? `${help.fields.bucketFilter} Weeks start Monday; daylight-saving changes follow the display time zone in the header. Last 7/30 days include today and the preceding local days.`
                : chartType === "workload" && layer === "tool" ? help.charts.activityCategory : help.charts[chartType]],
            ["Evidence limits", `${explanations[layer]} Review labels and relevance assessments do not change recorded results.${layer === "tool" ? " Tool completion is not an observed Graph HTTP response." : ""}`],
        ]) reading.append(el("dt", "", label), el("dd", "", text));
        notes.replaceChildren(reading);
        bindDetails($("meaningReading"), "meaningReading");
        const previousChart = $("chart").querySelector(".dimensional-scroll");
        if (previousChart) dimensional.disposeView(previousChart);
        $("chart").replaceChildren();
        $("chartFooter").replaceChildren();
        if (!analytics.totals.count) {
            $("chart").append(!state.scenarios.length && !collection?.config
                ? empty("No collected activity yet", "Nothing is collected without your source approval.")
                : empty("No activity in this slice", layer === "recorded-http" ? "No HTTP status is visible for these requests. Try Direct Graph requests to inspect what was requested." : layer === "direct-request" ? "No qualifying recorded Graph request sites were found in these inspected records. Code references and recorder diagnostics are separate evidence." : layer === "http" ? "No recorder diagnostics match. These are separate from workplace activity." : "Try another date, service, or activity source, or use Reset Analyze beside the filters."));
        } else if (chartType === "time") renderTime();
        else renderComparison();
        const selectedResults = resultSelection(applied.filters.outcomes);
        if (!analytics.totals.count && selectedResults.length) {
            $("chart").replaceChildren(empty(layer === "code-reference" ? "No references match the previous result filter" : "No matching results in this view",
                "Use Clear beside Recorded result to show all results. Other filters stay applied."));
        }
        const definitions = categories.used((analytics.workloadGroups || []).map((group) => group.label)), glossary = el("dl", "service-glossary");
        for (const entry of definitions) {
            const item = el("div", "glossary-entry");
            item.append(serviceCue("dt", entry.id), el("dd", "", entry.id === "Unknown" ? categories.explainRows(analytics.rows, layer) || entry.description : entry.description));
            glossary.append(item);
        }
        $("serviceDefinitions").replaceChildren(el("summary", "", layer === "tool" ? "What these activity categories mean" : "What these service categories mean"), glossary);
        $("serviceDefinitions").hidden = !definitions.length;
        const chartRows = chartType === "time" ? analytics.timeSeries?.points?.length || 0 : analytics.groups.length;
        $("tableDisclosure").querySelector("summary").textContent = `Exact counts and recorded results (${count(chartRows)} ${chartRows === 1 ? "row" : "rows"})`;
        bindDetails($("tableDisclosure"), "tableDisclosure", open => {
            if (open) renderCountTable();
            else $("countTable").replaceChildren();
        }, true);
        percentages.update(analytics, { ...applied, search: Boolean(search), withinServices: route.withinServices?.split(",") || [] });
        renderAnalyzeTiming();
        if (analytics.totals.count && chartType !== "time") $("chartFooter").prepend(el("span", "chart-size-note", "Linear count scale. Exact counts and recorded results are available below."));
    }
    function renderAnalyzeTiming() {
        const host = $("recordedTiming");
        // Other activity layers do not identify a common start/completion boundary.
        host.hidden = applied.layer !== "tool";
        if (host.hidden) { host.replaceChildren(); return; }
        const row = timingPresentation.fromSummary(analytics.totals.duration, analytics.rows.length, "tool-start-to-completion");
        row.label = "Matching tool calls";
        const action = analytics.rows.length ? link("View matching calls", "activity", { mode: "calls", page: undefined }, "text-link") : null;
        if (action) viewKey(action, "timing:matching-calls");
        assessmentFactories.renderTiming(host, [row], { action });
        bindDetails(host.querySelector(".timing-exact"), "recordedTiming:" + sliceKey());
    }
    function renderTime() {
        const series = analytics.timeSeries;
        if (!series?.points?.length) {
            $("chart").append(empty("No dated activity is available", "The captured records do not include usable dates for this slice. Service and API-path views remain available."));
            if (series?.undatedCount) $("chartFooter").append(el("span", "", `${count(series.undatedCount)} undated records are not plotted.`));
            return;
        }
        const points = series.points;
        const guidance = el("span");
        const chart = dimensional.timeView({
            points, label: point => date(point.date),
            unit: total => results.columnUnit(applied.layer, total),
            summary: point => `${date(point.date, true)}${point.endDate && point.endDate !== point.date ? " - " + date(point.endDate, true) : ""}: ${count(point.total)} ${results.unit(applied.layer, point.total)}. ${groupSummary(point)}.`,
            createAction: point => link("", "activity", { range: "custom", from: point.from, to: point.to, page: undefined }),
            inspect: inspectColumnSection,
            onOverflow: overflowing => { guidance.textContent = overflowing ? "Scroll for more dates, or open the exact data below." : ""; },
        });
        chart.removeAttribute("aria-label");
        chart.setAttribute("aria-labelledby", "chartTitle");
        chart.setAttribute("aria-describedby", "chartReadingNotes");
        viewKey(chart, "chart:time");
        chart.querySelectorAll(".time-slot").forEach((slot, index) => viewKey(slot.firstElementChild, "chart:time:" + points[index].date));
        $("chart").append(chart);
        dimensional.refreshView(chart);
        $("chartFooter").append(el("span", "chart-size-note", `Linear count scale. ${series.gapMeaning}`), guidance);
        if (series.undatedCount) $("chartFooter").append(el("span", "", `${count(series.undatedCount)} undated records are not plotted.`));
    }
    function drillTime(point) {
        go("activity", { range: "custom", from: point.from, to: point.to, page: undefined });
    }
    function drillGroup(group) {
        if (group.id === "group:other") { go("home", { expanded: "true" }); return; }
        go("activity", route.chart === "endpoint" ? { endpoint: group.id, page: undefined } : { service: group.label, page: undefined });
    }
    function renderComparison() {
        const groups = route.expanded === "true" ? analytics.groups : [...(analytics.visibleGroups || analytics.groups), ...(analytics.otherGroup ? [analytics.otherGroup] : [])];
        const serviceMode = route.chart !== "endpoint";
        const label = group => serviceMode ? categories.describe(group.label, group.groupCount).label : group.label.replace(/ \(no endpoint reported\)$/, "");
        const guidance = el("span");
        const chart = dimensional.comparisonView({
            groups, serviceMode, label, icons: dimensionalIcons,
            unit: total => results.columnUnit(applied.layer, total),
            summary: group => `${label(group)}: ${count(group.total)} ${results.unit(applied.layer, group.total)}; ${groupSummary(group)}.${group.id === "group:other" ? " Show all categories." : ""}`,
            createAction: group => group.id === "group:other" ? link("", "home", { expanded: "true" })
                : link("", "activity", serviceMode ? { service: group.label, page: undefined } : { endpoint: group.id, page: undefined }),
            inspect: serviceMode ? undefined : inspectColumnSection,
            onOverflow: overflowing => { guidance.textContent = overflowing ? "Scroll for more categories." : ""; },
        });
        chart.setAttribute("aria-describedby", "chartReadingNotes");
        viewKey(chart, "chart:" + (serviceMode ? "service" : "endpoint"));
        chart.querySelectorAll(".flat-comparison-action").forEach(action => viewKey(action, "chart:group:" + action.dataset.groupId));
        $("chart").append(chart);
        dimensional.refreshView(chart);
        $("chartFooter").append(guidance);
        if (analytics.otherGroup && route.expanded !== "true") $("chartFooter").append(ux.tooltip(button("Show all", () => go("home", { expanded: "true" }), "quiet"), help.actions.showAll));
    }
    function renderCountTable() {
        const time = !route.chart || route.chart === "time";
        const groups = time ? analytics.timeSeries?.points || [] : analytics.groups;
        const table = el("table"), thead = el("thead"), heading = el("tr");
        const layer = applied.layer;
        const labels = layer === "tool"
            ? { ...resultLabels }
            : { success: "HTTP 2xx", failure: "HTTP 4xx/5xx", unknown: "No status", other: "Other status", transport: "Connection failed", partial: "Partial result" };
        if (layer === "reported-api") { labels.failure = "Error result"; labels.unknown = "No status / error"; }
        const keys = layer === "code-reference" ? [] : resultKeys.filter(key =>
            key === "success" || key === "failure" || key === "unknown" && layer !== "recorded-http" || analytics.totals[key] > 0);
        const calendarMeaning = applied.bucket === "week" ? " Dates are Mondays." : applied.bucket === "month" ? " Dates are the first of each month." : "";
        const caption = el("caption", "", `${units[layer][0].toUpperCase() + units[layer].slice(1)}${time
            ? ` by ${applied.bucket}.${calendarMeaning} Counts use the current filters.`
            : ". All categories matching the current filters, including those grouped as Other in the chart."}`);
        if (groups.length > 24) caption.append(" Totals include every page.");
        if (layer === "reported-api") caption.append(" Error results include HTTP 4xx/5xx or a reported error code.");
        const dateLabel = time ? applied.bucket === "week" ? "Week starting" : applied.bucket === "month" ? "Month starting" : "Date" : route.chart === "endpoint" ? applied.layer === "tool" ? "Path / operation" : "API path" : categoryNoun();
        table.setAttribute("aria-label", "Exact data for the visible chart");
        table.className = "exact-data-table";
        const columns = el("colgroup");
        columns.append(el("col", "chart-label-column"), ...["total", ...keys].map(() => el("col", "chart-number-column")));
        for (const [index, label] of [dateLabel, "Total", ...keys.map(key => labels[key])].entries()) {
            const cell = el("th", index ? "numeric" : "", label); cell.scope = "col"; heading.append(cell);
        }
        thead.append(heading);
        const footer = el("tfoot"), totalRow = el("tr"), totalLabel = el("th", "", "Total (all rows)");
        totalLabel.scope = "row";
        totalRow.append(totalLabel, ...["total", ...keys].map(key => el("td", "numeric", count(groups.reduce((sum, group) => sum + group[key], 0)))));
        footer.append(totalRow);
        pagedList($("countTable"), groups, { key: "chart:" + sliceKey(), size: 24, noun: "chart rows", listTag: "tbody", renderItem: group => {
            const row = el("tr");
            const label = el("td");
            if (time && group.total) {
                const action = button(date(group.date, true), () => drillTime(group), "chart-data-action quiet");
                action.setAttribute("aria-label", `${date(group.date, true)}: ${count(group.total)} ${results.unit(applied.layer, group.total)}. View requests.`);
                label.append(action);
            } else if (!time && group.total) {
                const name = route.chart === "endpoint" ? group.label : serviceLabel(group.label);
                const action = button(name, () => drillGroup(group), "chart-data-action quiet");
                action.setAttribute("aria-label", `${name}: ${count(group.total)} ${results.unit(applied.layer, group.total)}. View requests.`);
                label.append(action);
            } else label.append(el("span", "chart-data-label", time ? date(group.date, true) : route.chart === "endpoint" ? group.label : serviceLabel(group.label)));
            row.append(label, el("td", "numeric", count(group.total)), ...keys.map(key => el("td", "numeric", count(group[key]))));
            return row;
        }, wrapList: tbody => {
            table.replaceChildren(caption, columns, thead, tbody, footer);
            const content = document.createDocumentFragment();
            content.append(groups.length ? table : el("p", "", "No chart rows in this slice."));
            if (time && analytics.timeSeries?.undatedCount) {
                const missing = analytics.timeSeries.undatedCount;
                content.append(el("p", "table-note", `${count(missing)} record${missing === 1 ? "" : "s"} without a date ${missing === 1 ? "is" : "are"} excluded here. Service and API-path views include them.`));
            }
            return content;
        } });
    }
    function servicesFor(rows) { return [...new Set(rows.map((row) => row.workload).filter(Boolean))].map(serviceLabel).join(", ") || serviceLabel("Unknown"); }
    function projectContext(scenario) {
        const context = el("p", "project-context");
        if (!scenario.projectId) {
            context.classList.add("unscoped");
            context.textContent = scenario.sourceSessionId || scenario.sessionId ? applied.layer === "http" ? "Recorder source without a project" : "Copilot chat without a project" : "Project not recorded";
        } else {
            context.append(el("span", "project-context-label", scenario.projectType === "folder" ? "Copilot folder project" : scenario.projectType === "repository" ? "Copilot repository project" : "Copilot project"), el("strong", "", scenario.project || scenario.projectId));
        }
        return context;
    }
    function currentViewScenarios() {
        return slice?.scenarios.slice() || [];
    }
    function renderCurrentViewInsights() {
        const host = route.view === "analyze" ? $("homeInsights") : null;
        if (!host) return;
        const scenarios = currentViewScenarios();
        const ids = new Set(scenarios.map(item => item.scenarioId));
        const rows = selectionRows().filter(row => ids.has(row.scenarioId));
        const scopeNote = `${chatCopy.groups(ids.size, applied.layer === "http")} across all pages · ${count(rows.length)} ${results.unit(applied.layer, rows.length)} matched. Insights include each group's full retained interaction.`;
        setText($("homeInsightScope"), `${chatCopy.groups(ids.size, applied.layer === "http")} across all pages; full retained interactions, not only matched ${results.unit(applied.layer, 2)}.`);
        assessmentUI.overview(host, [...ids], { scopeNote, findingsHost: $("homeFindings") });
    }
    function revealResults() {
        $("activityTitle").focus({ preventScroll: true });
        $("activityView").scrollIntoView({ block: "start" });
    }
    function revealSessionResult() {
        if (route.view === "request" && route.call !== undefined) {
            const target = $("selectedCall") || $("unavailableCall");
            if (!target) return false;
            target.focus({ preventScroll: true });
            target.scrollIntoView({ block: "start" });
            return true;
        }
        if (route.view !== "analyze" || route.mode !== "calls") return false;
        revealResults();
        return true;
    }
    function sessionScopeText() {
        const coverage = state.sessionAnalysis?.coverage;
        const period = route.from || route.to ? `${date(route.from)} to ${date(route.to)}` : coverage?.firstAt
            ? `${date(coverage.firstAt)} to ${date(coverage.lastAt)}` : "All retained dates; no dated actions in this scope";
        const serviceFocus = route.services ? route.services.split(",").map(serviceLabel).join(", ")
            + (route.includeMissingService === true ? ` + ${applied.layer === "tool" ? "calls" : results.unit(applied.layer, 2)} with missing service details` : " only") : null;
        return `${period} / ${serviceFocus || (route.service ? serviceLabel(route.service) : allCategories())}${serviceFocus && route.service ? " / Category: " + serviceLabel(route.service) : ""}${route.tool ? " / " + route.tool : ""} / ${authorship.selectionLabel(applied.filters.promptAuthors)} / ${scopeLabels[applied.filters.scope]}${route.endpoint ? " / Selected API path" : ""}${search ? " / Private request search applied" : ""}`;
    }
    function renderSessionAnalysis() {
        const host = $("sessionAnalysis"), source = sessionSource();
        host.replaceChildren();
        host.hidden = route.view !== "analyze" || !route.session;
        if (host.hidden) return;
        const context = state.sessionAnalysis;
        const rows = context?.rows && slice.refineRows(context.rows);
        const summary = results.summarize(rows);
        host.append(resultLine(applied.layer, summary, {
            scope: "Source results before the result filter", sessionId: source.sessionId,
            label: summary ? chatCopy.relationship(new Set(rows.map(row => row.scenarioId).filter(Boolean)).size, summary.count, results.unit(applied.layer, summary.count), applied.layer === "http") : "Source results",
        }));
        host.append(el("p", "session-scope", `${sessionScopeText()}. ${route.result ? `Totals above include all results in this scope; showing ${resultNames(resultSelection(route.result))} only below.` : "All recorded results in this scope below."}`));
        if (summary?.count) host.append(el("p", "context-help-note", applied.layer === "tool"
            ? "Worked and Tool failed count tool calls, not completed requests."
            : explanations[applied.layer]));
        const reasons = source.reasons?.map(reason => historyStatus.reasons[reason]?.label).filter(Boolean) || [];
        const coverage = source.unavailable ? "Saved history is unavailable. Previously collected evidence is shown; reports may omit unread history."
            : source.eligible === false ? "This source is no longer in Current activity. Previously collected evidence is preserved."
            : source.pending ? "History is still being collected. This analysis may be incomplete."
            : reasons.length ? "Partial history: " + reasons.join("; ") + "."
            : !source.coverageKnown ? "History coverage has not been verified for this Copilot chat."
            : "Collected history only; unrecorded calls and hosted internal Graph traffic are not observable.";
        host.append(el("p", "session-coverage", coverage));
        if (!summary?.count) {
            host.append(el("p", "", summary ? "No recorded evidence matches this source and scope. This is not a success or failure result." : "Result counts are unavailable; no replacement totals were inferred."));
            const layers = results.layers.filter(layer => state.requestActivity?.[layer]?.some(row => row.sourceSessionId === source.sessionId));
            const options = el("div", "page-actions");
            for (const layer of layers.filter(layer => layer !== applied.layer && layer !== "reported-api" && layer !== "recorded-http")) {
                options.append(link(`Inspect ${results.unit(layer, 2)}`, "activity", { layer, result: undefined, endpoint: undefined, search: undefined, page: undefined }, "text-link"));
            }
            if (source.eligible === false) options.append(link("Inspect preserved activity", "activity", { scope: "all", result: undefined, page: undefined }, "text-link"));
            host.append(options);
        }
        if (source.unavailable || source.pending || reasons.length || !summary?.count) {
            host.append(link("Review collection status", "collection-status", { setting: "issues" }, "text-link"));
        }
    }
    function renderActivity() {
        captureReading();
        const scenarios = currentViewScenarios();
        scenarios.sort((a, b) => String(b.userPrompt?.sourceTimestamp || b.capturedAt || "").localeCompare(String(a.userPrompt?.sourceTimestamp || a.capturedAt || "")));
        const host = $("activityList");
        const calls = route.mode === "calls";
        const items = calls ? callInvestigation.order(selectionRows(), route.callSort, applied.layer)
            : presentation.ordered("interactions:" + sliceKey(), scenarios, item => item.scenarioId);
        $("callSortControls").hidden = !calls;
        $("callSort").value = route.callSort || "slowest";
        selectControls?.sync();
        const timed = items.filter(row => callInvestigation.duration(row, applied.layer) !== null).length;
        $("callTimingScope").textContent = `${count(timed)} timed; ${count(items.length - timed)} unavailable, listed last. Ties use canonical record ID order. Each duration is for one record, not task latency.`;
        const noun = calls ? results.unit(applied.layer, 2) : applied.layer === "http" ? "record groups" : "interactions";
        $("activityTitle").textContent = calls ? applied.layer === "tool" ? "Calls" : results.unit(applied.layer, 2) : applied.layer === "http" ? "Record groups" : "Interactions";
        for (const node of document.querySelectorAll("[data-analyze-mode]")) {
            const active = calls === (node.dataset.analyzeMode === "calls");
            node.href = routeUrl(routeFor("analyze", { mode: node.dataset.analyzeMode === "calls" ? "calls" : undefined, page: undefined }));
            if (active) node.setAttribute("aria-current", "true");
            else node.removeAttribute("aria-current");
        }
        $("activityView").dataset.revision = String(state.revision);
        const unlinked = selectionRows().filter(row => !slice.scenarioIds.includes(row.scenarioId)).length;
        $("activityListSummary").textContent = `${count(scenarios.length)} ${applied.layer === "http" ? "record group" : "interaction"}${scenarios.length === 1 ? "" : "s"} with ${count(selectionRows().length)} matching ${results.unit(applied.layer, selectionRows().length)} across all pages. Filters and private search apply to the overview and both lists. Opening an interaction includes its full retained evidence.${unlinked ? ` ${count(unlinked)} records have no retained interaction; they remain available in Calls.` : ""}`;
        $("activityListSummary").hidden = false;
        host.replaceChildren();
        activityPage = Math.min(activityPage, Math.max(0, Math.ceil(items.length / pageSize) - 1));
        if (!items.length) {
            host.append(empty(!state.scenarios.length ? "No collected activity yet" : `No matching ${noun}`,
                search ? "Try a different phrase or clear the private search. Other filters and report selections stay."
                    : "Change a filter or use Reset Analyze to explore retained evidence. Source approval and collection settings are unchanged."));
        }
        let previousTiming;
        for (const item of items.slice(activityPage * pageSize, (activityPage + 1) * pageSize)) {
            if (calls) {
                const timing = callInvestigation.duration(item, applied.layer) === null ? "Duration unavailable" : "Recorded duration";
                if (timing !== previousTiming) host.append(el("h3", "call-duration-group", timing));
                previousTiming = timing;
            }
            host.append(calls ? matchingAction(item) : requestCard(item));
        }
        const pager = viewKey($("activityPager"), "pager:activity");
        pager.hidden = !items.length;
        pager.setAttribute("role", "navigation");
        pager.setAttribute("aria-label", "Analyze result pages");
        pager.replaceChildren(el("span", "", `${activityPage * pageSize + 1}-${Math.min((activityPage + 1) * pageSize, items.length)} of ${items.length} ${noun}`));
        const position = pager.firstElementChild;
        position.id = "activityPagePosition";
        position.dataset.pagePosition = "";
        position.tabIndex = -1;
        if (items.length > pageSize) {
            const turnPage = offset => navigate(routeFor("analyze", { page: Math.max(0, activityPage + offset) }), false,
                { paging: capturePager(pager, offset) });
            const prev = button("Previous", () => turnPage(-1));
            prev.disabled = activityPage === 0;
            prev.dataset.pageDirection = "-1";
            prev.setAttribute("aria-describedby", position.id);
            const next = button("Next", () => turnPage(1));
            next.disabled = (activityPage + 1) * pageSize >= items.length;
            next.dataset.pageDirection = "1";
            next.setAttribute("aria-describedby", position.id);
            pager.append(prev, next);
        }
        updateSessionSelections();
    }
    function recordedFailure(tool, failed = false) {
        const errors = (tool?.apiResults || []).filter(result => result.errorCode || result.statusCode >= 400)
            .map(result => [result.statusCode ? `Reported HTTP ${result.statusCode}` : null, result.errorCode].filter(Boolean).join(": "));
        const evidence = tool?.failureEvidence;
        const signIn = (failed || tool?.toolSucceeded === false) && evidence?.version === 1
            && evidence.messageStatus === "text-excluded" && evidence.messageSignal === "workiq-sign-in-required";
        if (evidence?.version === 1 && evidence.reason === "error-code-recorded" && evidence.code
            && (!signIn || evidence.code !== "failure")) errors.unshift("Tool error: " + evidence.code);
        if (signIn) errors.unshift("Work IQ sign-in was required");
        if (evidence?.version === 1 && evidence.messageSignal === "access-denial") errors.push("Tool error mentions access denial");
        if (evidence?.version === 1 && evidence.messageSignal === "request-timeout") errors.push("Tool reported an MCP request timeout (-32001).");
        if (errors.length) return errors.join("; ");
        if (!failed && tool?.toolSucceeded !== false) return null;
        return help.failureEvidence[evidence?.version === 1 ? evidence.reason : "unknown"] ?? help.failureEvidence.unknown;
    }
    function matchingAction(row) {
        const scenario = state.scenarios.find(s => s.scenarioId === row.scenarioId);
        const card = viewKey(el("article", "matched-action"), "action:" + row.id);
        card.dataset.actionId = row.id;
        card.dataset.sessionId = row.sourceSessionId;
        const call = sourceCallFor(row);
        const recordedLabel = applied.layer === "code-reference" ? "Reference recorded" : applied.layer === "reported-api" ? "Parent call recorded"
            : ["direct-request", "recorded-http"].includes(applied.layer) ? "Request site recorded" : "Action recorded";
        card.append(toolHeading(row.tool), el("p", "muted", `${recordedLabel}: ${time.formatMoment(row.startedAt, applied.timeContext)}`));
        const measured = callInvestigation.duration(row, applied.layer);
        card.append(el("p", "call-duration", measured === null ? "Duration unavailable"
            : `Recorded ${applied.layer === "tool" ? "call" : applied.layer === "reported-api" ? "API result" : "HTTP record"} duration: ${count(measured)} ms`));
        if (analytics.serviceInvolvement?.selection.contextOnlyIds.includes(row.id)) card.append(el("p", "service-context-label", "Missing-service context, not a known match to the selected service."));
        if (["tool", "reported-api"].includes(applied.layer)) card.append(actionFields(call, row, { includeTool: false, returned: applied.layer === "reported-api" }));
        else {
            const fields = el("dl", "action-fields");
            fields.append(el("dt", "", "Service"), serviceHeading("dd", row.workload));
            const graph = scenario?.graphActivities?.find(item => item.activityId === row.activityId);
            const http = scenario?.httpRecords?.find(item => item.recordId === row.recordId);
            pathField(fields, applied.layer === "code-reference" ? "Referenced API path" : "API path",
                results.pathText(graph?.endpoint ?? http?.responsePath ?? http?.path ?? http?.requestedPath ?? http?.requestShape?.path));
            card.append(fields);
        }
        card.append(resultLine(applied.layer, results.summarize([row]), { heading: results.heading(applied.layer) }));
        if (["failure", "transport"].includes(row.outcome)) {
            const reason = applied.layer === "http" && row.outcome === "transport" ? "Connection failed; no HTTP response was recorded."
                : applied.layer === "tool" ? recordedFailure(call, true)
                : row.status ? `${applied.layer === "reported-api" ? "Tool-reported" : "Recorded"} HTTP ${row.status}. Response body was not retained.`
                    : recordedFailure(call, true);
            card.append(el("p", "action-error", reason));
        } else {
            card.append(el("p", "context-help-note", `${row.status ? `${applied.layer === "reported-api" ? "Tool-reported" : "Recorded"} HTTP ${row.status}. ` : ""}${help.resultHelp(row.outcome, applied.layer)}`));
        }
        if (scenario) {
            card.append(interactionContext(scenario));
            card.append(textAccess.render(scenario.userPrompt, { key: "action:" + row.id, originKind: authorship.originKind(scenario),
                navigationNode: link(applied.layer === "tool" ? "Open exact call in context" : "Open exact record in context",
                    "request", { request: scenario.scenarioId, call: row.id,
                        callRevision: applied.layer === "reported-api" ? String(state.revision) : undefined }, "request-link text-link"),
            }));
        } else card.append(el("p", "muted", "Full request details were not retained."));
        return card;
    }
    function interactionContext(scenario) {
        const context = el("div", "interaction-context"), source = sessionSource(scenario.sourceSessionId);
        if (source) {
            const chat = routeLink(source.name, sessionRoute(source.sessionId), "text-link");
            chat.setAttribute("aria-label", "Filter to Copilot chat: " + source.name);
            context.append(chat);
            const reference = sourceReference(source);
            if (reference) context.append(el("span", "source-reference", reference));
        } else context.append(el("span", "muted", "Source chat not recorded"));
        context.append(projectContext(source || scenario));
        return context;
    }
    function requestCard(scenario) {
        const rows = rowsFor(scenario.scenarioId), row = viewKey(el("article", "request-row"), "request:" + scenario.scenarioId);
        const content = el("div");
        const requestLink = link("View interaction", "request", { request: scenario.scenarioId }, "request-link text-link");
        content.append(textAccess.render(scenario.userPrompt, { key: "activity:" + scenario.scenarioId, navigationNode: requestLink, originKind: authorship.originKind(scenario) }));
        const services = [...new Set(rows.map(row => row.workload).filter(Boolean))];
        const cue = serviceCue("span", services.length > 1 ? "Multiple workloads" : services[0] || "Unknown");
        cue.lastElementChild.remove();
        const serviceText = servicesFor(rows);
        const meta = metadata.row([
            { label: serviceText, leading: cue, helpWithLabel: true, helpLabel: `${serviceText}; ${applied.layer === "tool" ? "recorded activity categories" : "recorded services"}`, help: categories.used(rows.map(row => row.workload)).map(entry => `${entry.label}: ${entry.description}`).join(" ") || categories.describe("Unknown").description },
            { label: requestTiming.summary(scenario, applied.timeContext) },
        ]);
        meta.classList.add("request-meta");
        const tools = [...new Set(rows.map(row => row.tool).filter(Boolean))];
        content.append(interactionContext(scenario), meta);
        if (tools.length) content.append(el("p", "interaction-tools", tools.join(", ")));
        content.append(matchingResults(scenario.scenarioId));
        const selection = el("label", "interaction-select");
        selection.append(selectionCheckbox(scenario));
        row.append(selection, content);
        return row;
    }
    function updateSessionSelections() {
        const reportRequests = reportSelection().requests;
        for (const node of document.querySelectorAll("[data-session-selection]")) {
            const id = node.dataset.sessionSelection;
            const requests = state.scenarios.filter(s => (s.sourceSessionId || "unattributed:" + s.scenarioId) === id);
            const ids = new Set(requests.map(s => s.scenarioId));
            const total = reportRequests.filter(request => request.aliases.some(id => ids.has(id))).length;
            renderSelectionCount(node, total, requests.length);
            node.title = `${chatCopy.groups(total)} in this Copilot chat included in report, across its retained dates and pages. Complete eligible request groups, not only matching calls.`;
            node.hidden = false;
        }
    }
    function renderSelectionCount(node, total, maximum) {
        let number = node.querySelector(".selection-number");
        if (!number) {
            number = el("span", "selection-number");
            node.replaceChildren(number, document.createTextNode(" in report"));
        }
        number.style.minInlineSize = String(count(maximum).length) + "ch";
        setText(number, count(total));
    }
    function selectionCheckbox(scenario) {
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.id = "select-request-" + encodeURIComponent(scenario.scenarioId);
        checkbox.checked = selected.has(scenario.scenarioId);
        checkbox.setAttribute("aria-label", "Select request for report: " + shorten(excerpt(scenario), 70));
        ux.tooltip(checkbox, help.actions.selectRequest);
        checkbox.addEventListener("change", () => {
            checkbox.checked ? selected.add(scenario.scenarioId) : selected.delete(scenario.scenarioId);
            reportScope = "selected";
            reportEntry = null;
            invalidatePreview();
            updateSelection();
        });
        return checkbox;
    }
    function renderRequest() {
        if (route.view !== "request") return;
        captureReading();
        const context = requestContext.select(state.scenarios, route.request);
        const target = callInvestigation.resolve(state.requestActivity, state.scenarios, route, state.revision);
        const body = $("requestContent");
        body.replaceChildren();
        detailOwner = "request:" + route.request;
        viewKey(body, detailOwner);
        if (target.status === "unavailable") {
            const notice = empty("This exact record is unavailable", target.reason === "snapshot-changed"
                ? "This API-result link has no matching snapshot revision. Returned-entry identities are not stable across stored revisions. No other entry was substituted. Return to Calls and reopen the result from the current snapshot."
                : "The selected record or its recorded parent is no longer available in this interaction. No nearby action was substituted. Return to results to choose another record.");
            notice.id = "unavailableCall";
            notice.tabIndex = -1;
            body.append(notice);
            return;
        }
        if (!context.groups.length) {
            body.append(empty("This interaction is not available", "It may no longer be in the current local collection. Return to Analyze to choose another interaction."));
            return;
        }
        const heading = el("h2", "", "What was asked and what came back");
        heading.id = "requestContextTitle";
        const contextHeader = el("section", "request-context-heading");
        contextHeader.append(heading, el("p", "context-help-note", context.limitation));
        if (target.status === "available") contextHeader.append(el("p", "context-help-note", "Opened the exact selected record below. Other retained actions and messages remain context, not additional matches."));
        if (context.groups.length > 1) contextHeader.append(el("p", "context-help-note", "Nearby groups are linked by recorded messages, not a confirmed task or continuation."));
        const boundary = el("details", "reader-details");
        boundary.append(el("summary", "", "How this context is linked"), el("p", "", context.boundary),
            el("p", "", "Prompt-to-call and nearby-follow-up associations remain inferred. A retained group is not proof of a human task, its intent or its boundaries."));
        contextHeader.append(boundary);
        for (const gap of context.gaps) contextHeader.append(el("p", "reader-empty", gap));
        const journey = el("ol", "journey request-context-timeline");
        journey.setAttribute("aria-labelledby", heading.id);
        const summaries = el("section", "request-context-summaries");
        summaries.append(el("h2", "", "Counts and saved assessment scope"),
            el("p", "context-help-note", "Each result below keeps its original recorded group and assessment scope. Nearby messages do not change an old verdict or judge a later reply against an earlier request. No assessment is rerun here."));
        body.append(contextHeader, journey, summaries);
        const entries = [], seen = new Set(), rendered = [];
        const relationLabel = relation => relation === "selected" ? "Selected interaction"
            : relation === "preceding" ? "Earlier linked context" : "Following linked context";
        function insertEntry(entry) {
            const content = entry.render(), item = content.tagName === "LI" ? content : el("li", "journey-item");
            if (content !== item) item.append(content);
            item.dataset.contextGroup = entry.scenarioId;
            item.dataset.contextKind = entry.kind ?? "action";
            if (entry.actionId) item.dataset.actionId = entry.actionId;
            viewKey(item, entry.key);
            const moment = typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))
                ? `${entry.kind === "response" ? "Response recorded" : entry.kind === "prompt" || entry.kind === "follow-up" ? "Message recorded" : entry.timeLabel || "Action started"}: ${timestamp(entry.at)}`
                : "Time not recorded; position in the chronology is unknown.";
            const label = el("p", "context-entry-label", `${relationLabel(entry.relation)} / ${moment}`);
            item.prepend(label);
            if (entry.kind === "prompt" && entry.relation === "selected") {
                item.id = "selectedContext";
                if (target.status !== "available") item.setAttribute("aria-current", "true");
                label.classList.add("context-selected-label");
            }
            if (target.status === "available" && entry.actionId === target.actionId && entry.scenarioId === route.request) {
                item.dataset.selectedAction = "true";
                label.classList.add("context-selected-label");
                label.prepend(document.createTextNode(applied.layer === "reported-api" ? "Parent of selected API result / " : "Selected record / "));
                if (applied.layer !== "reported-api") {
                    item.id = "selectedCall";
                    item.tabIndex = -1;
                    item.setAttribute("aria-current", "true");
                }
            }
            const index = rendered.findIndex(other => requestContext.compare(entry, other) < 0);
            journey.insertBefore(item, index < 0 ? null : rendered[index].node);
            if (index < 0) rendered.push({ ...entry, node: item });
            else rendered.splice(index, 0, { ...entry, node: item });
            detailOwner = "request:" + route.request;
        }
        for (const group of context.groups) {
        const scenario = group.scenario, isSelected = group.relation === "selected";
        detailOwner = "request:" + scenario.scenarioId;
        const rows = rowsFor(scenario.scenarioId);
        const full = fullRowsFor(scenario.scenarioId);
        const sameScope = full && full.length === rows.length && full.every(row => rows.some(match => match.id === row.id));
        const outcome = el("section", "request-outcome");
        const allResults = el("div", "full-request-results");
        allResults.append(el("h3", "", "Recorded results"));
        fullResults(allResults, scenario.scenarioId);
        outcome.append(allResults);
        if (!sameScope) {
            const matching = el("div", "request-matching");
            matching.append(el("p", "muted", "Matching this view"), matchingResults(scenario.scenarioId),
                el("p", "context-help-note", "Recorded results cover this original group only. The chronology identifies matching and nonmatching actions; linked context does not enlarge the Analyze or report selection."));
            outcome.append(matching);
        }
        const intro = el("div", "request-intro");
        const source = sessionSource(scenario.sourceSessionId);
        const originKind = authorship.originKind?.(scenario);
        const sourceIdentity = el("div", "request-source");
        sourceIdentity.append(el("span", "request-source-label", originKind === "copilot-chat" ? "GitHub Copilot chat"
            : applied.layer === "http" ? "Recorder source" : "Source"),
            el("strong", source && applied.layer !== "http" ? "copilot-chat-name" : "", source?.name ?? "Source not recorded"));
        const sourceMeta = el("div", "request-context-meta");
        const project = projectContext(source || scenario);
        if (originKind !== "copilot-chat" && project.classList.contains("unscoped")) project.textContent = "Project not recorded";
        sourceMeta.append(project, el("p", "request-time", requestTiming.summary(scenario, applied.timeContext)));
        intro.append(sourceIdentity, sourceMeta);
        const requestText = el("section", isSelected ? "request-original" : "request-context-prompt");
        requestText.append(textAccess.render(scenario.userPrompt, {
            key: "request:" + scenario.scenarioId, mode: "complete", initialOpen: true,
            originKind,
            notice: "Copy includes the complete retained prompt body only, without export masking. It does not include chat details, warnings, the response or the rest of this page. Other apps and clipboard history may access your system clipboard.",
        }));
        const insightHost = el("div", "interaction-insights"), responseHost = el("section", "interaction-response");
        const findingsHost = el("div", "interaction-findings");
        insightHost.dataset.contextGroup = scenario.scenarioId;
        findingsHost.dataset.contextGroup = scenario.scenarioId;
        if (isSelected) body.prepend(intro);
        entries.push({ key: "prompt:" + scenario.scenarioId, at: scenario.userPrompt?.sourceTimestamp,
            scenarioId: scenario.scenarioId, relation: group.relation, kind: "prompt", render: () => {
                const item = el("li", "journey-item");
                item.append(requestText, findingsHost, responseHost);
                return item;
            } });
        assessmentUI.detail(insightHost, responseHost, scenario.scenarioId, { eager: true, findingsHost, placeResponse: (node, observation) => {
            if (!journey.isConnected) return;
            insertEntry({ key: "response:" + observation.observationRef, at: observation.occurredAt,
                scenarioId: scenario.scenarioId, relation: group.relation, kind: "response", render: () => node });
        } });
        const original = scenario.userPrompt;
        const support = el("div", "request-support");
        const provenance = el("div");
        provenance.append(facts([
            ["Origin", requestTiming.origin(original)], ["Text retained", requestTiming.coverage(original)],
            ["Message recorded", timestamp(original?.sourceTimestamp)], ["Raw message timestamp", original?.sourceTimestamp],
            ["Group timestamp", timestamp(scenario.capturedAt)], ["Raw group timestamp", scenario.capturedAt], ["Source event", original?.sourceEventId],
            ["Provenance", authorship.read(original).basis], ["Status", original?.status],
            ["Copilot chat ID", scenario.sourceSessionId], ["Prompt association", scenario.promptAssociation],
            ["Coverage", scenario.coverageNote], ["Assessment", scenario.assessedFinding],
        ]));
        support.append(disclosure("Technical source record", provenance));
        for (const message of context.messages.filter(message => message.scenarioId === scenario.scenarioId && message.kind === "follow-up")) {
            const followup = el("section", "request-context-prompt");
            followup.append(el("p", "context-help-note", "Nearby retained message / inferred follow-up, not a confirmed continuation."),
                textAccess.render(message.source, { key: message.key, mode: "complete", initialOpen: true, originKind }));
            if (message.source.association) followup.append(el("p", "context-help-note", message.source.association));
            entries.push({ ...message, relation: group.relation, render: () => followup });
        }
        const actions = el("section", "request-actions");
        actions.setAttribute("aria-labelledby", "requestReportTitle");
        const reportContext = el("div");
        const reportTitle = el("h2", "", "Report selection");
        reportTitle.id = "requestReportTitle";
        const included = reportSelection().requests.some(request => request.aliases.includes(scenario.scenarioId));
        reportContext.append(reportTitle, el("p", "muted", selected.has(scenario.scenarioId) ? "This request is selected."
            : included ? "This request is included through the current report scope." : "This request is not selected."));
        const pick = button(selected.has(scenario.scenarioId) ? "Remove from report" : "Add to report", () => {
            selected.has(scenario.scenarioId) ? selected.delete(scenario.scenarioId) : selected.add(scenario.scenarioId);
            reportScope = "selected";
            reportEntry = null;
            invalidatePreview(); renderRequest(); updateSelection();
            ux.restoreFocus($("requestReportToggle"));
        });
        pick.id = "requestReportToggle";
        ux.tooltip(pick, selected.has(scenario.scenarioId) ? help.actions.removeRequest : help.actions.selectRequest);
        actions.append(reportContext, pick);
        const recorded = el("section", "request-recorded");
        const recordedTitle = el("h3", "request-actions-heading", relationLabel(group.relation));
        recordedTitle.id = "requestRecordedTitle-" + encodeURIComponent(scenario.scenarioId);
        recorded.setAttribute("aria-labelledby", recordedTitle.id);
        recorded.append(recordedTitle, el("p", "context-help-note", "Original group prompt recorded: " + timestamp(scenario.userPrompt?.sourceTimestamp)), outcome, insightHost);
        const entryStart = entries.length;
        const canonical = fullRowsFor(scenario.scenarioId, "tool") ?? (applied.layer === "tool" ? rows : undefined);
        for (const tool of scenario.toolCalls || []) {
            const row = canonical?.find(item => tool.toolCallId ? item.toolCallId === tool.toolCallId : item.id === `event:${JSON.stringify([scenario.sourceSessionId, tool.startEventId])}`);
            if (row && (seen.has(row.id) || row.id === target.actionId && !isSelected)) continue;
            if (row) seen.add(row.id);
            const key = JSON.stringify([scenario.scenarioId, "tool", row?.id || tool.toolCallId || tool.startEventId || tool]);
            entries.push({ key, actionId: row?.id, startedAt: tool.startedAt, render: () => {
            detailOwner = key;
            const item = viewKey(el("li", "journey-item"), key);
            item.dataset.toolCallId = tool.toolCallId || "";
            item.append(actionHeading(tool.tool || "Recorded assistant action", row?.workload, row));
            const result = resultLine("tool", row ? results.summarize([row]) : null, { help: explanations.tool, heading: results.heading("tool") });
            result.classList.add("journey-result");
            item.append(result);
            const duration = callInvestigation.duration(tool);
            item.append(el("p", "call-duration", duration === null ? "Call duration unavailable" : `Recorded call duration: ${count(duration)} ms`));
            const apiRows = fullRowsFor(scenario.scenarioId, "reported-api")?.filter(r => r.parentCallId === row?.id);
            if (apiRows?.length) item.append(resultLine("reported-api", results.summarize(apiRows), { heading: results.heading("reported-api") }));
            else if (row?.workload !== "Discovery") item.append(el("p", "result-missing-api", apiRows ? "API metadata: None recorded." : "API metadata: Unavailable."));
            if (!sameScope || target.status === "available") actionContext(item, applied.layer === "tool" ? (row ? [row] : canonical ? [] : undefined) : applied.layer === "reported-api" ? apiRows : []);
            const failure = recordedFailure(tool, ["failure", "transport"].includes(row?.outcome));
            if (failure) item.append(el("p", "action-error", failure),
                el("p", "context-help-note", "Historical call evidence only; it does not establish current sign-in or permission state."));
            const sourceCall = sourceCallFor(row) || tool;
            const fields = actionFields(sourceCall, row, { includeTool: false, includeService: false });
            if (fields.childElementCount) item.append(fields);
            if (row) {
                const returned = returnedDetails(sourceCall, row, apiRows,
                    applied.layer === "reported-api" && target.actionId === row.id ? target.row.id : undefined);
                if (returned) item.append(returned);
            }
            const expert = el("div", "technical-detail");
            expert.append(facts([["Started", timestamp(tool.startedAt)], ["Ended", timestamp(tool.completedAt ?? tool.endedAt)], ["Duration", tool.durationMs == null ? null : tool.durationMs + " ms"],
                ["Raw start timestamp", tool.startedAt], ["Raw end timestamp", tool.completedAt ?? tool.endedAt],
                ["Tool outcome", tool.reportedOutcome], ["Execution success", tool.toolSucceeded], ["HTTP observed", tool.observedGraphHttp ? "Yes" : "No"], ["Tool call ID", tool.toolCallId], ["Parent invocation", tool.parentToolCallId], ["Parallel group", tool.parallelGroup]], {
                technical: true,
                missing: {
                    "Parent invocation": tool.parentInvocationEvidence === "source-field-absent" ? help.invocationAbsence.parentSource : help.invocationAbsence.unknownParent,
                    "Parallel group": tool.parallelGroupEvidence === "adapter-not-supported" || scenario.sourceHost === "copilot-app" && scenario.workloadKind === "recorded-history"
                        ? help.invocationAbsence.parallelAdapter : help.invocationAbsence.unknownParallel,
                },
            }));
            if (tool.failureEvidence?.version === 1) {
                const evidence = tool.failureEvidence;
                const reason = help.failureMessageStatus[evidence.messageStatus] ?? "Error messages, stack traces and response bodies are excluded from collection.";
                expert.append(el("p", "context-help-note", reason));
            }
            expert.append(disclosure("Exact recorded arguments / local only", JSON.stringify(tool.requestArgs, null, 2) ?? "[Arguments unavailable]"));
            for (const key of ["command", "code", "script"]) if (typeof tool.requestArgs?.[key] === "string") expert.append(ux.codeBlock(tool.requestArgs[key], { label: "Recorded " + key, copyLabel: "Copy " + key }));
            for (const result of tool.apiResults || []) expert.append(facts([["Result attribution", result.evidenceLevel], ["Reported status", result.statusCode], ["Reported error", result.errorCode]]));
            item.append(disclosure("Technical details", expert));
            return item;
            } });
        }
        for (const graph of scenario.graphActivities || []) {
            const layer = graph.evidenceLevel === "code-reference" ? "code-reference" : "direct-request";
            const graphRows = fullRowsFor(scenario.scenarioId, layer)?.filter(row => row.activityId === graph.activityId);
            if (graphRows?.[0] && (seen.has(graphRows[0].id) || graphRows[0].id === target.actionId && !isSelected)) continue;
            if (graphRows?.[0]) seen.add(graphRows[0].id);
            const key = JSON.stringify([scenario.scenarioId, "graph", graph.activityId || graph]);
            entries.push({ key, actionId: graphRows?.[0]?.id, startedAt: graph.startedAt,
                timeLabel: layer === "code-reference" ? "Reference recorded" : "Request site recorded", render: () => {
            detailOwner = key;
            const item = viewKey(el("li", "journey-item"), key);
            item.append(actionHeading(layer === "code-reference" ? "Graph code reference" : "Direct Graph request site", graphRows?.[0]?.workload || graph.workload || "Unknown", graphRows?.[0], layer));
            const path = el("dl", "action-fields");
            pathField(path, layer === "code-reference" ? "Referenced API path" : "API path", results.pathText(graph.endpoint));
            item.append(path);
            item.append(resultLine(layer, graphRows?.length ? results.summarize(graphRows) : null));
            actionContext(item, ["direct-request", "recorded-http", "code-reference"].includes(applied.layer) ? graphRows : []);
            const status = graph.evidenceLevel === "output-visible-http" ? graph.httpStatus : null;
            item.append(el("p", "", status != null ? "Visible HTTP status: " + status : graph.evidenceLevel === "code-reference" ? "Code reference only; execution is not established." : "No HTTP status observed in this record."));
            const expert = el("div");
            expert.append(facts([["Recorded", timestamp(graph.startedAt)]]), ux.codeBlock(JSON.stringify(graph, null, 2), { label: "Recorded Graph evidence / local only", copyLabel: "Copy recorded Graph evidence" }));
            item.append(disclosure("Technical details", expert));
            return item;
            } });
        }
        for (const record of scenario.httpRecords || []) {
            const httpRows = fullRowsFor(scenario.scenarioId, "http")?.filter(row => row.recordId === record.recordId);
            if (httpRows?.[0] && (seen.has(httpRows[0].id) || httpRows[0].id === target.actionId && !isSelected)) continue;
            if (httpRows?.[0]) seen.add(httpRows[0].id);
            const key = JSON.stringify([scenario.scenarioId, "http", record.recordId || record]);
            entries.push({ key, actionId: httpRows?.[0]?.id, startedAt: record.startedAt, render: () => {
            detailOwner = key;
            const item = viewKey(el("li", "journey-item"), key);
            item.append(actionHeading("Explicit HTTP recorder", httpRows?.[0]?.workload, httpRows?.[0], "http"), el("p", "", record.status == null ? "No HTTP response recorded." : "Recorded HTTP status " + record.status));
            item.append(resultLine("http", httpRows?.length ? results.summarize(httpRows) : null));
            actionContext(item, applied.layer === "http" ? httpRows : []);
            const path = el("dl", "action-fields");
            pathField(path, "API path", results.pathText(record.responsePath ?? record.path ?? record.requestedPath ?? record.requestShape?.path));
            item.append(path);
            const expert = el("div");
            expert.append(facts([["Started", timestamp(record.startedAt)], ["Ended", timestamp(record.completedAt ?? record.endedAt)], ["Duration", record.durationMs == null ? null : record.durationMs + " ms"]]),
                ux.codeBlock(JSON.stringify(record, null, 2), { label: "Recorder details / local only", copyLabel: "Copy recorder details" }));
            item.append(disclosure("Technical details", expert));
            return item;
            } });
        }
        for (const entry of entries.slice(entryStart)) Object.assign(entry, {
            at: entry.startedAt, scenarioId: scenario.scenarioId, relation: group.relation, kind: "action",
        });
        if (entryStart === entries.length) recorded.append(el("p", "", "No individual action details were retained."));
        summaries.append(recorded);
        if (isSelected) body.append(actions);
        for (const item of analytics.journeys || []) {
            if (item.scenarioId !== scenario.scenarioId || item.association === "none") continue;
            const relation = item.association === "same-prompt-after-failure" ? "A Graph request follows a Work IQ failure in this prompt group." : item.association === "explicit-transition" ? "The record contains an explicit transition to Graph." : "Work IQ and Graph activity occur in the same prompt group.";
            provenance.append(el("p", "context-help-note", relation + " This is sequence evidence; it does not prove why the assistant chose Graph."));
        }
        detailOwner = "request:" + scenario.scenarioId;
        provenance.append(el("p", "context-help-note", "Counts use separate recorded units, not a combined total. Visible Graph statuses belong to request sites. Recorded completion does not establish task correctness."));
        recorded.append(support);
        }
        entries.sort(requestContext.compare);
        for (const entry of entries) insertEntry(entry);
        detailOwner = "request:" + route.request;
    }
    function reportSelection(kind = reportScope) {
        return reportScopes.resolve(state?.exportCatalog, kind, state ? currentViewScenarios().map((s) => s.scenarioId) : [], [...selected], reportAuthors);
    }
    function clearReportSelection() {
        if (exportWriting) return;
        reportScope = "selected";
        reportEntry = null;
        selected.clear();
        draft.clearSelection();
        invalidatePreview();
        reportJourney?.clear();
        if ($("overlay").open) {
            returnFocus = document.querySelector("#reportsView [data-clear-selection]");
            $("overlay").close();
        }
        $("detail").replaceChildren();
        if (state) { renderActivity(); renderRequest(); renderReports(); }
    }
    function selectedScenarios() {
        const ids = new Set(reportSelection().requests.map((r) => r.scenarioId));
        return state ? state.scenarios.filter((scenario) => ids.has(scenario.scenarioId)) : [];
    }
    function updateSelection() {
        if (!state) return;
        const value = reportSelection();
        const unknownSelected = reportScope === "selected" && [...selected].some((id) => !state.scenarios.some((s) => s.scenarioId === id));
        if (!exportWriting && !isLoading && !isStale && value.available) {
            const token = draft.token();
            draft.select([reportScope, "authors:" + reportAuthors.join(","), ...value.requests.map((r) => r.scenarioId)]);
            draft.synchronizeTime(viewerTime, dateSelection());
            draft.synchronizeBasis(state, value);
            if (!draft.current(token)) invalidatePreview("The report scope, source or review basis changed. Return to Setup and scan again; unchanged draft choices are kept.");
        }
        for (const kind of ["all", "current", "selected"]) {
            const scope = reportSelection(kind), size = scope.requests.length;
            $("scopeCount-" + kind).textContent = scope.available ? chatCopy.groups(size) : "Count unavailable";
            document.querySelector(`[name=reportScope][value=${kind}]`).checked = reportScope === kind;
        }
        $("scopeSummary").textContent = !state.exportCatalog ? "Report scope is unavailable. Refresh before previewing." : unknownSelected ? "A selected request is no longer available. Choose a fresh selection." : reportScopes.summary(value);
        for (const option of $("reportPromptAuthorFilter").options) option.selected = reportAuthors.includes(option.value);
        $("reportPromptAuthorFilter").disabled = exportWriting;
        document.querySelectorAll("[name=reportScope],[name=promptMode],#formatOptions input,#manualTerms").forEach(control => { control.disabled = exportWriting; });
        setText($("reportPromptAuthorSummary"), `${count(value.requests.length)} of ${count(value.baseRequests.length)} request groups in the base scope included.${value.authorExcludedRequestGroups ? ` ${count(value.authorExcludedRequestGroups)} left out with their calls and scores. The base selection is kept.` : ""}`);
        $("scopeExplanation").textContent = reportEntry && reportScope === "selected"
            ? `GitHub Copilot chat: ${reportEntry.sessionName}. Complete eligible request groups across all retained dates, services and pages, not just the analysis slice. The chosen groups stay fixed until you change selection; new groups are not added automatically.`
            : reportScope === "all"
            ? "Base scope: all available eligible collected evidence, including identifiable preserved snapshots. Browsing filters and private search do not limit it; the report's prompt author choice can narrow it. No new Copilot chats are scanned."
            : "Complete eligible evidence for the matching request groups, not only individual chart actions. Current view includes all matching pages and private search; selected requests may be outside these filters. Known aliases are included once.";
        const reportIds = new Set(value.requests.flatMap(request => request.aliases));
        const currentIds = new Set(currentViewScenarios().map(s => s.scenarioId));
        const hidden = value.requests.filter(request => !request.aliases.some(id => currentIds.has(id))).length;
        $("reportPopulationNote").textContent = value.available && !unknownSelected && value.requests.length
            ? `${count(value.requests.length)} complete request group${value.requests.length === 1 ? "" : "s"} / ${count(value.counts.workIqActions)} Work IQ tool call${value.counts.workIqActions === 1 ? "" : "s"} across all pages.${hidden ? ` Includes ${chatCopy.groups(hidden)} outside the current browsing filters.` : ""} Calls and scores use these groups, not just the visible chart matches. Other evidence units and exclusions are detailed below.`
            : "";
        const matching = results.summarize(selectionRows().filter(row => reportIds.has(row.scenarioId) && currentIds.has(row.scenarioId)));
        $("reportMatchingContext").replaceChildren(resultLine(applied?.layer || "tool", matching, { scope: "Matching view results, not the full report", label: `${count(matching?.count)} matching ${results.unit(applied?.layer || "tool", matching?.count)} in the current view` }));
        $("reportMatchingContext").append(el("p", "context-help-note", `Report counts above include complete eligible request groups; the matching results here do not. Snapshot revision ${count(state.revision)}; frozen only when you prepare a preview.`));
        $("reportMatchingContext").hidden = !value.requests.length;
        const x = state.exportCatalog?.excluded;
        $("scopeExclusions").textContent = x
            ? `Collection exclusions: ${x.syntheticRequestGroups} synthetic request groups; ${x.diagnosticRequestGroups} diagnostic groups; ${x.unknownSourceRequestGroups} groups with unknown source identity; ${x.requestGroupsWithoutEligibleEvidence} alias-only or excluded groups. ${x.duplicateEvidenceRecords} duplicate evidence records, ${x.unidentifiableEvidenceRecords} unidentifiable records and ${x.platformDiagnosticEvidenceRecords} platform diagnostic records are excluded. ${x.excludedOrDuplicateEvidenceRecords} evidence records excluded or deduplicated overall. ${value.excludedRequestedGroups} requested groups have no eligible evidence. These overlapping categories are not additive. Missing projects remain unscoped, not excluded. Hidden calls, missing logs and new chats are not inferred.`
            : "Fresh scope information is required.";
        const inclusion = unknownSelected ? "A selected request is no longer available" : reportScopes.inclusion(value);
        const activity = route.view === "analyze";
        for (const id of ["selectionSummary", "previewSelectionSummary", "activitySelectionSummary"]) setText($(id), inclusion);
        let compactSelection = $("activitySelectionCompact");
        if (!compactSelection) {
            compactSelection = el("p");
            compactSelection.id = "activitySelectionCompact";
            compactSelection.setAttribute("aria-hidden", "true");
            $("activitySelectionSummary").before(compactSelection);
        }
        compactSelection.hidden = !activity || unknownSelected;
        $("activitySelectionSummary").classList.toggle("visually-hidden", activity && !unknownSelected);
        renderSelectionCount(compactSelection, value.requests.length, state.exportCatalog?.requests?.length ?? state.scenarios.length);
        $("activitySelectionScope").textContent = activity || value.requests.length ? ({ all: "All collected activity", current: "Current view", selected: "Selected requests" })[reportScope] : "";
        $("activitySelectionContext").hidden = !activity && !value.baseRequests.length;
        if (route.view === "request") $("pageAction").hidden = !value.baseRequests.length;
        $("activityClearSelection").hidden = !activity && !value.baseRequests.length;
        $("reportSelectionBar").hidden = ["reports", "settings", "collection-status"].includes(route.view)
            || !activity && !value.baseRequests.length && $("contextReturn").hidden;
        document.querySelectorAll("[data-clear-selection]").forEach(control => {
            control.disabled = exportWriting || control.id === "activityClearSelection" && !value.baseRequests.length;
        });
        $("reportClearSelection").hidden = !value.baseRequests.length && !selected.size || ["saved", "unavailable"].includes(reportJourney?.snapshot().phase);
        if (route.view === "reports") {
            $("pageAction").hidden = !value.requests.length;
            $("pageAction").classList.add("quiet");
        } else $("pageAction").classList.remove("quiet");
        $("exportBtn").disabled = isLoading || isStale || !state.exportCatalog || value.available === false || unknownSelected || !value.requests.length || !draft.options().formats.length;
        reportJourney?.update({
            requestCount: value.requests.length, scope: reportScope, authorLabel: authorship.selectionLabel(reportAuthors),
            scopeReady: !isLoading && !isStale && Boolean(state.exportCatalog) && value.available !== false && !unknownSelected,
            scopeIssue: isLoading || isStale ? "Wait for a current activity snapshot." : !value.available || unknownSelected ? $("scopeSummary").textContent : "",
            promptMode: draft.options().promptMode, formats: draft.options().formats,
            timeLabel: time.label(applied?.timeContext || viewerTime), entry: reportEntry,
        });
        updateSessionSelections();
        selectControls?.sync();
        renderStoredRefresh();
        renderReportTask();
    }
    function renderReports() {
        captureReading();
        $("reportTimeContext").textContent = `Report timezone: ${time.label(applied.timeContext)}. Locale: ${applied.timeContext.locale}. Frozen at preview; source event timestamps stay withheld.`;
        const host = $("reportList"), requests = selectedScenarios();
        $("reportRequests").querySelector("summary").textContent = `Included requests and optional labels (${count(requests.length)})`;
        bindDetails($("reportRequests"), "reportRequests", open => {
            host.replaceChildren();
            if (!open) return;
            setText($("reportRequestSearchCount"), `0 of ${count(requests.length)} report requests shown.`);
            if (!requests.length) { host.append(empty("No requests selected", "Select interactions in Analyze or choose a scope above. Your captured evidence and saved reports are still here.")); return; }
            const query = localQuery("reportRequestSearch");
            const matching = requests.filter(scenario => localSearch.matches(query, [scenario.userPrompt?.text, scenario.title, scenario.sourceSessionName, sessionSource(scenario.sourceSessionId)?.name, scenario.project, scenario.sourceSessionId]));
            setText($("reportRequestSearchCount"), `${count(matching.length)} of ${count(requests.length)} report requests shown. All ${count(requests.length)} remain included.`);
            if (!matching.length) { host.append(empty("No report requests match", "Clear this search to show every request in the report. Membership is unchanged.")); return; }
            pagedList(host, matching, { key: "report:" + reportScope + ":" + query, size: 4, noun: "report requests", wrapList: list => {
                list.className = "report-request-page";
                list.tabIndex = 0;
                list.setAttribute("role", "region");
                list.setAttribute("aria-label", "Requests on this report page");
                return list;
            }, renderItem: scenario => {
            detailOwner = "report:" + scenario.scenarioId;
            const row = viewKey(el("article", "report-entry"), detailOwner), text = el("div"), actions = el("div", "actions");
            const requestLink = link("View interaction", "request", { request: scenario.scenarioId }, "request-link text-link");
            const source = sessionSource(scenario.sourceSessionId);
            const identity = el("p", "muted", source ? "GitHub Copilot chat: " : "Source Copilot chat not recorded");
            if (source) identity.append(el("span", "copilot-chat-name", source.name));
            text.append(textAccess.render(scenario.userPrompt, { key: "report:" + scenario.scenarioId, navigationNode: requestLink, originKind: authorship.originKind(scenario) }), projectContext(source || scenario), identity);
            text.append(matchingResults(scenario.scenarioId), el("p", "context-help-note", "Full eligible request in this report:"));
            fullResults(text, scenario.scenarioId, state.exportCatalog.requests.find(r => r.scenarioId === scenario.scenarioId));
            if (reviewLabels[scenario.workflowState]) {
                const review = el("p");
                review.append(metadata.item(reviewLabels[scenario.workflowState], { help: help.reviewStates[scenario.workflowState] }));
                text.append(review);
            }
            if (nextReview[scenario.workflowState]) {
                const control = button(nextReviewLabel[scenario.workflowState], (event) => move(scenario, nextReview[scenario.workflowState], event.currentTarget));
                control.disabled = isStale || isLoading;
                actions.append(ux.tooltip(control, help.actions.review));
                ux.explainDisabled(control, "Wait for a current activity snapshot before changing review labels.");
            } else if (scenario.workflowState === "exported") {
                const control = button("Review again", (event) => move(scenario, "reviewing", event.currentTarget));
                control.disabled = isStale || isLoading;
                actions.append(ux.tooltip(control, help.actions.review));
                ux.explainDisabled(control, "Wait for a current activity snapshot before changing review labels.");
            }
            if (reportScope === "selected") actions.append(ux.tooltip(button("Remove", () => {
                for (const id of state.exportCatalog.requests.find((r) => r.scenarioId === scenario.scenarioId).aliases) selected.delete(id);
                reportEntry = null;
                invalidatePreview(); renderReports(); updateSelection();
            }, "quiet"), help.actions.removeRequest));
            row.append(text, actions);
            return row;
            } });
        });
        $("bundleList").replaceChildren();
        const savedCount = state.exports?.length || 0;
        const reportCount = (state.exports || []).filter(bundle => (bundle.kind ?? "report") === "report").length;
        const comparisonCount = savedCount - reportCount;
        $("bundles").querySelector("summary").textContent = comparisonCount ? `Saved reports and comparisons (${count(savedCount)})` : `Saved reports (${count(savedCount)})`;
        $("savedReportCount").textContent = `${count(reportCount)} report${reportCount === 1 ? "" : "s"}${comparisonCount ? ` / ${count(comparisonCount)} comparison${comparisonCount === 1 ? "" : "s"}` : ""}. Newest prepared first.`;
        $("deleteAllReports").disabled = !reportCount || isLoading || isStale;
        bindDetails($("bundles"), "bundles", open => {
        $("bundleList").replaceChildren();
        if (!open) return;
        setText($("savedReportSearchCount"), "");
        if (!savedCount) { $("bundleList").append(el("p", "", "No local reports have been saved.")); return; }
        const history = el("div");
        const query = localQuery("savedReportSearch");
        const rows = state.exports.map((bundle, index) => {
            let prepared = null;
            try { prepared = Date.parse(time.instant(bundle.preparedAt)); }
            catch (error) { if (!(error instanceof RangeError)) throw error; }
            const date = bundle.preparedAtDisplay?.trim() || time.formatTime(bundle.preparedAt, bundle.timeContext || viewerTime);
            const mode = ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[bundle.promptMode];
            const formats = (bundle.formats || []).map(format => format === "markdown" ? "Markdown" : format.toUpperCase()).join(", ");
            const groups = bundle.selectionScope?.requestGroups;
            const label = [
                bundle.kind === "comparison" ? "Comparison" : "Report",
                date === "Time not recorded" ? "Preparation time unavailable" : `Prepared ${date}`,
                mode, formats,
                Number.isSafeInteger(groups) && groups >= 0 ? `${count(groups)} request group${groups === 1 ? "" : "s"}` : "",
            ].filter(Boolean).join(" / ");
            return { bundle, index, prepared, label, date, mode, formats };
        });
        const labelCounts = new Map();
        for (const { label } of rows) labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
        rows.sort((a, b) => a.prepared === null ? b.prepared === null ? a.index - b.index : 1
            : b.prepared === null ? -1 : b.prepared - a.prepared || b.index - a.index);
        const matching = rows.filter(({ bundle, label }) => localSearch.matches(query, [
            label,
            bundle.bundleId, bundle.preparedAt, bundle.preparedAtDisplay, bundle.promptMode,
            ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[bundle.promptMode],
            ...(bundle.formats || []), ...Object.keys(bundle.files || {}), bundle.timeContext?.timeZone, bundle.timeContext?.locale,
        ]));
        setText($("savedReportSearchCount"), query ? `${count(matching.length)} of ${count(savedCount)} saved ${comparisonCount ? "items" : "reports"} match.` : "");
        if (!matching.length) { $("bundleList").append(empty("No saved reports match", "Try a report ID, date, format or prompt mode, or clear this metadata search.")); return; }
        pagedList(history, matching, { key: "saved-reports:" + query, noun: comparisonCount ? "saved items" : "saved reports", jump: true, renderItem: ({ bundle, label, date, mode, formats }) => {
            detailOwner = "bundle:" + bundle.bundleId;
            const content = el("div", "saved-report-management");
            content.append(el("p", "mono", `Report ID: ${bundle.bundleId}`));
            const outer = el("article", "saved-library-row");
            let openButton;
            if (bundle.kind !== "comparison") {
                if (bundle.files?.["product-report.html"]) openButton = button("Open", event => openSavedReport(bundle, event.currentTarget), "quiet");
                else content.append(el("p", "muted", "HTML was not saved. Read one of the saved downloads below."));
            } else {
                openButton = button("Open", () => reportComparisonUI.open(bundle.bundleId), "quiet");
            }
            if (openButton) {
                openButton.setAttribute("aria-label", bundle.kind === "comparison" ? "Open saved comparison" : "Open saved report");
                viewKey(openButton, "open-bundle:" + bundle.bundleId);
            }
            if (bundle.kind !== "comparison") content.append(button("Compare saved reports", () => reportComparisonUI.open(), "quiet"));
            content.append(button(bundle.kind === "comparison" ? "Delete saved comparison" : "Delete report", event => savedArtifactUI.open({
                artifactKind: bundle.kind === "comparison" ? "comparison" : "report",
                artifactId: bundle.bundleId, label: `${bundle.preparedAtDisplay || time.formatTime(bundle.preparedAt, viewerTime)} / ${bundle.bundleId}`,
            }, event.currentTarget), "danger"));
            if (bundle.timeContext) content.append(el("p", "", `Report timezone: ${time.label(bundle.timeContext)}. Prepared: ${bundle.preparedAtDisplay || time.formatTime(bundle.preparedAt, bundle.timeContext)}. Locale: ${bundle.timeContext.locale}.`));
            const groups = bundle.selectionScope?.requestGroups;
            if (Number.isSafeInteger(groups) && groups >= 0) content.append(el("p", "", `${count(groups)} request group${groups === 1 ? "" : "s"}`));
            const downloads = el("div", "saved-report-downloads");
            for (const name of Object.keys(bundle.files || {})) {
                const control = button("Download " + name, async () => {
                    control.disabled = true;
                    try {
                        await downloadReportFile(bundle, name);
                    } catch (error) { announce(error.message, "error"); }
                    finally { control.disabled = false; }
                });
                control.prepend(ux.icon("download"));
                control.classList.add("icon-action");
                downloads.append(ux.tooltip(control, help.actions.download));
            }
            content.append(downloads);
            const row = el("details", "detail-disclosure saved-report");
            const summary = el("summary", "saved-report-summary"), identity = el("span", "saved-report-identity");
            identity.append(el("span", "saved-report-name", bundle.kind === "comparison" ? "Comparison" : "Report"),
                el("span", "", date === "Time not recorded" ? "Preparation time unavailable" : `Prepared ${date}`));
            if (labelCounts.get(label) > 1) identity.append(el("span", "saved-report-disambiguation", bundle.bundleId));
            const metadata = el("span", "saved-report-metadata");
            metadata.append(el("span", "", mode || "Prompt mode not recorded"), el("span", "", formats || "Formats not recorded"));
            summary.append(identity, metadata, el("span", "saved-report-manage", "Manage"));
            row.append(summary, content);
            outer.append(bindDetails(row, detailOwner));
            if (openButton) outer.append(openButton);
            else outer.append(el("span", "saved-report-no-html", "No HTML"));
            return outer;
        } });
        $("bundleList").append(history);
        }, true);
        updateSelection();
    }
    async function openSavedReport(bundle, trigger) {
        ux.hideTooltip();
        savedReportView?.dialog.close();
        const dialog = el("dialog", "assessment-dialog saved-report-dialog");
        dialog.setAttribute("aria-label", "Saved report");
        const header = el("div", "dialog-head"), close = button("Close saved report", () => dialog.close(), "quiet");
        header.append(el("h2", "", "Saved report"), close);
        const body = el("div", "assessment-dialog-body");
        body.append(el("p", "", "Reading the frozen saved HTML. Nothing is regenerated."));
        dialog.append(header, body); document.body.append(dialog);
        const current = { dialog, body, bundleId: bundle.bundleId, manifestHash: bundle.manifestHash, invalid: false };
        savedReportView = current;
        const leave = () => dialog.close();
        window.addEventListener("hashchange", leave);
        dialog.addEventListener("close", () => {
            window.removeEventListener("hashchange", leave);
            if (savedReportView === current) savedReportView = null;
            dialog.remove();
            if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger);
        }, { once: true });
        dialog.showModal(); close.focus();
        try {
            const result = await api("/api/report/open", { bundleId: bundle.bundleId });
            if (!dialog.open || savedReportView !== current || current.invalid) return;
            if (result.artifact?.bundleId !== bundle.bundleId || typeof result.html !== "string"
                || !state.exports?.some(entry => entry.bundleId === bundle.bundleId)) throw new Error("This saved report is no longer available.");
            const mode = ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[result.artifact.promptMode] ?? "Prompt mode not recorded";
            body.replaceChildren(el("p", "", `Prepared ${result.artifact.preparedAtDisplay || time.formatTime(result.artifact.preparedAt, viewerTime)} / ${mode}`),
                el("p", "mono", `Report ID: ${bundle.bundleId}`),
                el("p", "muted", "Frozen saved copy. Today's activity, scores and report choices do not change it. Section links work here; use the saved download buttons outside this reader for companion files."));
            const frame = el("iframe", "report-frame");
            frame.title = "Frozen saved report";
            frame.setAttribute("sandbox", "");
            frame.setAttribute("referrerpolicy", "no-referrer");
            // Parse in an inert template: opening frozen bytes must not load or navigate to companion content.
            const template = document.createElement("template");
            template.innerHTML = result.html;
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
            const root = document.createElement("html"), rootTemplate = document.createElement("template");
            const prefix = result.html.match(/^\s*(?:<!doctype html>\s*)?<html\b([^>]*)>/i);
            if (prefix) {
                rootTemplate.innerHTML = "<div" + prefix[1] + "></div>";
                for (const attribute of ["lang", "data-evidence-theme"]) {
                    const value = rootTemplate.content.firstElementChild?.getAttribute(attribute);
                    if (value !== null && value !== undefined) root.setAttribute(attribute, value);
                }
            }
            const isolation = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; font-src data:; base-uri &#39;none&#39;; form-action &#39;none&#39;">';
            frame.srcdoc = "<!doctype html>" + root.outerHTML.replace("</html>", () => isolation + template.innerHTML + "</html>");
            body.append(frame);
        } catch (error) {
            if (dialog.open && savedReportView === current && !current.invalid) body.replaceChildren(el("p", "error", error.message));
        }
    }
    async function downloadReportFile(bundle, name, isCurrent = () => true) {
        const result = await api("/api/report-file", { bundleId: bundle.bundleId, name });
        if (!isCurrent() || !state.exports?.some(entry => entry.bundleId === bundle.bundleId)) throw new Error("This saved report is no longer available. No download was started.");
        const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        const anchor = el("a");
        anchor.href = url; anchor.download = name;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function move(scenario, toState, control) {
        if (isStale || isLoading) { announce("Wait for the activity snapshot to finish updating before changing review state.", "stale"); return; }
        control.disabled = true;
        try {
            await api("/api/move", { scenarioId: scenario.scenarioId, toState });
            if (await load()) announce("Review state updated. Recorded results are unchanged.");
        } catch (error) { announce(error.message, "error"); control.disabled = false; }
    }
    let coverageDetailsKey;
    function renderCoverage() {
        detailOwner = "coverage";
        const body = $("coverageBody"), coverage = state.coverage || {};
        const c = analytics.coverage, http = applied.layer === "http";
        const sources = http ? `${count(c.sessionCount)} recorder source${c.sessionCount === 1 ? "" : "s"}` : chatCopy.count(c.sessionCount);
        const unscoped = c.unscopedSessionCount
            ? ` ${count(c.unscopedSessionCount)} ${http ? "source" : "chat"}${c.unscopedSessionCount === 1 ? " has" : "s have"} no project.` : "";
        body.replaceChildren(
            el("p", "coverage-meaning", "A request group links actions to a recorded Copilot message, which may be automated. Follow-ups with calls form separate groups; missing origins stay unverified."),
            el("p", "coverage-counts", `${scopeLabels[applied.filters.scope] || "Selected collection"}: ${count(c.scenarioCount)} ${http ? "record" : "request"} group${c.scenarioCount === 1 ? "" : "s"} from ${sources} in ${count(c.projectCount)} project${c.projectCount === 1 ? "" : "s"}.${unscoped}`),
            el("p", "coverage-scope", "Counts include only matching records. The date filter selects saved evidence, not the history to collect."),
        );
        if (route.view === "analyze") body.append(el("p", "activity-list-explanation",
            "Matching counts cover all pages and follow the current filters and private search. Interactions open directly; Chat in More filters is optional context. Insights include each matching group's full retained interaction, so their scope can be wider than the matching calls. Chats without matching evidence remain available through Chat and Collection status."));
        if (c.unknownSessionRows) body.append(el("p", "coverage-warning", `${count(c.unknownSessionRows)} matching records have no known source chat; they are not included in the chat count.`));
        if (!coverage.graphHistory && ["direct-request", "recorded-http", "code-reference"].includes(applied.layer)) {
            body.append(el("p", "coverage-warning", "Direct Graph history has not been scanned in this collection. Coverage is unknown, not zero."));
        }
        renderCoverageDetails();
    }
    function renderCoverageDetails() {
        if (!state || !analytics || !applied) return;
        const host = $("collectionEvidenceDetails"), coverage = state.coverage || {}, c = analytics.coverage;
        const key = JSON.stringify([state.revision, applied, c.firstAt, c.lastAt, coverage, analytics.warnings, collectionReadError, collection?.config?.approved, collection?.config?.windowDays]);
        if (key === coverageDetailsKey) return;
        coverageDetailsKey = key;
        const range = (from, to) => from && to ? `${date(from, true)} to ${date(to, true)}` : null;
        const selectedDates = applied.filters.from || applied.filters.to
            ? `${applied.filters.from ? date(applied.filters.from, true) : "Earliest saved date"} to ${applied.filters.to ? date(applied.filters.to, true) : "Latest saved date"}`
            : "All retained dates";
        host.replaceChildren(el("h3", "", "Evidence scope"), facts([
            ["Collection shown", scopeLabels[applied.filters.scope]],
            ["Selected date filter", selectedDates],
            ["Dated records in this view", range(c.firstAt, c.lastAt) || "No dated matching records"],
            ["Approved collection window", collectionReadError ? "Current approval unavailable" : collection?.config?.approved ? `${count(collection.config.windowDays)} days of local history` : "No approved collection window"],
            ["Collection window at this snapshot", range(coverage.since, coverage.until) || "Not recorded"],
            ["Snapshot coverage checked", coverage.checkedAt ? timestamp(coverage.checkedAt) : "Not recorded"],
            ["Snapshot revision", state.revision],
        ], { inlineHelp: false }),
        el("p", "", "The date filter selects saved records. Their first and last dates do not prove continuous coverage. The approved window controls which history is read; saved evidence may be older. The coverage check is when sources were checked, not when the work happened."),
        el("p", "", "Current activity uses app-listed Copilot chats with verified local history locations. Preserved earlier snapshots and owned HTTP captures are separate."));
        const graph = coverage.graphHistory;
        if (graph) {
            const retainedScans = graph.sourceCountBasis === "retained-scan-history";
            const scanCount = value => Number.isFinite(value) ? count(value) : "Not recorded";
            host.append(el("h3", "", "Collection Graph scan"), facts([
                [retainedScans ? "Listed sources read at least once" : "Sources with a recorded scan", scanCount(graph.counts?.sourcesScanned)],
                [retainedScans ? "Sources currently eligible for collection" : "Sources requested for scanning", scanCount(graph.counts?.sourcesRequested)],
                ["Recorded request sites", scanCount(graph.counts?.requestedDirectSites)],
                ["Sites with a recorded HTTP status", scanCount(graph.counts?.outputVisibleStatuses)],
                ["Code references (not executions)", scanCount(graph.counts?.codeReferences)],
                ["Synthetic references excluded", scanCount(graph.counts?.syntheticReferences)],
            ], { inlineHelp: false }), el("p", "", retainedScans
                ? "Read-at-least-once includes listed sources that are no longer eligible. Eligible sources may not have been read yet. These are separate counts, not a completion fraction or a count of chats containing Graph activity."
                : "Scan counts describe sources inspected or requested, not chats containing Graph activity. They are shown separately; no completion percentage is inferred."));
        } else host.append(el("p", "", "Direct Graph history has not been scanned in this collection. Coverage is unknown, not zero."));
        host.append(el("h3", "", "What the records show"),
            el("p", "", "Work IQ calls and API metadata returned by a tool are separate from direct Graph request sites recorded in local chats. A tool name or service category does not prove a Graph request or HTTP status."),
            el("p", "", "Recorded HTTP statuses are a subset of Graph request sites, not extra requests. Owned HTTP captures are separate opt-in public metadata tests. Code references do not show that code ran. Do not add these overlapping layers."));
        // Keep source notes verbatim, including future limitations this UI does not yet classify.
        const notes = [...new Set([
            ...(analytics.warnings || []).filter(warning => warning.code !== "tool-not-http").map(warning => warning.message),
            ...(coverage.notes || []),
        ])];
        if (notes.length) {
            const list = el("div", "collection-evidence-notes");
            host.append(el("h3", "", "Scan notes and exclusions"), list);
            pagedList(list, notes, { key: "coverage-notes", noun: "scan notes", listTag: "ul", listClass: "evidence-notes", renderItem: note => el("li", "", note) });
        }
    }
    function render() {
        if (!state || !analytics) return;
        slice = analysisSlice(state, applied, search, route.withinServices?.split(",") || []);
        analytics = slice.analytics;
        renderTimeContext();
        renderControls(); renderNavigation(); renderFilterChips(); renderViewingContext(); renderSessionAnalysis(); renderPeriodFeedback();
        detailOwner = route.view;
        if (route.view === "analyze") {
            renderHome();
            renderActivity();
        }
        renderCurrentViewInsights();
        if (route.view === "request") renderRequest();
        if (route.view === "reports") renderReports();
        if (route.view === "settings" && route.section === "privacy") assessmentUI.setup($("assessmentSetup"));
        renderCoverage();
        updateSelection();
        periodComparisonUI.update();
    }

    function setText(node, text) {
        if (node.textContent !== text) node.textContent = text;
    }
    function freshness(value) {
        if (!value || !Number.isFinite(Date.parse(value))) return "not yet";
        const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
        return minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago`
            : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
    }
    function renderIssueZeroState(detail, rows, query) {
        const coverage = detail?.historyCoverage;
        const unavailable = coverage?.unavailable ?? detail?.sourceErrors ?? 0, limited = coverage?.limited ?? 0;
        const compact = Array.isArray(rows) && rows.length === 0 && !unavailable && !limited && !query.trim();
        const checked = coverage && detail?.lastCheckedAt && detail?.discovery;
        setText($("collectionIssueLabel"), unavailable || limited ? `${count(unavailable + limited)} ${unavailable + limited === 1 ? "chat" : "chats"} with history gaps`
            : !checked ? "History not checked"
            : collectionReadError || collection?.error || ["error", "disconnected", "stopped"].includes(collection?.state) ? "Current history coverage unavailable"
            : !coverage.eligible ? "No eligible chats to check"
            : coverage.pending ? "History is still importing"
            : detail.state === "collecting" ? "Checking for history gaps"
            : detail.state === "paused" ? "No history gaps reported at last check" : "No history gaps reported");
        const search = $("issueSearch").closest(".scoped-search");
        if (compact && (search.contains(document.activeElement) || $("collectionIssueGroups").contains(document.activeElement))) ux.restoreFocus($("collectionIssuesTitle"));
        for (const node of [$("collectionIssueCounts"), search,
            $("collectionIssueGroups"), $("collectionIssuesBody").querySelector(":scope>.settings-help")]) node.hidden = compact;
        return compact;
    }
    function renderCollectionIssues(status) {
        const rows = status.historyIssues;
        if (!Array.isArray(rows) || route.view !== "collection-status") return;
        issueRows = rows;
        const query = localQuery("issueSearch");
        const detail = status.historyCoverage !== undefined ? status : issuesStatus ?? collection;
        const compact = renderIssueZeroState(detail, rows, query);
        const signature = JSON.stringify([query, compact, Boolean(detail?.historyCoverage), rows.map(({ lastAttemptAt, ...row }) => row)]);
        for (const row of rows) issueAttempts.set(row.sessionId, row.lastAttemptAt);
        if (signature !== issuesSignature) {
            const reading = captureReading();
            const focusedSource = document.activeElement?.closest(".history-issue")?.dataset.disclosureKey?.slice("history-issue:".length);
            const ordered = presentation.ordered("history-issues", rows, row => row.sessionId).filter(row => localSearch.matches(query, historyStatus.searchTerms(row)));
            setText($("issueSearchCount"), `${count(ordered.length)} of ${count(rows.length)} ${rows.length === 1 ? "chat" : "chats"}`);
            $("issueSearchCount").hidden = !query.trim();
            issuesSignature = signature;
            const host = $("collectionIssueGroups");
            host.replaceChildren();
            for (const [reason, copy] of Object.entries(historyStatus.reasons)) {
                const members = ordered.filter(row => row.reasons[0] === reason);
                if (!members.length) continue;
                const focusedIndex = members.findIndex(row => row.sessionId === focusedSource);
                if (focusedIndex >= 0) presentation.setPage(`history-issues:${reason}:${query}`, Math.floor(focusedIndex / 6));
                const list = el("div"), content = el("div", "history-reason-body");
                content.append(el("p", "", copy.explanation), el("p", "muted", copy.guidance), list);
                const group = disclosure(`${historyStatus.reasonTitles[reason]} (${count(members.length)})`, content, "history-reason");
                bindDetails(group, `history-reason:${reason}:${query}`, open => {
                    if (!open) { list.replaceChildren(); return; }
                    pagedList(list, members, { key: `history-issues:${reason}:${query}`, noun: members.length === 1 ? "affected Copilot chat" : "affected Copilot chats", renderItem: row => {
                        const detail = el("details", "history-issue"), title = el("summary"), identity = el("span", "history-issue-identity");
                        identity.append(el("span", "history-issue-name copilot-chat-name", row.name), el("span", "muted", row.projectId ? `Copilot project: ${row.project || "Name unavailable"}` : "Copilot chat without a project"));
                        title.append(identity);
                        detail.append(title);
                        bindDetails(detail, `history-issue:${row.sessionId}`, expanded => {
                            detail.querySelector(".history-issue-detail")?.remove();
                            if (!expanded) return;
                            const body = el("div", "history-issue-detail");
                            const attempt = el("p", "muted");
                            attempt.dataset.historyAttempt = row.sessionId;
                            attempt.textContent = `Last attempted: ${issueAttempts.get(row.sessionId) ? timestamp(issueAttempts.get(row.sessionId)) : "Not recorded"}`;
                            body.append(el("p", "", row.unavailable ? "History unavailable" : "Limited history"), attempt, el("p", "", row.hasPriorEvidence
                                ? "Previously collected evidence for this Copilot chat is kept."
                                : "No evidence has been collected for this Copilot chat."));
                            body.append(routeLink("Open chat activity", sessionRoute(row.sessionId), "text-link history-chat-link"));
                            for (const secondary of row.reasons.slice(1)) {
                                const copy = historyStatus.reasons[secondary];
                                body.append(el("p", "", copy.label + ". " + copy.explanation + " " + copy.guidance));
                            }
                            const technical = disclosure("Technical details", facts([["Copilot chat identifier", row.sessionId], ["Technical code", row.reasons.join(", ")]], { inlineHelp: false }));
                            bindDetails(technical, `history-technical:${row.sessionId}`);
                            body.append(technical);
                            detail.append(body);
                        });
                        return detail;
                    } });
                }, Boolean(query.trim()));
                host.append(group);
            }
            if (!rows.length && !compact) host.append(el("p", "", "There are no reported chats to search. Clear this search to see history coverage."));
            else if (rows.length && !ordered.length) host.append(el("p", "", "No affected Copilot chats match. Try a chat, project or known issue reason, or clear this search."));
            restoreReading(reading);
        }
        for (const node of document.querySelectorAll("[data-history-attempt]")) {
            const attempt = issueAttempts.get(node.dataset.historyAttempt);
            setText(node, `Last attempted: ${attempt ? timestamp(attempt) : "Not recorded"}`);
        }
    }
    async function refreshCollectionIssues() {
        if (route.view !== "collection-status" || issuesLoading) return;
        issuesLoading = true;
        const readGeneration = collectionReadGeneration;
        const message = $("collectionIssuesMessage");
        if (issuesSignature === undefined) { setText(message, "Reading current local history issues..."); message.hidden = false; ux.pending(message, true); }
        try {
            const detailed = await api("/api/collection/status", { details: true });
            if (readGeneration !== collectionReadGeneration || collectionBusy) return;
            if (!Array.isArray(detailed.historyIssues)) throw new Error("Affected Copilot chats are unavailable. Collection status still shows the last known counts.");
            renderCollection(detailed);
            message.hidden = true;
        } catch (error) {
            if (readGeneration !== collectionReadGeneration || collectionBusy) return;
            setText(message, "Current issue details could not be loaded. Any displayed list is from the previous check. " + error.message);
            message.hidden = false;
        } finally { issuesLoading = false; ux.pending(message, false); }
    }
    function renderCollectionNotice() {
        const hasEvidence = Boolean(state?.scenarios.length);
        const notice = historyStatus.entry(collection, { hasEvidence, unavailable: Boolean(collectionReadError), reason: collectionReadReason });
        const setupHandled = route.view === "analyze" && !collection?.config?.approved && !collection?.error && notice?.severity === "normal";
        const host = $("collectionNotice");
        host.hidden = ["settings", "collection-status"].includes(route.view) || !notice || setupHandled && !hasEvidence
            || !$("message").hidden && $("message").dataset.connectionFailure === "true";
        const retryHost = route.view === "collection-status" ? $("collectionStatus").parentElement : host;
        if ($("collectionRetry").parentElement !== retryHost) retryHost.append($("collectionRetry"));
        $("collectionRetry").hidden = !collectionReadError;
        $("collectionRetry").disabled = isLoading;
        if (!notice) return;
        host.dataset.severity = notice.severity;
        setText($("collectionNoticeText"), setupHandled ? "Retained evidence is still available." : notice.text);
        $("collectionNoticeAction").hidden = setupHandled;
        setText($("collectionNoticeAction"), notice.action);
        $("collectionNoticeAction").href = notice.issues ? "#collection-status?setting=issues"
            : notice.severity === "error" || notice.action === "View collection details" ? "#collection-status" : "#settings?section=connection";
    }
    function collectionUnavailable(error, reason = "") {
        collectionReadError = error;
        collectionReadReason = reason;
        if (reason === "runtime_unavailable") {
            connectionNeedsSnapshot = true;
            isStale = Boolean(analytics);
            updateSelection();
        }
        setText($("collectionStatus"), "Collection status unavailable");
        $("collectionStatus").dataset.severity = "error";
        setText($("collectionStatusGuidance"), "Retry the connection to read current status. Any coverage below is from the last accepted check. Previously collected evidence is kept.");
        $("collectionStatusAction").hidden = true;
        $("collectionSourceLink").hidden = false;
        setText($("settingsDiagnosticError"), error);
        $("settingsDiagnosticError").hidden = false;
        renderCoverageDetails();
        renderCollectionNotice();
        if (collection) renderIssueZeroState(issuesStatus ?? collection, issueRows, localQuery("issueSearch"));
        renderFreshActivity();
    }
    function renderFreshActivity() {
        const host = $("freshActivity"), model = fresh.snapshot(), approved = collection?.config?.approved;
        host.hidden = false;
        host.dataset.phase = model.phase;
        host.dataset.checkId = model.check?.id || "";
        host.dataset.revision = model.check ? String(model.check.revision) : "";
        const control = $("checkActivity");
        const text = "Refresh";
        if (control.lastChild?.nodeType === Node.TEXT_NODE) control.lastChild.textContent = text;
        ux.pending(control, ["checking", "applying"].includes(model.phase));
        $("freshSourceSetup").hidden = Boolean(approved);
        setText($("freshScope"), approved
            ? `Local Copilot history · ${collection.config.windowDays}-day window`
            : "Choose which local Copilot history this app can read.");
        const completed = ["complete", "partial"].includes(model.phase) && Boolean(model.check);
        setText($("freshChecked"), completed ? `Manual check ${timestamp(model.check.completedAt)}` : "");
        $("freshChecked").hidden = !completed;
        setText($("freshStatus"), model.message || (approved ? "Refresh recorded activity." : "Refresh reads stored activity only. Approve a source separately to check history."));
        ux.pending($("freshStatus"), ["checking", "applying"].includes(model.phase));
        $("freshStatus").hidden = approved && model.phase === "idle";
        setText($("freshContextMessage"), [model.context, model.sourceWarning].filter(Boolean).join(" "));
        $("freshContextMessage").hidden = !model.context && !model.sourceWarning;
        setText($("freshCheckDetails"), model.details);
        $("freshCheckDetails").hidden = !model.details;
        setText($("freshCoverageAnnouncement"), model.coverage);
        $("freshStatus").dataset.severity = model.phase === "error" ? "error" : model.phase === "partial" ? "warning" : "normal";
        $("freshIssues").hidden = !["partial", "error", "unconfirmed"].includes(model.phase);
        $("freshIssues").href = model.phase === "partial" ? "#collection-status?setting=issues" : "#collection-status";
        setText($("freshIssues"), model.phase === "partial" ? model.coverage : "Review collection status");
        $("freshResult").hidden = $("freshStatus").hidden && !model.context && !model.sourceWarning && !completed && !collectionReadError && !isStale;
        const gapDetails = $("freshCoverageDetails");
        gapDetails.hidden = model.phase !== "partial";
        if (!gapDetails.hidden && gapDetails.dataset.checkId !== model.check.id) {
            gapDetails.dataset.checkId = model.check.id;
            const groups = Object.entries(model.check.coverage?.groups ?? {}).filter(([, total]) => total > 0);
            const reasons = el("dl", "fresh-reasons");
            for (const [code, total] of groups) {
                const reason = historyStatus.reasons[code];
                const row = el("div");
                row.append(el("dt", "", `${chatCopy.count(total)}: ${reason?.label ?? "History reason unavailable"}`),
                    el("dd", "", historyStatus.checkSummaries[code] ?? "No supported reason was retained. Review current collection status; the earlier cause cannot be reconstructed here."));
                reasons.append(row);
            }
            const current = el("a", "button-link", "View current history issues");
            current.href = "#collection-status?setting=issues"; current.dataset.settingsLink = "";
            gapDetails.replaceChildren(el("p", "", "Primary reasons from this manual check. Each affected chat is grouped once; other limits and pending counts may overlap."),
                ...(groups.length ? [reasons] : [el("p", "", "No per-reason breakdown was retained for this check.")]),
                el("p", "", "Previously collected evidence stays. Current issue details may differ after a later check."), current);
        }
        renderStoredRefresh();
    }
    function clearSourceCheckMarker() {
        try {
            sessionStorage.removeItem(sourceCheckKey);
            if (sessionStorage.getItem(sourceCheckKey) !== null) throw new Error("Pending marker remains.");
        } catch {
            fresh.blockSource("This tab could not clear its source-check recovery marker. Source refresh stays read-only.");
        }
    }
    async function checkActivity(event) {
        renderFreshActivity();
        if ($("checkActivity").disabled) return null;
        if (fresh.snapshot().sourceUnknown || fresh.snapshot().sourceBlocked || fresh.snapshot().phase === "error" || collectionReadError || isStale) return refreshStoredData(event);
        const initiatingControl = document.activeElement;
        const checkSource = collection?.config?.approved === true;
        const token = fresh.begin({ checkSource });
        if (token === null) return null;
        collectionBusy = true;
        collectionReadGeneration++;
        clearTimeout(pollTimer);
        collectionSettings?.setChecking(true);
        renderFreshActivity();
        try {
            if (!checkSource) return await load({ background: true });
            try {
                sessionStorage.setItem(sourceCheckKey, "pending");
                if (sessionStorage.getItem(sourceCheckKey) !== "pending") throw new Error("Pending marker was not saved.");
            } catch {
                fresh.blockSource("This tab cannot preserve source-check recovery state. No source check was sent; Refresh and Retry remain read-only.");
                return false;
            }
            const result = await api("/api/collection/now", {});
            if (!fresh.collected(token, result.check)) return false;
            clearSourceCheckMarker();
            renderCollection(result);
            renderFreshActivity();
            if ($("overlay").open || reportJourney?.isReviewOpen() || collectionSettings?.hasDraft()) {
                fresh.defer();
                $("newDataNotice").hidden = false;
            } else await load({ background: true });
            return { ...result, checkMessage: fresh.snapshot().message };
        } catch (error) {
            fresh.fail(token, error.message, { rejected: error.code === "request_rejected" });
            if (error.code === "request_rejected") clearSourceCheckMarker();
            return false;
        } finally {
            collectionBusy = false;
            collectionSettings?.setChecking(false);
            renderFreshActivity();
            if (initiatingControl === $("checkActivity") && document.activeElement === document.body) ux.restoreFocus(initiatingControl);
            clearTimeout(pollTimer);
            pollTimer = setTimeout(pollCollection, 5000);
        }
    }
    function renderCollection(status) {
        if (collection && status.configVersion !== undefined && collection.configVersion !== undefined && status.configVersion !== collection.configVersion) {
            invalidatePreview();
            invalidateDialog("Collection settings changed. Prepare a fresh report preview; source approval is not disclosure review.");
            issuesStatus = undefined; issueRows = undefined; issuesSignature = undefined;
            $("collectionIssueGroups").replaceChildren();
            setText($("issueSearchCount"), "Reading current issues...");
        }
        collection = status;
        collectionReadError = "";
        collectionReadReason = "";
        if (Array.isArray(status.historyIssues)) issuesStatus = status;
        // Keep counts, source coverage and rows on the same detailed response while it is visible.
        const detail = route.view === "collection-status" && issuesStatus ? issuesStatus : status;
        const c = detail.historyCoverage, view = historyStatus.page({ ...status, historyCoverage: c });
        setText($("collectionStatus"), view.label);
        $("collectionStatus").dataset.severity = view.severity || "normal";
        setText($("collectionStatusGuidance"), view.guidance);
        const statusAction = $("collectionStatusAction");
        statusAction.hidden = !view.action;
        if (view.action) { setText(statusAction, view.action.label); statusAction.href = view.action.href; }
        $("collectionSourceLink").hidden = view.action?.href === "#settings?section=connection&setting=source";
        setText($("collectionChecked"), status.lastCheckedAt ? `Last checked ${freshness(status.lastCheckedAt)}` : "Not checked yet");
        setText($("collectionNewActivity"), status.lastNewDataAt ? `Last new evidence ${freshness(status.lastNewDataAt)}` : "No new evidence collected yet");
        $("collectionChecked").title = `Last local check: ${timestamp(status.lastCheckedAt)}`;
        $("collectionNewActivity").title = `Last newly collected activity: ${timestamp(status.lastNewDataAt)}`;
        setText($("settingsDiagnosticError"), status.error || status.lastCheckWarning || "");
        $("settingsDiagnosticError").hidden = !status.error && !status.lastCheckWarning;
        const unavailable = c?.unavailable ?? detail.sourceErrors ?? 0, limited = c?.limited ?? 0;
        $("collectionIssues").dataset.severity = c?.eligible > 0 && unavailable === c.eligible ? "error" : "normal";
        setText($("collectionIssueCounts"), c ? `${count(unavailable)} unavailable · ${count(limited)} limited` : "");
        setText($("collectionIssueImpact"), unavailable || limited ? "Missing activity may be absent from reports. Previously collected evidence is kept. Open a reason for affected chats and guidance." : "");
        $("collectionIssueImpact").hidden = !unavailable && !limited;
        renderIssueZeroState(detail, detail.historyIssues, localQuery("issueSearch"));
        setText($("collectionExactCheck"), timestamp(status.lastCheckedAt));
        setText($("collectionExactNew"), timestamp(status.lastNewDataAt));
        setText($("collectionExactTimes"), status.config
            ? `Read new history every ${count(status.cadence?.pollSeconds)} seconds; discover chats every ${count(status.cadence?.reconciliationSeconds ?? 30)} seconds; refresh this view every ${count(status.cadence?.browserPollSeconds ?? 5)} seconds.`
            : "Not configured.");
        setText($("collectionCoverageCounts"), c && status.lastCheckedAt
            ? `${status.error || ["error", "stopped", "disconnected"].includes(status.state) ? "Last known coverage: " : ""}${count(c.readable)} of ${count(c.eligible)} eligible chats have readable history.`
            : "History coverage is not available until a check completes.");
        setText($("collectionCoveragePending"), c?.pending
            ? `${count(c.pending)} ${c.pending === 1 ? "chat is" : "chats are"} awaiting or still importing history; some may already be readable.` : "");
        $("collectionCoveragePending").hidden = !c?.pending;
        collectionSettings.receive(status);
        renderSettingsSearch();
        renderCollectionNotice();
        const m = detail.metrics, inventory = detail.discovery?.counts, diagnostics = $("collectionDiagnostics");
        diagnostics.replaceChildren();
        if (inventory && c) {
            diagnostics.append(el("h3", "", "Source inventory"), facts([
                ["Copilot chats listed by the source", count(inventory.sessions)],
                ["Chats with a verified local history location", count(c.eligible)],
                ["Chats read at least once", count(c.readable)],
                ["Chats awaiting or still importing history", count(c.pending)],
            ], { inlineHelp: false }), el("p", "", "A verified location is not a successful read. A chat being imported may already have readable entries."));
            const excluded = Object.entries(c.excluded || {}).map(([name, total]) => [historyStatus.dispositions[name] || `Unclassified exclusion (technical code: ${name})`, count(total)]);
            diagnostics.append(el("h3", "", "Not included in local collection"), facts(excluded, { inlineHelp: false }),
                el("p", "", "Archived chats, chats hosted elsewhere and unverified source links are exclusions, not failed reads."),
                facts([["Chats beyond the source-list limit", count(inventory.skippedByLimit)], ["Workspace records without a listed chat", count(inventory.unmappedWorkspaces)]], { inlineHelp: false }));
        }
        if (m) diagnostics.append(el("h3", "", "Reading limits"), facts([
            ["Chats with older history beyond the file read limit", count(m.truncatedSources)],
            ["Entries skipped above the 1 MiB size limit", count(m.oversizedLines)],
            ["Entries skipped because their format was invalid", count(m.malformedLines)],
            ["Older context records dropped from working memory", count(m.contextEvictions)],
            ["Credential-related exclusions", count(m.credentialExclusions)],
            ["Chats waiting for an unfinished entry", count(m.partialSources)],
            ["History data read in the last check (bytes)", count(m.lastBytesRead)],
            ["Time spent in the last check (milliseconds)", count(m.lastDurationMs)],
        ], { inlineHelp: false }));
        diagnostics.append(el("p", "", "The initial read covers at most the last 64 MiB per history file within the selected history window. Older saved activity outside that window is not newly collected; previously collected evidence stays."),
            el("p", "", "Each check reads at most 32 MiB in 4 MiB portions. Pending history needs further checks; an unfinished entry is read after Copilot finishes saving it."),
            el("p", "", "Working context is limited to 2,000 records and 512 KiB, so links to later actions can be incomplete. Credential-related exclusions protect sensitive content and are not tool failures."),
            el("p", "", "Closing this panel does not stop collection. Pausing does not erase evidence. Remote-only history and Work IQ's internal network requests are not visible to this local collector."));
        renderCoverageDetails();
        renderCollectionIssues(status);
        renderFreshActivity();
    }
    async function pollCollection() {
        if (pageInactive || document.hidden || !state?.collection) return;
        const readGeneration = collectionReadGeneration;
        try {
            if (collectionBusy) return;
            if (!ensureCurrentTime()) return;
            const status = await api("/api/collection/status", {});
            if (readGeneration !== collectionReadGeneration || collectionBusy) return;
            assessmentUI.observe(status.assessment);
            periodComparisonUI.observe(status.assessment);
            automaticUI.observe();
            if (status.assessment?.pendingCleanup) {
                if (status.assessment.kind === "artifact-deletion") {
                    artifactRefreshRequired = true;
                    savedArtifactUI?.invalidate();
                    reportComparisonUI?.pendingArtifactCleanup();
                    announce("Saved-object cleanup is pending. This does not delete collected activity or its insights.", "stale");
                    return;
                }
                isStale = true;
                invalidatePreview();
                invalidateDialog("Local evidence cleanup is pending. Prepare a fresh report after cleanup.");
                announce("Local evidence cleanup is pending. Private responses and dependent insights are unavailable.", "stale");
                updateSelection();
                return;
            }
            if (artifactRefreshRequired || (status.artifactRevision ?? 0) !== (state.artifactRevision ?? 0)) {
                savedArtifactUI?.invalidate();
                if (await load({ background: true })) artifactRefreshRequired = false;
                return;
            }
            if ((status.deletionVersion ?? 0) !== (state.deletionVersion ?? 0)) {
                clearDeletedDraft();
                await load({ background: true });
                return;
            }
            renderCollection(status);
            await refreshCollectionIssues();
            const action = live.observe(status.revision, state?.revision, {
                reviewing: $("overlay").open || deletionUI.isOpen() || recollectionUI.isOpen() || reportJourney?.isReviewOpen(), loading: isLoading || collectionBusy || fresh.snapshot().phase === "error",
                editing: collectionSettings.hasDraft() || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) || Boolean(document.querySelector(".select-popup:not([hidden])")),
            });
            setText($("newDataNotice"), fresh.snapshot().phase === "error" ? "Stored evidence has changed. Retry the stored read; the earlier source check is not repeated."
                : collectionSettings.hasDraft() ? "New evidence is available. Your unsaved Settings changes are kept; save or cancel them to update automatically." : "New data is available. Your report preview stays frozen; close it to update the activity view.");
            $("newDataNotice").hidden = action !== "defer" || status.revision === state?.revision;
            const canApply = !isLoading && !$("overlay").open && !deletionUI.isOpen() && !recollectionUI.isOpen() && !reportJourney?.isReviewOpen() && !collectionSettings.hasDraft()
                && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && !document.querySelector(".select-popup:not([hidden])");
            if ((action === "refresh" || (connectionNeedsSnapshot || ["applying", "waiting"].includes(fresh.snapshot().phase)) && canApply) && state) await load({ background: true });
        } catch (error) {
            if (readGeneration !== collectionReadGeneration || collectionBusy) return;
            assessmentUI.clearPrivateText();
            collectionUnavailable(error.message, error.reason);
        } finally {
            clearTimeout(pollTimer);
            if (!pageInactive) pollTimer = setTimeout(pollCollection, 5000);
        }
    }
    async function writeCollection(endpoint, input) {
        if (endpoint === "/api/collection/now") return checkActivity();
        if (collectionBusy) throw new Error("A collection change is already in progress. It has not been repeated.");
        collectionBusy = true;
        collectionReadGeneration++;
        $("collectionStatus").textContent = "Updating local collection...";
        try {
            const result = await api(endpoint, input);
            renderCollection(result);
            if (!$("overlay").open && !reportJourney?.isReviewOpen()) await load({ background: true });
            else if (collection.revision !== state?.revision) $("newDataNotice").hidden = false;
            return result;
        } finally {
            collectionBusy = false;
        }
    }
    function openDialog(title) {
        ux.hideTooltip();
        invalidatePreview();
        $("clearPreviewSelection").hidden = true;
        returnFocus = document.activeElement;
        $("dialogTitle").textContent = title;
        $("detail").replaceChildren();
        if (!$("overlay").open) $("overlay").showModal();
        return $("detail");
    }
    function renderDocument(markdown) {
        const article = el("article", "report-document");
        const lines = String(markdown).split("\n");
        const containers = [article];
        let list = null, section = null;
        const current = () => containers.length > 1 ? containers.at(-1) : section || article;
        function inline(node, text) {
            const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
            for (const part of parts) {
                if (part.startsWith("**") && part.endsWith("**")) node.append(el("strong", "", part.slice(2, -2)));
                else if (part.startsWith("`") && part.endsWith("`")) node.append(el("code", "", part.slice(1, -1)));
                else node.append(document.createTextNode(part.replace(/\\([\\|*_`])/g, "$1")));
            }
            return node;
        }
        function cells(line) {
            const result = [];
            let value = "", escaped = false;
            for (const char of line.trim().replace(/^\|/, "").replace(/\|$/, "")) {
                if (escaped) { value += char; escaped = false; }
                else if (char === "\\") escaped = true;
                else if (char === "|") { result.push(value.trim()); value = ""; }
                else value += char;
            }
            result.push(value.trim());
            return result;
        }
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (!line) { list = null; continue; }
            const fence = /^\s*(`{3,}|~{3,})[^`~]*$/.exec(lines[index]);
            if (fence) {
                const code = [];
                while (++index < lines.length && !new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`).test(lines[index])) code.push(lines[index]);
                current().append(ux.codeBlock(code.join("\n") + (index < lines.length ? "\n" : ""), { label: "Report code", copyLabel: "Copy report code" }));
                list = null;
            } else if (line === "<details>") {
                const details = el("details", "detail-disclosure");
                current().append(details); containers.push(details); list = null;
            } else if (line === "</details>" && containers.length > 1) { containers.pop(); list = null; }
            else if (/^<summary>.*<\/summary>$/.test(line) && current().tagName === "DETAILS") current().append(inline(el("summary"), line.slice(9, -10)));
            else if (line.startsWith("|") && /^\|[\s:|-]+\|$/.test(lines[index + 1]?.trim() || "")) {
                const headers = cells(line), table = el("table"), head = el("thead"), row = el("tr"), body = el("tbody");
                const numeric = cells(lines[index + 1]).map((cell) => cell.endsWith(":"));
                headers.forEach((label, column) => { const th = inline(el("th", numeric[column] ? "numeric" : ""), label); th.scope = "col"; row.append(th); });
                head.append(row);
                index++;
                while (lines[index + 1]?.trim().startsWith("|")) {
                    const values = cells(lines[++index]), tr = el("tr");
                    headers.forEach((label, column) => {
                        const td = inline(el("td", numeric[column] ? "numeric" : ""), values[column] || "");
                        td.dataset.label = label;
                        tr.append(td);
                    });
                    body.append(tr);
                }
                table.append(head, body); current().append(table); list = null;
            } else if (/^##\s/.test(line)) {
                section = el("details", "detail-disclosure");
                section.append(inline(el("summary"), line.replace(/^##\s+/, "")));
                article.append(section);
                list = null;
            } else if (/^#{1,4}\s/.test(line)) { current().append(inline(el("h3"), line.replace(/^#{1,4}\s+/, ""))); list = null; }
            else if (/^[-*]\s/.test(line)) {
                if (!list) { list = el("ul"); current().append(list); }
                list.append(inline(el("li"), line.replace(/^[-*]\s+/, "")));
            } else { current().append(inline(el("p"), line)); list = null; }
        }
        return article;
    }
    async function previewExport() {
        if (exportWriting || reportJourney?.snapshot().phase === "scanning" || !ensureCurrentTime() || isLoading || isStale || $("exportBtn").disabled) return;
        const selection = reportSelection().selection(state.revision);
        invalidatePreview();
        const body = reportJourney.beginScan();
        if (!body) return;
        const operation = draft.token();
        const progress = el("p", "", "Scanning selected evidence locally. No files are being written.");
        progress.setAttribute("role", "status");
        ux.pending(progress, true);
        body.append(progress);
        try {
            const preview = await api("/api/preview", { selection, options: draft.options() });
            if (!ensureCurrentTime() || !draft.current(operation) || !reportJourney.isReviewOpen()) {
                if (preview.previewId) await api("/api/cancel-preview", { previewId: preview.previewId });
                return;
            }
            if (preview.privacy?.allSelectedFieldsScanned !== true || !preview.files || !preview.previewId) throw new Error("The local privacy scan is incomplete. Export is blocked.");
            activePreview = preview;
            renderPreview(body, preview, operation);
        } catch (error) {
            if (!draft.current(operation)) return;
            body.replaceChildren();
            reportJourney.failed(error.message + " No files were written. Prepare a new preview.");
        }
    }
    function renderPreview(body, preview, operation) {
        detailOwner = "preview:" + preview.previewId;
        body.replaceChildren();
        const steps = el("ol", "privacy-steps");
        steps.append(el("li", "", "Local scan"), el("li", "current", "Disclosure review"), el("li", "", "Confirm local write"));
        const modeLabels = { none: "No prompts", masked: "Masked prompts", original: "Original prompts" };
        const mode = preview.promptMode || "none";
        const formats = (preview.formats || ["markdown"]).map((f) => f === "markdown" ? "Markdown" : f.toUpperCase()).join(", ");
        const snapshotDetails = el("details", "detail-disclosure report-snapshot-details");
        snapshotDetails.append(el("summary", "", "Included evidence and preparation details"), el("p", "report-confirmation", `One report · ${chatCopy.groups(preview.records.length)} included. ${modeLabels[mode]} / ${formats}`));
        body.append(steps, snapshotDetails);
        if (reportEntry) snapshotDetails.append(el("p", "report-confirmation", `GitHub Copilot chat: ${reportEntry.sessionName} / ${reportEntry.projectId ? "Copilot project: " + reportEntry.projectName : "Copilot chat without a project"}. Complete eligible request groups from this Copilot chat only.`));
        if (preview.snapshot?.selectionScope) {
            const scope = preview.snapshot.selectionScope;
            snapshotDetails.append(el("p", "report-confirmation", `Scope: ${({ all: "All collected activity", current: "Current view", selected: "Selected requests" })[scope.kind]}. ${scope.workIqActions} Work IQ tool calls; ${scope.returnedApiResults} tool-returned API results; ${scope.graphRequestSites} recorded Graph request sites (${scope.graphVisibleStatuses} with visible status); ${scope.ownedHttpRecords} owned HTTP records; ${scope.graphCodeReferences} Graph code references. Separate units, never summed.`));
            snapshotDetails.append(el("p", "muted", `${scope.exclusions.excludedOrDuplicateEvidenceRecords} collection evidence records excluded or deduplicated; ${scope.exclusions.unknownSourceRequestGroups} groups with unknown source identity. Existing review labels and original evidence will remain unchanged.`));
        }
        if (preview.timeContext) snapshotDetails.append(el("p", "report-time-context", `Report timezone: ${time.label(preview.timeContext)}. Locale: ${preview.timeContext.locale}. Prepared: ${preview.snapshot.preparedAtDisplay}.`));
        body.append(el("p", "report-privacy-note", mode === "original" ? "Personal wording will be included in local files. Detected credentials are removed even in Original mode. This is not permission to publish or upload." : mode === "none" ? "Request, follow-up and tool question text is omitted. Originals remain available here locally." : "Your retained wording is masked, not rewritten or summarized. Check unlabelled names and confidential meaning yourself."));
        const changed = () => {
            const canRebuild = activePreview === preview || body.querySelector(".rebuild-preview");
            invalidatePreview(canRebuild ? "" : undefined);
            body.querySelectorAll("[data-review-control]").forEach((node) => { node.disabled = true; });
            if (canRebuild && !body.querySelector(".rebuild-preview")) {
                const warning = el("div", "notice stale rebuild-preview");
                warning.setAttribute("role", "status");
                warning.append(el("p", "", "Your report copy changed. Select Rebuild preview, then review the updated report before approving or saving."), button("Rebuild preview", previewExport));
                body.prepend(warning);
            }
        };
        if (preview.promptReview?.length) {
            const comparisons = el("section", "prompt-comparisons");
            const comparisonHeading = el("h3", "help-heading", "Originals and report copies");
            comparisonHeading.append(ux.helpButton("highlighted report copies", "Highlighted spans show replacements in the report copy, not changes to your original. Credential removals are mandatory; category counts describe replacements."));
            comparisons.append(comparisonHeading, el("p", "muted", "Original text stays unchanged. Highlighted report spans show local masking. Edits affect this report only."));
            comparisons.append(el("p", "context-help-note", help.notices.clipboard));
            const incomplete = preview.promptReview.filter(prompt => prompt.status !== "full" || prompt.original === null).length;
            const removals = preview.promptReview.reduce((sum, prompt) => sum + prompt.changes.length, 0);
            comparisons.append(el("p", "prompt-review-summary", `${count(preview.promptReview.length)} prompt copies across all pages; ${count(incomplete)} incomplete or unavailable sources; ${count(removals)} removals. Review every relevant copy; changing pages does not approve disclosure.`));
            const copies = el("div");
            pagedList(copies, preview.promptReview, { key: "copies:" + preview.previewId, noun: "prompt copies", renderItem: prompt => {
                detailOwner = "preview:" + preview.previewId + ":" + prompt.key;
                const displayLabel = prompt.kind === "origin" ? textAccess.caption(prompt) : prompt.kind === "tool" ? `Recorded tool argument (${prompt.label})` : `${prompt.label} / ${textAccess.caption(prompt)}`;
                const item = el("details", "prompt-comparison");
                item.append(el("summary", "", `${displayLabel} / ${prompt.omitted ? "omitted" : prompt.representation} / ${prompt.changes.length} removal(s)`));
                const pair = el("div", "prompt-pair");
                const original = el("div", "prompt-original"), copy = el("div", "prompt-report");
                original.append(el("h4", "", "Local original"));
                if (prompt.original === null) original.append(el("p", "", "Original text is unavailable."));
                else {
                    const originalBlock = ux.codeBlock(prompt.original, { label: "Local original", copyLabel: "Copy local original", prose: true });
                    original.append(mode === "none" ? disclosure("Read local original; not included in report", originalBlock) : originalBlock);
                }
                original.append(el("p", "muted", `Source status: ${prompt.status}. ${prompt.status === "full" ? "Exact retained text." : "Incomplete or unavailable; not reconstructed."}`));
                copy.append(el("h4", "", "In your report"));
                const rendered = el("pre");
                if (prompt.text === null) copy.append(el("p", "", prompt.omitted ? "No prompt text included." : "Source text unavailable; not reconstructed."));
                else {
                    for (const segment of prompt.segments) {
                        if (segment.category) {
                            const mark = el("mark", segment.mandatory ? "mandatory" : "", segment.text);
                            mark.tabIndex = 0;
                            rendered.append(ux.tooltip(mark, segment.mandatory ? "Mandatory credential removal. Cannot be restored to an export." : `This span replaces a ${segment.category.replaceAll("_", " ")} match in the report copy. Your local original is unchanged.`));
                        } else rendered.append(document.createTextNode(segment.text));
                    }
                    copy.append(ux.attachCopy(rendered, { label: "Report copy", copyLabel: mode === "masked" ? "Copy masked prompt" : "Copy original-mode prompt", getText: () => rendered.textContent, prose: true }));
                }
                for (const category of [...new Set(prompt.changes.map((c) => c.category))]) copy.append(el("p", "muted", `${category.replaceAll("_", " ")}: ${prompt.changes.filter((c) => c.category === category).length} removal(s).`));
                if (prompt.changes.some((c) => c.mandatory)) copy.append(el("p", "notice", "Mandatory credential removal. This copy is not byte-identical to the original."));
                if (prompt.edited) copy.append(el("p", "muted", "You edited this report copy. It is not the original wording."));
                pair.append(original, copy);
                item.append(pair);
                if (mode !== "none" && prompt.original !== null) {
                    const edit = el("details", "detail-disclosure");
                    edit.append(el("summary", "", "Edit or omit this report copy"));
                    const omit = el("input"), omitLabel = el("label", "attestation");
                    omit.type = "checkbox"; omit.checked = prompt.omitted;
                    omitLabel.append(omit, el("span", "", "Omit this prompt from the report"));
                    const textarea = el("textarea");
                    const override = draft.options().overrides.find(value => value.key === prompt.key);
                    omit.checked = override?.omit ?? prompt.omitted;
                    textarea.rows = 5; textarea.value = override?.text ?? prompt.text ?? ""; textarea.disabled = omit.checked;
                    textarea.setAttribute("aria-label", `Report copy: ${displayLabel}`);
                    const saveEdit = () => {
                        const overrides = draft.options().overrides.filter((o) => o.key !== prompt.key);
                        overrides.push({ key: prompt.key, omit: omit.checked, ...(omit.checked || prompt.omitted && !textarea.value ? {} : { text: textarea.value }) });
                        draft.change({ overrides });
                        changed();
                    };
                    omit.addEventListener("change", () => { textarea.disabled = omit.checked; saveEdit(); });
                    textarea.addEventListener("input", saveEdit);
                    edit.append(omitLabel, el("p", "", "Edit the exported copy only. Detected credentials and, in Masked mode, personal patterns are removed again when rebuilt."), textarea);
                    item.append(edit);
                }
                return bindDetails(viewKey(item, detailOwner), detailOwner, undefined, prompt === preview.promptReview[0]);
            } });
            comparisons.append(copies);
            body.append(comparisons);
        }
        const report = el("div", "report-document");
        function showFiles(value) {
            report.replaceChildren();
            if (value.previewHtml) {
                const frame = el("iframe", "report-frame");
                frame.title = "Formatted report preview";
                frame.setAttribute("sandbox", "");
                frame.srcdoc = value.previewHtml;
                report.append(el("h3", "", "Formatted report"), el("p", "muted", "All selected formats share these reviewed facts and prompt copies."), frame);
            } else if (value.files["product-report.md"]) report.append(renderDocument(value.files["product-report.md"]));
            const exactFiles = el("details", "detail-disclosure report-file-inspection");
            exactFiles.append(el("summary", "", "Inspect exact files"));
            for (const [name, text] of Object.entries(value.files)) {
                if (typeof text === "string") exactFiles.append(disclosure("Inspect exact " + name, text));
                else exactFiles.append(el("p", "muted", `${name}: PDF prepared locally in memory. It is written only after disclosure review and final confirmation.`));
            }
            report.append(exactFiles);
        }
        showFiles(preview);
        body.append(report);
        const scan = el("details", "detail-disclosure");
        scan.append(el("summary", "", "What the local privacy scan found"));
        for (const [category, occurrences] of Object.entries(preview.privacy.categories || {})) if (occurrences) scan.append(el("p", "", `${category.replaceAll("_", " ")}: ${occurrences} source occurrence(s). The report-copy comparison shows what is removed or retained.`));
        scan.append(facts([["Original prompts", preview.privacy.originatingPrompts], ["Follow-ups", preview.privacy.followUpPrompts], ["Argument objects", preview.privacy.toolArgumentObjects], ["Strings scanned", preview.privacy.stringsScanned], ["All selected fields scanned", "Yes"]]));
        scan.append(el("p", "", preview.privacy.transformation));
        for (const limitation of preview.privacy.limitations || []) scan.append(el("p", "", limitation));
        body.append(scan);
        const attestation = el("label", "attestation"), checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.dataset.reviewControl = "";
        attestation.append(checkbox, el("span", "", `I reviewed these report copies, category findings and coverage limits for ${modeLabels[mode]} in ${formats}. I approve this disclosure to local files only.`));
        body.append(attestation);
        const feedback = el("p", "muted");
        feedback.setAttribute("role", "status");
        const review = button("Complete disclosure review", async () => {
            if (isLoading || isStale || !ensureCurrentTime() || !checkbox.checked || !draft.current(operation)) return;
            review.disabled = checkbox.disabled = true;
            feedback.textContent = "Recording your disclosure review...";
            ux.pending(review, true);
            try {
                const result = await api("/api/privacy-review", { previewId: activePreview.previewId, disclosureReviewed: true, timeContext: viewerTime });
                if (!ensureCurrentTime() || !draft.current(operation) || !reportJourney.isReviewOpen()) return;
                if (result.privacy?.reviewerConfirmed !== true || result.privacy?.allSelectedFieldsScanned !== true) throw new Error("The review was not confirmed.");
                activePreview = result;
                showFiles(result);
                review.textContent = "Disclosure reviewed";
                steps.children[1].classList.remove("current"); steps.children[2].classList.add("current");
                feedback.textContent = "Disclosure review recorded. No files saved yet.";
                confirm.disabled = false;
                reportJourney.reviewed();
            } catch (error) { feedback.className = "notice error"; feedback.setAttribute("role", "alert"); feedback.textContent = error.message + " Prepare a new preview."; review.textContent = "Review not confirmed"; reportJourney.failed(feedback.textContent); }
            finally { ux.pending(review, false); }
        });
        ux.pending(review, false);
        review.disabled = true;
        review.dataset.reviewControl = "";
        checkbox.addEventListener("change", () => { review.disabled = !checkbox.checked || !draft.current(operation); });
        const confirm = button("Confirm local export", async () => {
            if (exportWriting || isLoading || isStale || !ensureCurrentTime() || !draft.current(operation) || activePreview?.privacy?.reviewerConfirmed !== true || !reportJourney.isReviewOpen()) return;
            confirm.disabled = true;
            ux.pending(confirm, true);
            exportWriting = true;
            reportJourney.writing(true);
            $("clearPreviewSelection").disabled = true;
            $("closeDialog").disabled = true;
            feedback.textContent = "Saving the confirmed local files. This write cannot be cancelled now; no action will be replayed if the response is uncertain.";
            try {
                const result = await api("/api/export", { previewId: activePreview.previewId, confirmed: true, timeContext: viewerTime });
                if (!draft.current(operation)) return;
                activePreview = null;
                presentation.setPage("saved-reports:" + localQuery("savedReportSearch"), 0);
                const loaded = await load({ afterExport: true });
                if (!draft.current(operation)) return;
                if (!loaded) {
                    reportJourney.failed("The report save was confirmed, but its availability could not be checked. Read saved history before downloading; do not save it again.");
                    announce("The report save was confirmed. Current saved files could not be checked; use Retry without repeating the save.", "stale", true);
                    return;
                }
                const available = state.exports.some(bundle => bundle.bundleId === result.bundle.bundleId);
                reportJourney.saved(result.bundle, { available });
                if (route.view !== "reports") announce(available ? "Local report saved: " + result.bundle.bundleDir + ". Disclosure reviewed; not a privacy certification."
                    : "The saved report is no longer available. Its downloads have been removed.", available ? "" : "stale");
            } catch (error) { feedback.className = "notice error"; feedback.setAttribute("role", "alert"); feedback.textContent = error.message + " Read current saved reports before preparing a new preview; the write may have completed."; confirm.textContent = "Export not confirmed"; reportJourney.failed(feedback.textContent); }
            finally { ux.pending(confirm, false); exportWriting = false; reportJourney.writing(false); $("closeDialog").disabled = false; $("clearPreviewSelection").disabled = false; updateSelection(); }
        }, "primary");
        ux.pending(confirm, false);
        confirm.disabled = true;
        confirm.dataset.reviewControl = "";
        const controls = el("div", "dialog-actions");
        controls.append(ux.explainDisabled(review, "Check the disclosure box after reviewing the report copies and selected formats."), ux.explainDisabled(confirm, "Complete disclosure review before confirming the local file write."));
        body.append(controls, feedback, el("p", "muted", "No network sharing. This preview expires after 10 minutes. Changed selections or evidence require a new scan."));
        reportJourney.previewReady(preview, { confirm, feedback });
    }
    function invalidateDialog(message) {
        $("reportReviewBody")?.querySelector(".rebuild-preview")?.remove();
        reportJourney?.invalidate(message);
        if (!$("overlay").open) return;
        $("detail").querySelectorAll("button,input").forEach((control) => { control.disabled = true; });
        if (!$("detail").querySelector("[data-invalidated]")) {
            const warning = el("p", "notice stale", message);
            warning.dataset.invalidated = "true";
            $("detail").append(warning);
        }
    }
    function recoverRead() {
        if (exportWriting) return;
        invalidatePreview();
        invalidateDialog("The panel reconnected. Close and prepare a new report preview before continuing.");
        if (analytics) { isStale = true; updateSelection(); }
        load();
    }
    function handleVisibilityChange() {
        if (exportWriting) return;
        invalidatePreview();
        invalidateDialog("The panel changed visibility. Close and prepare a new report preview before continuing.");
        if (analytics) { isStale = true; updateSelection(); }
        if (!document.hidden) load();
    }
    document.querySelectorAll("[data-nav]").forEach((node) => node.addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); go(node.dataset.nav, { request: undefined, task: undefined });
    }));
    $("resultsLink").addEventListener("click", event => { event.preventDefault(); revealResults(); });
    for (const node of document.querySelectorAll("[data-analyze-mode]")) node.addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        go("analyze", { mode: node.dataset.analyzeMode === "calls" ? "calls" : undefined, page: undefined });
    });
    for (const id of ["pageAction", "exploreLink", "backToSelection", "reportLibraryLink", "reportCreateLink"]) $(id).addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const reportTask = event.currentTarget.closest("#reportTaskNav");
        if (!reportTask && (isLoading || isStale)) return;
        navigate({ ...readRoute(new URL(event.currentTarget.href).hash, null), search: route.search, returnToSessions: route.returnToSessions,
            ...(reportTask ? { localSearch: route.localSearch } : {}) });
    });
    $("resetView").addEventListener("click", resetView);
    document.querySelectorAll("[data-chart]").forEach((node) => node.addEventListener("click", () => go("home", { chart: node.dataset.chart, request: undefined })));
    for (const [id, key] of Object.entries({ layerFilter: "layer", toolFilter: "tool", serviceAssociationFilter: "services", serviceFilter: "service", projectFilter: "project", chatFilter: "session", scopeFilter: "scope" })) $(id).addEventListener("change", () => {
        if (restoring) return;
        navigate(routeFor(route.view, { [key]: $(id).value === "all" && key !== "scope" ? undefined : $(id).value,
            ...(key === "layer" && $(id).value !== "tool" && route.service === "Discovery" ? { service: undefined } : {}),
            ...(key === "services" ? { includeMissingService: $(id).value !== "all" ? true : undefined, withinServices: undefined } : {}),
            page: undefined, request: undefined }), false, { keepFocus: true });
    });
    $("addServiceContext").addEventListener("click", () => {
        ux.restoreFocus($("serviceAssociationFilter-control"));
        navigate(routeFor(route.view === "request" ? "activity" : route.view, { includeMissingService: true, page: undefined, request: undefined }), false, { keepFocus: true });
    });
    $("outcomeFilter").addEventListener("change", () => {
        if (restoring) return;
        const values = [...$("outcomeFilter").selectedOptions].map(option => option.value);
        navigate(routeFor(route.view, { result: results.filterValue(values), page: undefined, request: undefined }), false, { keepFocus: true });
    });
    $("clearResultFilter").addEventListener("click", () => {
        ux.hideTooltip();
        const trigger = $("outcomeFilter-control");
        if (trigger.disabled) $("resultFilterLabel").tabIndex = -1;
        ux.restoreFocus(trigger.disabled ? $("resultFilterLabel") : trigger);
        navigate(routeFor(route.view, { result: undefined, page: undefined, request: undefined }), false, { keepFocus: true });
    });
    $("promptAuthorFilter").addEventListener("change", () => {
        if (restoring) return;
        const values = [...$("promptAuthorFilter").selectedOptions].map(option => option.value);
        navigate(routeFor(route.view, { authors: authorship.filterValue(values), page: undefined, request: undefined }), false, { keepFocus: true });
    });
    $("clearPromptAuthorFilter").addEventListener("click", () => {
        ux.hideTooltip();
        ux.restoreFocus($("promptAuthorFilter-control"));
        navigate(routeFor(route.view, { authors: undefined, page: undefined, request: undefined }), false, { keepFocus: true });
    });
    $("bucketFilter").addEventListener("change", () => navigate(routeFor("home", { bucket: $("bucketFilter").value }), false, { keepFocus: true }));
    $("dateFilter").addEventListener("change", () => {
        dateDraft = null;
        dateError("");
        const range = $("dateFilter").value;
        $("dateFields").hidden = range !== "custom";
        if (range === "custom") { go(route.view, { range, page: undefined }); return; }
        if (range === "capture") go(route.view, { range: undefined, from: undefined, to: undefined, page: undefined });
        else {
            const to = time.day(new Date().toISOString(), viewerTime.timeZone);
            go(route.view, { range, from: time.addDays(to, 1 - Number(range)), to, page: undefined });
        }
    });
    $("filters").addEventListener("submit", (event) => {
        event.preventDefault();
        const from = $("fromFilter").value, to = $("toFilter").value;
        try {
            if (!from || !to) throw new RangeError("Choose both dates. For one day, use the same date twice.");
            time.calendar(from); time.calendar(to); time.range({ from, to }, viewerTime.timeZone);
        } catch (error) { dateError(error.message); return; }
        dateError("");
        dateDraft = null;
        if (isLoading && route.from === from && route.to === to) return;
        navigate(routeFor(route.view, { range: "custom", from, to, page: undefined }), false, { keepFocus: true });
    });
    function dateError(message) {
        setText($("dateError"), message);
        $("dateError").hidden = !message;
        for (const id of ["fromFilter", "toFilter"]) $(id).setAttribute("aria-invalid", String(Boolean(message)));
    }
    for (const id of ["fromFilter", "toFilter"]) $(id).addEventListener("input", () => {
        dateDraft = { from: $("fromFilter").value, to: $("toFilter").value };
        dateError("");
    });
    $("activitySearch").addEventListener("input", () => {
        search = $("activitySearch").value; activityPage = 0;
        route = { ...route, search, page: undefined };
        rememberRoute(route, true);
        if (isLoading) return;
        appliedRoute = { ...route };
        render();
    });
    $("clearActivitySearch").addEventListener("click", () => {
        $("activitySearch").value = ""; $("activitySearch").dispatchEvent(new Event("input")); $("activitySearch").focus();
    });
    $("activitySearch").addEventListener("keydown", event => {
        if (event.key === "Escape" && search) { event.preventDefault(); $("clearActivitySearch").click(); }
    });
    for (const [id, clear] of Object.entries(scopedSearches)) {
        $(clear).setAttribute("aria-label", ({
            settingsSearch: "Clear settings search", issueSearch: "Clear affected chat search",
            savedReportSearch: "Clear saved report search", reportRequestSearch: "Clear report request search",
        })[id]);
        $(id).addEventListener("input", () => {
            route = { ...route, localSearch: { ...route.localSearch, [id]: $(id).value } };
            rememberRoute(route, true); appliedRoute = { ...route };
            syncLocalSearchFields();
            if (id === "settingsSearch") renderSettingsSearch();
            else if (id === "issueSearch") { if (issueRows) renderCollectionIssues({ historyIssues: issueRows }); }
            else renderReports();
        });
        $(clear).addEventListener("click", () => {
            $(id).value = ""; $(id).dispatchEvent(new Event("input"));
            if (id === "issueSearch" && !$(id).checkVisibility()) ux.restoreFocus($("collectionIssuesTitle"));
            else $(id).focus();
        });
        $(id).addEventListener("keydown", event => {
            if (event.key === "Escape" && $(id).value) { event.preventDefault(); $(clear).click(); }
        });
    }
    $("settingsSearchResults").addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); $("clearSettingsSearch").click(); }
    });
    const settingsCategoryIcons = { connection: "connection", privacy: "database", ai: "check", display: "sun", troubleshooting: "collection-status" };
    const settingsSearchIcon = ux.icon("search");
    settingsSearchIcon.classList.add("settings-search-icon");
    $("settingsSearch").before(settingsSearchIcon);
    for (const category of settingsNavigation.categories) {
        const anchor = link("", "settings", { section: category.id, setting: undefined, issues: undefined });
        anchor.dataset.category = category.id;
        anchor.append(ux.icon(settingsCategoryIcons[category.id]), el("span", "settings-category-label", category.title));
        $("settingsCategoryNav").append(anchor);
    }
    const settingsSize = new ResizeObserver(() => {
        if (!$("settingsView").checkVisibility()) return;
        const compact = $("settingsView").clientWidth <= 52 * parseFloat(getComputedStyle(document.documentElement).fontSize);
        if (compactSettings !== compact) {
            const wasFocused = $("settingsCategoryNav").contains(document.activeElement);
            compactSettings = compact;
            $("settingsCategories").open = !compact;
            if (wasFocused && compact) $("settingsCategorySummary").focus({ preventScroll: true });
        }
    });
    settingsSize.observe($("settingsView"));
    $("refreshBtn").addEventListener("click", refreshStoredData);
    $("deleteAllReports").addEventListener("click", event => savedArtifactUI.open({ scope: "all-reports" }, event.currentTarget));
    $("collectionRetry").addEventListener("click", refreshStoredData);
    $("collectionRetry").setAttribute("aria-describedby", "storedRefreshHelp");
    $("clearDates").addEventListener("click", () => {
        ux.restoreFocus($("dateFilter-control"));
        go(route.view, { from: undefined, to: undefined, range: undefined, request: undefined, page: undefined });
    });
    $("checkActivity").addEventListener("click", checkActivity);
    document.querySelectorAll("[data-settings-link]").forEach(node => node.addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const target = readRoute(node.hash, null);
        const changes = { section: target.section, setting: target.setting, issues: undefined };
        const mode = new URLSearchParams(node.hash.split("?")[1]).get("mode");
        if (target.view === "analyze" && ["calls", "interactions"].includes(mode)) {
            changes.mode = mode === "calls" ? "calls" : undefined;
            changes.page = undefined;
        }
        go(target.view, changes);
    }));
    mountRecorderDiagnostics({ api, openDialog, el, button });
    $("exportBtn").addEventListener("click", previewExport);
    document.querySelectorAll("[data-clear-selection]").forEach(control => {
        control.addEventListener("click", clearReportSelection);
        ux.tooltip(control, "Empty this report selection and discard its preview and per-copy edits. Keep captured evidence, review labels, saved reports, filters and prompt/format choices.");
    });
    document.querySelectorAll("[name=reportScope]").forEach((control) => control.addEventListener("change", () => {
        if (exportWriting) return;
        reportScope = control.value;
        reportEntry = null;
        invalidatePreview(); renderReports();
    }));
    $("reportPromptAuthorFilter").addEventListener("change", () => {
        if (exportWriting) return;
        reportAuthors = authorship.selection([...$("reportPromptAuthorFilter").selectedOptions].map(option => option.value));
        invalidatePreview("Prompt authors changed. Review the updated report membership before saving.");
        renderReports();
    });
    ux.explainDisabled($("exportBtn"), () => isStale || isLoading ? "Wait for a current activity snapshot." : !draft.options().formats.length ? "Select at least one export format." : "Select interactions in Analyze or choose Current view or All collected activity. Review labels do not control export eligibility.");
    document.querySelectorAll("[name=promptMode]").forEach((control) => control.addEventListener("change", () => {
        draft.change({ promptMode: control.value, overrides: [] });
        invalidatePreview(); updateSelection();
    }));
    $("formatOptions").querySelectorAll("input[type=checkbox]").forEach((control) => control.addEventListener("change", () => {
        const formats = [...$("formatOptions").querySelectorAll("input:checked")].map((node) => node.value);
        draft.change({ formats });
        $("formatError").hidden = formats.length > 0;
        invalidatePreview(); updateSelection();
    }));
    $("manualTerms").addEventListener("input", () => {
        draft.change({ manualTerms: $("manualTerms").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) });
        invalidatePreview();
    });
    $("closeDialog").addEventListener("click", () => $("overlay").close());
    $("overlay").addEventListener("close", () => { invalidatePreview(); if (returnFocus?.isConnected) ux.restoreFocus(returnFocus); });
    $("overlay").addEventListener("cancel", (event) => { if (exportWriting) event.preventDefault(); });
    document.querySelector(".skip-link").addEventListener("click", event => {
        event.preventDefault();
        const heading = $("pageTitle");
        heading.tabIndex = -1;
        ux.restoreFocus(heading);
        heading.scrollIntoView({ block: "start" });
    });
    window.addEventListener("popstate", () => applyRoute(readRoute(), { restorePosition: true }));
    window.addEventListener("pageshow", (event) => { if (event.persisted) recoverRead(); });
    window.addEventListener("online", recoverRead);
    window.addEventListener("focus", () => { if (!exportWriting) ensureCurrentTime(); });
    window.addEventListener("languagechange", () => { if (!exportWriting) ensureCurrentTime(); });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", () => { pageInactive = true; assessmentUI.leave(); automaticUI.leave(); savedArtifactUI?.leave(); clearTimeout(pollTimer); });
    window.addEventListener("pageshow", () => { pageInactive = false; clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 250); });
    document.addEventListener("visibilitychange", () => { assessmentUI.clearPrivateText(); if (!document.hidden) { clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 250); } });
    for (const node of document.querySelectorAll("details[id]")) {
        if (!node.dataset.disclosureKey && node.id !== "settingsCategories") bindDetails(node, node.id, undefined, node.id === "bundles");
    }
    viewKey($("chart"), "chart");
    reportJourney = createReportJourney({
        onStateChange: () => { renderStoredRefresh(); renderReportTask(); },
        root: $("reportsView"), cancelReview: invalidatePreview, clearSelection: clearReportSelection,
        chooseRequests: () => navigate(reportEntry?.returnTo || routeFor("activity")),
        showSourceIssues: async () => {
            await go("collection-status", { setting: "issues" });
        },
        downloadFile: downloadReportFile,
        openSavedReport,
    });
    reportComparisonUI = assessmentFactories.mountComparison($("comparisonWorkspace"), {
        api, renderer: assessmentFactories.createReportComparison(), timeContext: () => viewerTime,
        refresh: () => load({ background: true }), onError: message => announce(message, "error"),
    });
    savedArtifactUI = assessmentFactories.createArtifactDeletion({
        api, ux, onError: message => announce(message, "error"),
        fallbackFocus: () => {
            const saved = $("bundles").querySelector("summary");
            if (saved.checkVisibility()) return saved;
            $("pageTitle").tabIndex = -1;
            return $("pageTitle");
        },
        onDeleted: async artifact => {
            for (const item of artifact.artifacts ?? [artifact]) {
                reportComparisonUI.invalidateSavedReport(item.artifactId);
                reportJourney.invalidateSavedReport(item.artifactId);
            }
            return load({ background: true });
        },
    });
    displayTimeSettings = mountDisplayTimeSettings({ time, onChange: () => { if (!exportWriting) load(); } });
    $("callSort").addEventListener("change", () => {
        if (!restoring) navigate(routeFor("analyze", { callSort: $("callSort").value, page: undefined }), false, { keepFocus: true });
    });
    selectControls = createSelectControls(ux, {
        decorateOption: (node, { id, value, label }) => {
            if (["promptAuthorFilter", "reportPromptAuthorFilter"].includes(id)) {
                if (authorship.actors.includes(value)) node.dataset.promptActor = value;
                else delete node.dataset.promptActor;
                return;
            }
            if (id !== "outcomeFilter") return;
            node.classList.add("result-option-value");
            node.replaceChildren(el("span", "result-option-label", label));
            if (resultKeys.includes(value) && (applied?.layer !== "code-reference" || value === "unknown")) {
                const icon = el("span", `result-legend-icon result-tone-${value}`);
                icon.append(ux.icon(results.icon(value)));
                node.prepend(icon);
            }
        },
    });
    collectionSettings = mountCollectionSettings({
        ux,
        write: writeCollection,
        read: async () => { const status = await api("/api/collection/status", {}); renderCollection(status); return status; },
        invalidate: () => { invalidatePreview(); invalidateDialog("Collection settings are changing. Prepare a fresh report preview."); },
        onDraftChange: changed => {
            $("settingsDraftNotice").hidden = route.view === "settings" || !changed;
            $("settingsDraftNotice").querySelector("a").href = $("sourceEditor").hidden ? "#settings?section=connection&setting=history-window" : "#settings?section=connection&setting=source";
            renderSettingsSearch();
            renderFreshActivity();
        },
    });
    syncControls();
    rememberRoute(route, true);
    load().then(ok => {
        if (!ok) return;
        if (route.view === "settings") revealSetting();
        else if (route.view === "collection-status") revealCollectionStatus();
    });
    pollTimer = setTimeout(pollCollection, 250);
}
