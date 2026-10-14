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
    function bucket(route) {
        if (route.bucket) return route.bucket;
        if (["day", "week", "month", "7", "30"].includes(route.range)) return "day";
        const span = Date.parse(route.to) - Date.parse(route.from);
        return span < 31 * 86400000 ? "day" : span >= 366 * 86400000 ? "month" : "week";
    }
    return { canonical, query, scope, bucket };
}

// Refine only an accepted canonical snapshot. Private search never becomes a server filter.
export function createAnalysisSlice(localSearch, projection) {
    function legacyScenarioIds(snapshot, search) {
        if (!search.trim()) return undefined;
        const sources = new Map((snapshot.sessions || []).map(source => [source.sessionId, source]));
        const records = new Map(snapshot.scenarios.map(scenario => [scenario.scenarioId, scenario]));
        return [...records.values()].filter(scenario => {
            const source = sources.get(scenario.sourceSessionId);
            return localSearch.phrase(search, [scenario.userPrompt?.text, scenario.title, source?.project, source?.name,
                scenario.project, scenario.sourceSessionName, scenario.sourceSessionId]);
        }).map(scenario => scenario.scenarioId).sort();
    }
    function slice(snapshot, options, search = "", withinServices = [], membership) {
        if (!Array.isArray(withinServices) || withinServices.some(service => typeof service !== "string" || !service)) {
            throw new TypeError("Service chart refinements require named services.");
        }
        const base = snapshot.analytics, records = new Map(snapshot.scenarios.map(scenario => [scenario.scenarioId, scenario]));
        if (membership && (membership.revision !== snapshot.revision || membership.scopeKey !== JSON.stringify([options, withinServices])
            || !Array.isArray(membership.scenarioIds) || !Array.isArray(membership.actionIds) || !Array.isArray(membership.parentScenarioIds))) {
            throw new TypeError("Search membership is not bound to this accepted analytical scope.");
        }
        const legacyIds = legacyScenarioIds(snapshot, search), legacy = legacyIds ? new Set(legacyIds) : null;
        const hasQuery = Boolean(legacy) || Boolean(membership);
        const matches = new Set(membership?.scenarioIds);
        const actionIds = new Set(membership?.actionIds);
        const withinLegacy = row => !legacy || legacy.has(row.scenarioId);
        const searchRows = rows => hasQuery ? rows.filter(row => withinLegacy(row)
            && (!membership || matches.has(row.scenarioId) || actionIds.has(row.id))) : rows;
        const refineRows = rows => searchRows(rows).filter(row => withinServices.every(service => row.serviceAssociation?.services.includes(service)));
        const rows = refineRows(base.rows), scenarioIds = [...new Set(rows.map(row => row.scenarioId).filter(id => records.has(id)))];
        let analytics = base;
        if (hasQuery || withinServices.length) {
            const facetRows = refineRows(base.resultFacet.rows);
            let parentCalls;
            if (base.layer === "reported-api") {
                parentCalls = membership ? base.apiCoverage.calls.filter(row => withinLegacy(row) && membership.parentScenarioIds.includes(row.scenarioId))
                    : searchRows(base.apiCoverage.calls);
                if (withinServices.length) {
                    const entries = snapshot.requestActivity?.["reported-api"];
                    if (!Array.isArray(entries)) throw new TypeError("Service-refined API parent coverage requires accepted returned-entry associations.");
                    const parentEntries = membership ? entries.filter(row => withinLegacy(row) && membership.parentScenarioIds.includes(row.scenarioId)
                        && withinServices.every(service => row.serviceAssociation?.services.includes(service))) : refineRows(entries);
                    const parents = new Set(parentEntries.map(row => row.parentCallId));
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
    }
    slice.legacyScenarioIds = legacyScenarioIds;
    return slice;
}

export function mountEvidence(capability, createBoardTransport, theme, createReportDraft, createEvidenceUX, uxIcons, mountThemeControl, createTimeContext, createServiceCategories, createDimensionalCharts, dimensionalIcons, mountSidebarNavigation, createReportScope, createSelectControls, createInlineMetadata, createControlHelp, createRecordedResults, createLiveState, createDisclosureState, createCollectionStatus, createSessionJourney, createReportJourney, mountCollectionSettings, createTextAccess, createPeriodFlow, createChatCopy, mountDisplayTimeSettings, createLocalSearch, createSettingsNavigation, createFreshActivity, createPercentageCharts, createRequestTiming, mountRecorderDiagnostics, createDeletionFlow, mountDeletion, assessmentFactories, createPromptAuthorship, createFilterState, createAnalysisSlice, createActivityProjection, createRequestContext, createCallInvestigation) {
    const $ = (id) => document.getElementById(id);
    const time = createTimeContext();
    const authorship = createPromptAuthorship();
    const requestTiming = createRequestTiming(time, authorship);
    const localSearch = createLocalSearch(), settingsNavigation = createSettingsNavigation(localSearch);
    let compactSettings, settingsSearchSignature, issueRows, deletionUI, recollectionUI, assessmentUI, automaticUI, liveSearchUI;
    let semanticMembership, semanticQuery = null, semanticComplete = false, semanticBound = false, semanticStatus = "stale";
    let searchOpenedRequest = null, searchTargetInvalid = false;
    const chatCopy = createChatCopy();
    const periodFlow = createPeriodFlow(time, chatCopy);
    let viewerTime = time.detect();
    let displayTimeSettings;
    const draft = createReportDraft({ contextSelector: createRequestContext() });
    const renderedContextBundles = new Set();
    const ux = createEvidenceUX(uxIcons);
    const metadata = createInlineMetadata(ux);
    // Keep operation wording on screen separate from saved report definitions.
    const recordedCategories = createServiceCategories();
    const categories = { ...recordedCategories, operation(tool) {
        const operation = recordedCategories.operation(tool);
        return tool === "workiq-ask" ? { ...operation, label: "Asked Copilot",
            description: "Recorded attempt to ask Copilot or an agent, not confirmation of delivery." } : operation;
    }, serviceEvidence(row, layer) {
        const evidence = recordedCategories.serviceEvidence(row, layer);
        return evidence?.reason === "hosted-routing" ? { ...evidence,
            description: categories.operation("workiq-ask").description + " Its record does not identify a service or API path." } : evidence;
    } };
    const help = createControlHelp(categories, assessmentFactories.wording);
    const dimensional = createDimensionalCharts();
    const reportScopes = createReportScope(authorship);
    const results = createRecordedResults();
    const filterState = createFilterState(results, authorship);
    const analysisSlice = createAnalysisSlice(localSearch, createActivityProjection(time, categories, Object.keys(results.labels("tool"))));
    const timingPresentation = assessmentFactories.timing;
    const percentageMath = createPercentageCharts({ dimensional, categories, results, ux, icons: dimensionalIcons,
        createLink: (kind, row) => kind === "outcomes" && applied.layer !== "code-reference" ? link("", "activity", { result: row.id, page: undefined })
            : kind === "services" ? link("", "activity", { withinServices: [...new Set([...(route.withinServices?.split(",") || []), row.id])].sort().join(","), page: undefined })
                : kind === "service-purpose" ? link("", "activity", { endpoint: "operation:workiq-retrieve", page: undefined })
                    : kind === "service-preparation" ? link("", "activity", { service: "Discovery", page: undefined })
                        : kind === "service-operation" ? link("", "activity", { tool: "workiq-ask", endpoint: row.endpointId, page: undefined })
                : kind === "tools" && row.id !== "tool:unidentified" ? link("", "activity", { tool: row.id.slice(5), page: undefined }) : null });
    $("analyzePopulation").append($("filters"), $("filterChips"), $("serviceFocus"), $("freshActivity"), $("collectionNotice"));
    $("freshHelpBody").append($("activityCollectionLink"));
    $("periodActions").prepend($("resultsLink"));
    $("resultsLink").textContent = "View records";
    const percentages = percentageMath.mount($("percentageCharts"), { outcomesHost: $("outcomeChart"), dataHost: $("percentageData"), includeModels: true });
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
    let reportEntry = null, reportJourney, reportComparisonUI, savedArtifactUI, artifactRefreshRequired = false, contextReturnKey, savedReportView, preparedReportReader;
    let periodReport = null, periodReportInvalid = false;
    const sessionReportButton = button("Create report for this Copilot chat", createSessionReport, "primary");
    sessionReportButton.id = "createSessionReport";
    sessionReportButton.hidden = true;
    $("pageAction").after(sessionReportButton);
    let issuesSignature, issuesLoading = false, issuesStatus;
    const issueAttempts = new Map();
    const presentation = createDisclosureState(), readingPositions = new Map();
    let periodReturnReading = null;
    const textAccess = createTextAccess(ux, presentation, authorship, metadata);
    const requestContext = createRequestContext();
    const callInvestigation = createCallInvestigation();
    let detailOwner = "page";
    let collection, collectionSettings, collectionBusy = false, collectionReadError = "", collectionReadReason = "", connectionNeedsSnapshot = false, pollTimer, pageInactive = false;
    const sidebar = mountSidebarNavigation(ux);
    let reportScope = "selected";
    let reportAuthors = authorship.selection();
    mountThemeControl(theme, ux);
    document.querySelectorAll(".primary-navigation [data-nav]").forEach(node => {
        node.prepend(ux.icon(`navigation-${node.dataset.nav}`));
    });
    for (const [id, icon] of Object.entries({ navigationToggle: "menu", closeNavigation: "close", refreshBtn: "refresh", checkActivity: "refresh", resetView: "reset", closeDialog: "close" })) {
        $(id).prepend(ux.icon(icon));
        $(id).classList.add("icon-action");
    }
    for (const [id, text] of Object.entries(help.actions)) if ($(id)) ux.tooltip($(id), text);
    for (const node of document.querySelectorAll("[data-chart]")) ux.tooltip(node, () =>
        node.dataset.chart === "workload" && applied?.layer === "tool" ? help.charts.activityCategory : help.charts[node.dataset.chart]);
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
    function sliceKey() { return JSON.stringify([query(), search, route.withinServices?.split(",") || []]); }
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
        collectionSettings?.setSection(route.view === "settings" ? section : null, route.setting);
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
    function categoryPresentation(row, layer = "tool") {
        const entry = categories.describe(row?.workload), evidence = categories.serviceEvidence(row, layer);
        return layer === "tool" && row?.workload === "Unknown" && row.tool === "workiq-ask" && evidence?.reason === "hosted-routing"
            ? { ...entry, icon: "Assistance", label: categories.operation(row.tool).label, description: evidence.description } : entry;
    }
    function serviceCue(tag, value, presentation) {
        const entry = presentation ?? categories.describe(value), node = el(tag, `semantic-cue service-cue dimensional-tone-${dimensional.tone(entry.id)}`);
        node.dataset.service = entry.id;
        node.innerHTML = dimensionalIcons[entry.icon ?? entry.id];
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
    function actionHeading(title, service, row, layer = "tool", { inlineHelp = true } = {}) {
        const heading = el("div", "action-heading");
        heading.append(el("h3", "", title));
        if (service) {
            const entry = categoryPresentation({ ...row, workload: service, tool: title }, layer), identity = el("span", "action-service-heading");
            const operation = categories.operation(title), cue = serviceCue("span", service, entry);
            const evidence = categories.serviceEvidence(row ? { ...row, tool: title } : row, layer);
            const label = service === "Discovery" ? operation.label : entry.label;
            const scope = layer === "tool" ? categories.requestedSearchScope(sourceCallFor(row)) : null;
            const help = [
                evidence?.description ?? (service === "Discovery" ? operation.description : entry.description),
                scope ? `${scope.label}. ${scope.description}` : null,
            ].filter(Boolean).join(" ");
            cue.lastElementChild.textContent = label;
            if (evidence && !entry.icon) cue.querySelector("svg")?.remove();
            identity.append(cue);
            if (inlineHelp) identity.append(ux.helpButton(label, help));
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
    fieldHelp("dateFilter", "Dates", "One period for every Analyze widget, headline and matching record. Today, This week and This month use calendar periods in the display time zone; weeks start Monday. All dates uses retained evidence. Custom dates include both boundary days. Changing dates does not collect history.");
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
    const activitySearchInput = $("activitySearch"), activitySearchRow = el("div", "search-input-row");
    activitySearchInput.replaceWith(activitySearchRow);
    activitySearchRow.append(activitySearchInput, $("clearActivitySearch"));
    $("clearActivitySearch").textContent = "Clear";
    $("clearActivitySearch").setAttribute("aria-label", "Clear activity search");
    $("clearResultFilter").append(ux.icon("close"));
    ux.tooltip($("clearResultFilter"), "Clear recorded result filter. Other filters stay applied.");
    $("clearPromptAuthorFilter").append(ux.icon("close"));
    ux.tooltip($("clearPromptAuthorFilter"), "Include all prompt authors, including unverified. Other filters stay applied.");
    $("formatOptions").append(el("p", "context-help-note", "Every format contains the same reviewed facts. HTML and PDF are for reading; JSON keeps structured data for other tools."));
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
        const preset = time.preset(route.range, viewerTime.timeZone);
        if (preset) {
            route = { ...route, ...preset };
            rememberRoute(route, true);
        }
        if (draft.synchronizeTime(periodReport?.timeContext ?? viewerTime, periodReport ? { range: "capture" } : dateSelection())) {
            invalidatePreview("The report time or date basis changed. Return to Setup and scan again.");
        }
        renderTimeContext();
    }
    function renderTimeContext() {
        const context = applied?.timeContext || viewerTime;
        displayTimeSettings.receive(context, { busy: exportWriting, pending: isLoading, stale: !isLoading && isStale && context.timeZone !== viewerTime.timeZone });
        const notice = $("timeZoneNotice");
        notice.textContent = [displayTimeSettings.warning(), context.timeZoneFallback ? "Browser timezone unavailable. Dates and reports use UTC, not an inferred local timezone." : "", context.localeFallback ? "Browser locale unavailable. Dates use en-US formatting." : ""].filter(Boolean).join(" ");
        notice.hidden = !notice.textContent;
        selectControls?.sync();
    }
    function timeChanged() {
        const next = displayTimeSettings.resolve(), preset = time.preset(route.range, next.timeZone);
        return JSON.stringify(next) !== JSON.stringify(viewerTime)
            || Boolean(preset && (preset.from !== route.from || preset.to !== route.to));
    }
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
    function facts(pairs, { inlineHelp = true, missing = {}, technical = false, omitMissing = false, copyIdentifiers = true } = {}) {
        const list = el("dl", "facts");
        if (technical) list.classList.add("technical-facts");
        for (const [label, value] of pairs) {
            if (omitMissing && (value == null || value === "")) continue;
            const cell = el("dd");
            if (value != null && ["Tool call ID", "Parent invocation", "Parallel group", "Copilot chat ID", "Source event"].includes(label)) {
                cell.append(copyIdentifiers ? ux.inlineCode(String(value), { label: "Copy " + label.toLowerCase() }) : el("code", "reader-identifier", String(value)));
            }
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
        liveSearchUI?.sessionChanged();
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
    let searchReturnMarker = null;
    const analysisSearchKey = () => state ? JSON.stringify([state.revision, applied, route.withinServices?.split(",") || []]) : null;
    function unavailableSearchMembership() {
        return { revision: state.revision, scopeKey: JSON.stringify([applied, route.withinServices?.split(",") || []]),
            receipt: null, scenarioIds: [], actionIds: [], parentScenarioIds: [] };
    }
    liveSearchUI = assessmentFactories.liveSearch.mount({
        api, createState: assessmentFactories.liveSearch.createState,
        frozenFrame: assessmentFactories.liveSearch.frozenFrame,
        getAnalysis: () => ({ key: analysisSearchKey(), revision: state?.revision, pending: isLoading,
            active: route.view === "analyze", needsRebind: semanticStatus === "pending" && !semanticBound }),
        async navigate(target) {
            const next = readRoute(target.href, null);
            searchOpenedRequest = next.view === "request" ? next.request : null;
            searchReturnMarker = liveSearchUI.returnKey();
            searchTargetInvalid = false;
            await navigate(next.view === "analyze" ? next
                : { ...route, ...next, request: next.request, call: next.call, callRevision: next.callRevision }, false, { fromSearch: true });
            if (target.focus) {
                const node = $(target.focus);
                if (node) { node.tabIndex = -1; node.focus({ preventScroll: true }); node.scrollIntoView({ block: "start" }); }
            }
        },
        onInvalidateOpen() {
            if (!searchOpenedRequest || route.view !== "request" || route.request !== searchOpenedRequest) return;
            searchTargetInvalid = true;
            assessmentUI?.invalidate("Search authorization changed. Reopen the current item.");
            assessmentUI?.clearPrivateText();
            $("requestContent").replaceChildren(el("p", "notice", "This search destination is no longer current. Return to Search and reopen its verified current item."));
        },
        onAnalysis(update) {
            if (!state) return;
            if (update.query === null || !update.query.trim()) {
                if (semanticQuery === null) return;
                semanticQuery = null; semanticMembership = undefined; semanticComplete = false; semanticBound = false;
                $("wireAnalysisSearchNotice").hidden = true;
                render(); return;
            }
            semanticQuery = update.query;
            semanticComplete = false;
            semanticBound = false;
            semanticStatus = update.state === "pending" ? "pending" : "stale";
            const current = update.scopeKey === analysisSearchKey() && update.receipt?.revision === state.revision
                && assessmentFactories.liveSearch.contract.analysisReceipt(update.receipt);
            if (update.state === "ready" && current) {
                semanticComplete = update.complete === true;
                semanticMembership = assessmentFactories.liveSearch.membership(state, applied, route.withinServices?.split(",") || [],
                    semanticComplete ? update.hits : [], update.receipt);
                semanticBound = semanticComplete;
                semanticStatus = semanticComplete ? "ready" : "partial";
            } else {
                semanticMembership = unavailableSearchMembership();
            }
            $("wireAnalysisSearchNotice").hidden = false;
            $("wireAnalysisSearchNotice").textContent = update.state === "ready" && current
                ? `Search / Current Analyze scope: ${semanticQuery}. ${semanticComplete ? "Current search matches across all pages." : "Partial searchable coverage; analytical measures and current-view report preparation are unavailable."} Navigation hits do not change membership.`
                : `Search / Current Analyze scope: ${semanticQuery}. ${update.state === "pending" ? "Waiting for verified membership; analytical counts are not displayed yet." : "Membership cleared because local search is not current."} Current-view report preparation is unavailable.`;
            render();
        },
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
    let ignoringStaleContextStatus = false;
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
            if (ignoringStaleContextStatus) return;
            draft.clearContext({ authority: true, writing: exportWriting });
            scrubContextPreview();
            invalidatePreview();
            invalidateDialog("Recorded evidence, permission or feedback changed. Prepare a new report preview.");
        },
    });
    function scrubContextPreview() {
        for (const bundle of renderedContextBundles) {
            for (const copy of bundle.contextReview ?? []) if (copy.kind === "response") {
                copy.original = copy.text = null;
                copy.segments = [];
            }
            for (const entry of bundle.snapshot?.recordedContext?.entries ?? []) if (entry.kind === "response") entry.text = null;
            bundle.previewHtml = "";
            bundle.files = {};
        }
        renderedContextBundles.clear();
        const body = $("reportReviewBody");
        if (body?.dataset.recordedContext !== "true") return;
        preparedReportReader?.dispose();
        preparedReportReader = null;
        for (const frame of body.querySelectorAll(".report-frame")) frame.srcdoc = "";
        body.replaceChildren();
        delete body.dataset.recordedContext;
    }
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
        root: $("periodComparison"), setup: $("periodComparisonSetup"), toggle: $("comparePeriods"), api, time, search: localSearch, categories, results,
        projection: createActivityProjection(time, categories, resultKeys),
        createState: assessmentFactories.periodComparison.createState, assessmentFactories, bindDetails,
        getContext: () => ({ snapshot: state, options: query(), route, search, isLoading, isStale, readingIntent,
            semanticSearch: semanticQuery === null ? undefined : {
                status: semanticStatus,
                receipt: semanticBound ? semanticMembership?.receipt : undefined,
                scenarioIds: semanticMembership?.scenarioIds ?? [], actionIds: semanticMembership?.actionIds ?? [],
                parentScenarioIds: semanticMembership?.parentScenarioIds ?? [], coverage: "whole-retained-corpus",
                ...(search.trim() ? { withinScenarioIds: analysisSlice.legacyScenarioIds(state, search) } : {}),
            } }),
        navigate: changes => navigate(routeFor("analyze", changes), false, { keepFocus: true }),
        onSearch: value => { $("activitySearch").value = value; $("activitySearch").dispatchEvent(new Event("input")); },
        openSearch: () => liveSearchUI.analysisScope(),
        syncFilters: () => selectControls?.sync(),
        createReport: (value, semanticSelection) => {
            if (reportJourney?.snapshot().saveUnconfirmed) { announce(reportJourney.reason(1), "stale"); return; }
            if (exportWriting || isLoading || isStale) return;
            const ids = [...new Set(Object.values(value.periods).flatMap(side => side.scenarioIds))];
            if (!ids.length) { announce("Neither period has matching retained records. Choose periods with activity before creating a report.", "error"); return; }
            clearReportSelection();
            periodReport = { value, semanticSelection, returnTo: { ...route, search }, timeContext: structuredClone(viewerTime) };
            periodReportInvalid = false;
            for (const id of ids) selected.add(id);
            draft.clearSelection();
            go("reports", { task: "create", request: undefined });
        },
        recordLink: (row, side, value) => link(row.tool, "request", {
            request: row.scenarioId, call: row.id, callRevision: value.definitions.layer === "reported-api" ? String(value.revision) : undefined,
            range: "custom", from: side.range.from, to: side.range.to,
        }, "text-link"),
    });
    function clearDeletedDraft(change = "changed") {
        assessmentUI.invalidate(`Collected activity or its optional evidence was ${change}. Read current insights.`);
        reportComparisonUI?.invalidate("Collected activity changed. The unfinished comparison was cleared.", true, { force: true });
        selected.clear();
        periodReport = null; periodReportInvalid = false;
        reportScope = "selected";
        reportEntry = null;
        draft.clearSelection();
        invalidatePreview();
        invalidateDialog(`Collected activity was ${change}. This report preview is no longer available.`);
        reportJourney?.clear();
        $("detail").replaceChildren();
    }
    function invalidatePreview(message) {
        if (message !== "" || !$("reportReviewBody")?.dataset.recordedContext || !draft.contextCurrent(draft.contextToken())) {
            draft.clearContext({ writing: exportWriting });
            scrubContextPreview();
        }
        if (exportWriting) return;
        preparedReportReader?.dispose();
        preparedReportReader = null;
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
        if (navigationState?.evidenceView?.url === hash && navigationState.evidenceView.returnToSessions) values.returnToSessions = sessionJourney.returnRoute(navigationState.evidenceView.returnToSessions);
        if (navigationState?.evidenceView?.url === hash && navigationState.evidenceView.returnToResults) values.returnToResults = sessionJourney.returnRoute(navigationState.evidenceView.returnToResults, true);
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
        for (const [key, value] of Object.entries(next)) if (!["view", "search", "returnToSessions", "returnToResults", "localSearch", "settingsWarning"].includes(key) && value !== null && value !== undefined && value !== "" && !(value === "all" && ["project", "service", "result"].includes(key))) params.set(key, value);
        return "#" + next.view + (params.size ? "?" + params.toString() : "");
    }
    function routeFor(view, changes = {}) {
        view = sessionJourney.canonical({ view }).view;
        return {
            ...route, view,
            returnToResults: view === "request" ? route.returnToResults : undefined,
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
        const navigationState = { ...history.state, evidenceView: { url, search: next.search || "",
            returnToSessions: sessionJourney.returnRoute(next.returnToSessions),
            returnToResults: next.view === "request" ? sessionJourney.returnRoute(next.returnToResults, true) : undefined,
            localSearch: next.localSearch } };
        if (replace) history.replaceState(navigationState, "", url);
        else history.pushState(navigationState, "", url);
    }
    function navigate(next, replace = false, options = {}) {
        next = canonicalRoute(next);
        if (next.view === "request" && !options.fromSearch) {
            searchOpenedRequest = null;
            searchReturnMarker = null;
        }
        if (next.view === "request" && route.view !== "request") {
            next = { ...next, returnToResults: sessionJourney.returnRoute({ ...route, search }, true) };
        }
        rememberRoute(next, replace);
        return applyRoute(next, options);
    }
    function link(label, view, changes = {}, cls = "") {
        const node = el("a", cls, label);
        node.href = routeUrl(routeFor(view, changes));
        node.addEventListener("click", (event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            go(view, changes);
        });
        return node;
    }
    function routeLink(label, next, cls = "text-link", options = {}) {
        const node = el("a", cls, label);
        node.href = routeUrl(next);
        node.addEventListener("click", event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (next.session) presentation.setOpen("session:" + next.session, true);
            const pending = navigate(next, false, { restorePosition: next.view === "collection-status" && route.view === "analyze" && Boolean(route.session), ...options });
            if (options.searchReturn) {
                const navigation = navigationGeneration, intent = readingIntent;
                Promise.resolve(pending).then(loaded => {
                    if (loaded && navigation === navigationGeneration && intent === readingIntent && !liveSearchUI.restore(options.searchReturn)) {
                        announce("The earlier search is no longer available. Search again to see current results.", "stale");
                    }
                });
            }
        });
        return node;
    }
    function sessionsRoute() {
        return sessionJourney.returnRoute(route.returnToSessions) || routeFor("analyze", { session: undefined, page: undefined, returnToSessions: undefined });
    }
    function sessionRoute(sessionId, result) {
        return { ...filterState.scope(route, sessionJourney.open(route, sessionId, result)), search,
            mode: result ? "calls" : route.mode, callSort: route.callSort,
            returnToSessions: sessionJourney.returnRoute({ ...route, search }) };
    }
    function sessionSource(sessionId = route.session || state?.scenarios.find(s => s.scenarioId === route.request)?.sourceSessionId) {
        const source = state?.sessions?.find(s => s.sessionId === sessionId);
        if (source) return source;
        const scenario = state?.scenarios.find(s => s.sourceSessionId === sessionId);
        return sessionId ? { sessionId, name: scenario?.sourceSessionName || chatCopy.unnamed, projectId: scenario?.projectId, project: scenario?.project,
            missing: !scenario } : null;
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
        if (reportJourney?.snapshot().saveUnconfirmed) { announce(reportJourney.reason(1), "stale"); return; }
        const source = sessionSource(), requestIds = sessionJourney.reportIds(state?.exportCatalog, source?.sessionId);
        if (isLoading || isStale || requestIds === null) { announce("Copilot chat report scope is unavailable. Refresh before selecting request groups.", "error"); return; }
        if (!requestIds.length) { announce("No eligible collected request groups are available for this Copilot chat. Check its collection coverage or choose another Copilot chat."); return; }
        selected.clear();
        periodReport = null; periodReportInvalid = false;
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
    function resultLine(layer, summary, { total, scope = "Recorded results", label, help: explanation, sessionId, heading, compactSingle = false, pillsOnly = false } = {}) {
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
        const compact = pillsOnly || compactSingle && summary.count === 1;
        const unit = el("strong", "result-unit");
        unit.append(metadata.item(label || results.countLabel(layer, summary.count, total), explanation ? { helpLabel: "recorded tool result", help: explanation } : {}));
        const values = heading && !compact ? el("div", "result-values") : node;
        if (compact) {
            node.classList.add("result-inline");
            node.setAttribute("aria-label", `${heading || scope}: ${results.countLabel(layer, summary.count, total)}`);
        } else if (heading) {
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
            item.append(ux.icon(`${entry.icon}-compact`), el("span", "recorded-result-label", `${count(entry.count)} ${entry.label}`));
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
    function matchingResults(scenarioId, { compact = false } = {}) {
        const rows = rowsFor(scenarioId), full = results.summarize(fullRowsFor(scenarioId));
        const matching = results.summarize(rows);
        const node = resultLine(applied.layer, matching, { total: full?.count ?? null, scope: "Matching results only", pillsOnly: compact });
        if (compact && full && matching && matching.count !== full.count) {
            node.prepend(el("span", "card-result-scope", `${count(matching.count)} of ${count(full.count)} ${results.unit(applied.layer, full.count)} in this view`));
        }
        return node;
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
    function actionFields(call, row, { includeTool = true, includeService = true, includePurpose = true, includeMissing = true, returned = false } = {}) {
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
            } else {
                const cue = serviceCue("span", row?.workload, categoryPresentation(row)), scope = categories.requestedSearchScope(call);
                cue.lastElementChild.textContent = categoryPresentation(row).label;
                if (scope) cue.lastElementChild.replaceChildren(metadata.item(cue.lastElementChild.textContent,
                    { help: `${scope.label}. ${scope.description}` }));
                service.append(cue);
            }
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
            if (includeMissing) {
                pathField(list, "Downstream API path", null, "Not recorded");
                list.append(el("dt", "", "HTTP method"), el("dd", "", "Not recorded"),
                    el("dt", "", "API version"), el("dd", "", "Not recorded"));
            }
        } else if (!discovery || operation.pathLabel) {
            const paths = results.callPaths(call);
            paths.forEach((path, index) => {
                if (path !== null || includeMissing) pathField(list, discovery ? operation.pathLabel : paths.length > 1 ? `API path ${index + 1}` : "API path", path);
            });
        }
        return list;
    }
    function responseTimingFact(scenario) {
        const timing = requestTiming.response(scenario.scenarioId, state.assessment);
        const value = el("span"), field = cardFact("Final response", value);
        field.classList.add("response-timing");
        if (timing.status === "measured") {
            const duration = el("data", "", timingPresentation.duration(timing.durationMs));
            duration.value = String(timing.durationMs);
            value.append(duration);
        } else if (timing.status === "error") {
            const error = el("span", "action-error", "Timing could not be read");
            error.setAttribute("role", "alert");
            value.append(error);
        } else value.textContent = "Not recorded";
        return field;
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
        return { layer: route.layer || "tool", groupBy: route.chart === "endpoint" ? "endpoint" : "workload", bucket: filterState.bucket(route), filters: filterState.query(route), limit: 8, timeContext: viewerTime };
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
        const refreshRead = background && !afterExport ? fresh.snapshot() : null;
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
            liveSearchUI?.invalidate("The stored view could not be verified. Search results were cleared.");
            assessmentUI.clearPrivateText();
            isStale = Boolean(analytics);
            isLoading = false;
            if (error.reason === "runtime_unavailable") collectionUnavailable(error.message, error.reason);
            if (fresh.snapshot().phase === "applying") fresh.fail(fresh.snapshot().token, error.message, { reason: error.reason });
            refreshReadFailure = analytics && refreshRead?.phase === "applying"
                ? { generation: request, token: refreshRead.token, checkId: refreshRead.check?.id } : null;
            renderFreshActivity();
            $("loading").hidden = true;
            const offline = error.reason === "runtime_unavailable";
            if (!refreshOwnsReadFailure()) {
                announce(offline
                    ? (analytics ? "Local runtime unavailable. Showing the last recorded snapshot. " : "Your activity could not load. ")
                        + "Start WIRE if it is stopped, then retry."
                    : (analytics ? "This view could not update. The last recorded snapshot is shown. " : "Your activity could not load. ") + error.message,
                analytics ? "stale" : "error", true);
                if (offline) $("message").dataset.connectionFailure = "true";
            }
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
        sidebar.close(false);
        if ($("overlay").open) $("overlay").close();
        const before = JSON.stringify(query());
        if (["range", "from", "to"].some(key => route[key] !== next[key])) dateDraft = null;
        route = canonicalRoute(next);
        rememberRoute(route, true);
        search = route.search || "";
        activityPage = Math.max(0, Number.parseInt(route.page || "0", 10) || 0);
        syncControls();
        $("resetView").hidden = route.view !== "analyze";
        $("resetView").disabled = !viewChanged();
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
                project: "projectFilter", session: "chatFilter", layer: "layerFilter", scope: "scopeFilter", result: "outcomeFilter", authors: "promptAuthorFilter", from: "dateFilter", to: "dateFilter" };
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
        periodReturnReading = restorePosition && route.view === "analyze" && route.compare === "periods" && position
            ? { position, navigation, intent } : null;
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
        const defaults = { view: "analyze", chart: "time", range: "capture", layer: "tool", scope: "history", page: "0" };
        return Object.entries(route).some(([key, value]) => !["localSearch", "settingsWarning", "bucket"].includes(key) && value !== undefined && value !== null && value !== "" && !(value === "all" && ["project", "service", "result"].includes(key)) && String(value) !== defaults[key]);
    }
    async function resetView() {
        const next = { view: "analyze", ...(route.bucket ? { bucket: route.bucket } : {}) };
        await navigate(next, false, { reset: true });
    }
    let refreshReadFailure = null;
    let deferredReviewIdentity = null;
    function refreshOwnsReadFailure() {
        const current = fresh.snapshot();
        return refreshReadFailure?.generation === generation && refreshReadFailure.token === current.token
            && refreshReadFailure.checkId === current.check?.id && current.phase === "error";
    }
    function renderDeferredReviewNotice() {
        const model = fresh.snapshot();
        const checkIdentity = model.phase === "waiting" && model.check
            ? JSON.stringify([model.token, model.check.id, model.check.configVersion]) : null;
        if (deferredReviewIdentity?.check !== checkIdentity) deferredReviewIdentity = checkIdentity ? { check: checkIdentity, previewId: null } : null;
        const eligible = model.phase === "waiting" && model.check && !model.sourceUnknown && !model.sourceBlocked
            && !collectionReadError && !collectionSettings?.hasDraft() && model.check.configVersion === collection?.configVersion
            && reportJourney?.snapshot().hasPreview && activePreview?.previewId;
        // Navigation may retain this binding; a replacement preview cannot inherit it.
        if (eligible && deferredReviewIdentity.previewId === null && reportJourney.isReviewOpen()) deferredReviewIdentity.previewId = activePreview.previewId;
        const owns = Boolean(eligible && deferredReviewIdentity.previewId === activePreview.previewId);
        $("freshActivity").dataset.deferredReview = String(owns);
        $("freshAwayNotice").dataset.deferredReview = String(owns);
        if (model.phase === "waiting" && !model.sourceUnknown && !model.sourceBlocked) setText($("freshAwayStatus"), owns
            ? " Waiting to apply recorded activity. Your report preview stays frozen; finish the review or edits before applying it."
            : " Waiting until the current review or edits finish.");
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
        const model = fresh.snapshot(), localRecovery = model.recovery === "stored" || model.phase === "error" && !model.sourceFailure;
        const globalRecovery = !$("message").hidden && $("message").querySelector("[data-stored-refresh-retry]");
        const collectionRecovery = collectionReadError && $("collectionRetry").parentElement.checkVisibility();
        const needsRecovery = localRecovery || collectionReadError || isStale && !isLoading;
        $("storedRefresh").hidden = Boolean(globalRecovery) || !needsRecovery || !localRecovery && Boolean(collectionRecovery);
        $("collectionRetry").hidden = !collectionReadError || Boolean(globalRecovery) || !$("storedRefresh").hidden;
        setText($("storedRefreshHelp"), reviewing
            ? "Finish this report, or change its choices in Setup, before refreshing."
            : editing ? "Save or cancel your Settings edits before refreshing."
            : exportWriting ? "The saved report will be shown when its current write finishes."
            : "Read stored activity and current status.");
        $("storedRefreshHelp").hidden = !reviewing && !editing && !exportWriting;
        renderDeferredReviewNotice();
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
            const fallback = $("checkActivity").checkVisibility() ? $("checkActivity")
                : $("freshAwayLink").checkVisibility() ? $("freshAwayLink") : $("pageTitle");
            ux.restoreFocus(initiator.checkVisibility() && !initiator.disabled ? initiator : fallback);
        }
        return loaded;
    }
    function renderNavigation() {
        $("wireAnalysisSearchNotice").hidden = semanticQuery === null || route.view !== "analyze";
        const active = route.view === "request" ? "analyze" : route.view === "collection-status" ? "settings" : route.view;
        document.querySelectorAll("[data-nav]").forEach((node) => {
            const view = node.dataset.nav;
            node.href = routeUrl(routeFor(view, { request: undefined, task: undefined }));
            if (view === active && node.closest("nav")) node.setAttribute("aria-current", "page");
            else node.removeAttribute("aria-current");
        });
        const settings = route.view === "settings", operational = route.view === "collection-status", configurationOrStatus = settings || operational;
        for (const [view, ids] of Object.entries({ analyze: ["homeView", "activityView"], request: ["requestView"], reports: ["reportsView"], settings: ["settingsView"], "collection-status": ["collectionStatusView"] })) {
            for (const id of ids) $(id).hidden = route.view !== view || view === "analyze" && semanticQuery !== null && !semanticBound;
        }
        $("resultsLink").hidden = route.view !== "analyze" || semanticQuery !== null && !semanticBound;
        $("filters").hidden = configurationOrStatus || route.view === "request" || route.view === "reports";
        $("projectContextHelp").hidden = configurationOrStatus || route.view === "reports";
        $("filterChips").hidden = configurationOrStatus || route.view === "reports" || route.view === "request";
        $("coverage").hidden = configurationOrStatus || route.view === "request";
        $("coverageNotice").hidden = configurationOrStatus;
        $("activityCollectionLink").hidden = !["analyze", "request"].includes(route.view);
        $("settingsDraftNotice").hidden = settings || !collectionSettings?.hasDraft();
        renderSettingsNavigation();
        syncLocalSearchFields();
        renderCollectionNotice();
        renderFreshActivity();
        const selectedRequest = state.scenarios.find(scenario => scenario.scenarioId === route.request);
        const titles = {
            analyze: ["Analyze", ""],
            request: [selectedRequest ? route.call ? "Call in context" : "Interaction" : "Interaction unavailable", ""],
            reports: [route.task === "create" ? "Create a report" : "Reports", ""],
            settings: ["Settings", ""],
            "collection-status": ["Collection status", ""],
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
            $("pageProject").append(el("p", "context-source", source.missing
                ? "This source is not in the retained collection. Clear its filter to see other records."
                : (applied.layer === "http" ? "Filtered to recorder source: " : "Filtered to chat: ") + source.name));
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
        $("resetView").hidden = configurationOrStatus || route.view === "reports" || route.view === "request";
        $("resetView").disabled = !viewChanged();
        const resetHost = route.view === "analyze" ? $("filterTools") : $("scopeResetActions");
        if ($("resetView").parentElement !== resetHost) resetHost.append($("resetView"));
        $("scopeResetActions").hidden = true;
        renderStoredRefresh();
        const returnRoute = route.view === "analyze" && route.session ? sessionsRoute()
            : route.view === "request" ? sessionJourney.returnRoute(route.returnToResults, true) || { view: "analyze" } : null;
        const searchReturn = route.view === "request" && route.request === searchOpenedRequest && liveSearchUI.canRestore(searchReturnMarker) ? searchReturnMarker : null;
        const returnLabel = searchReturn ? "Back to search" : returnRoute?.view === "collection-status" ? "Back to history gaps"
            : route.view === "analyze" ? route.returnToSessions ? "Back to results" : applied.layer === "http" ? "Clear source filter" : "Clear chat filter"
            : returnRoute?.view === "reports" ? "Back to report scope"
            : returnRoute?.view === "settings" ? "Back to Settings"
            : route.returnToResults ? "Back to results" : "Back to Analyze";
        const returnKey = JSON.stringify([returnRoute, returnLabel, searchReturn]);
        if (returnKey !== contextReturnKey) {
            const back = returnRoute ? routeLink(returnLabel, returnRoute, "button-link", { restorePosition: true, searchReturn }) : null;
            if (back) {
                back.id = "contextBack";
                if (route.view === "request") {
                    back.classList.add("reader-back");
                    back.prepend(ux.icon("back"));
                }
            }
            $("contextReturn").replaceChildren(...(back ? [back] : []));
            contextReturnKey = returnKey;
        }
        if ($("contextReturn").parentElement !== $("pagePrimaryActions")) $("pagePrimaryActions").prepend($("contextReturn"));
        $("contextReturn").hidden = !returnRoute;
        const reports = route.view === "reports";
        const inactiveClear = reports ? $("activityClearSelection") : $("reportClearSelection");
        const inactiveHost = reports ? $("reportSelectionBar") : $("reportSelectionActions");
        if (inactiveClear.parentElement !== inactiveHost) inactiveHost.append(inactiveClear);
        const contextHost = reports ? $("reportPreviewContext") : $("reportSelectionBar");
        if ($("pageHeadingActions").parentElement !== contextHost) contextHost.append($("pageHeadingActions"));
        const activeClear = reports ? $("reportClearSelection") : $("activityClearSelection");
        if (activeClear.parentElement !== $("pageHeadingActions")) $("pageHeadingActions").append(activeClear);
        const selectionHost = route.view === "analyze" ? $("analyzeResultActions") : route.view === "request" ? $("requestView") : document.querySelector(".page-heading");
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
        setText($("reportCreateLink"), current?.saveUnconfirmed ? "Save status" : unfinished ? "Continue draft" : "Create a report");
        $("reportCreateLink").hidden = creating;
        $("reportLibraryLink").hidden = !creating;
        setText($("reportLibraryLink"), creating ? "Back to Reports" : "Saved reports");
        $("reportCreateLink").classList.toggle("primary", Boolean(!creating && state && !state.exports?.length && !isLoading && !isStale));
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
        if (host.contains(collectionLink)) $("freshHelpBody").append(collectionLink);
        host.hidden = route.view !== "request" || semanticQuery !== null && !semanticBound;
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
        if (route.view === "request") {
            host.hidden = true;
            host.replaceChildren();
            return;
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
            endpoint: "API path", session: "Copilot chat", layer: "Activity", scope: "Collection" };
        const selectedLabel = id => $(id).selectedOptions[0]?.textContent;
        for (const [key, label] of Object.entries(labels)) {
            const selectedValue = key === "authors" && applied ? authorship.filterValue(applied.filters.promptAuthors) : route[key];
            if (!selectedValue || key === "scope" && selectedValue === "history" || key === "layer" && selectedValue === "tool") continue;
            const value = key === "authors" ? authorship.selectionLabel(selectedValue) : key === "result" ? resultNames(resultSelection(selectedValue))
                : key === "scope" ? scopeLabels[selectedValue] : key === "project" ? selectedLabel("projectFilter")
                    : key === "session" ? selectedLabel("chatFilter") : key === "layer" ? selectedLabel("layerFilter")
                        : key === "endpoint" ? "Selected path"
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
        $("serviceFocus").hidden = !focused || route.view !== "analyze";
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
        $("periodFeedback").hidden = route.view !== "analyze" || semanticQuery !== null && !semanticBound;
        if ($("periodFeedback").hidden) return;
        const rows = selectionRows();
        const model = periodFlow({ rows, filters: applied.filters, coverage: state.collection?.config?.approved ? state.collection.checkedWindow : state.coverage, timeContext: applied.timeContext, session: Boolean(route.session), stale: isStale, layer: applied.layer, unit: results.unit(applied.layer, rows.length) });
        $("periodFeedback").classList.add("home-period-summary");
        setText(homeCount, count(rows.length));
        setText(homeUnit, results.unit(applied.layer, rows.length));
        $("periodResult").replaceChildren(...(isStale ? ["Previous results: "] : []), homeCount, " ", homeUnit, ` (${model.caption})`);
        $("periodResult").dataset.revision = String(state.revision);
        setText($("periodHint"), isStale ? "The update failed. The last applied period is still shown; retry before using these results."
            : !state.scenarios.length && !collection?.config ? "No activity has been collected."
                : model.requests ? `${count(model.requests)} ${applied.layer === "http" ? "record group" : "interaction"}${model.requests === 1 ? "" : "s"} · ${applied.layer === "http" ? `${count(model.sessions)} recorder sources` : chatCopy.count(model.sessions)}`
                    : model.next);
        $("periodHint").hidden = !rows.length && !isStale;
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
        const countsAvailable = semanticQuery === null || semanticBound;
        const resultOptions = choices.map(key => [key, applied.layer === "code-reference" && key !== "unknown" ? `Previous: ${results.labels("tool")[key]}` : resultLabels[key], countsAvailable ? totals[key] : null]);
        $("outcomeFilter").dataset.allLabel = countsAvailable ? `All results (${count(totals.count)})` : "All results (counts unavailable)";
        const signature = JSON.stringify([applied.layer, resultOptions]);
        if ($("outcomeFilter").dataset.optionsSignature !== signature) {
            $("outcomeFilter").replaceChildren(...resultOptions.map(([key, label, total]) => option(key, `${label} (${total === null ? "count unavailable" : count(total)})`)));
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
        $("homeView").dataset.empty = String(analytics.totals.count === 0 && !slice.scenarios.length
            && !isLoading && !isStale && (semanticQuery === null || semanticBound && semanticComplete));
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
        $("chartTitle").textContent = chartType === "time" ? "Activity over time" : chartType === "workload" ? layer === "tool" ? "Activity categories" : "Service categories" : layer === "tool" ? "Paths and operations" : "API paths requested";
        const notes = $("chartReadingNotes");
        const reading = el("dl");
        for (const [label, text] of [
            ["Chart scale", chartType === "time"
                ? "Time columns and their recorded-result sections use a linear count scale from zero; small values are not enlarged. Count links and the exact-data table remain usable when a section is too small to see. Percentage charts also preserve actual shares."
                : "Bars use a linear count scale from zero. Counts, shares and result sections are not enlarged. Full labels and exact-data links remain usable even for tiny values."],
            ["Chart colors", chartType === "workload" ? `Color identifies the ${layer === "tool" ? "activity category" : "service"}, not its result.` : "Colors match the recorded results."],
            ["Dates and grouping", chartType === "time"
                ? `${help.fields.timeGrouping} Weeks start Monday; daylight-saving changes follow the display time zone in Settings. Zero means no matching records, not proof that no activity occurred. Scroll horizontally for more dates when needed, or use the exact data below.`
                : chartType === "workload" && layer === "tool" ? help.charts.activityCategory : help.charts[chartType]],
            ["Evidence limits", `${explanations[layer]} Review labels and relevance assessments do not change recorded results.${layer === "tool" ? " Tool completion is not an observed Graph HTTP response." : ""}`],
        ]) reading.append(el("dt", "", label), el("dd", "", text));
        notes.replaceChildren(reading);
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
        $("serviceDefinitions").replaceChildren(el("h3", "", layer === "tool" ? "Activity categories" : "Service categories"), glossary);
        $("serviceDefinitions").hidden = !definitions.length;
        const chartRows = chartType === "time" ? analytics.timeSeries?.points?.length || 0 : analytics.groups.length;
        $("chartDataTitle").textContent = `${$("chartTitle").textContent} (${count(chartRows)} ${chartRows === 1 ? "row" : "rows"})`;
        bindDetails($("meaning"), "meaning", open => {
            if (open) renderCountTable();
            else $("countTable").replaceChildren();
        });
        percentages.update(analytics, { ...applied, search: Boolean(search), withinServices: route.withinServices?.split(",") || [] }, slice.scenarios);
    }
    function renderTime() {
        const series = analytics.timeSeries;
        if (!series?.points?.length) {
            $("chart").append(empty("No dated activity is available", "The captured records do not include usable dates for this slice. Service and API-path views remain available."));
            if (series?.undatedCount) $("chartFooter").append(el("span", "", `${count(series.undatedCount)} undated records are not plotted.`));
            return;
        }
        const points = series.points;
        const chart = dimensional.timeView({
            points, label: point => date(point.date),
            unit: total => results.columnUnit(applied.layer, total),
            summary: point => `${date(point.date, true)}${point.endDate && point.endDate !== point.date ? " - " + date(point.endDate, true) : ""}: ${count(point.total)} ${results.unit(applied.layer, point.total)}. ${groupSummary(point)}.`,
            createAction: point => link("", "activity", { range: "custom", from: point.from, to: point.to, page: undefined }),
            inspect: inspectColumnSection,
        });
        chart.removeAttribute("aria-label");
        chart.setAttribute("aria-labelledby", "chartTitle");
        chart.setAttribute("aria-describedby", "chartReadingNotes");
        viewKey(chart, "chart:time");
        chart.querySelectorAll(".time-slot").forEach((slot, index) => viewKey(slot.firstElementChild, "chart:time:" + points[index].date));
        $("chart").append(chart);
        dimensional.refreshView(chart);
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
        chart.tabIndex = 0;
        chart.setAttribute("aria-label", $("chartTitle").textContent);
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
    function servicesFor(rows) { return [...new Set(rows.map(row => categoryPresentation(row, applied.layer).label))].join(", ") || serviceLabel("Unknown"); }
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
        setText($("homeInsightScope"), `${chatCopy.groups(ids.size, applied.layer === "http")} across all pages; full retained interactions, not only matched ${results.unit(applied.layer, 2)}.`);
        assessmentUI.overview(host, [...ids], { findingsHost: $("homeFindings"),
            matchedCallCount: applied.layer === "tool" ? rows.length : null });
    }
    function revealResults() {
        $("activityTitle").focus({ preventScroll: true });
        $("activityView").scrollIntoView({ block: "start" });
    }
    function revealSessionResult() {
        if (route.view === "request" && route.call !== undefined) {
            const target = $("selectedCall") || $("unavailableCall");
            if (!target) return false;
            const navigation = navigationGeneration, intent = readingIntent, body = $("requestContent");
            const events = new AbortController();
            let frame;
            const stop = () => {
                cancelAnimationFrame(frame);
                observer.disconnect();
                events.abort();
            };
            const schedule = () => {
                cancelAnimationFrame(frame);
                frame = requestAnimationFrame(() => {
                    if (navigation !== navigationGeneration || intent !== readingIntent
                        || !target.isConnected || document.activeElement !== target) { stop(); return; }
                    target.scrollIntoView({ block: "start" });
                    if (!body.querySelector('[aria-busy="true"]')) stop();
                });
            };
            // Retained findings/replies can move this anchor after the initial render.
            const observer = new MutationObserver(schedule);
            observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
            for (const type of ["pointerdown", "wheel", "touchmove", "keydown"]) {
                document.addEventListener(type, event => { if (event.isTrusted) stop(); }, { capture: true, passive: true, signal: events.signal });
            }
            window.addEventListener("pagehide", stop, { once: true, signal: events.signal });
            target.focus({ preventScroll: true });
            schedule();
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
        host.hidden = route.view !== "analyze" || !route.session || semanticQuery !== null && !semanticBound;
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
        const coverage = source.missing ? "No retained records identify this source."
            : source.unavailable ? "Saved history is unavailable. Previously collected evidence is shown; reports may omit unread history."
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
        const unavailable = items.length - timed;
        $("callTimingScope").textContent = unavailable ? `${count(unavailable)} unavailable; listed last.` : "";
        $("callTimingScope").hidden = unavailable === 0;
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
        const groups = `${count(scenarios.length)} ${applied.layer === "http" ? "record group" : "interaction"}${scenarios.length === 1 ? "" : "s"}`;
        $("activityListSummary").textContent = (calls
            ? `${count(selectionRows().length)} ${results.unit(applied.layer, selectionRows().length)} from ${groups}.`
            : `${groups} with ${count(selectionRows().length)} matching ${results.unit(applied.layer, selectionRows().length)}.`)
            + (unlinked ? ` ${count(unlinked)} records have no retained interaction; they remain available in Calls.` : "");
        $("activityListSummary").hidden = selectionRows().length === 0;
        host.replaceChildren();
        activityPage = Math.min(activityPage, Math.max(0, Math.ceil(items.length / pageSize) - 1));
        if (!items.length) {
            host.append(empty(!state.scenarios.length ? "No collected activity yet" : `No matching ${noun}`,
                state.scenarios.length
                    ? search ? "Try another phrase or clear Search." : "Change filters or reset Analyze."
                    : search ? "Try a different phrase or clear the private search. Other filters and report selections stay."
                        : "Change a filter or use Reset Analyze. Source approval and collection settings stay unchanged."));
        }
        for (const item of items.slice(activityPage * pageSize, (activityPage + 1) * pageSize)) {
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
        const card = viewKey(el("article", "matched-action activity-card"), "action:" + row.id);
        card.dataset.actionId = row.id;
        card.dataset.sessionId = row.sourceSessionId;
        const call = sourceCallFor(row);
        const recordedLabel = applied.layer === "code-reference" ? "Reference recorded" : applied.layer === "reported-api" ? "Parent call recorded"
            : ["direct-request", "recorded-http"].includes(applied.layer) ? "Request site recorded" : "Action recorded";
        if (scenario) card.append(textAccess.render(scenario.userPrompt, { key: "action:" + row.id, originKind: authorship.originKind(scenario), compactProvenance: true, inlinePreview: true,
            navigationNode: link(applied.layer === "tool" ? "Open exact call in context" : "Open exact record in context",
                "request", { request: scenario.scenarioId, call: row.id,
                    callRevision: applied.layer === "reported-api" ? String(state.revision) : undefined }, "request-link text-link"),
        }));
        else card.append(el("p", "muted", "Full request details were not retained."));
        const composition = el("div", "card-details"), activity = el("div", "card-activity");
        const details = el("dl", "activity-card-facts");
        details.append(cardFact("Tool", cardTools([row], false)));
        let fields;
        if (["tool", "reported-api"].includes(applied.layer)) fields = actionFields(call, row, { includeTool: false, returned: applied.layer === "reported-api" });
        else {
            fields = el("dl", "action-fields");
            fields.append(el("dt", "", "Service"), serviceHeading("dd", row.workload));
            const graph = scenario?.graphActivities?.find(item => item.activityId === row.activityId);
            const http = scenario?.httpRecords?.find(item => item.recordId === row.recordId);
            pathField(fields, applied.layer === "code-reference" ? "Referenced API path" : "API path",
                results.pathText(graph?.endpoint ?? http?.responsePath ?? http?.path ?? http?.requestedPath ?? http?.requestShape?.path));
        }
        for (const term of [...fields.querySelectorAll(":scope > dt")]) {
            const value = term.nextElementSibling, group = el("div");
            term.textContent = cardKey(term.textContent);
            group.append(term, value);
            details.append(group);
        }
        const measured = callInvestigation.duration(row, applied.layer);
        details.append(cardFact(applied.layer === "tool" ? "Call duration" : applied.layer === "reported-api" ? "API result duration" : "Record duration",
            durationValue(measured)),
        cardFact(recordedLabel, time.formatMoment(row.startedAt, applied.timeContext)));
        if (analytics.serviceInvolvement?.selection.contextOnlyIds.includes(row.id)) details.append(cardFact("Service scope",
            el("span", "service-context-label", "Missing-service context, not a known match to the selected service.")));
        const outcome = resultLine(applied.layer, results.summarize([row]), { heading: results.heading(applied.layer), pillsOnly: true });
        outcome.classList.add("card-outcomes");
        activity.append(details, outcome);
        if (["failure", "transport"].includes(row.outcome)) {
            const reason = applied.layer === "http" && row.outcome === "transport" ? "Connection failed; no HTTP response was recorded."
                : applied.layer === "tool" ? recordedFailure(call, true)
                : row.status ? `${applied.layer === "reported-api" ? "Tool-reported" : "Recorded"} HTTP ${row.status}. Response body was not retained.`
                    : recordedFailure(call, true);
            activity.append(el("p", "card-result-note action-error",
                Object.values(help.failureEvidence).includes(reason) ? "Failure reason unavailable." : reason));
        } else if (row.status) {
            activity.append(el("p", "card-result-note", `${applied.layer === "reported-api" ? "Tool-reported" : "Recorded"} HTTP ${row.status}`));
        }
        composition.append(activity);
        if (scenario) {
            const context = el("dl", "activity-card-facts card-context");
            appendCardSource(context, scenario, { callContext: true });
            composition.append(context);
        }
        card.append(composition);
        return card;
    }
    function cardKey(label) {
        return label.trimEnd().replace(/:+$/, "") + ":";
    }
    function cardFact(label, value) {
        const row = el("div"), definition = el("dd");
        definition.append(value);
        row.append(el("dt", "", cardKey(label)), definition);
        return row;
    }
    function durationValue(milliseconds) {
        if (milliseconds === null) return el("span", "call-duration", "Not recorded");
        const value = el("data", "call-duration", timingPresentation.duration(milliseconds));
        value.value = String(milliseconds);
        return value;
    }
    function originalModelFact(scenario, { callContext = false } = {}) {
        const model = scenario.originalModel;
        const valid = model && ["Model", "Models"].includes(model.label) && typeof model.value === "string" && model.value.trim();
        return cardFact(callContext ? "Interaction model" : valid ? model.label : "Model",
            valid ? model.value : model ? "Not verified (invalid model metadata)" : "Not recorded");
    }
    function cardTools(rows, showCounts = true) {
        const tools = new Map();
        for (const row of rows) {
            const name = row.tool || "Tool not recorded";
            tools.set(name, (tools.get(name) || 0) + 1);
        }
        const list = el("ul", "interaction-tools");
        for (const [name, total] of tools) {
            const item = el("li");
            item.append(el("span", "card-tool-name", name));
            if (showCounts && (tools.size > 1 || total > 1)) item.append(document.createTextNode(" "),
                el("span", "card-tool-count", `(${count(total)} ${results.columnUnit(applied.layer, total)})`));
            list.append(item);
        }
        if (!tools.size) list.append(el("li", "", "No tool evidence in this view"));
        return list;
    }
    function appendCardSource(list, scenario, options = {}) {
        const source = sessionSource(scenario.sourceSessionId);
        const chat = el("span", "card-chat");
        if (source) {
            const action = routeLink(source.name, sessionRoute(source.sessionId), "text-link");
            action.setAttribute("aria-label", (applied.layer === "http" ? "Filter to recorder source: " : "Filter to chat: ") + source.name);
            chat.append(action);
            const reference = sourceReference(source);
            if (reference) chat.append(el("span", "source-reference", reference));
        } else chat.textContent = "Not recorded";
        list.append(cardFact(applied.layer === "http" ? "Recorder source" : options.compact ? "Chat" : "Copilot chat", chat));
        const project = source || scenario;
        const projectLabel = project.projectType === "folder" ? "Copilot folder project"
            : project.projectType === "repository" ? "Copilot repository project" : "Copilot project";
        if (!options.compact || project.projectId) list.append(cardFact(projectLabel, el("span", "project-context", project.projectId
            ? project.project || project.projectId : project.sessionId || project.sourceSessionId ? "No project associated" : "Not recorded")));
        const moment = requestTiming.entry(scenario, applied.timeContext);
        list.append(cardFact(options.compact && moment.label === "Message recorded" ? "Recorded" : moment.label, moment.value));
        if (options.includeModel !== false) list.append(originalModelFact(scenario, options));
    }
    function requestCard(scenario) {
        const rows = rowsFor(scenario.scenarioId), row = viewKey(el("article", "request-row activity-card"), "request:" + scenario.scenarioId);
        const content = el("div", "interaction-body");
        const requestLink = link("View interaction", "request", { request: scenario.scenarioId }, "request-link text-link");
        content.append(textAccess.render(scenario.userPrompt, { key: "activity:" + scenario.scenarioId, navigationNode: requestLink, originKind: authorship.originKind(scenario), compactProvenance: true, inlinePreview: true }));
        const services = [...new Set(rows.map(row => row.workload).filter(Boolean))];
        const presentations = rows.map(row => categoryPresentation(row, applied.layer));
        const sharedOperation = presentations.length && presentations.every(entry => entry.icon === "Assistance");
        const cue = serviceCue("span", services.length > 1 ? "Multiple workloads" : services[0] || "Unknown", sharedOperation ? presentations[0] : undefined);
        cue.lastElementChild.remove();
        const serviceText = servicesFor(rows);
        const requestedScopes = applied.layer === "tool" ? [...new Set(rows.map(row => {
            const scope = categories.requestedSearchScope(sourceCallFor(row));
            return scope ? `${scope.label}. ${scope.description}` : null;
        }).filter(Boolean))] : [];
        const meta = metadata.row([
            { label: serviceText, leading: cue, helpWithLabel: true, helpLabel: `${serviceText}; ${applied.layer === "tool" ? "recorded activity categories" : "recorded services"}`, help: [
                [...new Set(rows.map(row => {
                    const entry = categoryPresentation(row, applied.layer);
                    return `${entry.label}: ${entry.description}`;
                }))].join(" ") || categories.describe("Unknown").description,
                ...requestedScopes,
            ].join(" ") },
        ]);
        meta.classList.add("request-meta");
        const composition = el("div", "card-details interaction-details"), activity = el("div", "card-activity");
        const details = el("dl", "activity-card-facts"), context = el("dl", "activity-card-facts card-context");
        const tools = cardTools(rows);
        const category = cardFact(applied.layer === "tool" ? "Activity" : "Services", meta);
        category.classList.add("card-operation");
        details.append(category, responseTimingFact(scenario));
        if (!sharedOperation) {
            const toolFact = cardFact(tools.children.length > 1 ? "Tools" : "Tool", tools);
            toolFact.classList.add("card-tools");
            details.append(toolFact);
        }
        appendCardSource(context, scenario, { compact: true });
        const outcome = matchingResults(scenario.scenarioId, { compact: true });
        outcome.classList.add("card-outcomes");
        category.lastElementChild.append(outcome);
        activity.append(details);
        composition.append(activity, context);
        content.append(composition);
        const selection = el("label", "interaction-select");
        selection.append(selectionCheckbox(scenario));
        row.append(selection, content);
        return row;
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
    function selectionCheckbox(scenario, reportPicker = false) {
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.id = (reportPicker ? "report-select-" : "select-request-") + encodeURIComponent(scenario.scenarioId);
        if (reportPicker) checkbox.dataset.reportRequest = scenario.scenarioId;
        else checkbox.dataset.selectedRequest = scenario.scenarioId;
        const aliases = reportPicker ? state.exportCatalog.requests.find(request => request.scenarioId === scenario.scenarioId).aliases : [scenario.scenarioId];
        checkbox.checked = aliases.some(id => selected.has(id));
        checkbox.setAttribute("aria-label", "Select request for report: " + shorten(excerpt(scenario), 70));
        ux.tooltip(checkbox, help.actions.selectRequest);
        checkbox.addEventListener("change", () => setReportRequestSelected(scenario.scenarioId, checkbox.checked));
        return checkbox;
    }
    function renderRequest() {
        if (route.view !== "request") return;
        if (searchTargetInvalid && route.request === searchOpenedRequest) return;
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
        const contextNote = el("p", "request-context-note", target.status === "available"
            ? `Nearby messages are context, not additional matches.${applied.layer === "tool" ? " Tool completion is not answer correctness." : ""}`
            : context.groups.length > 1 || context.messages.some(message => message.kind === "follow-up") ? "Linked messages may be separate work; this is not the whole chat."
                : "Saved messages only; unsaved parts of the conversation may be missing.");
        const journey = el("ol", "journey request-context-timeline");
        journey.setAttribute("aria-label", "Recorded prompts, calls and replies");
        const summaryContents = el("div", "request-summary-content");
        const summaries = el("section", "request-context-summaries");
        const reviewHeading = el("h2", "", "Reviews");
        reviewHeading.id = "readerReviewsTitle";
        summaries.setAttribute("aria-labelledby", reviewHeading.id);
        summaries.append(reviewHeading, summaryContents);
        const footer = el("div", "reader-footer");
        footer.append(summaries);
        body.append(journey, footer);
        const copyNoticeId = "reader-copy-notice";
        const entries = [], seen = new Set(), rendered = [], responseHosts = [];
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
            const labelText = entry.kind === "prompt" && entry.relation === "selected" ? "Selected prompt"
                : entry.kind === "prompt" ? `${entry.relation === "preceding" ? "Earlier linked message" : "Next linked message"} / ${typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at)) ? timestamp(entry.at) : moment}` : moment;
            const label = el("p", "context-entry-label"), separator = labelText.indexOf(":");
            if (separator >= 0) label.append(el("strong", "", labelText.slice(0, separator + 1)), document.createTextNode(labelText.slice(separator + 1)));
            else label.textContent = labelText;
            item.prepend(label);
            if (entry.kind === "action" && item.querySelector(".call-heading")) {
                label.classList.add("call-started");
                item.querySelector(".call-heading").after(label);
                if (typeof entry.at === "string" && Number.isFinite(Date.parse(entry.at))) {
                    label.textContent = "Started " + time.formatMoment(entry.at, applied.timeContext);
                }
            }
            if (entry.kind === "prompt" && entry.relation === "selected") {
                item.id = "selectedContext";
                if (target.status !== "available") item.setAttribute("aria-current", "true");
                label.remove();
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
            matching.append(el("p", "muted", "Matching this view"), matchingResults(scenario.scenarioId));
            outcome.append(matching);
        }
        const intro = el("div", "request-intro");
        const source = sessionSource(scenario.sourceSessionId);
        const sourceProject = source || scenario;
        const originKind = authorship.originKind?.(scenario);
        if (!sameScope) intro.append(el("p", "reader-scope", full
            ? `${count(rows.length)} of ${count(full.length)} ${results.unit(applied.layer, full.length)} match the current view. The full recorded interaction follows.`
            : "Matching context unavailable. The retained interaction follows."));
        const requestText = el("section", isSelected ? "request-original" : "request-context-prompt");
        requestText.append(textAccess.render(scenario.userPrompt, {
            key: "request:" + scenario.scenarioId, mode: "complete", initialOpen: true, contentFirst: true, copyNoticeId,
            originKind,
            notice: "Copy includes the complete retained prompt body only, without export masking. It does not include chat details, warnings, the response or the rest of this page. Other apps and clipboard history may access your system clipboard.",
        }));
        const responseTime = el("dl", "reader-response-timing");
        responseTime.append(responseTimingFact(scenario));
        const modelFact = el("dl", "activity-card-facts interaction-model-fact");
        modelFact.append(originalModelFact(scenario));
        const readerFacts = el("div", "reader-facts");
        const sourceFacts = el("dl", "activity-card-facts reader-source");
        appendCardSource(sourceFacts, scenario, { compact: true, includeModel: false });
        if (isSelected) readerFacts.append(sourceFacts);
        readerFacts.append(modelFact, responseTime);
        requestText.append(readerFacts);
        const insightHost = el("div", "interaction-insights"), responseHost = el("section", "interaction-response");
        const findingsHost = el("div", "interaction-findings");
        findingsHost.dataset.presentation = "reader";
        insightHost.dataset.contextGroup = scenario.scenarioId;
        findingsHost.dataset.contextGroup = scenario.scenarioId;
        if (isSelected) {
            for (const gap of context.gaps) intro.append(el("p", "reader-empty", gap));
            body.prepend(intro);
        }
        entries.push({ key: "prompt:" + scenario.scenarioId, at: scenario.userPrompt?.sourceTimestamp,
            scenarioId: scenario.scenarioId, relation: group.relation, kind: "prompt", render: () => {
                const item = el("li", "journey-item");
                item.append(requestText);
                return item;
            } });
        responseHosts.push({ scenarioId: scenario.scenarioId, host: responseHost });
        assessmentUI.detail(insightHost, responseHost, scenario.scenarioId, { eager: true, contentFirst: true, copyNoticeId, findingsHost, placeResponse: (node, observation) => {
            if (!journey.isConnected) return;
            insertEntry({ key: "response:" + observation.observationRef, at: observation.occurredAt,
                scenarioId: scenario.scenarioId, relation: group.relation, kind: "response", render: () => node });
        } });
        const original = scenario.userPrompt;
        const support = el("div", "request-support");
        const provenance = el("div");
        provenance.append(facts([
            ["Prompt author", requestTiming.origin(original)], ["Text retained", requestTiming.coverage(original)], ["Message timestamp", original?.sourceTimestamp],
            ["Group timestamp", scenario.capturedAt], ["Source event", original?.sourceEventId],
            ["Provenance", authorship.read(original).basis],
            ["Copilot chat ID", scenario.sourceSessionId], ["Prompt association", scenario.promptAssociation],
            ["Project", sourceProject.projectId ? sourceProject.project || sourceProject.projectId
                : sourceProject.sessionId || sourceProject.sourceSessionId ? "No project associated" : "Not recorded"],
            ["Coverage", scenario.coverageNote], ["Assessment", scenario.assessedFinding],
        ], { inlineHelp: false, omitMissing: true, copyIdentifiers: false }));
        support.append(disclosure("Technical source record", provenance));
        for (const message of context.messages.filter(message => message.scenarioId === scenario.scenarioId && message.kind === "follow-up")) {
            const followup = el("section", "request-context-prompt");
            followup.append(textAccess.render(message.source, { key: message.key, mode: "complete", initialOpen: true, contentFirst: true, copyNoticeId, originKind }));
            if (message.source.association) provenance.append(el("p", "context-help-note", message.source.association));
            entries.push({ ...message, relation: group.relation, render: () => followup });
        }
        const actions = el("section", "request-actions");
        actions.setAttribute("aria-label", "Report selection");
        const reportTitle = el("span", "muted");
        reportTitle.id = "requestReportTitle";
        const pick = button("Add to report", () => {
            if (!setReportRequestSelected(scenario.scenarioId, !reportRequestSelection(scenario.scenarioId).selected)) return;
            renderRequest();
            ux.restoreFocus($("requestReportToggle"));
        });
        pick.id = "requestReportToggle";
        const continueReport = button("Continue to report", () => continueSelectedReport(scenario.scenarioId), "primary");
        continueReport.id = "requestReportContinue";
        actions.append(reportTitle, pick, continueReport);
        const recorded = el("section", "request-recorded");
        const recordedTitle = el("h3", "request-actions-heading", relationLabel(group.relation) + ": " + textAccess.excerpt(scenario.userPrompt, 100));
        recordedTitle.id = "requestRecordedTitle-" + encodeURIComponent(scenario.scenarioId);
        recorded.dataset.contextGroup = scenario.scenarioId;
        recorded.setAttribute("aria-labelledby", recordedTitle.id);
        if (context.groups.length > 1) recorded.append(recordedTitle);
        else recorded.removeAttribute("aria-labelledby");
        recorded.append(findingsHost);
        if (context.groups.length > 1 || full?.length > 1 || !sameScope) recorded.append(outcome);
        recorded.append(insightHost);
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
            const expert = el("div", "technical-detail");
            item.dataset.toolCallId = tool.toolCallId || "";
            const heading = el("div", "call-heading");
            const operation = categories.operation(tool.tool);
            const actionTitle = actionHeading(tool.tool || "Tool not recorded", row?.workload, row, "tool", { inlineHelp: false });
            if (tool.tool === "workiq-ask") {
                const identity = actionTitle.querySelector(".action-service-heading");
                if (categoryPresentation({ ...row, tool: tool.tool }).icon === "Assistance") identity?.remove();
                const icon = el("span", "operation-icon");
                icon.innerHTML = dimensionalIcons.Assistance;
                actionTitle.prepend(icon);
            }
            heading.append(actionTitle);
            const result = resultLine("tool", row ? results.summarize([row]) : null, { heading: results.heading("tool"), compactSingle: true });
            result.classList.add("journey-result");
            const duration = el("p", "call-duration");
            duration.append(el("span", "call-duration-label", "Call: "), durationValue(callInvestigation.duration(tool, "tool")));
            heading.append(result, duration);
            item.append(heading);
            const sourceCall = sourceCallFor(row) || tool;
            const fields = actionFields(sourceCall, row, { includeTool: false, includeService: false, includePurpose: false, includeMissing: false });
            if (fields.childElementCount) item.append(fields);
            const serviceEvidence = categories.serviceEvidence(row ? { ...row, tool: tool.tool } : row, "tool");
            const explanation = el("p", "reader-call-evidence", tool.tool === "workiq-ask"
                ? "Recorded request to Copilot or an agent; delivery and the downstream service are not established."
                : serviceEvidence?.description ?? operation?.description);
            const searchScope = categories.requestedSearchScope(sourceCall);
            if (searchScope) explanation.append(" " + searchScope.description);
            const apiRows = fullRowsFor(scenario.scenarioId, "reported-api")?.filter(r => r.parentCallId === row?.id);
            if (apiRows?.length) {
                const apiSummary = resultLine("reported-api", results.summarize(apiRows));
                apiSummary.classList.add("call-api-summary");
                item.append(apiSummary);
            }
            else if (row?.workload !== "Discovery") explanation.append(apiRows ? " No API result metadata recorded." : " API result metadata is unavailable.");
            if (explanation.textContent.trim()) expert.prepend(explanation);
            if (!sameScope) {
                actionContext(item, applied.layer === "tool" ? (row ? [row] : canonical ? [] : undefined) : applied.layer === "reported-api" ? apiRows : []);
                const scope = item.querySelector(".action-context");
                if (scope.textContent === "Outside current view") expert.append(scope);
                else if (applied.layer === "tool" && row && rows.some(match => match.id === row.id)) scope.textContent = "Matches current view";
            }
            const failure = recordedFailure(tool, ["failure", "transport"].includes(row?.outcome));
            if (failure) {
                const missingCause = Object.values(help.failureEvidence).includes(failure);
                item.append(el("p", "action-error", missingCause ? "Failure cause unavailable." : failure));
                if (missingCause) expert.append(el("p", "context-help-note", failure));
                expert.append(el("p", "context-help-note", "Historical call evidence only; it does not establish current sign-in or permission state."));
            }
            if (row) {
                const returned = returnedDetails(sourceCall, row, apiRows,
                    applied.layer === "reported-api" && target.actionId === row.id ? target.row.id : undefined);
                if (returned) item.append(returned);
            }
            const consistentCompletion = row?.outcome === "success" && tool.reportedOutcome === "succeeded" && tool.toolSucceeded === true
                || row?.outcome === "failure" && tool.reportedOutcome === "failed" && tool.toolSucceeded === false;
            expert.append(facts([
                ["Recorded start", tool.startedAt], ["Recorded end", tool.completedAt ?? tool.endedAt],
                ["Call duration (ms)", callInvestigation.duration(tool, "tool")],
                ...consistentCompletion ? [] : [["Reported outcome", tool.reportedOutcome], ["Execution success", tool.toolSucceeded]],
                ["Tool call ID", tool.toolCallId], ["Parent invocation", tool.parentToolCallId], ["Parallel group", tool.parallelGroup],
            ], { inlineHelp: false, omitMissing: true, copyIdentifiers: false }));
            if (tool.observedGraphHttp) expert.append(el("p", "reader-record-limits", "HTTP directly observed."));
            if (tool.failureEvidence?.version === 1) {
                const evidence = tool.failureEvidence;
                const reason = help.failureMessageStatus[evidence.messageStatus] ?? "Error messages, stack traces and response bodies are excluded from collection.";
                expert.append(el("p", "context-help-note", reason));
            }
            const argumentsBlock = ux.codeBlock(JSON.stringify(tool.requestArgs, null, 2) ?? "[Arguments unavailable]",
                { label: "Tool input (recorded)", copyLabel: "Copy recorded arguments" });
            argumentsBlock.classList.add("recorded-arguments");
            expert.append(argumentsBlock);
            for (const key of ["command", "code", "script"]) if (typeof tool.requestArgs?.[key] === "string") expert.append(ux.codeBlock(tool.requestArgs[key], { label: "Recorded " + key, copyLabel: "Copy " + key }));
            for (const result of tool.apiResults || []) expert.append(facts([["Result attribution", result.evidenceLevel], ["Reported status", result.statusCode], ["Reported error", result.errorCode]], { inlineHelp: false, omitMissing: true }));
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
        if (entryStart === entries.length) requestText.append(el("p", "reader-empty", "No individual action details were retained."));
        summaryContents.append(recorded);
        if (isSelected) body.prepend(actions);
        for (const item of analytics.journeys || []) {
            if (item.scenarioId !== scenario.scenarioId || item.association === "none") continue;
            const relation = item.association === "same-prompt-after-failure" ? "A Graph request follows a Work IQ failure in this prompt group." : item.association === "explicit-transition" ? "The record contains an explicit transition to Graph." : "Work IQ and Graph activity occur in the same prompt group.";
            provenance.append(el("p", "context-help-note", relation + " This is sequence evidence; it does not prove why the assistant chose Graph."));
        }
        detailOwner = "request:" + scenario.scenarioId;
        recorded.append(support);
        }
        entries.sort(requestContext.compare);
        for (const entry of entries) insertEntry(entry);
        for (const { scenarioId, host } of responseHosts) {
            const last = rendered.filter(entry => entry.scenarioId === scenarioId && ["prompt", "action"].includes(entry.kind)).at(-1);
            if (last) last.node.insertBefore(host, last.node.querySelector(":scope > .detail-disclosure"));
        }
        const copyNotice = el("p", "reader-copy-scope", "Copy uses unmasked text. Other apps and clipboard history may access it.");
        copyNotice.id = copyNoticeId;
        journey.after(copyNotice);
        const firstLinkedMessage = rendered.find(entry => entry.kind === "prompt" && entry.relation !== "selected" || entry.kind === "follow-up")?.node;
        const selectedRecord = target.status === "available" ? body.querySelector("#selectedCall") : null;
        if (selectedRecord) selectedRecord.prepend(contextNote);
        else if (firstLinkedMessage && target.status !== "available") firstLinkedMessage.prepend(contextNote);
        const boundary = el("section", "request-link-details");
        boundary.append(el("h3", "", "How these messages were linked"), el("p", "", context.boundary), el("p", "", context.limitation));
        if (context.groups.length > 1 || context.messages.some(message => message.kind === "follow-up")) summaryContents.append(boundary);
        const evidenceScope = el("p", "reader-evidence-scope", "Saved messages can have gaps. Tool outcomes do not establish answer correctness or permission. ");
        evidenceScope.append(link("Collection coverage", "collection-status", { setting: "collection-details" }, "text-link"));
        summaryContents.append(evidenceScope);
        detailOwner = "request:" + route.request;
        updateRequestReportActions();
    }
    function updateRequestReportActions() {
        if (route.view !== "request" || !$("requestReportToggle")) return;
        const membership = reportRequestSelection(route.request);
        const pick = $("requestReportToggle"), next = $("requestReportContinue"), title = $("requestReportTitle");
        setText(pick, membership.selected ? "Remove from report" : "Add to report");
        pick.disabled = membership.disabled;
        next.disabled = membership.disabled || !membership.selected;
        setText(title, membership.selected && !membership.included ? "Selected; not included with current report choices."
            : !membership.selected && membership.included ? "Included through the current report scope." : "");
        title.hidden = !title.textContent;
        const block = reportSelectionBlock();
        ux.tooltip(pick, block || (membership.disabled ? "This interaction has no reportable activity."
            : membership.selected ? help.actions.removeRequest : help.actions.selectRequest));
        ux.tooltip(next, block || (membership.selected ? "Review selected activity and the report's author choices."
            : "Add this interaction before continuing to the report."));
    }
    function reportSelection(kind = reportScope) {
        if (periodReport && kind === reportScope) {
            const value = periodReport.value;
            return reportScopes.resolve(state?.exportCatalog, "selected", [],
                [...new Set(Object.values(value.periods).flatMap(side => side.scenarioIds))], authorship.selection(value.options.filters?.promptAuthors));
        }
        const value = reportScopes.resolve(state?.exportCatalog, kind, state ? currentViewScenarios().map((s) => s.scenarioId) : [], [...selected], reportAuthors);
        return kind === "current" && semanticQuery !== null && !semanticComplete ? { ...value, available: false } : value;
    }
    function reportSelectionBlock() {
        if (exportWriting || reportJourney?.snapshot().saveUnconfirmed) return "Check or finish the current save before changing report activity.";
        if (isLoading || isStale || !state?.exportCatalog) return "Wait for a current activity snapshot before changing report activity.";
        if (periodReport) return "This draft uses paired periods. Return to the comparison to change its activity.";
        return "";
    }
    function reportRequestSelection(scenarioId) {
        const catalog = state?.exportCatalog;
        const request = catalog?.requests.find(item => item.scenarioId === scenarioId)
            ?? catalog?.requests.find(item => item.aliases.includes(scenarioId));
        const base = reportScopes.resolve(catalog, "selected", [], [...selected], reportAuthors);
        return {
            selected: Boolean(request && base.baseRequests.some(item => item.scenarioId === request.scenarioId)),
            included: Boolean(request && reportSelection().requests.some(item => item.scenarioId === request.scenarioId)),
            disabled: Boolean(reportSelectionBlock() || !request),
        };
    }
    function setReportRequestSelected(scenarioId, checked) {
        const block = reportSelectionBlock();
        const request = state?.exportCatalog?.requests.find(item => item.scenarioId === scenarioId)
            ?? state?.exportCatalog?.requests.find(item => item.aliases.includes(scenarioId));
        if (block || !request) {
            announce(block || "This interaction has no reportable activity.", "stale");
            updateSelection();
            return false;
        }
        if (checked) selected.add(scenarioId);
        else for (const id of request.aliases) selected.delete(id);
        reportScope = "selected";
        reportEntry = null;
        invalidatePreview();
        updateSelection();
        return true;
    }
    function continueSelectedReport(scenarioId) {
        const block = reportSelectionBlock();
        if (block) { announce(block, "stale"); return false; }
        if (!reportRequestSelection(scenarioId).selected) {
            announce("Add this interaction to the report before continuing.", "stale");
            return false;
        }
        const request = state.exportCatalog.requests.find(item => item.scenarioId === scenarioId)
            ?? state.exportCatalog.requests.find(item => item.aliases.includes(scenarioId));
        const choices = reportPickerRequests(), target = choices.find(item => item.scenarioId === request.scenarioId);
        if (!target) { announce("This interaction is no longer available in the report picker.", "stale"); return false; }
        const query = matchesReportRequest(target, localQuery("reportRequestSearch")) ? localQuery("reportRequestSearch") : "";
        const matching = choices.filter(item => matchesReportRequest(item, query));
        presentation.setPage("report:selected:" + query, Math.floor(matching.indexOf(target) / 4));
        reportScope = "selected";
        reportEntry = null;
        updateSelection();
        reportJourney.go(1);
        const moved = go("reports", { task: "create", request: undefined,
            localSearch: { ...route.localSearch, reportRequestSearch: query } });
        const navigation = navigationGeneration, intent = readingIntent;
        const reveal = loaded => {
            if (!loaded || navigation !== navigationGeneration || intent !== readingIntent) return;
            const control = $("report-select-" + encodeURIComponent(request.scenarioId));
            if (!control?.checkVisibility() || !control.checked) {
                announce("The continued interaction changed. Check the current report selection.", "stale");
                return;
            }
            const entry = control.closest(".report-entry"), actions = $("reportStage1").querySelector(".report-stage-actions");
            entry.tabIndex = -1;
            entry.focus({ preventScroll: true });
            const inset = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
            if (entry.getBoundingClientRect().bottom - actions.getBoundingClientRect().top <= innerHeight - inset - 16) {
                actions.scrollIntoView({ block: "start", inline: "nearest" });
            } else control.scrollIntoView({ block: "center", inline: "nearest" });
        };
        if (moved instanceof Promise) moved.then(reveal);
        else reveal(moved);
        return true;
    }
    function clearReportSelection() {
        if (exportWriting || reportJourney?.snapshot().saveUnconfirmed) return;
        reportScope = "selected";
        reportEntry = null;
        periodReport = null; periodReportInvalid = false;
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
    function reportPickerRequests() {
        const ids = new Set((state.exportCatalog?.requests ?? []).map(request => request.scenarioId));
        return state.scenarios.filter(scenario => ids.has(scenario.scenarioId));
    }
    function matchesReportRequest(scenario, query) {
        return localSearch.matches(query, [scenario.userPrompt?.text, scenario.title, scenario.sourceSessionName,
            sessionSource(scenario.sourceSessionId)?.name, scenario.project, scenario.sourceSessionId]);
    }
    function updateSelection() {
        if (!state) return;
        const savedCount = state.exports?.length || 0;
        const verifiedEmptyLibrary = !savedCount && !isLoading && !isStale;
        for (const node of $("bundles").querySelectorAll(":scope > .saved-library-tools,:scope > #savedLibraryHelp,:scope > #savedLibraryManagement")) {
            if (verifiedEmptyLibrary && node.contains(document.activeElement)) $("reportCreateLink").focus({ preventScroll: true });
            node.hidden = verifiedEmptyLibrary;
        }
        if (!savedCount) {
            const notice = $("bundleList").querySelector(":scope > p");
            if (notice) setText(notice, isLoading ? "Checking saved reports..." : isStale ? "Saved reports could not be checked. Retry the stored view."
                : "No local reports have been saved. Create or continue a report, then review it before saving.");
        }
        const value = reportSelection();
        const picked = new Set(reportSelection("selected").baseRequests.map(request => request.scenarioId));
        for (const control of $("reportList").querySelectorAll("input[data-report-request]")) control.checked = picked.has(control.dataset.reportRequest);
        for (const control of document.querySelectorAll("input[data-selected-request]")) control.checked = selected.has(control.dataset.selectedRequest);
        const activeAuthors = periodReport ? authorship.selection(periodReport.value.options.filters?.promptAuthors) : reportAuthors;
        if (periodReport) {
            const expected = [...new Set(Object.values(periodReport.value.periods).flatMap(side => side.scenarioIds))].sort();
            if (JSON.stringify([...selected].sort()) !== JSON.stringify(expected)) {
                periodReportInvalid = true;
                invalidatePreview("The comparison selection changed. Return to Analyze and create a new comparison report.");
            }
        }
        const unknownSelected = reportScope === "selected" && [...selected].some((id) => !state.scenarios.some((s) => s.scenarioId === id));
        if (!exportWriting && !isLoading && !isStale && value.available) {
            if (draft.observeContext({ revision: state.revision, assessment: state.assessment })) {
                scrubContextPreview();
                invalidatePreview("Recorded context changed. Prepare a new preview; ordinary prompt edits are kept.");
            }
            const token = draft.token();
            draft.select([reportScope, "authors:" + activeAuthors.join(","), ...value.requests.map((r) => r.scenarioId)]);
            draft.synchronizeTime(periodReport?.timeContext ?? viewerTime, periodReport ? { range: "capture" } : dateSelection());
            if (draft.synchronizeBasis(state, value, { paired: Boolean(periodReport) }) && periodReport) periodReportInvalid = true;
            if (periodReport && JSON.stringify(periodReport.timeContext) !== JSON.stringify(viewerTime)) periodReportInvalid = true;
            if (!draft.current(token)) invalidatePreview("The report scope, source or review basis changed. Return to Setup and scan again; unchanged draft choices are kept.");
        }
        for (const kind of ["all", "current", "selected"]) {
            const scope = reportSelection(kind), size = scope.requests.length;
            $("scopeCount-" + kind).textContent = scope.available
                ? `${scope.sourceSessionCount === null ? "Chat count unavailable" : `${count(scope.sourceSessionCount)} ${scope.sourceSessionCount === 1 ? "chat" : "chats"}`} · ${count(size)} ${size === 1 ? "interaction" : "interactions"}`
                : "Count unavailable";
            document.querySelector(`[name=reportScope][value=${kind}]`).checked = reportScope === kind;
        }
        setText($("reportScopeChoiceHelp"), help.reportScopes[reportScope]);
        $("reportScopeChoiceHelp").hidden = Boolean(periodReport);
        $("scopeSummary").textContent = !state.exportCatalog ? "Report scope is unavailable. Refresh before previewing." : unknownSelected ? "A selected request is no longer available. Choose a fresh selection." : reportScopes.summary(value);
        for (const option of $("reportPromptAuthorFilter").options) option.selected = activeAuthors.includes(option.value);
        $("reportPromptAuthorFilter").disabled = exportWriting || Boolean(periodReport);
        document.querySelectorAll("[name=reportScope]").forEach(control => { control.disabled = exportWriting || Boolean(periodReport); });
        document.querySelectorAll("[name=promptMode],#formatOptions input,#manualTerms").forEach(control => { control.disabled = exportWriting; });
        $("reportRecordedContext").checked = draft.options().recordedContext === true && draft.options().promptMode !== "none";
        $("reportRecordedContext").disabled = exportWriting || draft.options().promptMode === "none";
        $("reportRecordedContextHelp").hidden = !$("reportRecordedContext").checked && draft.options().promptMode !== "none";
        setText($("reportRecordedContextHelp"), draft.options().promptMode === "none"
            ? "No prompts leaves linked request and reply text out."
            : $("reportRecordedContext").checked ? "Your author and prompt choices apply. Missing or revoked replies stay unavailable. Review every copy before saving; reading is not permission to export. Linked context is not proof of one task and does not expand counts or assessments." : "");
        setText($("reportPromptAuthorSummary"), value.available === false ? "Request counts are unavailable for this scope."
            : `${count(value.requests.length)} of ${count(value.baseRequests.length)} request groups in the base scope included.${value.authorExcludedRequestGroups ? ` ${count(value.authorExcludedRequestGroups)} left out with their calls and scores. The base selection is kept.` : ""}`);
        $("reportPromptAuthorSummary").hidden = !periodReport && value.available !== false && !value.authorExcludedRequestGroups;
        $("scopeExplanation").textContent = "";
        $("scopeExplanation").hidden = !periodReport;
        const reportIds = new Set(value.requests.flatMap(request => request.aliases));
        const currentIds = new Set(currentViewScenarios().map(s => s.scenarioId));
        const hidden = value.requests.filter(request => !request.aliases.some(id => currentIds.has(id))).length;
        const currentMembershipAvailable = semanticQuery === null || semanticBound;
        $("reportPopulationNote").textContent = value.available && !unknownSelected && value.requests.length
            ? `${count(value.counts.workIqActions)} Work IQ tool call${value.counts.workIqActions === 1 ? "" : "s"} from the full included interactions, across all pages.${currentMembershipAvailable ? hidden ? ` Includes ${chatCopy.groups(hidden)} outside the current browsing filters.` : "" : " Current analytical match membership is unavailable."}`
            : "";
        const matching = results.summarize(selectionRows().filter(row => reportIds.has(row.scenarioId) && currentIds.has(row.scenarioId)));
        $("reportMatchingContext").replaceChildren(resultLine(applied?.layer || "tool", matching, { scope: "Matching view results, not the full report", label: `${count(matching?.count)} matching ${results.unit(applied?.layer || "tool", matching?.count)} in the current view` }));
        $("reportMatchingContext").hidden = !value.requests.length || !currentMembershipAvailable;
        const x = state.exportCatalog?.excluded;
        const exclusions = $("scopeExclusions");
        exclusions.replaceChildren();
        if (!x) exclusions.append(el("p", "context-help-note", "Collection exclusion counts unavailable."));
        else {
            const excluded = el("dl", "scope-facts");
            for (const [key, label] of [
                ["syntheticRequestGroups", "Synthetic request groups"],
                ["diagnosticRequestGroups", "Diagnostic request groups"],
                ["unknownSourceRequestGroups", "Request groups with unknown source identity"],
                ["requestGroupsWithoutEligibleEvidence", "Alias-only or excluded request groups"],
                ["duplicateEvidenceRecords", "Duplicate evidence records"],
                ["unidentifiableEvidenceRecords", "Unidentifiable evidence records"],
                ["platformDiagnosticEvidenceRecords", "Platform diagnostic records"],
                ["excludedOrDuplicateEvidenceRecords", "Total excluded or deduplicated evidence records"],
            ]) {
                const amount = x[key], known = Number.isSafeInteger(amount) && amount >= 0;
                if (known && amount === 0) continue;
                const row = el("div");
                row.append(el("dt", "", label), el("dd", "", known ? count(amount) : "Count unavailable"));
                excluded.append(row);
            }
            if (excluded.childElementCount) exclusions.append(excluded,
                el("p", "context-help-note", "Categories may overlap; do not add them."));
            else exclusions.append(el("p", "context-help-note", "No collection exclusions."));
        }
        if (value.excludedRequestedGroups) exclusions.append(el("p", "context-help-note",
            `${count(value.excludedRequestedGroups)} selected request groups have no eligible evidence.`));
        const inclusion = periodReport
            ? `One comparison report / ${periodReport.value.periods.baseline.rowIds.length} matching records in A / ${periodReport.value.periods.later.rowIds.length} in B`
            : unknownSelected ? "A selected request is no longer available" : reportScopes.inclusion(value);
        const activity = route.view === "analyze";
        setText($("activitySelectionSummary"), inclusion);
        setText($("previewSelectionSummary"), periodReport || unknownSelected || !value.available ? inclusion : !value.requests.length ? "No interactions included"
            : `${value.sourceSessionCount === null ? "Chat count unavailable" : `${count(value.sourceSessionCount)} ${value.sourceSessionCount === 1 ? "chat" : "chats"}`} · ${count(value.requests.length)} ${value.requests.length === 1 ? "interaction" : "interactions"}`);
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
        $("reportSelectionBar").hidden = ["request", "reports", "settings", "collection-status"].includes(route.view)
            || !activity && !value.baseRequests.length;
        updateRequestReportActions();
        document.querySelectorAll("[data-clear-selection]").forEach(control => {
            control.disabled = exportWriting || reportJourney?.snapshot().saveUnconfirmed || control.id === "activityClearSelection" && !value.baseRequests.length;
        });
        $("reportClearSelection").hidden = !value.baseRequests.length && !selected.size || ["saved", "unavailable"].includes(reportJourney?.snapshot().phase);
        if (route.view === "reports") {
            $("pageAction").hidden = !value.requests.length;
            $("pageAction").classList.add("quiet");
        } else $("pageAction").classList.remove("quiet");
        let pairedSummary = $("periodReportScope");
        if (!pairedSummary) {
            pairedSummary = el("section", "report-period-scope"); pairedSummary.id = "periodReportScope";
            $("reportPopulationNote").before(pairedSummary);
        }
        pairedSummary.hidden = !periodReport;
        $("reportsView").querySelector(".scope-choices").hidden = Boolean(periodReport);
        if (periodReport) {
            const { baseline: a, later: b } = periodReport.value.periods;
            $("reportPopulationNote").textContent = `Period A: ${a.rowIds.length} matching records; Period B: ${b.rowIds.length}. Full-interaction assessment coverage remains separate. ${value.requests.length} supporting-copy groups are not a combined analytical cohort.`;
            $("scopeSummary").textContent = $("reportPopulationNote").textContent;
            $("scopeExplanation").textContent = "This report freezes the comparison accepted in Analyze. It does not use ordinary Current view full-interaction call counts.";
            $("reportMatchingContext").hidden = true;
            $("reportPromptAuthorSummary").textContent = "Authors and matching records are fixed to this comparison. None / Masked / Original changes copies, not membership.";
            pairedSummary.replaceChildren(el("h3", "", "Report this comparison"),
                el("p", "", `Period A: ${a.range.from} to ${a.range.to}. Period B: ${b.range.from} to ${b.range.to}. ${time.label(periodReport.timeContext)}.`),
                el("p", "", "Authors and matching records are fixed to this comparison. Change them in Analyze and create a new comparison report."),
                button("Change comparison in Analyze", () => {
                    const returnTo = periodReport.returnTo;
                    clearReportSelection();
                    navigate(returnTo);
                }));
        }
        $("exportBtn").disabled = isLoading || isStale || periodReportInvalid || !state.exportCatalog || value.available === false || unknownSelected || !value.requests.length || !draft.options().formats.length;
        reportJourney?.update({
            requestCount: value.requests.length, sourceSessionCount: value.sourceSessionCount, scope: periodReport ? "period" : reportScope,
            authorLabel: authorship.selectionLabel(activeAuthors), authorFiltered: activeAuthors.length !== authorship.actors.length,
            scopeReady: !isLoading && !isStale && !periodReportInvalid && Boolean(state.exportCatalog) && value.available !== false && !unknownSelected,
            scopeIssue: periodReportInvalid ? "The accepted comparison changed. Return to Analyze and create a new comparison report." : isLoading || isStale ? "Wait for a current activity snapshot." : !value.available || unknownSelected ? $("scopeSummary").textContent : "",
            promptMode: draft.options().promptMode, formats: draft.options().formats,
            timeLabel: time.label(applied?.timeContext || viewerTime), entry: reportEntry,
        });
        selectControls?.sync();
        renderStoredRefresh();
        renderReportTask();
    }
    function renderReports() {
        captureReading();
        $("reportTimeContext").textContent = `Report dates use ${time.label(applied.timeContext)} (${applied.timeContext.locale}). Source event timestamps stay withheld.`;
        const host = $("reportList"), picking = reportScope === "selected" && !periodReport;
        const requests = picking ? reportPickerRequests() : selectedScenarios();
        $("reportRequestsTitle").textContent = picking ? "Choose interactions" : "Included interactions";
        host.replaceChildren();
        {
            const query = localQuery("reportRequestSearch");
            $("reportRequestSearchCount").hidden = !query;
            const matching = requests.filter(scenario => matchesReportRequest(scenario, query));
            setText($("reportRequestSearchCount"), `${count(matching.length)} of ${count(requests.length)} saved interactions shown.${picking ? " Selections outside this list are kept." : ` All ${count(requests.length)} remain included.`}`);
            if (!requests.length) host.append(empty(picking ? "No reportable activity saved" : "No interactions included",
                isStale ? "Activity could not be checked. Retry the stored view." : picking ? "This library uses activity already saved in WIRE." : "Choose another scope or include other prompt authors."));
            else if (!matching.length) host.append(empty("No interactions match", "Clear this search to show the list. Your report selection is unchanged."));
            if (matching.length) pagedList(host, matching, { key: "report:" + reportScope + ":" + query, size: 4, noun: "report requests", wrapList: list => {
                list.className = "report-request-page";
                list.tabIndex = 0;
                list.setAttribute("role", "region");
                list.setAttribute("aria-label", "Requests on this report page");
                return list;
            }, renderItem: scenario => {
            detailOwner = "report:" + scenario.scenarioId;
            const row = viewKey(el("article", "report-entry"), detailOwner), text = el("div");
            const requestLink = link("View interaction", "request", { request: scenario.scenarioId }, "request-link text-link");
            const source = sessionSource(scenario.sourceSessionId);
            const identity = el("p", "report-entry-meta");
            identity.append(el("strong", "", "Chat "), document.createTextNode(source?.name || scenario.sourceSessionName || "Name not recorded"));
            text.append(textAccess.render(scenario.userPrompt, { key: "report:" + scenario.scenarioId, navigationNode: requestLink, originKind: authorship.originKind(scenario) }), identity);
            if (picking) {
                const checkbox = selectionCheckbox(scenario, true);
                checkbox.disabled = reportRequestSelection(scenario.scenarioId).disabled;
                const pick = el("label", "report-selection-toggle");
                pick.htmlFor = checkbox.id;
                pick.append(checkbox);
                row.append(pick);
                const request = state.exportCatalog.requests.find(item => item.scenarioId === scenario.scenarioId);
                if (!reportAuthors.includes(request.promptAuthor ?? "unknown")) text.append(el("p", "context-help-note", "Not included with the current prompt-author choice."));
            }
            row.append(text);
            return row;
            } });
        }
        $("bundleList").replaceChildren();
        const savedCount = state.exports?.length || 0;
        const reportCount = (state.exports || []).filter(bundle => (bundle.kind ?? "report") === "report").length;
        const comparisonCount = savedCount - reportCount;
        $("savedLibraryTitle").textContent = comparisonCount ? `Saved reports and comparisons (${count(savedCount)})` : savedCount ? `Saved reports (${count(savedCount)})` : "Saved reports";
        $("savedReportCount").textContent = comparisonCount ? `${count(reportCount)} report${reportCount === 1 ? "" : "s"} / ${count(comparisonCount)} comparison${comparisonCount === 1 ? "" : "s"}` : "";
        $("savedReportCount").parentElement.hidden = !comparisonCount;
        $("deleteAllReports").disabled = !reportCount || isLoading || isStale;
        (() => {
        $("bundleList").replaceChildren();
        setText($("savedReportSearchCount"), "");
        if (!savedCount) {
            $("bundleList").append(el("p", "", isStale ? "Saved reports could not be checked. Retry the stored view."
                : "No local reports have been saved. Create or continue a report, then review it before saving."));
            return;
        }
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
            const title = bundle.kind === "comparison" ? "Comparison" : bundle.reportType === "period-comparison" ? "Period comparison report"
                : ({ all: "All saved activity", current: "Analyze selection", selected: "Selected interactions" })[bundle.selectionScope?.kind] || "Report";
            const label = [
                title,
                date === "Time not recorded" ? "Preparation time unavailable" : `Prepared ${date}`,
                mode, formats,
                Number.isSafeInteger(groups) && groups >= 0 ? `${count(groups)} interaction${groups === 1 ? "" : "s"}` : "",
            ].filter(Boolean).join(" / ");
            return { bundle, index, prepared, label, date, mode, formats, title, groups };
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
        pagedList(history, matching, { key: "saved-reports:" + query, noun: comparisonCount ? "saved items" : "saved reports", jump: true, renderItem: ({ bundle, label, date, mode, formats, title, groups }) => {
            detailOwner = "bundle:" + bundle.bundleId;
            const content = el("div", "saved-report-management");
            const outer = el("article", "saved-library-row");
            let openButton;
            const htmlName = bundle.kind === "comparison" ? "comparison-report.html" : "product-report.html";
            if (bundle.files?.[htmlName]) openButton = button("Open", event => openSavedReport(bundle, event.currentTarget), "quiet");
            else content.append(el("p", "muted", "HTML was not saved. Read one of the saved downloads below."));
            if (openButton) {
                openButton.setAttribute("aria-label", bundle.kind === "comparison" ? "Open saved comparison" : "Open saved report");
                viewKey(openButton, "open-bundle:" + bundle.bundleId);
            }
            if (bundle.kind !== "comparison" && bundle.reportType !== "period-comparison") content.append(button("Compare saved reports", () => reportComparisonUI.open(), "quiet"));
            if (bundle.reportType === "period-comparison") content.append(el("p", "", "Two frozen matching-record cohorts. Supporting copies are not a third analytical cohort."));
            content.append(button(bundle.kind === "comparison" ? "Delete saved comparison" : "Delete report", event => savedArtifactUI.open({
                artifactKind: bundle.kind === "comparison" ? "comparison" : "report",
                artifactId: bundle.bundleId, label: `${bundle.preparedAtDisplay || time.formatTime(bundle.preparedAt, viewerTime)} / ${bundle.bundleId}`,
            }, event.currentTarget), "danger"));
            if (bundle.timeContext) content.append(el("p", "", `Report timezone: ${time.label(bundle.timeContext)}. Prepared: ${bundle.preparedAtDisplay || time.formatTime(bundle.preparedAt, bundle.timeContext)}. Locale: ${bundle.timeContext.locale}.`));
            const downloads = el("div", "saved-report-downloads");
            for (const name of Object.keys(bundle.files || {})) {
                const fileLabel = name.endsWith(".html") ? "HTML" : name.endsWith(".pdf") ? "PDF" : name.endsWith(".md") ? "Markdown"
                    : name === "coverage-and-redaction-manifest.json" ? "Manifest" : "JSON";
                const control = button(fileLabel, async () => {
                    control.disabled = true;
                    try {
                        await downloadReportFile(bundle, name);
                    } catch (error) { announce(error.message, "error"); }
                    finally { control.disabled = false; }
                });
                control.setAttribute("aria-label", "Download " + name);
                control.prepend(ux.icon("download"));
                control.classList.add("icon-action");
                downloads.append(ux.tooltip(control, help.actions.download));
            }
            if (!openButton) {
                const name = [".pdf", ".md", ".json"].map(suffix => Object.keys(bundle.files || {}).find(file => file !== "coverage-and-redaction-manifest.json" && file.endsWith(suffix))).find(Boolean);
                const download = name && [...downloads.querySelectorAll("button")].find(control => control.getAttribute("aria-label") === "Download " + name);
                if (download) {
                    openButton = download;
                    const label = name.endsWith(".pdf") ? "PDF" : name.endsWith(".md") ? "Markdown" : "JSON";
                    openButton.replaceChildren(ux.icon("download"), document.createTextNode("Download " + label));
                    viewKey(openButton, "open-bundle:" + bundle.bundleId);
                }
            }
            content.prepend(downloads);
            content.append(el("p", "mono", `Report ID: ${bundle.bundleId}`));
            const row = el("details", "detail-disclosure saved-report");
            const summary = el("summary", "saved-report-summary"), identity = el("span", "saved-report-identity");
            identity.append(el("span", "saved-report-name", title),
                el("span", "", date === "Time not recorded" ? "Preparation time unavailable" : `Prepared ${date}`));
            if (Number.isSafeInteger(groups) && groups >= 0 && bundle.reportType !== "period-comparison") identity.append(el("span", "saved-report-scope", `${count(groups)} interaction${groups === 1 ? "" : "s"}`));
            if (labelCounts.get(label) > 1) identity.append(el("span", "saved-report-disambiguation", bundle.bundleId));
            const metadata = el("span", "saved-report-metadata");
            metadata.append(el("span", "", mode || "Prompt mode not recorded"), el("span", "", formats || "Formats not recorded"));
            summary.append(identity, metadata, el("span", "saved-report-manage", "Files & actions"));
            row.append(summary, content);
            outer.append(bindDetails(row, detailOwner));
            if (openButton) outer.append(openButton);
            else outer.append(el("span", "saved-report-no-html", "No HTML"));
            return outer;
        } });
        $("bundleList").append(history);
        })();
        updateSelection();
    }
    async function openSavedReport(bundle, trigger) {
        ux.hideTooltip();
        savedReportView?.dialog.close();
        const kind = bundle.kind === "comparison" ? "comparison" : "report";
        const title = kind === "comparison" ? "Saved comparison" : bundle.reportType === "period-comparison" ? "Saved period comparison report" : "Saved report";
        const dialog = el("dialog", "assessment-dialog saved-report-dialog");
        dialog.setAttribute("aria-label", kind === "comparison" ? "Saved comparison" : "Saved report");
        const header = el("div", "dialog-head"), close = button("Back to report library", () => {
            dialog.close();
            if (route.view === "reports" && route.task === "create") $("reportLibraryLink").click();
        }, "quiet");
        header.append(el("h2", "", title), close);
        const body = el("div", "assessment-dialog-body");
        body.append(el("p", "", "Opening the saved copy..."));
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
            const result = kind === "comparison"
                ? await api("/api/artifact-file", { bundleId: bundle.bundleId, kind, format: "html" })
                : await api("/api/report/open", { bundleId: bundle.bundleId });
            if (!dialog.open || savedReportView !== current || current.invalid) return;
            if (kind === "comparison") {
                if (result.artifact?.kind !== kind || result.format !== "html" || result.name !== "comparison-report.html"
                    || result.encoding !== "base64" || result.manifestHash !== bundle.manifestHash || typeof result.data !== "string") {
                    throw new Error("The verified saved comparison file is unavailable. Nothing was regenerated.");
                }
                result.html = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.data), c => c.charCodeAt(0)));
            }
            if (result.artifact?.bundleId !== bundle.bundleId || typeof result.html !== "string"
                || !state.exports?.some(entry => entry.bundleId === bundle.bundleId && entry.manifestHash === current.manifestHash)) throw new Error("This saved artifact is no longer available.");
            body.replaceChildren(el("p", "saved-reader-caption", `Saved copy · Prepared ${result.artifact.preparedAtDisplay || time.formatTime(result.artifact.preparedAt, viewerTime)}`));
            if (result.artifact.sourceReports?.some(source => !source.available)) body.append(el("p", "muted",
                "An original report is no longer available. This independently reviewed saved copy is unchanged."));
            const frame = assessmentFactories.liveSearch.frozenFrame(result.html);
            frame.title = "Frozen saved " + kind;
            body.append(frame);
        } catch (error) {
            if (dialog.open && savedReportView === current && !current.invalid) body.replaceChildren(el("p", "error", error.message));
        }
    }
    async function downloadReportFile(bundle, name, isCurrent = () => true) {
        const kind = bundle.kind === "comparison" ? "comparison" : "report";
        const prefix = kind === "comparison" ? "comparison-report" : "product-report";
        const formats = { [`${prefix}.html`]: "html", [`${prefix}.pdf`]: "pdf", [`${prefix}.json`]: "json",
            [`${prefix}.md`]: "markdown", "coverage-and-redaction-manifest.json": "manifest" };
        if (!Object.hasOwn(formats, name)) throw new Error("This saved file format is unsupported. No download was started.");
        const result = await api("/api/artifact-file", { bundleId: bundle.bundleId, kind, format: formats[name] });
        if (!isCurrent() || !state.exports?.some(entry => entry.bundleId === bundle.bundleId && entry.manifestHash === bundle.manifestHash)
            || result.artifact?.bundleId !== bundle.bundleId || result.artifact?.kind !== kind || result.name !== name
            || result.format !== formats[name] || result.manifestHash !== bundle.manifestHash || result.encoding !== "base64"
            || typeof result.data !== "string") throw new Error("This verified saved file is no longer available. No download was started.");
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
        const checked = collection?.config?.approved ? collection.checkedWindow : coverage;
        const key = JSON.stringify([state.revision, applied, c.firstAt, c.lastAt, coverage, checked, analytics.warnings, collectionReadError, collection?.config?.approved, collection?.config?.windowDays]);
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
            ["Last checked history", checked?.since && checked?.until ? `${timestamp(checked.since)} to ${timestamp(checked.until)}` : "Not recorded"],
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
        const withinServices = route.withinServices?.split(",") || [];
        if (semanticMembership && (semanticMembership.revision !== state.revision
            || semanticMembership.scopeKey !== JSON.stringify([applied, withinServices]))) {
            semanticComplete = false;
            semanticBound = false;
            semanticStatus = "pending";
            semanticMembership = unavailableSearchMembership();
        }
        slice = analysisSlice(state, applied, search, withinServices, semanticMembership);
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
        periodComparisonUI.update().then(() => {
            const saved = periodReturnReading;
            if (!saved) return;
            if (saved.navigation !== navigationGeneration || saved.intent !== readingIntent
                || route.view !== "analyze" || route.compare !== "periods") { periodReturnReading = null; return; }
            if (periodComparisonUI.consumer()) { restoreReading(saved.position); periodReturnReading = null; }
        });
        liveSearchUI?.changed();
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
        const model = fresh.snapshot(), recovery = !$("freshActivity").hidden && model.recovery;
        const sameSourceFailure = recovery && !collectionReadError && collection?.error
            && collection.state === "error" && Number.isSafeInteger(model.sourceFailure?.revision)
            && typeof model.sourceFailure?.configVersion === "string"
            && collection.configVersion === model.sourceFailure.configVersion
            && collection.revision === model.sourceFailure.revision
            && collection.lastCheck?.id === model.sourceFailure.lastCheckId
            && collection.error === model.sourceFailure.error;
        host.hidden = ["settings", "collection-status"].includes(route.view) || !notice || setupHandled
            || ["reports", "request"].includes(route.view) && notice?.severity === "normal"
            || !$("message").hidden && $("message").dataset.connectionFailure === "true"
            || Boolean(collectionReadError) && refreshOwnsReadFailure()
            || recovery && notice?.severity === "normal" && collection?.state === "paused"
            || Boolean(sameSourceFailure);
        const retryHost = route.view === "collection-status" ? $("collectionStatus").parentElement : host;
        if ($("collectionRetry").parentElement !== retryHost) retryHost.append($("collectionRetry"));
        $("collectionRetry").hidden = !collectionReadError || refreshOwnsReadFailure()
            || !$("message").hidden && Boolean($("message").querySelector("[data-stored-refresh-retry]"));
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
        liveSearchUI?.invalidate("Current collection status could not be verified. Search results were cleared.");
        collectionReadError = error;
        collectionReadReason = reason;
        collectionSettings?.unavailable(error);
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
        const connection = route.view === "settings" && settingsNavigation.resolve(route).section === "connection";
        const contextual = route.view === "analyze" || connection || route.view === "collection-status";
        const anchor = route.view === "analyze" ? $("collectionNotice")
            : route.view === "collection-status" ? $("collectionCoverageCounts") : $("connectionPreferences");
        if (host.nextElementSibling !== anchor) anchor.before(host);
        const details = host.querySelector(".fresh-details"), links = $("freshHelp").querySelector(".fresh-links");
        const sourceHost = route.view === "analyze" ? links : details;
        if ($("freshSourceSetup").parentElement !== sourceHost) sourceHost.prepend($("freshSourceSetup"));
        if (host.querySelector(".fresh-controls").lastElementChild !== $("freshResult")) {
            host.querySelector(".fresh-controls").append($("freshResult"));
        }
        host.hidden = !contextual;
        $("freshHeading").hidden = !contextual || route.view === "analyze";
        const globalRecovery = !$("message").hidden && $("message").querySelector("[data-stored-refresh-retry]");
        const attention = ["checking", "applying", "waiting"].includes(model.phase) || model.recovery
            || refreshOwnsReadFailure() || !globalRecovery && (["error", "unconfirmed"].includes(model.phase) || collectionReadError || isStale && !isLoading);
        $("freshAwayNotice").hidden = contextual || !attention;
        setText($("freshAwayStatus"), model.sourceUnknown ? " Source check outcome is unknown; no check will be repeated."
            : model.sourceBlocked ? " Source checks are read-only in this tab; review the recovery details."
            : model.phase === "checking" ? " Checking approved history."
            : model.phase === "applying" ? " Reading stored activity."
            : model.phase === "waiting" ? " Waiting until the current review or edits finish."
            : model.phase === "error" || model.sourceFailure ? " " + model.message : " Stored activity or its status could not be verified.");
        host.dataset.phase = model.phase;
        host.dataset.checkId = model.check?.id || "";
        host.dataset.revision = model.check ? String(model.check.revision) : "";
        const control = $("checkActivity");
        const text = "Refresh";
        if (control.lastChild?.nodeType === Node.TEXT_NODE) control.lastChild.textContent = text;
        ux.pending(control, ["checking", "applying"].includes(model.phase));
        $("freshSourceSetup").hidden = Boolean(approved) || connection;
        setText($("freshHelp").querySelector("summary"), connection ? "About Refresh" : "Source and collection");
        $("freshHelp").querySelector(".fresh-links").hidden = connection;
        setText($("freshScope"), approved
            ? `Local Copilot history · ${collection.config.windowDays}-day window`
            : "Choose which local Copilot history this app can read.");
        const completed = ["complete", "partial"].includes(model.phase) && Boolean(model.check);
        setText($("freshChecked"), completed ? `Manual check ${timestamp(model.check.completedAt)}` : "");
        $("freshChecked").hidden = !completed;
        setText($("freshStatus"), model.message || (approved ? "Refresh recorded activity." : "Stored activity only. No source is approved."));
        ux.pending($("freshStatus"), ["checking", "applying"].includes(model.phase));
        $("freshStatus").hidden = approved && model.phase === "idle";
        const paused = model.recovery && !collectionReadError && approved && collection?.config?.enabled === false;
        setText($("freshContextMessage"), [model.context, model.sourceWarning, paused ? "Collection is paused." : ""].filter(Boolean).join(" "));
        $("freshContextMessage").hidden = !model.context && !model.sourceWarning;
        setText($("freshCheckDetails"), model.details);
        $("freshCheckDetails").hidden = !model.details;
        setText($("freshCoverageAnnouncement"), model.coverage);
        $("freshStatus").dataset.severity = model.phase === "error" || model.sourceFailure ? "error" : model.phase === "partial" ? "warning" : "normal";
        $("freshIssues").hidden = model.phase !== "partial" && model.recovery !== "source";
        $("freshIssues").href = model.phase === "partial" ? "#collection-status?setting=issues" : "#settings?section=connection&setting=source-paths";
        setText($("freshIssues"), model.phase === "partial" ? model.coverage : "Review source");
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
        renderCollectionNotice();
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
        const initiatingNavigation = navigationGeneration, initiatingIntent = readingIntent;
        const checkSource = collection?.config?.approved === true;
        const token = fresh.begin({ checkSource });
        if (token === null) return null;
        const sourceIdentity = { configVersion: collection?.configVersion, revision: collection?.revision, lastCheckId: collection?.lastCheck?.id };
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
            // A generic 422 can follow dispatch; only a specific pre-read source code settles it.
            const failed = fresh.fail(token, error.message, { rejected: error.code === "request_rejected" && error.status !== 422, reason: error.reason, ...sourceIdentity });
            if (failed && !fresh.snapshot().sourceUnknown) clearSourceCheckMarker();
            return false;
        } finally {
            collectionBusy = false;
            collectionSettings?.setChecking(false);
            renderFreshActivity();
            if (initiatingControl === $("checkActivity") && navigationGeneration === initiatingNavigation && readingIntent === initiatingIntent
                && initiatingControl.checkVisibility() && document.activeElement === document.body) ux.restoreFocus(initiatingControl);
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
            if (exportWriting ? !Number.isSafeInteger(draft.contextRevision()) : !ensureCurrentTime()) return;
            const status = await api("/api/collection/status", {});
            if (readGeneration !== collectionReadGeneration || collectionBusy) return;
            if (draft.observeContext(status, { writing: exportWriting })) {
                scrubContextPreview();
                if (!exportWriting) invalidatePreview("Recorded context changed or became unavailable. Prepare a new preview; ordinary prompt edits are kept.");
            }
            periodComparisonUI.observe(status.assessment);
            if (exportWriting) return;
            ignoringStaleContextStatus = Number.isSafeInteger(draft.contextRevision()) && status.revision < draft.contextRevision();
            try { assessmentUI.observe(status.assessment); }
            finally { ignoringStaleContextStatus = false; }
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
            const preview = await api("/api/preview", { ...(periodReport ? { periodComparison: periodReport.value,
                ...(periodReport.semanticSelection ? { semanticSelection: periodReport.semanticSelection } : {}) } : { selection }), options: draft.options() });
            if (!ensureCurrentTime() || !draft.current(operation) || !reportJourney.isReviewOpen()) {
                if (preview.previewId) await api("/api/cancel-preview", { previewId: preview.previewId });
                return;
            }
            if (preview.privacy?.allSelectedFieldsScanned !== true || !preview.files || !preview.previewId) throw new Error("The local privacy scan is incomplete. Export is blocked.");
            if (!draft.bindContext(preview)) {
                await api("/api/cancel-preview", { previewId: preview.previewId });
                throw new Error("Recorded context changed while preparing this preview. Read current activity and prepare a new preview.");
            }
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
        body.dataset.recordedContext = String(Boolean(preview.snapshot?.recordedContext));
        const contextToken = draft.contextToken();
        const steps = el("ol", "privacy-steps");
        steps.append(el("li", "", "Local scan"), el("li", "current", "Disclosure review"), el("li", "", "Confirm local write"));
        const modeLabels = { none: "No prompts", masked: "Masked prompts", original: "Original prompts" };
        const mode = preview.promptMode || "none";
        const formats = (preview.formats || ["markdown"]).map((f) => f === "markdown" ? "Markdown" : f.toUpperCase()).join(", ");
        const snapshotDetails = el("details", "detail-disclosure report-snapshot-details");
        snapshotDetails.append(el("summary", "", "Included evidence and preparation details"), el("p", "report-confirmation",
            preview.snapshot?.periodComparison ? `One paired report / ${preview.records.length} supporting-copy groups. ${modeLabels[mode]} / ${formats}`
                : `One report · ${chatCopy.groups(preview.records.length)} included. ${modeLabels[mode]} / ${formats}`));
        body.append(steps, snapshotDetails);
        if (preview.snapshot?.periodComparison) {
            const { baseline, later } = preview.snapshot.periodComparison.periods;
            snapshotDetails.append(el("p", "report-confirmation", `Two frozen cohorts: ${baseline.rows.length} matching records in Period A; ${later.rows.length} in Period B. Supporting copies do not add analytical calls or assessment units.`));
        }
        if (reportEntry) snapshotDetails.append(el("p", "report-confirmation", `GitHub Copilot chat: ${reportEntry.sessionName} / ${reportEntry.projectId ? "Copilot project: " + reportEntry.projectName : "Copilot chat without a project"}. Complete eligible request groups from this Copilot chat only.`));
        if (preview.snapshot?.selectionScope) {
            const scope = preview.snapshot.selectionScope;
            snapshotDetails.append(el("p", "report-confirmation", `Scope: ${({ all: "All collected activity", current: "Current view", selected: "Selected requests" })[scope.kind]}. ${scope.workIqActions} Work IQ tool calls; ${scope.returnedApiResults} tool-returned API results; ${scope.graphRequestSites} recorded Graph request sites (${scope.graphVisibleStatuses} with visible status); ${scope.ownedHttpRecords} owned HTTP records; ${scope.graphCodeReferences} Graph code references. Separate units, never summed.`));
            snapshotDetails.append(el("p", "muted", `${scope.exclusions.excludedOrDuplicateEvidenceRecords} collection evidence records excluded or deduplicated; ${scope.exclusions.unknownSourceRequestGroups} groups with unknown source identity. Existing review labels and original evidence will remain unchanged.`));
        }
        if (preview.timeContext) snapshotDetails.append(el("p", "report-time-context", `Report timezone: ${time.label(preview.timeContext)}. Locale: ${preview.timeContext.locale}. Prepared: ${preview.snapshot.preparedAtDisplay}.`));
        body.append(el("p", "report-privacy-note", mode === "original" ? "Personal wording will be included in local files. Detected credentials are removed even in Original mode. This is not permission to publish or upload." : mode === "none" ? "Request, follow-up and tool question text is omitted. Originals remain available here locally." : "Your retained wording is masked, not rewritten or summarized. Check unlabelled names and confidential meaning yourself."));
        if (preview.snapshot?.recordedContext) {
            const context = preview.snapshot.recordedContext;
            const note = el("section", "report-context-review");
            note.append(el("h3", "", "Recorded context in this report"),
                el("p", "", `${context.coverage.entries} context entries; ${context.coverage.included} included, ${context.coverage.omitted} omitted, ${context.coverage.unavailable} unavailable, ${context.coverage.partial} partial. Context does not add analytical requests, calls, timing samples or verdicts.`),
                el("p", "muted", context.boundary), el("p", "muted", context.limitation));
            for (const gap of new Set(context.anchors.flatMap(anchor => anchor.gaps))) note.append(el("p", "context-help-note", gap));
            body.append(note);
        }
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
        const reviewCopies = [...(preview.promptReview ?? []), ...(preview.contextReview ?? [])];
        if (reviewCopies.length) {
            const comparisons = el("section", "prompt-comparisons");
            comparisons.append(el("h3", "", "Text in your report"));
            const incomplete = reviewCopies.filter(prompt => prompt.status !== "full" || prompt.original === null).length;
            const removals = reviewCopies.reduce((sum, prompt) => sum + prompt.changes.length, 0);
            comparisons.append(el("p", "prompt-review-summary", `${count(reviewCopies.length)} copies · ${count(removals)} removals${incomplete ? ` · ${count(incomplete)} incomplete, excluded or unavailable sources` : ""}. Originals stay unchanged; edits affect this report only.`));
            const copies = el("div");
            pagedList(copies, reviewCopies, { key: "copies:" + preview.previewId, size: 1, noun: "report copies", renderItem: prompt => {
                detailOwner = "preview:" + preview.previewId + ":" + prompt.key;
                const displayLabel = prompt.kind === "response" ? "Recorded reply (context; finality unverified)"
                    : prompt.kind === "origin" ? textAccess.caption(prompt) : prompt.kind === "tool" ? `Recorded tool argument (${prompt.label})` : `${prompt.label} / ${textAccess.caption(prompt)}`;
                const item = el("article", "prompt-comparison");
                item.append(el("h4", "", `${displayLabel}${prompt.omitted ? " · omitted" : ""}`));
                const pair = el("div", "prompt-pair");
                const original = el("div", "prompt-original"), copy = el("div", "prompt-report");
                if (prompt.original === null) original.append(el("p", "", "Original text is unavailable."));
                else {
                    const originalBlock = ux.codeBlock(prompt.original, { label: "Local original", copyLabel: "Copy local original", prose: true });
                    original.append(mode === "none" ? disclosure("Read local original; not included in report", originalBlock) : originalBlock);
                }
                original.append(el("p", "muted", `Source status: ${prompt.status}. ${prompt.status === "full" ? "Exact retained text." : "Incomplete or unavailable; not reconstructed."}`));
                const rendered = el("pre");
                if (prompt.text === null) copy.append(el("p", "", prompt.omitted ? prompt.kind === "response" ? "No reply text included." : "No prompt text included." : "Source text unavailable; not reconstructed."));
                else {
                    for (const segment of prompt.segments) {
                        if (segment.category) {
                            const mark = el("mark", segment.mandatory ? "mandatory" : "", segment.text);
                            mark.tabIndex = 0;
                            rendered.append(ux.tooltip(mark, segment.mandatory ? "Mandatory credential removal. Cannot be restored to an export." : `This span replaces a ${segment.category.replaceAll("_", " ")} match in the report copy. Your local original is unchanged.`));
                        } else rendered.append(document.createTextNode(segment.text));
                    }
                    copy.append(ux.attachCopy(rendered, { label: "Report copy", copyLabel: prompt.kind === "response" ? "Copy report reply" : mode === "masked" ? "Copy masked prompt" : "Copy original-mode prompt", getText: () => rendered.textContent, prose: true }));
                }
                for (const category of [...new Set(prompt.changes.map((c) => c.category))]) copy.append(el("p", "muted", `${category.replaceAll("_", " ")}: ${prompt.changes.filter((c) => c.category === category).length} removal(s).`));
                if (prompt.changes.some((c) => c.mandatory)) copy.append(el("p", "notice", "Mandatory credential removal. This copy is not byte-identical to the original."));
                if (prompt.edited) copy.append(el("p", "muted", "You edited this report copy. It is not the original wording."));
                pair.append(original, copy);
                item.append(pair);
                if (mode !== "none" && prompt.original !== null) {
                    const edit = el("details", "detail-disclosure");
                    edit.append(el("summary", "", "Edit or omit this report copy"));
                    const fields = el("fieldset", "report-copy-controls");
                    fields.disabled = exportWriting || reportJourney.snapshot().saveUnconfirmed;
                    const omit = el("input"), omitLabel = el("label", "attestation");
                    omit.type = "checkbox"; omit.checked = prompt.omitted;
                    omitLabel.append(omit, el("span", "", prompt.scenarioRef ? "Omit this copy from the report" : "Omit this prompt from the report"));
                    const textarea = el("textarea");
                    const override = draft.options().overrides.find(value => value.key === prompt.key);
                    omit.checked = override?.omit ?? prompt.omitted;
                    textarea.rows = 5; textarea.value = override?.text ?? prompt.text ?? ""; textarea.disabled = omit.checked;
                    textarea.setAttribute("aria-label", `Report copy: ${displayLabel}`);
                    const saveEdit = () => {
                        if (exportWriting || reportJourney.snapshot().saveUnconfirmed) return;
                        const overrides = draft.options().overrides.filter((o) => o.key !== prompt.key);
                        overrides.push({ key: prompt.key, omit: omit.checked, ...(omit.checked || prompt.omitted && !textarea.value ? {} : { text: textarea.value }) });
                        draft.change({ overrides });
                        changed();
                    };
                    omit.addEventListener("change", () => {
                        if (exportWriting || reportJourney.snapshot().saveUnconfirmed) return;
                        textarea.disabled = omit.checked; saveEdit();
                    });
                    textarea.addEventListener("input", saveEdit);
                    fields.append(omitLabel, el("p", "", "Edit the exported copy only. Detected credentials and, in Masked mode, personal patterns are removed again when rebuilt."), textarea);
                    edit.append(fields);
                    item.append(edit);
                }
                return viewKey(item, detailOwner);
            } });
            comparisons.append(copies);
            body.append(comparisons);
        }
        const report = el("div", "report-document"), exactFiles = el("section", "report-file-inspection");
        function showExactFiles(value) {
            if (value.snapshot?.recordedContext && !draft.contextCurrent(contextToken)) return;
            if (value.snapshot?.recordedContext) renderedContextBundles.add(value);
            exactFiles.replaceChildren(el("h3", "", "Exact files"));
            for (const [name, text] of Object.entries(value.files)) {
                if (typeof text === "string") exactFiles.append(disclosure("Inspect exact " + name, text));
                else exactFiles.append(el("p", "muted", `${name}: prepared in memory; saved only after your separate confirmation.`));
            }
        }
        function showFiles(value) {
            if (value.snapshot?.recordedContext && !draft.contextCurrent(contextToken)) return;
            if (value.snapshot?.recordedContext) renderedContextBundles.add(value);
            report.replaceChildren();
            if (value.previewHtml) {
                preparedReportReader?.dispose();
                preparedReportReader = assessmentFactories.preparedFrame(value.previewHtml, assessmentFactories.liveSearch.frozenFrame, {
                    onError: message => {
                        if (!draft.current(operation) || exportWriting) return;
                        invalidatePreview(message);
                        reportJourney.failed(message);
                    },
                });
                report.append(preparedReportReader.frame);
            } else if (value.files["product-report.md"]) report.append(renderDocument(value.files["product-report.md"]));
            showExactFiles(value);
            report.append(exactFiles);
        }
        showFiles(preview);
        body.append(report);
        const scan = el("details", "detail-disclosure report-privacy-findings");
        scan.append(el("summary", "", "What the local privacy scan found"));
        for (const [category, occurrences] of Object.entries(preview.privacy.categories || {})) if (occurrences) scan.append(el("p", "", `${category.replaceAll("_", " ")}: ${occurrences} source occurrence(s). The report-copy comparison shows what is removed or retained.`));
        scan.append(facts([["Original prompts", preview.privacy.originatingPrompts], ["Follow-ups", preview.privacy.followUpPrompts], ["Argument objects", preview.privacy.toolArgumentObjects], ["Strings scanned", preview.privacy.stringsScanned], ["All selected fields scanned", "Yes"]]));
        scan.append(el("p", "", preview.privacy.transformation));
        for (const limitation of preview.privacy.limitations || []) scan.append(el("p", "", limitation));
        if (preview.privacy.context) {
            scan.append(el("p", "", `Context: ${preview.privacy.context.coverage.sourceBytes} source UTF-8 text bytes; ${preview.privacy.context.coverage.projectedBytes} projected bytes. All contextual copies scanned.`));
            for (const [category, occurrences] of Object.entries(preview.privacy.context.categories)) if (occurrences) {
                scan.append(el("p", "", `Additional context ${category.replaceAll("_", " ")}: ${occurrences} source occurrence(s).`));
            }
        }
        body.append(scan);
        const attestation = el("label", "attestation"), checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.dataset.reviewControl = "";
        attestation.append(checkbox, el("span", "", `I reviewed this report, its text changes and limits. I approve ${modeLabels[mode].toLowerCase()} in ${formats} for local files.`));
        const approval = el("section", "report-approval");
        approval.id = "reportApproval";
        approval.append(attestation);
        body.append(approval);
        const feedback = el("p", "muted");
        feedback.setAttribute("role", "status");
        const review = button("Approve for local saving", async () => {
            if (isLoading || isStale || !ensureCurrentTime() || !checkbox.checked || !draft.current(operation)) return;
            review.disabled = checkbox.disabled = true;
            feedback.textContent = "Recording your disclosure review...";
            ux.pending(review, true);
            try {
                const result = await api("/api/privacy-review", { previewId: activePreview.previewId, disclosureReviewed: true, timeContext: viewerTime });
                if (!ensureCurrentTime() || !draft.current(operation) || !reportJourney.isReviewOpen()) return;
                if (result.privacy?.reviewerConfirmed !== true || result.privacy?.allSelectedFieldsScanned !== true) throw new Error("The review was not confirmed.");
                activePreview = result;
                showExactFiles(result);
                review.textContent = "Disclosure reviewed";
                steps.children[1].classList.remove("current"); steps.children[2].classList.add("current");
                feedback.textContent = "Disclosure approved. Not saved yet.";
                confirm.disabled = false;
                reportJourney.reviewed();
            } catch (error) { feedback.className = "notice error"; feedback.setAttribute("role", "alert"); feedback.textContent = error.message + " Prepare a new preview."; review.textContent = "Review not confirmed"; reportJourney.failed(feedback.textContent); }
            finally { ux.pending(review, false); }
        });
        ux.pending(review, false);
        review.disabled = true;
        review.dataset.reviewControl = "";
        checkbox.addEventListener("change", () => { review.disabled = !checkbox.checked || !draft.current(operation); });
        const confirm = button("Save report locally", async () => {
            if (exportWriting || isLoading || isStale || !ensureCurrentTime() || !draft.current(operation) || activePreview?.privacy?.reviewerConfirmed !== true || !reportJourney.isReviewOpen()) return;
            confirm.disabled = true;
            ux.pending(confirm, true);
            exportWriting = true;
            reportJourney.writing(true);
            $("clearPreviewSelection").disabled = true;
            $("closeDialog").disabled = true;
            feedback.textContent = "Saving your reviewed files. This save cannot be cancelled or repeated.";
            const expectedBundleId = activePreview.bundleId;
            let exportResponseReceived = false;
            const offerSaveRecovery = () => {
                const recovery = button("Check save status", async () => {
                    recovery.disabled = true;
                    try {
                        const loaded = await load({ afterExport: true });
                        if (!recovery.isConnected || !reportJourney.snapshot().saveUnconfirmed) return;
                        if (!loaded) throw new Error("Saved history is unavailable. The outcome remains unconfirmed; no save was repeated.");
                        const saved = state.exports.find(item => item.bundleId === expectedBundleId);
                        if (!saved) throw new Error("No registered receipt is available for this report. The outcome remains unconfirmed; no save was repeated.");
                        preparedReportReader?.dispose(); preparedReportReader = null;
                        reportJourney.saved(saved, { available: true });
                        updateSelection();
                    } catch (error) { if (recovery.isConnected) reportJourney.failed(error.message); }
                    finally { if (recovery.isConnected) recovery.disabled = false; }
                });
                $("reportSaveBody").append(recovery);
            };
            try {
                const result = await api("/api/export", { previewId: activePreview.previewId, confirmed: true, timeContext: viewerTime });
                exportResponseReceived = true;
                if (result.bundle?.bundleId !== expectedBundleId) throw new Error("The saved report receipt did not match the dispatched report.");
                activePreview = null;
                presentation.setPage("saved-reports:" + localQuery("savedReportSearch"), 0);
                const loaded = await load({ afterExport: true });
                if (!loaded) {
                    reportJourney.failed("The report save was confirmed, but its availability could not be checked. Read saved history before downloading; do not save it again.");
                    offerSaveRecovery();
                    announce("The report save was confirmed. Current saved files could not be checked; use Retry without repeating the save.", "stale", true);
                    return;
                }
                const available = state.exports.some(bundle => bundle.bundleId === result.bundle.bundleId);
                preparedReportReader?.dispose(); preparedReportReader = null;
                reportJourney.saved(result.bundle, { available });
                if (route.view !== "reports") announce(available ? "Local report saved: " + result.bundle.bundleDir + ". Disclosure reviewed; not a privacy certification."
                    : "The saved report is no longer available. Its downloads have been removed.", available ? "" : "stale");
            } catch (error) {
                activePreview = null;
                const saveRejected = !exportResponseReceived && error.code === "request_rejected";
                feedback.className = "notice error"; feedback.setAttribute("role", "alert");
                feedback.textContent = error.message + (saveRejected
                    ? " The save was rejected before dispatch. No files were written. Return to Setup and read current state before preparing a new review."
                    : " The local write may have completed. Check save status; do not repeat the save.");
                confirm.textContent = saveRejected ? "Save not sent" : "Export not confirmed";
                reportJourney.failed(feedback.textContent, { saveRejected });
                if (!saveRejected) offerSaveRecovery();
            }
            finally { ux.pending(confirm, false); exportWriting = false; reportJourney.writing(false); $("closeDialog").disabled = false; $("clearPreviewSelection").disabled = false; updateSelection(); }
        }, "primary");
        ux.pending(confirm, false);
        confirm.disabled = true;
        confirm.dataset.reviewControl = "";
        const controls = el("div", "dialog-actions");
        controls.append(review, confirm);
        approval.append(feedback, el("p", "muted", "Nothing is uploaded. Changes require a fresh review."));
        body.append(controls);
        const textPanel = el("section", "report-inspection-panel report-copy-inspection");
        textPanel.id = "reportTextInspection";
        for (const node of body.querySelectorAll(":scope > .report-privacy-note,:scope > .report-context-review,:scope > .prompt-comparisons,:scope > .report-privacy-findings")) textPanel.append(node);
        const filesPanel = report.querySelector(".report-file-inspection");
        filesPanel.id = "reportFileInspection";
        report.id = "reportDocumentInspection";
        const tabs = el("nav", "report-inspection-tabs");
        tabs.setAttribute("aria-label", "Report inspection");
        const tabList = el("div", "report-inspection-choices");
        tabList.setAttribute("role", "tablist");
        const views = [[report, "Report"], [textPanel, `Text (${reviewCopies.length})`], [filesPanel, `Files (${Object.keys(preview.files).length})`]];
        const tabControls = [];
        views.forEach(([panel, label], index) => {
            panel.setAttribute("role", "tabpanel");
            const tab = button(label, () => {
                const top = tab.getBoundingClientRect().top;
                views.forEach(([other], i) => { other.hidden = i !== index; });
                tabControls.forEach((control, i) => { control.setAttribute("aria-selected", String(i === index)); control.tabIndex = i === index ? 0 : -1; });
                window.scrollBy(0, tab.getBoundingClientRect().top - top);
            }, "quiet");
            tab.id = "reportInspectionTab" + index;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", panel.id);
            tab.setAttribute("aria-selected", String(index === 0));
            tab.tabIndex = index === 0 ? 0 : -1;
            panel.setAttribute("aria-labelledby", tab.id);
            panel.hidden = index !== 0;
            tabControls.push(tab); tabList.append(tab);
        });
        tabList.addEventListener("keydown", event => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            const current = tabControls.indexOf(document.activeElement);
            if (current < 0) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabControls.length - 1
                : (current + (event.key === "ArrowRight" ? 1 : -1) + tabControls.length) % tabControls.length;
            tabControls[next].click(); tabControls[next].focus();
        });
        tabs.append(tabList, button("Review & save", () => {
            const offset = (parseFloat(getComputedStyle(tabs).top) || 0) + tabs.getBoundingClientRect().height + 12;
            window.scrollBy(0, approval.getBoundingClientRect().top - offset);
            (checkbox.disabled ? confirm : checkbox).focus({ preventScroll: true });
        }, "quiet"));
        body.prepend(tabs);
        approval.before(report, textPanel, filesPanel);
        reportJourney.previewReady({ ...preview, promptReview: reviewCopies }, { confirm, feedback });
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
        draft.clearContext({ writing: exportWriting });
        scrubContextPreview();
        if (exportWriting) return;
        invalidatePreview();
        invalidateDialog("The panel reconnected. Close and prepare a new report preview before continuing.");
        if (analytics) { isStale = true; updateSelection(); }
        load();
    }
    function handleVisibilityChange() {
        draft.clearContext({ writing: exportWriting });
        scrubContextPreview();
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
    for (const id of ["pageAction", "exploreLink", "reportLibraryLink", "reportCreateLink"]) $(id).addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const reportTask = event.currentTarget.closest("#reportTaskNav");
        if (!reportTask && (isLoading || isStale)) return;
        if (id === "reportCreateLink" && ["saved", "unavailable"].includes(reportJourney.snapshot().phase)) clearReportSelection();
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
    $("dateFilter").addEventListener("change", () => {
        dateDraft = null;
        dateError("");
        const range = $("dateFilter").value;
        $("dateFields").hidden = range !== "custom";
        const dates = range === "capture" ? { range: undefined, from: undefined, to: undefined }
            : { range, ...time.preset(range, viewerTime.timeZone) };
        navigate(routeFor(route.view, { ...dates, bucket: undefined, page: undefined }), false, { keepFocus: true });
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
        navigate(routeFor(route.view, { range: "custom", from, to, bucket: undefined, page: undefined }), false, { keepFocus: true });
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
    $("openAnalysisSearch").addEventListener("click", () => liveSearchUI.analysisScope());
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
    const settingsSearchIcon = ux.icon("search");
    settingsSearchIcon.classList.add("settings-search-icon");
    $("settingsSearch").before(settingsSearchIcon);
    for (const category of settingsNavigation.categories) {
        const anchor = link("", "settings", { section: category.id, setting: undefined, issues: undefined });
        anchor.dataset.category = category.id;
        anchor.append(ux.icon(`settings-${category.id}`), el("span", "settings-category-label", category.title));
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
        if (exportWriting || periodReport) return;
        reportScope = control.value;
        reportEntry = null;
        invalidatePreview(); renderReports();
    }));
    $("reportPromptAuthorFilter").addEventListener("change", () => {
        if (exportWriting || periodReport) return;
        reportAuthors = authorship.selection([...$("reportPromptAuthorFilter").selectedOptions].map(option => option.value));
        invalidatePreview("Prompt authors changed. Review the updated report membership before saving.");
        renderReports();
    });
    ux.explainDisabled($("exportBtn"), () => isStale || isLoading ? "Wait for a current activity snapshot." : !draft.options().formats.length ? "Select at least one file format." : "Choose interactions in Activity, or use Current Analyze view or All saved sessions.");
    document.querySelectorAll("[name=promptMode]").forEach((control) => control.addEventListener("change", () => {
        draft.change({ promptMode: control.value, overrides: [], ...(control.value === "none" ? { recordedContext: false } : {}) });
        invalidatePreview(); updateSelection();
    }));
    $("reportRecordedContext").addEventListener("change", () => {
        if (exportWriting) return;
        draft.change({ recordedContext: $("reportRecordedContext").checked, overrides: [] });
        invalidatePreview(); updateSelection();
    });
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
    window.addEventListener("pagehide", () => { pageInactive = true; preparedReportReader?.dispose(); preparedReportReader = null; assessmentUI.leave(); automaticUI.leave(); savedArtifactUI?.leave(); clearTimeout(pollTimer); });
    window.addEventListener("pageshow", () => { pageInactive = false; clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 250); });
    document.addEventListener("visibilitychange", () => { assessmentUI.clearPrivateText(); if (!document.hidden) { clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 250); } });
    for (const node of document.querySelectorAll("details[id]")) {
        if (!node.dataset.disclosureKey && node.id !== "settingsCategories") bindDetails(node, node.id, undefined, node.id === "bundles");
    }
    // The shared panel stays put; the plot's top changes with mode-specific heading controls.
    viewKey($("chart").closest(".analyze-chart-main"), "chart");
    reportJourney = createReportJourney({
        onStateChange: () => { renderStoredRefresh(); renderReportTask(); updateRequestReportActions(); },
        root: $("reportsView"), cancelReview: invalidatePreview, clearSelection: clearReportSelection,
        readCurrent: () => load(),
        showSourceIssues: async () => {
            await go("collection-status", { setting: "issues" });
        },
        downloadFile: downloadReportFile,
        openSavedReport,
        icon: name => ux.icon(name),
    });
    reportComparisonUI = assessmentFactories.mountComparison($("comparisonWorkspace"), {
        api, renderer: assessmentFactories.createReportComparison(), timeContext: () => viewerTime,
        refresh: () => load({ background: true }), onError: message => announce(message, "error"),
    });
    savedArtifactUI = assessmentFactories.createArtifactDeletion({
        api, ux, onError: message => announce(message, "error"),
        fallbackFocus: () => {
            const saved = $("savedLibraryTitle");
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
