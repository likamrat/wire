// Shared route adapter, serialized with the shell. Matching stays in activity analytics.
export function createFilterState(results, authorship) {
    const sources = [
        { id: "github-copilot", label: "GitHub Copilot" },
        { id: "microsoft-365-chat", label: "Microsoft 365 Copilot Chat" },
        { id: "microsoft-365-cowork", label: "Cowork" },
    ];
    function sourceLabel(id) {
        if (id === "microsoft-365") return "Microsoft 365";
        const source = sources.find(source => source.id === id);
        if (!source) throw new RangeError("Accepted source is unavailable.");
        return source.label;
    }
    function sourceIdentity(rows) {
        if (!Array.isArray(rows) || !rows.length) return null;
        const source = sources.find(source => source.id === rows[0]?.sourceId);
        return source && rows.every(row => row?.sourceId === source.id) ? { ...source } : null;
    }
    function canonical(route) {
        const next = { ...route };
        if (next.source === "all") next.source = undefined;
        if (typeof next.services === "string") next.services = [...new Set(next.services.split(",").filter(Boolean))].sort().join(",") || undefined;
        if (typeof next.withinServices === "string") next.withinServices = [...new Set(next.withinServices.split(",").filter(Boolean))].sort().join(",") || undefined;
        if (!next.services) next.includeMissingService = undefined;
        else if (["true", "false"].includes(next.includeMissingService)) next.includeMissingService = next.includeMissingService === "true";
        return next;
    }
    function query(route) {
        const filters = { scope: route.scope || "history", includeMetadata: route.layer === "http" };
        if (route.source) filters.sources = route.source === "microsoft-365"
            ? ["microsoft-365-chat", "microsoft-365-cowork"] : [route.source];
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
        const retained = Object.fromEntries(["layer", "range", "from", "to", "bucket", "timelineFrom", "tool", "service", "services", "includeMissingService",
            "withinServices", "scope", "authors", "result", "project", "endpoint", "source", "nativeGroup"].filter(key => route[key] !== undefined).map(key => [key, route[key]]));
        return reconcileTimeline(route, { ...retained, ...next });
    }
    function bucket(route) {
        return route.bucket || "day";
    }
    function reconcileTimeline(previous, next) {
        const basis = value => {
            const route = canonical(value);
            return JSON.stringify([route.layer || "tool", bucket(route), query(route),
                route.withinServices || "", route.nativeGroup || "", route.search || "", route.analysisQuery || ""]);
        };
        return basis(previous) === basis(next) ? next : { ...next, timelineFrom: undefined };
    }
    return { canonical, query, scope, bucket, reconcileTimeline, sources, sourceLabel, sourceIdentity };
}

// Refine only an accepted canonical snapshot. Private search never becomes a server filter.
export function createAnalysisSlice(localSearch, projection) {
    function legacyScenarioIds(snapshot, search) {
        if (!search.trim()) return undefined;
        const sources = new Map((snapshot.sessions || []).map(source => [source.sessionId, source]));
        const records = new Map(snapshot.scenarios.map(scenario => [scenario.scenarioId, scenario]));
        return [...records.values()].filter(scenario => {
            const source = sources.get(scenario.sourceSessionId);
            return localSearch.phrase(search, [scenario.userPrompt?.text,
                ...(scenario.recordKind === "native-conversation" ? scenario.nativeConversation.messages
                    .filter(message => message.availability === "recorded").map(message => message.value.text) : []),
                scenario.title, source?.project, source?.name,
                scenario.project, scenario.sourceSessionName, scenario.sourceSessionId]);
        }).map(scenario => scenario.scenarioId).sort();
    }
    function slice(snapshot, options, search = "", withinServices = [], membership) {
        if (!Array.isArray(withinServices) || withinServices.some(service => typeof service !== "string" || !service)) {
            throw new TypeError("Service chart refinements require named services.");
        }
        const base = snapshot.analytics, records = new Map(snapshot.scenarios.map(scenario => [scenario.scenarioId, scenario]));
        if (membership && (membership.revision !== snapshot.revision || membership.nativeRevision !== snapshot.nativeRead?.revision
            || membership.scopeKey !== JSON.stringify([options, withinServices])
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
        const rows = refineRows(base.rows);
        const population = base.population?.scenarioIds;
        if (population !== undefined && (!Array.isArray(population) || new Set(population).size !== population.length
            || population.some(id => !records.has(id)))) throw new TypeError("Accepted conversation population is unavailable.");
        const contextIds = base.population?.contextOnlyScenarioIds ?? [];
        if (!Array.isArray(contextIds) || new Set(contextIds).size !== contextIds.length
            || contextIds.some(id => !population?.includes(id) || records.get(id).recordKind !== "native-conversation")
            || contextIds.length && base.population.contextDateBasis !== "ordinary-message-created") {
            throw new TypeError("Accepted message-date context is unavailable.");
        }
        const context = new Set(contextIds);
        const matched = new Set(rows.map(row => row.scenarioId).filter(id => records.has(id)));
        const scenarioIds = population ? population.filter(id => matched.has(id)
            || !withinServices.length && (!legacy || legacy.has(id)) && (!membership || matches.has(id))
                && records.get(id).recordKind === "native-conversation"
                && (context.has(id) || !records.get(id).nativeConversation.calls.length))
            : [...matched];
        let analytics = base;
        if (hasQuery || withinServices.length) {
            if (population && typeof projection.narrowPopulation !== "function") {
                throw new TypeError("Conversation refinement requires the shared accepted-population projection.");
            }
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
                ...(population ? { population: projection.narrowPopulation(base.population, scenarioIds, rows, snapshot.scenarios) } : {}),
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

export function mountEvidence(capability, createBoardTransport, theme, createReportDraft, createEvidenceUX, uxIcons, mountThemeControl, createTimeContext, createServiceCategories, createDimensionalCharts, dimensionalIcons, mountSidebarNavigation, createReportScope, createSelectControls, createInlineMetadata, createControlHelp, createRecordedResults, createLiveState, createDisclosureState, createCollectionStatus, createSessionJourney, createReportJourney, mountCollectionSettings, createTextAccess, createPeriodFlow, createChatCopy, mountDisplayTimeSettings, createLocalSearch, createSettingsNavigation, createFreshActivity, createPercentageCharts, createRequestTiming, mountRecorderDiagnostics, createDeletionFlow, mountDeletion, assessmentFactories, createPromptAuthorship, createFilterState, createAnalysisSlice, createActivityProjection, createRequestContext, createCallInvestigation, accessBootstrap) {
    const $ = (id) => document.getElementById(id);
    const api = createBoardTransport(capability, sessionChanged, accessBootstrap);
    const workspaceState = assessmentFactories.createWorkspaceState({
        isCurrent: token => api.isCurrent(token), releaseReading: forgetReading,
    });
    assessmentFactories.connectWorkspace?.(workspaceState);
    const historyOwner = crypto.randomUUID();
    let accessToken = null, clearingAccess = false;
    for (const type of ["click", "auxclick", "input", "change", "submit", "keydown"]) {
        document.addEventListener(type, event => {
            if (api.publicationToken() && !clearingAccess) return;
            if (!event.target.closest?.("#workspace,#contextSidebar,#overlay,.select-popup")) return;
            event.preventDefault(); event.stopImmediatePropagation();
        }, { capture: true });
    }
    const time = createTimeContext();
    const pageDefaults = assessmentFactories.createPageDefaults();
    const hiddenCards = assessmentFactories.createCardVisibility(window, refreshCardVisibility);
    let undoCard = null, hiddenDialog = null;
    const homepage = assessmentFactories.mountAnalyzeHomepage({ prefs: pageDefaults, isCurrent: token => api.isCurrent(token) });
    const authorship = createPromptAuthorship({ screen: true });
    const requestTiming = createRequestTiming(time, authorship);
    let appUpdate;
    const localSearch = createLocalSearch(), settingsNavigation = createSettingsNavigation(localSearch, { updates: Boolean(assessmentFactories.mountAppUpdate) });
    const paths = assessmentFactories.createPagePaths();
    const currentAddress = () => paths.legacy(location.hash) ? location.hash : location.pathname + location.search;
    let linkTargets = new WeakMap(), initialRoute = null;
    let initialHistory = history.state;
    const historyViews = new Map();
    const trendEntries = new Map();
    const bookmarkIndexes = new WeakMap();
    function bookmarkIndex(snapshot) {
        if (!snapshot) return null;
        if (!bookmarkIndexes.has(snapshot)) {
            const byId = new Map(), byRef = new Map();
            for (const record of snapshot.scenarios) {
                const ref = record.interactionBookmark, id = record.scenarioId;
                if (!paths.validBookmark(ref) || typeof id !== "string" || !id) continue;
                byId.set(id, byId.has(id) ? null : ref);
                byRef.set(ref, byRef.has(ref) ? null : id);
            }
            bookmarkIndexes.set(snapshot, { byId, byRef });
        }
        return bookmarkIndexes.get(snapshot);
    }
    function resolveBookmark(route, snapshot) {
        if (route.view !== "request" || route.bookmark === undefined) return route;
        const index = bookmarkIndex(snapshot), id = index?.byRef.get(route.bookmark);
        return { ...route, request: id && index.byId.get(id) === route.bookmark ? id : undefined };
    }
    let acceptedAddress = null;
    const [incomingView, incomingQuery = ""] = currentAddress().split("?");
    const incomingParameters = new URLSearchParams(incomingQuery);
    const incomingNavigationKey = incomingParameters.get("privateView") ?? history.state?.wirePrivateNavigation;
    // Capture freshness before legacy normalization or the access shell replaces history.
    let pendingFreshBrowse = !incomingQuery && incomingNavigationKey === undefined && !history.state?.evidenceView;
    let legacyHandoffTarget;
    if (incomingView.startsWith("#") && incomingParameters.has("privateView")) {
        incomingParameters.delete("privateView");
        legacyHandoffTarget = incomingView + (incomingParameters.size ? "?" + incomingParameters : "");
        history.replaceState(null, "", legacyHandoffTarget);
    }
    let incomingNavigation = null, incomingNavigationError = null, incomingNavigationClaimed = false;
    function claimIncomingNavigation() {
        if (incomingNavigationClaimed || incomingNavigationKey === undefined || !api.publicationToken()) return;
        incomingNavigationClaimed = true;
        try {
            // Return data only to the WindowProxy opened by the source, never to the caller
            // of the opener function. No transferable nonce in the URL or history is needed.
            window.__wireReceivePrivateNavigation = value => { incomingNavigation = value; };
            const legacy = window.opener?.__wireTakePrivateNavigation?.(incomingNavigationKey, window, legacyHandoffTarget ?? currentAddress());
            if (incomingNavigationKey !== "required" && legacy) incomingNavigation = legacy;
        } catch (error) {
            if (error.name !== "SecurityError") throw error;
        } finally { delete window.__wireReceivePrivateNavigation; }
        window.opener = null;
        if (!incomingNavigation || typeof incomingNavigation.search !== "string"
            || incomingNavigation.analysisQuery !== null && typeof incomingNavigation.analysisQuery !== "string"
            || !Number.isSafeInteger(incomingNavigation.revision)) {
            incomingNavigation = null;
            incomingNavigationError = "The private selection could not be restored. Return to the original tab and open the result again.";
        }
    }
    if (api.publicationToken()) claimIncomingNavigation();
    let compactSettings, settingsSearchSignature, issueRows, deletionUI, recollectionUI, assessmentUI, liveSearchUI;
    let recollectionNoticeVisible = true, recollectionNoticeKey = "";
    let semanticMembership, semanticQuery = incomingNavigationKey === undefined ? null : incomingNavigation?.analysisQuery ?? "",
        semanticComplete = false, semanticBound = false, semanticStatus = "stale";
    const browseStates = new Map();
    const browseDefaults = { analyze: "analyzeRange", trends: "trendChart", compare: "compareDays" };
    const analysisNavigations = new Map();
    let switchingAnalysis = false;
    let searchOpenedRequest = null, searchTargetInvalid = false;
    const chatCopy = createChatCopy();
    const periodFlow = createPeriodFlow(time, chatCopy);
    let viewerTime = time.detect();
    let displayTimeSettings;
    const draft = createReportDraft({ contextSelector: createRequestContext() });
    draft.change({ saveMode: "local" });
    let reportExperience, reportDates = { range: "7", ...time.preset("7", viewerTime.timeZone) };
    let initialReportChoices = { range: "7", formats: ["html"] }, reportDefaultsVisit = null;
    let reportBaseExplicit = false, reportDatesReplaced = false, reportRebuildFrom = null, reportUpdateTimer;
    let reportPreparing = false, reportPreparationOwner = null, reportUpdateAgain = false, saveAfterMask = false;
    let reportPreset = null, reportLandingOrigin = null;
    const reportSaveWarning = assessmentFactories.createReportSaveWarning({
        icon: name => ux.icon(name), current: () => !clearingAccess && Boolean(api.publicationToken()),
    });
    const nativePublication = assessmentFactories.createNativeReportPublicationState();
    let syncNativeSaveAvailability = null, nativePreviewExpiryTimer;
    function nativePublicationContext(includeDraft = true) {
        const access = api.accessState();
        return { kind: "report", mode: access.mode, collectionMode: access.collectionMode,
            runtimeId: access.runtimeId, publication: api.publicationToken(), owner: api.controlToken(), revision: workspaceState.evidence?.revision,
            ...(includeDraft && workspaceState.evidence ? { draftToken: draft.token(), scope: JSON.stringify([
                reportScope, reportSelection().selection(workspaceState.evidence.revision), reportNativeIntent(), draft.options(),
            ]) } : {}) };
    }
    const renderedContextBundles = new Set();
    const ux = createEvidenceUX(uxIcons, assessmentFactories.createOperationIcons());
    const searchFields = assessmentFactories.createSearchFields(ux);
    let namedReport = null;
    const namedDrafts = assessmentFactories.createReportDraftPicker({ api, ux, searchFields, normalize: assessmentFactories.normalizeSearchText,
        announce, erase: erasePreparedNodes,
        openDraft: openAddedDraft,
        libraryLink: () => link("Saved library", "reports", { task: "library", request: undefined, inspect: undefined, bundle: undefined }, "text-link"),
        blocked: () => workspaceState.loading || workspaceState.stale || clearingAccess ? "Wait for current activity." : "",
        changed: syncNamedReport,
    });
    function namedRequest(id) {
        if (!namedDrafts.read()) return null;
        const requests = workspaceState.evidence?.exportCatalog?.requests;
        return requests?.find(r => r.scenarioId === id) ?? requests?.find(r => r.aliases.includes(id));
    }
    const metadata = createInlineMetadata(ux);
    // Keep operation wording on screen separate from saved report definitions.
    const recordedCategories = createServiceCategories();
    const describeService = (value, n) => {
        const entry = recordedCategories.display(value, n);
        return entry.id === "Search" ? { ...entry, label: "Search endpoint",
            description: "The recorded target is a search endpoint. It doesn’t identify every app searched." } : entry;
    };
    const categories = { ...recordedCategories, entries: recordedCategories.entries.map(entry => recordedCategories.display(entry.id)),
        describe: recordedCategories.display, operation(tool) {
        const operation = recordedCategories.operation(tool);
        return tool === "workiq-ask" ? { ...operation, label: "Asked Copilot",
            description: "A request to Copilot or a selected agent." } : operation;
    }, serviceEvidence(row, layer = "tool") {
        return recordedCategories.displayEvidence(recordedCategories.serviceEvidence(row, layer), { screen: true });
    }, displayEvidence(evidence) {
        return recordedCategories.displayEvidence(evidence, { screen: true });
    }, availabilitySummary(rows, layer) {
        return recordedCategories.availabilitySummary(rows, layer, { screen: true });
    }, explainRows(rows, layer) {
        return recordedCategories.availabilitySummary(rows, layer, { screen: true })?.description ?? "";
    }, evidenceGroups(rows, layer) {
        return recordedCategories.evidenceGroups(rows, layer).map(group => ({ ...group,
            evidence: recordedCategories.displayEvidence(group.evidence, { screen: true }),
            purpose: group.tool === "workiq-ask" ? "Asked Copilot" : group.purpose }));
    } };
    const help = createControlHelp(categories);
    const dimensional = createDimensionalCharts();
    const reportScopes = createReportScope(authorship);
    const results = createRecordedResults({ scope: () => workspaceState.analytics, screen: true });
    const filterState = createFilterState(results, authorship);
    // Display wording must not change the facts checked against the server's projection.
    const activityProjection = createActivityProjection(time, recordedCategories, Object.keys(results.labels("tool")));
    const analysisSlice = createAnalysisSlice(localSearch, activityProjection);
    const timingPresentation = assessmentFactories.timing;
    const percentageMath = createPercentageCharts({ dimensional, categories, results, ux, authorship, icons: dimensionalIcons,
        modelShareReading: assessmentFactories.modelShareReading, usageSummary: assessmentFactories.usageSummary,
        createLink(kind, row) {
            const changes = Object.hasOwn(row, "nativeFilter") ? row.nativeFilter
                : kind === "outcomes" ? workspaceState.scope.layer === "code-reference" ? { widget: "all" } : { result: row.id }
                : kind === "services" ? { withinServices: [...new Set([...(workspaceState.route.withinServices?.split(",") || []), row.id])].sort().join(",") }
                : kind === "tools" && row.id !== "tool:unidentified" ? { tool: row.id.slice(5) } : null;
            return changes ? routeLink("", routeFor("activity", { ...changes, ...(row.sourceId ? { source: row.sourceId } : {}), page: undefined }),
                "", { revealReferenceRecords: true }) : null;
        } });
    const trendInventory = new WeakMap();
    function retainedTrendTools(snapshot) {
        if (!trendInventory.has(snapshot)) {
            const supported = new Set(snapshot.scenarios.filter(s => !nativeActivity.isNative(s)
                && ["copilot-app", "copilot-app-chat"].includes(s.sourceHost)).map(s => s.scenarioId));
            trendInventory.set(snapshot, new Set((snapshot.requestActivity?.tool || [])
                .filter(row => supported.has(row.scenarioId) && row.workload !== "Platform metadata").map(row => row.tool)));
        }
        return trendInventory.get(snapshot);
    }
    const analyzeTrends = assessmentFactories.createAnalyzeTrendsEntry({ time, results, authorship, categories: recordedCategories }).mount({
        announce,
        getContext: () => {
            const { scope, acceptedRoute: route, evidence: snapshot } = workspaceState;
            if (!scope || !snapshot || !api.publicationToken() || workspaceState.loading || workspaceState.stale || workspaceState.route.view !== "analyze"
                || route?.view !== "analyze" || route.compare || scope.layer !== "tool" || !retainedTrendTools(snapshot).size
                || semanticQuery !== null && (!semanticBound || !semanticComplete)) return null;
            const githubOnly = scope.filters.sources?.length === 1 && scope.filters.sources[0] === "github-copilot";
            return { scope, route, snapshot, revision: snapshot.revision, hasSearch: Boolean(route.search?.trim() || semanticQuery),
                supportedTools: retainedTrendTools(snapshot), searchMembership: semanticMembership,
                includesNative: !githubOnly && (boundedIncludesMicrosoft() && hasMicrosoftSource() || snapshot.scenarios.some(nativeActivity.isNative)),
                otherSources: !githubOnly && snapshot.scenarios.some(s => s.recordKind !== "native-conversation" && !["copilot-app", "copilot-app-chat"].includes(s.sourceHost)),
                hasEarlier: snapshot.scenarios.some(s => s.isLegacy || s.collectionInactive) };
        },
        open: (entry, trigger) => {
            const key = crypto.randomUUID(), reading = captureReading();
            if (!reading) return;
            viewKey(trigger, trigger.id);
            Object.assign(reading, { focus: { id: trigger.id }, anchor: trigger.id, top: trigger.getBoundingClientRect().top });
            trendEntries.set(key, { entry: { ...entry, key }, publication: reading.publication, revision: entry.revision, timeZone: entry.timeContext.timeZone,
                origin: { ...workspaceState.acceptedRoute, search, analysisQuery: semanticQuery },
                reading, position: historyPosition });
            if (navigate({ view: "trends", search: "", analysisQuery: null, trendEntry: key }) === false) trendEntries.delete(key);
        },
    });
    $("chartTitle").after(analyzeTrends.link("rhythm"));
    $("analyzeUsageTitle").after(analyzeTrends.link("usage"));
    function widgetRecordsLink(widget) {
        return routeLink("", routeFor("activity", { widget, page: undefined }), "", { revealReferenceRecords: true });
    }
    function widgetDefinitionLink(topic) {
        return routeLink("", routeFor("analyze", { analyzeSection: "guide", guideTopic: topic }), "");
    }
    function populationLink(total, label, source) {
        const action = !total ? widgetDefinitionLink("outcomes") : source ? routeLink("", routeFor("activity", { source, page: undefined }), "", { revealReferenceRecords: true }) : widgetRecordsLink("all");
        action.dataset.viewKey = "population:" + (source ?? "current");
        action.classList.add("population-link");
        const tip = total ? `${label} in the current dates and filters.` : "No records match these dates and filters.";
        action.setAttribute("aria-description", tip);
        return ux.tooltip(action, tip);
    }
    function widgetMeaning(topic, row, layer) {
        if (topic === "tools") return (!Object.hasOwn(row, "nativeFilter") && ux.operations.toolPurpose(row.label)) ||
            (row.id === "tool:unidentified" || row.nativeFilter === null ? "The retained records don’t identify individual tools here." : "The tool name recorded for this activity.");
        if (topic === "outcomes") return help.resultMeaning(row.id, layer);
        if (topic === "services") return describeService(row.id).description;
        if (topic === "authors") return ({ user: "The originating prompt was recorded as human-written.", agent: "The originating prompt came from an agent, including automatic continuations.",
            unknown: "The record doesn’t establish who wrote the originating prompt." })[row.id];
        if (topic === "models") return "Interactions with a response attributed to this model. One interaction can use several models.";
    }
    const percentages = percentageMath.mount($("percentageCharts"), { outcomesHost: $("outcomeChart"), dataHost: $("percentageData"), includeModels: true, includeAuthors: true, trendLink: analyzeTrends.link,
        evidenceLink: widgetRecordsLink, definitionLink: widgetDefinitionLink, meaning: widgetMeaning,
        mirrorLink: (target, source) => linkTargets.set(target, linkTargets.get(source)) });
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
    const historyStatus = createCollectionStatus();
    const sourceCollection = assessmentFactories.createSourceCollectionState({
        bootstrap: accessBootstrap, collectionStatus: historyStatus,
        createNativeConfigurationState: assessmentFactories.createNativeConfigurationState,
    });
    function acceptSourceCollection(status) {
        if (!sourceCollection.controlsActive) return status;
        sourceCollection.receive(status?.sourceAware, api.accessState());
        const github = status.sourceAware.github.status;
        if (["nativeControl", "nativePersistence", "nativeConfigurationOffer"].some(key => Object.hasOwn(status, key))
            || ["configVersion", "revision", "deletionVersion", "artifactRevision"].some(key => status[key] !== github[key])) {
            sourceCollection.withdraw();
            throw new Error("GitHub collection changed while source status was read. Read current Settings; no action was started.");
        }
        return status;
    }
    function nativeCollectionStatus(status) {
        return sourceCollection.active ? { nativePersistence: status?.sourceAware?.microsoft.status } : status;
    }
    function observeNativeReaderStatus(status) {
        if (!sourceCollection.active) return;
        const native = historyStatus.persistence(nativeCollectionStatus(status));
        if (!native?.configured) { boundedNative.retireReaderAuthority(status.revision); return; }
        boundedNative.observeReaderAuthority({ revision: status.revision, deletionVersion: status.deletionVersion,
            current: { generation: native.generation, configurationRevision: native.configuration?.configurationRevision ?? null,
                privacyRevision: native.configuration?.privacyRevision ?? null } });
    }
    function savedMicrosoftSummary(view) {
        const committed = view?.readback?.committed;
        return committed?.committedAt ? `Last saved ${timestamp(committed.committedAt)}.`
            : view?.readback ? "Saved time unavailable."
            : "";
    }
    async function readCollectionStatus(input = {}, isCurrent = () => true) {
        const publication = api.publicationToken(), readGeneration = collectionReadGeneration;
        const current = () => api.isCurrent(publication) && readGeneration === collectionReadGeneration && isCurrent();
        const status = await api("/api/collection/status", input);
        if (!current()) throw new Error("This collection read was superseded or WIRE access changed.");
        if (!sourceCollection.controlsActive) return status;
        const composite = await api("/api/collection/sources/status", {});
        if (!current()) throw new Error("This source status read was superseded or WIRE access changed.");
        return acceptSourceCollection({ ...status, sourceAware: composite });
    }
    let nativeCollectIntent = null;
    const receiptStatus = { ...historyStatus, nativeReadbackMatches(receipt, snapshot, status) {
        return sourceCollection.active ? nativeIntentCurrent()
            && boundedContract.matchesReadback(nativeCollectIntent?.readbackQualification, snapshot?.nativeRead, receipt)
            : historyStatus.nativeReadbackMatches(receipt, snapshot, status);
    } };
    let fresh = createFreshActivity({ sourceUnknown: sourcePending, sourceWarning: sourceStorageWarning, nativeStatus: receiptStatus });
    const refreshSources = assessmentFactories.createRefreshSources();
    let refreshGesture = null;
    let githubRecoveryPending = false;
    const refreshWorking = () => Boolean(refreshGesture?.running || refreshGesture?.recovering);
    function refreshGestureCurrent(gesture) {
        return gesture === refreshGesture && !gesture.withdrawn && api.isCurrent(gesture.publication)
            && api.isControlCurrent(gesture.owner) === true && api.accessState().runtimeId === gesture.runtimeId;
    }
    function refreshPresentation() {
        const model = fresh.snapshot(), gesture = refreshGesture;
        if (!gesture || gesture.withdrawn) return githubRecoveryPending ? { ...model,
            phase: ["checking", "applying", "waiting"].includes(model.phase) ? model.phase : "unconfirmed",
            sourceUnknown: true, recovery: "stored", message: "Earlier GitHub check unconfirmed.",
            context: "Read saved activity; neither source check will be repeated." } : model;
        const summary = refreshSources.describe(gesture.branches);
        return { ...model, phase: gesture.running ? "checking" : gesture.recovering ? "applying"
            : summary.recovery ? "unconfirmed" : summary.waiting ? "waiting" : "complete",
            message: summary.message, context: summary.context, coverage: summary.coverage,
            recovery: summary.recovery || model.sourceBlocked ? "stored" : null,
            sourceUnknown: Object.values(gesture.branches).some(branch => branch.state !== "superseded" && branch.result?.sourceUnknown),
            readFailed: Object.values(gesture.branches).some(branch => branch.state !== "superseded" && branch.result?.readFailed),
            combined: { completedAt: gesture.completedAt, problem: summary.problem } };
    }
    function settleRefreshBranch(branch) {
        if (branch.withdrawn || !branch.flow || ["skipped", "queued", "retired"].includes(branch.state)) return;
        const next = structuredClone(branch.flow.snapshot());
        branch.flow.releaseSnapshot(branch.result);
        branch.result = next;
    }
    function withdrawRefreshGesture() {
        const gesture = refreshGesture, github = gesture?.branches.github, microsoft = gesture?.branches.microsoft;
        const githubResult = github?.flow?.snapshot();
        githubRecoveryPending ||= Boolean(github?.dispatched && github.state !== "retired"
            && !githubResult?.check && !githubResult?.sourceFailure && !github.result?.check && !github.result?.sourceFailure);
        const original = gesture ? microsoft?.dispatched ? microsoft.intent : null : nativeCollectIntent;
        const recovery = original && !original.confirmed ? { operationId: original.operationId, owner: original.owner } : null;
        if (gesture) {
            gesture.withdrawn = true;
            for (const [source, branch] of Object.entries(gesture.branches)) {
                branch.flow?.withdrawAccess(branch.result, branch.intent?.readbackQualification, gesture.plan?.[source]);
                if (branch.intent) for (const key of Object.keys(branch.intent)) delete branch.intent[key];
                for (const key of Object.keys(branch)) delete branch[key];
                branch.withdrawn = true;
                delete gesture.branches[source];
            }
            if (gesture.plan) for (const key of Object.keys(gesture.plan)) delete gesture.plan[key];
            for (const key of Object.keys(gesture)) delete gesture[key];
            gesture.withdrawn = true;
        }
        fresh.withdrawAccess(nativeCollectIntent?.readbackQualification);
        if (nativeCollectIntent) for (const key of Object.keys(nativeCollectIntent)) delete nativeCollectIntent[key];
        nativeCollectIntent = recovery;
        refreshGesture = null;
    }
    function retireRefreshBranch(branch) {
        const flow = branch.flow;
        flow?.withdrawAccess(branch.result, branch.intent?.readbackQualification, branch.gesture.plan?.[branch.source]);
        if (nativeCollectIntent === branch.intent) nativeCollectIntent = null;
        if (branch.intent) for (const key of Object.keys(branch.intent)) delete branch.intent[key];
        branch.intent = branch.result = branch.flow = null;
        branch.state = "retired";
        if (fresh === flow) fresh = createFreshActivity({ nativeStatus: receiptStatus, sourceWarning: sourceStorageWarning });
    }
    function syncRefreshBranches(snapshot) {
        const gesture = refreshGesture;
        if (!gesture || gesture.withdrawn) return;
        const prior = refreshSources.describe(gesture.branches);
        if (!refreshWorking() && !prior.recovery && !prior.waiting
            && Number.isSafeInteger(gesture.completedRevision) && snapshot.revision > gesture.completedRevision) {
            withdrawRefreshGesture();
            fresh = createFreshActivity({ nativeStatus: receiptStatus, sourceWarning: sourceStorageWarning });
            return;
        }
        for (const source of refreshSources.names) {
            const branch = gesture.branches[source], model = branch.flow?.snapshot();
            if (!model || branch.state === "retired") continue;
            if (!gesture.running && Number.isSafeInteger(branch.feedbackRevision) && snapshot.revision > branch.feedbackRevision) {
                retireRefreshBranch(branch);
                continue;
            }
            if (branch.state === "superseded") continue;
            const native = snapshot.collection?.sourceAware?.microsoft.status, receipt = model.nativeReceipt;
            const changed = source === "github" ? model.check && snapshot.collection?.configVersion !== model.check.configVersion
                : receipt?.status === "committed" && (native?.accountRef !== receipt.partition
                    || native?.configuration?.configurationRevision !== receipt.configurationRevision
                    || native?.configuration?.privacyRevision !== receipt.privacyRevision);
            if (changed) {
                branch.state = "superseded";
                branch.feedbackRevision ??= snapshot.revision;
                settleRefreshBranch(branch);
                if (fresh === branch.flow) {
                    fresh = createFreshActivity({ nativeStatus: receiptStatus, sourceWarning: sourceStorageWarning });
                    nativeCollectIntent = null;
                }
                continue;
            }
            const awaitingView = ["applying", "waiting"].includes(model.phase);
            if (awaitingView) {
                if (source === "github") branch.flow.applied(snapshot.revision, snapshot.collection?.configVersion, snapshot.analytics.rows);
                else if (nativeIntentCurrent(branch.intent) && branch.flow.nativeApplied(snapshot, nativeCollectionStatus(collection))) {
                    branch.intent.confirmed = true;
                }
            }
            if (awaitingView || ["applying", "waiting"].includes(branch.result?.phase)
                || branch.result?.sourceUnknown && !model.sourceUnknown && model.phase === "complete") settleRefreshBranch(branch);
            const result = branch.result;
            if (branch.feedbackRevision === undefined && result && !result.sourceUnknown && !result.sourceBlocked
                && !result.readFailed && !result.sourceFailure && ["complete", "partial"].includes(result.phase)
                && (result.check || result.nativeReceipt?.status === "committed")) branch.feedbackRevision = snapshot.revision;
        }
        if (!refreshWorking()) {
            gesture.completedRevision = snapshot.revision;
            clearSourceCheckMarker();
        }
    }
    let collectionReadGeneration = 0, collectionPollGeneration = 0;
    function nativeIntentCurrent(intent = nativeCollectIntent) {
        return Boolean(intent?.owner) && typeof intent.owner.then !== "function" && api.isControlCurrent(intent.owner) === true;
    }
    function nativeReceiptQuery() {
        return nativeIntentCurrent() ? { operationId: nativeCollectIntent.operationId } : {};
    }
    async function qualifyNativeReadback(intent) {
        if (!sourceCollection.active || !nativeIntentCurrent(intent)) return;
        fresh.releaseSnapshot(intent.readbackQualification);
        intent.readbackQualification = null;
        const value = await api("/api/retained/microsoft/readback", { schemaVersion: 1, operationId: intent.operationId });
        if (intent !== nativeCollectIntent || !nativeIntentCurrent(intent)) throw new Error("The original Microsoft operation owner changed.");
        intent.readbackQualification = boundedContract.decodeReadback(value, intent.operationId);
    }
    function receiveNativeReceipt(status, intent = nativeCollectIntent) {
        if (!intent || !nativeIntentCurrent(intent)) return false;
        const value = historyStatus.persistence(status);
        if (!value || value.receiptQuery !== intent.operationId) {
            fresh.nativeReceived(fresh.snapshot().token, null);
            return false;
        }
        const receipt = value.receipt;
        if (receipt && (receipt.operationId !== intent.operationId || receipt.partition !== value.accountRef)) {
            throw new Error("The Microsoft receipt does not match this panel's operation and account.");
        }
        return fresh.nativeReceived(fresh.snapshot().token, receipt);
    }
    const sessionJourney = createSessionJourney();
    let reportEntry = null, reportJourney, savedArtifactUI, artifactRefreshRequired = false, contextReturnKey, savedReportView, preparedReportReader, preparedFileInspection;
    let savedListOwner;
    let pendingReportReading = null;
    let periodReport = null, periodReportInvalid = false;
    let reportPickerEvents = null;
    const sessionReportButton = button("Create report for this chat", createSessionReport, "primary");
    sessionReportButton.id = "createSessionReport";
    sessionReportButton.hidden = true;
    $("pageAction").after(sessionReportButton);
    let issuesSignature, issuesLoading = false, issuesStatus;
    const issueAttempts = new Map();
    const presentation = createDisclosureState();
    const sidebarPositions = new Map();
    let sidebarIdentity = null, sidebarOrigin = null, sidebarAnimation = null, sidebarAnimationFinish = null, sidebarExit = null, requestRenderKey = null, requestInvalidated = false, contextOwner = null;
    let sidebarColumnAnimation = null, sidebarColumnAnchor = null, sidebarColumnFrame = null;
    let sidebarReadingFocus = null, cancelSidebarReading = null;
    const invalidatedReaderFocus = new WeakMap();
    let readerWidth = null, readerExpanded = false, readerResize = null, sidebarTextAnchor = null, readerLayoutSize = null;
    let readerSections = null, timingHeadingObserver = null, cardEntry = null;
    const callHeaderLayouts = [];
    const readerTextReleases = [];
    function clearReaderSections() {
        callHeaderLayouts.length = 0;
        sidebarTextAnchor = null;
        endReaderResize();
        timingHeadingObserver?.disconnect();
        timingHeadingObserver = null;
        for (const release of readerTextReleases.splice(0)) release();
        readerSections?.dispose();
        readerSections = null;
        $("requestContent").classList.remove("tool-activity-log");
        $("requestContent").style.removeProperty("--reader-timing-inset");
        $("requestContent").style.removeProperty("--reader-timing-padding");
        if ($("contextSidebarTitle").hasAttribute("data-interaction-identity")) {
            $("contextSidebarTitle").removeAttribute("data-interaction-identity");
            $("contextSidebarTitle").textContent = interactionTitle();
        }
    }
    let reportSetupReturn = null;
    let reportPickerOrigin = null;
    const savedEntries = new Map();
    let savedInspector = null;
    const contextSidebar = $("contextSidebar"), contextBody = $("contextSidebarBody");
    let sidebarHistoryMode = null;
    function restoreSidebarHistoryMode() {
        const previous = sidebarHistoryMode ?? history.state?.evidenceView?.sidebarRestoration;
        sidebarHistoryMode = null;
        if (!["auto", "manual"].includes(previous)) return;
        if (history.scrollRestoration === "manual") history.scrollRestoration = previous;
        if (readRoute().view !== "request" && !readRoute().inspect && history.state?.evidenceView?.sidebarRestoration) {
            const { sidebarRestoration, ...entry } = history.state.evidenceView;
            history.replaceState({ ...history.state, evidenceView: entry }, "");
        }
    }
    function ownSidebarHistory(origin = false) {
        if (sidebarHistoryMode === null) {
            const remembered = history.state?.evidenceView?.sidebarRestoration;
            sidebarHistoryMode = ["auto", "manual"].includes(remembered) ? remembered : history.scrollRestoration;
        }
        // Set the origin entry before pushing; popstate is too late to prevent native restoration.
        if (origin) history.replaceState({ ...history.state, evidenceView: { ...history.state?.evidenceView, sidebarRestoration: sidebarHistoryMode } }, "");
        history.scrollRestoration = "manual";
    }
    let periodReturnReading = null, trendPeriodVisit = null;
    const textAccess = createTextAccess(ux, presentation, authorship, metadata);
    const nativeActivity = assessmentFactories.createNativeActivityPresentation({
        api, ux, presentation, createReaderSections: assessmentFactories.readerSections, sourceLabel: filterState.sourceLabel,
        excerpt: textAccess.excerpt, timing: timingPresentation, results, pagedList, activityIdentities,
        capturedAt: value => time.formatMoment(value, workspaceState.scope?.timeContext || viewerTime),
    });
    const boundedContract = assessmentFactories.createBoundedNativeState();
    let nativeAnalysisState = null, nativeAnalysisRender = 0;
    const boundedNative = assessmentFactories.mountBoundedNative({
        api, ux, results, createState: assessmentFactories.createBoundedNativeState, sourceLabel: filterState.sourceLabel,
        active: () => sourceCollection.active, presentHit: assessmentFactories.liveSearch.presentHit,
        matchPolicyId: assessmentFactories.liveSearch.contract.matchPolicyId,
        savedSummary: savedMicrosoftSummary,
        dimensional, formatDate: value => date(value),
        createReaderSections: assessmentFactories.readerSections, presentation, renderText: value => renderDocument(value),
        onPage: () => { if (workspaceState.evidence && !workspaceState.loading && !clearingAccess) queueMicrotask(() => { if (workspaceState.evidence && !workspaceState.loading && !clearingAccess) render(); }); },
        conversationHref: (target, link) => setRouteLink(link, nativeTargetRoute(target)),
        onFilter: values => navigate(routeFor("analyze", { ...values, request: undefined, page: undefined }), true),
        onInventories: dimension => {
            pendingInventoryUpdates.add(dimension);
            refreshInventoryControls();
        },
        onGroup: groupId => navigate(routeFor("analyze", { nativeGroup: groupId ?? undefined, request: undefined, page: undefined })),
        onAnalysis: value => {
            if (value === null && nativeAnalysisState === null) return;
            nativeAnalysisState = value;
            const version = ++nativeAnalysisRender, publication = api.publicationToken();
            queueMicrotask(() => {
                if (version === nativeAnalysisRender && api.isCurrent(publication) && workspaceState.evidence && !workspaceState.loading && !clearingAccess) render();
            });
        },
        openConversation: target => {
            liveSearchUI?.hide?.();
            navigate(nativeTargetRoute(target));
        },
    });
    const requestContext = createRequestContext();
    const callInvestigation = createCallInvestigation(requestContext.compare);
    let detailOwner = "page";
    let collection, collectionSettings, sourceSettings, firstConnection, recorderUI, accountUI, accountProfile, microsoftProfile, collectionBusy = false, collectionReadError = "", collectionReadReason = "", connectionNeedsSnapshot = false, pollTimer, pageInactive = false;
    const privateObjectUrls = new Set();
    function privateObjectUrl(bytes) {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        privateObjectUrls.add(url);
        setTimeout(() => { URL.revokeObjectURL(url); privateObjectUrls.delete(url); }, 1000);
        return url;
    }
    const sidebar = mountSidebarNavigation(ux);
    let reportScope = "selected";
    let reportAuthors = authorship.selection();
    mountThemeControl(theme, ux);
    document.querySelectorAll("nav [data-nav]").forEach(node => {
        node.prepend(ux.icon(`navigation-${node.dataset.nav}`));
    });
    $("openEvidenceHelp").prepend(ux.icon("navigation-help"));
    $("wireFeedback").prepend(ux.icon("navigation-feedback"));
    for (const [id, icon] of Object.entries({ navigationToggle: "menu", closeNavigation: "close", refreshBtn: "refresh", checkActivity: "refresh", closeDialog: "close" })) {
        ux.utility($(id), icon, $(id).getAttribute("aria-label") || $(id).textContent);
    }
    $("resetView").prepend(ux.icon("reset"));
    $("analyzeRefresh").prepend(ux.icon("refresh"));
    ux.tooltip($("analyzeRefresh"), () => $("analyzeRefreshLabel").checkVisibility()
        ? "" : $("analyzeRefresh").getAttribute("aria-label"));
    for (const [id, text] of Object.entries(help.actions)) if ($(id) && id !== "resetView") ux.tooltip($(id), $(id).classList.contains("icon-only") ? $(id).getAttribute("aria-label") : text);
    function refreshUsesStoredRecovery(model = refreshPresentation()) {
        return Boolean(model.sourceUnknown || model.sourceBlocked || model.phase === "error" || collectionReadError || workspaceState.stale);
    }
    ux.tooltip($("checkActivity"), "");
    ux.tooltip($("refreshBtn"), "");
    ux.tooltip($("freshStoredRead"), "");
    for (const [id, label] of Object.entries({ clearDates: "Clear dates", clearActivitySearch: "Clear legacy search" })) ux.utility($(id), "close", label);
    for (const node of document.querySelectorAll("[data-chart]")) ux.tooltip(node, () =>
        node.dataset.chart === "workload" && workspaceState.scope?.layer === "tool" ? help.charts.activityCategory : help.charts[node.dataset.chart]);
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
        const values = resultSelection(workspaceState.route.result);
        return values.length === 1 ? results.canInspect(workspaceState.scope.layer, values[0])
            : values.length > 1 && workspaceState.scope.layer !== "code-reference" && values.every(key => resultKeys.includes(key));
    }
    const reviewLabels = { captured: "Not reviewed", reviewing: "In review", ready_to_export: "Ready for report", exported: "Previously exported" };
    const nextReview = { captured: "reviewing", reviewing: "ready_to_export" };
    const nextReviewLabel = { captured: "Start review", reviewing: "Mark ready" };
    const scopeLabels = { history: "Current activity", legacy: "Preserved earlier snapshot", all: "Both collections" };
    const selected = new Set();
    let slice, activePreview = null, clearPreviewPayload = null, pendingSaveResult = null, pendingSaveOwner = null;
    let deferredDataNotice = false;
    let acceptingSnapshot = null;
    let selectControls;
    let exportWriting = false, returnFocus = null;
    workspaceState.route = readRoute();
    if (paths.legacy(location.hash) || location.pathname === "/analyze" || location.pathname.endsWith("/") && location.pathname !== "/"
        || [...incomingParameters.keys()].some(key => paths.isScope(key) || incomingView === "/trends" && ["period", "measure"].includes(key))) {
        const { url } = routeAddress(workspaceState.route, incomingNavigationKey !== undefined);
        initialRoute = { url, value: workspaceState.route };
        history.replaceState(null, "", url + (paths.legacy(location.hash) ? "" : location.hash));
    }
    let historyPosition = Number.isSafeInteger(history.state?.evidenceView?.position) ? history.state.evidenceView.position : 0;
    let search = workspaceState.route.search || "", activityPage = Math.max(0, Number.parseInt(workspaceState.route.page || "0", 10) || 0), restoring = false, mounted = false;
    let usageSort = pageDefaults.get("analyzeSort"), explicitUsageSort = false;
    const pageSize = 8;
    const frontendActivity = assessmentFactories.mountActivityList?.({
        root: $("activityList"), pager: $("activityPager"), isCurrent: token => api.isCurrent(token),
        reuseCard: (previous, replacement) => boundedNative.reuseCard(previous, replacement),
        release: node => { boundedNative.releaseCard(node); releaseCardPreviews(node); }, onError: message => {
            $("activityListSummary").textContent = "Recorded activity unavailable.";
            $("activityListScope").textContent = "";
            $("activityListScope").hidden = true;
            announce(message, "error");
        },
    });
    const homeCount = el("span"), homeUnit = el("span");
    homeCount.id = "activityCount";
    homeUnit.id = "activityUnit";
    const analyzeScope = assessmentFactories.createAnalyzeScope(results, authorship, serviceLabel, filterState.sourceLabel);
    const analyzeReferenceEntry = assessmentFactories.mountAnalyzeReferenceEntry({
        host: $("analyzeReferenceEntry"), trigger: $("openChartReference"), openReference: openChartReference,
    });
    const analyzeControls = assessmentFactories.mountAnalyzeControls(ux, {
        api, motionTiming: sidebar.timing,
        closeSelect: () => selectControls?.close(), closeNavigation: () => sidebar.close(false),
        toolbarHost: $("analyzeResultCommands"), scopeHost: $("analyzeResultScope"),
    });
    $("meaningScopeTitle").parentElement.append($("periodHint"));
    const chartReferenceKeys = new Map();
    let chartReferenceRevision = null, chartReferenceVersion = 0, chartReferenceOrigin = null, pendingChartReferenceReading = null;
    let chartReferenceAccepted = null, chartReferenceInput = null, chartReferenceSourceCoverage = "";
    const chartReferenceCountTable = $("countTable");
    const chartReferenceUI = assessmentFactories.chartReference.mount({
        host: $("analyzeReference"), root: $("meaning"), trigger: $("openChartReference"),
        ux, results, help, categories, dimensional, motionTiming: sidebar.timing,
        readContext: readChartReferenceContext, renderExact: renderChartReferenceExact,
        onAnalyzeExit: () => selectAnalyzeSection(false),
        renderQualification: analyzeControls.scopeCaption,
        openComparisonRecords: openChartReferencePeriodRecords,
        publicationToken: () => api.publicationToken(), isCurrent: token => api.isCurrent(token),
        onUnavailable: message => announce(message, "stale"),
    });
    for (const type of ["pointerdown", "wheel", "touchmove", "keydown"]) {
        document.addEventListener(type, event => {
            if (!event.isTrusted) return;
            // Keyboard Close reverses the entrance; it doesn't change where the user was
            // reading. Carry only its still-current origin through to the return navigation.
            const closing = type === "keydown" && event.target === $("closeContextSidebar")
                && (event.key === "Enter" || event.key === " ") && sidebarIdentity
                && sidebarColumnAnchor?.intent === workspaceState.readingIntent;
            const intent = workspaceState.noteReading();
            if (closing) sidebarColumnAnchor.intent = intent;
            if (contextBody.contains(event.target)) cancelSidebarReading?.();
        }, { capture: true, passive: true });
    }
    // Pasting or replacing a query need not start with a key or pointer event.
    $("wireSearch").addEventListener("input", event => {
        if (event.isTrusted) workspaceState.noteReading();
    });
    // Feedback actions reuse the controllers released by the exiting reader.
    document.addEventListener("click", event => {
        const action = event.target.closest?.("[data-insight-details]");
        if (!sidebarExit || !action || contextSidebar.contains(action)) return;
        workspaceState.noteReading();
        finishSidebarMotion();
    }, { capture: true });

    function viewKey(node, key) { node.dataset.viewKey = key; return node; }
    function keyed(key) { return [...document.querySelectorAll("[data-view-key]")].find(node => node.dataset.viewKey === key); }
    const underlyingRoute = () => sessionJourney.underlying(workspaceState.route);
    function fromReportCreation() {
        const origin = underlyingRoute();
        return origin.view === "reports" && origin.task === "create";
    }
    function requestIdentity(value = workspaceState.route) { return JSON.stringify([value.request, value.call, value.callRevision,
        value.nativeSource, value.nativeRevision, value.nativeSourceRevision, value.nativeOrdinal, value.completedCalls?.key, value.failedCalls?.key, value.nativeCompletedRef]); }
    function sidebarAnchor() {
        if (underlyingRoute().view === "trends") return trendsUI.evidenceOrigin()?.closest(".trends-panel,.trends-panel-pair") ?? null;
        return (workspaceState.route.inspect ? savedInspector?.anchor || keyed("bundle:" + workspaceState.route.inspect) : null)
            ?? (fromReportCreation() ? keyed("report:" + workspaceState.route.request)?.closest(".activity-card") : null)
            ?? keyed("request:" + workspaceState.route.request)?.closest(".activity-card")
            ?? document.querySelector(`[data-action-id="${CSS.escape(workspaceState.route.call || "")}"].activity-card`)
            ?? (sidebarOrigin?.anchor?.isConnected ? sidebarOrigin.anchor : null);
    }
    function rememberSidebarAnchor() {
        if (!sidebarIdentity) return;
        const anchor = sidebarAnchor();
        if (anchor?.checkVisibility()) sidebarOrigin = { anchor, top: anchor.getBoundingClientRect().top };
    }
    function keepAnchor(action) {
        const anchor = sidebarAnchor(), top = anchor?.getBoundingClientRect().top;
        action();
        if (anchor?.isConnected && anchor.checkVisibility()) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
        rememberSidebarAnchor();
    }
    function retainSidebarColumnAnchor() {
        const current = sidebarColumnAnchor;
        if (!current || current.navigation !== workspaceState.navigationGeneration || current.intent !== workspaceState.readingIntent
            || !current.anchor?.isConnected || !current.anchor.checkVisibility()) return;
        const target = Math.max(0, scrollY + current.anchor.getBoundingClientRect().top - current.top);
        // Short origins need scroll capacity before native scrolling can compensate their reflow.
        if (target > document.documentElement.scrollHeight - innerHeight) {
            document.body.style.setProperty("--context-anchor-height", `${Math.ceil(innerHeight + target)}px`);
        }
        window.scrollBy(0, target - scrollY);
        rememberSidebarAnchor();
    }
    function readerBounds() {
        const unit = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const available = document.body.getBoundingClientRect().right - $("main").getBoundingClientRect().left;
        return { unit, available, min: 26 * unit, max: Math.min(46 * unit, available - 36 * unit), split: available >= 62 * unit };
    }
    function currentReaderLayoutSize() {
        return `${contextBody.clientWidth}:${getComputedStyle(document.documentElement).fontSize}`;
    }
    function captureReaderAnchor() {
        if (!contextOwner?.interaction || !contextSidebar.open || !contextBody.checkVisibility()) return null;
        if (contextBody.scrollTop < 1) return { start: true };
        const viewport = contextBody.getBoundingClientRect(), walker = document.createTreeWalker(contextBody, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode, parent = node.parentElement;
            if (!node.data.trim() || !parent.checkVisibility() || parent.closest('[inert],.visually-hidden,.reader-section-heading,button')) continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = [...range.getClientRects()].find(rect => rect.width && rect.top >= viewport.top + 16 && rect.bottom < viewport.bottom);
            if (!rect) continue;
            const x = Math.max(viewport.left + 20, rect.left + 2), y = rect.top + rect.height / 2;
            const caret = document.caretPositionFromPoint?.(x, y);
            const legacy = caret ? null : document.caretRangeFromPoint?.(x, y);
            const text = caret?.offsetNode ?? legacy?.startContainer, offset = caret?.offset ?? legacy?.startOffset;
            // Clipped labels and overlaid headings have layout boxes too. Anchor only
            // when the character under this visible line belongs to the line we measured.
            if (text !== node || offset >= text.length) continue;
            range.setStart(text, offset); range.setEnd(text, offset + 1);
            return { node: text, offset, top: range.getBoundingClientRect().top - viewport.top };
        }
        return null;
    }
    function restoreReaderAnchor(anchor) {
        if (!anchor || !contextOwner?.interaction) return;
        if (anchor.start) { contextBody.scrollTop = 0; return; }
        if (!contextBody.contains(anchor.node) || anchor.offset >= anchor.node.length || !anchor.node.parentElement.checkVisibility()) return;
        const range = document.createRange();
        range.setStart(anchor.node, anchor.offset); range.setEnd(anchor.node, anchor.offset + 1);
        contextBody.scrollTop += range.getBoundingClientRect().top - contextBody.getBoundingClientRect().top - anchor.top;
    }
    function syncReaderControls(bounds) {
        const interaction = Boolean(contextOwner?.interaction);
        const adjustable = interaction && bounds.split && !readerExpanded;
        $("readerWidthControls").hidden = !adjustable;
        $("readerResize").hidden = !adjustable;
        $("expandInteraction").hidden = !interaction || !bounds.split;
        const label = readerExpanded ? "Restore reader width" : "Maximize interaction";
        const expand = $("expandInteraction");
        if (expand.getAttribute("aria-label") !== label) {
            expand.setAttribute("aria-label", label);
            expand.replaceChildren(ux.icon(readerExpanded ? "reader-restore" : "reader-maximize"));
            ux.tooltip(expand, label);
        }
        if (adjustable) {
            const width = contextSidebar.getBoundingClientRect().width, handle = $("readerResize");
            handle.setAttribute("aria-valuemin", String(Math.round(bounds.min)));
            handle.setAttribute("aria-valuemax", String(Math.round(bounds.max)));
            handle.setAttribute("aria-valuenow", String(Math.round(width)));
            handle.setAttribute("aria-valuetext", `${Math.round(width)} pixels wide`);
            $("narrowInteraction").setAttribute("aria-disabled", String(width <= bounds.min + 1));
            $("widenInteraction").setAttribute("aria-disabled", String(width >= bounds.max - 1));
        } else endReaderResize();
    }
    function fitContextSidebar() {
        if (!sidebarIdentity) return;
        const bounds = readerBounds();
        const modal = contextOwner?.interaction ? !bounds.split : innerWidth - $("main").getBoundingClientRect().left < 62 * bounds.unit;
        const expanded = Boolean(contextOwner?.interaction && readerExpanded && !modal);
        const mode = modal ? "overlay" : expanded ? "expanded" : "docked";
        if (contextSidebar.open && contextSidebar.dataset.mode !== mode) {
            finishSidebarMotion();
            if (!sidebarIdentity) return;
        }
        const focus = contextSidebar.contains(document.activeElement) ? document.activeElement : null;
        const top = contextBody.scrollTop, pageY = scrollY, reading = sidebarTextAnchor;
        keepAnchor(() => {
            document.body.toggleAttribute("data-context-docked", !modal && !expanded);
            document.body.toggleAttribute("data-reader-expanded", expanded);
            if (modal || expanded) document.body.style.removeProperty("--context-anchor-height");
            $("main").inert = expanded;
            contextSidebar.dataset.mode = mode;
            contextSidebar.toggleAttribute("data-interaction-reader", Boolean(contextOwner?.interaction));
            if (contextOwner?.interaction && !modal) {
                const width = Math.min(bounds.max, Math.max(bounds.min, readerWidth ?? Math.min(innerWidth * .42, 34 * bounds.unit)));
                document.body.style.setProperty("--context-sidebar-width", `${expanded ? bounds.available : width}px`);
            } else document.body.style.removeProperty("--context-sidebar-width");
            if (contextSidebar.open && contextSidebar.matches(":modal") !== modal) contextSidebar.close();
            if (!contextSidebar.open) modal ? contextSidebar.showModal() : contextSidebar.show();
            for (const layout of callHeaderLayouts) layout(expanded);
        });
        contextBody.scrollTop = top;
        // Content publication and navigation restoration own scrolling when size is unchanged.
        if (readerLayoutSize !== currentReaderLayoutSize()) restoreReaderAnchor(reading);
        syncReaderControls(bounds);
        if (focus?.checkVisibility()) focus.focus({ preventScroll: true });
        else if (focus) $("closeContextSidebar").focus({ preventScroll: true });
        if (modal) window.scrollTo(scrollX, pageY);
        sidebarTextAnchor = captureReaderAnchor();
        readerLayoutSize = currentReaderLayoutSize();
    }
    function changeReaderGeometry(change) {
        if (!sidebarIdentity || !contextOwner?.interaction || clearingAccess) return;
        finishSidebarMotion();
        cancelSidebarReading?.();
        const anchor = sidebarAnchor(), top = anchor?.getBoundingClientRect().top;
        sidebarTextAnchor = readerResize?.anchor ?? captureReaderAnchor();
        ux.hideTooltip();
        change();
        fitContextSidebar();
        sidebarColumnAnchor = { anchor, top, navigation: workspaceState.navigationGeneration, intent: workspaceState.readingIntent };
        retainSidebarColumnAnchor();
    }
    function resizeReader(width) {
        const bounds = readerBounds();
        if (!bounds.split || readerExpanded) return;
        changeReaderGeometry(() => { readerWidth = Math.max(bounds.min, Math.min(bounds.max, width)); });
    }
    function endReaderResize() {
        const drag = readerResize;
        readerResize = null;
        contextSidebar?.removeAttribute("data-resizing");
        const handle = $("readerResize");
        if (drag && handle?.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId);
    }
    function finishSidebarMotion() {
        const animation = sidebarAnimation, finish = sidebarAnimationFinish;
        cancelAnimationFrame(sidebarColumnFrame);
        sidebarColumnFrame = null;
        sidebarAnimation = null; sidebarAnimationFinish = null;
        // Release the exiting column before canceling its fill, never through the docked width.
        if (!sidebarIdentity && sidebarColumnAnimation) document.body.removeAttribute("data-context-docked");
        animation?.cancel();
        sidebarColumnAnimation?.cancel();
        sidebarColumnAnimation = null;
        retainSidebarColumnAnchor();
        sidebarColumnAnchor = null;
        finish?.();
    }
    function moveSidebar(entering, finish = () => {}, preserveAnchor = true) {
        const from = sidebarAnimation ? getComputedStyle(contextSidebar).transform : entering ? "translateX(100%)" : "translateX(0)";
        const main = $("main"), docked = contextSidebar.dataset.mode === "docked";
        const width = contextSidebar.getBoundingClientRect().width;
        // The width keyframes resolve against body, not the root viewport (which may include a reserved gutter).
        const occupied = sidebarColumnAnimation ? document.body.getBoundingClientRect().right - main.getBoundingClientRect().right : entering ? 0 : width;
        const anchor = preserveAnchor ? sidebarAnchor() : null, top = anchor?.getBoundingClientRect().top;
        const navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent;
        cancelAnimationFrame(sidebarColumnFrame);
        sidebarColumnFrame = null;
        sidebarAnimation?.cancel();
        sidebarAnimation = null; sidebarAnimationFinish = null;
        sidebarColumnAnchor = null;
        sidebarColumnAnimation?.cancel();
        sidebarColumnAnimation = null;
        const animation = contextSidebar.animate([{ transform: from }, { transform: entering ? "translateX(0)" : "translateX(100%)" }],
            sidebar.timing);
        if (docked) {
            const columnWidth = space => `calc(100% - var(--app-sidebar-width,196px) - ${space}px)`;
            sidebarColumnAnimation = main.animate([
                { width: columnWidth(occupied), overflowAnchor: "none" },
                { width: columnWidth(entering ? width : 0), overflowAnchor: "none" },
            ], sidebar.timing);
            // Both edges share one clock; the width still follows a simultaneously moving left rail.
            const start = document.timeline.currentTime;
            animation.startTime = start;
            sidebarColumnAnimation.startTime = start;
            sidebarColumnAnchor = { anchor, top, navigation, intent };
            retainSidebarColumnAnchor();
        }
        sidebarAnimation = animation; sidebarAnimationFinish = finish;
        if (docked) {
            const track = () => {
                if (sidebarAnimation !== animation) return;
                retainSidebarColumnAnchor();
                sidebarColumnFrame = requestAnimationFrame(track);
            };
            track();
        }
        animation.onfinish = () => { if (sidebarAnimation === animation) finishSidebarMotion(); };
    }
    function clearSidebarExit() {
        const exit = sidebarExit;
        if (!exit) return;
        sidebarExit = null;
        contextSidebar.inert = false;
        exit.cleanup();
    }
    contextSidebar.addEventListener("click", event => {
        if (!sidebarExit) return;
        event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true });
    function saveSidebarPosition() {
        if (!sidebarIdentity || contextOwner?.identity === "report-setup" || cancelSidebarReading) return;
        for (const node of contextBody.querySelectorAll("details[data-disclosure-key]")) presentation.setOpen(node.dataset.disclosureKey, node.open);
        sidebarPositions.set(sidebarIdentity, { top: contextBody.scrollTop, revision: workspaceState.evidence?.revision, nativeRevision: workspaceState.evidence?.nativeRead?.revision, basis: JSON.stringify(workspaceState.evidence?.assessment?.basis),
            identifyInteraction: $("contextSidebarTitle").hasAttribute("data-interaction-identity"),
            focus: sidebarReadingFocus,
            keys: [...contextBody.querySelectorAll("[data-disclosure-key],.full-text[data-view-key]")].map(node => node.dataset.disclosureKey || node.dataset.viewKey) });
    }
    contextSidebar.addEventListener("focusin", event => {
        if (!contextBody.contains(event.target) && !$("contextSidebarFooter").contains(event.target)) return;
        const target = event.target;
        sidebarReadingFocus = { id: target.id, key: target.closest("[data-view-key]")?.dataset.viewKey,
            tag: target.tagName, label: target.getAttribute("aria-label") };
        if (contextOwner?.identity === "report-setup") reportSetupReturn = { ...reportSetupReturn, focus: target };
    });
    function showContextSidebar({ identity, title, body, bodyTitle, footer, anchor, requestClose, interaction = false, closeLabel = "Close interaction" }) {
        if (clearingAccess || !api.publicationToken()) return;
        if (body !== $("requestView")) clearReaderSections();
        const entering = !sidebarIdentity;
        if (entering) {
            sidebarOrigin = { anchor, top: anchor?.getBoundingClientRect().top };
        }
        if (sidebarIdentity !== identity) {
            endReaderResize();
            readerWidth = null; readerExpanded = false; sidebarTextAnchor = null;
            cancelSidebarReading?.();
            sidebarReadingFocus = null;
            if (contextOwner?.footer) $("contextSidebarParking").append(contextOwner.footer);
            $("contextSidebarFooter").replaceChildren();
        }
        sidebarIdentity = identity;
        contextOwner = { identity, requestClose, footer, interaction };
        contextSidebar.hidden = false;
        if (body.parentElement !== contextBody) {
            for (const previous of [...contextBody.children]) {
                previous.hidden = true;
                $("contextSidebarParking").append(previous);
            }
            contextBody.append(body);
        }
        if (footer && footer.parentElement !== $("contextSidebarFooter")) $("contextSidebarFooter").replaceChildren(footer);
        body.hidden = false;
        $("contextSidebarTitle").textContent = title;
        $("contextSidebarTitle").hidden = Boolean(bodyTitle);
        if (bodyTitle) bodyTitle.textContent = title;
        $("closeContextSidebar").setAttribute("aria-label", closeLabel);
        ux.tooltip($("closeContextSidebar"), closeLabel);
        const main = $("main");
        // Publish the docked state without first painting its final, narrower column.
        if (entering) main.style.width = main.getBoundingClientRect().width + "px";
        try {
            fitContextSidebar();
            if (entering) moveSidebar(true);
            else if (sidebarColumnAnimation) {
                const anchor = sidebarAnchor();
                sidebarColumnAnchor = { anchor, top: anchor?.getBoundingClientRect().top, navigation: workspaceState.navigationGeneration, intent: workspaceState.readingIntent };
            }
        } finally { main.style.removeProperty("width"); }
    }
    function interactionTitle() {
        if (sourceCollection.active && workspaceState.route.nativeSource) return "Microsoft conversation";
        if (workspaceState.route.call === undefined) return "Interaction";
        return ({ tool: "Call in context", "reported-api": "API result in context", http: "HTTP record in context",
            "direct-request": "Request site in context", "recorded-http": "Request site in context",
            "code-reference": "Code reference in context" })[workspaceState.route.layer || "tool"] || "Record in context";
    }
    function showInteractionSidebar() {
        ownSidebarHistory();
        if (contextOwner?.identity === "report-setup") rememberReportSetup(true);
        showContextSidebar({ identity: requestIdentity(), title: interactionTitle(),
            body: $("requestView"), anchor: sidebarAnchor() || document.activeElement?.closest("[data-view-key]"),
            requestClose: closeContextSidebar, interaction: true });
        updateActiveCard();
    }
    function rememberReportSetup(peek = false) {
        reportSetupReturn = { ...reportSetupReturn, top: contextBody.scrollTop, peek };
    }
    function syncReportSetupPresentation() {
        reportJourney?.setContentsPresented(contextSidebar.open && (contextOwner?.identity === "report-setup"
            || workspaceState.route.view === "request" && fromReportCreation() && reportSetupReturn?.peek === true));
    }
    function closeReportSetup({ restoreFocus = true, focusJourney = false } = {}) {
        if (sidebarIdentity !== "report-setup") return;
        rememberReportSetup();
        const contents = $("reportStage2"), intent = workspaceState.readingIntent, navigation = workspaceState.navigationGeneration, owner = contextOwner;
        hideContextSidebar({ restoreFocus: false, onClosed: () => {
            if (contextOwner && contextOwner !== owner) return;
            syncReportSetupPresentation();
            if (intent !== workspaceState.readingIntent || navigation !== workspaceState.navigationGeneration || workspaceState.route.view !== "reports" || workspaceState.route.task !== "create") return;
            contents.hidden = true;
            if (focusJourney) $("reportStepTitle" + reportJourney.snapshot().step)?.focus({ preventScroll: true });
            else if (restoreFocus) {
                const next = $("reportStage1").querySelector(".primary");
                (next?.disabled ? $("reportStepTitle1") : next)?.focus({ preventScroll: true });
            }
        } });
    }
    function presentReportStep({ step, focus, contents, footer }) {
        if (step !== 2) {
            if (contextOwner?.identity === "report-setup") closeReportSetup({ restoreFocus: false, focusJourney: focus });
            if (focus) reportSetupReturn = null;
            if (focus && workspaceState.route.view === "request" && fromReportCreation()) navigate(underlyingRoute(), true, { restorePosition: true });
            syncReportSetupPresentation();
            return false;
        }
        if (!focus || !contents) { syncReportSetupPresentation(); return true; }
        if (workspaceState.route.view === "request") {
            returnToReportSetup();
            syncReportSetupPresentation();
            return true;
        }
        if (workspaceState.route.view !== "reports" || workspaceState.route.task !== "create") { syncReportSetupPresentation(); return true; }
        if (sidebarExit) {
            clearSidebarExit();
            restoreSidebarHistoryMode();
        }
        const saved = reportSetupReturn;
        showContextSidebar({ identity: "report-setup", title: "Report setup", body: contents, footer,
            anchor: $("reportStage1").querySelector(".primary"), requestClose: closeReportSetup, closeLabel: "Close report setup" });
        $("reportStepTitle2").classList.add("visually-hidden");
        const target = saved?.focus?.isConnected && saved.focus.checkVisibility() && !saved.focus.disabled ? saved.focus : $("contextSidebarTitle");
        target.focus({ preventScroll: true });
        contextBody.scrollTop = saved?.top || 0;
        reportSetupReturn = { ...saved, peek: false };
        syncReportSetupPresentation();
        return true;
    }
    function returnToReportSetup() {
        const origin = underlyingRoute();
        if (origin.view !== "reports" || origin.task !== "create") return;
        if (!requestInvalidated) saveSidebarPosition();
        navigate(origin, true, { restorePosition: true, reportSetup: true });
    }
    function returnFromReportInspection() {
        if (reportSetupReturn?.peek) returnToReportSetup();
        else navigate(underlyingRoute(), true, { restorePosition: true });
    }
    function renderReportInspectionReturn() {
        const footer = $("contextSidebarFooter");
        footer.replaceChildren();
        if (fromReportCreation()) footer.append(button(reportSetupReturn?.peek ? "Back to report setup" : "Back to activity", returnFromReportInspection));
    }
    function updateActiveCard() {
        const key = (fromReportCreation() ? "report:" : "request:") + workspaceState.route.request;
        for (const node of document.querySelectorAll(".request-card-open,.card-evidence-link")) {
            const active = sidebarIdentity !== null && node.closest(".request-row")?.dataset.viewKey === key;
            node.setAttribute("aria-expanded", String(active));
            if (node.classList.contains("card-panel-link")) labelPanelLink(node, active);
            node.closest(".request-row").toggleAttribute("data-detail-active", active);
        }
    }
    function timingHeading(target) {
        return $("requestContent").classList.contains("tool-activity-log")
            ? target?.closest('[data-reader-section="activity"]')?.querySelector(":scope > .reader-section-heading") : null;
    }
    function timingInset(target) { return 16 + (timingHeading(target)?.getBoundingClientRect().height || 0); }
    function identifyInteraction() {
        const scenario = workspaceState.evidence.scenarios.find(item => item.scenarioId === workspaceState.route.request);
        $("contextSidebarTitle").textContent = scenario ? excerpt(scenario) : "Interaction unavailable";
        $("contextSidebarTitle").setAttribute("data-interaction-identity", "");
    }
    function restoreSidebarPosition(saved, valid) {
        cancelSidebarReading?.();
        const identity = sidebarIdentity, navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent;
        let frame;
        const stop = () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            if (cancelSidebarReading === stop) cancelSidebarReading = null;
        };
        const restore = () => {
            if (identity !== sidebarIdentity || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent || requestInvalidated || !valid()) { stop(); return; }
            if (contextBody.querySelector('[aria-busy="true"]')) return;
            const owner = saved.focus?.key ? keyed(saved.focus.key) : null;
            const remembered = saved.focus?.id ? $(saved.focus.id) : null;
            const target = remembered && contextSidebar.contains(remembered) ? remembered
                : owner && contextBody.contains(owner) ? [...owner.querySelectorAll(saved.focus.tag)].find(node => node.getAttribute("aria-label") === saved.focus.label) : null;
            if (saved.focus?.text !== undefined && target?.textContent !== saved.focus.text) { stop(); return; }
            if (target?.checkVisibility()) target.focus({ preventScroll: true });
            contextBody.scrollTop = saved.top;
            stop();
        };
        const observer = new MutationObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(restore);
        });
        cancelSidebarReading = stop;
        observer.observe(contextBody, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
        restore();
    }
    function focusSidebar() {
        if (clearingAccess || !api.publicationToken()) return;
        cancelSidebarReading?.();
        const saved = sidebarPositions.get(sidebarIdentity);
        const valid = () => saved && saved.revision === workspaceState.evidence?.revision && saved.nativeRevision === workspaceState.evidence?.nativeRead?.revision
            && saved.basis === JSON.stringify(workspaceState.evidence?.assessment?.basis);
        const entry = cardEntry;
        if (entry?.pending && entry.focus && entry.target.request === workspaceState.route.request
            && entry.navigation === workspaceState.navigationGeneration && entry.intent === workspaceState.readingIntent && entry.revision === workspaceState.evidence.revision) {
            entry.pending = false;
            let reading;
            if (entry.focus === "prompt") {
                textAccess.revealPrompt($("selectedContext")?.querySelector(".full-text"));
                reading = $("selectedContext")?.querySelector(".full-text-content") ?? $("selectedContext");
            }
            else if (entry.focus === "activity") reading = contextBody.querySelector('[data-reader-section="activity"] .reader-section-heading');
            else if (entry.focus === "record") {
                const resolved = callInvestigation.resolve(workspaceState.evidence.requestActivity, workspaceState.evidence.scenarios, entry.target, entry.revision);
                if (resolved.status === "available") reading = contextBody.querySelector(entry.target.layer === "reported-api"
                    ? `[data-result-id="${CSS.escape(resolved.row.id)}"]` : `[data-action-id="${CSS.escape(resolved.actionId)}"]`);
                if (!reading) { navigate(entry.target, true); return; }
            }
            if (reading) {
                readerSections?.reveal(reading);
                const parentDisclosure = reading.closest("details.reader-returned-facts");
                if (parentDisclosure) parentDisclosure.open = true;
                contextBody.scrollTop = entry.focus === "prompt" ? 0
                    : contextBody.scrollTop + reading.getBoundingClientRect().top - contextBody.getBoundingClientRect().top
                        - (entry.focus === "activity" ? 0 : timingInset(reading));
                reading.tabIndex = -1;
                reading.focus({ preventScroll: true });
                return;
            }
        }
        if (!valid() && entry?.pending && workspaceState.route.call === undefined && entry.target.request === workspaceState.route.request
            && entry.navigation === workspaceState.navigationGeneration && entry.intent === workspaceState.readingIntent) {
            entry.pending = false;
            if (entry.revision === workspaceState.evidence.revision) {
                const resolved = callInvestigation.resolve(workspaceState.evidence.requestActivity, workspaceState.evidence.scenarios, entry.target, workspaceState.evidence.revision);
                if (resolved.status !== "available") { navigate(entry.target, true); return; }
                const target = $("requestContent").querySelector(`[data-action-id="${CSS.escape(resolved.actionId)}"]`);
                if (!target) { navigate(entry.target, true); return; }
                if (resolved.row.outcome === "failure" && rowsFor(workspaceState.route.request).some(row => row.id === resolved.row.id && row.outcome === "failure")) {
                    const reading = target.querySelector(".call-heading") || target;
                    const box = reading.getBoundingClientRect(), viewport = contextBody.getBoundingClientRect();
                    const heading = timingHeading(target)?.getBoundingClientRect();
                    const top = Math.max(viewport.top + 4, heading ? heading.bottom + 4 : viewport.top + 4);
                    const needsScroll = target.getBoundingClientRect().top < top || box.bottom > viewport.bottom - 4;
                    if (needsScroll) identifyInteraction();
                    target.tabIndex = -1;
                    target.focus({ preventScroll: true });
                    if (needsScroll) reading.scrollIntoView({ block: "nearest" });
                    return;
                }
            }
        }
        if (valid()) {
            cardEntry = null;
            if (saved.identifyInteraction) identifyInteraction();
            $("contextSidebarTitle").focus({ preventScroll: true });
            restoreSidebarPosition(saved, valid);
            return;
        }
        const completedHeading = workspaceState.route.nativeCompletedRef ? readerSections?.revealTarget?.("completed")
            : (workspaceState.route.completedCalls || workspaceState.route.failedCalls) && contextBody.querySelector('[data-reader-section="activity"] .reader-section-heading');
        const anchor = $("selectedCall") || $("unavailableCall") || completedHeading || $("selectedContext")?.closest("[data-reader-section]") || $("selectedContext");
        readerSections?.reveal(anchor);
        contextBody.scrollTop = anchor ? contextBody.scrollTop + anchor.getBoundingClientRect().top - contextBody.getBoundingClientRect().top - timingInset(anchor) : 0;
        if (completedHeading) completedHeading.tabIndex = -1;
        const target = workspaceState.route.call ? $("selectedCall") || $("unavailableCall") : completedHeading || $("unavailableCall") || $("contextSidebarTitle");
        (target || $("contextSidebarTitle")).focus({ preventScroll: true });
        if (workspaceState.route.call) revealSessionResult();
    }
    function hideContextSidebar({ restoreFocus = true, preserveAnchor = true, onClosed } = {}) {
        if (!sidebarIdentity) { restoreSidebarHistoryMode(); onClosed?.(); return; }
        saveSidebarPosition();
        endReaderResize();
        sidebarTextAnchor = null;
        cancelSidebarReading?.();
        const anchor = sidebarAnchor(), top = anchor?.getBoundingClientRect().top;
        const navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent, closingOwner = contextOwner;
        // Let the origin's container layouts settle beneath the exiting reading surface.
        document.body.removeAttribute("data-reader-expanded");
        $("main").inert = false;
        sidebarIdentity = null; requestRenderKey = null; sidebarReadingFocus = null;
        updateActiveCard();
        moveSidebar(false, () => {
            // Search (or another control) may already own focus before the exit finishes.
            const returnFocus = contextSidebar.contains(document.activeElement) || document.activeElement === document.body;
            contextSidebar.close();
            document.body.removeAttribute("data-context-docked");
            document.body.removeAttribute("data-reader-expanded");
            document.body.style.removeProperty("--context-sidebar-width");
            document.body.style.removeProperty("--context-anchor-height");
            $("main").inert = false;
            if (contextOwner === closingOwner) {
                if (closingOwner?.footer) $("contextSidebarParking").append(closingOwner.footer);
                contextOwner = null;
            }
            if (preserveAnchor && navigation === workspaceState.navigationGeneration && intent === workspaceState.readingIntent && anchor?.isConnected && anchor.checkVisibility()) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
            if (restoreFocus && returnFocus && navigation === workspaceState.navigationGeneration && intent === workspaceState.readingIntent) {
                const route = underlyingRoute(), saved = workspaceState.positions.get(readingKey(route));
                // A nested visit can rebuild the article and lose its originating-link marker.
                const focus = saved && api.isCurrent(saved.publication) ? saved.focus : null;
                const restored = anchor && focus?.tag === "A" && focus.key === anchor.dataset.viewKey
                    ? [...anchor.querySelectorAll("a[aria-controls=contextSidebar]")].filter(link =>
                        link.getAttribute("aria-label") === focus.label && link.textContent === focus.text) : [];
                const origin = route.view === "trends" ? trendsUI.evidenceOrigin()
                    : anchor?.querySelector("[data-card-origin]") ?? (restored.length === 1 ? restored[0] : null)
                        ?? anchor?.querySelector(".request-card-open,.request-link");
                if (origin?.isConnected && origin.checkVisibility()) ux.restoreFocus(origin);
                else if ($("activityView").checkVisibility()) revealResults();
            }
            restoreSidebarHistoryMode();
            onClosed?.();
        }, preserveAnchor);
    }
    function closeContextSidebar() {
        const origin = underlyingRoute();
        const marker = history.state?.evidenceView?.sidebarEntry;
        if (marker === sidebarHistoryKey) history.back();
        else navigate(origin, true, { restorePosition: true });
    }
    const sidebarHistoryKey = crypto.randomUUID();
    for (const [id, icon, label, direction] of [
        ["narrowInteraction", "zoom-out", "Narrow interaction", -1],
        ["widenInteraction", "zoom-in", "Widen interaction", 1],
    ]) {
        const control = $(id);
        control.append(ux.icon(icon)); ux.tooltip(control, label);
        control.addEventListener("click", () => resizeReader(contextSidebar.getBoundingClientRect().width + direction * 2 * readerBounds().unit));
    }
    $("expandInteraction").addEventListener("click", () => {
        if (!readerBounds().split) return;
        changeReaderGeometry(() => { readerExpanded = !readerExpanded; });
    });
    const resizeHandle = $("readerResize");
    ux.tooltip(resizeHandle, "Drag to resize. Left widens, Right narrows; Home and End reach the limits.");
    resizeHandle.addEventListener("keydown", event => {
        const bounds = readerBounds(), width = contextSidebar.getBoundingClientRect().width;
        const next = { ArrowLeft: width + 2 * bounds.unit, ArrowRight: width - 2 * bounds.unit, Home: bounds.min, End: bounds.max }[event.key];
        if (next === undefined) return;
        event.preventDefault(); resizeReader(next);
    });
    resizeHandle.addEventListener("pointerdown", event => {
        if (event.button !== 0 || !event.isPrimary || !contextOwner?.interaction || !readerBounds().split || readerExpanded) return;
        event.preventDefault();
        changeReaderGeometry(() => {});
        resizeHandle.focus({ preventScroll: true });
        readerResize = { pointerId: event.pointerId, x: event.clientX, width: contextSidebar.getBoundingClientRect().width, anchor: sidebarTextAnchor };
        contextSidebar.setAttribute("data-resizing", "");
        resizeHandle.setPointerCapture(event.pointerId);
    });
    resizeHandle.addEventListener("pointermove", event => {
        if (readerResize?.pointerId !== event.pointerId) return;
        resizeReader(readerResize.width + readerResize.x - event.clientX);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) resizeHandle.addEventListener(type, endReaderResize);
    contextBody.addEventListener("scroll", () => {
        // Native reflow can deliver scroll before ResizeObserver; keep the pre-reflow text anchor.
        if (readerLayoutSize === currentReaderLayoutSize()) sidebarTextAnchor = captureReaderAnchor();
    }, { passive: true });
    $("closeContextSidebar").append(ux.icon("close"));
    ux.tooltip($("closeContextSidebar"), "Close interaction");
    const closeReader = () => contextOwner?.requestClose();
    if (assessmentFactories.bindReaderClose) assessmentFactories.bindReaderClose(closeReader);
    else $("closeContextSidebar").addEventListener("click", closeReader);
    contextSidebar.addEventListener("cancel", event => { event.preventDefault(); contextOwner?.requestClose(); });
    ux.dismissOnOutside(contextSidebar, () => contextOwner?.requestClose());
    contextSidebar.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.defaultPrevented || contextSidebar.matches(":modal")) return;
        if (document.querySelector(".ux-tooltip:not([hidden]),.select-popup:not([hidden])")) return;
        event.preventDefault(); contextOwner?.requestClose();
    });
    let sidebarViewport = innerWidth, sidebarTextSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
    window.addEventListener("scroll", () => {
        if (sidebarIdentity && sidebarViewport === innerWidth && sidebarTextSize === parseFloat(getComputedStyle(document.documentElement).fontSize)) rememberSidebarAnchor();
    }, { passive: true });
    const sidebarLayout = new ResizeObserver(() => {
        const textSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
        const changed = sidebarViewport !== innerWidth || sidebarTextSize !== textSize;
        // The observer sees the new layout; retain the last pre-reflow reading anchor.
        const anchor = sidebarIdentity ? sidebarAnchor() : null, top = sidebarOrigin?.anchor === anchor ? sidebarOrigin.top : anchor?.getBoundingClientRect().top;
        if (changed) finishSidebarMotion();
        sidebarViewport = innerWidth; sidebarTextSize = textSize;
        fitContextSidebar();
        if (changed && sidebarIdentity && Number.isFinite(top) && anchor?.checkVisibility()) window.scrollBy(0, anchor.getBoundingClientRect().top - top);
        retainSidebarColumnAnchor();
        rememberSidebarAnchor();
    });
    sidebarLayout.observe(document.documentElement);
    sidebarLayout.observe($("main"));
    function sliceKey() { return JSON.stringify([query(), search, workspaceState.route.withinServices?.split(",") || []]); }
    function scrollOwner(node) {
        for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && (parent.scrollTop || parent.scrollHeight > parent.clientHeight)) return parent;
        }
        return null;
    }
    function capturePager(pager, direction) {
        return { id: pager.id, key: pager.dataset.viewKey, top: pager.getBoundingClientRect().top,
            direction: String(direction), intent: workspaceState.readingIntent, scroller: scrollOwner(pager) };
    }
    function restorePager(saved) {
        if (!saved || saved.intent !== workspaceState.readingIntent) return;
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
    function promptFocus(active) {
        const section = active?.closest('[data-reader-section="prompt"]');
        if (!contextOwner?.interaction || !section || !contextBody.contains(section)) return null;
        const pre = section.querySelector(".request-original .full-text-content");
        if (!pre || active !== pre && !active.matches(".prompt-preview-toggle")) return null;
        const selection = window.getSelection(), text = pre.firstChild;
        return { id: active.id, prompt: true,
            selection: active === pre && text && selection && !selection.isCollapsed && selection.anchorNode === text && selection.focusNode === text
                ? [selection.anchorOffset, selection.focusOffset] : null };
    }
    function sameRetainedPrompt(next) {
        const previous = workspaceState.evidence, id = workspaceState.route.request;
        if (!next || !previous || !id || previous.deletionVersion !== next.deletionVersion
            || previous.collection?.configVersion !== next.collection?.configVersion
            || ["consentRevision", "overrideRevision", "deletionEpoch"].some(key =>
                previous.assessment?.basis?.[key] !== next.assessment?.basis?.[key])) return false;
        // Compare the two authorized snapshots in place. Reading state holds offsets, never a prompt copy.
        const a = previous.scenarios.find(row => row.scenarioId === id), b = next.scenarios.find(row => row.scenarioId === id);
        return a?.userPrompt && b?.userPrompt
            && typeof a.sourceSessionId === "string" && a.sourceSessionId.trim() !== "" && a.sourceSessionId === b.sourceSessionId
            && typeof a.userPrompt.sourceEventId === "string" && a.userPrompt.sourceEventId.trim() !== ""
            && a.userPrompt.sourceEventId === b.userPrompt.sourceEventId && a.userPrompt.sourceTimestamp === b.userPrompt.sourceTimestamp
            && a.userPrompt.status === b.userPrompt.status && a.userPrompt.text === b.userPrompt.text;
    }
    function captureReading(next) {
        if (clearingAccess || !api.publicationToken()) return null;
        for (const node of document.querySelectorAll("details[data-disclosure-key]")) presentation.setOpen(node.dataset.disclosureKey, node.open);
        const active = document.activeElement, owner = active?.closest("[data-view-key]");
        const readerPosition = contextOwner?.interaction && contextBody.contains(active)
            ? { identity: sidebarIdentity, top: contextBody.scrollTop } : null;
        const pending = invalidatedReaderFocus.get(active);
        const retiredFocus = pending && readerPosition?.identity === pending.identity
            && api.isCurrent(pending.publication) && pending.intent === workspaceState.readingIntent ? pending.focus : null;
        const prompt = retiredFocus?.prompt ? retiredFocus : promptFocus(active);
        const focus = prompt ? (sameRetainedPrompt(next) ? prompt : null)
            : retiredFocus || (contextSidebar.contains(active) && !readerPosition ? null : active?.id ? {
            id: active.id, ...(readerPosition ? { text: active.textContent } : {}),
        } : owner === active && active?.closest("#savedReportsPanel") && owner?.dataset.viewKey ? { key: owner.dataset.viewKey, self: true } : owner ? {
            key: owner.dataset.viewKey, label: active.getAttribute("aria-label"), tag: active.tagName,
            callDetail: readerPosition && active.matches(".reader-call-toggle") ? active.getAttribute("aria-controls") : null,
            text: active.textContent, type: active.getAttribute("type"), self: active === owner,
        } : null);
        const scrollers = [...document.querySelectorAll("#workspace *")].filter(node => node.checkVisibility() && (node.scrollLeft || node.scrollTop)).map(node => ({
            id: node.id, key: node.closest("[data-view-key]")?.dataset.viewKey,
            tag: node.tagName, label: node.getAttribute("aria-label"), cls: node.className,
            left: node.scrollLeft, top: node.scrollTop,
        }));
        const activeReader = contextSidebar.contains(active) ? null : active?.closest(".full-text");
        const requestAnchor = workspaceState.route.view === "request" ? sidebarAnchor() : active?.closest(".activity-card");
        const anchor = activeReader?.querySelector(".full-text-body pre")?.checkVisibility() ? activeReader
            : requestAnchor?.checkVisibility() ? requestAnchor
            : [...$("workspace").querySelectorAll("[data-view-key]")].find(node => node.checkVisibility() && node.getBoundingClientRect().top >= 100 && node.getBoundingClientRect().top < innerHeight);
        const selection = window.getSelection(), selectedText = selection?.anchorNode;
        const reader = selectedText?.parentElement?.closest(".full-text-body pre");
        const textSelection = reader?.checkVisibility() && !contextSidebar.contains(reader) && selectedText === reader.firstChild && selection.focusNode === selectedText ? {
            key: reader.closest("[data-view-key]")?.dataset.viewKey, text: reader.textContent,
            anchor: selection.anchorOffset, focus: selection.focusOffset,
        } : null;
        return { publication: api.publicationToken(), intent: workspaceState.readingIntent, x: scrollX, y: scrollY, focus, scrollers, anchor: anchor?.dataset.viewKey, top: anchor?.getBoundingClientRect().top, textSelection,
            chartReference: chartReferenceUI.capture(), reader: readerPosition };
    }
    function forgetReading(saved) {
        if (!saved) return;
        if (saved.chartReference) for (const key of Object.keys(saved.chartReference)) delete saved.chartReference[key];
        for (const key of Object.keys(saved)) delete saved[key];
    }
    function restoreReading(saved) {
        if (!saved || clearingAccess || !api.isCurrent(saved.publication)) return;
        const chartLink = saved.focus?.key?.startsWith("percentage:") || saved.focus?.key?.startsWith("chart:");
        if ((saved.chartReference || chartLink || saved.focus?.id?.startsWith("analyze-trend-")) && workspaceState.route.view === "analyze" && semanticQuery !== null && !semanticBound) {
            pendingChartReferenceReading = { position: saved, navigation: workspaceState.navigationGeneration, intent: workspaceState.readingIntent };
            return;
        }
        const root = saved.focus?.key ? keyed(saved.focus.key) : null;
        const prompt = saved.focus?.prompt && saved.reader?.identity === sidebarIdentity && saved.intent === workspaceState.readingIntent
            && contextOwner?.interaction && !requestInvalidated;
        // Preview toggles are normally measured after mount; focus needs the current toggle now.
        if (prompt) textAccess.measurePrompt($("selectedContext")?.querySelector(".full-text"));
        // Call identity survives a timing/outcome update; the button's accessible name does not.
        const callToggle = saved.reader && saved.focus?.callDetail && root?.querySelector(".reader-call-toggle");
        const sameCall = callToggle && callToggle.getAttribute("aria-controls") === saved.focus.callDetail;
        const focus = sameCall ? callToggle : saved.focus?.id ? $(saved.focus.id) : root && saved.focus.self ? root : root ? [...root.querySelectorAll("button,a,input,summary,textarea,pre")].find(node =>
            node.tagName === saved.focus.tag && (saved.focus.tag === "SUMMARY" || (saved.focus.label ? node.getAttribute("aria-label") === saved.focus.label : node.textContent === saved.focus.text && node.getAttribute("type") === saved.focus.type))) : null;
        const readerCurrent = !saved.reader || saved.reader.identity === sidebarIdentity && contextOwner?.interaction
            && focus && contextBody.contains(focus) && (saved.focus.prompt ? prompt : sameCall || focus.textContent === saved.focus.text);
        if (readerCurrent && focus?.checkVisibility()) ux.restoreFocus(focus);
        if (readerCurrent && prompt && saved.focus.selection && document.activeElement === focus) {
            const [anchor, end] = saved.focus.selection, text = focus.firstChild;
            if (text?.nodeType === Node.TEXT_NODE && Math.max(anchor, end) <= text.length)
                window.getSelection()?.setBaseAndExtent(text, anchor, text, end);
        }
        if (saved.reader && readerCurrent) contextBody.scrollTop = saved.reader.top;
        for (const entry of saved.scrollers) {
            const owner = entry.key ? keyed(entry.key) : null;
            const node = entry.id ? $(entry.id) : owner ? [owner, ...owner.querySelectorAll("*")].find(node =>
                node.tagName === entry.tag && node.className === entry.cls && node.getAttribute("aria-label") === entry.label) : null;
            node?.scrollTo(entry.left, entry.top);
        }
        const anchor = saved.anchor ? keyed(saved.anchor) : null;
        window.scrollTo(saved.x, anchor?.checkVisibility() ? scrollY + anchor.getBoundingClientRect().top - saved.top : saved.y);
        rememberSidebarAnchor();
        if (sidebarColumnAnimation && sidebarIdentity && sidebarColumnAnchor?.navigation === workspaceState.navigationGeneration && sidebarColumnAnchor.intent === workspaceState.readingIntent) {
            sidebarColumnAnchor.top = sidebarColumnAnchor.anchor?.getBoundingClientRect().top;
        }
        if (saved.textSelection) {
            const { key, text, anchor, focus } = saved.textSelection;
            const reader = key ? keyed(key)?.querySelector(".full-text-body pre") : null;
            if (reader?.checkVisibility() && reader.textContent === text) {
                window.getSelection()?.setBaseAndExtent(reader.firstChild, anchor, reader.firstChild, focus);
            }
        }
        if (saved.reader && readerCurrent) {
            const revision = workspaceState.evidence?.revision;
            restoreSidebarPosition({ top: saved.reader.top, focus: saved.focus }, () =>
                api.isCurrent(saved.publication) && workspaceState.evidence?.revision === revision
                && contextOwner?.interaction && sidebarIdentity === saved.reader.identity);
        }
        if (saved.chartReference && workspaceState.route.view === "analyze") {
            const current = chartReferenceUI.value();
            if (current.view !== saved.chartReference.view || current.topic !== saved.chartReference.topic) chartReferenceUI.restore(saved.chartReference);
            else chartReferenceUI.refresh();
        }
    }
    function finishChartReferenceReading() {
        const pending = pendingChartReferenceReading;
        if (!pending) return;
        if (pending.navigation !== workspaceState.navigationGeneration || pending.intent !== workspaceState.readingIntent || workspaceState.route.view !== "analyze") {
            pendingChartReferenceReading = null;
            return;
        }
        if (workspaceState.loading || workspaceState.stale || semanticQuery !== null && !semanticBound) return;
        pendingChartReferenceReading = null;
        if (pending.position) restoreReading(pending.position);
        else revealResults();
    }
    function bindDetails(node, key, renderBody, initial = false) {
        viewKey(node, "disclosure:" + key);
        node.dataset.disclosureKey = key;
        node.open = presentation.isOpen(key, initial);
        let renderedOpen = node.open;
        const update = () => {
            if (clearingAccess || !api.publicationToken() || !node.isConnected || renderedOpen === node.open) return;
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
    function pagedList(host, items, { key, size = 6, noun = "items", renderItem, listTag = "div", listClass = "", wrapList = list => list, jump = false, pageLabel = "Saved library page", pagerAfter = false, hideSinglePage = false, onPage, isCurrent, beforeReplace, signal }) {
        const publication = api.publicationToken();
        let pageEvents;
        const paint = (position = null) => {
            if (!api.isCurrent(publication) || isCurrent && !isCurrent()) return;
            pageEvents?.abort();
            if (signal) pageEvents = new AbortController();
            const listeners = pageEvents ? { signal: AbortSignal.any([signal, pageEvents.signal]) } : undefined;
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
                        if (isCurrent && !pager.isConnected) return;
                        if (isCurrent && !isCurrent()) { announce("That earlier table view is no longer current.", "stale"); return; }
                        onPage?.();
                        captureReading();
                        const position = capturePager(pager, offset);
                        presentation.setPage(key, page + offset);
                        paint(position);
                    }, "quiet", listeners);
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
                    input.setAttribute("aria-label", pageLabel);
                    const numberField = el("span", "number-field");
                    numberField.style.setProperty("--number-digits", String(Math.max(2, String(pages).length)));
                    numberField.append(input);
                    fieldLabel.append(numberField, el("span", "", `of ${count(pages)}`));
                    const go = el("button", "", "Go to page"); go.type = "submit";
                    form.append(fieldLabel, go);
                    form.addEventListener("submit", event => {
                        event.preventDefault();
                        if (!api.isCurrent(publication) || !form.isConnected || isCurrent && !isCurrent()) return;
                        if (!form.reportValidity()) return;
                        onPage?.();
                        const position = capturePager(pager, 0);
                        presentation.setPage(key, input.valueAsNumber - 1);
                        paint(position);
                        keyed("pager:" + key)?.querySelector("input")?.focus({ preventScroll: true });
                    }, listeners);
                    pager.append(form);
                }
            }
            const list = el(listTag, listClass);
            for (const item of items.slice(start, start + size)) list.append(renderItem(item, listeners));
            beforeReplace?.(host);
            if (!api.isCurrent(publication) || isCurrent && !isCurrent()) { beforeReplace?.(list); return; }
            const content = wrapList(list);
            host.replaceChildren(...(hideSinglePage && items.length <= size ? [content] : pagerAfter ? [content, pager] : [pager, content]));
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
    function button(text, action, cls = "", listeners) {
        const node = el("button", cls, text);
        const publication = accessToken;
        node.type = "button";
        node.addEventListener("click", event => {
            if (clearingAccess || !api.publicationToken() || publication && !api.isCurrent(publication)) return;
            action?.(event);
        }, listeners);
        const utilityRole = { Previous: "previous", Next: "next", Close: "close", Back: "back" }[text];
        if (utilityRole) ux.utility(node, utilityRole, text);
        return node;
    }
    function option(value, label) { const node = el("option", "", label); node.value = value; return node; }
    function replacePrivateChoices(control, ...choices) {
        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) text.data = "";
        for (const child of control.querySelectorAll("*")) for (const attribute of [...child.attributes]) {
            attribute.value = "";
            child.removeAttributeNode(attribute);
        }
        control.replaceChildren(...choices);
    }
    function count(value) { return Number.isFinite(value) ? value.toLocaleString() : "Not recorded"; }
    function localQuery(id) { return workspaceState.route.localSearch?.[id] || ""; }
    const scopedSearches = {};
    function syncLocalSearchFields() {
        for (const [id, field] of Object.entries(scopedSearches)) field.sync(localQuery(id));
        $("clearActivitySearch").hidden = !search;
    }
    function highlighted(node, text, query) {
        for (const part of localSearch.parts(text, query)) node.append(part.match ? el("mark", "", part.text) : document.createTextNode(part.text));
        return node;
    }
    function nativeSettingUnavailable(id) {
        if (sourceCollection.copilotOnly && id?.startsWith("microsoft-")) return true;
        const configuredInterface = collectionSettings?.hasNativeConfiguration?.() === true;
        if (id === "global-collection") return !sourceCollection.active
            && !(sourceCollection.copilotOnly && collection?.sourceAware?.global.paused);
        if (["microsoft-collection-state", "microsoft-collect-now"].includes(id)) return !sourceCollection.active;
        if (id === "microsoft-collection") return !sourceCollection.active && !configuredInterface;
        return Boolean(historyStatus.native(collection)) && (["source", "source-paths", "cadence"].includes(id)
            || ["history-window", "save-preferences"].includes(id) && !configuredInterface
            || id === "collect-now" && !historyStatus.persistence(collection));
    }
    function settingsTarget(entry) {
        if (["app-update", "automatic-updates"].includes(entry.id) && !$("appUpdateGuide").hidden) return "appUpdateGuide";
        if (entry.id === "app-update" && !$("settingsAppUpdate").hidden) return "settingsAppUpdate";
        if (entry.id === "palette") {
            const checked = document.querySelector("input[name=screenPalette]:checked");
            return checked?.parentElement.hidden ? "paletteQuery" : checked?.id ?? entry.target;
        }
        const approved = collection?.config?.approved;
        if (nativeSettingUnavailable(entry.id)) return entry.section === "source-access" ? "sourceAccessTitle" : "connectionTitle";
        if (entry.section === "connection" && !$("sourceEditor").hidden
            && ["history-window", "cadence", "save-preferences"].includes(entry.id)) return "collectionSourceDraft";
        if (sourceCollection.copilotOnly && !approved && ["history-window", "cadence", "save-preferences", "collection-state"].includes(entry.id)) return "collectionSourceEntry";
        if (sourceCollection.active && entry.id === "microsoft-collection") return "sourceMicrosoftSurfaces";
        if (entry.id === "collection-state" && historyStatus.native(collection)) {
            return collectionSettings?.nativeConfigurationIntent?.() === "enable" ? "saveCollection" : "pauseCollection";
        }
        if (entry.id === "microsoft-connection" && !$("wireMicrosoftConnection")?.checkVisibility()) return "connectionTitle";
        if (entry.id === "collect-now") return [$("storedViewRetry"), $("refreshBtn"), $("collectionRetry"), $("checkActivity")]
            .find(control => control?.checkVisibility())?.id || entry.target;
        if (entry.id === "source") return !$("sourceEditor").hidden ? "sourceDatabase" : approved ? "editSource" : "reviewSource";
        if (entry.id === "source-paths") return !$("sourceEditor").hidden ? "sourceDatabase" : approved ? "approvedSourceTitle" : "reviewSource";
        if (!approved && ["source-paths", "collection-state"].includes(entry.id)) return "reviewSource";
        if (entry.id === "save-preferences" && $("preferenceActions").hidden) {
            return $("connectCollection").checkVisibility() && $("connectCollection").dataset.intent === "save-preferences"
                ? "connectCollection" : "settingsDraftStatus";
        }
        return entry.target;
    }
    function renderSettingsSearch() {
        const query = localQuery("settingsSearch"), entries = settingsNavigation.find(query).filter(entry => !nativeSettingUnavailable(entry.id));
        const searching = Boolean(query.trim());
        $("settingsCategories").hidden = searching;
        const availability = entries.map(entry => {
            const id = settingsTarget(entry), control = $(id);
            if (entry.id === "microsoft-connection") return !$("wireMicrosoftConnection") || $("microsoftConnectionHost").hidden
                ? "Unavailable in this runtime" : $("wireMicrosoftStatus").textContent;
            if (!collection?.config?.approved && !historyStatus.native(collection)
                && (["source-paths", "collection-state"].includes(entry.id) || id === "collectionSourceEntry" || id === "reviewSource" && entry.id !== "source")) return "Source approval needed";
            if (control?.disabled) return "Action unavailable";
            return "";
        });
        const signature = JSON.stringify([query, entries.map(entry => entry.id), availability, workspaceState.route.view, workspaceState.route.setting]);
        if (signature === settingsSearchSignature) return;
        settingsSearchSignature = signature;
        const list = $("settingsSearchResults"), status = $("settingsSearchCount");
        const focusedSetting = list.contains(document.activeElement) ? document.activeElement.dataset.setting : null;
        list.replaceChildren();
        list.hidden = !searching || !entries.length;
        status.hidden = !searching;
        status.classList.toggle("visually-hidden", entries.length > 0);
        setText(status, entries.length ? `${entries.length} setting${entries.length === 1 ? "" : "s"} found.` : "No settings match.");
        const groups = new Map();
        entries.forEach((entry, index) => {
            const groupKey = entry.section || entry.view;
            let group = groups.get(groupKey);
            if (!group) {
                const item = el("li", "settings-search-group"), heading = el("h3", "settings-search-heading");
                heading.id = "settings-search-group-" + groupKey;
                heading.append(ux.icon(entry.view || "settings-" + entry.section), highlighted(el("span"), entry.category, query));
                group = el("ul");
                group.setAttribute("aria-labelledby", heading.id);
                item.append(heading, group); list.append(item);
                groups.set(groupKey, group);
            }
            const item = el("li"), anchor = viewKey(link("", entry.view || "settings", { section: entry.section, setting: entry.id }), "settings-search:" + entry.id);
            anchor.dataset.setting = entry.id;
            if (workspaceState.route.setting === entry.id && workspaceState.route.view === (entry.view || "settings")) anchor.setAttribute("aria-current", "location");
            anchor.append(highlighted(el("span"), entry.title, query));
            if (availability[index]) anchor.append(el("span", "settings-search-availability", availability[index]));
            item.append(anchor); group.append(item);
        });
        if (focusedSetting) [...list.querySelectorAll("a")].find(anchor => anchor.dataset.setting === focusedSetting)?.focus({ preventScroll: true });
    }
    function renderSettingsNavigation() {
        const section = workspaceState.route.view === "settings" ? settingsNavigation.resolve(workspaceState.route).section : "connection";
        if (section === "reports" && !clearingAccess && api.publicationToken()) assessmentFactories.rateReference(el, $("costRateReference"), workspaceState.evidence?.scenarios ?? []);
        else $("costRateReference").replaceChildren();
        $("settingsGeneralBack").hidden = workspaceState.route.view !== "settings"
            || history.state?.evidenceView?.generalShortcut !== section || history.state?.wireAccess?.owner !== historyOwner;
        collectionSettings?.setSection(workspaceState.route.view === "settings" ? section : null, workspaceState.route.setting);
        for (const pane of document.querySelectorAll("[data-settings-section]")) pane.hidden = pane.dataset.settingsSection !== section;
        for (const anchor of $("settingsCategoryNav").querySelectorAll("a[data-category]")) {
            const selected = anchor.dataset.category === section;
            if (selected) anchor.setAttribute("aria-current", "page");
            else anchor.removeAttribute("aria-current");
            setRouteLink(anchor, routeFor("settings", { section: anchor.dataset.category, setting: undefined, issues: undefined }));
        }
        setText($("settingsCategorySummary"), "Category: " + settingsNavigation.categories.find(category => category.id === section).title);
        const routeNotice = nativeSettingUnavailable(workspaceState.route.setting) ? sourceCollection.copilotOnly
            ? "This setting is not available in this release." : "This setting is not available for the registered Microsoft reads."
            : workspaceState.route.settingsWarning || (workspaceState.route.setting === "microsoft-connection"
            && (!$("wireMicrosoftConnection") || $("microsoftConnectionHost").hidden)
            ? "Microsoft 365 connection is not available in this runtime." : "");
        setText($("settingsRouteNotice"), routeNotice);
        $("settingsRouteNotice").hidden = !routeNotice;
        renderSettingsSearch();
    }
    let refreshHelpVisibility = null;
    function renderSettingsRefresh(connection, model) {
        const host = $("freshActivity"), help = $("freshHelp");
        const labelled = connection;
        const storedOnly = !refreshWorking() && refreshUsesStoredRecovery(model);
        const nativePersistence = historyStatus.persistence(collection);
        const sources = sourceCollection.active ? sourceCollection.view(api.accessState()) : null;
        const canAcquire = sources ? sources.current && refreshSources.names.some(source => sources.actions[source].includes("collect-now"))
            : nativePersistence ? nativePersistence.actions.includes("collect-now") : Boolean(collection?.config?.approved);
        for (const [id, originalText] of [["checkActivity", "Refresh"], ["refreshBtn", "Read stored activity"]]) {
            const control = $(id);
            const text = id === "checkActivity" ? storedOnly || !canAcquire
                ? "Read stored activity" : nativePersistence ? "Collect now" : originalText
                : originalText;
            let label = control.querySelector(":scope > .settings-action-label");
            if (labelled && !label) {
                label = el("span", "settings-action-label", text);
                control.append(label);
            }
            if (label) { setText(label, text); label.hidden = !labelled; }
            control.setAttribute("aria-label", text);
            ux.tooltip(control, labelled ? "" : text);
            control.classList.toggle("icon-only", !labelled);
            control.classList.toggle("quiet", !labelled);
            control.classList.toggle("primary", labelled && id === "checkActivity" && !storedOnly
                && canAcquire);
        }
        function checkedScope(check) {
            const checked = Number.isSafeInteger(check.sourcesChecked) && check.sourcesChecked >= 0;
            const eligible = Number.isSafeInteger(check.eligibleSources) && check.eligibleSources >= 0;
            if (checked && eligible) return `Checked ${check.sourcesChecked.toLocaleString()} of ${check.eligibleSources.toLocaleString()} ${check.eligibleSources === 1 ? "chat" : "chats"}.`;
            if (checked) return `Checked ${check.sourcesChecked.toLocaleString()} ${check.sourcesChecked === 1 ? "chat" : "chats"}; eligible count is unavailable.`;
            if (eligible) return `${check.eligibleSources.toLocaleString()} eligible ${check.eligibleSources === 1 ? "chat" : "chats"}; checked count is unavailable.`;
            return "Checked chat counts are unavailable.";
        }
        let context = $("settingsRefreshContext");
        if (connection && !context) {
            context = el("p", "settings-refresh-context");
            context.id = "settingsRefreshContext";
            $("freshResult").before(context);
        }
        const storedControl = $("freshStoredRead").closest(".ux-disabled-help") || $("freshStoredRead");
        if (storedControl.parentElement !== $("collectionSetup")) $("collectionSetup").append(storedControl);
        const check = model.check, partial = model.phase === "partial";
        $("freshCoverageAnnouncement").classList.toggle("visually-hidden", !connection);
        const c = model.combined || nativePersistence ? null : partial && check ? check.coverage : collection?.historyCoverage;
        const pending = partial && check ? check.pendingSources : c?.pending;
        const gaps = c ? [
            c.unavailable > 0 ? `${chatCopy.count(c.unavailable)} unavailable` : "",
            c.limited > 0 ? `${chatCopy.count(c.limited)} incomplete` : "",
            pending > 0 ? "more history remains to read" : "",
        ].filter(Boolean) : [];
        const coverage = model.combined || nativePersistence ? model.coverage : gaps.length ? `GitHub history: ${gaps.join("; ")}.`
            : partial ? model.coverage : "";
        setText($("freshCoverageAnnouncement"), coverage);
        $("freshCoverageAnnouncement").hidden = !coverage;
        if (coverage) $("freshResult").hidden = false;
        if (check && ["complete", "partial"].includes(model.phase)) {
            const countDetail = Number.isSafeInteger(check.sourcesChecked) && Number.isSafeInteger(check.eligibleSources) ? "" : checkedScope(check);
            setText($("freshCheckDetails"), [model.details, countDetail, model.coverage].filter(Boolean).join(" "));
            $("freshCheckDetails").hidden = false;
        }
        if (connection) {
            if (refreshHelpVisibility === null) refreshHelpVisibility = help.hidden;
            help.hidden = true;
            const approved = collection?.config?.approved;
            const explanation = !storedOnly && !["checking", "applying", "waiting"].includes(model.phase)
                && approved && !collection.config.enabled ? "Collection stays paused." : "";
            setText(context, explanation);
            context.hidden = !explanation;
        } else {
            if (refreshHelpVisibility !== null) {
                help.hidden = refreshHelpVisibility;
                refreshHelpVisibility = null;
            }
            if (context) context.hidden = true;
        }
    }
    function revealSetting() {
        document.querySelector(".settings-target")?.classList.remove("settings-target");
        if (compactSettings) $("settingsCategories").open = false;
        const resolved = settingsNavigation.resolve(workspaceState.route), entry = settingsNavigation.entries.find(entry => entry.id === resolved.setting);
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
    async function reviewFirstConnection() {
        const publication = api.publicationToken(), origin = { ...workspaceState.route };
        if (!publication || !sourceCollection.copilotOnly) return;
        const update = navigate({ view: "settings", section: "source-access", setting: "source" });
        const navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent;
        const destinationCurrent = () => api.isCurrent(publication) && navigation === workspaceState.navigationGeneration
            && workspaceState.route.view === "settings" && workspaceState.route.section === "source-access" && workspaceState.route.setting === "source";
        const current = () => destinationCurrent() && intent === workspaceState.readingIntent;
        try {
            if (await Promise.resolve(update) === false || !current()) return;
            const opened = collectionSettings.openSourceReview({ onCancel: () => {
                if (!destinationCurrent()) return;
                const returning = navigate(origin, false, { restorePosition: true }), destination = workspaceState.navigationGeneration;
                Promise.resolve(returning).then(loaded => {
                    if (loaded !== false && api.isCurrent(publication) && destination === workspaceState.navigationGeneration
                        && $("firstConnectionReview").checkVisibility()) ux.restoreFocus($("firstConnectionReview"));
                });
            } });
            if (!opened && current()) announce("Read the current connection in Settings before reviewing the source.", "stale");
        } catch (error) {
            if (current()) announce("Source review could not open. " + error.message, "error");
        }
    }
    function renderFirstConnection() {
        if (!firstConnection || !workspaceState.evidence) return;
        const source = sourceCollection.copilotOnly ? sourceCollection.view(api.accessState()) : null;
        firstConnection.update({
            status: collection,
            enabled: sourceCollection.copilotOnly,
            analyze: workspaceState.route.view === "analyze" && workspaceState.route.compare !== "periods" && semanticQuery === null && !search.trim(),
            hasActivity: workspaceState.evidence.scenarios.length > 0,
            hasReports: workspaceState.evidence.exports?.length > 0,
            stale: workspaceState.stale && !workspaceState.loading || Boolean(collectionReadError) || !source?.current,
            busy: workspaceState.loading || exportWriting || collectionBusy || collectionSettings?.hasDraft(),
            snapshotCurrent: collection?.revision === workspaceState.evidence.revision,
            paused: collection?.config?.enabled === false || source?.status?.global.state === "committed" && source.status.global.paused,
            canConfigure: source?.actions.github.includes("configure") === true && !$("reviewSource").disabled,
            allowWelcome: !document.hidden && !pageInactive && !collectionSettings?.hasDraft(),
        });
    }
    function revealCollectionStatus() {
        document.querySelector(".settings-target")?.classList.remove("settings-target");
        const entry = settingsNavigation.entries.find(entry => entry.view === "collection-status" && entry.id === workspaceState.route.setting);
        let target = $(entry?.target || "pageTitle");
        if (target.tagName === "DETAILS") {
            target.open = true;
            presentation.setOpen(target.id, true);
            target = target.querySelector("summary");
        }
        ux.restoreFocus(target);
        target.scrollIntoView({ block: workspaceState.route.setting ? "nearest" : "start" });
        refreshCollectionIssues();
    }
    function serviceLabel(value) { return categories.describe(value).label; }
    function categoryNoun(layer = workspaceState.scope?.layer || workspaceState.route.layer || "tool") { return layer === "tool" ? "Activity category" : "Service"; }
    function allCategories() { return categoryNoun() === "Service" ? "All services" : "All categories"; }
    function operationForGap(row, layer, evidence) {
        if (evidence?.reason === "exchange-item-type") return { id: "Unknown", label: "Exchange ID conversion",
            operationRole: "operation-exchange-id-conversion", description: evidence.description };
        if (layer === "tool" && row?.tool === "workiq-ask" && evidence?.reason === "hosted-routing")
            return { id: "Unknown", operationRole: ux.operations.toolRole(row.tool), label: categories.operation(row.tool).label, description: evidence.description };
        return null;
    }
    function categoryPresentation(row, layer = "tool") {
        const entry = categories.describe(row?.workload);
        if (layer === "tool" && categories.operation(row?.tool)?.category === "Discovery")
            return { ...entry, label: categories.operation(row.tool).label, operationRole: ux.operations.toolRole(row.tool) };
        return entry.id === "Unknown" ? operationForGap(row, layer, categories.serviceEvidence(row, layer)) ?? entry : entry;
    }
    function serviceCue(tag, value, presentation) {
        const entry = presentation ?? categories.describe(value), node = el(tag, `semantic-cue service-cue dimensional-tone-${dimensional.tone(entry.id)}`);
        if (entry.operationRole) {
            node.dataset.operation = entry.operationRole;
            node.append(ux.icon(entry.operationRole));
        } else {
            node.dataset.service = entry.id;
            if (entry.icon) node.dataset.serviceIcon = entry.icon;
            node.innerHTML = dimensionalIcons[entry.icon ?? entry.id];
        }
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
    function identityList(items) {
        const list = el("span", "identity-list");
        for (const item of items) {
            if (list.childNodes.length) list.append(document.createTextNode(", "));
            list.append(item);
        }
        return list;
    }
    function serviceIdentity(rows, layer, { compact = false, labelled = false, fieldValue = false, includeGap = true } = {}) {
        const available = Array.isArray(rows);
        const services = new Set(), activity = new Map();
        let missing = false;
        for (const row of available ? rows : []) {
            const association = row.serviceAssociation?.layer === layer ? row.serviceAssociation : null;
            const entry = categoryPresentation(row, layer), operation = layer === "tool" ? categories.operation(row.tool) : null;
            if (association) {
                for (const service of association.services) {
                    if (association.basis === "tool-purpose" && service === "Search") {
                        activity.set("Search requested", { id:service, label:"Search requested", operationRole:ux.operations.toolRole(row.tool) });
                    } else services.add(service);
                }
                missing ||= association.gaps.length > 0;
                if (association.status === "not-applicable" && operation) {
                    activity.set(operation.label, { ...categories.describe("Discovery"), label: operation.label, operationRole:ux.operations.toolRole(row.tool) });
                }
                for (const gap of association.gaps) {
                    const knownOperation = operationForGap(row, layer, gap);
                    if (knownOperation) activity.set(knownOperation.label, knownOperation);
                }
            } else if (entry.id === "Discovery") {
                const label = operation?.label ?? entry.label;
                activity.set(label, { ...entry, label });
            } else if (entry.id === "Unknown") {
                missing = true;
                if (entry.icon || entry.operationRole) activity.set(entry.label, entry);
            } else if (entry.id === "Multiple workloads") activity.set(entry.label, entry);
            else services.add(entry.id);
            for (const op of ux.operations.pathOperations(row, layer)) activity.set(op.operationRole, { id:"Unknown", ...op });
        }
        const known = categories.entries.filter(entry => services.has(entry.id));
        const items = known.slice(0, compact ? 2 : undefined).map(entry => serviceCue("span", entry.id));
        if (compact && known.length > 2) items.push(el("span", "identity-overflow", "More services"));
        for (const entry of activity.values()) items.push(serviceCue("span", entry.id, entry));
        const availability = categories.availabilitySummary(available ? rows : undefined, layer);
        const gapLabel = !available || fieldValue ? availability?.label : availability?.notice;
        const gap = includeGap && (!available || missing) && gapLabel
            ? el("span", "recorded-category-field service-availability") : null;
        if (gap) {
            gap.append(el("span", "identity-gap", gapLabel));
        }
        if (!labelled) {
            const identity = el("span", "service-identity");
            if (items.length) identity.append(identityList(items));
            if (gap) identity.append(document.createTextNode(" "), gap);
            return identity;
        }
        const group = el("div", "recorded-category");
        if (items.length) {
            const entries = [...known, ...activity.values()];
            const operations = layer === "tool" ? entries.filter(entry => ["Discovery", "Unknown", "Search", "Platform metadata"].includes(entry.id)).length : 0;
            const label = operations ? operations < entries.length ? "Services and operations" : operations === 1 ? "Operation" : "Operations"
                : entries.length === 1 && entries[0].id !== "Multiple workloads" ? "Service" : "Services";
            const field = el("div", "recorded-category-field"), list = compact ? identityList(items) : el("ul", "service-label-list");
            if (!compact) for (const item of items) {
                const entry = el("li");
                entry.append(item);
                list.append(entry);
            }
            field.append(el("span", "recorded-category-label", label + ":"), document.createTextNode(" "), list);
            group.append(field);
        }
        if (gap) group.append(document.createTextNode(" "), gap);
        return group;
    }
    function recordedCategory(rows, layer, options = {}) {
        return serviceIdentity(rows?.length ? rows : undefined, layer, { ...options, labelled: true });
    }
    function actionHeading(title, service, row, layer = "tool", { inlineHelp = true } = {}) {
        const heading = el("div", "action-heading");
        heading.append(el("h3", "", title));
        if (!inlineHelp) {
            const identity = el("span", "action-service-heading");
            identity.append(serviceIdentity(row ? [{ ...row, tool: title }] : undefined, layer));
            heading.append(identity);
            return heading;
        }
        if (service) {
            const entry = categoryPresentation({ ...row, workload: service, tool: title }, layer), identity = el("span", "action-service-heading");
            const operation = categories.operation(title), cue = serviceCue("span", service, entry);
            const evidence = categories.serviceEvidence(row ? { ...row, tool: title } : row, layer);
            const label = service === "Discovery" ? operation.label : entry.label;
            const scope = layer === "tool" ? categories.requestedSearchScope(sourceCallFor(row)) : null;
            const help = [
                evidence?.description ?? (service === "Discovery" ? operation.description : entry.description),
                scope ? [scope.label + ".", scope.description].filter(Boolean).join(" ") : null,
            ].filter(Boolean).join(" ");
            cue.lastElementChild.textContent = label;
            if (evidence && !entry.icon && !entry.operationRole) cue.querySelector("svg")?.remove();
            identity.append(cue);
            if (inlineHelp) identity.append(ux.helpButton(label, help));
            heading.append(identity);
        }
        return heading;
    }
    function resultHelp(key) {
        return help.resultHelp(key, workspaceState.scope?.layer || workspaceState.route.layer || "tool");
    }
    function filterField(id, labelText) {
        const control = $(id), label = control.closest("label"), field = el("div", "filter-field");
        label.replaceWith(field);
        label.replaceChildren(document.createTextNode(labelText));
        label.htmlFor = id;
        field.append(label, control);
    }
    for (const [id, label] of [
        ["dateFilter", "Dates"], ["sourceFilter", "Source"], ["toolFilter", "Tool"], ["serviceAssociationFilter", "Service involved"],
        ["serviceFilter", "Activity category"], ["projectFilter", "Project"],
        ["chatFilter", "Chat"], ["layerFilter", "Evidence layer"], ["scopeFilter", "Collection"],
    ]) filterField(id, label);
    function hasMicrosoftSource() {
        const evidence = workspaceState.evidence, read = evidence?.nativeRead;
        return Boolean(read && !["microsoft-account-not-configured", "native-retention-not-configured"].includes(read.reason)
            || nativeCollectionStatus(evidence?.collection)?.nativePersistence?.configured
            || evidence?.scenarios.some(nativeActivity.isNative));
    }
    function showMicrosoftActivity() {
        return hasMicrosoftSource() || Boolean(workspaceState.scope?.filters.sources?.some(id => boundedContract.sourceIds.includes(id)));
    }
    function showSourceChoice() {
        return hasMicrosoftSource() || Boolean(workspaceState.route.source && workspaceState.route.source !== "github-copilot")
            || Boolean(workspaceState.evidence?.scenarios.some(record => !["copilot-app", "copilot-app-chat"].includes(record.sourceHost)));
    }
    function sourceOptions() {
        const control = $("sourceFilter");
        control.closest(".filter-field").hidden = !showSourceChoice();
        const microsoft = hasMicrosoftSource(), selected = workspaceState.route.source;
        replacePrivateChoices(control, option("all", "All sources"), ...(microsoft || selected === "microsoft-365" ? [option("microsoft-365", "Microsoft 365")] : []),
            ...filterState.sources.filter(source => microsoft || source.id === "github-copilot" || source.id === selected)
                .map(source => option(source.id, source.label)));
    }
    sourceOptions();
    $("filters").querySelector(".filter-scroll").addEventListener("focusin", event => {
        if (event.target instanceof HTMLElement && event.target.matches("button")) {
            event.target.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
    });
    const activitySearchInput = $("activitySearch"), activitySearchRow = el("div", "search-input-row");
    activitySearchInput.replaceWith(activitySearchRow);
    activitySearchRow.append(activitySearchInput, $("clearActivitySearch"));
    $("clearActivitySearch").textContent = "Clear";
    $("clearActivitySearch").setAttribute("aria-label", "Clear activity search");
    $("clearResultFilter").append(ux.icon("close"));
    ux.tooltip($("clearResultFilter"), "Cancel the pending Outcome change and keep all recorded results. Other filters stay applied.");
    $("clearPromptAuthorFilter").append(ux.icon("close"));
    ux.tooltip($("clearPromptAuthorFilter"), "Cancel the pending change and include all prompts. Other filters stay applied.");
    function date(value, full = false) {
        return time.formatDate(value, workspaceState.scope?.timeContext || viewerTime, full);
    }
    function timestamp(value) { return time.formatTime(value, workspaceState.scope?.timeContext || viewerTime); }
    function dateInput(value) {
        if (!value) return "";
        try { return value.includes("T") ? time.day(value, (workspaceState.scope?.timeContext || viewerTime).timeZone) : time.calendar(value); }
        catch { announce("Invalid date filter. Choose real calendar dates or use Reset Analyze.", "error"); return ""; }
    }
    function dateSelection() {
        return { range: workspaceState.route.range || (workspaceState.route.from || workspaceState.route.to ? "custom" : "capture"), ...(workspaceState.route.from ? { from: workspaceState.route.from } : {}), ...(workspaceState.route.to ? { to: workspaceState.route.to } : {}) };
    }
    function syncTime() {
        const nextTime = displayTimeSettings.resolve();
        if (JSON.stringify(nextTime) !== JSON.stringify(viewerTime)) {
            deletionUI?.invalidate();
            recollectionUI?.invalidate();
            viewerTime = nextTime;
            appUpdate?.render();
        }
        const preset = time.preset(workspaceState.route.range, viewerTime.timeZone);
        if (preset) {
            workspaceState.route = { ...workspaceState.route, ...preset };
            rememberRoute(workspaceState.route, true);
        }
        const reportPreset = time.preset(reportDates.range, viewerTime.timeZone);
        if (reportPreset && !activePreview && !reportRebuildFrom && !reportPreparing) reportDates = { range: reportDates.range, ...reportPreset };
        if (draft.synchronizeTime(periodReport?.timeContext ?? viewerTime, effectiveReportDates())) {
            invalidatePreview("The report time or date basis changed. Return to Setup and scan again.");
        }
        renderTimeContext();
    }
    function renderTimeContext() {
        const context = workspaceState.scope?.timeContext || viewerTime;
        displayTimeSettings.receive(context, { busy: exportWriting, pending: workspaceState.loading, stale: !workspaceState.loading && workspaceState.stale && context.timeZone !== viewerTime.timeZone });
        const notice = $("timeZoneNotice");
        notice.textContent = [displayTimeSettings.warning(), context.timeZoneFallback ? "Browser timezone unavailable. Dates and reports use UTC, not an inferred local timezone." : "", context.localeFallback ? "Browser locale unavailable. Dates use en-US formatting." : ""].filter(Boolean).join(" ");
        notice.hidden = !notice.textContent;
        selectControls?.sync();
    }
    function timeChanged() {
        const next = displayTimeSettings.resolve(), preset = time.preset(workspaceState.route.range, next.timeZone);
        return JSON.stringify(next) !== JSON.stringify(viewerTime)
            || Boolean(preset && (preset.from !== workspaceState.route.from || preset.to !== workspaceState.route.to));
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
        if (hiddenCards.has(scenario.scenarioId)) return "Hidden card";
        if (nativeActivity.isNative(scenario)) return nativeActivity.recognition(scenario).text;
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
        node.append(el("h3", "", title));
        if (text) node.append(el("p", "", text));
        return node;
    }
    function announce(text, kind = "", retry = false) {
        if (clearingAccess || !api.publicationToken()) return;
        const node = $("message");
        delete node.dataset.connectionFailure;
        node.replaceChildren(el("p", "", text));
        node.className = "notice " + kind;
        node.setAttribute("role", kind === "error" ? "alert" : "status");
        node.hidden = false;
        if (retry) {
            const control = button("Retry", refreshStoredData, "quiet");
            control.id = "storedViewRetry";
            control.dataset.storedRefreshRetry = "";
            control.setAttribute("aria-describedby", "storedRefreshHelp");
            node.append(control);
            renderStoredRefresh();
        }
    }
    function clearMessage() { $("message").hidden = true; }
    function retirePendingSaveMessage() {
        if (!exportWriting && !collectionSettings?.isBusy() && $("message").classList.contains("pending-save")) clearMessage();
    }

    function sessionChanged() {
        if (api.accessState().mode !== "unbound") return;
        for (const key of privateNavigations.keys()) forgetPrivateNavigation(key);
        liveSearchUI?.sessionChanged();
        connectionNeedsSnapshot = true;
        assessmentUI?.invalidate("The local connection changed. Read current insights; no update was replayed.");
        deletionUI?.invalidate();
        recollectionUI?.invalidate();
        invalidatePreview();
        workspaceState.stale = true;
        invalidateDialog("The local connection changed. Close and prepare a new report preview.");
        updateSelection();
    }
    let searchReturnMarker = null;
    const analysisSearchKey = () => workspaceState.evidence ? JSON.stringify([workspaceState.evidence.revision, workspaceState.evidence.nativeRead?.sourceRevision ?? workspaceState.evidence.nativeRead?.revision, workspaceState.scope, workspaceState.route.withinServices?.split(",") || []]) : null;
    function unavailableSearchMembership() {
        return { revision: workspaceState.evidence.revision, nativeRevision: workspaceState.evidence.nativeRead?.revision, scopeKey: JSON.stringify([workspaceState.scope, workspaceState.route.withinServices?.split(",") || []]),
            receipt: null, scenarioIds: [], actionIds: [], parentScenarioIds: [] };
    }
    liveSearchUI = assessmentFactories.liveSearch.mount({
        api, ux, searchFields, results, authorship, createState: assessmentFactories.liveSearch.createState,
        showHit: hit => {
            if (!workspaceState.evidence && !["view", "setting"].includes(hit.type)) return false;
            if (!hiddenCards.any()) return true;
            if (["report", "comparison"].includes(hit.type)) return false;
            const query = hit.target?.href?.split("?")[1];
            return !query || !hiddenCards.has(new URLSearchParams(query).get("request"));
        },
        nativeSearch: {
            active: () => sourceCollection.active && showMicrosoftActivity(),
            changed: value => boundedNative.searchChanged({ ...value,
                sources: sourceCollection.active && showMicrosoftActivity() ? workspaceState.scope?.filters.sources?.length
                    ? workspaceState.scope.filters.sources.filter(source => boundedContract.sourceIds.includes(source)) : boundedContract.sourceIds : [],
                revision: workspaceState.evidence?.revision ?? null, pending: workspaceState.loading || !workspaceState.evidence, base: workspaceState.evidence?.nativeRead, analytics: workspaceState.scope }),
            withdraw: () => boundedNative.searchChanged({ query: "", scope: "navigation", types: [], sources: [], revision: null }),
        },
        serviceIcon(target) {
            if (target?.kind !== "route" || typeof target.href !== "string" || !target.href.startsWith("#analyze?")) throw new TypeError("Search service target is invalid.");
            const services = new URLSearchParams(target.href.split("?")[1]).getAll("services");
            if (services.length !== 1 || !services[0] || services[0].includes(",")) throw new TypeError("Search requires one recorded service identity.");
            return serviceCue("span", services[0]).querySelector(".wire-icon");
        },
        async presentDocument(value, { isCurrent, returnKey }) {
            if (!isCurrent() || hiddenCards.any()) return;
            const key = savedEntry("reader", value.artifact, document.activeElement, { value, isCurrent, searchReturn: returnKey });
            const entered = await navigate({ ...routeFor("reports"), bundle: value.artifact.bundleId, savedEntry: key, savedAuthority: "search" }, false, { fromSearch: true, isCurrent });
            if (!entered) { savedEntries.delete(key); return false; }
            if (!isCurrent()) invalidateSavedReader("This Search destination is no longer current. Return to Search and open its verified current item.");
            return true;
        },
        getAnalysis: () => ({ key: analysisSearchKey(), revision: workspaceState.evidence?.revision, pending: workspaceState.loading,
            returnPending: Boolean(sidebarExit),
            active: underlyingRoute().view === "analyze", needsRebind: semanticStatus === "pending" && !semanticBound }),
        async navigate(target, { isCurrent } = {}) {
            if (!isCurrent?.()) return false;
            // The navigation result named Saved reports opens the library, not the creation landing.
            const next = target.href === "/reports" ? routeFor("reports", { task: "library", request: undefined })
                : readRoute(target.href, null);
            searchOpenedRequest = next.view === "request" ? next.request : null;
            searchReturnMarker = liveSearchUI.returnKey();
            searchTargetInvalid = false;
            const intent = workspaceState.readingIntent;
            const entered = await navigate(next.view === "analyze" ? next
                : { ...workspaceState.route, ...next, request: next.request, call: next.call, callRevision: next.callRevision }, false, { fromSearch: true, isCurrent });
            if (!entered || !isCurrent() || intent !== workspaceState.readingIntent) return false;
            if (target.focus) {
                const nativeTarget = target.focus.startsWith("native-source-fact-") || target.focus.startsWith("native-message-");
                let node = nativeTarget ? readerSections?.revealTarget?.(target.focus) : $(target.focus);
                if (next.view === "request" && target.focus === "selectedContext") {
                    if (!node || node.dataset.contextGroup !== next.request || workspaceState.route.request !== next.request) return false;
                    cancelSidebarReading?.();
                    textAccess.revealPrompt(node.querySelector(".full-text"));
                    node = node.querySelector(".full-text-content");
                }
                if (!isCurrent()) return false;
                if (nativeTarget && !node) {
                    announce("This exact recorded text is no longer available. Search again to open the current record.", "stale");
                    return false;
                }
                if (node) {
                    if (nativeTarget) { cancelSidebarReading?.(); cancelSidebarReading = null; }
                    node.tabIndex = -1; node.focus({ preventScroll: true });
                    if (contextBody.contains(node)) contextBody.scrollTop += node.getBoundingClientRect().top - contextBody.getBoundingClientRect().top - 16;
                    else node.scrollIntoView({ block: "start" });
                }
            }
        },
        onInvalidateOpen({ accessWithdrawn = false } = {}) {
            if (accessWithdrawn) {
                searchOpenedRequest = null; searchReturnMarker = null; searchTargetInvalid = true;
                savedEntries.clear(); clearSavedReader();
                return;
            }
            for (const entry of savedEntries.values()) if (entry.searchReturn) delete entry.value;
            if (savedReportView && workspaceState.route.savedAuthority === "search") invalidateSavedReader("This Search destination is no longer current. Return to Search and open its verified current item.");
            if (!searchOpenedRequest || (workspaceState.route.view === "request" ? workspaceState.route.request : sidebarExit?.request) !== searchOpenedRequest) return;
            searchTargetInvalid = true;
            assessmentUI?.invalidate("Search authorization changed. Reopen the current item.");
            assessmentUI?.clearPrivateText();
            if (workspaceState.route.view === "request") $("requestContent").replaceChildren(el("p", "notice", "This search destination is no longer current. Return to Search and reopen its verified current item."));
        },
        onAnalysis(update) {
            if (!workspaceState.evidence) return;
            if (update.query === null || !update.query.trim()) {
                if (incomingNavigation?.analysisQuery) {
                    semanticQuery = incomingNavigation.analysisQuery;
                    semanticComplete = semanticBound = false;
                    semanticMembership = unavailableSearchMembership();
                    return;
                }
                if (semanticQuery === null) return;
                semanticQuery = null; semanticMembership = undefined; semanticComplete = false; semanticBound = false;
                workspaceState.route = { ...workspaceState.route, analysisQuery: null };
                rememberRoute(workspaceState.route, true);
                if (history.state?.wirePrivateNavigation) {
                    const { wirePrivateNavigation, ...navigationState } = history.state;
                    history.replaceState(navigationState, "");
                }
                $("wireAnalysisSearchNotice").hidden = true;
                if (!switchingAnalysis) { render(); finishChartReferenceReading(); }
                return;
            }
            const changed = semanticQuery !== update.query;
            semanticQuery = update.query;
            workspaceState.route = { ...workspaceState.route, analysisQuery: semanticQuery };
            if (changed) rememberRoute(workspaceState.route, true);
            semanticComplete = false;
            semanticBound = false;
            semanticStatus = update.state === "pending" ? "pending" : "stale";
            const current = update.scopeKey === analysisSearchKey() && update.receipt?.revision === workspaceState.evidence.revision
                && assessmentFactories.liveSearch.contract.analysisReceipt(update.receipt);
            if (update.state === "ready" && current) {
                semanticComplete = update.complete === true;
                semanticMembership = assessmentFactories.liveSearch.membership(workspaceState.evidence, workspaceState.scope, workspaceState.route.withinServices?.split(",") || [],
                    semanticComplete ? update.hits : [], update.receipt);
                semanticBound = semanticComplete;
                semanticStatus = semanticComplete ? "ready" : "partial";
            } else {
                semanticMembership = unavailableSearchMembership();
            }
            $("wireAnalysisSearchNotice").hidden = update.state === "ready" && current && semanticComplete;
            $("wireAnalysisSearchNotice").textContent = update.state === "ready" && current
                ? semanticComplete ? "" : "Some saved text could not be searched. Counts and Current reports are unavailable."
                : update.state === "pending" ? "Searching saved activity..." : "Search is unavailable. Try again before preparing a Current report.";
            if (!switchingAnalysis) { render(); finishChartReferenceReading(); }
        },
    });
    deletionUI = mountDeletion({ api, flow: createDeletionFlow(), createCalendar: assessmentFactories.createDateRangeCalendar, time, timeContext: () => viewerTime, ux,
        onCommitted: async () => {
            clearDeletedDraft("deleted");
            return load();
        },
    });
    recollectionUI = assessmentFactories.mountRecollection({ api, createCalendar: assessmentFactories.createDateRangeCalendar, time, timeContext: () => viewerTime, search: localSearch, ux, searchFields,
        describe: assessmentFactories.describeRecollection,
        offerVerifiedRecords: () => collection?.recollection?.exactRecordsAvailable === true,
        canAct: recollectionGuard,
        onNotice: message => announce(message, "error"),
        onChanged: current => {
            const key = `${current.phase}:${current.operationId || ""}`;
            if (["pending", "uncertain"].includes(current.phase) || ["complete", "not-started"].includes(current.phase) && key !== recollectionNoticeKey) recollectionNoticeVisible = true;
            recollectionNoticeKey = key;
            renderFreshActivity();
        },
        pageSources: (host, sources, renderItem, reset, isCurrent, beforeReplace) => {
            if (reset) presentation.setPage("recollection-chats", 0);
            pagedList(host, sources, { key: "recollection-chats", size: pageSize, noun: "chats", renderItem, isCurrent, beforeReplace });
        },
        onCommitted: async () => {
            clearDeletedDraft("changed by explicit recollection");
            return load({ background: true });
        },
    });
    let ignoringStaleContextStatus = false;
    assessmentUI = assessmentFactories.createExperience({
        ...assessmentFactories, api, ux, textAccess,
        onInvalidated: (message, reason) => {
            if (clearingAccess || !api.publicationToken()) return;
            if (reason === "data" && sourceCollection.active && workspaceState.route.nativeSource
                && readerSections?.retains?.(nativeReaderScope())) return;
            if (sidebarExit) { clearSidebarExit(); finishSidebarMotion(); }
            const sameReader = reason === "data" && acceptingSnapshot && contextOwner?.interaction && workspaceState.route.nativeSource === undefined
                && workspaceState.evidence?.collection?.configVersion === acceptingSnapshot.collection?.configVersion
                && workspaceState.evidence?.deletionVersion === acceptingSnapshot.deletionVersion
                && JSON.stringify(requestContext.select(workspaceState.evidence.scenarios, workspaceState.route.request))
                    === JSON.stringify(requestContext.select(acceptingSnapshot.scenarios, workspaceState.route.request));
            // Only presentation choices survive; text owners and pending callbacks still retire below.
            const retainedKeys = new Set(sameReader
                ? [...contextBody.querySelectorAll("[data-disclosure-key],.full-text[data-view-key]")].map(node => node.dataset.disclosureKey || node.dataset.viewKey) : []);
            cancelSidebarReading?.();
            sidebarReadingFocus = null;
            for (const node of contextBody.querySelectorAll("[data-disclosure-key],.full-text[data-view-key]")) {
                const key = node.dataset.disclosureKey || node.dataset.viewKey;
                if (!retainedKeys.has(key)) presentation.forget(key);
            }
            for (const entry of sidebarPositions.values()) for (const key of entry.keys) if (!retainedKeys.has(key)) presentation.forget(key);
            sidebarPositions.clear();
            requestRenderKey = null;
            if (workspaceState.route.view === "request") {
                const active = document.activeElement;
                const focus = reason === "data" && !acceptingSnapshot && contextBody.contains(active)
                    ? promptFocus(active) ?? (active.matches(".reader-call-toggle")
                        ? { key: active.closest("[data-view-key]")?.dataset.viewKey, callDetail: active.getAttribute("aria-controls") } : null) : null;
                requestInvalidated = true;
                clearReaderSections();
                const notice = el("p", "notice", message);
                $("requestContent").replaceChildren(notice);
                // Status can retire the reader before its replacement snapshot arrives. Carry
                // only the disclosure identity, and only while focus remains on this notice.
                if (focus?.prompt || focus?.key && focus.callDetail) {
                    invalidatedReaderFocus.set(notice, { focus, identity: sidebarIdentity, publication: api.publicationToken(), intent: workspaceState.readingIntent });
                    notice.tabIndex = -1; notice.focus({ preventScroll: true });
                }
                renderReportInspectionReturn();
            }
        },
        refresh: () => load({ background: true }),
        onNotice: message => announce(message, "error"),
        onSaved: message => announce(message),
        onChanged: () => {
            if (ignoringStaleContextStatus) return;
            draft.clearContext({ authority: true, writing: exportWriting });
            scrubContextPreview();
            invalidatePreview();
            invalidateDialog("Recorded evidence or permission changed. Prepare a new report preview.");
        },
    });
    function cloneReportBrand(version) {
        if (version !== undefined && version !== 1 && version !== 2) throw new Error("This report's branding version is not supported.");
        const originals = $(version === 2 ? "reportBrandV2" : version === 1 ? "reportBrandV1" : "reportBrand").content.querySelectorAll(".brand-logo");
        if (originals.length !== 2) throw new Error("WIRE's report wordmark assets are unavailable.");
        const mark = el("span", "saved-report-mark");
        mark.setAttribute("role", "img"); mark.setAttribute("aria-label", "WIRE");
        for (const original of originals) {
            const copy = original.cloneNode(true), ids = new Map(), prefix = "report-mark-" + crypto.randomUUID() + "-";
            for (const node of copy.querySelectorAll("[id]")) {
                ids.set(node.id, prefix + ids.size); node.id = ids.get(node.id);
            }
            for (const node of [copy, ...copy.querySelectorAll("*")]) for (const attribute of [...node.attributes]) {
                let value = attribute.value;
                for (const [before, after] of ids) value = value.replaceAll(`url(#${before})`, `url(#${after})`);
                if (value !== attribute.value) node.setAttribute(attribute.name, value);
            }
            mark.append(copy);
        }
        return mark;
    }
    function mountFileInspection(host, files, options) {
        return assessmentFactories.preparedFileInspection(host, files, {
            ...options, fileLabel: reportFilenameLabel, icon: ux.icon, utility: ux.utility, brand: () => cloneReportBrand(options.brandVersion),
            createPreview: (target, value, settings) => {
                const mounted = assessmentFactories.savedFilePreview(target, value, {
                    ...settings, frozenFrame: assessmentFactories.liveSearch.frozenFrame,
                });
                void mounted.ready.then(() => { if (settings.isCurrent()) selectControls?.sync(); });
                return mounted;
            },
        });
    }
    function clearPreparedReaders() {
        preparedReportReader?.dispose(); preparedReportReader = null;
        preparedFileInspection?.dispose(); preparedFileInspection = null;
    }
    function erasePreparedNodes(root) {
        ux.withdrawAccess([root]);
        const nodes = [root, ...root.querySelectorAll("*")];
        for (const node of nodes) {
            for (const text of node.childNodes) if (text.nodeType === Node.TEXT_NODE) text.data = "";
            if (node.matches("input,textarea,select,option")) {
                node.value = "";
                if ("defaultValue" in node) node.defaultValue = "";
            }
            if (node !== root) for (const attribute of [...node.attributes]) {
                node.removeAttributeNode(attribute);
                attribute.value = "";
            }
        }
    }
    function scrubContextPreview() {
        for (const bundle of renderedContextBundles) {
            for (const copy of bundle.nativeReview ?? []) {
                copy.original = copy.text = null;
                copy.segments = [];
            }
            for (const copy of bundle.resultReview ?? []) {
                copy.original = copy.text = null;
                copy.segments = [];
            }
            for (const copy of bundle.snapshot?.resultText?.copies ?? []) copy.text = null;
            if (bundle.snapshot?.nativeEvidence) delete bundle.snapshot.nativeEvidence;
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
        clearPreviewPayload?.();
        clearPreparedReaders();
        for (const frame of body.querySelectorAll(".report-frame")) frame.srcdoc = "";
        body.replaceChildren();
        delete body.dataset.recordedContext;
    }
    function restorePeriodComparisonReading() {
        const saved = periodReturnReading;
        if (!saved) return;
        if (saved.navigation !== workspaceState.navigationGeneration || saved.intent !== workspaceState.readingIntent
            || workspaceState.route.view !== "analyze" || workspaceState.route.compare !== "periods") { periodReturnReading = null; return; }
        if (periodComparisonUI.consumer()) { restoreReading(saved.position); periodReturnReading = null; }
    }
    const expiredTrend = el("section", "empty-state"), expiredTrendTitle = el("h2"), expiredTrendHelp = el("p");
    expiredTrend.hidden = true;
    expiredTrend.append(expiredTrendTitle, expiredTrendHelp,
        button("Open Trends without this scope", () => navigate({ view: "trends", search: "", analysisQuery: null }, true)));
    $("trendsView").before(expiredTrend);
    const periodBackToTrends = button("Back to Trends", () => {
        if (!trendPeriodVisit || !api.isCurrent(trendPeriodVisit.publication)
            || trendPeriodVisit.destination !== historyPosition || workspaceState.route.compare !== "periods") return;
        history.back();
    }, "quiet");
    periodBackToTrends.prepend(ux.icon("back")); periodBackToTrends.hidden = true;
    $("periodComparisonSetup").prepend(periodBackToTrends);
    const trendsUI = assessmentFactories.mountTrends({
        questionControls: assessmentFactories.questionControls,
        root: $("trendsView"), api, time, ux, authorship,
        hiddenInteraction: id => hiddenCards.has(id),
        getContext: () => ({ active: underlyingRoute().view === "trends" && !expiredTrendEntry(underlyingRoute()), revision: workspaceState.evidence?.revision,
            entry: trendOrigin(underlyingRoute())?.entry ?? null, get hasMicrosoftSource() { return hasMicrosoftSource(); },
            section: trendSection(underlyingRoute()),
            routeScope: trendRouteScope(underlyingRoute()),
            timeContext: viewerTime, publication: api.publicationToken(), stale: workspaceState.stale || workspaceState.loading }),
        onScopeChange: rememberTrendScope,
        onComparePeriods: (dates, filters, usageChoice) => {
            const publication = api.publicationToken();
            if (workspaceState.route.view !== "trends" || !publication || workspaceState.stale || workspaceState.loading) return;
            const target = { view: "analyze", compare: "periods", layer: "tool", scope: "all", source: "github-copilot",
                bucket: "day", search: "", analysisQuery: null, ...dates,
                ...(filters.author ? { authors: filters.author } : {}), ...(filters.tool ? { tool: filters.tool } : {}),
                ...(filters.service === "Discovery" ? { service: "Discovery" } : filters.service && filters.service !== "missing"
                    ? { services: filters.service, includeMissingService: false } : {}) };
            trendPeriodVisit = { publication, destination: historyPosition + 1, target: readingKey(target) };
            periodComparisonUI.startUsage(usageChoice);
            navigate(target);
        },
        onUsageReport: async ({revision, range, filters, question, threshold, scenarioIds}) => {
            const publication = api.publicationToken();
            if (!publication || workspaceState.route.view !== "trends" || revision !== workspaceState.evidence?.revision || workspaceState.stale || workspaceState.loading) return;
            const original = boundTrend(workspaceState.route)?.reportVisit && draft.options().usageOptions;
            const sameDraft = original && !reportBaseExplicit && !namedReport && question === original.question && filters.author === original.author && filters.tool === original.tool && !filters.service
                && (question !== "tool" || threshold === (original.threshold ?? 30000))
                && range.from === effectiveReportDates().from && range.to === effectiveReportDates().to;
            if ((!sameDraft && hasReportDraftChoices()) || reportPreparing || exportWriting || reportJourney.snapshot().saveUnconfirmed) {
                announce("Your current report is still open. Finish it in Reports before preparing another question.", "stale"); return;
            }
            const catalog = new Set(workspaceState.evidence.exportCatalog.requests.map(r=>r.scenarioId));
            if (!scenarioIds.length || scenarioIds.some(id=>!catalog.has(id) || hiddenCards.has(id))) {
                announce("Some chart interactions are hidden or unavailable for a report. Review the selection in Analyze.", "stale"); return;
            }
            if (!sameDraft) applyReportDefaults();
            reportBaseExplicit = true; reportScope = "selected"; reportDates = {range:"custom",...range};
            for (const id of scenarioIds) selected.add(id);
            draft.change({usageOptions:{ tokens:true,dollars:true,rows:false,...(sameDraft ? original : {}),question,
                ...(question === "tool" ? {threshold} : {}), ...(filters.author ? {author:filters.author} : {}), ...(filters.tool ? {tool:filters.tool} : {}) }});
            if (await navigate({view:"reports",search:"",analysisQuery:null}) && api.isCurrent(publication)) await chooseReportPreset("all");
        },
        onSectionChange: (section, measure) => {
            const route = workspaceState.route;
            if (route.view !== "trends" || expiredTrendEntry(route)) return;
            navigate({ ...route, entryDefault: undefined, trendSection: section, ...(measure ? { trendMeasure: measure } : {}) }, false, { keepFocus: true });
        },
        returnToAnalyze: () => {
            const from = trendOrigin(workspaceState.route);
            if (from && from.position < historyPosition) history.go(from.position - historyPosition);
        },
        reload: () => load(),
        recordLink: row => {
            const node = link(row.tool, "request", { request: row.scenarioId, call: row.id }, "text-link");
            const scenario = workspaceState.evidence?.scenarios.find(item => item.scenarioId === row.scenarioId);
            const call = fullRowsFor(row.scenarioId, "tool")?.find(item => item.id === row.id);
            const prompt = scenario && textAccess.describePrompt(scenario.userPrompt).hasText
                ? textAccess.excerpt(scenario.userPrompt, 160) : scenario?.title || "Retained interaction";
            node.append(el("span", "trends-evidence-context", prompt),
                el("span", "trends-evidence-time", "Call started: " + time.formatTime(call ? sourceCallFor(call)?.startedAt : null, viewerTime)));
            return node;
        },
    });
    const periodComparisonUI = assessmentFactories.periodComparison.mount({
        hiddenInteraction: id => hiddenCards.has(id),
        root: $("periodComparison"), setup: $("periodComparisonSetup"), toggle: $("comparePeriods"), api, time, ux, search: localSearch, categories, results,
        projection: createActivityProjection(time, recordedCategories, resultKeys),
        createState: assessmentFactories.periodComparison.createState, assessmentFactories, bindDetails,
        getContext: () => {
            const options = query(), includesGithub = !options.filters.sources?.length || options.filters.sources.includes("github-copilot");
            return { snapshot: workspaceState.evidence, options, nativeView: acceptedNativeView(), route: workspaceState.route, search, isLoading: workspaceState.loading, isStale: workspaceState.stale, readingIntent: workspaceState.readingIntent, navigationGeneration: workspaceState.navigationGeneration,
            semanticSearch: semanticQuery === null || !includesGithub ? undefined : {
                status: semanticStatus,
                receipt: semanticBound ? semanticMembership?.receipt : undefined,
                scenarioIds: semanticMembership?.scenarioIds ?? [], actionIds: semanticMembership?.actionIds ?? [],
                parentScenarioIds: semanticMembership?.parentScenarioIds ?? [], coverage: "whole-retained-corpus",
                ...(search.trim() ? { withinScenarioIds: analysisSlice.legacyScenarioIds(workspaceState.evidence, search) } : {}),
            } };
        },
        navigate: changes => Object.hasOwn(changes, "compare") && changes.compare === undefined
            ? navigateBrowse("analyze", { returning: true }) : navigate(routeFor("analyze", changes), true, { keepFocus: true }),
        open: () => navigateBrowse("compare"),
        useAnalyze: () => navigateBrowse("compare", { useAnalyze: true }),
        onPairChange: pair => {
            let description = analyzeScope.describePair(pair, {
                githubOnly: !showSourceChoice(),
            });
            const filters = pair?.comparison.options.filters;
            if (description && !workspaceState.route.comparisonFocus && !filters.outcomes?.length
                && filters.promptAuthors?.length === 1 && ["user", "agent"].includes(filters.promptAuthors[0])) {
                const parts = description.parts.filter(part => !part.startsWith("Author: "));
                description = { ...description, parts, text: parts.join("; ") };
            }
            analyzeControls.pairedCaption(description === null ? null : {
                ...description, key: pair.key, revision: pair.revision,
            });
            refreshChartReference();
        },
        onSearch: value => { $("activitySearch").value = value; $("activitySearch").dispatchEvent(new Event("input")); },
        openSearch: () => liveSearchUI.analysisScope(),
        syncFilters: () => selectControls?.sync(),
        onAccepted: restorePeriodComparisonReading,
        createReport: function createPeriodReport(value, semanticSelection, usageChoice) {
            if (reportJourney?.snapshot().saveUnconfirmed) { announce(reportJourney.reason(1), "stale"); return; }
            if (exportWriting || workspaceState.loading || workspaceState.stale) return;
            const ids = [...new Set(Object.values(value.periods).flatMap(side => side.scenarioIds))];
            if (!ids.length && !value.nativePeriods?.rows.length && !value.nativePeriods?.refinement?.contextConversationRefs.length) { announce("Neither period has matching retained records. Choose periods with activity before creating a report.", "error"); return; }
            clearReportSelection();
            periodReport = { value, semanticSelection, returnTo: { ...workspaceState.route, search }, timeContext: structuredClone(viewerTime) };
            periodReportInvalid = false;
            for (const id of ids) selected.add(id);
            draft.clearSelection();
            draft.change({ saveMode: "local", ...(usageChoice?.question && usageChoice.question !== "all" ? { usageOptions:{
                tokens:true, dollars:true, rows:false, question:usageChoice.question,
                ...(usageChoice.question === "tool" ? {threshold:usageChoice.threshold} : {}),
            } } : {}) });
            reportBaseExplicit = true;
            go("reports", { task: "create", request: undefined });
            updateSelection(); void previewExport();
        },
        recordLink: (row, side, value) => link(row.tool, "request", {
            request: row.scenarioId, call: row.id, callRevision: value.definitions.layer === "reported-api" ? String(value.revision) : undefined,
            range: "custom", from: side.range.from, to: side.range.to,
        }, "text-link"),
    });
    function clearDeletedDraft(change = "changed") {
        namedReport = null;
        assessmentUI.invalidate(`Collected activity or its optional evidence was ${change}. Read current insights.`);
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
    function invalidatePreview(message, { preserveFileView = false } = {}) {
        if (clearingAccess || !api.publicationToken()) return;
        reportSaveWarning.cancel();
        const view = $("preparedReportView");
        const reading = preserveFileView ? view
            ? { view: view.value, file: preparedFileInspection?.selection() ?? pendingReportReading?.file } : pendingReportReading : null;
        const publication = api.publicationToken();
        if (message !== "" || !$("reportReviewBody")?.dataset.recordedContext || !draft.contextCurrent(draft.contextToken())) {
            draft.clearContext({ writing: exportWriting });
            scrubContextPreview();
        }
        if (exportWriting) return;
        pendingReportReading = reading;
        clearTimeout(reportUpdateTimer); reportUpdateAgain = false; saveAfterMask = false;
        nativePublication.invalidate(); clearTimeout(nativePreviewExpiryTimer); syncNativeSaveAvailability = null;
        const previewId = activePreview?.previewId ?? reportRebuildFrom;
        if (message !== "") clearPreviewPayload?.();
        clearPreparedReaders();
        draft.invalidate();
        if (message !== "") $("reportReviewBody")?.querySelector(".rebuild-preview")?.remove();
        reportJourney?.invalidate(message);
        activePreview = null;
        reportRebuildFrom = null;
        if (previewId) api("/api/cancel-preview", { previewId }).catch(() => {
            if (api.isCurrent(publication)) announce("The previous preview could not be cancelled on the runtime. Do not reuse it; prepare a new preview before reviewing.", "error");
        });
    }
    function readHistoryAnalysis(key) {
        const remembered = typeof key === "string" ? analysisNavigations.get(key) : null;
        if (!remembered || !api.isCurrent(remembered.publication)) {
            incomingNavigationError = "The earlier private Search selection is unavailable. Search again or explicitly open this view without it.";
            return null;
        }
        return remembered.query;
    }
    function readRoute(address = currentAddress(), navigationState = history.state) {
        const values = paths.parse(address);
        if (!values) throw new TypeError("This address is not a WIRE page.");
        const current = api.publicationToken();
        const historyEntry = navigationState?.evidenceView?.url === address ? navigationState
            : arguments.length === 0 && initialHistory?.evidenceView?.url === address ? initialHistory : null;
        const entryScope = historyEntry?.evidenceView.viewScope;
        if (entryScope && current) {
            if (historyEntry.wireAccess?.runtimeId === api.accessState().runtimeId && historyEntry.wireAccess.generation === current.generation) {
                const allowed = Object.fromEntries(Object.entries(entryScope).filter(([key, value]) =>
                    paths.isScope(key) && ["string", "boolean"].includes(typeof value)));
                Object.assign(values, paths.project({ ...values, ...allowed }, publicField).viewScope);
            } else incomingNavigationError = "The earlier view is no longer authorized. Open this view again without that selection.";
        }
        if (historyEntry?.evidenceView.unavailableSelection) incomingNavigationError = "This tab no longer has the private view. Open it again from its original records.";
        if (!current || api.accessState().mode !== "unbound" && (navigationState?.wireAccess?.owner !== historyOwner
            || navigationState.wireAccess.epoch !== current.epoch || navigationState.wireAccess.runtimeId !== current.runtimeId)) {
            if (navigationState?.evidenceView?.url === address && (navigationState.evidenceView.privateKey && !values.bookmark
                || navigationState.evidenceView.search?.trim() || sessionJourney.hasHistoryAnalysis(navigationState.evidenceView))) {
                incomingNavigationError = "The earlier private selection is no longer authorized. Search again or explicitly open this view without that selection.";
            }
            navigationState = null;
        }
        if (arguments.length === 0 && initialRoute?.url === address) Object.assign(values, initialRoute.value);
        if (incomingNavigation && arguments.length === 0) Object.assign(values, incomingNavigation.fields, { search: incomingNavigation.search });
        if (navigationState?.evidenceView?.url === address) {
            const entry = navigationState.evidenceView;
            const snapshot = historyViews.get(entry.privateKey);
            if (snapshot && api.isCurrent(snapshot.publication)) Object.assign(values, snapshot.fields);
            else if (entry.privateKey && !values.bookmark) incomingNavigationError = "This tab no longer has the private view. Open it again from its original records.";
            // Read old history entries, but never write their private payload back to history.
            const remembered = snapshot?.fields || entry;
            if (typeof remembered.search === "string") values.search = remembered.search;
            if (remembered.returnToSessions) values.returnToSessions = sessionJourney.decodeHistoryRoute(remembered.returnToSessions, readHistoryAnalysis);
            if (remembered.returnToResults) values.returnToResults = sessionJourney.decodeHistoryRoute(remembered.returnToResults, readHistoryAnalysis, true);
            if (remembered.localSearch) values.localSearch = remembered.localSearch;
            const key = entry.analysisKey;
            values.analysisQuery = key !== undefined || Object.hasOwn(entry, "analysisQuery")
                ? readHistoryAnalysis(Object.hasOwn(entry, "analysisQuery") ? undefined : key) : null;
            if (/^[a-f0-9-]{36}$/.test(entry.savedEntry)) values.savedEntry = entry.savedEntry;
            if (entry.savedAuthority === "search") values.savedAuthority = "search";
        }
        // Old saved-list bookmarks predate the shelf; keep their explicit list order or inspector.
        if (values.view === "reports" && !values.bundle && !values.task && (new URLSearchParams(address.split("?")[1]).get("order") === "oldest" || values.inspect && !values.savedEntry))
            values.task = "library";
        if (values.view === "trends" && new URLSearchParams(address.split("?")[1]).has("privateView") && !values.trendEntry)
            values.trendUnavailable = true;
        return resolveBookmark(canonicalRoute(values), current && workspaceState.evidence);
    }
    function canonicalRoute(next) {
        next = sessionJourney.savedRoute(filterState.canonical(sessionJourney.canonical(next)));
        if (next.analyzeSection !== "guide" || next.view !== "analyze" || next.compare) delete next.analyzeSection;
        if (next.view === "trends" && next.trendPeriod === "custom") {
            try {
                time.calendar(next.trendFrom); time.calendar(next.trendTo);
                time.range({ from: next.trendFrom, to: next.trendTo }, viewerTime.timeZone);
            } catch { next = { view: "trends", trendUnavailable: true }; }
        }
        if (next.view !== "request") {
            const { nativeSource, nativeRevision, nativeSourceRevision, nativeOrdinal, nativeCompletedRef, completedCalls, failedCalls, bookmark, searchOwned, ...rest } = next;
            next = rest;
        }
        if (next.view !== "request" && Object.hasOwn(next, "call")) next = { ...next, call: undefined };
        if ((next.view !== "request" || next.layer !== "reported-api" || next.call === undefined) && Object.hasOwn(next, "callRevision")) {
            next = { ...next, callRevision: undefined };
        }
        if (next.callSort && !["slowest", "fastest"].includes(next.callSort)) next = { ...next, callSort: undefined };
        if (Object.hasOwn(next, "task") && (!["create", "library"].includes(next.task) || !["reports", "request"].includes(next.view))) {
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
    function publicField(key, value) {
        if (key === "guideTopic") return ["time", "tools", "services", "models", "authors", "outcomes"].includes(value);
        if (key === "section") return settingsNavigation.categories.some(item => item.id === value);
        if (key === "setting") return settingsNavigation.entries.some(item => item.id === value);
        if (["service", "services", "withinServices"].includes(key)) return value.split(",").every(id => recordedCategories.entries.some(item => item.id === id));
        if (key === "source") return value === "microsoft-365" || filterState.sources.some(item => item.id === value);
        if (key === "result") return value.split(",").every(item => Object.hasOwn(results.labels("tool"), item));
        if (key === "authors") return authorship.validSelection(value.split(","));
        if (key === "layer") return results.layers.includes(value);
        if (["from", "to", "timelineFrom", "aFrom", "aTo", "bFrom", "bTo"].includes(key)) return /^\d{4}-\d\d-\d\d(?:T\d\d:\d\d:\d\d(?:\.\d{3})?Z)?$/.test(value);
        if (["bundle", "inspect"].includes(key)) return /^export-[a-f0-9-]{36}$/.test(value);
        if (key === "page") return /^\d{1,8}$/.test(value);
        return ({ chart: ["time", "service", "endpoint", "workload"], bucket: ["day", "week", "month"], range: ["capture", "custom", "day", "week", "month", "7", "14", "30"],
            task: ["create", "library"], order: ["oldest"], scope: ["history", "legacy", "all"], origin: ["analyze", "trends", "reports"],
            includeMissingService: ["true", "false"], expanded: ["true"], comparisonView: ["outcomes", "timeline", "tools", "timing"],
            comparisonFocus: ["errors", "completed"] })[key]?.includes(value) === true;
    }
    function routeAddress(next, privateSelection = false, snapshot = workspaceState.evidence) {
        const { path, params, privateFields, viewScope } = paths.project(canonicalRoute(next), publicField);
        let bookmark;
        if (next.view === "request" && !next.searchOwned && !privateSelection && !next.nativeSource && !next.call && !next.nativeGroup
            && Object.keys(privateFields).every(key => key === "request")) {
            const index = bookmarkIndex(snapshot);
            const ref = next.bookmark ?? index?.byId.get(next.request);
            if (next.bookmark !== undefined || paths.validBookmark(ref) && index.byRef.get(ref) === next.request) {
                bookmark = paths.validBookmark(ref) ? ref : "unavailable";
                params.set("record", bookmark);
                delete privateFields.request;
            }
        }
        const privateDestination = Object.keys(privateFields).some(key => !paths.isScope(key) && key !== "trendEntry")
            || next.trendEntry && trendOrigin(next) || next.savedAuthority === "search"
            || privateSelection && (next.view === "request" || next.bundle);
        if (privateDestination || incomingNavigationKey === "required" && (privateSelection || incomingNavigationError)) params.set("privateView", "required");
        return { url: path + (params.size ? "?" + params : ""), privateFields, viewScope, bookmark };
    }
    function setRouteLink(node, next, privateSelection = Boolean(next.search?.trim() || next.analysisQuery != null)) {
        linkTargets.set(node, next);
        const target = routeAddress(next, privateSelection);
        const url = new URL(target.url, location.origin);
        if (!node.hasAttribute("data-nav") && (privateSelection || Object.keys(target.privateFields).length))
            url.searchParams.set("privateView", "required");
        node.setAttribute("href", url.pathname + url.search);
        return node.href;
    }
    // Preparation only: recipients admit their own snapshot and fresh Search receipt.
    const privateNavigationLifetimeMs = 30000;
    const privateNavigations = new Map();
    function forgetPrivateNavigation(key) {
        const entry = privateNavigations.get(key);
        clearTimeout(entry?.timer);
        if (entry) { entry.value = null; entry.recipient = null; entry.target = ""; }
        privateNavigations.delete(key);
    }
    window.__wireTakePrivateNavigation = (key, recipient, target) => {
        const entry = privateNavigations.get(recipient);
        if (key !== "required" || !entry || !api.isCurrent(entry.publication) || entry.recipient !== recipient || entry.target !== target) return null;
        if (!(performance.now() < entry.expiresAt) || workspaceState.loading || workspaceState.stale || entry.value.revision !== workspaceState.evidence?.revision
            || entry.value.sourceVersion !== workspaceState.evidence.collection?.configVersion || entry.value.nativeRevision !== workspaceState.evidence.nativeRead?.revision
            || entry.value.deletionVersion !== workspaceState.evidence.deletionVersion) { forgetPrivateNavigation(recipient); return null; }
        if (recipient.location.origin !== location.origin || recipient.location.pathname + recipient.location.search !== target
            || typeof recipient.__wireReceivePrivateNavigation !== "function") return null;
        const value = structuredClone(entry.value);
        forgetPrivateNavigation(recipient);
        recipient.__wireReceivePrivateNavigation(value);
        return null;
    };
    window.addEventListener("pagehide", () => {
        for (const key of privateNavigations.keys()) forgetPrivateNavigation(key);
    });
    function privateNavigationNotice(message, kind) {
        if (!chartReferenceUI.notify(message)) announce(message, kind);
    }
    function openPrivateNavigation(event) {
        if (!api.publicationToken()) return;
        const modified = event.type === "auxclick" ? event.button === 1
            : event.button === 0 && (event.ctrlKey || event.metaKey || event.shiftKey);
        if (!modified || event.altKey || event.defaultPrevented) return;
        const anchor = event.target.closest?.("a[href]");
        if (!anchor || anchor.hasAttribute("download")) return;
        const target = new URL(anchor.getAttribute("href"), location.href);
        const next = linkTargets.get(anchor);
        if (!next || target.origin !== location.origin || !paths.isPagePath(target.pathname)) return;
        const { privateFields, viewScope } = routeAddress(next);
        if (target.searchParams.get("privateView") !== "required") {
            if (anchor.hasAttribute("data-nav") || !Object.keys(privateFields).length && !Object.keys(viewScope).length && !next.search?.trim() && next.analysisQuery == null) return;
            target.searchParams.set("privateView", "required");
        }
        event.preventDefault();
        if (next.trendEntry || next.trendUnavailable) {
            privateNavigationNotice("Open this Trends selection in its original tab.", "stale");
            return;
        }
        if (next.savedAuthority === "search" || next.nativeGroup || next.nativeCompletedRef || searchOpenedRequest && searchOpenedRequest === next.request) {
            privateNavigationNotice("Open this selection in its original tab; another tab must verify its own Search or group.", "stale");
            return;
        }
        if (workspaceState.loading || workspaceState.stale || !workspaceState.evidence || semanticQuery !== null && !semanticBound) {
            privateNavigationNotice("Wait for the current private selection before opening another tab.", "stale");
            return;
        }
        const analysisQuery = liveSearchUI.analysisPreparation();
        if (semanticQuery !== null && analysisQuery !== semanticQuery) {
            privateNavigationNotice("The private Search changed. Wait for its current results before opening another tab.", "stale");
            return;
        }
        const value = { search: next.search ?? search, analysisQuery: next.analysisQuery === undefined ? semanticQuery === null ? null : analysisQuery : next.analysisQuery,
            fields: { ...viewScope, ...privateFields },
            revision: workspaceState.evidence.revision, nativeRevision: workspaceState.evidence.nativeRead?.revision, sourceVersion: workspaceState.evidence.collection?.configVersion, deletionVersion: workspaceState.evidence.deletionVersion,
            timeContext: structuredClone(workspaceState.scope.timeContext) };
        const recipient = window.open(target.href, "_blank", event.shiftKey ? "popup" : undefined);
        if (!recipient) {
            privateNavigationNotice("The new tab was blocked. Allow it or open this result in the current tab.", "error");
            return;
        }
        privateNavigations.set(recipient, { publication: api.publicationToken(), recipient, target: target.pathname + target.search, value, expiresAt: performance.now() + privateNavigationLifetimeMs,
            timer: setTimeout(() => forgetPrivateNavigation(recipient), privateNavigationLifetimeMs) });
    }
    for (const event of ["click", "auxclick"]) document.addEventListener(event, openPrivateNavigation);
    function routeFor(view, changes = {}) {
        if (view === "request" && workspaceState.route.view === "request" && changes.request === undefined) {
            view = underlyingRoute().view;
        }
        view = sessionJourney.canonical({ view }).view;
        return filterState.reconcileTimeline(workspaceState.route, {
            ...workspaceState.route, view, analyzeSection: undefined, guideTopic: undefined, widget: undefined, entryDefault: undefined, bookmark: undefined, searchOwned: undefined,
            completedCalls: undefined, failedCalls: undefined,
            nativeCompletedRef: undefined,
            bundle: undefined, inspect: undefined, savedEntry: undefined, savedAuthority: undefined,
            returnToResults: view === "request" ? workspaceState.route.returnToResults : undefined,
            request: ["request", "reports"].includes(view) ? workspaceState.route.request : undefined,
            ...Object.fromEntries(["nativeSource", "nativeRevision", "nativeSourceRevision", "nativeOrdinal"]
                .map(key => [key, view === "request" && (!changes.request || changes.request === workspaceState.route.request) ? workspaceState.route[key] : undefined])),
            call: view === "request" && (!changes.request || changes.request === workspaceState.route.request) ? workspaceState.route.call : undefined,
            callRevision: view === "request" && (!changes.request || changes.request === workspaceState.route.request) ? workspaceState.route.callRevision : undefined,
            origin: view === "request" ? (workspaceState.route.view === "reports" ? "reports" : workspaceState.route.origin || "analyze") : undefined,
            task: view === "reports" ? (workspaceState.route.view === "reports" ? workspaceState.route.task : workspaceState.route.origin === "reports" ? "create" : undefined)
                : view === "request" && workspaceState.route.view === "reports" ? workspaceState.route.task : undefined,
            issues: view === "settings" ? workspaceState.route.issues : undefined,
            section: view === "settings" && workspaceState.route.view === "settings" ? workspaceState.route.section : undefined,
            setting: view === workspaceState.route.view && ["settings", "collection-status"].includes(view) ? workspaceState.route.setting : undefined,
            settingsWarning: undefined,
            ...changes,
        });
    }
    function browseName(value) {
        const origin = sessionJourney.underlying(value);
        return origin?.view === "analyze" ? origin.compare === "periods" ? "compare" : "analyze" : origin?.view === "trends" ? "trends" : null;
    }
    function compareDestination(route) {
        return browseName(route) === "compare";
    }
    function rememberBrowse() {
        const name = browseName(workspaceState.route);
        if (!name || workspaceState.loading || workspaceState.stale || !api.publicationToken()) return;
        const origin = sessionJourney.underlying(workspaceState.route);
        browseStates.set(name, { publication: api.publicationToken(), route: { ...origin, search, analysisQuery: semanticQuery } });
    }
    function freshBrowseRoute(name, context = viewerTime) {
        const entryDefault = pageDefaults.get(browseDefaults[name]);
        const route = { view: name === "trends" ? "trends" : "analyze", search: "", analysisQuery: null, entryDefault };
        if (name === "analyze") return entryDefault === "capture" ? route
            : { ...route, range: entryDefault, ...time.preset(entryDefault, context.timeZone) };
        // Overview already opens on Errors & failures. Only other defaults need a Charts address.
        if (name === "trends") return entryDefault === "problems" ? route : { ...route, trendMeasure: entryDefault };
        return { ...route, compare: "periods", bucket: "day",
            ...assessmentFactories.periodComparison.createPresentation(time).completeDays(entryDefault, context) };
    }
    function browseRoute(name, { useAnalyze = false, returning = false } = {}) {
        const saved = browseStates.get(useAnalyze ? "analyze" : name);
        if (useAnalyze && !saved) throw new Error("Open an available Analyze view before using it in this comparison.");
        if (saved && !api.isCurrent(saved.publication)) {
            throw new Error("The earlier view is no longer authorized. Open a current view before using it.");
        }
        if (!useAnalyze) {
            if (name === "compare" && compareDestination(workspaceState.route)) {
                const current = underlyingRoute();
                if (current?.aFrom && current.aTo && current.bFrom && current.bTo)
                    return { ...current, search, analysisQuery: semanticQuery };
            }
            const route = saved?.route;
            // A previously untouched landing can use a newly chosen default. A filter,
            // deep link, history return or bounded handoff is a visit in its own right.
            if (!route || !returning && route.entryDefault && route.entryDefault !== pageDefaults.get(browseDefaults[name]) && !route.search && route.analysisQuery == null)
                return freshBrowseRoute(name);
            return route;
        }
        const value = saved.route, pair = underlyingRoute();
        return { ...value, view: "analyze", compare: "periods", entryDefault: undefined, request: undefined, task: undefined,
            range: undefined, from: undefined, to: undefined, page: undefined,
            ...(pair?.aFrom && pair?.aTo && pair?.bFrom && pair?.bTo
                ? { aFrom: pair.aFrom, aTo: pair.aTo, bFrom: pair.bFrom, bTo: pair.bTo }
                : assessmentFactories.periodComparison.createPresentation(time).completeDays(pageDefaults.get("compareDays"), viewerTime)),
            bucket: value.bucket ?? "day", timelineFrom: undefined };
    }
    function navigateBrowse(name, options) {
        rememberBrowse();
        try { return navigate(browseRoute(name, options), false, { restorePosition: true }); }
        catch (error) { announce(error.message, "error"); return false; }
    }
    function isComparisonAnalyzeLink(node, origin = underlyingRoute()) {
        return node.matches('.primary-navigation [data-nav="analyze"]') && origin.compare === "periods";
    }
    function readingKey(value) {
        const { url, privateFields, viewScope } = routeAddress(value);
        return JSON.stringify([url, viewScope, privateFields, value.search || ""]);
    }
    function positionKey(value, position) {
        const key = readingKey(value);
        // Two visits to General can launch different preference rows.
        return value.view === "settings" && value.section === "general" ? `${key}:${position}` : key;
    }
    function boundTrend(route) {
        const bound = route.view === "trends" && trendEntries.get(route.trendEntry);
        return bound && api.isCurrent(bound.publication) && bound.revision === workspaceState.evidence?.revision
            && bound.timeZone === viewerTime.timeZone ? bound : null;
    }
    function trendOrigin(route) {
        const bound = boundTrend(route);
        return bound?.origin ? bound : null;
    }
    function expiredTrendEntry(route) {
        return Boolean(route.view === "trends" && (route.trendUnavailable || route.trendEntry && !boundTrend(route)));
    }
    function trendRouteScope(route) {
        if (route.view !== "trends" || expiredTrendEntry(route)) return null;
        const bound = boundTrend(route);
        if (bound?.scope) return route.trendMeasure && route.trendSection
            ? { ...bound.scope, family: route.trendMeasure } : bound.scope;
        if (!route.trendMeasure && !route.trendPeriod) return null;
        const period = route.trendPeriod ?? "7";
        return { family: route.trendMeasure ?? "rhythm", period, adaptive: !route.trendPeriod,
            range: period === "custom" ? { from: route.trendFrom, to: route.trendTo } : time.preset(period, viewerTime.timeZone), filters: {} };
    }
    function trendSection(route) {
        return paths.trendSection(route);
    }
    function rememberTrendScope({ family, period, range, filters }, kind) {
        const previous = workspaceState.route;
        if (previous.view !== "trends" || !api.publicationToken() || workspaceState.loading || workspaceState.stale || expiredTrendEntry(previous)) return;
        if (!paths.trendMeasures.includes(family) || !["measure", "period", "filters"].includes(kind)) throw new TypeError("Invalid Trends navigation.");
        const scope = { family, period, adaptive: false, range: { from: range.from, to: range.to }, filters: { ...filters } };
        const oldScope = trendRouteScope(previous);
        const bound = boundTrend(previous);
        const implicitPeriod = !bound?.origin && (bound ? bound.implicitPeriod : !previous.trendPeriod);
        const keepImplicit = kind !== "period" && implicitPeriod;
        if (oldScope && !(kind === "period" && implicitPeriod) && JSON.stringify(oldScope) === JSON.stringify(scope)) return;
        // A widget is a single bound visit. Forward reopens its latest selection;
        // its original widget, reading position and revision remain authoritative.
        const home = trendOrigin(previous);
        let next;
        if (home) {
            home.scope = scope;
            next = previous.trendMeasure ? { ...previous, trendMeasure: family } : previous;
        } else {
            next = { view: "trends", search: "", analysisQuery: null, trendMeasure: family, trendSection: trendSection(previous) };
            const publicPeriod = ["7", "14", "30"].includes(period);
            const userDates = period === "custom" && (kind === "period" || previous.trendPeriod === "custom"
                && previous.trendFrom === range.from && previous.trendTo === range.to);
            if (!keepImplicit && (publicPeriod || userDates)) next.trendPeriod = period;
            if (userDates) Object.assign(next, { trendFrom: range.from, trendTo: range.to });
            if (Object.keys(filters).length || !keepImplicit && !publicPeriod && !userDates) {
                next.trendEntry = crypto.randomUUID();
                trendEntries.set(next.trendEntry, { scope, implicitPeriod: keepImplicit, position: historyPosition,
                    publication: api.publicationToken(), revision: workspaceState.evidence.revision, timeZone: viewerTime.timeZone });
            } else if (next.trendMeasure === previous.trendMeasure && !previous.trendEntry && keepImplicit) return;
        }
        // The controller already accepted and painted the selection. Publish history,
        // not another projection read or a navigation/focus cycle.
        rememberRoute(next, true);
        workspaceState.route = next;
        workspaceState.acceptedRoute = { ...next };
    }
    function go(view, changes = {}, replace = false) {
        if (view === "activity" && changes.session) presentation.setOpen("session:" + changes.session, true);
        return navigate(routeFor(view, changes), replace);
    }
    function refineScope(changes) {
        const view = workspaceState.route.view === "request" ? "analyze" : workspaceState.route.view;
        return navigate(routeFor(view, { ...changes, page: undefined, request: undefined }), view === workspaceState.route.view, { keepFocus: true });
    }
    function rememberHistoryAnalysis(query, publication, existingKey) {
        const remembered = analysisNavigations.get(existingKey);
        const key = remembered?.query === query && api.isCurrent(remembered.publication) ? existingKey : crypto.randomUUID();
        analysisNavigations.set(key, { query, publication });
        return key;
    }
    function rememberRoute(next, replace = false, generalShortcut) {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return;
        const analysisQuery = Object.hasOwn(next, "analysisQuery") ? next.analysisQuery : semanticQuery;
        const { url, privateFields, viewScope } = routeAddress(next, Boolean(next.search?.trim() || analysisQuery != null || incomingNavigationError));
        let analysisKey;
        if (typeof analysisQuery === "string" && analysisQuery.trim()) {
            analysisKey = rememberHistoryAnalysis(analysisQuery, publication, history.state?.evidenceView?.analysisKey);
        }
        const storeAnalysis = query => rememberHistoryAnalysis(query, publication, analysisKey);
        historyPosition = replace ? historyPosition : historyPosition + 1;
        if (!replace) for (const [key, from] of trendEntries) {
            if (key !== next.trendEntry && from.position + 1 >= historyPosition) trendEntries.delete(key);
        }
        if (next.search) privateFields.search = next.search;
        if (next.searchOwned) privateFields.searchOwned = true;
        if (next.localSearch && Object.values(next.localSearch).some(Boolean)) privateFields.localSearch = next.localSearch;
        if (next.returnToSessions) privateFields.returnToSessions = sessionJourney.encodeHistoryRoute(next.returnToSessions, storeAnalysis);
        if (next.view === "request" && next.returnToResults) privateFields.returnToResults = sessionJourney.encodeHistoryRoute(next.returnToResults, storeAnalysis, true);
        // Only allowlisted display choices can survive reload. Record-derived selectors and
        // Search (including their accompanying dates) remain behind page-local keys.
        const hasScope = Object.keys(viewScope).length > 0;
        const safeScope = hasScope && !Object.keys(privateFields).length && !analysisKey && !incomingNavigationError;
        if (!safeScope) Object.assign(privateFields, viewScope);
        const oldKey = history.state?.evidenceView?.privateKey;
        const privateKey = Object.keys(privateFields).length ? replace && historyViews.has(oldKey) ? oldKey : crypto.randomUUID() : undefined;
        if (replace && oldKey !== privateKey) historyViews.delete(oldKey);
        if (!replace) for (const [key, entry] of historyViews) if (entry.position >= historyPosition) historyViews.delete(key);
        if (privateKey) historyViews.set(privateKey, { fields: privateFields, publication, position: historyPosition });
        const previousShortcut = replace && history.state?.wireAccess?.owner === historyOwner ? history.state?.evidenceView?.generalShortcut : undefined;
        const navigationState = { ...history.state, wireAccess: { owner: historyOwner, epoch: publication.epoch, runtimeId: api.accessState().runtimeId, generation: publication.generation },
            evidenceView: { url, privateKey, analysisKey, position: historyPosition, viewScope: safeScope ? viewScope : undefined, unavailableSelection: incomingNavigationError ? true : undefined,
            generalShortcut: next.view === "settings" && !next.setting && (generalShortcut || previousShortcut === next.section) ? next.section : undefined,
            sidebarEntry: next.view === "request" ? (next.sidebarEntry ?? history.state?.evidenceView?.sidebarEntry) : undefined,
            sidebarRestoration: next.view === "request" || next.inspect ? sidebarHistoryMode ?? history.state?.evidenceView?.sidebarRestoration : undefined,
            savedEntry: next.savedEntry, savedAuthority: next.savedAuthority } };
        delete navigationState.wirePrivateNavigation;
        acceptedAddress = url;
        if (replace) history.replaceState(navigationState, "", url + (paths.legacy(location.hash) ? "" : location.hash));
        else history.pushState(navigationState, "", url);
    }
    function navigate(next, replace = false, options = {}) {
        namedDrafts.close();
        namedDrafts.dismissNotice();
        if (appUpdate?.locked()) return false;
        if (clearingAccess || !api.publicationToken()) return false;
        next = canonicalRoute(next);
        if (!options.restorePosition && browseName(workspaceState.route) === "analyze" && browseName(next) === "analyze")
            next = filterState.reconcileTimeline(workspaceState.route, next);
        if (!next.search) incomingNavigationError = null;
        if (options.isCurrent && !options.isCurrent()) {
            announce("This Search destination is no longer current. Search again before opening it.", "stale");
            return false;
        }
        if (exportWriting || collectionSettings?.isBusy()) {
            announce("Wait for the current local save to finish before leaving this view.", "pending-save");
            return false;
        }
        if (next.view === "request" && !options.fromSearch) {
            searchOpenedRequest = null;
            searchReturnMarker = null;
        }
        if (next.view === "request" && options.fromSearch) next = { ...next, bookmark: undefined, searchOwned: true };
        else if (next.view === "request" && !next.bookmark) next = { ...next,
            bookmark: routeAddress(next, Boolean(next.search?.trim() || (next.analysisQuery ?? semanticQuery) != null)).bookmark };
        if (next.view === "request" && workspaceState.route.view !== "request") {
            ownSidebarHistory(true);
            next = { ...next, returnToResults: sessionJourney.returnRoute({ ...workspaceState.route, search }, true), sidebarEntry: sidebarHistoryKey };
        }
        if (next.view === "request" && workspaceState.route.view === "request") {
            replace = true;
            // A sibling card can still have the link it rendered before the reader opened.
            if (!next.returnToResults && !options.fromSearch && workspaceState.route.returnToResults)
                next = { ...next, returnToResults: workspaceState.route.returnToResults };
        }
        const originPosition = historyPosition;
        rememberRoute(next, replace, options.generalShortcut);
        return applyRoute(next, { ...options, originPosition });
    }
    function link(label, view, changes = {}, cls = "") {
        const node = el("a", cls, label);
        const publication = api.publicationToken();
        setRouteLink(node, routeFor(view, changes), Boolean(search.trim() || semanticQuery !== null));
        node.addEventListener("click", (event) => {
            if (!api.isCurrent(publication)) { event.preventDefault(); return; }
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            go(view, changes);
        });
        return node;
    }
    function routeLink(label, next, cls = "text-link", options = {}) {
        const node = el("a", cls, label);
        const publication = api.publicationToken();
        setRouteLink(node, next, Boolean(next.search?.trim() || (next.analysisQuery ?? semanticQuery) != null));
        node.addEventListener("click", event => {
            if (!api.isCurrent(publication)) { event.preventDefault(); return; }
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (next.session) presentation.setOpen("session:" + next.session, true);
            const pending = navigate(next, false, { restorePosition: next.view === "collection-status" && workspaceState.route.view === "analyze" && Boolean(workspaceState.route.session), ...options });
            if (options.searchReturn) {
                const intent = workspaceState.captureIntent(publication);
                Promise.resolve(pending).then(loaded => {
                    if (loaded && workspaceState.intentCurrent(intent) && !liveSearchUI.restore(options.searchReturn)) {
                        announce("The earlier search is no longer available. Search again to see current results.", "stale");
                    }
                });
            }
        });
        return node;
    }
    function sessionsRoute() {
        return sessionJourney.returnRoute(workspaceState.route.returnToSessions) || routeFor("analyze", { session: undefined, page: undefined, returnToSessions: undefined });
    }
    function sessionRoute(sessionId, result) {
        return { ...filterState.scope(workspaceState.route, sessionJourney.open(workspaceState.route, sessionId, result)), search,
            returnToSessions: sessionJourney.returnRoute({ ...workspaceState.route, search }) };
    }
    function sessionSource(sessionId = workspaceState.route.session || workspaceState.evidence?.scenarios.find(s => s.scenarioId === workspaceState.route.request)?.sourceSessionId) {
        const source = workspaceState.evidence?.sessions?.find(s => s.sessionId === sessionId);
        if (source) return source;
        const scenario = workspaceState.evidence?.scenarios.find(s => s.sourceSessionId === sessionId);
        return sessionId ? { sessionId, name: scenario?.sourceSessionName || chatCopy.unnamed, projectId: scenario?.projectId, project: scenario?.project,
            missing: !scenario } : null;
    }
    function sourceReference(source, references) {
        if (!source) return null;
        return (references || chatCopy.references(workspaceState.evidence?.sessions, workspaceState.evidence?.scenarios))(source, workspaceState.scope.layer === "http");
    }
    function createSessionReport() {
        if (reportJourney?.snapshot().saveUnconfirmed) { announce(reportJourney.reason(1), "stale"); return; }
        const source = sessionSource(), requestIds = sessionJourney.reportIds(workspaceState.evidence?.exportCatalog, source?.sessionId);
        if (workspaceState.loading || workspaceState.stale || requestIds === null) { announce("Copilot chat report scope is unavailable. Refresh before selecting request groups.", "error"); return; }
        if (!requestIds.length) { announce("No eligible collected request groups are available for this Copilot chat. Check its collection coverage or choose another Copilot chat."); return; }
        selected.clear();
        periodReport = null; periodReportInvalid = false;
        for (const id of requestIds) selected.add(id);
        reportScope = "selected";
        reportBaseExplicit = true; reportDatesReplaced = false; reportDates = { range: "capture" };
        reportEntry = { scope: "selected", sessionId: source.sessionId, sessionName: source.name, projectId: source.projectId, projectName: source.project, requestIds, returnTo: { ...workspaceState.route, view: "activity", request: undefined } };
        draft.clearSelection();
        invalidatePreview();
        reportJourney?.clear();
        go("reports", { request: undefined, task: "create" });
    }
    function selectionRows() { return workspaceState.analytics?.rows || []; }
    function idsFor(row) { return Array.isArray(row?.scenarioIds) && row.scenarioIds.length ? row.scenarioIds : [row?.scenarioId]; }
    function rowsFor(scenarioId) {
        return selectionRows().filter(row => row.scenarioId === scenarioId);
    }
    function fullRowsFor(scenarioId, layer = workspaceState.scope.layer) {
        const rows = workspaceState.evidence.requestActivity?.[layer];
        return results.summarize(rows) ? rows.filter(row => idsFor(row).includes(scenarioId)) : undefined;
    }
    // Keep counted IDs in the existing publication-fenced private route, never its URL.
    function countedCallTarget(rows, target, outcome) {
        if (!["success", "failure"].includes(outcome)) return null;
        const ids = callInvestigation.countedIds(rows, target.request, outcome);
        if (!ids?.size) return null;
        if (outcome === "failure" && ids.size === 1) return { ...target, layer: "tool", call: [...ids][0] };
        return { ...target, [outcome === "failure" ? "failedCalls" : "completedCalls"]: {
            key: crypto.randomUUID(), revision: workspaceState.evidence.revision, ids: [...ids],
        } };
    }
    function currentOutcomeCalls(route) {
        const view = route.failedCalls ?? route.completedCalls;
        if (!view || view.revision !== workspaceState.evidence.revision || !Array.isArray(view.ids) || !view.ids.length) return null;
        const expected = new Set(view.ids);
        const rows = route.origin === "reports" ? fullRowsFor(route.request, "tool") : rowsFor(route.request);
        const actual = callInvestigation.countedIds(rows, route.request, route.failedCalls ? "failure" : "success");
        if (actual?.size !== expected.size || [...expected].some(id => !actual.has(id))) return null;
        return expected;
    }
    function sourceCallFor(row) {
        if (!row?.scenarioId) return null;
        const owners = workspaceState.evidence.scenarios.filter(item => item.scenarioId === row.scenarioId);
        if (owners.length !== 1) return null;
        const scenario = owners[0];
        if (nativeActivity.isNative(scenario)) return scenario.nativeConversation.calls.find(call => call.key === (row.parentCallId || row.id));
        return callInvestigation.sourceToolCall(scenario, row);
    }
    function callOutcomeLabel(outcome) {
        return ({ success: "completed", failure: "failed", unknown: "has no recorded result",
            partial: "partly completed", other: "has another result", transport: "could not connect" })[outcome];
    }
    function callReasonList(items, { inline = false } = {}) {
        const list = el(inline ? "span" : "ul", "call-reason-list");
        if (inline) list.setAttribute("role", "list");
        for (const item of items) {
            const reason = el(inline ? "span" : "li", "call-reason-item");
            if (item.interpretation) reason.dataset.interpretation = "true";
            if (inline) reason.setAttribute("role", "listitem");
            if (item.label) reason.append(el("span", "call-reason-label", item.label + ": "));
            reason.append(el("span", "call-reason-text", failureReasonText(item.text)));
            list.append(reason);
        }
        return list;
    }
    // Screen copy only; shared labels and failure-group identities stay unchanged.
    const failureReasonCopy = {
        "Work IQ could not find the requested MCP server": "Work IQ could not find the requested tool server",
        "Sign-in was required": "Work IQ required sign-in at the time",
        "Request timed out (MCP -32001)": "The tool did not respond in time (MCP -32001)",
        "Error text excluded for privacy": "Error details omitted for privacy",
        "Error text exceeded the saving limit": "Error details were too long to save",
        "Error format was not supported": "WIRE could not read the error details",
        "Error text was not saved": "WIRE did not save the error details",
        "The source did not supply a failure reason": "The tool did not provide an error reason",
    };
    function failureReasonText(reason) {
        return Object.hasOwn(failureReasonCopy, reason) ? failureReasonCopy[reason] : reason;
    }
    function callIssueText(text, recordedCause) {
        if (recordedCause && text === "BadRequest") return "The tool reported a bad request (BadRequest).";
        if (!recordedCause && text === "Failure reason was not saved") return "No failure reason was saved.";
        return failureReasonText(text);
    }
    function resultLine(layer, summary, { total, scope = "Recorded results", label, help: explanation, sessionId, heading, compactSingle = false, pillsOnly = false, singleRecord = false, recordLabel, rows, inline = false, includeReturned = true, omitCallKind } = {}) {
        const node = el(inline ? "span" : "div", "recorded-results");
        node.dataset.resultLayer = layer;
        node.setAttribute("role", "group");
        node.setAttribute("aria-label", scope);
        const entries = rows ? results.explainedEntries(layer, rows, sourceCallFor,
            { concise: singleRecord, contextual: singleRecord && Boolean(recordLabel), includeReturned }) : results.entries(layer, summary);
        if (!entries) {
            const unavailable = el("span", "result-unavailable");
            unavailable.append(metadata.item(`${label || results.unit(layer, 2)}: result counts unavailable`, explanation ? { help: explanation } : {}));
            node.append(unavailable);
            return node;
        }
        const compact = pillsOnly || compactSingle && summary.count === 1;
        const unit = el("strong", "result-unit");
        unit.append(metadata.item(label || results.countLabel(layer, summary.count, total), explanation ? { helpLabel: "recorded tool result", help: explanation } : {}));
        const values = heading && !compact ? el(inline ? "span" : "div", "result-values") : node;
        if (compact) {
            node.classList.add("result-inline");
            const described = rows && !singleRecord ? entries.map(entry => `${count(entry.count)} ${entry.label}${entry.reason ? ": " + failureReasonText(entry.reason) : ""}`).join("; ") : "";
            node.setAttribute("aria-label", `${heading || scope}: ${results.countLabel(layer, summary.count, total)}${described ? ". " + described : ""}`);
        } else if (heading) {
            node.classList.add("result-with-heading");
            const description = el(inline ? "span" : "div", "result-description");
            description.append(el("strong", "result-heading", heading), unit);
            node.append(description, values);
        } else node.append(unit);
        for (const entry of entries) {
            const actionable = sessionId && results.canInspect(layer, entry.key);
            const classes = `recorded-result ${entry.key} result-tone-${singleRecord && recordLabel ? entry.key : entry.tone ?? entry.key}`;
            const item = actionable ? routeLink("", sessionRoute(sessionId, entry.key), classes + " result-link") : el("span", classes);
            item.dataset.outcome = entry.key;
            item.dataset.count = entry.count;
            const execution = singleRecord && recordLabel && layer === "tool" && summary.count === 1 && results.countedExecution(entry.key, 1);
            if (execution) item.append(ux.cardOutcome(execution));
            else item.append(ux.icon(`${singleRecord && recordLabel ? results.icon(entry.key) : entry.icon}-compact`), el("span", "recorded-result-label",
                `${singleRecord && entry.count === 1 ? "" : count(entry.count) + " "}${singleRecord && summary.count === 1 && recordLabel ? recordLabel : entry.label}`));
            if (entry.reason) {
                item.classList.add("result-explained");
                const recital = item.lastElementChild;
                if (singleRecord && recordLabel) {
                    item.classList.add("result-story");
                    if (["failure", "partial", "transport"].includes(entry.tone ?? entry.key)) item.classList.add("result-story-problem");
                    const status = el("span", "result-status result-tone-" + entry.key);
                    status.append(...item.childNodes);
                    const call = sourceCallFor(rows[0]);
                    const reasons = callReasonList(results.callReasonItems(call, rows[0].outcome, { includeReturned, omitCallKind }), { inline: true });
                    if (rows[0].outcome === "failure") {
                        const first = reasons.querySelector(".call-reason-item:not([data-interpretation])");
                        if (first && !first.querySelector(".call-reason-label")) {
                            const text = first.querySelector(".call-reason-text"), cause = Boolean(results.recordedCallCause(call, true));
                            if (cause) first.prepend(el("strong", "", "Recorded reason:"), " ");
                            text.textContent = callIssueText(text.textContent, cause);
                            first.classList.add("reader-issue-note");
                        }
                    }
                    reasons.classList.add("result-cause");
                    item.append(status, reasons);
                    const coverage = includeReturned && results.returnedCoverage(sourceCallFor(rows[0]));
                    if (coverage) item.append(el("span", "returned-coverage", coverage.text));
                } else {
                    const words = el("span", "result-explanation");
                    words.append(el("span", "result-cause", failureReasonText(entry.reason)));
                    if (singleRecord && entry.reasonOnly) recital.remove();
                    else words.append(document.createTextNode(" \u00b7 "), recital);
                    item.append(words);
                }
            }
            if (actionable) {
                viewKey(item, `session-result:${scope}:${sessionId}:${layer}:${entry.key}`);
                const label = layer === "tool" ? `View ${count(entry.count)} Work IQ tool call${entry.count === 1 ? "" : "s"} ${entry.key === "success" ? "with recorded completion" : "needing attention"}` : `View ${count(entry.count)} ${results.unit(layer, entry.count)}: ${entry.label}`;
                item.setAttribute("aria-label", `${label} in ${layer === "http" ? "recorder source" : "chat"} ${sessionSource(sessionId)?.name}. Current date, service and request scope.`);
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
        const node = resultLine(workspaceState.scope.layer, matching, { total: full?.count ?? null, scope: "Matching results only", pillsOnly: compact });
        if (compact && full && matching && matching.count !== full.count) {
            node.prepend(el("span", "card-result-scope", `${count(matching.count)} of ${count(full.count)} ${results.unit(workspaceState.scope.layer, full.count)} in this view`));
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
    function recordedPathValue(path, missing = "Not recorded") {
        if (path === null) return el("span", "muted", missing);
        const code = el("code", "api-path"), parts = path.split(/(?<=[/?&=])/u);
        parts.forEach((part, index) => {
            code.append(document.createTextNode(part));
            if (index < parts.length - 1) code.append(el("wbr"));
        });
        return code;
    }
    function pathField(list, label, path, missing = "Not recorded") {
        const value = el("dd", "api-path-value");
        value.append(recordedPathValue(path, missing));
        list.append(el("dt", "api-path-label", label), value);
    }
    function actionFields(call, row, { includeTool = true, includeService = true, includePurpose = true, includeMissing = true, returned = false, sharedBatchGap = false } = {}) {
        const list = el("dl", "action-fields");
        const operation = !returned ? categories.operation(call?.tool || row?.tool) : null;
        const discovery = operation?.category === "Discovery";
        const path = returned ? results.returnedPath(call, row, { discovery: categories.operation(call?.tool)?.category === "Discovery" }) : null;
        const returnedAssociation = returned && row?.serviceAssociation?.layer === "reported-api" ? row.serviceAssociation : null;
        const unassignedBatch = includeService && path?.source === "unattributed" && returnedAssociation?.services.length === 0
            && returnedAssociation.gaps.length === 1 && returnedAssociation.gaps[0].reason === "unattributed-result";
        if (includeTool) list.append(el("dt", "", "Tool"), el("dd", "action-tool", call?.tool || row?.tool || "Not recorded"));
        if (includeService && !sharedBatchGap) {
            const service = el("dd", "action-service");
            let serviceContext;
            if (unassignedBatch) {
                service.append(metadata.item("No path returned for this batch entry.", {
                    helpLabel: "batch target", help: "The entry's position does not identify a requested target. Its recorded status still counts.",
                }));
                service.classList.add("returned-target-help");
            } else if (returned) {
                const association = returnedAssociation;
                for (const [index, name] of (association?.services ?? []).entries()) {
                    if (index) service.append(document.createTextNode(", "));
                    service.append(serviceCue("span", name));
                }
                for (const rawGap of association?.gaps ?? []) {
                    const gap = categories.displayEvidence(rawGap);
                    service.append(metadata.item(gap.label, { help: gap.description }));
                }
                if (includePurpose && association?.gaps.length) serviceContext = categories.attributionReading(row, "reported-api").text;
                if (!service.childNodes.length) service.textContent = "Service evidence could not be read in this snapshot.";
            } else {
                const scope = categories.requestedSearchScope(call);
                const identity = serviceIdentity(row ? [{ ...row, tool: call?.tool || row.tool }] : undefined, "tool");
                service.append(identity);
                if (scope) service.append(ux.helpButton(categoryPresentation(row).label, [scope.label + ".", scope.description].filter(Boolean).join(" ")));
            }
            list.append(el("dt", "", unassignedBatch ? "Returned target" : returned ? "Result service" : "Services and operations"), service);
            if (serviceContext) list.append(el("dt", "visually-hidden", "Service context"), el("dd", "action-attribution", serviceContext));
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
            if (!sharedBatchGap && !unassignedBatch) pathField(list, "API path", path.path, path.source === "unattributed" ? "Not attributed to a target in this batch" : "Not recorded");
            if (path.source === "call") {
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
        const timing = requestTiming.response(scenario.scenarioId, workspaceState.evidence.assessment);
        const value = el("span"), field = cardFact("Final response", value);
        field.classList.add("response-timing");
        field.hidden = timing.status === "unavailable";
        if (timing.status === "measured") {
            value.append(durationValue(timing.durationMs));
        } else if (timing.status === "error") {
            const error = el("span", "action-error", "Timing could not be read");
            error.setAttribute("role", "alert");
            value.append(error);
        } else value.textContent = "Not recorded";
        return field;
    }
    function field(label, value) {
        const node = cardFact(label, value ?? "Not recorded");
        node.firstElementChild.textContent = label;
        return node;
    }
    function fields(pairs) {
        const node = el("dl", "reader-fields");
        for (const [label, value] of pairs) if (value !== undefined && value !== null && value !== "") node.append(field(label, value));
        return node;
    }
    function resultDetailBlock(rows, { errorContext = false } = {}) {
        if (!rows.length) return null;
        const node = el("div", "reader-error-details");
        for (const [label, value] of rows) {
            if (["Recorded error", "Error detail", "Source description"].includes(label)) {
                if (!errorContext || label === "Source description") node.append(el("p", "context-help-note", label));
                node.append(el("p", "reader-error-message", value));
            } else node.append(fields([[label, value]]));
        }
        return node;
    }
    function failureDiagnostic(diagnostic, options) {
        return resultDetailBlock(results.diagnosticDetails(diagnostic, options), { errorContext: true });
    }
    function returnedDetails(call, row, apiRows, selectedId) {
        if (!apiRows?.length) return null;
        const ordered = apiRows.map(entry => {
            const retained = results.returnedResult(call, entry);
            return { entry, retained, offset: retained ? call.apiResults.indexOf(retained) : Infinity };
        }).sort((a,b) => a.offset - b.offset);
        const sharedBatchGap = ordered.length > 1 && ordered.every(({entry, retained}) => retained
            && results.returnedPath(call, entry, {discovery:categories.operation(call.tool)?.category === "Discovery"}).source === "unattributed"
            && entry.serviceAssociation?.layer === "reported-api" && !entry.serviceAssociation.services.length
            && entry.serviceAssociation.gaps.length === 1 && entry.serviceAssociation.gaps[0].reason === "unattributed-result");
        const sharedDurationGap = ordered.length > 1 && ordered.every(({retained}) => callInvestigation.duration(retained, "reported-api") === null);
        const renderEntry = ({entry, retained}) => {
            const item = viewKey(el("div", "api-result-entry"), "returned:" + entry.id);
            item.dataset.resultId = entry.id;
            const parent = el("p", "returned-call-parent", `${call.tool ?? "Tool not recorded"} · ${results.labels("tool")[row.outcome] ?? "Outcome unavailable"}`);
            const code = retained?.errorCode;
            const status = entry.status != null ? `Tool-reported HTTP ${entry.status}` : code ? "Tool-reported error" : null;
            const recordLabel = (retained ? results.returnedEntryLabel(call, retained) + ": " : "")
                + (["partial", "unknown"].includes(entry.outcome)
                ? results.labels("reported-api")[entry.outcome] + (status ? ": " + status : "")
                : status || results.labels("reported-api")[entry.outcome]) + (code ? ": " + code : "");
            const diagnostic = failureDiagnostic(retained?.errorDiagnostic, {
                codeShown: code === retained?.errorDiagnostic?.code,
                statusShown: entry.status === retained?.errorDiagnostic?.statusCode,
            });
            item.append(parent, resultLine("reported-api", results.summarize([entry]), {
                heading: "Returned API result", compactSingle: true, singleRecord: true, recordLabel }));
            if (diagnostic) {
                const message = diagnostic.querySelector(".reader-error-message");
                const cue = message && results.entryCue(retained.errorDiagnostic, retained.errorDiagnostic?.code ?? code, retained.errorDiagnostic?.code ?? code);
                if (cue && cue !== message.textContent) {
                    item.append(el("p", "reader-entry-problem", cue));
                    const exact = el("details", "reader-diagnostic");
                    exact.append(el("summary", "", "Full diagnostic"), diagnostic);
                    if (selectedId === entry.id && searchOpenedRequest === workspaceState.route.request) exact.open = true;
                    item.append(exact);
                } else item.append(diagnostic);
            }
            const interpretation = results.interpretation({apiResults:retained ? [retained] : []}, row.outcome);
            const explanation = results.interpretationItems({ ...interpretation,
                items: interpretation.items.filter(value => value.channel === "returned-entry") });
            if (explanation.length) item.append(callReasonList(explanation));
            const facts = actionFields(call, entry, { includeTool: false, returned: true, sharedBatchGap, includeService: !results.inheritsCallService(call, entry, row) });
            if (!sharedDurationGap) {
                const duration = el("dd", "reader-api-duration");
                duration.append(durationValue(callInvestigation.duration(retained, "reported-api"), true));
                facts.append(el("dt", "", "Entry duration"), duration);
            }
            if (retained?.evidenceLevel && !(status?.startsWith("Tool-reported") && retained.evidenceLevel === "intermediary-reported")) facts.append(el("dt", "", "Result attribution"), el("dd", "",
                retained.evidenceLevel === "intermediary-reported" ? "Reported by the tool" : retained.evidenceLevel));
            if (facts.childElementCount) item.append(facts);
            if (entry.id === selectedId) {
                item.id = "selectedCall";
                item.tabIndex = -1;
                item.setAttribute("aria-current", "true");
                actionContext(item, [entry]);
            }
            return item;
        };
        const list = el("div", "returned-api-entries"), pages = el("div", "returned-entries-pages");
        list.append(el("h4", "returned-entries-heading", `${count(ordered.length)} returned ${ordered.length === 1 ? "entry" : "entries"}`), pages);
        const hasErrors = ordered.some(({entry, retained}) => ["failure","transport"].includes(entry.outcome)
            || retained?.errorCode || results.diagnosticDetails(retained?.errorDiagnostic).length);
        const size = hasErrors ? Math.max(6, ordered.length) : 6, key = "returned:" + row.id;
        if (selectedId) {
            const selected = ordered.findIndex(({entry}) => entry.id === selectedId);
            if (selected >= 0) presentation.setPage(key, Math.floor(selected / size));
        }
        pagedList(pages, ordered, {
            key, noun: call.resultEvidence?.contentStatus === "partial"
                ? "retained entries" : "returned results",
            size,
            hideSinglePage: true,
            renderItem: renderEntry,
        });
        const coverage = results.returnedCoverage(call);
        if (coverage) list.prepend(el("p", "returned-coverage", coverage.text));
        if (sharedBatchGap || sharedDurationGap) list.append(el("p", "reader-batch-gap", sharedBatchGap && sharedDurationGap
            ? "No per-entry paths or durations were recorded for this batch."
            : sharedBatchGap ? "No per-entry paths were recorded for this batch." : "No per-entry durations were recorded for this batch."));
        return list;
    }
    function actionContext(item, rows) {
        const matching = rows?.filter(row => rowsFor(workspaceState.route.request).some(match => match.id === row.id)).length;
        item.append(el("p", "action-context", !rows ? "Matching context unavailable" : matching ? `${matching} matching ${results.unit(workspaceState.scope.layer, matching)} in current view` : "Outside current view"));
        if (rows?.some(row => workspaceState.analytics.serviceInvolvement?.selection.contextOnlyIds.includes(row.id))) {
            item.append(el("p", "service-context-label", "Includes missing-service context, not a known match to the selected service."));
        }
    }
    function query(value = workspaceState.route) {
        if (sessionJourney.underlying(value).view === "trends") return {
            layer: "tool", groupBy: "workload", bucket: "month", filters: { scope: "all", sources: ["github-copilot"] }, limit: 8, timeContext: viewerTime,
        };
        return { layer: value.layer || "tool", groupBy: value.chart === "endpoint" ? "endpoint" : "workload", bucket: filterState.bucket(value),
            ...(value.timelineFrom && value.compare !== "periods" ? { timelineFrom: value.timelineFrom } : {}),
            filters: filterState.query(value), limit: 8, timeContext: viewerTime };
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
                || byId.get(row.scenarioId)?.recordKind !== "native-conversation"
                    && row.promptAuthor !== authorship.read(byId.get(row.scenarioId)?.userPrompt).actor)) {
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
    function validateBoundedSnapshot(snapshot, config) {
        const native = snapshot.nativeRead;
        if (!native || native.revision !== snapshot.revision || JSON.stringify(snapshot.analytics?.native) !== JSON.stringify(native)) {
            throw new Error("The Microsoft aggregate and page do not match this snapshot.");
        }
        if (snapshot.scenarios?.some(record => nativeActivity.isNative(record))
            || snapshot.analytics?.rows?.some(row => boundedContract.sourceIds.includes(row.sourceId))) {
            throw new Error("The bounded Microsoft population cannot be replaced by legacy native arrays.");
        }
        if (native.status === "unavailable") {
            const fields = native.reason === "microsoft-account-not-configured"
                ? ["status", "reason", "revision", "generation", "authorizationRevision"] : ["status", "reason", "revision"];
            if (Object.keys(native).length !== fields.length || fields.some(key => !Object.hasOwn(native, key))
                || !["microsoft-account-not-configured", "native-retention-not-configured", "native-retained-source-not-committed"].includes(native.reason)) {
                throw new Error("The unavailable Microsoft view is invalid; no zero population was inferred.");
            }
            const metadata = nativeCollectionStatus(snapshot.collection);
            if (native.reason === "microsoft-account-not-configured") {
                const unavailable = historyStatus.nativeUnavailable(metadata);
                if (!unavailable || !historyStatus.nativeUnavailableCurrent(metadata, api.accessState().state)
                    || native.generation !== unavailable.generation || native.authorizationRevision !== unavailable.authorizationRevision) {
                    throw new Error("Microsoft setup metadata changed during the bounded snapshot.");
                }
            } else {
                const saved = historyStatus.persistence(metadata);
                if (!saved || (native.reason === "native-retention-not-configured") !== !saved.configured) {
                    throw new Error("Microsoft availability does not match its current configuration.");
                }
            }
            return;
        }
        const { status, ...value } = native;
        if (status !== "bounded") throw new Error("The source-aware Microsoft view must use the bounded public protocol.");
        boundedContract.decode(value, { schemaVersion: 1, revision: snapshot.revision, sources: boundedContract.sourceIds,
            analytics: config, page: { limit: config.limit ?? 10, after: null } });
        const current = value.readback.current;
        const saved = historyStatus.persistence(nativeCollectionStatus(snapshot.collection));
        if (!saved || current.generation !== api.accessState().state?.generation
            || current.configurationRevision !== (saved.configuration?.configurationRevision ?? null)
            || current.privacyRevision !== (saved.configuration?.privacyRevision ?? null)) {
            throw new Error("The bounded Microsoft view does not match current collection settings.");
        }
    }
    function syncSavedReportPresence(currentRead) {
        const entries = workspaceState.evidence.exports || [];
        savedArtifactUI?.observeEligibility();
        reportJourney?.syncPresence(entries);
        if (!currentRead()) return false;
        if (savedReportView && !entries.some(entry => savedIdentity(entry) === savedReportView.identity)) {
            invalidateSavedReader("This saved item changed or is no longer available. Return to the library and refresh saved reports.");
        }
        return true;
    }
    async function load({ background = false, afterExport = false, refinement = false, expectedSource, refreshOwner } = {}) {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return false;
        if (exportWriting && !afterExport) {
            announce("The confirmed local save is still running. This view will refresh when it finishes; the write is not replayed.");
            return false;
        }
        const previousStale = workspaceState.stale;
        const request = workspaceState.beginRead(publication);
        if (request === null) return false;
        const currentRead = () => workspaceState.readCurrent(request, publication) && !pageInactive;
        const recollectionReceipt = recollectionUI?.snapshot().result?.operationId;
        if (!background || fresh.snapshot().phase === "waiting") fresh.retryApply();
        syncTime();
        const config = query();
        savedInspector?.refreshEligibility?.();
        if (sourceCollection.active && (JSON.stringify(config) !== JSON.stringify(workspaceState.scope) || boundedNative.presentation().error)) {
            boundedNative.invalidate("Updating the complete Microsoft source selection...");
            liveSearchUI?.changed();
        }
        refreshChartReference();
        $("deleteAllReports").disabled = true;
        syncResultFilter();
        syncAuthorFilter();
        renderTimeContext();
        if (!background) {
            if (!workspaceState.analytics) setText($("periodResult"), "Updating this period...");
            $("periodResult").setAttribute("aria-busy", "true");
            for (const id of ["pageAction", "reportContextAction"]) $(id).setAttribute("aria-disabled", "true");
        }
        ux.pending($("loadingStatus"), true);
        ux.pending($("periodResult"), true);
        ux.pending($("refreshBtn"), true);
        updateSelection();
        renderTimeContext();
        $("refreshBtn").disabled = true;
        renderFreshActivity();
        $("workspace").setAttribute("aria-busy", "true");
        if (workspaceState.analytics && !background && !refinement) announce("Updating this view...");
        const refreshRead = background && !afterExport ? fresh.snapshot() : null;
        try {
            if (incomingNavigationError) throw new Error(incomingNavigationError);
            const next = await api("/api/snapshot", config);
            if (!api.isCurrent(publication) || request !== workspaceState.readGeneration || pageInactive) return false;
            if (refreshOwner && (!refreshGestureCurrent(refreshOwner) || refreshViewHeld())) {
                workspaceState.stale = previousStale;
                if (refreshGestureCurrent(refreshOwner)) deferRefreshView(refreshOwner);
                return false;
            }
            acceptSourceCollection(next.collection);
            if (sourceCollection.active) validateBoundedSnapshot(next, config);
            if (sourceCollection.active && workspaceState.route.nativeGroup !== undefined) {
                if (!/^[a-f0-9]{64}$/.test(workspaceState.route.nativeGroup) || next.nativeRead?.status !== "bounded") {
                    throw new Error("The original Microsoft group is unavailable. Clear the group or read its current source view.");
                }
                const groupRequest = { schemaVersion: 1, revision: next.revision, viewId: next.nativeRead.viewId,
                    groupId: workspaceState.route.nativeGroup, page: { limit: config.limit ?? 10, after: null } };
                const context = { sources: [...boundedContract.sourceIds], analytics: config, original: next.nativeRead };
                const grouped = await api("/api/retained/microsoft/drilldown", groupRequest);
                if (!currentRead()) return false;
                boundedContract.decode(grouped, groupRequest, context);
                next.nativeGroupBinding = { request: groupRequest, context };
                next.nativeRead = { status: "bounded", ...grouped };
                next.analytics.native = next.nativeRead;
            }
            const currentNative = nativeCollectionStatus(next.collection), previousNative = nativeCollectionStatus(collection);
            const nativeStatus = historyStatus.persistence(currentNative);
            const nativeUnavailable = historyStatus.nativeUnavailable(currentNative);
            if (!sourceCollection.active && (nativeUnavailable || next.nativeRead?.status === "unavailable")) {
                if (!historyStatus.nativeUnavailableCurrent(currentNative, api.accessState().state, previousNative)
                    || !historyStatus.nativeUnavailableMatches(next, currentNative)) {
                    throw new Error("Microsoft account setup status changed. Read current Settings and stored activity; no collection was repeated.");
                }
            }
            if (nativeStatus && !sourceCollection.active) {
                if (nativeStatus.generation !== api.accessState().state?.generation
                    || !historyStatus.nativeReadbackCurrent(next, currentNative)) {
                    throw new Error("Saved Microsoft activity does not match current access and collection settings. Read current status and stored activity; collection will not be repeated.");
                }
                const currentNativeStatus = historyStatus.persistence(previousNative);
                if (currentNativeStatus?.accountRef === nativeStatus.accountRef
                    && currentNativeStatus.generation === nativeStatus.generation
                    && currentNativeStatus.revision > nativeStatus.revision) {
                    throw new Error("The Microsoft snapshot is older than the current collection status. Retry the stored read; collection will not be repeated.");
                }
            }
            const result = next.analytics;
            if (timeChanged()) return load({ background, afterExport, refinement, expectedSource, refreshOwner });
            if (!Array.isArray(next.scenarios)) throw new Error("Recorded requests are unavailable.");
            if (result?.revision !== undefined && result.revision !== next.revision) throw new Error("Activity changed during the read. Try again.");
            if (result?.timeContext && JSON.stringify(result.timeContext) !== JSON.stringify(config.timeContext)) throw new Error("The runtime used a different timezone. Retry the stored-data read before continuing.");
            const validated = validateAnalytics(result, next.scenarios);
            for (const layer of results.layers) {
                const rows = next.requestActivity?.[layer];
                if (rows !== undefined && (!Array.isArray(rows) || rows.some(row => typeof row?.id !== "string" || !row.id))) {
                    throw new Error("Recorded activity details could not be read.");
                }
            }
            if (incomingNavigation && (incomingNavigation.revision !== next.revision
                || incomingNavigation.nativeRevision !== next.nativeRead?.revision
                || incomingNavigation.sourceVersion !== next.collection?.configVersion
                || incomingNavigation.deletionVersion !== next.deletionVersion
                || JSON.stringify(incomingNavigation.timeContext) !== JSON.stringify(config.timeContext))) {
                incomingNavigation = null; semanticQuery = "";
                incomingNavigationError = "The selected records changed. Return to the original tab and open the current result again.";
                throw new Error(incomingNavigationError);
            }
            if (incomingNavigation?.analysisQuery && !liveSearchUI.canPrepareAnalysis(incomingNavigation.analysisQuery)) {
                incomingNavigation = null; semanticQuery = "";
                incomingNavigationError = "Search changed while the private view was opening. Your newer Search was kept.";
                throw new Error(incomingNavigationError);
            }
            if (workspaceState.route.withinServices) analysisSlice(next, config, search, workspaceState.route.withinServices.split(","));
            const checking = fresh.snapshot();
            if (expectedSource !== undefined && next.collection?.configVersion !== expectedSource) throw new Error("The approved source changed during the stored read. Retry current status and stored activity; no source check was repeated.");
            if (checking.phase === "applying" && checking.check && next.revision < checking.check.revision) throw new Error("The view read is older than the completed local check. Retry the stored read; no collection was repeated.");
            if (checking.phase === "applying" && checking.check && next.collection?.configVersion !== checking.check.configVersion) throw new Error("The approved source changed during this check. Review the current connection before checking again.");
            if (workspaceState.evidence && next.revision < workspaceState.evidence.revision) throw new Error("An older snapshot was rejected. The current view is kept.");
            if (next.sessionAnalysis && (next.sessionAnalysis.revision !== next.revision || !results.valid(next.sessionAnalysis.totals))) throw new Error("Source analysis does not match this snapshot. Retry the stored-data read before continuing.");
            const reading = captureReading(next);
            if (!currentRead()) return false;
            if (workspaceState.evidence && (workspaceState.evidence.revision !== next.revision || workspaceState.evidence.nativeRead?.revision !== next.nativeRead?.revision || workspaceState.evidence.deletionVersion !== next.deletionVersion
                || workspaceState.evidence.collection?.configVersion !== next.collection?.configVersion)) {
                for (const key of privateNavigations.keys()) forgetPrivateNavigation(key);
                // A transfer is consent for this accepted snapshot, not a later revision.
                if (workspaceState.evidence.revision !== next.revision || workspaceState.evidence.deletionVersion !== next.deletionVersion
                    || workspaceState.evidence.collection?.configVersion !== next.collection?.configVersion) trendEntries.clear();
            }
            if (workspaceState.evidence && (workspaceState.evidence.deletionVersion !== next.deletionVersion
                || workspaceState.evidence.collection?.configVersion !== next.collection?.configVersion)) historyViews.clear();
            if (workspaceState.evidence && (next.deletionVersion ?? 0) !== (workspaceState.evidence.deletionVersion ?? 0)) clearDeletedDraft();
            if (!currentRead()) return false;
            if (sourceCollection.active) {
                if (next.nativeRead?.status === "bounded") boundedNative.observeReaderAuthority(next.nativeRead);
                observeNativeReaderStatus(next.collection);
            }
            acceptingSnapshot = next;
            try { assessmentUI.receive(next.assessment); }
            finally { acceptingSnapshot = null; }
            if (workspaceState.evidence && JSON.stringify((workspaceState.evidence.exports || []).map(item => [item.bundleId, item.manifestHash])) !== JSON.stringify((next.exports || []).map(item => [item.bundleId, item.manifestHash]))) savedArtifactUI?.invalidate();
            if (!currentRead()) return false;
            if (refreshOwner && (!refreshGestureCurrent(refreshOwner) || refreshViewHeld())) {
                workspaceState.stale = previousStale;
                if (refreshGestureCurrent(refreshOwner)) deferRefreshView(refreshOwner);
                return false;
            }
            const route = workspaceState.route;
            const acceptedRoute = route.view === "request" ? resolveBookmark({ ...route,
                bookmark: route.bookmark ?? routeAddress(route, Boolean(route.search?.trim() || semanticQuery != null), next).bookmark,
            }, next) : route;
            if (!workspaceState.acceptRead(request, publication, {
                evidence: next, analytics: validated, scope: config, route: acceptedRoute,
            })) return false;
            hiddenCards.bind(next);
            namedDrafts.accept(next.namedDrafts);
            syncNamedReport();
            if (acceptedRoute.view === "request") rememberRoute(acceptedRoute, true);
            nativePublication.snapshot(next.nativeReportPublication, nativePublicationContext(false));
            syncNativeSaveAvailability?.();
            requestInvalidated = false;
            if (!syncSavedReportPresence(currentRead)) return false;
            connectionNeedsSnapshot = false;
            const incomingAnalysisQuery = incomingNavigation?.analysisQuery;
            if (incomingNavigation) {
                if (incomingAnalysisQuery === null) {
                    semanticQuery = null;
                    const { wirePrivateNavigation, ...navigationState } = history.state;
                    history.replaceState(navigationState, "");
                } else semanticMembership = unavailableSearchMembership();
            }
            syncResultFilter();
            syncAuthorFilter();
            if (!currentRead()) return false;
            $("loading").hidden = true;
            $("accessShell").hidden = true;
            $("workspace").hidden = false;
            clearMessage();
            if (next.collection) renderCollection(next.collection, publication);
            else collectionUnavailable("Collection status unavailable from this connection. Reconnect to the maintained runtime.", "", publication);
            render();
            if (!currentRead()) return false;
            if (incomingNavigation?.namedDraft && workspaceState.route.view === "reports") revealAddedDraft(incomingNavigation.namedDraft);
            if (incomingAnalysisQuery) liveSearchUI.prepareAnalysis(incomingAnalysisQuery);
            incomingNavigation = null;
            if (nativeCollectIntent) {
                if (nativeIntentCurrent() && nativeCollectIntent.confirmed
                    && fresh.snapshot().nativeReceipt
                    && !receiptStatus.nativeReadbackMatches(fresh.snapshot().nativeReceipt, next, nativeCollectionStatus(collection))) {
                    fresh.retireNativeResult();
                    nativeCollectIntent = null;
                } else if (nativeIntentCurrent() && fresh.nativeApplied(next, nativeCollectionStatus(collection))) {
                    nativeCollectIntent.confirmed = true;
                    clearSourceCheckMarker();
                }
            } else fresh.applied(workspaceState.evidence.revision, next.collection?.configVersion, workspaceState.analytics.rows);
            syncRefreshBranches(next);
            recollectionUI?.viewApplied(recollectionReceipt);
            renderFreshActivity();
            restoreReading(reading);
            if (!mounted) revealSessionResult();
            showDeferredDataNotice(false);
            mounted = true;
            if (next.collection) { clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 5000); }
            return true;
        } catch (error) {
            if (!api.isCurrent(publication) || request !== workspaceState.readGeneration || pageInactive) return false;
            liveSearchUI?.invalidate("The stored view could not be verified. Search results were cleared.");
            assessmentUI.clearPrivateText();
            workspaceState.failRead(request, publication);
            if (sourceCollection.active) boundedNative.invalidate("The current Microsoft selection could not be verified. Read current activity.");
            refreshChartReference();
            if (sourceCollection.active || error.reason === "runtime_unavailable") collectionUnavailable(error.message, error.reason, publication);
            if (fresh.snapshot().phase === "applying") fresh.fail(fresh.snapshot().token, error.message, { reason: error.reason });
            refreshReadFailure = workspaceState.analytics && refreshRead?.phase === "applying"
                ? { generation: request, token: refreshRead.token, checkId: refreshRead.check?.id } : null;
            renderFreshActivity();
            $("loading").hidden = true;
            const offline = error.reason === "runtime_unavailable";
            if (!refreshOwnsReadFailure()) {
                announce(incomingNavigationError && error.message === incomingNavigationError ? incomingNavigationError : offline
                    ? (workspaceState.analytics ? "Local runtime unavailable. Showing the last recorded snapshot. " : "Your activity could not load. ")
                        + "Start WIRE if it is stopped, then retry."
                    : (workspaceState.analytics ? "This view could not update. The last recorded snapshot is shown. " : "Your activity could not load. ") + error.message,
                workspaceState.analytics ? "stale" : "error", !incomingNavigationError);
                if (offline) $("message").dataset.connectionFailure = "true";
                if (error.reason === "wire_access_global_collection_stale" && $("storedViewRetry")) {
                    setText($("storedViewRetry"), "Read current settings");
                }
            }
            if (incomingNavigationError || incomingNavigation) {
                $("message").append(button("Open this view without the private selection", () => {
                    incomingNavigation = null; incomingNavigationError = null;
                    semanticQuery = null; semanticMembership = undefined; semanticComplete = semanticBound = false;
                    const { wirePrivateNavigation, ...navigationState } = history.state;
                    history.replaceState(navigationState, "");
                    const route = workspaceState.route;
                    navigate(route.view === "request" && !route.request ? { view: "analyze" }
                        : route.view === "reports" && (route.bundle || route.savedAuthority) ? { view: "reports" }
                        : route.view === "trends" ? { view: "trends", search: "", analysisQuery: null }
                        : { ...route, search: "", analysisQuery: null }, true);
                }, "quiet"));
            }
            renderCollectionNotice();
            if (workspaceState.analytics) {
                const reading = captureReading();
                workspaceState.route = { ...workspaceState.acceptedRoute, search };
                workspaceState.acceptedRoute = { ...workspaceState.route };
                rememberRoute(workspaceState.route, true);
                render();
                restoreReading(reading);
            }
            return false;
        } finally {
            if (api.isCurrent(publication) && request === workspaceState.readGeneration) {
                workspaceState.loading = false;
                savedInspector?.refreshEligibility?.();
                $("refreshBtn").disabled = false;
                $("workspace").setAttribute("aria-busy", "false");
                $("periodResult").removeAttribute("aria-busy");
                for (const id of ["pageAction", "reportContextAction"]) $(id).removeAttribute("aria-disabled");
                $("applyDates").removeAttribute("aria-disabled");
                ux.pending($("loadingStatus"), false);
                ux.pending($("periodResult"), false);
                ux.pending($("refreshBtn"), false);
                updateSelection();
                renderFreshActivity();
            }
        }
    }
    function applyRoute(next, { keepFocus = false, restorePosition = false, originPosition = historyPosition, reset = false, paging = null, reportSetup = false, cardTarget = null, revealReferenceRecords = false } = {}) {
        const publication = api.publicationToken();
        if (clearingAccess || !publication) { workspaceState.route = readRoute(); return false; }
        analyzeTrends.leave();
        if (next.view !== "analyze") analyzeControls.close(false);
        if (exportWriting || collectionSettings?.isBusy()) {
            rememberRoute(workspaceState.route, true);
            announce("Wait for the current local save to finish before leaving this view.", "pending-save");
            return false;
        }
        const pickerOrigin = reportPickerOrigin;
        reportPickerOrigin = workspaceState.route.view === "reports" && next.view === "request"
            ? reportExperience?.selectionReturn(keyed("report:" + next.request))
            : workspaceState.route.view === "request" && next.view === "request" && next.request === workspaceState.route.request ? pickerOrigin : null;
        if (workspaceState.route.view === "reports" && (next.view !== "reports" || next.task !== workspaceState.route.task || next.bundle !== workspaceState.route.bundle)) reportExperience?.closeOptions();
        // A new navigation can precede ResizeObserver delivery for the current motion frame.
        retainSidebarColumnAnchor();
        const navigation = workspaceState.beginNavigation();
        pendingChartReferenceReading = null;
        const intent = workspaceState.readingIntent;
        const recordsFocus = revealReferenceRecords && workspaceState.route.view === "request" ? document.activeElement : null;
        cardEntry = cardTarget && next.view === "request" && next.call === undefined && next.request === cardTarget.target.request
            ? { ...cardTarget, navigation, intent, pending: true } : null;
        if (sidebarExit) {
            if (next.view === "request" && sidebarExit.request
                || next.view === "reports" && next.inspect && !next.bundle && (!next.task || next.task === "library")
                    && sidebarExit.bundleId && workspaceState.evidence && !workspaceState.loading && !workspaceState.stale) clearSidebarExit();
            else finishSidebarMotion();
        }
        const previousRoute = workspaceState.route, clearingFilter = $("filterChips").contains(document.activeElement);
        // A section change is a reading action: keep the accepted population, a pending read, and any staged report choices.
        if (next.view === "analyze" && previousRoute.view === "analyze" && !next.compare && !previousRoute.compare
            && previousRoute.analyzeSection !== next.analyzeSection
            && readingKey({ ...previousRoute, analyzeSection: undefined }) === readingKey({ ...next, analyzeSection: undefined })
            && (next.analysisQuery ?? null) === (previousRoute.analysisQuery ?? null)) {
            if (workspaceState.acceptedRoute) workspaceState.positions.set(readingKey(previousRoute), captureReading());
            workspaceState.route = next;
            if (workspaceState.acceptedRoute) workspaceState.acceptedRoute = { ...workspaceState.acceptedRoute, analyzeSection: next.analyzeSection };
            refreshChartReference();
            const saved = workspaceState.positions.get(readingKey(next));
            if (revealReferenceRecords) revealResults();
            else if (saved) {
                restoreReading(saved);
                if (next.analyzeSection === "guide" && !restorePosition) $("openChartReference").focus({ preventScroll: true });
            }
            else if (!next.analyzeSection) $("analyzeResultsSection").focus({ preventScroll: true });
            return true;
        }
        const trendReturn = trendOrigin(sessionJourney.underlying(previousRoute));
        if (previousRoute.bookmark && !previousRoute.request) $("workspace").hidden = false;
        rememberBrowse();
        const leavingSaved = savedEntries.get(workspaceState.route.savedEntry);
        if (workspaceState.evidence && !workspaceState.loading && !workspaceState.stale && workspaceState.route.view === "reports" && next.view === "reports"
            && !workspaceState.route.bundle && !next.bundle && workspaceState.route.task === next.task && (!next.task || next.task === "library") && (workspaceState.route.inspect || next.inspect)
            && readingKey({ ...workspaceState.route, inspect: undefined }) === readingKey({ ...next, inspect: undefined })) {
            workspaceState.route = next; workspaceState.acceptedRoute = { ...workspaceState.route }; rememberRoute(workspaceState.route, true);
            if (next.inspect) renderSavedInspector();
            else closeSavedInspector(true);
            updateSavedRows();
            return true;
        }
        if (savedReportView && (next.bundle !== workspaceState.route.bundle || next.savedEntry !== workspaceState.route.savedEntry || next.view !== "reports")) clearSavedReader();
        if (savedInspector && (!next.inspect || next.view !== "reports" || next.bundle)) closeSavedInspector(false, true);
        let searchReturn = null, returnReading = null, comparisonReturn = null, pickerReturn = null, sidebarClosed = true, navigationFinished = false, recordsRevealed = false;
        function finishPickerReturn() {
            if (!pickerReturn || !sidebarClosed || !navigationFinished || !api.isCurrent(publication)
                || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent) return;
            pickerReturn();
            pickerReturn = null;
        }
        function finishRecordsReveal() {
            if (!revealReferenceRecords || recordsRevealed || !sidebarClosed || !navigationFinished
                || !api.isCurrent(publication) || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent || workspaceState.route.view !== "analyze"
                || recordsFocus && document.activeElement !== recordsFocus && document.activeElement !== document.body) return;
            recordsRevealed = true;
            if (semanticQuery !== null && !semanticBound) pendingChartReferenceReading = { navigation, intent, position: null };
            else revealResults();
        }
        function finishSearchReturn() {
            if (!searchReturn || !sidebarClosed || !navigationFinished || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent) return;
            const marker = searchReturn;
            searchReturn = null;
            if (!liveSearchUI.canRestore(marker)) return;
            restoreReading(returnReading);
            liveSearchUI.restore(marker);
        }
        function finishComparisonReturn() {
            if (!comparisonReturn || !sidebarClosed || !navigationFinished
                || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent) return;
            periodReturnReading = { position: comparisonReturn, navigation, intent };
            comparisonReturn = null;
            restorePeriodComparisonReading();
        }
        if (contextOwner?.identity === "report-setup" && next.view !== "request"
            && (next.view !== "reports" || next.task !== "create")) closeReportSetup({ restoreFocus: false });
        if (workspaceState.analytics && !workspaceState.loading && !workspaceState.stale && next.view === "request"
            && (workspaceState.route.view === "request" || readingKey(workspaceState.route) === readingKey(sessionJourney.underlying(next)))
            && JSON.stringify(workspaceState.scope) === JSON.stringify(query(next))) {
            if (workspaceState.route.view === "request" && requestIdentity(workspaceState.route) === requestIdentity(next)) {
                if (cardEntry?.focus) {
                    requestRenderKey = null;
                    renderRequest();
                    focusSidebar();
                    return true;
                }
                cardEntry = null;
                $("contextSidebarTitle").focus({ preventScroll: true }); return true;
            }
            if (workspaceState.route.view !== "request") workspaceState.positions.set(positionKey(workspaceState.route, originPosition), captureReading());
            else saveSidebarPosition();
            chartReferenceUI.leave();
            ux.hideTooltip(); selectControls?.close(); sidebar.close(false);
            assessmentUI.leave();
            workspaceState.route = next;
            rememberRoute(workspaceState.route, true);
            workspaceState.acceptedRoute = { ...workspaceState.route };
            refreshChartReference();
            showInteractionSidebar();
            renderRequest();
            focusSidebar();
            return true;
        }
        if (workspaceState.route.view === "request" && next.view !== "request") {
            const sameOrigin = readingKey(underlyingRoute()) === readingKey(next);
            const unchanged = sameOrigin && !workspaceState.loading && !workspaceState.stale && JSON.stringify(workspaceState.scope) === JSON.stringify(query(next));
            pickerReturn = unchanged && restorePosition && next.view === "reports" && !reportSetup && !requestInvalidated ? pickerOrigin : null;
            searchReturn = sameOrigin && !revealReferenceRecords && workspaceState.route.request === searchOpenedRequest && liveSearchUI.canRestore(searchReturnMarker) ? searchReturnMarker : null;
            returnReading = searchReturn ? workspaceState.positions.get(readingKey(underlyingRoute())) : null;
            // Same-scope comparison links return to their roster, not a hidden Activity card.
            comparisonReturn = unchanged && restorePosition && !searchReturn && next.view === "analyze" && next.compare === "periods"
                ? workspaceState.positions.get(readingKey(next)) : null;
            const cleanup = () => {
                assessmentUI.leave();
                clearReaderSections();
                requestRenderKey = null;
                $("requestContent").replaceChildren(); $("contextSidebarFooter").replaceChildren();
            };
            if (reportSetup && sameOrigin) {
                cleanup();
                restoreSidebarHistoryMode();
            } else {
                sidebarClosed = false;
                const retainPaint = unchanged && !requestInvalidated && !contextBody.querySelector("form[aria-busy=true]");
                if (retainPaint) {
                    assessmentUI.invalidatePendingViewReads();
                    contextSidebar.inert = true;
                    sidebarExit = { request: workspaceState.route.request, cleanup };
                    ux.hideTooltip(); selectControls?.close();
                }
                hideContextSidebar({ restoreFocus: unchanged && !searchReturn && !comparisonReturn && !pickerReturn && !revealReferenceRecords, preserveAnchor: !searchReturn && !pickerReturn,
                    onClosed: () => {
                        clearSidebarExit();
                        sidebarClosed = true;
                        finishSearchReturn();
                        finishComparisonReturn();
                        finishPickerReturn();
                        finishRecordsReveal();
                    } });
                if (!retainPaint) { cleanup(); finishSidebarMotion(); }
                if (reportSetupReturn) reportSetupReturn.peek = false;
            }
            if (unchanged) {
                workspaceState.route = canonicalRoute(next);
                workspaceState.acceptedRoute = { ...workspaceState.route };
                refreshChartReference();
                if (revealReferenceRecords) { renderNavigation(); updateSelection(); }
                if (reportSetup) reportJourney.go(2);
                if (workspaceState.route.view === "reports" && workspaceState.route.task === "create") syncReportSetupPresentation();
                navigationFinished = true;
                finishSearchReturn();
                finishComparisonReturn();
                finishPickerReturn();
                finishRecordsReveal();
                return true;
            }
        }
        const focusId = keepFocus ? document.activeElement?.id : null;
        if (workspaceState.route.view === "request" && next.view === "request") saveSidebarPosition();
        savedArtifactUI?.leave();
        if (workspaceState.acceptedRoute) workspaceState.positions.set(positionKey(workspaceState.acceptedRoute, originPosition), captureReading());
        chartReferenceUI.leave();
        ux.hideTooltip();
        selectControls?.close();
        sidebar.close(false);
        if ($("overlay").open) $("overlay").close();
        const before = JSON.stringify(workspaceState.scope ?? query());
        if (["range", "from", "to"].some(key => workspaceState.route[key] !== next[key])) {
            workspaceState.dateDraft = null; analyzeDatesPicker.close(false);
        }
        workspaceState.route = canonicalRoute(next);
        rememberRoute(workspaceState.route, true);
        if (workspaceState.route.view === "reports" && !workspaceState.route.bundle && !workspaceState.route.inspect && workspaceState.route.task !== "compare") {
            const journey = reportJourney?.snapshot();
            if (workspaceState.route.task !== "create" && journey && journey.step !== 1 && !journey.saveUnconfirmed) returnToReportOutline();
            else if (workspaceState.route.task === "create" && journey?.hasPreview && journey.step !== 3) reportJourney.go(3);
        }
        if (!workspaceState.evidence) showConnectionSettings(api.accessState());
        search = workspaceState.route.search || "";
        const analysisChanged = Object.hasOwn(workspaceState.route, "analysisQuery") && workspaceState.route.analysisQuery !== semanticQuery;
        if (analysisChanged) {
            switchingAnalysis = true;
            try { liveSearchUI.activateAnalysis(workspaceState.route.analysisQuery); }
            finally { switchingAnalysis = false; }
        }
        activityPage = Math.max(0, Number.parseInt(workspaceState.route.page || "0", 10) || 0);
        syncControls();
        $("resetView").hidden = workspaceState.route.view !== "analyze";
        $("resetView").disabled = !viewChanged();
        const queryChanged = analysisChanged || before !== JSON.stringify(query()) || workspaceState.route.nativeGroup !== previousRoute.nativeGroup;
        // Navigation is not report consent. Reconcile the exact report basis after a verified read.
        if (reportJourney?.snapshot().phase === "scanning" || $("reportReviewBody")?.querySelector('[data-review-control][data-pending=true]')) invalidatePreview();
        const refinement = !reset && !restorePosition && Boolean(workspaceState.analytics)
            && workspaceState.route.view === "analyze" && workspaceState.route.view === previousRoute.view
            && workspaceState.route.session === previousRoute.session && workspaceState.route.request === previousRoute.request
            && (queryChanged || workspaceState.route.range !== previousRoute.range || workspaceState.route.chart !== previousRoute.chart || workspaceState.route.withinServices !== previousRoute.withinServices);
        const controlsOnly = refinement && !queryChanged && workspaceState.route.chart === previousRoute.chart && workspaceState.route.withinServices === previousRoute.withinServices;
        if (refinement && clearingFilter) {
            const controls = { source: "sourceFilter", tool: "toolFilter", services: "serviceAssociationFilter", includeMissingService: "serviceAssociationFilter", withinServices: "serviceAssociationFilter", service: "serviceFilter",
                project: "projectFilter", session: "chatFilter", layer: "layerFilter", scope: "scopeFilter", result: "outcomeFilter", authors: "promptAuthorFilter", from: "dateFilter", to: "dateFilter" };
            const changed = Object.keys(controls).find(key => workspaceState.route[key] !== previousRoute[key]);
            const trigger = changed ? $(controls[changed] + "-control") : null;
            let target = trigger?.checkVisibility() ? trigger : trigger?.closest("#moreFilters") && $("moreFiltersToggle").checkVisibility()
                ? $("moreFiltersToggle") : $("openAnalyzeFilters");
            if (changed === "result" && trigger?.disabled) {
                target = $("resultFilterLabel");
                target.tabIndex = -1;
            }
            ux.restoreFocus(target);
            target?.scrollIntoView({ block: "nearest", inline: "nearest" });
        }
        if (!controlsOnly) assessmentUI.leave();
        let update = true;
        if (!workspaceState.analytics || queryChanged || workspaceState.loading) {
            if (workspaceState.analytics && (workspaceState.route.view !== previousRoute.view || workspaceState.route.compare !== previousRoute.compare)) {
                const destination = compareDestination(workspaceState.route) ? "compare" : workspaceState.route.view;
                const name = { analyze: "Analyze", trends: "Trends", compare: "Compare", reports: "Reports", settings: "Settings", help: "WIRE Help",
                    request: "Interaction", "collection-status": "Collection status" }[destination];
                const active = destination === "request" ? "analyze" : destination === "collection-status" ? "settings" : destination;
                for (const node of document.querySelectorAll("nav [data-nav]")) {
                    if (node.dataset.nav === active) node.setAttribute("aria-current", "page");
                    else node.removeAttribute("aria-current");
                }
                $("workspace").setAttribute("data-navigation-pending", "");
                $("navigationPending").hidden = false;
                setText($("navigationPending"), `Opening ${name}...`);
            }
            update = load({ refinement });
        }
        else {
            workspaceState.acceptedRoute = { ...workspaceState.route };
            if (controlsOnly) { renderNavigation(); renderFilterChips(); updateSelection(); }
            else render();
        }
        const position = workspaceState.positions.get(positionKey(workspaceState.route, historyPosition));
        periodReturnReading = restorePosition && workspaceState.route.view === "analyze" && workspaceState.route.compare === "periods" && position
            ? { position, navigation, intent } : null;
        const finishNavigation = (loaded = true) => {
            if (!loaded || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent) return;
            if (trendReturn && workspaceState.route.view === "analyze" && semanticQuery === trendReturn.origin.analysisQuery
                && readingKey(workspaceState.route) === readingKey(trendReturn.origin)) {
                restoreReading(trendReturn.reading);
                return;
            }
            if (revealReferenceRecords && workspaceState.route.view === "analyze") {
                navigationFinished = true;
                finishRecordsReveal();
                return;
            }
            if (refinement) return;
            if (workspaceState.route.bundle) { $("pageTitle").focus({ preventScroll: true }); window.scrollTo(0, 0); return; }
            if (workspaceState.route.inspect) {
                if (leavingSaved?.origin?.inspect === workspaceState.route.inspect) {
                    restoreReading(leavingSaved.reading);
                    contextBody.scrollTop = leavingSaved.inspectorTop || 0;
                    ux.restoreFocus(keyed(leavingSaved.focusKey) || savedInspector?.heading || $("contextSidebarTitle"));
                } else (savedInspector?.heading || $("contextSidebarTitle")).focus({ preventScroll: true });
                return;
            }
            if (leavingSaved?.origin && readingKey(next) === readingKey(leavingSaved.origin)) {
                restoreReading(leavingSaved.reading);
                if (leavingSaved.searchReturn && liveSearchUI.canRestore(leavingSaved.searchReturn)) {
                    cancelSidebarReading?.();
                    liveSearchUI.restore(leavingSaved.searchReturn);
                }
                else if (leavingSaved.focusKey) ux.restoreFocus(keyed(leavingSaved.focusKey));
                return;
            }
            if (searchReturn) { navigationFinished = true; finishSearchReturn(); return; }
            if (workspaceState.route.view === "request") {
                const reading = previousRoute.view === "reports" ? workspaceState.positions.get(readingKey(underlyingRoute())) ?? position : position;
                if (restorePosition && reading) restoreReading(reading);
                focusSidebar();
                return;
            }
            if (paging) { restorePager(paging); return; }
            if (workspaceState.route.view === "settings") {
                revealSetting();
                if (restorePosition && position && (!workspaceState.route.setting || position.focus?.key?.startsWith("settings-search:")
                    || $(position.focus?.id)?.hasAttribute("data-general-shortcut"))) restoreReading(position);
            }
            else if (workspaceState.route.view === "help" && !restorePosition) {
                const target = previousRoute.view === "help" ? $("help-" + (workspaceState.route.section || "reports")) : $("pageTitle");
                target?.focus();
            }
            else if (workspaceState.route.view === "collection-status") {
                revealCollectionStatus();
                if (restorePosition && position && !workspaceState.route.setting) restoreReading(position);
            }
            else if (keepFocus) ux.restoreFocus($(focusId));
            else if (position) restoreReading(position);
            else if (workspaceState.route.view === "analyze" && previousRoute.view === "analyze" && workspaceState.route.mode !== previousRoute.mode) revealResults();
            else if (mounted && !revealSessionResult()) { $("pageTitle").focus({ preventScroll: true }); window.scrollTo(0, 0); }
            if (reportSetup && workspaceState.route.view === "reports" && workspaceState.route.task === "create") reportJourney.go(2);
        };
        if (update instanceof Promise) update.then(finishNavigation);
        else finishNavigation();
        mounted = true;
        return update;
    }
    function syncControls() {
        restoring = true;
        const values = {
            layerFilter: workspaceState.route.layer || "tool", dateFilter: dateSelection().range, sourceFilter: workspaceState.route.source || "all",
            toolFilter: workspaceState.route.tool || "all", serviceAssociationFilter: workspaceState.route.services || "all", chatFilter: workspaceState.route.session || "all",
            serviceFilter: workspaceState.route.service || "all",
            projectFilter: workspaceState.route.project || "all", scopeFilter: workspaceState.route.scope || "history",
        };
        for (const [id, value] of Object.entries(values)) {
            const control = $(id);
            if (control.tagName === "SELECT" && ![...control.options].some((item) => item.value === value)) {
                control.append(option(value, id === "sourceFilter" ? "Source unavailable" : value));
            }
            control.value = value;
        }
        const dates = dateSelection(), from = dateInput(dates.from), to = dateInput(dates.to);
        const rangeLabel = from && to && from <= to ? time.formatCivilRange(from, to, viewerTime)
            : from && !to ? `From ${time.formatDate(from, viewerTime)}` : to && !from ? `Through ${time.formatDate(to, viewerTime)}`
            : $("dateFilter").selectedOptions[0]?.textContent || "All dates";
        analyzeDatesPicker.showRange(rangeLabel);
        analyzeDatesPicker.sync();
        $("activitySearch").value = search;
        restoring = false;
        syncResultFilter();
        syncAuthorFilter();
        selectControls?.sync();
    }
    function syncResultFilter() {
        if (!workspaceState.scope) return;
        const accepted = resultSelection(workspaceState.scope.filters.outcomes), requested = resultSelection(workspaceState.route.result);
        for (const option of $("outcomeFilter").options) option.selected = !accepted.length || accepted.includes(option.value);
        if (workspaceState.loading) $("outcomeFilter").dataset.pendingValue = JSON.stringify([...$("outcomeFilter").options]
            .filter(option => !requested.length || requested.includes(option.value)).map(option => option.value));
        else delete $("outcomeFilter").dataset.pendingValue;
        $("clearResultFilter").hidden = !workspaceState.loading || accepted.length > 0 || requested.length === 0;
        const scope = "Analyze";
        const text = workspaceState.scope.layer === "code-reference"
            ? "Result filtering is unavailable: execution is not observed." + (accepted.length ? " Clear the previous result filter to include references." : "")
            : `${scope}: ${resultNames(accepted)}${accepted.length ? " only" : ""}. Option counts are before result filtering.`;
        setText($("resultFilterScope"), text + (workspaceState.loading ? " Updating view..." : ""));
        $("resultSummary").dataset.unavailable = String(workspaceState.scope.layer === "code-reference");
        ux.pending($("resultFilterScope"), workspaceState.loading);
        $("resultSummary").setAttribute("aria-busy", String(workspaceState.loading));
    }
    function syncAuthorFilter() {
        if (!workspaceState.scope) return;
        const control = $("promptAuthorFilter"), accepted = authorship.selection(workspaceState.scope.filters.promptAuthors);
        const requested = authorship.selection(workspaceState.route.authors);
        for (const option of control.options) option.selected = accepted.includes(option.value);
        if (workspaceState.loading) control.dataset.pendingValue = JSON.stringify(requested);
        else delete control.dataset.pendingValue;
        $("clearPromptAuthorFilter").hidden = !workspaceState.loading || Boolean(authorship.filterValue(accepted)) || !authorship.filterValue(requested);
        $("promptAuthorSummary").setAttribute("aria-busy", String(workspaceState.loading));
        $("promptAuthorSummary").dataset.revision = String(workspaceState.evidence?.revision ?? "");
        setText($("promptAuthorFilterHelp"), `${authorship.selectionLabel(accepted)}. Calls stay with their originating prompt.${workspaceState.loading ? " Updating view..." : ""}`);
    }
    function viewChanged() {
        const defaults = { view: "analyze", chart: "time", range: "capture", layer: "tool", scope: "history", page: "0" };
        const presentation = ["localSearch", "settingsWarning", "bucket", "timelineFrom", "entryDefault",
            ...(workspaceState.route.compare === "periods" ? ["compare", "aFrom", "aTo", "bFrom", "bTo", "comparisonView", "chart"] : [])];
        return Object.entries(workspaceState.route).some(([key, value]) => !presentation.includes(key) && value !== undefined && value !== null && value !== "" && !(value === "all" && ["project", "service", "result"].includes(key)) && String(value) !== defaults[key]);
    }
    async function resetView() {
        const keepFocus = workspaceState.route.compare === "periods" && $("analyzeFilterDialog").open;
        if (keepFocus) analyzeControls.close();
        const next = { view: "analyze", search: "", analysisQuery: null, ...(workspaceState.route.bucket ? { bucket: workspaceState.route.bucket } : {}),
            ...(workspaceState.route.compare === "periods" ? Object.fromEntries(["compare", "aFrom", "aTo", "bFrom", "bTo", "comparisonView", "chart"]
                .map(key => [key, workspaceState.route[key]])) : {}) };
        await navigate(next, true, { reset: true, keepFocus });
    }
    let refreshReadFailure = null;
    let deferredReviewIdentity = null;
    function refreshOwnsReadFailure() {
        const current = fresh.snapshot();
        return refreshReadFailure?.generation === workspaceState.readGeneration && refreshReadFailure.token === current.token
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
        showDeferredDataNotice(deferredDataNotice);
        if (model.phase === "waiting" && !model.sourceUnknown && !model.sourceBlocked) setText($("freshAwayStatus"), owns
            ? " Waiting to apply recorded activity. Your report preview stays frozen; finish the review or edits before applying it."
            : " Waiting until the current review or edits finish.");
    }
    function showDeferredDataNotice(deferred) {
        deferredDataNotice = deferred;
        const reports = workspaceState.route.view === "reports", notice = $("newDataNotice");
        const error = fresh.snapshot().phase === "error", edits = collectionSettings?.hasDraft();
        const explicitCheck = $("freshAwayNotice").dataset.deferredReview === "true";
        notice.hidden = !deferred || reports && !error && !edits && !explicitCheck;
        if (!notice.hidden) setText(notice, error ? "Stored evidence has changed. Retry the stored read; the earlier source check is not repeated."
            : edits ? "New evidence is available. Your unsaved Settings changes are kept; save or cancel them to update automatically."
            : "New evidence is available.");
        const previewNotice = $("reportPreviewActivityNotice"), sourceRevision = collection?.assessment?.basis?.sourceRevision;
        if (previewNotice) previewNotice.hidden = !reports || !activePreview || !reportJourney?.snapshot().hasPreview || error || explicitCheck
            || !Number.isSafeInteger(activePreview.activityRevision) || !Number.isSafeInteger(sourceRevision) || sourceRevision <= activePreview.activityRevision;
    }
    function renderStoredRefresh() {
        if (clearingAccess || !api.publicationToken()) return;
        const report = reportJourney?.snapshot();
        const reviewing = report?.hasPreview || report?.phase === "scanning";
        const editing = collectionSettings?.hasDraft() || sourceSettings?.hasDraft();
        const settingsBusy = collectionSettings?.isBusy() || sourceSettings?.isBusy();
        const blocked = workspaceState.loading || collectionBusy || refreshWorking() || exportWriting || reviewing || editing || settingsBusy
            || ["checking", "applying"].includes(fresh.snapshot().phase);
        for (const control of [$("refreshBtn"), $("freshStoredRead"), $("collectionRetry"), ...document.querySelectorAll("[data-stored-refresh-retry]")]) control.disabled = blocked;
        $("checkActivity").disabled = blocked || fresh.busy()
            || !sourceCollection.active && collectionSettings?.canRefresh() === false;
        $("analyzeRefresh").disabled = $("checkActivity").disabled;
        const reason = editing ? "Save or cancel your Settings edits before refreshing."
            : reviewing ? "Finish this report, or change its choices in Setup, before refreshing."
            : refreshWorking() || settingsBusy ? "Wait for the current activity update to finish."
            : collectionSettings?.canRefresh() === false ? collectionSettings.explain("collectNow")
            : "Wait for the current activity update to finish.";
        ux.explainDisabled($("checkActivity"), reason, { compact: true });
        ux.explainDisabled($("analyzeRefresh"), reason, { compact: true });
        ux.explainDisabled($("freshStoredRead"), reason, { compact: true });
        const model = refreshPresentation(), localRecovery = model.recovery === "stored" || model.phase === "error" && !model.sourceFailure;
        const globalRecovery = !$("message").hidden && $("message").querySelector("[data-stored-refresh-retry]");
        const sharedRecovery = Boolean(globalRecovery && !globalRecovery.disabled);
        collectionSettings?.setSharedRecovery(sharedRecovery);
        sourceSettings?.setSharedRecovery(sharedRecovery);
        const collectionRecovery = collectionReadError && $("collectionRetry").parentElement.checkVisibility();
        const needsRecovery = localRecovery || collectionReadError || workspaceState.stale && !workspaceState.loading;
        $("storedRefresh").hidden = Boolean(globalRecovery) || !needsRecovery || !localRecovery && Boolean(collectionRecovery);
        $("collectionRetry").hidden = !collectionReadError || Boolean(globalRecovery) || !$("storedRefresh").hidden;
        $("checkActivity").hidden = Boolean(historyStatus.native(collection)) && !historyStatus.persistence(collection)
            || Boolean(globalRecovery) || !$("storedRefresh").hidden
            || !$("collectionRetry").hidden && $("collectionRetry").parentElement.checkVisibility();
        $("checkActivity").closest(".ux-disabled-help").hidden = $("checkActivity").hidden;
        $("freshStoredRead").hidden = workspaceState.route.view !== "collection-status"
            || !collection?.config?.approved && !historyStatus.persistence(collection)
            || Boolean(globalRecovery) || $("checkActivity").hidden || Boolean(model.recovery)
            || model.phase === "error" || Boolean(collectionReadError) || workspaceState.stale && !workspaceState.loading;
        $("freshStoredRead").closest(".ux-disabled-help").hidden = $("freshStoredRead").hidden;
        if (refreshWorking()) {
            $("storedRefresh").hidden = true;
            $("collectionRetry").hidden = true;
            $("checkActivity").hidden = false;
            $("checkActivity").closest(".ux-disabled-help").hidden = false;
            $("freshStoredRead").hidden = true;
            $("freshStoredRead").closest(".ux-disabled-help").hidden = true;
        }
        ux.pending($("freshStoredRead"), !model.check && model.phase === "applying");
        setText($("storedRefreshHelp"), reviewing
            ? "Finish this report, or change its choices in Setup, before refreshing."
            : editing ? "Save or cancel your Settings edits before refreshing."
            : exportWriting ? "The saved report will be shown when its current write finishes."
            : "Read stored activity and current status.");
        $("storedRefreshHelp").hidden = !reviewing && !editing && !exportWriting;
        renderDeferredReviewNotice();
        renderRecollectionEntry();
    }
    function recollectionGuard(action) {
        const report = reportJourney?.snapshot();
        if (collectionSettings?.hasDraft() || collectionSettings?.isBusy()) return "Save or cancel your Settings edits before reading history again.";
        if (report?.hasPreview || report?.phase === "scanning" || $("overlay").open) return "Finish this report, or change its choices in Setup, before updating activity.";
        if (exportWriting || workspaceState.loading || collectionBusy || refreshWorking() || fresh.busy()) return "Wait for the current activity update or local save to finish.";
        if (action === "receipt" || action === "view") return "";
        if (!collection?.config?.approved) return "Approve a local source in Settings before reading its history again.";
        if (api.accessState().mode === "enforced" && collection.recollection?.available !== true) {
            return collection.recollection?.mode === "new-only" ? "History recovery is unavailable while collection is paused or the source is not ready."
                : "This runtime does not support history recovery.";
        }
        if (workspaceState.stale || collectionReadError || collectionSettings?.canRefresh() === false) return "Read the current stored activity and source status before previewing history again.";
        return "";
    }
    function renderRecollectionEntry() {
        const current = recollectionUI?.snapshot();
        const reason = recollectionGuard(current?.needsReceipt ? "receipt" : "open");
        const recoveryLabel = current?.phase === "blocked" ? "Review recollection recovery" : "Check recollection result";
        $("recollectActivity").disabled = Boolean(reason) || current?.phase === "pending";
        setText($("recollectActivity"), current?.needsReceipt ? recoveryLabel : "Choose chats");
        ux.explainDisabled($("recollectActivity"), reason || "Wait for the current history operation to finish.", { compact: true });
        const notice = $("recollectionUpdateStatus");
        const message = ["complete", "not-started"].includes(current?.phase) && !recollectionNoticeVisible ? "" : current?.message || "";
        setText(notice, message + (current?.phase === "complete" && !current.viewNeedsRead
            ? " Current filters are kept; reread records may be outside them." : ""));
        notice.hidden = workspaceState.route.view !== "settings" || settingsNavigation.resolve(workspaceState.route).section !== "privacy" || !message;
    }
    function activityUpdatePresentation() {
        const saved = historyStatus.persistence(collection);
        const entry = fresh.entry({ approved: collection?.config?.approved, enabled: saved ? !saved.configuration?.settings.paused : collection?.config?.enabled,
            nativePersistence: Boolean(saved),
            readError: Boolean(collectionReadError), stale: workspaceState.stale && !workspaceState.loading, collectionState: collection?.state });
        const reread = recollectionUI?.snapshot();
        const label = !entry.attention && reread?.phase === "pending" ? "Reading selected history..."
            : !entry.attention && reread?.phase === "blocked" ? "Recollection recovery unavailable"
            : !entry.attention && reread?.needsReceipt ? "History reread unconfirmed"
            : !entry.attention && reread?.phase === "not-started" && recollectionNoticeVisible ? "No history reread committed"
            : !entry.attention && reread?.phase === "complete" && recollectionNoticeVisible ? "History reread completed" : entry.label;
        return { entry, reread, label };
    }
    async function refreshStoredData(event) {
        if (refreshGesture && !refreshGesture.withdrawn) return recoverRefreshGesture(event);
        return refreshStoredSourceData(event);
    }
    async function refreshStoredSourceData(event, statusOnly = false) {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return false;
        renderStoredRefresh();
        if (!statusOnly && $("refreshBtn").disabled || ["checking", "applying"].includes(fresh.snapshot().phase)) return;
        if (!recollectionUI?.snapshot().viewNeedsRead) recollectionNoticeVisible = false;
        const initiator = document.activeElement === event?.currentTarget ? event.currentTarget : null;
        const intent = workspaceState.readingIntent, navigation = workspaceState.navigationGeneration, context = workspaceState.route;
        fresh.retryApply();
        if (fresh.snapshot().phase !== "applying" && !nativeCollectIntent) fresh.begin({ checkSource: false });
        collectionReadGeneration++;
        const readGeneration = collectionReadGeneration;
        clearTimeout(pollTimer);
        $("workspace").setAttribute("aria-busy", "true");
        renderFreshActivity();
        let statusError, expectedSource;
        try {
            const intent = nativeCollectIntent, input = nativeReceiptQuery();
            if (intent && !input.operationId) fresh.nativeRecoveryFailed("The original panel owner is no longer available.");
            if (sourceCollection.active && input.operationId) {
                const receiptStatus = await api("/api/collection/microsoft/status", input);
                if (!api.isCurrent(publication) || readGeneration !== collectionReadGeneration) return false;
                if (intent === nativeCollectIntent && nativeIntentCurrent(intent)) {
                    if (receiveNativeReceipt(receiptStatus, intent)) await qualifyNativeReadback(intent);
                }
            }
            const status = await readCollectionStatus(sourceCollection.active ? {} : input);
            if (!api.isCurrent(publication) || readGeneration !== collectionReadGeneration) return false;
            expectedSource = status.configVersion;
            fresh.retryApply({ configVersion: status.configVersion });
            if (!sourceCollection.active && intent && input.operationId && intent === nativeCollectIntent && nativeIntentCurrent(intent)) receiveNativeReceipt(status, intent);
            renderCollection(status, publication);
        } catch (error) {
            statusError = error;
            if (api.isCurrent(publication) && nativeCollectIntent) fresh.nativeRecoveryFailed(error.message, error.reason);
        }
        if (!api.isCurrent(publication) || readGeneration !== collectionReadGeneration) return false;
        if (statusOnly) return { statusError, expectedSource };
        if ($("overlay").open || reportJourney?.isReviewOpen() || collectionSettings?.hasDraft()) {
            fresh.defer();
            $("workspace").setAttribute("aria-busy", "false");
            showDeferredDataNotice(true);
            renderFreshActivity();
            pollTimer = setTimeout(pollCollection, 5000);
            return false;
        }
        const pending = load({ background: true, expectedSource }), request = workspaceState.readGeneration;
        const loaded = await pending;
        if (!api.isCurrent(publication)) return false;
        if (statusError && (!loaded || !workspaceState.evidence?.collection)) collectionUnavailable(statusError.message, statusError.reason, publication);
        // An unrelated lastCheck cannot confirm or unlock a source request whose response was lost.
        renderFreshActivity();
        if (loaded && request === workspaceState.readGeneration && navigation === workspaceState.navigationGeneration && context === workspaceState.route
            && intent === workspaceState.readingIntent && initiator
            && (document.activeElement === document.body || document.activeElement === initiator)) {
            const fallback = $("checkActivity").checkVisibility() ? $("checkActivity")
                : $("freshAwayLink").checkVisibility() ? $("freshAwayLink") : $("pageTitle");
            ux.restoreFocus(initiator.isConnected && initiator.checkVisibility() && !initiator.disabled ? initiator : fallback);
        }
        return loaded;
    }
    function openChartReference() {
        if (workspaceState.route.view !== "analyze" || semanticQuery !== null && !semanticBound) return;
        analyzeControls.close(false);
        selectControls?.close(); sidebar.close(false); ux.hideTooltip();
        chartReferenceOrigin = workspaceState.positions.get(readingKey(workspaceState.route)) ?? null;
        if (underlyingRoute().compare === "periods") chartReferenceUI.open();
        else selectAnalyzeSection(true);
    }
    function selectAnalyzeSection(guide) {
        const route = workspaceState.route;
        if (route.view !== "analyze" || route.compare || (route.analyzeSection === "guide") === guide || semanticQuery !== null && !semanticBound) return;
        return navigate({ ...route, analyzeSection: guide ? "guide" : undefined });
    }
    function readChartReferenceContext() {
        if (underlyingRoute().compare === "periods") {
            const pair = periodComparisonUI.acceptedPair();
            const description = analyzeScope.describePair(pair);
            const target = pair ? periodComparisonUI.recordsTarget(pair) : null;
            return Object.freeze({
                key: pair?.key || "period:unavailable", revision: pair?.revision,
                layer: pair?.comparison.definitions.layer || workspaceState.scope?.layer || "tool",
                mode: "comparison", available: Boolean(pair), canOpenData: Boolean(target),
                qualification: description?.text ?? "", qualificationParts: description?.parts.slice() ?? [],
                notice: pair ? "" : "Comparison records are not available for the current view.",
                unavailableReason: pair ? "There is no current period-record roster to open." : "Apply both periods before opening their records.",
            });
        }
        const available = Boolean(chartReferenceAccepted && (semanticQuery === null || semanticBound));
        if (!available) return Object.freeze({
            key: "analysis:unavailable", layer: workspaceState.scope?.layer || "tool", mode: "analyze",
            available: false, canOpenData: false,
            qualification: "", qualificationParts: [],
            notice: semanticQuery !== null && !semanticBound ? "Search has not supplied a current selection." : "Chart numbers are unavailable.",
            unavailableReason: "Open a current Analyze view before reading exact numbers.",
        });
        const current = chartReferenceInput.state === workspaceState.evidence && chartReferenceInput.applied === workspaceState.scope && chartReferenceInput.slice === slice
            && (!boundedIncludesMicrosoft() || acceptedNativeView()?.status === "bounded" && !search.trim() && !workspaceState.route.withinServices);
        return Object.freeze({
            ...chartReferenceAccepted, mode: "analyze", available: true, canOpenData: current && !workspaceState.loading && !workspaceState.stale,
            notice: workspaceState.loading || !current ? "The view is updating. Earlier accepted numbers are shown."
                : workspaceState.stale ? "These numbers are from an earlier accepted view." : "",
            unavailableReason: "Wait for a current view before opening matching records.",
        });
    }
    function publishChartReference() {
        const scope = acceptedAnalyzeScope(), model = percentages.referenceModel();
        if (!scope || !workspaceState.evidence || !Number.isSafeInteger(workspaceState.evidence.revision) || workspaceState.evidence.revision < 0 || !workspaceState.scope || !slice || !model) {
            chartReferenceAccepted = null; chartReferenceInput = null; return;
        }
        if (chartReferenceRevision !== workspaceState.evidence.revision) { chartReferenceKeys.clear(); chartReferenceRevision = workspaceState.evidence.revision; }
        const signature = JSON.stringify([workspaceState.evidence.revision, workspaceState.evidence.collection?.configVersion, workspaceState.evidence.deletionVersion,
            workspaceState.scope, workspaceState.acceptedRoute.withinServices || "", workspaceState.acceptedRoute.search?.trim() || "",
            acceptedNativeView()?.selectionRef, acceptedNativeView()?.textSelection?.membershipRef,
            semanticQuery === null ? null : { policy: semanticMembership?.receipt?.matchPolicyId, types: semanticMembership?.receipt?.queryTypes },
            slice.rowIds, slice.scenarioIds, model]);
        if (!chartReferenceKeys.has(signature)) chartReferenceKeys.set(signature, `analysis:${workspaceState.evidence.revision}:${++chartReferenceVersion}`);
        chartReferenceAccepted = Object.freeze({
            key: chartReferenceKeys.get(signature), revision: workspaceState.evidence.revision, layer: workspaceState.scope.layer,
            ...assessmentFactories.chartReference.facts(workspaceState.analytics, model.github ?? model),
            nativeView: boundedIncludesMicrosoft() && showMicrosoftActivity() && !search.trim() && !workspaceState.route.withinServices ? acceptedNativeView() : null,
            nativeOnly: Boolean(sharedNativeView() && !workspaceState.analytics.totals.count && !slice.scenarios.length
                || sourceCollection.active && workspaceState.scope.filters.sources?.length
                && workspaceState.scope.filters.sources.every(source => boundedContract.sourceIds.includes(source))),
            qualification: scope.restrictionText, qualificationParts: scope.restrictions.slice(),
            coverage: [...new Set([acceptedAnalyzePeriod()?.warning, chartReferenceSourceCoverage].filter(Boolean))].join(" "),
        });
        chartReferenceInput = { state: workspaceState.evidence, applied: workspaceState.scope, slice };
    }
    function renderChartReferenceExact(topic, host, identity, presentationState) {
        const context = readChartReferenceContext();
        if (context.mode !== "analyze" || !context.canOpenData || identity.key !== context.key || identity.revision !== context.revision) {
            return { status: "unavailable", reason: "The chart view changed. Open its current exact data." };
        }
        const isCurrent = () => {
            const current = readChartReferenceContext();
            return presentationState.isCurrent() && current.mode === "analyze" && current.canOpenData
                && current.key === identity.key && current.revision === identity.revision;
        };
        const guarded = link => {
            const guard = event => {
                if (isCurrent()) {
                    if (event.type !== "click" || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                    event.preventDefault(); event.stopImmediatePropagation();
                    const next = { ...linkTargets.get(link), analyzeSection: undefined, search: workspaceState.acceptedRoute.search, localSearch: workspaceState.acceptedRoute.localSearch };
                    if (readingKey(next) === readingKey(workspaceState.acceptedRoute)) { chartReferenceUI.leave(); revealResults(); }
                    else navigate(next, false, { revealReferenceRecords: true });
                    return;
                }
                event.preventDefault(); event.stopImmediatePropagation();
                announce("That earlier chart link is no longer current.", "stale");
                chartReferenceUI.refresh();
            };
            for (const event of ["click", "auxclick"]) link.addEventListener(event, guard, { capture: true });
            return link;
        };
        if (context.nativeOnly && topic !== "authors") {
            host.replaceChildren();
            boundedNative.renderExact(host, topic, isCurrent, entry => !presentationState.rowQuery?.trim()
                || localSearch.phrase(presentationState.rowQuery, [entry.label]));
            return { status: "ready" };
        }
        if (["outcomes", "services", "models", "authors", "tools"].includes(topic)) {
            percentages.renderExact(topic, host, presentationState);
            for (const link of host.querySelectorAll("a")) guarded(link);
        } else {
            const chartType = { time: "time", categories: "workload", paths: "endpoint" }[topic];
            if (!chartType) throw new TypeError("Choose a supported exact chart table.");
            host.replaceChildren(chartReferenceCountTable);
            if (chartType === "time" && !workspaceState.analytics.timeSeries) {
                return { status: "unavailable", reason: "Dated chart values are unavailable for this accepted view." };
            }
            renderCountTable(chartReferenceCountTable, chartType, (group, label, outcome) => {
                const changes = chartType === "time" ? { range: "custom", from: group.from, to: group.to }
                    : chartType === "endpoint" ? { endpoint: group.id } : { service: group.label };
                    const next = canonicalRoute({ ...workspaceState.acceptedRoute, view: "analyze", analyzeSection: undefined, request: undefined, call: undefined, callRevision: undefined,
                        ...changes, widget: undefined, guideTopic: undefined, ...(outcome ? { result: outcome } : {}), ...(context.nativeView ? { source: "github-copilot" } : {}), page: undefined });
                return guarded(viewKey(routeLink(label, next, "chart-data-action text-link"), "chart-reference:" + topic + ":" + (group.id || group.date) + (outcome ? ":" + outcome : "")));
            }, { referenceKey: identity.key, isCurrent, rowQuery: presentationState.rowQuery, resetPage: presentationState.resetPage });
        }
        if (context.nativeView) boundedNative.renderExact(host, topic, isCurrent, entry => !presentationState.rowQuery?.trim()
            || localSearch.phrase(presentationState.rowQuery, [entry.label]));
        return { status: "ready" };
    }
    function openChartReferencePeriodRecords(identity) {
        const publication = api.publicationToken();
        if (!publication) return;
        const target = periodComparisonUI.recordsTarget(identity);
        if (!target) {
            announce("The comparison changed. Apply the current periods before opening their records.", "stale");
            chartReferenceUI.refresh();
            return;
        }
        const navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent, origin = chartReferenceOrigin;
        chartReferenceUI.leave();
        requestAnimationFrame(() => {
            if (!api.isCurrent(publication) || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent) return;
            const current = periodComparisonUI.showRecords(identity);
            if (!current) { announce("The comparison records are no longer current.", "stale"); return; }
            const savedFocus = origin?.focus?.id ? $(origin.focus.id) : origin?.focus?.key ? keyed(origin.focus.key) : null;
            if (savedFocus && (current.region.contains(savedFocus) || savedFocus === current.tab)) restoreReading(origin);
            else {
                current.tab.focus({ preventScroll: true });
                current.tab.scrollIntoView({ block: "center", inline: "nearest" });
            }
        });
    }
    function refreshChartReference() {
        if (clearingAccess || !api.publicationToken()) return;
        const route = workspaceState.route, visible = route.view === "analyze" && !route.compare && (semanticQuery === null || semanticBound);
        analyzeReferenceEntry.show(visible);
        const guide = visible && route.analyzeSection === "guide";
        for (const [id, current] of [["analyzeResultsSection", !guide], ["openChartReference", guide]]) {
            if (current) $(id).setAttribute("aria-current", "page"); else $(id).removeAttribute("aria-current");
        }
        if (guide && chartReferenceUI.value().view === "closed" && $("workspace").checkVisibility())
            chartReferenceUI.openAnalyze(pageDefaults.get("guideStart"), route.guideTopic, $("wireSearchHome").contains(document.activeElement));
        else if (guide || route.view === "analyze" && route.compare) chartReferenceUI.refresh();
        else chartReferenceUI.leave();
    }
    $("analyzeResultsSection").addEventListener("click", () => selectAnalyzeSection(false));
    $("analyzeReferenceEntry").addEventListener("keydown", event => {
        if (event.key === "Escape" && !event.defaultPrevented && chartReferenceUI.value().view !== "closed") {
            event.preventDefault(); selectAnalyzeSection(false);
        }
    });
    function setNavigationLink(node) {
        const view = node.dataset.nav;
        setRouteLink(node, Object.hasOwn(browseDefaults, view) ? browseRoute(view) : routeFor(view, { request: undefined, task: undefined }));
    }
    // Keep native link activation (including opening in another tab) in step with ordinary clicks.
    pageDefaults.subscribe(key => {
        if (clearingAccess || !api.publicationToken()) return;
        if (key === "analyzeSort" && (!explicitUsageSort || workspaceState.route.view === "settings")) {
            usageSort = pageDefaults.get(key); explicitUsageSort = false;
            if ($("activityUsageSort")) $("activityUsageSort").value = usageSort;
            if (workspaceState.route.view === "analyze" && !workspaceState.route.compare && workspaceState.evidence) renderActivity();
        }
        for (const node of document.querySelectorAll("[data-nav]"))
            if (browseDefaults[node.dataset.nav] === key) setNavigationLink(node);
    });
    function renderNavigation(references) {
        analyzeReferenceEntry.show(workspaceState.route.view === "analyze" && !workspaceState.route.compare && (semanticQuery === null || semanticBound));
        analyzeControls.context({ analyze: workspaceState.route.view === "analyze", compare: workspaceState.route.view === "analyze" && workspaceState.route.compare === "periods",
            ordinary: workspaceState.route.view === "analyze" && workspaceState.route.compare !== "periods" && (semanticQuery === null || semanticBound) });
        const finishRecoveryPresentation = assessmentUI?.prepareRecoveryPresentation();
        $("wireAnalysisSearchNotice").hidden = semanticQuery === null || workspaceState.route.view !== "analyze" || !$("wireAnalysisSearchNotice").textContent;
        const active = compareDestination(workspaceState.route) ? "compare" : workspaceState.route.view === "request" ? underlyingRoute().view === "trends" ? "trends" : "analyze" : workspaceState.route.view === "collection-status" ? "settings" : workspaceState.route.view;
        workspaceState.present({ active, view: workspaceState.route.view });
        document.title = ({ analyze: "Analyze", trends: "Trends", reports: "Reports", compare: "Compare", settings: "Settings", help: "WIRE Help" }[active] || "Analyze") + " | WIRE";
        document.querySelectorAll("[data-nav]").forEach((node) => {
            const view = node.dataset.nav;
            setNavigationLink(node);
            if (view === active && node.closest("nav")) node.setAttribute("aria-current", "page");
            else node.removeAttribute("aria-current");
        });
        periodBackToTrends.hidden = !(trendPeriodVisit && api.isCurrent(trendPeriodVisit.publication)
            && trendPeriodVisit.destination === historyPosition && workspaceState.route.compare === "periods"
            && trendPeriodVisit.target === readingKey(workspaceState.route));
        const settings = workspaceState.route.view === "settings", operational = workspaceState.route.view === "collection-status", help = workspaceState.route.view === "help", configurationOrStatus = settings || operational || help;
        if (help) {
            renderWireHelp();
            $("openEvidenceHelp").setAttribute("aria-current", "page");
        } else $("openEvidenceHelp").removeAttribute("aria-current");
        for (const [view, ids] of Object.entries({ analyze: ["homeView", "activityView", ...($("frontendBreakdowns") ? ["frontendBreakdowns"] : [])], trends: ["trendsView"], request: ["requestView"], reports: ["reportsView"], settings: ["settingsView"], help: ["wireHelpView"], "collection-status": ["collectionStatusView"] })) {
            for (const id of ids) $(id).hidden = workspaceState.route.view !== view || view === "analyze" && semanticQuery !== null && !semanticBound;
        }
        const expired = expiredTrendEntry(workspaceState.route);
        if (expired) {
            const home = workspaceState.route.trendEntry && !workspaceState.route.trendMeasure;
            setText(expiredTrendTitle, home ? "This Analyze scope is no longer current" : "This Trends selection is unavailable");
            setText(expiredTrendHelp, home ? "Reopen the original widget from Analyze, or open Trends without its scope."
                : "Open Trends without this scope to choose a new period and filters.");
            if (expiredTrend.hidden) trendsUI.withdrawAccess();
            $("trendsView").hidden = true;
        }
        expiredTrend.hidden = !expired;
        $("filters").hidden = configurationOrStatus || ["request", "reports", "trends"].includes(workspaceState.route.view);
        $("filterHeading").hidden = false;
        $("appliedFilters").hidden = $("filters").hidden;
        $("filterChips").hidden = configurationOrStatus || ["reports", "request", "trends"].includes(workspaceState.route.view);
        $("settingsDraftNotice").hidden = settings || !collectionSettings?.hasDraft();
        renderSettingsNavigation();
        finishRecoveryPresentation?.();
        syncLocalSearchFields();
        renderCollectionNotice();
        renderFreshActivity();
        const selectedRequest = workspaceState.evidence.scenarios.find(scenario => scenario.scenarioId === workspaceState.route.request);
        const titles = {
            analyze: [workspaceState.route.compare === "periods" ? "Compare" : "Analyze", ""],
            trends: ["Trends", ""],
            request: [selectedRequest ? workspaceState.route.call ? "Call in context" : "Interaction" : "Interaction unavailable", ""],
            reports: [workspaceState.route.bundle ? savedReportView?.bundleId === workspaceState.route.bundle && savedReportView.entryKey === workspaceState.route.savedEntry
                ? savedReportView.title : savedTitle(workspaceState.evidence.exports?.find(item => item.bundleId === workspaceState.route.bundle))
                : workspaceState.route.task === "create" ? "Create a report" : "Reports", ""],
            settings: ["Settings", ""], help: ["WIRE Help", ""],
            "collection-status": ["Collection status", ""],
        };
        setPageHeading(titles[workspaceState.route.view][0]);
        $("pageTitle").tabIndex = -1;
        $("pageIntro").textContent = titles[workspaceState.route.view][1];
        $("pageIntro").hidden = !titles[workspaceState.route.view][1];
        const source = sessionSource();
        $("pageIdentity").hidden = true;
        $("pageIdentity").textContent = workspaceState.scope.layer === "http" ? "Recorder source" : chatCopy.nameLabel;
        $("sessionAnalysis").setAttribute("aria-label", workspaceState.scope.layer === "http" ? "Recorder source analysis" : "Copilot chat analysis");
        $("pageProject").replaceChildren();
        if (source && workspaceState.route.view === "analyze" && workspaceState.route.session) {
            $("pageProject").append(el("p", "context-source", source.missing
                ? "This source is not in the retained collection. Clear its filter to see other records."
                : (workspaceState.scope.layer === "http" ? "Filtered to recorder source: " : "Filtered to chat: ") + source.name));
            if (source.projectId) $("pageProject").append(projectContext(source));
            const reference = sourceReference(source, references);
            if (reference) $("pageProject").append(el("span", "source-reference", reference));
            const hosts = [...new Set(workspaceState.evidence.scenarios.filter(item => item.sourceSessionId === source.sessionId).map(item => item.sourceHost).filter(Boolean))];
            $("pageProject").append(disclosure("Technical source record", facts([
                [workspaceState.scope.layer === "http" ? "Recorder source ID" : "Copilot chat ID", source.sessionId],
                ["Recorded name", source.name], ["Source host", hosts.length ? hosts.join(", ") : null],
                ["Project", source.projectId ? source.project || source.projectId : null], ["Project ID", source.projectId],
            ], { inlineHelp: false }), "source-header-details", "source:" + source.sessionId));
        }
        $("pageAction").textContent = "Create report";
        setRouteLink($("pageAction"), routeFor("reports", { task: "create" }));
        const contextualAction = $("reportContextAction"), reviewingSelection = workspaceState.route.view === "request";
        contextualAction.textContent = reviewingSelection ? "Review selection" : "Back to Analyze";
        setRouteLink(contextualAction, routeFor(reviewingSelection ? "reports" : "analyze", reviewingSelection ? { task: "create" } : {}));
        const actionHost = reviewingSelection ? $("activitySelectionContext") : $("pageHeadingActions");
        if (contextualAction.parentElement !== actionHost) {
            if (reviewingSelection) actionHost.append(contextualAction);
            else actionHost.prepend(contextualAction);
        }
        const reportMembership = reportSelection();
        contextualAction.hidden = !["request", "reports"].includes(workspaceState.route.view)
            || !reportMembership.requests.length && !reportMembership.nativeConversationCount;
        contextualAction.classList.toggle("button-link", !reviewingSelection);
        contextualAction.classList.toggle("text-link", reviewingSelection);
        sessionReportButton.hidden = workspaceState.route.view !== "analyze" || !workspaceState.route.session || workspaceState.scope.layer === "http";
        $("resetView").hidden = configurationOrStatus || ["reports", "request", "trends"].includes(workspaceState.route.view);
        $("resetView").disabled = !viewChanged();
        const resetHost = workspaceState.route.view === "analyze" ? $("filterTools") : $("scopeResetActions");
        if ($("resetView").parentElement !== resetHost) resetHost.append($("resetView"));
        $("scopeResetActions").hidden = true;
        renderStoredRefresh();
        const returnRoute = workspaceState.route.view === "analyze" && workspaceState.route.session ? sessionsRoute()
            : workspaceState.route.view === "request" ? sessionJourney.returnRoute(workspaceState.route.returnToResults, true) || { view: "analyze" } : null;
        const searchReturn = workspaceState.route.view === "request" && workspaceState.route.request === searchOpenedRequest && liveSearchUI.canRestore(searchReturnMarker) ? searchReturnMarker : null;
        const returnLabel = searchReturn ? "Back to search" : returnRoute?.view === "collection-status" ? "Back to history gaps"
            : workspaceState.route.view === "analyze" ? workspaceState.route.returnToSessions ? "Back to results" : workspaceState.scope.layer === "http" ? "Clear source filter" : "Clear chat filter"
            : returnRoute?.view === "reports" ? "Back to report scope"
            : returnRoute?.view === "trends" ? "Back to Trends"
            : returnRoute?.view === "settings" ? "Back to Settings"
            : workspaceState.route.returnToResults ? "Back to results" : "Back to Analyze";
        const returnKey = JSON.stringify([returnRoute, returnLabel, searchReturn]);
        if (returnKey !== contextReturnKey) {
            const back = returnRoute ? routeLink(returnLabel, returnRoute, "button-link", { restorePosition: true, searchReturn }) : null;
            if (back) {
                back.id = "contextBack";
                if (workspaceState.route.view === "request") {
                    back.classList.add("reader-back");
                    back.prepend(ux.icon("back"));
                }
            }
            $("contextReturn").replaceChildren(...(back ? [back] : []));
            contextReturnKey = returnKey;
        }
        const returnHost = workspaceState.route.view === "analyze" ? $("analyzeReturnActions") : $("pagePrimaryActions");
        if ($("contextReturn").parentElement !== returnHost) returnHost.prepend($("contextReturn"));
        $("contextReturn").hidden = !returnRoute;
        $("analyzeTools").hidden = sessionReportButton.hidden
            && ($("contextReturn").hidden || $("contextReturn").parentElement !== $("analyzeReturnActions"));
        const reports = workspaceState.route.view === "reports";
        const inactiveClear = reports ? $("activityClearSelection") : $("reportClearSelection");
        const inactiveHost = reports ? $("reportSelectionBar") : $("reportSelectionActions");
        if (inactiveClear.parentElement !== inactiveHost) inactiveHost.append(inactiveClear);
        const contextHost = reports ? $("reportPreviewContext") : $("reportSelectionBar");
        if ($("pageHeadingActions").parentElement !== contextHost) contextHost.append($("pageHeadingActions"));
        const activeClear = reports ? $("reportClearSelection") : $("activityClearSelection");
        if (activeClear.parentElement !== $("pageHeadingActions")) $("pageHeadingActions").append(activeClear);
        const selectionHost = workspaceState.route.view === "analyze" ? $("analyzeResultActions") : workspaceState.route.view === "request" ? $("requestView") : document.querySelector(".page-heading");
        if ($("reportSelectionBar").parentElement !== selectionHost) {
            if (workspaceState.route.view === "analyze") selectionHost.prepend($("reportSelectionBar"));
            else selectionHost.append($("reportSelectionBar"));
        }
        const crumbs = $("breadcrumbs");
        crumbs.replaceChildren();
        crumbs.hidden = !crumbs.childElementCount;
        setRouteLink($("exploreLink"), routeFor("activity"));
        renderReportTask();
    }
    function renderReportTask() {
        if (!$("reportCreatePanel")) return;
        const current = reportJourney?.snapshot();
        const view = assessmentFactories.reportWorkspacePresentation(workspaceState.route, current);
        const reading = view.saved, creating = view.prepared;
        const drawer = workspaceState.route.view === "reports" && creating && Boolean(api.publicationToken());
        $("reportsView").classList.toggle("report-workspace-landing", view.landing);
        $("reportsView").classList.toggle("report-home", workspaceState.route.view === "reports" && (drawer || view.landing && workspaceState.route.task !== "library"));
        $("reportCreatePanel").hidden = reading;
        $("savedReportsPanel").hidden = !view.landing && !drawer;
        $("savedReportReader").hidden = !reading;
        const filePanel = creating && !$("reportStage3")?.hidden ? $("reportFileInspection") : null;
        $("reportsView").classList.toggle("report-file-stage", !drawer && workspaceState.route.view === "reports" && Boolean(filePanel && !filePanel.hidden)
            && filePanel.parentElement === $("reportReviewBody"));
        const taskHost = drawer && reportExperience ? reportExperience.backSlot : $("pagePrimaryActions");
        if ($("reportTaskNav").parentElement !== taskHost) taskHost.append($("reportTaskNav"));
        $("reportTaskNav").hidden = workspaceState.route.view !== "reports" || reading || view.landing;
        if (drawer) setText($("pageTitle"), "Reports");
        else if (workspaceState.route.view === "reports" && view.landing) setText($("pageTitle"), workspaceState.route.task === "library" ? "Saved report library" : "Reports");
        $("reportCreateLink").hidden = true;
        $("reportLibraryLink").hidden = !creating;
        setText($("reportLibraryLink"), creating && periodReport?.returnTo ? "Back to comparison"
            : creating && reportEntry?.returnTo ? "Back to Analyze" : "Back to Reports");
        $("reportLibraryLink").setAttribute("aria-disabled", String(Boolean(exportWriting || current?.saveUnconfirmed)));
        for (const [id, active, task] of [["reportLibraryLink", !creating, undefined], ["reportCreateLink", creating, "create"]]) {
            const control = $(id);
            setRouteLink(control, routeFor("reports", { task, request: task ? workspaceState.route.request : undefined }));
            if (active) control.setAttribute("aria-current", "page");
            else control.removeAttribute("aria-current");
        }
        if (creating && (periodReport?.returnTo || reportEntry?.returnTo)) setRouteLink($("reportLibraryLink"), periodReport?.returnTo ?? reportEntry.returnTo);
        syncSavedLibraryTask(view);
        if (drawer) $("savedReportsPanel").classList.add("saved-shelf");
        reportExperience?.sync();
        reportExperience?.syncDrawer(drawer, current?.saveUnconfirmed ? "Check save status" : current?.phase === "saved"
            ? "Report saved" : current?.phase === "unavailable" ? "Report unavailable" : "Report preview");
        const stage = $("reportStage3");
        if (stage) {
            const covered = drawer && !current?.saveUnconfirmed && !current?.completed && Boolean(hiddenReportBlock());
            let notice = $("hiddenPreviewNotice");
            if (covered && !notice) {
                notice = empty("Preview kept closed", "This preview could show a hidden card. Restore it in Analyze to read the preview. The report has not changed.");
                notice.id = "hiddenPreviewNotice"; stage.before(notice);
            }
            if (covered && !stage.hasAttribute("inert") && stage.contains(document.activeElement)) {
                notice.tabIndex = -1; notice.focus({ preventScroll: true });
            }
            if (notice) notice.hidden = !covered;
            stage.toggleAttribute("data-cards-covered", covered); stage.inert = covered;
        }
    }
    function returnToReportOutline() {
        const newOrdinaryDraft = reportJourney.snapshot().completed && !reportBaseExplicit && !periodReport && !selected.size;
        if (!reportJourney.go(1)) return false;
        if (newOrdinaryDraft) applyReportDefaults();
        return true;
    }
    function backToReports() {
        const current = reportJourney?.snapshot();
        if (exportWriting || current?.saveUnconfirmed) { announce("Check or finish the current save before leaving this report.", "stale"); return false; }
        reportExperience?.closeOptions();
        const origin = periodReport?.returnTo ?? reportEntry?.returnTo ?? reportLandingOrigin?.route
            ?? routeFor("reports", { task: undefined, bundle: undefined, inspect: undefined });
        const reading = reportLandingOrigin?.reading;
        if (!returnToReportOutline()) return false;
        const publication = api.publicationToken(), intent = workspaceState.readingIntent;
        const result = navigate(origin, false, { restorePosition: true });
        const restore = loaded => {
            if (loaded && api.isCurrent(publication) && intent === workspaceState.readingIntent && workspaceState.route.view === "reports" && !workspaceState.route.task) restoreReading(reading);
        };
        if (result instanceof Promise) result.then(restore); else restore(result);
        return result;
    }
    function renderViewingContext() {
        const host = $("viewingContext");
        host.hidden = workspaceState.route.view !== "request" || semanticQuery !== null && !semanticBound;
        const rows = selectionRows();
        const evidenceHost = $("serviceEvidenceSummary");
        const evidenceGroups = categories.evidenceGroups(rows, workspaceState.scope.layer);
        evidenceHost.hidden = workspaceState.route.view !== "analyze" || workspaceState.route.service !== "Unknown" || !evidenceGroups.length;
        evidenceHost.replaceChildren();
        if (!evidenceHost.hidden) {
            const heading = el("h2", "", "Why the service is not shown");
            heading.id = "serviceEvidenceTitle";
            const total = evidenceGroups.reduce((sum, group) => sum + group.count, 0);
            const description = el("p", "", `${count(total)} of ${count(rows.length)} ${results.unit(workspaceState.scope.layer, rows.length)} in this view. Recorded outcomes are shown separately.`);
            const groups = el("dl");
            for (const group of evidenceGroups) {
                const item = el("div"), term = el("dt");
                item.dataset.evidenceCount = group.count;
                term.append(document.createTextNode(`${count(group.count)} ${results.unit(workspaceState.scope.layer, group.count)}: `));
                if (group.purpose) term.append(document.createTextNode(group.purpose + " "), el("span", "muted", `(${group.tool})`));
                else term.append(document.createTextNode(group.tool));
                const representative = rows.find(row => (row.tool || "Tool not identified") === group.tool
                    && categories.serviceEvidence(row, workspaceState.scope.layer)?.reason === group.evidence.reason);
                item.append(term, el("dd", "", categories.attributionReading(representative, workspaceState.scope.layer)?.text
                    ?? `${group.evidence.label}. ${group.evidence.description}`));
                groups.append(item);
            }
            evidenceHost.append(heading, description, groups);
        }
        if (workspaceState.route.view === "request") {
            host.hidden = true;
            host.replaceChildren();
            return;
        }
        const label = workspaceState.route.view === "request" ? "Viewing full request from" : workspaceState.route.view === "reports" ? "Current activity view" : "Viewing";
        const project = workspaceState.route.project ? $("projectFilter").selectedOptions[0]?.textContent || "Project unavailable" : "All projects";
        const dates = workspaceState.route.from || workspaceState.route.to ? `${date(workspaceState.route.from)} to ${date(workspaceState.route.to)}` : "All retained dates";
        host.replaceChildren(metadata.row([
            { label },
            { label: `${count(rows.length)} ${results.unit(workspaceState.scope.layer, rows.length)}` },
            { label: resultNames(resultSelection(workspaceState.route.result)) },
            { label: authorship.selectionLabel(workspaceState.scope.filters.promptAuthors) },
            ...(workspaceState.scope.filters.sources?.length && showSourceChoice() ? [{ label: workspaceState.scope.filters.sources.map(filterState.sourceLabel).join(", ") }] : []),
            ...(workspaceState.route.tool ? [{ label: workspaceState.route.tool }] : []),
            ...(workspaceState.route.services ? [{ label: $("serviceFocusScope").textContent }] : []),
            { label: workspaceState.route.service ? serviceLabel(workspaceState.route.service) : allCategories() },
            { label: project },
            { label: dates },
            { label: scopeLabels[workspaceState.scope.filters.scope] || "Collection unavailable" },
            ...(search ? [{ label: "Private search applied" }] : []),
        ]));
        if (workspaceState.route.session && workspaceState.route.view !== "request") {
            const session = workspaceState.evidence.scenarios.find(s => s.sourceSessionId === workspaceState.route.session);
            host.append(el("p", "context-source", (workspaceState.scope.layer === "http" ? "Recorder source: " : "Copilot chat: ") + (session?.sourceSessionName || chatCopy.unnamed)));
        }
        if (workspaceState.route.endpoint) {
            const endpoint = workspaceState.analytics.filterOptions?.endpoints?.find(item => item.id === workspaceState.route.endpoint);
            const context = el("p", "context-source", "API path: ");
            context.append(endpoint?.label ? el("code", "api-path", endpoint.label) : document.createTextNode("Selected path"));
            host.append(context);
        }
        const unlinked = rows.filter(row => !workspaceState.evidence.scenarios.some(scenario => scenario.scenarioId === row.scenarioId)).length;
        if (unlinked) host.append(el("p", "context-source", `${count(unlinked)} records have no retained request details; they remain in the view total.`));
        if (["request", "reports"].includes(workspaceState.route.view) && workspaceState.route.request) {
            const scenario = workspaceState.evidence.scenarios.find(s => s.scenarioId === workspaceState.route.request);
            const back = el("div", "context-return");
            if (workspaceState.route.view === "reports" && scenario) back.append(link("From request: " + excerpt(scenario), "request", { request: scenario.scenarioId }, "request-link"));
            host.append(back);
        }
    }
    function renderFilterChips() {
        const host = $("filterChips");
        host.replaceChildren();
        if (search) {
            const chip = button("Private search applied", () => refineScope({ search: "" }), "filter-chip");
            chip.setAttribute("aria-label", "Remove private search");
            chip.append(ux.icon("close"));
            host.append(chip);
        }
        for (const service of workspaceState.route.withinServices?.split(",") || []) {
            const chip = button(`${service} within current scope`, () => refineScope({
                withinServices: workspaceState.route.withinServices.split(",").filter(value => value !== service).join(",") || undefined,
                request: undefined, page: undefined,
            }), "filter-chip");
            chip.setAttribute("aria-label", `Remove service chart refinement: ${service}`);
            chip.append(ux.icon("close"));
            host.append(chip);
        }
        if (sourceCollection.active && workspaceState.route.nativeGroup) {
            const group = workspaceState.evidence.nativeRead?.grouping?.groups.find(group => group.id === workspaceState.route.nativeGroup);
            const chip = button(`Microsoft group: ${group?.label ?? "Unavailable"}`, () => refineScope({
                nativeGroup: undefined, request: undefined, page: undefined,
            }), "filter-chip");
            chip.setAttribute("aria-label", "Remove Microsoft group restriction");
            chip.append(ux.icon("close")); host.append(chip);
        }
        const labels = { source: "Source", tool: "Tool", services: "Service", service: "Category", result: "Outcome", authors: "Author", project: "Project",
            endpoint: "API path", session: workspaceState.scope.layer === "http" ? "Recorder source" : "Chat", layer: "Activity", scope: "Collection" };
        const selectedLabel = id => $(id).selectedOptions[0]?.textContent;
        for (const [key, label] of Object.entries(labels)) {
            const selectedValue = key === "authors" && workspaceState.scope ? authorship.filterValue(workspaceState.scope.filters.promptAuthors) : workspaceState.route[key];
            if (key === "source" && !showSourceChoice()) continue;
            if (!selectedValue || key === "scope" && selectedValue === "history" || key === "layer" && selectedValue === "tool") continue;
            const value = key === "authors" ? authorship.selectionLabel(selectedValue) : key === "result" ? resultNames(resultSelection(selectedValue))
                : key === "source" ? selectedLabel("sourceFilter") : key === "scope" ? scopeLabels[selectedValue] : key === "project" ? selectedLabel("projectFilter")
                    : key === "session" ? selectedLabel("chatFilter") : key === "layer" ? selectedLabel("layerFilter")
                        : key === "endpoint" ? "Selected path"
                            : key === "tool" ? selectedValue : key === "services" ? selectedValue.split(",").map(serviceLabel).join(", ") : serviceLabel(selectedValue);
            const chip = button(`${label}: ${value}`, () => refineScope({ [key]: undefined }), "filter-chip");
            chip.setAttribute("aria-label", `Remove ${label.toLowerCase()} filter: ${value}`);
            chip.append(ux.icon("close"));
            host.append(chip);
        }
        if (workspaceState.route.from || workspaceState.route.to) {
            const label = `${date(workspaceState.route.from)} - ${date(workspaceState.route.to)}`;
            const chip = button(label, () => refineScope({ from: undefined, to: undefined, range: undefined }), "filter-chip");
            chip.setAttribute("aria-label", "Remove date filter: " + label);
            chip.append(ux.icon("close"));
            host.append(chip);
        }
        const activeMore = ["service", "project", "session", "layer", "scope"].filter(key => workspaceState.route[key] && workspaceState.route[key] !== ({ layer: "tool", scope: "history" })[key]).length;
        setText($("moreFilters").querySelector("summary"), `More filters${activeMore ? ` (${activeMore} active)` : ""}`);
        const focus = workspaceState.analytics.serviceInvolvement?.selection;
        const focused = Boolean(workspaceState.scope.filters.services?.length);
        $("serviceFocus").hidden = !focused || workspaceState.route.view !== "analyze";
        const name = (workspaceState.scope.filters.services || []).map(serviceLabel).join(", ");
        const noun = workspaceState.scope.layer === "tool" ? "calls" : results.unit(workspaceState.scope.layer, 2);
        setText($("serviceFocusScope"), focused ? `${name}${focus.includeMissingService ? ` + ${noun} with missing service details` : " only"}. ${count(focus.knownMatchIds.length)} known matches${focus.includeMissingService ? `; ${count(focus.contextOnlyIds.length)} context-only` : ""}.${workspaceState.stale ? " Previous results; refresh before using this scope." : ""}` : "");
        $("addServiceContext").hidden = !focused || focus.includeMissingService;
        $("addServiceContext").disabled = workspaceState.stale || workspaceState.loading;
        setText($("addServiceContext"), `Include ${noun} with missing service details`);
        if (focused && focus.includeMissingService) {
            const chip = button(`${noun[0].toUpperCase() + noun.slice(1)} with missing service details (context)`,
                () => refineScope({ includeMissingService: false }), "filter-chip");
            chip.setAttribute("aria-label", "Remove missing-service context");
            chip.append(ux.icon("close"));
            host.append(chip);
        }
    }
    function renderPeriodFeedback() {
        if (workspaceState.route.view !== "analyze") return;
        const unbound = semanticQuery !== null && !semanticBound;
        $("periodResult").hidden = unbound;
        $("periodHint").hidden = unbound;
        if (unbound) { $("periodCoverage").hidden = true; return renderAnalyzeScope(); }
        const rows = selectionRows();
        const model = acceptedAnalyzePeriod();
        setText(homeCount, count(rows.length));
        setText(homeUnit, results.unit(workspaceState.scope.layer, rows.length));
        const label = `${homeCount.textContent} ${homeUnit.textContent}`;
        const metric = workspaceState.stale ? el("span") : populationLink(rows.length, label);
        metric.append(homeCount, " ", homeUnit, ` (${model.caption})`);
        $("periodResult").replaceChildren(...(workspaceState.stale ? ["Previous results: "] : []), metric);
        $("periodResult").dataset.revision = String(workspaceState.evidence.revision);
        const hint = workspaceState.stale ? "The update failed. The last applied period is still shown; retry before using these results."
            : !workspaceState.evidence.scenarios.length && !collection?.config ? "No activity has been collected."
                : model.requests ? model.countText : model.next;
        analyzeControls.scopeCaption($("periodHint"), { text: hint,
            parts: !workspaceState.stale && model.requests ? model.countParts : [hint] });
        $("periodHint").hidden = !rows.length && !workspaceState.stale;
        setText($("periodCoverageText"), model.warning);
        $("periodCoverage").hidden = !model.warning;
        $("periodHistoryLink").hidden = !model.historyLink;
        return renderAnalyzeScope(model);
    }
    function acceptedAnalyzePeriod() {
        if (!workspaceState.evidence || !workspaceState.scope || !workspaceState.analytics || !workspaceState.acceptedRoute) return null;
        const rows = selectionRows();
        return periodFlow({ rows, filters: workspaceState.scope.filters,
            coverage: workspaceState.evidence.collection?.config?.approved ? workspaceState.evidence.collection.checkedWindow : workspaceState.evidence.coverage,
            timeContext: workspaceState.scope.timeContext, session: Boolean(workspaceState.acceptedRoute.session), stale: workspaceState.stale,
            layer: workspaceState.scope.layer, unit: results.unit(workspaceState.scope.layer, rows.length) });
    }
    function acceptedAnalyzeScope(period = acceptedAnalyzePeriod()) {
        if (!period || semanticQuery !== null && !semanticBound) return null;
        const projects = workspaceState.scope.filters.projectIds || [], sources = workspaceState.scope.filters.sourceSessionIds || [];
        const names = [...new Set([
            ...projects.map(id => workspaceState.evidence.scenarios.find(row => row.projectId === id)),
            ...sources.map(id => workspaceState.evidence.scenarios.find(row => row.sourceSessionId === id)),
        ])].filter(Boolean);
        const snapshot = {
            scenarios: names.map(({ projectId, project, sourceSessionId, sourceSessionName }) => ({ projectId, project, sourceSessionId, sourceSessionName })),
            sessions: sources.map(id => workspaceState.evidence.sessions?.find(row => row.sessionId === id)).filter(Boolean).map(({ sessionId, name }) => ({ sessionId, name })),
        };
        return analyzeScope.describe({ applied: workspaceState.scope, acceptedRoute: { withinServices: workspaceState.acceptedRoute.withinServices,
            nativeGroupLabel: workspaceState.acceptedRoute.nativeGroup ? workspaceState.evidence.nativeRead?.grouping?.groups.find(group => group.id === workspaceState.acceptedRoute.nativeGroup)?.label
                ?? "Selected group unavailable" : undefined }, snapshot, analytics: workspaceState.analytics,
            period: period.caption, hasSearch: Boolean(workspaceState.acceptedRoute.search?.trim()) || semanticQuery !== null && semanticBound,
            singleSource: !showSourceChoice() });
    }
    function renderAnalyzeScope(period = acceptedAnalyzePeriod()) {
        const description = acceptedAnalyzeScope(period);
        if (!description) { analyzeControls.caption(null); return; }
        const update = activityUpdatePresentation();
        const updateState = fresh.snapshot();
        const notice = historyStatus.entry(collection, { hasEvidence: Boolean(workspaceState.evidence.scenarios.length),
            unavailable: Boolean(collectionReadError), reason: collectionReadReason });
        const updateError = updateState.readFailed || updateState.sourceFailure || collectionReadError
            || workspaceState.stale && !workspaceState.loading || collection?.state === "error";
        const updateExplained = workspaceState.route.view === "analyze" && (update.entry.pending && $("analyzeRefresh").checkVisibility()
            || !$("freshAwayNotice").hidden);
        const errors = [
            workspaceState.stale && !workspaceState.loading ? "Previous results. The view could not update." : "",
            notice?.severity === "error" ? notice.text : "",
            updateState.readFailed || updateState.sourceFailure ? updateState.message : "",
        ].filter(Boolean);
        const empty = workspaceState.analytics.totals.count === 0 && !slice?.scenarios.length && !sharedNativeView()?.aggregates.conversations && !workspaceState.loading && !workspaceState.stale;
        const status = [
            nativeActivityDatesUnavailable() && (workspaceState.scope.filters.from || workspaceState.scope.filters.to)
                ? workspaceState.analytics.population?.coverage?.messageCreationDatesAvailable && workspaceState.analytics.population.contextOnlyScenarioIds?.length
                    ? "Microsoft context uses message dates; call dates are unavailable."
                    : "Microsoft call dates are unavailable; undated calls are excluded." : "",
            !updateExplained && (update.entry.attention || update.reread?.needsReceipt) && (!updateError || update.entry.pending) ? update.label : "",
            !updateExplained && updateState.sourceUnknown ? "A local history check is unconfirmed. It will not be repeated." : "",
            !updateExplained && updateState.sourceBlocked ? "Source checks are read-only in this tab." : "",
            empty ? period.warning : "",
        ].filter(Boolean);
        analyzeControls.caption({ ...description, status: [...new Set(status)].join(" "), error: [...new Set(errors)].join(" "), revision: workspaceState.evidence.revision, empty });
        publishAcceptedListScope(description);
        return description;
    }
    function publishAcceptedListScope(description) {
        const host = $("activityListScope");
        if (!host) return;
        if (frontendActivity && workspaceState.route.compare !== "periods") {
            host.replaceChildren();
            host.hidden = true;
            $("activityListSummary").setAttribute("aria-describedby", "analyzeScopeCaption");
            return;
        }
        // Defaults are already described by the global Dates and collection controls.
        const parts = description?.parts.filter((part, index) => index === 0
            ? Boolean(workspaceState.scope.filters.from || workspaceState.scope.filters.to) : index !== 1 || workspaceState.scope.filters.scope !== "history") ?? [];
        analyzeControls.scopeCaption(host, description ? { ...description, parts, text: parts.join("; ") } : null);
        host.hidden = !parts.length;
        if (description) host.dataset.revision = String(workspaceState.evidence.revision);
        else delete host.dataset.revision;
    }
    function renderControls(references) {
        resultLabels = results.labels(workspaceState.scope.layer);
        sourceOptions();
        const projects = new Map(workspaceState.evidence.scenarios.map((scenario) => [scenario.projectId || "unscoped", scenario.projectId ? scenario.project || scenario.projectId : "Project not recorded"]));
        replacePrivateChoices($("projectFilter"), option("all", "All projects"), ...[...projects].map(([id, name]) => option(id, name)));
        const workloads = workspaceState.analytics.filterOptions?.workloads || workspaceState.analytics.filterOptions?.services || [];
        replacePrivateChoices($("serviceFilter"), option("all", "All categories"), ...workloads.map((item) => option(typeof item === "string" ? item : item.id, serviceLabel(typeof item === "string" ? item : item.label))));
        replacePrivateChoices($("toolFilter"), option("all", "All tools"), ...(workspaceState.analytics.filterOptions?.tools || []).map(tool => option(tool, tool)));
        const services = (workspaceState.analytics.filterOptions?.services || []).filter(value => !["Discovery", "Multiple workloads", "Unknown"].includes(value));
        replacePrivateChoices($("serviceAssociationFilter"), option("all", "All services"), ...services.map(value => option(value, serviceLabel(value))));
        const chats = new Map((workspaceState.evidence.sessions || []).map(source => [source.sessionId, source.name || chatCopy.unnamed]));
        for (const scenario of workspaceState.evidence.scenarios) if (scenario.sourceSessionId && !chats.has(scenario.sourceSessionId)) chats.set(scenario.sourceSessionId, scenario.sourceSessionName || chatCopy.unnamed);
        setText($("chatFilter").closest(".filter-field").querySelector("label"), workspaceState.scope.layer === "http" ? "Recorder source" : "Chat");
        replacePrivateChoices($("chatFilter"), option("all", workspaceState.scope.layer === "http" ? "All recorder sources" : "All chats"), ...[...chats].map(([id, name]) => {
            const reference = sourceReference({ sessionId: id, name }, references);
            return option(id, reference ? `${name} (${reference})` : name);
        }));
        document.querySelector('[data-chart="workload"]').textContent = workspaceState.scope.layer === "tool" ? "By category" : "By service";
        document.querySelector('[data-chart="endpoint"]').textContent = workspaceState.scope.layer === "tool" ? "By path or operation" : "By API path";
        const selectedResults = resultSelection(workspaceState.scope.filters.outcomes);
        const choices = workspaceState.scope.layer === "code-reference" ? [...new Set(["unknown", ...selectedResults])] : resultKeys;
        const totals = workspaceState.analytics.resultFacet.totals;
        const githubCountsAvailable = semanticQuery === null || semanticBound && semanticComplete;
        const nativeOnly = sourceCollection.active && workspaceState.scope.filters.sources?.length
            && workspaceState.scope.filters.sources.every(source => boundedContract.sourceIds.includes(source));
        const nativeView = acceptedNativeView();
        const nativeFacet = boundedIncludesMicrosoft() && nativeView?.status === "bounded" && !search.trim()
            && !workspaceState.route.withinServices ? nativeView.resultFacet : null;
        const countsAvailable = nativeOnly ? Boolean(nativeFacet) : githubCountsAvailable || Boolean(nativeFacet);
        const optionCount = key => {
            if (!countsAvailable) return null;
            if (!boundedIncludesMicrosoft()) return githubCountsAvailable ? count(totals[key]) : null;
            const microsoft = nativeFacet ? count(key === "count" ? nativeFacet.count : nativeFacet.outcomes[key]) : "unavailable";
            return nativeOnly ? microsoft : `GitHub ${githubCountsAvailable ? count(totals[key]) : "unavailable"}; Microsoft ${microsoft}`;
        };
        const resultOptions = choices.map(key => [key, workspaceState.scope.layer === "code-reference" && key !== "unknown" ? `Previous: ${results.labels("tool")[key]}` : resultLabels[key], optionCount(key)]);
        $("outcomeFilter").dataset.allLabel = countsAvailable ? `All results (${optionCount("count")})` : "All results (counts unavailable)";
        const signature = JSON.stringify([workspaceState.scope.layer, resultOptions]);
        if ($("outcomeFilter").dataset.optionsSignature !== signature) {
            replacePrivateChoices($("outcomeFilter"), ...resultOptions.map(([key, label, total]) => {
                const node = option(key, `${label} (${total === null ? "count unavailable" : total})`);
                node.dataset.optionLabel = label;
                node.dataset.count = total === null ? "count unavailable" : total;
                return node;
            }));
            $("outcomeFilter").dataset.optionsSignature = signature;
        }
        $("outcomeFilter").disabled = workspaceState.scope.layer === "code-reference";
        $("resultSummary").dataset.revision = String(workspaceState.evidence.revision);
        applyNativeInventoryOptions();
        syncControls();
    }
    const nativeFilterDimensions = { toolFilter: "tools", outcomeFilter: "outcomes", sourceFilter: "sources",
        chatFilter: "conversations", serviceAssociationFilter: "services", serviceFilter: "workloads", promptAuthorFilter: "promptAuthors" };
    function nativeInventoryPaging(select) {
        if (!sourceCollection.active || !workspaceState.evidence?.nativeRead || !nativeFilterDimensions[select.id]) return null;
        const dimension = nativeFilterDimensions[select.id], { value, error, loading, bound } = boundedNative.inventory(dimension);
        if (!bound) return { label: "Microsoft options unavailable." };
        if (loading) return { label: "Reading Microsoft choices..." };
        if (error) return { label: "Microsoft choices unavailable. " + error,
            first: () => boundedNative.pageInventory(dimension, false) };
        if (!value) return { label: "Reading Microsoft choices...",
            load: async () => {
                await boundedNative.pageInventory(dimension, false);
                const current = boundedNative.inventory(dimension);
                return Boolean(current.value || current.error);
            } };
        if (value.qualification === "unqualified") return { label: "Microsoft values are unavailable for this filter." };
        if (!value.page.nextCursor && value.page.items.length === value.aggregates.options && !value.aggregates.unavailableRows) return null;
        return { label: `${value.page.items.length} of ${count(value.aggregates.options)} Microsoft options.`
                + (value.aggregates.unavailableRows ? ` Values unavailable for ${count(value.aggregates.unavailableRows)} records.` : ""),
            ...(value.page.nextCursor ? { next: () => boundedNative.pageInventory(dimension, true) } : {}),
            first: () => boundedNative.pageInventory(dimension, false) };
    }
    const pendingInventoryUpdates = new Set();
    function refreshInventoryControls() {
        if (!pendingInventoryUpdates.size || !workspaceState.evidence || !workspaceState.scope || workspaceState.loading || clearingAccess || !api.publicationToken()
            || document.querySelector(".select-popup:not([hidden])")) return;
        const pending = [...pendingInventoryUpdates]; pendingInventoryUpdates.clear();
        for (const dimension of pending) applyNativeInventoryOptions(dimension);
        syncControls();
    }
    function applyNativeInventoryOptions(onlyDimension) {
        if (!sourceCollection.active) return;
        const nativeOnly = workspaceState.scope.filters.sources?.length && workspaceState.scope.filters.sources.every(source => boundedContract.sourceIds.includes(source));
        for (const [id, dimension] of Object.entries(nativeFilterDimensions)) {
            if (onlyDimension && dimension !== onlyDimension) continue;
            const control = $(id), inventory = boundedNative.inventory(dimension), value = inventory.value;
            for (const item of [...control.options]) if (item.dataset.nativeInventory === "true") item.remove();
            if (id === "promptAuthorFilter") {
                control.disabled = Boolean(nativeOnly);
                continue;
            }
            if (id === "sourceFilter") {
                for (const item of control.options) if (boundedContract.sourceIds.includes(item.value)) {
                    delete item.dataset.detail;
                }
                continue;
            }
            const enabled = value?.qualification === "available";
            if (nativeOnly && id !== "outcomeFilter") {
                const all = control.options[0]?.cloneNode(true);
                replacePrivateChoices(control, ...(all ? [all] : []));
            }
            control.disabled = id === "outcomeFilter" && workspaceState.scope.layer === "code-reference"
                || Boolean(nativeOnly && !enabled && ["services", "workloads"].includes(dimension));
            if (id === "outcomeFilter") {
                for (const item of control.options) {
                    const row = enabled && value.page.items.find(row => row.value === item.value);
                    const facet = sharedNativeView()?.resultFacet;
                    const nativeCount = row ? count(row.count) : enabled && value.page.nextCursor === null ? "0"
                        : facet ? count(facet.outcomes[item.value]) : "unavailable";
                    if (boundedIncludesMicrosoft()) {
                        item.dataset.count = nativeOnly ? nativeCount : `GitHub ${semanticQuery === null || semanticBound && semanticComplete
                            ? count(workspaceState.analytics.resultFacet.totals[item.value]) : "unavailable"}; Microsoft ${nativeCount}`;
                        item.label = `${resultLabels[item.value]} (${item.dataset.count})`;
                    }
                }
                continue;
            }
            if (enabled) for (const row of value.page.items) {
                let item = [...control.options].find(option => option.value === row.value);
                if (!item) {
                    item = option(row.value, dimension === "conversations" ? `${row.label} (${row.value.slice(0, 8)})` : row.label);
                    item.dataset.nativeInventory = "true"; control.append(item);
                }
                item.dataset.detail = `${count(row.count)} Microsoft ${workspaceState.scope.layer === "tool" ? "tool calls" : "returned results"}`;
            }
            const requested = { toolFilter: workspaceState.route.tool, chatFilter: workspaceState.route.session,
                serviceFilter: workspaceState.route.service, serviceAssociationFilter: workspaceState.route.services }[id];
            if (requested && ![...control.options].some(item => item.value === requested)) {
                const item = option(requested, requested);
                item.dataset.detail = "Current selection is not on this Microsoft option page.";
                item.dataset.nativeInventory = "true"; control.append(item);
            }
        }
    }
    function visibleResultKeys() { return workspaceState.scope.layer === "code-reference" ? [] : resultKeys.filter((key) => ["success", "failure", "unknown"].includes(key) || workspaceState.analytics.resultFacet.totals[key] > 0 || workspaceState.scope.filters.outcomes?.includes(key)); }
    function groupSummary(group) {
        const separate = group.successRate?.unavailable === "different-source-unit-definitions";
        return visibleResultKeys().map(key => `${count(group[key])} ${resultLabels[key].toLowerCase()}${separate ? ""
            : ` (${percentageMath.percent(group[key], group.total)})`}`).join(", ") + (separate ? ". Different source units." : "");
    }
    function chartGroupUnit(group) {
        return group.native ? workspaceState.scope.layer === "tool" ? "native tool calls" : "returned-result observations"
            : results.unit(workspaceState.scope.layer, group.total);
    }
    function inspectColumnSection(node, group, key) {
        ux.tooltip(node, `${resultLabels[key]}: ${count(group[key])} of ${count(group.total)} ${chartGroupUnit(group)}${group.successRate?.unavailable
            ? ". Different source units" : ` (${percentageMath.percent(group[key], group.total)})`}.`,
            { placement: "right", immediatePointer: true, avoid: () =>
                (node.closest(".analyze-chart-grid") || node.closest(".flat-time-view,.flat-comparison"))
                    ?.querySelectorAll(".time-column,.dimensional-count,.dimensional-time-labels,.flat-time-axis,.flat-comparison-action,.flat-comparison-count,.group-name,.percentage-legend-row") || [] });
    }
    function nativeActivityDatesUnavailable() {
        return ["tool", "reported-api"].includes(workspaceState.scope.layer) && workspaceState.analytics.measurementEligibility?.nativeActivityDates === "unqualified"
            && (!workspaceState.scope.filters.sources?.length || workspaceState.scope.filters.sources.some(source => source.startsWith("microsoft-365-")));
    }
    function nativeContextDateBasis(scenarioId) {
        return workspaceState.analytics.population?.contextOnlyScenarioIds?.includes(scenarioId) ? workspaceState.analytics.population.contextDateBasis : null;
    }
    function boundedIncludesMicrosoft() {
        return sourceCollection.active && (!workspaceState.scope?.filters.sources?.length
            || workspaceState.scope.filters.sources.some(source => boundedContract.sourceIds.includes(source)));
    }
    function acceptedNativeView() {
        return nativeAnalysisState ? nativeAnalysisState.value ? { status: "bounded", ...nativeAnalysisState.value } : null : workspaceState.evidence?.nativeRead;
    }
    function sharedNativeView() {
        return boundedIncludesMicrosoft() && !workspaceState.stale && !search.trim() && !workspaceState.route.withinServices
            && acceptedNativeView()?.status === "bounded" ? acceptedNativeView() : null;
    }
    function nativeViewRestriction() {
        const reason = acceptedNativeView()?.reason;
        return workspaceState.stale ? "Microsoft activity changed. Refresh to continue."
            : search.trim() || workspaceState.route.withinServices ? "Microsoft activity is unavailable for this filter."
                : nativeAnalysisState && !nativeAnalysisState.value ? nativeAnalysisState.error || "Searching Microsoft activity..."
                    : acceptedNativeView()?.status !== "bounded" ? ({
                        "microsoft-account-not-configured": "Connect Microsoft 365 in Settings.",
                        "native-retention-not-configured": "Enable Microsoft collection in Settings.",
                        "native-retained-source-not-committed": "No saved Microsoft activity is available.",
                    }[reason] || reason || "Microsoft activity could not be read.") : "";
    }
    function seedBoundedNative() {
        const nativeView = acceptedNativeView();
        const restriction = nativeViewRestriction();
        boundedNative.seed(nativeView, workspaceState.scope, restriction, nativeAnalysisState?.value ? nativeAnalysisState.binding : workspaceState.evidence.nativeGroupBinding,
            { chartType: workspaceState.route.chart || "time" });
        return { nativeView, restriction };
    }
    function renderBoundedAnalyze() {
        const nativeOnly = workspaceState.scope.filters.sources?.length && workspaceState.scope.filters.sources.every(source => boundedContract.sourceIds.includes(source));
        const includesNative = boundedIncludesMicrosoft() && (hasMicrosoftSource() || nativeOnly);
        const { nativeView, restriction } = seedBoundedNative();
        const githubReady = semanticQuery === null || semanticBound && semanticComplete;
        $("homeView").querySelector(".analyze-dashboard").hidden = (nativeOnly || !githubReady) && !sharedNativeView();
        $("activityListContext").hidden = $("activityList").hidden = false;
        const native = !restriction && nativeView?.status === "bounded" ? nativeView.aggregates : null;
        const descriptions = [
            ...(!nativeOnly ? [(hasMicrosoftSource() ? "GitHub Copilot: " : "") + (githubReady ? `${count(workspaceState.analytics.totals.count)} ${results.unit(workspaceState.scope.layer, workspaceState.analytics.totals.count)}`
                : "Search membership unavailable")] : []),
            ...(includesNative ? [native ? `Microsoft: ${count(native.selectedRows)} ${native.layer === "tool" ? "native tool calls"
                : native.layer === "reported-api" ? "returned-result observations" : "selected records"}`
                : "Microsoft: current totals unavailable"] : []),
        ];
        const stats = descriptions.map(text => {
            const microsoft = text.startsWith("Microsoft:");
            if (workspaceState.stale || (microsoft ? !native : !githubReady)) return text;
            const source = microsoft ? nativeView.sourceGroups?.length === 1 ? nativeView.sourceGroups[0].sourceId : "microsoft-365" : null;
            const action = populationLink(microsoft ? native.selectedRows : workspaceState.analytics.totals.count, text, source);
            action.textContent = text;
            if ($("periodResult").classList.contains("visually-hidden")) action.tabIndex = -1;
            return action;
        });
        $("periodResult").replaceChildren(...stats.flatMap((stat, i) => i ? [" / ", stat] : [stat]));
        if (nativeAnalysisState) {
            setText($("wireAnalysisSearchNotice"), native
                ? "Reports include whole matching conversations."
                    + (!nativeOnly && !semanticComplete ? " Current reports need both sources' search results." : "")
                : nativeAnalysisState.error ? "Microsoft search failed. Try again." : "Searching Microsoft activity...");
            $("wireAnalysisSearchNotice").hidden = false;
        }
        $("periodResult").hidden = false;
        if (native) setText($("periodHint"), savedMicrosoftSummary(nativeView));
        $("periodHint").hidden = !native && Boolean(nativeOnly);
        if (includesNative) $("analyzeEmptyScope").hidden = true;
        $("comparePeriods").disabled = boundedIncludesMicrosoft() && !workspaceState.evidence.nativeRead?.allViewId;
        const optionNotice = $("boundedFilterNotice") || el("p", "settings-help");
        if (!optionNotice.id) { optionNotice.id = "boundedFilterNotice"; $("periodResult").after(optionNotice); }
        const setupCovered = !nativeOnly && !workspaceState.stale && !nativeAnalysisState && !search.trim() && !workspaceState.route.withinServices
            && nativeView?.status === "unavailable" && nativeView.reason === "microsoft-account-not-configured"
            && !$("collectionNotice").hidden && $("collectionNotice").dataset.severity === "normal"
            && !$("collectionNoticeAction").hidden;
        optionNotice.hidden = !includesNative || Boolean(native) || setupCovered;
        setText(optionNotice, includesNative && !native && !setupCovered ? restriction : "");
    }
    function renderHome() {
        const layer = workspaceState.scope.layer;
        $("homeView").dataset.resultLayer = layer;
        $("homeView").dataset.revision = String(workspaceState.evidence.revision);
        const chartType = workspaceState.route.chart || "time";
        const native = sharedNativeView();
        const selectedCount = workspaceState.analytics.totals.count + (native?.aggregates.selectedRows ?? 0);
        $("homeView").dataset.empty = String(selectedCount === 0 && !slice.scenarios.length && !native?.aggregates.conversations
            && !workspaceState.loading && !workspaceState.stale && (semanticQuery === null || semanticBound && semanticComplete));
        const recordedDates = [workspaceState.analytics.coverage.firstAt, workspaceState.analytics.coverage.lastAt,
            ...(native?.timeSeries.window ? [native.timeSeries.window.first, native.timeSeries.window.last]
                : native?.timeSeries.points.filter(point => point.count).map(point => point.date) ?? [])].filter(Boolean).sort();
        $("periodLabel").textContent = workspaceState.scope.filters.from || workspaceState.scope.filters.to || recordedDates.length
            ? `${date(workspaceState.scope.filters.from || recordedDates[0])} - ${date(workspaceState.scope.filters.to || recordedDates.at(-1))}`
            : "No dated activity in this view";
        $("meaningMatched").textContent = native
            ? [...(workspaceState.analytics.totals.count ? [`GitHub: ${count(workspaceState.analytics.totals.count)} ${results.unit(layer, workspaceState.analytics.totals.count)}`] : []),
                `Microsoft: ${count(native.aggregates.selectedRows)} ${layer === "tool" ? "native tool calls" : "returned-result observations"}`].join(" / ")
            : `${count(workspaceState.analytics.totals.count)} ${results.unit(layer, workspaceState.analytics.totals.count)}`;
        $("meaningSources").textContent = native
            ? [...(workspaceState.analytics.coverage.sessionCount ? [chatCopy.count(workspaceState.analytics.coverage.sessionCount)] : []),
                `${count(native.aggregates.conversations)} Microsoft conversations`].join(" / ")
            : layer === "http" ? `${count(workspaceState.analytics.coverage.sessionCount)} recorder sources` : chatCopy.count(workspaceState.analytics.coverage.sessionCount);
        $("takeaway").textContent = "";
        if (layer === "reported-api" && workspaceState.analytics.apiCoverage) $("takeaway").textContent = `${count(workspaceState.analytics.apiCoverage.callsWithNumericStatus)} of ${count(workspaceState.analytics.apiCoverage.eligibleToolCalls)} Work IQ tool calls retained an API status; ${count(workspaceState.analytics.apiCoverage.callsWithoutNumericStatus)} did not. Parent-call coverage is before API-result outcome/path filters; private search applies.`;
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
        const interval = ["week", "month"].includes(workspaceState.scope.bucket) ? `by ${workspaceState.scope.bucket}` : "over time";
        $("chartTitle").textContent = chartType === "time" ? `${frontendActivity && !native ? results.unit(layer, 2) : "Activity"} ${interval}`
            : chartType === "workload" ? layer === "tool" ? "Activity categories" : "Service categories" : layer === "tool" ? "Paths and operations" : "API paths requested";
        const notes = $("chartReadingNotes");
        const reading = el("dl");
        for (const [label, text] of [
            ["Dates and grouping", chartType === "time"
                ? (workspaceState.scope.bucket === "week" ? "Weekly totals start Monday."
                    : workspaceState.scope.bucket === "month" ? "Monthly totals start on the first."
                    : "Each date shows one calendar day's records.")
                    + " Undated records are excluded; zero means no qualifying retained records, not proof no activity occurred."
                : chartType === "workload" && layer === "tool" ? help.charts.activityCategory : help.charts[chartType]],
            ["Evidence limits", explanations[layer]],
        ]) reading.append(el("dt", "", label), el("dd", "", text));
        notes.replaceChildren(reading);
        const previousChart = $("chart").querySelector(".dimensional-scroll");
        if (previousChart) dimensional.disposeView(previousChart);
        $("chart").replaceChildren();
        $("chartFooter").replaceChildren();
        const nativeDatesUnavailable = nativeActivityDatesUnavailable();
        if (!selectedCount) {
            $("chart").append(native?.aggregates.conversations ? empty("No recorded tool calls")
                : nativeDatesUnavailable && (workspaceState.scope.filters.from || workspaceState.scope.filters.to)
                ? empty("No dated calls", workspaceState.analytics.population?.contextOnlyScenarioIds?.length
                    ? "Message-date context is available in Activity. Microsoft call dates are unavailable."
                    : "Microsoft call dates are unavailable. Use All dates to read retained conversations.")
                : layer === "tool" && slice.scenarios.some(nativeActivity.isNative)
                    ? empty("No recorded tool calls")
                : !workspaceState.evidence.scenarios.length && !native && !collection?.config
                ? empty("No collected activity yet", "Connect a source in Settings.")
                : empty("No matching activity", layer === "recorded-http" ? "No HTTP statuses were recorded. Try Graph API call sites." : layer === "direct-request" ? "No Graph request sites were recorded." : layer === "http" ? "No recorder captures match." : "Change a filter or reset Analyze."));
        } else if (chartType === "time") renderTime();
        else renderComparison();
        const selectedResults = resultSelection(workspaceState.scope.filters.outcomes);
        if (!selectedCount && selectedResults.length) {
            $("chart").replaceChildren(empty(layer === "code-reference" ? "No references match the previous result filter" : "No matching results in this view",
                "Clear the Outcome filter."));
        }
        const definitions = categories.used((workspaceState.analytics.workloadGroups || []).map((group) => group.label)), glossary = el("dl", "service-glossary");
        for (const entry of definitions) {
            const item = el("div", "glossary-entry");
            item.append(serviceCue("dt", entry.id), el("dd", "", entry.id === "Unknown" ? categories.explainRows(workspaceState.analytics.rows, layer) || entry.description : entry.description));
            glossary.append(item);
        }
        $("serviceDefinitions").replaceChildren(el("h3", "", layer === "tool" ? "Activity categories" : "Service categories"), glossary);
        $("serviceDefinitions").hidden = !definitions.length;
        const chartRows = (chartType === "time" ? workspaceState.analytics.timeSeries?.points?.length || 0 : workspaceState.analytics.groups.length)
            + (chartType === "time" ? native?.timeSeries.points.length ?? 0 : native?.grouping.groups.length ?? 0);
        $("chartDataTitle").textContent = `${$("chartTitle").textContent} (${count(chartRows)} ${chartRows === 1 ? "row" : "rows"})`;
        percentages.update(workspaceState.analytics, { ...workspaceState.scope, search: Boolean(search), withinServices: workspaceState.route.withinServices?.split(",") || [] }, slice.scenarios, native);
        const breakdown = percentages.referenceModel();
        assessmentFactories.homepageUsage(el, $("analyzeUsageContent"), breakdown.models.usage, breakdown.authors.nativeConversations);
        const offersTrends = layer === "tool" && retainedTrendTools(workspaceState.evidence).size > 0;
        for (const link of document.querySelectorAll(".analyze-trend-link")) link.hidden = !offersTrends;
        publishChartReference();
    }
    function renderTime() {
        const series = workspaceState.analytics.timeSeries;
        const native = sharedNativeView(), nativePoints = native?.timeSeries.points ?? [];
        renderTimelineWindow();
        if (!series?.points?.length && !nativePoints.length) {
            $("chart").append(empty(series?.window || native?.timeSeries.window ? "No dated records in this window" : "Dates unavailable"));
            const missing = (series?.undatedCount ?? 0) + (native?.timeSeries.undatedRows ?? 0);
            if (missing) $("chartFooter").append(el("span", "", `${count(missing)} undated ${missing === 1 ? "record" : "records"}.`));
            return;
        }
        const points = [...(series?.points ?? []).map(point => ({ ...point, chartSource: "GitHub Copilot" })),
            ...nativePoints.map(point => ({ ...point, ...point.outcomes, total: point.count, chartSource: "Microsoft 365", native: true }))]
            .sort((a, b) => a.date.localeCompare(b.date) || a.chartSource.localeCompare(b.chartSource));
        const mixed = Boolean(series?.points?.length && nativePoints.length);
        function periodLink(point, key) {
            const next = routeFor("activity", { range: "custom", from: point.from, to: point.to, timelineFrom: undefined, page: undefined,
                ...(key && workspaceState.scope.layer !== "code-reference" ? { result: key } : {}),
                ...(native ? { source: point.native ? native.sourceGroups.length === 1 ? native.sourceGroups[0].sourceId : "microsoft-365" : "github-copilot" } : {}) });
            const control = routeLink("", next, "", { revealReferenceRecords: true });
            const range = date(point.date) + (point.endDate && point.endDate !== point.date ? " to " + date(point.endDate) : "");
            const tip = key ? `${range}: ${count(point[key])} ${resultLabels[key].toLowerCase()}. ${help.resultMeaning(key, workspaceState.scope.layer)}`
                : `${count(point.total)} ${chartGroupUnit(point)} dated ${range}.`;
            control.setAttribute("aria-label", tip);
            control.setAttribute("aria-description", tip);
            viewKey(control, `chart:time:${point.chartSource}:${point.date}:${key || "total"}`);
            return ux.tooltip(control, tip);
        }
        const chart = dimensional.timeView({
            compact: Boolean(frontendActivity),
            points, label: point => date(point.date) + (mixed ? " / " + point.chartSource : ""),
            unit: frontendActivity ? undefined : total => results.columnUnit(workspaceState.scope.layer, total),
            summary: point => `${mixed ? point.chartSource + ": " : ""}${date(point.date, true)}${point.endDate && point.endDate !== point.date ? " - " + date(point.endDate, true) : ""}: ${count(point.total)} ${chartGroupUnit(point)}. ${groupSummary(point)}.`,
            createAction: point => periodLink(point),
            createSegment: periodLink,
            zeroDefinition: () => ux.tooltip(widgetDefinitionLink("time"), "No matching records were dated in this period."),
        });
        chart.removeAttribute("aria-label");
        chart.setAttribute("aria-labelledby", "chartTitle");
        chart.setAttribute("aria-describedby", "chartReadingNotes");
        const windowed = series?.window?.total > 90 || native?.timeSeries.window?.total > 90;
        viewKey(chart, "chart:time" + (windowed ? ":" + points[0].date + ":" + points.at(-1).date : ""));
        chart.querySelectorAll(".time-slot").forEach((slot, index) => viewKey(slot.firstElementChild, "chart:time:" + points[index].chartSource + ":" + points[index].date));
        $("chart").append(chart);
        dimensional.refreshView(chart);
        if (windowed && !workspaceState.scope.timelineFrom) chart.scrollLeft = chart.scrollWidth;
        const missing = (series?.undatedCount ?? 0) + (native?.timeSeries.undatedRows ?? 0);
        if (missing) $("chartFooter").append(el("span", "", `${count(missing)} undated ${missing === 1 ? "record" : "records"}.`));
    }
    function renderTimelineWindow() {
        const windows = [
            ["GitHub Copilot", workspaceState.analytics.timeSeries?.window],
            ["Microsoft 365", sharedNativeView()?.timeSeries.window],
        ].filter(([, window]) => window);
        if (!windows.length || !workspaceState.scope.timelineFrom && windows.every(([, window]) => window.count === window.total)) return;
        const bucket = workspaceState.scope.bucket, first = windows.map(([, window]) => window.first).sort()[0],
            last = windows.map(([, window]) => window.last).sort().at(-1);
        const visible = windows.map(([, window]) => window.from).filter(Boolean).sort()[0];
        const start = workspaceState.scope.timelineFrom ?? visible ?? first;
        const distance = activityProjection.bucketDistance(first, last, bucket), unit = bucket === "day" ? "days" : bucket === "week" ? "weeks" : "months";
        const host = el("div", "list-pager timeline-window"); host.id = "timelineWindow"; host.setAttribute("role", "group"); host.setAttribute("aria-label", "Timeline dates");
        const summary = el("p", "muted", windows.map(([name, window]) => `${windows.length > 1 ? name + ": " : ""}${window.count
            ? window.from === window.to ? date(window.from, true) : `${date(window.from, true)} – ${date(window.to, true)}`
            : "No dates in this window"} (${window.count} of ${count(window.total)} ${window.total === 1 ? bucket : unit})`).join(" / ")
            + ". Totals and filters still cover the whole selected period.");
        const target = amount => activityProjection.advanceBucket(first, bucket,
            Math.max(0, Math.min(distance, activityProjection.bucketDistance(first, start, bucket) + amount)));
        const latest = activityProjection.advanceBucket(first, bucket, Math.max(0, distance - 89));
        const publication = api.publicationToken(), accepted = workspaceState.analytics;
        for (const [id, label, from, available] of [
            ["first", "First dates", first, start !== first],
            ["earlier", "Earlier dates", target(-90), start > first],
            ["later", "Later dates", target(90), windows.some(([, window]) => window.offset + window.count < window.total)],
            ["latest", "Latest dates", latest, start !== latest],
        ]) {
            const control = button(label, () => {
                if (!available || !api.isCurrent(publication) || accepted !== workspaceState.analytics || workspaceState.loading || workspaceState.stale) return;
                navigate(routeFor("analyze", { timelineFrom: from }), false, { keepFocus: true });
            }, "quiet");
            control.id = "timeline-" + id; control.setAttribute("aria-disabled", String(!available)); host.append(control);
        }
        host.append(summary); $("chartFooter").append(host);
    }
    function drillTime(point) {
        go("activity", { range: "custom", from: point.from, to: point.to, timelineFrom: undefined, page: undefined });
    }
    function drillGroup(group) {
        if (group.id === "group:other") { go("home", { expanded: "true" }, true); return; }
        go("activity", workspaceState.route.chart === "endpoint" ? { endpoint: group.id, page: undefined } : { service: group.label, page: undefined });
    }
    function renderComparison() {
        const native = sharedNativeView();
        const groups = [...(workspaceState.route.expanded === "true" ? workspaceState.analytics.groups : [...(workspaceState.analytics.visibleGroups || workspaceState.analytics.groups), ...(workspaceState.analytics.otherGroup ? [workspaceState.analytics.otherGroup] : [])]),
            ...(native?.grouping.groups.map(group => ({ ...group, ...group.outcomes, total: group.count, native: true })) ?? []),
            ...(native?.grouping.other ? [{ id: "native-other", label: "Other Microsoft groups", total: native.grouping.other.count,
                ...native.grouping.other.outcomes, native: true, unavailable: true }] : [])];
        const serviceMode = workspaceState.route.chart !== "endpoint";
        const label = group => group.native ? (group.label === "Unknown" ? "Service not identified" : group.label === "Path not qualified" ? "Path unavailable" : group.label)
            + (workspaceState.analytics.totals.count ? " / Microsoft 365" : "") : serviceMode ? categories.describe(group.label, group.groupCount).label : group.label.replace(/ \(no endpoint reported\)$/, "");
        const guidance = el("span");
        const chart = dimensional.comparisonView({
            groups, serviceMode, label, icons: dimensionalIcons,
            unit: total => results.columnUnit(workspaceState.scope.layer, total),
            renderValue: group => ux.countShare({ count: group.total,
                percentage: !group.native && workspaceState.analytics.measurementEligibility?.outcomeRate === "separate-unit-populations-only"
                    ? undefined : percentageMath.percent(group.total, group.native ? native.aggregates.selectedRows : workspaceState.analytics.totals.count) }),
            summary: group => `${label(group)}: ${count(group.total)} ${chartGroupUnit(group)}; ${groupSummary(group)}.${group.id === "group:other" ? " Show all categories." : ""}`,
            createAction: group => group.native ? group.unavailable ? el("span") : link("", "activity", { nativeGroup: group.id, source: native.sourceGroups.length === 1 ? native.sourceGroups[0].sourceId : "microsoft-365", page: undefined })
                : group.id === "group:other" ? link("", "home", { expanded: "true" })
                : link("", "activity", { ...(serviceMode ? { service: group.label } : { endpoint: group.id }), page: undefined,
                    ...(native ? { source: "github-copilot" } : {}) }),
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
        if (workspaceState.analytics.otherGroup && workspaceState.route.expanded !== "true") $("chartFooter").append(ux.tooltip(button("Show all", () => go("home", { expanded: "true" }, true), "quiet"), help.actions.showAll));
    }
    function renderCountTable(host = $("countTable"), chartType = workspaceState.route.chart || "time", createReferenceAction = null, options = {}) {
        const time = chartType === "time";
        const groups = time ? workspaceState.analytics.timeSeries?.points || [] : createReferenceAction
            ? chartType === "endpoint" ? activityProjection.groupRows(workspaceState.analytics.rows, "endpoint") : workspaceState.analytics.workloadGroups
            : workspaceState.analytics.groups;
        const table = el("table"), thead = el("thead"), heading = el("tr");
        const layer = workspaceState.scope.layer;
        const labels = layer === "tool"
            ? { ...resultLabels }
            : { success: "HTTP 2xx", failure: "HTTP 4xx/5xx", unknown: "No status", other: "Other status", transport: "Connection failed", partial: "Partial result" };
        if (layer === "reported-api") { labels.failure = "Error result"; labels.unknown = "No status / error"; }
        const keys = layer === "code-reference" ? [] : resultKeys.filter(key =>
            key === "success" || key === "failure" || key === "unknown" && layer !== "recorded-http" || workspaceState.analytics.totals[key] > 0);
        const calendarMeaning = workspaceState.scope.bucket === "week" ? " Dates are Mondays." : workspaceState.scope.bucket === "month" ? " Dates are the first of each month." : "";
        const caption = el("caption", "", `${units[layer][0].toUpperCase() + units[layer].slice(1)}${time
            ? ` by ${workspaceState.scope.bucket}.${calendarMeaning}` : "."}`);
        const window = time ? workspaceState.analytics.timeSeries?.window : null;
        if (window && window.count < window.total) caption.append(` ${window.count ? `Showing ${date(window.from, true)} – ${date(window.to, true)}` : "No dated records in this window"}; use Timeline dates below the chart to reach every interval. Totals cover all selected dated records.`);
        if (groups.length > 24) caption.append(" Totals include every page.");
        if (layer === "reported-api") caption.append(" Error results include HTTP 4xx/5xx or a reported error code.");
        const dateLabel = time ? workspaceState.scope.bucket === "week" ? "Week starting" : workspaceState.scope.bucket === "month" ? "Month starting" : "Date" : chartType === "endpoint" ? workspaceState.scope.layer === "tool" ? "Path / operation" : "API path" : categoryNoun();
        table.setAttribute("aria-label", "Exact data for the visible chart");
        table.className = "exact-data-table";
        const columns = el("colgroup");
        columns.append(el("col", "chart-label-column"), ...["total", ...keys].map(() => el("col", "chart-number-column")));
        for (const [index, label] of [dateLabel, "Total", ...keys.map(key => labels[key])].entries()) {
            const cell = el("th", index ? "numeric" : "", label); cell.scope = "col"; heading.append(cell);
        }
        thead.append(heading);
        const footer = el("tfoot"), totalRow = el("tr"), totalLabel = el("th", "", window && window.count < window.total ? "Dated total (selected period)" : "Total (all rows)");
        totalLabel.scope = "row";
        totalRow.append(totalLabel, ...["total", ...keys].map(key => el("td", "numeric", count(time && workspaceState.analytics.timeSeries?.totals
            ? workspaceState.analytics.timeSeries.totals[key] : groups.reduce((sum, group) => sum + group[key], 0)))));
        footer.append(totalRow);
        if (createReferenceAction && !options.referenceKey) throw new TypeError("Exact chart rows require their accepted reference identity.");
        const tableKey = createReferenceAction ? "chart-reference:" + chartType + ":" + options.referenceKey : "chart:" + sliceKey();
        const rowQuery = createReferenceAction && chartType === "endpoint" ? (options.rowQuery || "").trim().toLocaleLowerCase() : "";
        const visibleGroups = rowQuery ? groups.filter(group => group.label.toLocaleLowerCase().includes(rowQuery)) : groups;
        if (options.resetPage) presentation.setPage(tableKey, 0);
        pagedList(host, visibleGroups, { key: tableKey, size: 24, noun: "chart rows", isCurrent: options.isCurrent, listTag: "tbody", renderItem: group => {
            const row = el("tr");
            const label = el("td");
            if (time && group.total) {
                const action = createReferenceAction ? createReferenceAction(group, date(group.date, true))
                    : button(date(group.date, true), () => drillTime(group), "chart-data-action quiet");
                action.setAttribute("aria-label", `${date(group.date, true)}: ${count(group.total)} ${results.unit(workspaceState.scope.layer, group.total)}. View requests.`);
                label.append(action);
            } else if (!time && group.total) {
                const name = chartType === "endpoint" ? group.label : serviceLabel(group.label);
                const action = createReferenceAction ? createReferenceAction(group, name) : button(name, () => drillGroup(group), "chart-data-action quiet");
                action.setAttribute("aria-label", `${name}: ${count(group.total)} ${results.unit(workspaceState.scope.layer, group.total)}. View requests.`);
                label.append(action);
            } else label.append(el("span", "chart-data-label", time ? date(group.date, true) : chartType === "endpoint" ? group.label : serviceLabel(group.label)));
            row.append(label, el("td", "numeric", count(group.total)), ...keys.map(key => {
                const cell = el("td", "numeric", count(group[key]));
                if (time && group[key] && createReferenceAction) {
                    const action = createReferenceAction(group, count(group[key]), key);
                    action.setAttribute("aria-label", `${date(group.date, true)}: ${labels[key]}, ${count(group[key])}. View records.`);
                    cell.replaceChildren(action);
                }
                return cell;
            }));
            return row;
        }, wrapList: tbody => {
            table.replaceChildren(caption, columns, thead, tbody, footer);
            const content = document.createDocumentFragment();
            if (rowQuery) {
                const found = el("p", "table-note", `${count(visibleGroups.length)} of ${count(groups.length)} rows found. Totals include all rows.`);
                found.setAttribute("role", "status");
                content.append(found);
            }
            content.append(groups.length ? table : el("p", "", "No chart rows in this slice."));
            if (time && workspaceState.analytics.timeSeries?.undatedCount) {
                const missing = workspaceState.analytics.timeSeries.undatedCount;
                content.append(el("p", "table-note", `${count(missing)} record${missing === 1 ? "" : "s"} without a date ${missing === 1 ? "is" : "are"} excluded here. Service and API-path views include them.`));
            }
            return content;
        } });
    }
    function servicesFor(rows) { return [...new Set(rows.map(row => categoryPresentation(row, workspaceState.scope.layer).label))].join(", ") || serviceLabel("Unknown"); }
    function projectContext(scenario) {
        const context = el("p", "project-context");
        if (!scenario.projectId) {
            context.classList.add("unscoped");
            context.textContent = scenario.sourceSessionId || scenario.sessionId ? workspaceState.scope.layer === "http" ? "Recorder source without a project" : "Chat without a project" : "Project not recorded";
        } else {
            context.append(el("span", "project-context-label", projectTypeLabel(scenario)), el("strong", "", scenario.project || scenario.projectId));
        }
        return context;
    }
    function currentViewScenarios() {
        return slice?.scenarios.slice() || [];
    }
    function revealResults() {
        if (!api.publicationToken() || clearingAccess) return;
        if (!$("activityView").checkVisibility()) return;
        $("activityListSummary").focus({ preventScroll: true });
        $("activityListContext").scrollIntoView({ block: "start" });
    }
    function revealSessionResult() {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return;
        if (workspaceState.route.view === "request" && workspaceState.route.call !== undefined) {
            const target = $("selectedCall") || $("unavailableCall");
            if (!target) return false;
            const navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent, body = $("requestContent");
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
                    if (!api.isCurrent(publication) || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent
                        || !target.isConnected || document.activeElement !== target) { stop(); return; }
                    contextBody.scrollTop += target.getBoundingClientRect().top - contextBody.getBoundingClientRect().top - timingInset(target);
                    if (!body.querySelector('[aria-busy="true"]')) stop();
                });
            };
            // Retained findings/replies can move this anchor after the initial render.
            const observer = new MutationObserver(schedule);
            readerTextReleases.push(stop);
            observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
            for (const type of ["pointerdown", "wheel", "touchmove", "keydown"]) {
                document.addEventListener(type, event => { if (event.isTrusted) stop(); }, { capture: true, passive: true, signal: events.signal });
            }
            window.addEventListener("pagehide", stop, { once: true, signal: events.signal });
            target.focus({ preventScroll: true });
            schedule();
            return true;
        }
        return false;
    }
    function sessionScopeText() {
        const coverage = workspaceState.evidence.sessionAnalysis?.coverage;
        const period = workspaceState.route.from || workspaceState.route.to ? `${date(workspaceState.route.from)} to ${date(workspaceState.route.to)}` : coverage?.firstAt
            ? `${date(coverage.firstAt)} to ${date(coverage.lastAt)}` : "All retained dates; no dated actions in this scope";
        const serviceFocus = workspaceState.route.services ? workspaceState.route.services.split(",").map(serviceLabel).join(", ")
            + (workspaceState.route.includeMissingService === true ? ` + ${workspaceState.scope.layer === "tool" ? "calls" : results.unit(workspaceState.scope.layer, 2)} with missing service details` : " only") : null;
        return `${period} / ${serviceFocus || (workspaceState.route.service ? serviceLabel(workspaceState.route.service) : allCategories())}${serviceFocus && workspaceState.route.service ? " / Category: " + serviceLabel(workspaceState.route.service) : ""}${workspaceState.route.tool ? " / " + workspaceState.route.tool : ""} / ${authorship.selectionLabel(workspaceState.scope.filters.promptAuthors)} / ${scopeLabels[workspaceState.scope.filters.scope]}${workspaceState.route.endpoint ? " / Selected API path" : ""}${search ? " / Private request search applied" : ""}`;
    }
    function renderSessionAnalysis() {
        const host = $("sessionAnalysis"), source = sessionSource();
        host.replaceChildren();
        host.hidden = workspaceState.route.view !== "analyze" || !workspaceState.route.session || semanticQuery !== null && !semanticBound;
        if (host.hidden) return;
        const context = workspaceState.evidence.sessionAnalysis;
        const rows = context?.rows && slice.refineRows(context.rows);
        const summary = results.summarize(rows);
        host.append(resultLine(workspaceState.scope.layer, summary, {
            scope: "Source results before the result filter", sessionId: source.sessionId,
            label: summary ? chatCopy.relationship(new Set(rows.map(row => row.scenarioId).filter(Boolean)).size, summary.count, results.unit(workspaceState.scope.layer, summary.count), workspaceState.scope.layer === "http") : "Source results",
        }));
        host.append(el("p", "session-scope", `${sessionScopeText()}. ${workspaceState.route.result ? `Totals above include all results in this scope; showing ${resultNames(resultSelection(workspaceState.route.result))} only below.` : "All recorded results in this scope below."}`));
        if (summary?.count) host.append(el("p", "context-help-note", workspaceState.scope.layer === "tool"
            ? "Tool completed and Tool failed count recorded tool completions, not application results or completed tasks."
            : explanations[workspaceState.scope.layer]));
        const reasons = source.reasons?.map(reason => historyStatus.reasons[reason]?.label).filter(Boolean) || [];
        const coverage = source.missing ? "No retained records identify this source."
            : source.unavailable ? "Saved history is unavailable. Previously collected evidence is shown; reports may omit unread history."
            : source.eligible === false ? "This source is no longer in Current activity. Previously collected evidence is preserved."
            : source.pending ? "History is still being collected. This analysis may be incomplete."
            : reasons.length ? "Partial history: " + reasons.join("; ") + "."
            : !source.coverageKnown ? "History coverage has not been verified for this Copilot chat."
            : "Collected history only; unrecorded calls and hosted internal Graph traffic are not observable.";
        const coverageNotice = el("p", "session-coverage", coverage);
        host.append(coverageNotice);
        if (!summary?.count) {
            host.append(el("p", "", summary ? "No recorded evidence matches this source and scope. This is not a success or failure result." : "Result counts are unavailable; no replacement totals were inferred."));
            const layers = results.layers.filter(layer => workspaceState.evidence.requestActivity?.[layer]?.some(row => row.sourceSessionId === source.sessionId));
            const options = el("div", "page-actions");
            for (const layer of layers.filter(layer => layer !== workspaceState.scope.layer && layer !== "reported-api" && layer !== "recorded-http")) {
                options.append(link(`Inspect ${results.unit(layer, 2)}`, "activity", { layer, result: undefined, endpoint: undefined, search: undefined, page: undefined }, "text-link"));
            }
            if (source.eligible === false) options.append(link("Inspect preserved activity", "activity", { scope: "all", result: undefined, page: undefined }, "text-link"));
            host.append(options);
        }
        if (source.unavailable || source.pending || reasons.length || !summary?.count) {
            host.append(link("Review collection status", "collection-status", { setting: "issues" }, "text-link"));
        }
        if (source.missing || source.unavailable || source.eligible === false || source.pending || reasons.length || !source.coverageKnown) return coverageNotice;
    }
    function closeHiddenDialog() {
        if (hiddenDialog) { hiddenDialog.close(); hiddenDialog.remove(); hiddenDialog = null; }
    }
    function refreshCardVisibility() {
        if (clearingAccess || !api.publicationToken() || !workspaceState.evidence) return;
        ux.hideTooltip(); closeHiddenDialog();
        namedDrafts.close(false); namedDrafts.dismissNotice();
        requestRenderKey = null;
        liveSearchUI.visibilityChanged();
        trendsUI.leave(); periodComparisonUI.closeInspection();
        if (hiddenCards.any()) clearSavedReader();
        render();
    }
    function setCardVisibility(id, restoreRefs) {
        if (clearingAccess || !api.publicationToken()) return;
        if (workspaceState.stale || workspaceState.loading) { announce("Wait for current activity before changing hidden cards.", "stale"); return; }
        try {
            if (restoreRefs) { hiddenCards.restore(restoreRefs); undoCard = null; }
            else undoCard = hiddenCards.hide(id, pageDefaults.get("cardHideDuration"));
        } catch (error) { announce("Could not save card visibility on this device: " + error.message, "error"); return; }
        refreshCardVisibility();
        announce(restoreRefs ? restoreRefs.length === 1 ? "Card restored." : "Cards restored." : "Card hidden.");
        const target = workspaceState.route.view === "request" ? $("requestContent").querySelector("[data-undo-hide],button")
            : $("cardVisibilityActions")?.querySelector("[data-undo-hide],button") ?? $("activityListSummary");
        target?.focus({ preventScroll: true });
    }
    function visibilityButton(label, role, onClick, cls = "quiet") {
        const publication = api.publicationToken();
        const node = button(label, () => { if (node.isConnected && api.isCurrent(publication)) onClick(); }, cls);
        node.classList.add("icon-action"); node.prepend(ux.icon(role)); return node;
    }
    function showHiddenCards(trigger) {
        closeHiddenDialog();
        const dialog = el("dialog", "hidden-cards-dialog"), head = el("div", "dialog-head"), body = el("div", "dialog-body");
        hiddenDialog = dialog; dialog.setAttribute("aria-labelledby", "hiddenCardsTitle");
        const title = el("h2", "", "Hidden cards"); title.id = "hiddenCardsTitle"; title.tabIndex = -1; title.autofocus = true;
        const dismiss = button("Close", () => dialog.close(), "quiet");
        head.append(title, dismiss);
        const list = hiddenCards.entries();
        body.append(visibilityButton(`Restore all (${count(list.length)})`, "reset", () => setCardVisibility(null, list.map(v => v.ref))));
        for (const entry of list) {
            const row = el("div", "hidden-card-row"), identity = el("div");
            identity.append(el("span", "", entry.order ? `Hidden card ${entry.order}` : "Hidden card"));
            if (entry.at && Number.isFinite(new Date(entry.at).getTime())) identity.append(el("small", "muted", "Hidden " + timestamp(new Date(entry.at).toISOString())));
            row.append(identity, visibilityButton("Restore", "read", () => setCardVisibility(null, [entry.ref]))); body.append(row);
        }
        dialog.append(head, body); document.body.append(dialog);
        dialog.addEventListener("close", () => {
            dialog.remove();
            if (hiddenDialog === dialog) { hiddenDialog = null; if (trigger.isConnected) trigger.focus({ preventScroll: true }); }
        }, { once: true });
        dialog.showModal(); title.focus({ preventScroll: true });
    }
    function undoHideButton() {
        const ref = undoCard, undo = visibilityButton("Undo hide", "reset", () => setCardVisibility(null, [ref]));
        undo.dataset.undoHide = ""; return undo;
    }
    function renderHiddenActions() {
        let actions = $("cardVisibilityActions");
        if (!actions) { actions = el("div", "card-visibility-actions"); actions.id = "cardVisibilityActions"; $("activityListSummary").after(actions); }
        const list = hiddenCards.entries();
        actions.replaceChildren(); actions.hidden = !list.length;
        if (!list.length) {
            undoCard = null;
            if (hiddenCards.problem()) { actions.hidden = false; actions.append(el("span", "context-help-note", hiddenCards.problem())); }
            return;
        }
        if (list.some(v => v.ref === undoCard)) actions.append(undoHideButton());
        const manage = visibilityButton(`Hidden cards (${count(list.length)})`, "hide", () => showHiddenCards(manage));
        actions.append(manage);
    }
    function renderActivity() {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return;
        const scope = frontendActivity
            ? JSON.stringify([workspaceState.scope, search, semanticQuery, semanticMembership?.receipt, workspaceState.route.withinServices, underlyingRoute().widget, activityPage, hiddenCards.version(), usageSort]) : "";
        if (!workspaceState.evidence.nativeRead && frontendActivity?.retain(publication, workspaceState.evidence, scope)) return;
        const stage = frontendActivity?.begin(publication, workspaceState.evidence, scope);
        if (frontendActivity && !stage) return;
        try {
            if (!renderActivityContent(publication, stage?.host ?? $("activityList"), stage)) return;
            stage?.commit();
        } finally { stage?.discard(); }
    }
    function renderActivityContent(publication, host, stage) {
        captureReading();
        let scenarios = currentViewScenarios();
        scenarios.sort((a, b) => String(b.userPrompt?.sourceTimestamp || b.capturedAt || "").localeCompare(String(a.userPrompt?.sourceTimestamp || a.capturedAt || "")));
        releaseCardPreviews(host);
        nativeActivity.clearCards();
        if (!stage) boundedNative.clearCards();
        const widget = underlyingRoute().widget;
        const group = widget === "all" ? { label: "Recorded activity", drilldownIds: slice.rowIds } : percentages.evidence(widget);
        const members = new Set(group?.interactionIds ?? group?.drilldownIds);
        if (widget) scenarios = group?.interactionIds ? scenarios.filter(record => members.delete(percentageMath.interactionIdentity(record))) : [];
        const orphaned = widget ? [] : selectionRows().filter(row => !slice.scenarioIds.includes(row.scenarioId));
        let ordered = presentation.ordered("interactions:" + sliceKey(), scenarios, item => item.scenarioId);
        if (usageSort !== "recent") {
            const score = s => s.usage ? usageSort === "tokens" ? s.usage.total : s.usage.usd ?? -1 : -2;
            ordered = scenarios.toSorted((a, b) => score(b) - score(a));
        }
        const allItems = [...ordered
            .map(scenario => ({ scenario })), ...orphaned.map(record => ({ record })),
            ...(widget && !group?.interactionIds ? selectionRows().filter(row => members.has(row.id)).map(match => ({ match })) : [])];
        const items = allItems.filter(item => !hiddenCards.has((item.scenario ?? item.match ?? item.record).scenarioId));
        renderHiddenActions();
        const native = widget ? null : sharedNativeView(), nativePage = boundedNative.presentation();
        const roster = assessmentFactories.activityPage({ index: activityPage, github: items.length,
            native: native?.aggregates.conversations ?? 0, githubSize: pageSize, nativeSize: native?.page.limit ?? 10,
            ...(native && (nativePage.value || nativePage.loading) ? { nativeWindow: { index: nativePage.pageIndex, offset: nativePage.pageOffset,
                count: nativePage.pageCount, hasNext: nativePage.hasNext } } : {}) });
        const noun = widget && group?.drilldownIds ? results.unit(workspaceState.scope.layer, 2) : orphaned.length ? "activity entries" : workspaceState.scope.layer === "http" ? "record groups" : "interactions";
        $("activityTitle").textContent = "Activity";
        $("activityView").dataset.revision = String(workspaceState.evidence.revision);
        const unlinked = orphaned.length;
        const groups = `${count(scenarios.length)} ${workspaceState.scope.layer === "http" ? "record group" : "interaction"}${scenarios.length === 1 ? "" : "s"}`;
        const nativeUnavailable = !widget && boundedIncludesMicrosoft() && !native && showMicrosoftActivity();
        $("activityListSummary").textContent = widget ? !group ? "This chart selection is no longer available." :
            `${group.label}: ${count(allItems.length)} matching ${group.interactionIds ? allItems.length === 1 ? "interaction" : "interactions"
                : workspaceState.scope.layer === "tool" ? allItems.length === 1 ? "tool call" : "tool calls" : results.unit(workspaceState.scope.layer, allItems.length)}`
            : native ? [
            ...(allItems.length ? [`${count(allItems.length)} GitHub ${allItems.length === 1 ? "interaction" : "interactions"}`] : []),
            `${count(native.aggregates.conversations)} Microsoft ${native.aggregates.conversations === 1 ? "conversation" : "conversations"}`,
        ].join(" / ") : nativeUnavailable && !items.length ? "Microsoft activity is unavailable"
            : `${nativeUnavailable ? "GitHub: " : ""}${groups} \u00b7 ${count(selectionRows().length)} matching ${workspaceState.scope.layer === "tool"
                ? selectionRows().length === 1 ? "tool call" : "tool calls" : results.unit(workspaceState.scope.layer, selectionRows().length)}`
            + (unlinked ? `. WIRE couldn’t link ${count(unlinked)} ${unlinked === 1 ? "record" : "records"} to an interaction. See the separate list below.` : "");
        $("activityListSummary").hidden = false;
        if (!$("activityUsageSort")) {
            const label = el("label", "usage-sort", "Sort: "), select = el("select"); select.id = "activityUsageSort";
            select.append(...[...$("defaultAnalyzeSort").options].map(option => option.cloneNode(true)));
            select.value = usageSort;
            select.addEventListener("change", () => {
                if (!api.publicationToken() || clearingAccess) return;
                usageSort = select.value; explicitUsageSort = true; activityPage = 0;
                if (workspaceState.route.page) navigate(routeFor(underlyingRoute().view, { page: undefined }), true);
                else renderActivity();
            });
            label.append(select); $("activityListContext").append(label);
        }
        host.replaceChildren();
        activityPage = roster.index;
        if (widget) host.append(routeLink("Show all matching activity", routeFor("activity"), "text-link widget-record-exit", { revealReferenceRecords: true }));
        if (!roster.total && allItems.length && !items.length) {
            host.append(empty("All matching cards are hidden", "Choose Hidden cards to restore them."));
        } else if (!roster.total && !nativeUnavailable && !widget) {
            host.append(empty(native ? "No matching activity" : !workspaceState.evidence.scenarios.length ? "No collected activity yet" : `No matching ${noun}`,
                workspaceState.evidence.scenarios.length
                    ? search ? "Try another phrase or clear Search." : "Try different dates or clear a filter."
                    : search ? "Try a different phrase or clear Search. Your other filters and report selections stay."
                        : "Check your source and collection progress in Settings."));
        }
        for (const item of items.slice(roster.githubOffset, roster.githubOffset + roster.githubLimit)) {
            const card = item.scenario ? requestCard(item.scenario, { eventSignal: stage?.signal })
                : item.match ? widgetRecord(item.match) : matchingAction(item.record);
            if (card && stage) host.append(card);
            if (!api.isCurrent(publication)) return false;
            if (card && !stage) host.append(card);
        }
        if (nativeUnavailable) {
            if (!items.length) host.append(empty("Microsoft activity is unavailable", nativeViewRestriction()));
            else if (!["microsoft-account-not-configured", "native-retention-not-configured", "native-retained-source-not-committed"]
                .includes(acceptedNativeView()?.reason)) host.append(el("p", "notice", nativeViewRestriction()));
        }
        if (native && roster.nativePage !== null) {
            if (nativePage.value && nativePage.pageIndex === roster.nativePage && !nativePage.error) {
                for (const item of nativePage.value.page.items) host.append(boundedNative.card({ item, view: nativePage.value }));
            } else if (nativePage.error) {
                host.append(empty("Microsoft activity is unavailable", nativePage.error));
                host.append(button("Read current activity", async () => {
                    activityPage = 0;
                    await navigate(routeFor("analyze", { page: undefined }), true);
                    await refreshStoredData();
                }, "quiet"));
            }
            else {
                host.append(el("p", "reader-state", "Reading this activity page..."));
                if (!nativePage.loading) void boundedNative.pageAt(roster.nativePage);
            }
        }
        if (!api.isCurrent(publication)) return false;
        const pager = viewKey(stage?.pager ?? $("activityPager"), "pager:activity");
        pager.hidden = !roster.total;
        pager.setAttribute("role", "navigation");
        pager.setAttribute("aria-label", "Analyze result pages");
        const pageReady = roster.nativePage === null || !native || nativePage.value && nativePage.pageIndex === roster.nativePage && !nativePage.error;
        pager.replaceChildren(el("span", "", pageReady ? `${roster.first}-${roster.last} of ${roster.total} ${native ? "activity entries" : nativeUnavailable ? "GitHub " + noun : noun}`
            : nativeUnavailable || nativePage.error ? "Microsoft page unavailable" : `Reading page / ${roster.total} activity entries`));
        if (nativeUnavailable) pager.append(el("span", "muted", "Microsoft total unavailable"));
        const position = pager.firstElementChild;
        position.id = "activityPagePosition";
        position.dataset.pagePosition = "";
        position.tabIndex = -1;
        if (roster.pages > 1) {
            const turnPage = offset => navigate(routeFor("analyze", { widget, page: Math.max(0, activityPage + offset) }), true,
                { paging: capturePager(pager, offset) });
            const prev = button("Previous", () => turnPage(-1));
            prev.disabled = activityPage === 0 || !pageReady;
            prev.dataset.pageDirection = "-1";
            prev.setAttribute("aria-describedby", position.id);
            const next = button("Next", () => turnPage(1));
            next.disabled = activityPage + 1 >= roster.pages || !pageReady;
            next.dataset.pageDirection = "1";
            next.setAttribute("aria-describedby", position.id);
            pager.append(prev, next);
        }
        return true;
    }
    function widgetRecord(row) {
        const record = workspaceState.evidence.scenarios.find(scenario => row.scenarioId === scenario.scenarioId);
        if (!record) return matchingAction(row);
        const layer = workspaceState.scope.layer, card = viewKey(el("article", "activity-card widget-record"), "widget-record:" + row.id);
        card.dataset.actionId = row.id;
        const target = routeFor("request", { request: row.scenarioId, call: row.id, layer,
            ...(layer === "reported-api" ? { callRevision: workspaceState.evidence.revision } : {}) });
        const ordinal = layer === "tool" ? requestContext.actionOrdinals(record).get(sourceCallFor(row)) : null;
        const action = routeLink([ordinal && `Call #${ordinal}`, row.tool, row.endpoint?.path].filter(Boolean).join(" · ") || results.unit(layer, 1), target, "text-link request-link");
        action.setAttribute("aria-controls", "contextSidebar");
        card.dataset.resultLayer = layer;
        const metadata = el("div", "widget-record-meta"), outcome = el("span", "semantic-cue result-tone-" + row.outcome);
        outcome.append(ux.icon(results.icon(row.outcome)), el("span", "", results.labels(layer)[row.outcome]));
        metadata.append(outcome);
        if (row.startedAt) metadata.append(el("span", "muted", time.formatMoment(row.startedAt, workspaceState.scope.timeContext)));
        card.append(viewKey(action, "widget-open:" + row.id), metadata);
        return card;
    }
    function matchingAction(row) {
        const card = viewKey(el("article", "matched-action activity-card"), "action:" + row.id);
        card.dataset.actionId = row.id;
        card.dataset.sessionId = row.sourceSessionId;
        const recordedLabel = workspaceState.scope.layer === "code-reference" ? "Reference recorded" : workspaceState.scope.layer === "reported-api" ? "Parent call recorded"
            : ["direct-request", "recorded-http"].includes(workspaceState.scope.layer) ? "Request site recorded" : "Action recorded";
        const identity = el("p", "", workspaceState.scope.layer === "tool" ? results.callOperation(row) : row.tool || results.unit(workspaceState.scope.layer, 1));
        card.append(identity,
            el("p", "muted", "The owning interaction was not retained."),
            recordedCategory([row], workspaceState.scope.layer),
            resultLine(workspaceState.scope.layer, results.summarize([row]), { rows: [row], singleRecord: true,
                recordLabel: results.labels(workspaceState.scope.layer)[row.outcome] }));
        const details = el("dl", "activity-card-facts");
        if (row.status != null) details.append(cardFact(workspaceState.scope.layer === "reported-api" ? "Tool-reported HTTP" : "Recorded HTTP", String(row.status)));
        if (["tool", "reported-api", "http"].includes(workspaceState.scope.layer)) details.append(cardFact(workspaceState.scope.layer === "tool" ? "Tool latency"
            : workspaceState.scope.layer === "reported-api" ? "API result duration" : "Record duration", durationValue(callInvestigation.duration(row, workspaceState.scope.layer))));
        details.append(cardFact(recordedLabel, time.formatMoment(row.startedAt, workspaceState.scope.timeContext)));
        card.append(details);
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
    function durationValue(milliseconds, reader = false) {
        if (milliseconds === null) return el("span", "call-duration", "Not recorded");
        const value = el("data", "call-duration");
        const [primary, secondary] = (reader ? timingPresentation.readerDuration(milliseconds) : timingPresentation.duration(milliseconds)).split(" (");
        value.append(el("span", "duration-primary", primary));
        if (secondary) value.append(" ", el("span", "duration-equivalent", "(" + secondary));
        value.value = String(milliseconds);
        return value;
    }
    function originalModelFact(scenario, { callContext = false } = {}) {
        const model = scenario.originalModel;
        const valid = model && ["Model", "Models"].includes(model.label) && typeof model.value === "string" && model.value.trim();
        const presentation = model?.presentation;
        const explanations = {
            "missing-response-models": "some responses have no linked model name",
            "unverified-final-boundary": "the final response boundary was not verified",
            "truncated-history": "a source window or retention limit cut it short",
        };
        const validPresentation = valid && ["recorded", "partial"].includes(model.status)
            && typeof presentation?.identity === "string" && presentation.identity.trim()
            && Array.isArray(presentation.completeness) && presentation.completeness.every(reason => Object.hasOwn(explanations, reason));
        const value = el("span", "model-identity", presentation && !validPresentation ? "Not verified (invalid model presentation)"
            : validPresentation ? presentation.identity : valid ? model.value : model ? "Not verified (invalid model metadata)" : "Not recorded");
        const row = cardFact(callContext ? "Interaction model" : valid ? model.label : "Model", value);
        if (validPresentation && presentation.completeness.length) {
            const reasons = presentation.completeness;
            const qualifier = reasons.includes("missing-response-models") || reasons.includes("truncated-history") ? "is" : "may be";
            const detail = reasons.map(reason => explanations[reason]).join("; ");
            const note = reasons.length === 1 && reasons[0] === "missing-response-models"
                ? detail[0].toUpperCase() + detail.slice(1) : `Model history ${qualifier} incomplete: ${detail}`;
            row.append(el("dd", "model-recording-note", note + "."));
        }
        return row;
    }
    function cardTools(rows, showCounts = true, { compact = false } = {}) {
        if (!Array.isArray(rows)) return el("span", "identity-gap", "Tool evidence unavailable");
        const tools = new Map();
        for (const row of rows) {
            const name = row.tool || "Tool not recorded";
            tools.set(name, (tools.get(name) || 0) + 1);
        }
        if (compact) {
            const names = [...tools.keys()].filter(name => name !== "Tool not recorded");
            const items = names.slice(0, 2).map(name => el("span", "card-tool-name", name));
            if (names.length > 2) items.push(el("span", "identity-overflow", "More tools"));
            if (tools.has("Tool not recorded")) items.push(el("span", "identity-gap", "Tool not recorded"));
            return identityList(items);
        }
        const list = el("ul", "interaction-tools");
        for (const [name, total] of tools) {
            const item = el("li");
            item.append(el("span", "card-tool-name", name));
            if (showCounts && (tools.size > 1 || total > 1)) item.append(document.createTextNode(" "),
                el("span", "card-tool-count", `(${count(total)} ${results.columnUnit(workspaceState.scope.layer, total)})`));
            list.append(item);
        }
        if (!tools.size) list.append(el("li", "", "No tool evidence in this view"));
        return list;
    }
    function cardIdentityRows(rows, layer) {
        // Full canonical context can omit tool names. Use only its exact owning call.
        return rows?.map(row => Object.hasOwn(row, "tool") || !["tool", "reported-api"].includes(layer)
            ? row : { ...row, tool: sourceCallFor(row)?.tool });
    }
    function interactionSummary(rows, layer, scope, label) {
        const summary = el("div", "interaction-summary"), identity = el("div", "interaction-identity");
        if (!Array.isArray(rows) || rows.length) {
            const identities = cardIdentityRows(rows, layer);
            const tools = el("span", "identity-group"), services = recordedCategory(identities, layer, { compact: true });
            tools.append(el("span", "identity-key", "Tools: "), cardTools(identities, false, { compact: true }));
            services.setAttribute("role", "group");
            services.setAttribute("aria-label", "Services and recorded activity");
            identity.append(tools, services);
            summary.append(identity);
        }
        const outcomes = resultLine(layer, results.summarize(rows), { scope, pillsOnly: true, rows });
        if (Array.isArray(rows) && !rows.length) outcomes.lastElementChild.textContent = `No recorded ${results.unit(layer, 0)}`;
        if (label) outcomes.prepend(el("span", "identity-key", label + ": "));
        summary.append(outcomes);
        return summary;
    }
    function projectTypeLabel(project) {
        return project.projectType === "folder" ? "Folder project" : project.projectType === "repository" ? "Repository project" : "Project";
    }
    function appendCardSource(list, scenario, options = {}) {
        const source = sessionSource(scenario.sourceSessionId);
        const chat = el("span", "card-chat");
        if (source) {
            const action = routeLink(source.name, sessionRoute(source.sessionId), "text-link");
            action.setAttribute("aria-label", (workspaceState.scope.layer === "http" ? "Filter to recorder source: " : "Filter to chat: ") + source.name);
            chat.append(action);
            const reference = sourceReference(source, options.references);
            if (reference) chat.append(el("span", "source-reference", reference));
        } else chat.textContent = "Not recorded";
        list.append(cardFact(workspaceState.scope.layer === "http" ? "Recorder source" : "Chat", chat));
        const project = source || scenario;
        const projectLabel = projectTypeLabel(project);
        if (options.includeProject !== false && (!options.compact || project.projectId)) list.append(cardFact(projectLabel, el("span", "project-context", project.projectId
            ? project.project || project.projectId : project.sessionId || project.sourceSessionId ? "No project associated" : "Not recorded")));
        if (options.includeTime !== false) {
            const moment = requestTiming.entry(scenario, workspaceState.scope.timeContext);
            list.append(cardFact(options.compact && moment.label === "Message recorded" ? "Recorded" : moment.label, moment.value));
        }
        if (options.includeModel !== false) list.append(originalModelFact(scenario, options));
    }
    function activityCardException(layer, rows, summary) {
        if (!summary) return "Result counts unavailable";
        if (!summary.count) return `No recorded ${results.unit(layer, 0)} in this view`;
        const label = results.labels(layer);
        if (summary.failure) return layer === "tool"
            ? `${count(summary.failure)} tool ${summary.failure === 1 ? "call" : "calls"} failed`
            : `${label.failure}: ${count(summary.failure)}`;
        if (summary.transport) return label.transport;
        // A problem reported *by* a completed tool is not a failed tool call.
        if (layer === "tool" && results.explainedEntries(layer, rows, sourceCallFor)
            .some(entry => entry.tone && entry.tone !== entry.key)) return "Reported result issue";
        if (summary.partial) return label.partial;
        if (summary.unknown) return summary.unknown === summary.count ? label.unknown
            : `${label.unknown}: ${count(summary.unknown)}`;
        return summary.other ? label.other : null;
    }
    function activityIdentities(rows, layer, { includeTools = true, inspectGap, inspectTool } = {}) {
        const group = el("dl", "card-identities"), tools = new Map(), targets = new Map(), operations = new Map(), gaps = new Map();
        function recordToolOperation(row, id, label) {
            if (!operations.has(row.tool)) operations.set(row.tool, { id, label, tool: row.tool,
                operationRole: ux.operations.toolRole(row.tool), description: categories.operation(row.tool)?.description, rows: [] });
            operations.get(row.tool).rows.push(row);
        }
        const field = (name, values, className = "") => {
            if (!values.length) return;
            const line = el("div", "card-identity-field"), items = el("dd", "card-identity-values");
            if (className) line.classList.add(className);
            for (const value of values) items.append(value);
            line.append(el("dt", "", name), items); group.append(line);
        };
        for (const row of cardIdentityRows(rows, layer) ?? []) {
            const names = row.nativeToolNames ?? (row.tool ? [row.tool] : []);
            for (const name of new Set(names)) tools.set(name, (tools.get(name) ?? 0) + 1);
            const association = row.serviceAssociation;
            const dims = association?.layer === layer ? association.services : [row.workload].filter(Boolean);
            for (const id of dims) {
                if (id === "Unknown") continue;
                if (id === "Discovery" || association?.basis === "tool-purpose" && id === "Search") {
                    const title = categories.operation(row.tool)?.label ?? (id === "Search" ? "Search requested" : serviceLabel(id));
                    recordToolOperation(row, id, title);
                } else targets.set(id, describeService(id));
            }
            if (association?.status === "not-applicable" && categories.operation(row.tool))
                recordToolOperation(row, "Discovery", categories.operation(row.tool).label);
            for (const op of ux.operations.pathOperations(row, layer)) {
                if (!operations.has(op.operationRole)) operations.set(op.operationRole, { id:"Unknown", ...op, rows:[] });
                operations.get(op.operationRole).rows.push(row);
            }
            for (const gap of association?.gaps ?? [categories.serviceEvidence(row, layer)].filter(Boolean)) {
                const operation = operationForGap(row, layer, gap), owner = operation ? operations : gaps;
                if (!owner.has(gap.reason)) owner.set(gap.reason, {
                    ...(operation ?? { id: "Unknown", ...categories.displayEvidence(gap) }), reason: gap.reason, rows: [] });
                owner.get(gap.reason).rows.push(row);
            }
        }
        if (includeTools && ["tool", "reported-api"].includes(layer)) {
            const labels = Array.from(tools, ([name, total]) => ({ name,
                countLabel: total > 1 ? `${count(total)} ${layer === "tool" ? "calls" : "results"}` : null }));
            field(tools.size > 1 ? "Tools" : "Tool", tools.size ? [ux.cardToolList(labels, inspectTool)] : rows?.length ? [el("span", "muted", "Not recorded")] : []);
        }
        const cues = entries => [...entries.values()].map(item => {
            const cue = serviceCue("span", item.id, item);
            if (item.description) ux.tooltip(cue, () => cue.closest(".expanded-call") ? null : item.description);
            return item.rows && inspectGap ? inspectGap(item, cue) : cue;
        });
        const values = cues(targets);
        if (values.length > 3 && includeTools) {
            const extra = el("details", "card-more-targets");
            const more = values.length - 3;
            const remainder = el("span", "card-identity-values"); remainder.append(...values.splice(3));
            extra.append(el("summary", "", `${more} more ${more === 1 ? "target" : "targets"}`), remainder);
            values.push(extra);
        }
        field(layer === "reported-api" ? "Returned target" : targets.size > 1 ? "Targets" : "Target", values, "card-targets");
        field(operations.size > 1 ? "Operations" : "Operation", cues(operations));
        field("Service", cues(gaps));
        if (!Array.isArray(rows)) field("Evidence", [el("span", "muted", "Not available")]);
        return group;
    }
    const cardOwners = new WeakMap();
    function labelPanelLink(node, active) {
        const label = `${active ? "Close" : "Open"} activity panel: ${node.textContent.trim()}`;
        node.setAttribute("aria-label", label);
    }
    function requestCard(scenario, { reportPicker = false, eventSignal } = {}) {
        const authority = api.publicationToken();
        if (!authority || clearingAccess || !workspaceState.evidence) return null;
        const layer = reportPicker ? "tool" : workspaceState.scope.layer;
        const rows = reportPicker ? fullRowsFor(scenario.scenarioId, layer) : rowsFor(scenario.scenarioId);
        const target = routeFor("request", { request: scenario.scenarioId });
        const summary = results.summarize(rows), outcome = layer === "tool" ? results.toolCardOutcome(summary) : null;
        const statusTarget = countedCallTarget(rows, target, outcome?.key);
        if (nativeActivity.isNative(scenario)) return nativeActivity.card({
            record: scenario, setHref: (link, counted) => setRouteLink(link, counted ? statusTarget : target), rows: rows ?? [], layer,
            contextDateBasis: nativeContextDateBasis(scenario.scenarioId), canOpenCounted: Boolean(statusTarget),
            onOpen: (id, counted) => navigate(counted ? statusTarget : target),
        });
        const row = viewKey(el("article", "request-row activity-card read-in-place"), "request:" + scenario.scenarioId);
        const events = new AbortController();
        const signal = eventSignal ? AbortSignal.any([events.signal, eventSignal]) : events.signal;
        function open(label, focus, exact = target, cls = "card-evidence-link") {
            const link = el("a", cls, label);
            setRouteLink(link, exact);
            link.setAttribute("aria-controls", "contextSidebar");
            link.setAttribute("aria-expanded", String(sidebarIdentity !== null && workspaceState.route.request === target.request));
            link.addEventListener("click", event => {
                if (!api.isCurrent(authority)) { event.preventDefault(); return; }
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                const selection = window.getSelection();
                if (event.detail && !selection?.isCollapsed && link.contains(selection?.anchorNode)) return;
                row.querySelector("[data-card-origin]")?.removeAttribute("data-card-origin");
                link.dataset.cardOrigin = "";
                if (link.classList.contains("card-panel-link") && link.getAttribute("aria-expanded") === "true"
                    && workspaceState.route.view === "request" && workspaceState.route.request === target.request) {
                    closeContextSidebar(); return;
                }
                if (focus === "prompt") textAccess.setOpen("request:" + target.request, true);
                if (exact.completedCalls || exact.failedCalls) navigate(exact);
                else navigate(target, false, { cardTarget: { target: exact, revision: workspaceState.evidence.revision, focus } });
            }, { signal });
            return link;
        }
        const description = textAccess.describePrompt(scenario.userPrompt);
        const actor = authorship.read(scenario.userPrompt).actor;
        const authorLabel = actor === "unknown" && !description.automatic ? authorship.unknownLabel : description.label;
        const moment = requestTiming.entry(scenario, workspaceState.scope.timeContext);
        const openPrompt = text => open(text, "prompt", target, "request-card-open recognition-row");
        const prompt = description.hasText ? textAccess.renderCardPreview(scenario.userPrompt, { openPrompt, home: !reportPicker }) : el("p", "request-card-prompt");
        if (!description.hasText) {
            const notice = (description.automatic || /\bprompt\b/i.test(description.notice) ? "" : "Prompt: ") + description.notice;
            prompt.append(reportPicker ? openPrompt(notice) : notice);
        }
        if (reportPicker) {
            const promptLink = prompt.querySelector(".request-card-open"), passage = el("span", "card-excerpt");
            passage.append(...promptLink.childNodes); promptLink.append(passage, ux.icon("read"));
        }
        const sourceIdentity = filterState.sourceIdentity(rows);
        if (sourceIdentity) row.dataset.sourceId = sourceIdentity.id;
        const author = el("span", "request-card-author", authorLabel);
        author.dataset.promptActor = actor;
        author.prepend(ux.icon("author-" + actor));
        const full = results.summarize(fullRowsFor(scenario.scenarioId, layer));
        const facts = el("div", "request-card-summary");
        const header = ux.cardMetadata(author, el("span", "request-card-time", (moment.label === "Message recorded" ? "" : moment.label + ": ") + moment.value),
            sourceIdentity && sharedNativeView()?.aggregates.conversations ? el("span", "request-card-source", `Source: ${sourceIdentity.label}`) : null);
        if (scenario.usage && !reportPicker) header.append(el("span", "usage-chip", assessmentFactories.usageChip(scenario.usage)));
        if (summary && full?.count !== summary.count) {
            facts.append(el("span", "request-card-count", results.countLabel(layer, summary.count, full?.count ?? null)));
        } else if (!reportPicker && outcome && summary[outcome.key] < summary.count) {
            facts.append(el("span", "request-card-count", `${count(summary.count)} tool calls`));
        }
        if (description.hasText && ["partial", "truncated"].includes(scenario.userPrompt.status))
            facts.append(el("span", "request-card-availability", "Part of the prompt was retained."));
        if (description.hasText && description.notice) facts.append(el("span", "request-card-availability", description.notice));
        const body = el("div", "card-reading-body"), context = el("div", "card-request-context");
        const orientation = el("div", "card-orientation");
        context.append(header);
        if (!reportPicker && actor === "unknown") context.append(el("p", "request-card-origin-reason", authorship.unverifiedReason(scenario.userPrompt)));
        context.append(prompt, facts, orientation);
        function inspectGap(entry, cue) {
            const exact = callInvestigation.firstToolCall(workspaceState.evidence.requestActivity,
                workspaceState.evidence.scenarios, entry.rows, { ...target, layer }, workspaceState.evidence.revision,
                row => entry.tool ? (row.tool ?? sourceCallFor(row)?.tool) === entry.tool
                    : entry.reason ? row.serviceAssociation?.gaps.some(gap => gap.reason === entry.reason)
                    : ux.operations.pathOperations(row, layer).some(op => op.operationRole === entry.operationRole));
            if (!exact) return cue;
            const link = open("", "record", exact, "card-evidence-link card-gap-link");
            const group = entry.rows.length > 1 ? `first of ${count(entry.rows.length)} calls` : null;
            if (group) cue.lastElementChild.append(document.createTextNode(` (${group})`));
            link.setAttribute("aria-label", `${entry.label}: open ${group ?? "call"}`);
            if (entry.description) { ux.tooltip(link, entry.description); link.setAttribute("aria-description", entry.description); }
            link.append(cue, ux.icon("forward"));
            return link;
        }
        function inspectTool(name) {
            const matching = rows.filter(row => row.tool === name);
            const exact = callInvestigation.firstToolCall(workspaceState.evidence.requestActivity,
                workspaceState.evidence.scenarios, matching, { ...target, layer }, workspaceState.evidence.revision,
                row => (row.tool ?? sourceCallFor(row)?.tool) === name);
            if (!exact) return null;
            const control = open(name, "record", exact, "card-evidence-link");
            control.setAttribute("aria-label", `${name}: open ${matching.length === 1 ? "call" : `first of ${matching.length} calls`}`);
            return control;
        }
        const identities = activityIdentities(rows, layer, layer === "tool" && !reportPicker ? { inspectGap, inspectTool } : {});
        const foot = el("div", "card-reading-actions");
        const exception = activityCardException(layer, rows, summary);
        const exact = (row, layer) => ({ ...target, layer, call: row.id, ...(layer === "reported-api" ? { callRevision: workspaceState.evidence.revision } : {}) });
        function evidenceLink(label, destination) {
            const link = open(label, "record", destination);
            link.classList.add("request-card-exception", "returned-issue-ink");
            link.append(ux.icon("forward"));
            return link;
        }
        if (outcome) {
            const link = statusTarget ? open("", "record", statusTarget)
                : !reportPicker ? open("", "activity") : undefined;
            if (link && !reportPicker) link.classList.add("request-card-open");
            orientation.append(ux.cardOutcome(outcome, link));
        }
        const issues = layer === "tool" ? results.cardIssues(rows, fullRowsFor(scenario.scenarioId, "reported-api"), sourceCallFor) : [];
        if (issues.length) {
            const ordinals = requestContext.actionOrdinals(scenario), ordinal = r => ordinals.get(sourceCallFor(r));
            const list = el("ul", "card-issue-list");
            function problemLine(detail, link) {
                const line = el("div", "card-problem-line");
                if (detail) line.append(el("span", "card-issue-detail", detail));
                if (link) line.append(link);
                return line;
            }
            const ownsBadge = group => group.rows[0].outcome === outcome?.key && group.rows.length === summary[outcome.key];
            if (outcome?.key === "failure" && !issues.some(ownsBadge)) {
                const affected = issues.flatMap(group => group.rows).filter(row => row.outcome === "failure");
                const numbers = affected.map(ordinal), tools = new Set(affected.map(row => row.tool).filter(Boolean));
                if (numbers.length === summary.failure && numbers.every(Number.isSafeInteger))
                    orientation.append(el("span", "card-issue-owner", [results.callGroupLabel(numbers),
                        tools.size === 1 ? [...tools][0] : null].filter(Boolean).join(" · ")));
            }
            for (const group of issues.sort((a,b) => Number(ownsBadge(b)) - Number(ownsBadge(a))
                || Number(b.rows[0].outcome === "failure") - Number(a.rows[0].outcome === "failure")
                || (ordinal(a.rows[0]) ?? Infinity) - (ordinal(b.rows[0]) ?? Infinity))) {
                const first = group.rows[0], numbers = group.rows.map(ordinal);
                const name = [numbers.every(Number.isSafeInteger) && results.callGroupLabel(numbers), first.tool].filter(Boolean).join(" · ");
                const item = el("li", "request-card-cause screen-explanation");
                const owner = el("span", "card-issue-owner", name);
                if (ownsBadge(group)) orientation.append(owner);
                else item.append(owner);
                item.setAttribute("aria-label", name);
                if (group.detail || group.resultIssue) item.append(problemLine(
                    group.detail && callIssueText(group.detail, group.recordedCause),
                    group.resultIssue ? evidenceLink("Tool result", exact(first, "tool")) : null));
                for (const entry of group.entries) {
                    const services = entry.row.serviceAssociation?.services;
                    const service = services?.length === 1 && services[0] !== "Unknown" ? serviceLabel(services[0]) : null;
                    const label = entry.label + (service ? ` · ${service}` : "");
                    const link = evidenceLink(label, exact(entry.row, "reported-api"));
                    link.setAttribute("aria-label", `${name}, ${label}`);
                    const block = problemLine(entry.detail, link);
                    block.classList.add("card-entry-issue");
                    item.append(block);
                }
                list.append(item);
            }
            const feedback = el("div", "card-feedback"), problem = el("div", "card-problem-area");
            problem.append(el("h3", "card-problem-title", "Problem"), list);
            orientation.replaceWith(feedback); feedback.append(orientation, problem);
        }
        if (!outcome) {
            const cue = exception ?? (summary?.count && summary.success === summary.count ? results.labels(layer).success : null);
            if (!reportPicker) {
                const link = open(cue ?? "View interaction", "activity", target, "request-card-open card-evidence-link request-card-exception");
                const arrow = ux.icon("forward");
                link.append(arrow);
                ux.tooltip(link, "View interaction", { anchor: arrow });
                orientation.append(link);
            } else if (cue) foot.append(el("span", "request-card-exception", cue));
        }
        if (reportPicker) {
            const panel = open(full?.count ? `${count(full.count)} ${full.count === 1 ? "tool call" : "tool calls"}` : "Interaction",
                "activity", target, "card-evidence-link request-card-open-label card-panel-link");
            panel.prepend(ux.icon("activity-panel"), ux.icon("activity-panel-close"));
            labelPanelLink(panel, panel.getAttribute("aria-expanded") === "true");
            foot.append(panel);
            body.append(context, identities); row.append(body, foot);
        } else {
            const details = el("div", "card-reading-details");
            details.append(identities);
            const named = namedRequest(scenario.scenarioId);
            if (named) foot.append(namedDrafts.make(named.scenarioId));
            if (hiddenCards.available(scenario.scenarioId)) foot.append(visibilityButton("Hide", "hide", () => setCardVisibility(scenario.scenarioId), "card-hide-action"));
            if (foot.childElementCount) details.append(foot);
            body.append(context, details); row.append(body);
        }
        cardOwners.set(row, events);
        return row;
    }
    function eraseRetiredAttribute(attribute) {
        const owner = attribute.ownerElement;
        if (owner?.namespaceURI !== "http://www.w3.org/2000/svg"
            || !(owner.localName === "svg" && ["width", "height", "viewBox"].includes(attribute.name))
                && !(owner.localName === "rect" && ["width", "height", "x", "y", "rx", "ry"].includes(attribute.name))
                && !(owner.localName === "circle" && ["cx", "cy", "r"].includes(attribute.name))
                && !(owner.localName === "ellipse" && ["cx", "cy", "rx", "ry"].includes(attribute.name))
                && !(["line", "linearGradient"].includes(owner.localName) && ["x1", "x2", "y1", "y2"].includes(attribute.name))
                && !(owner.localName === "stop" && attribute.name === "offset")) attribute.value = "";
        owner?.removeAttributeNode(attribute);
        attribute.value = "";
    }
    function releaseCardPreviews(host) {
        for (const row of host.matches?.(".read-in-place") ? [host] : host.querySelectorAll(".read-in-place")) {
            const events = cardOwners.get(row);
            if (!events) continue;
            events.abort(); cardOwners.delete(row);
            const contents = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            while (contents.nextNode()) contents.currentNode.data = "";
            for (const node of [row, ...row.querySelectorAll("*")]) for (const attr of [...node.attributes]) {
                eraseRetiredAttribute(attr);
            }
            row.replaceChildren();
        }
        for (const preview of host.querySelectorAll("[data-card-preview]")) {
            const link = preview.closest("a"), name = link?.getAttributeNode("aria-label");
            if (name) { name.value = ""; link.removeAttributeNode(name); }
            textAccess.release(preview);
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
    function selectionCheckbox(scenario, reportPicker = false) {
        const checkbox = el("input");
        checkbox.type = "checkbox";
        checkbox.id = (reportPicker ? "report-select-" : "select-request-") + encodeURIComponent(scenario.scenarioId);
        if (reportPicker) checkbox.dataset.reportRequest = scenario.scenarioId;
        else checkbox.dataset.selectedRequest = scenario.scenarioId;
        const aliases = reportPicker ? workspaceState.evidence.exportCatalog.requests.find(request => request.scenarioId === scenario.scenarioId).aliases : [scenario.scenarioId];
        checkbox.checked = aliases.some(id => selected.has(id));
        checkbox.setAttribute("aria-label", "Select request for report: " + shorten(excerpt(scenario), 70));
        ux.tooltip(checkbox, () => checkbox.disabled ? reportSelectionBlock() || "No reportable activity." : "");
        checkbox.addEventListener("change", () => setReportRequestSelected(scenario.scenarioId, checkbox.checked),
            reportPicker ? { signal: reportPickerEvents.signal } : undefined);
        return checkbox;
    }
    function nativeReaderScope() { return JSON.stringify([requestIdentity(), workspaceState.route.origin, fromReportCreation()]); }
    function nativeTargetRoute(target) {
        return routeFor("request", { request: target.conversationId, nativeSource: target.sourceId, nativeRevision: String(target.revision),
            nativeSourceRevision: target.sourceRevision, nativeOrdinal: target.ordinal === undefined ? undefined : String(target.ordinal),
            nativeCompletedRef: target.completedRef });
    }
    function nativeReaderSelectionBlock() {
        return workspaceState.route.nativeSource && (Number(workspaceState.route.nativeRevision) !== workspaceState.evidence?.revision
            || workspaceState.route.nativeSourceRevision !== workspaceState.evidence?.nativeRead?.sourceRevision
            || boundedNative.readerRevision() > Number(workspaceState.route.nativeRevision))
            ? "Reopen this conversation from current activity to change report selection." : "";
    }
    function reportReaderActions(scenarioId) {
        const actions = el("section", "request-actions");
        actions.setAttribute("aria-label", "Report selection");
        const reportTitle = el("span", "muted");
        reportTitle.id = "requestReportTitle";
        const pick = button("Add to report", () => {
            if (!pick.isConnected || workspaceState.route.view !== "request" || workspaceState.route.request !== scenarioId) return;
            const readingBlock = nativeReaderSelectionBlock();
            if (readingBlock) { announce(readingBlock, "stale"); return; }
            if (underlyingRoute().view === "reports" && reportScope !== "selected") {
                announce("Return to report Activity to change this report's scope.", "stale"); return;
            }
            if (!setReportRequestSelected(scenarioId, !reportRequestSelection(scenarioId).selected)) return;
            updateRequestReportActions();
        });
        pick.id = "requestReportToggle";
        const continueReport = button("Continue to report", () => {
            if (!continueReport.isConnected || workspaceState.route.view !== "request" || workspaceState.route.request !== scenarioId) return;
            if (fromReportCreation()) returnFromReportInspection();
            else {
                const readingBlock = nativeReaderSelectionBlock();
                if (readingBlock) { announce(readingBlock, "stale"); return; }
                continueSelectedReport(scenarioId);
            }
        }, "primary");
        continueReport.id = "requestReportContinue";
        actions.append(reportTitle, pick, continueReport);
        ux.explainDisabled(pick, () => nativeReaderSelectionBlock() || reportSelectionBlock() || (underlyingRoute().view === "reports" && reportScope !== "selected"
            ? "Return to report Activity to change this scope." : "This interaction has no reportable activity."), { compact: true });
        ux.explainDisabled(continueReport, () => !fromReportCreation() && nativeReaderSelectionBlock() || reportSelectionBlock() || (underlyingRoute().view === "reports" && reportScope !== "selected"
            ? "Return to report Activity to change this scope." : "Add this interaction before continuing."), { compact: true });
        return actions;
    }
    function renderRequest(references) {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return;
        if (workspaceState.route.view !== "request") return;
        if (pageInactive) return;
        if (hiddenCards.has(workspaceState.route.request)) {
            clearReaderSections(); $("contextSidebarTitle").textContent = "Hidden interaction";
            const body = $("requestContent");
            body.replaceChildren(empty("This card is hidden", "Its prompt and call details are out of view."));
            if (hiddenCards.entries().some(v => v.ref === undoCard)) body.append(undoHideButton());
            const id = workspaceState.route.request;
            if (hiddenCards.available(id)) body.append(visibilityButton("Restore card", "read", () => setCardVisibility(null, [hiddenCards.ref(id)])));
            else body.append(el("p", "context-help-note", hiddenCards.problem()));
            $("contextSidebarFooter").replaceChildren(); return;
        }
        if (requestInvalidated) return;
        if (searchTargetInvalid && workspaceState.route.request === searchOpenedRequest) return;
        if (sourceCollection.active && workspaceState.route.nativeSource && readerSections?.retains?.(nativeReaderScope())) {
            updateRequestReportActions(); return;
        }
        const renderKey = JSON.stringify([requestIdentity(), workspaceState.evidence.revision, workspaceState.evidence.nativeRead?.revision, workspaceState.evidence.assessment?.basis, workspaceState.scope, workspaceState.route.withinServices,
            nativeContextDateBasis(workspaceState.route.request)]);
        if (requestRenderKey === renderKey) { updateRequestReportActions(); return; }
        requestRenderKey = renderKey;
        captureReading();
        clearReaderSections();
        const target = callInvestigation.resolve(workspaceState.evidence.requestActivity, workspaceState.evidence.scenarios, workspaceState.route, workspaceState.evidence.revision);
        const body = $("requestContent");
        renderReportInspectionReturn();
        body.replaceChildren();
        if (workspaceState.route.bookmark && !workspaceState.route.request) {
            body.append(empty("This interaction is unavailable", "Open a current interaction from Analyze."));
            $("contextSidebarFooter").replaceChildren();
            return;
        }
        detailOwner = "request:" + workspaceState.route.request;
        viewKey(body, detailOwner);
        const scopedCalls = workspaceState.route.failedCalls ?? workspaceState.route.completedCalls;
        const stateLabel = workspaceState.route.failedCalls ? "failed" : "completed";
        const countedIds = scopedCalls ? currentOutcomeCalls(workspaceState.route) : null;
        if (scopedCalls && !countedIds) {
            const notice = empty(`These ${stateLabel} calls are unavailable`, "The matching evidence changed. Return to the card to open its current calls.");
            notice.id = "unavailableCall"; notice.tabIndex = -1; body.append(notice);
            return;
        }
        const countedTitle = countedIds ? `${count(countedIds.size)} ${stateLabel} ${countedIds.size === 1 ? "call" : "calls"}` : "";
        if (sourceCollection.active && workspaceState.route.nativeSource !== undefined) {
            const ordinal = workspaceState.route.nativeOrdinal === undefined ? undefined : Number(workspaceState.route.nativeOrdinal);
            const revision = Number(workspaceState.route.nativeRevision);
            const exposed = nativeReportItem(workspaceState.route.request);
            const nativeTarget = { conversationId: workspaceState.route.request, sourceId: workspaceState.route.nativeSource,
                revision, sourceRevision: workspaceState.route.nativeSourceRevision, ordinal, completedRef: workspaceState.route.nativeCompletedRef };
            const currentRoot = workspaceState.evidence.nativeRead?.status === "bounded" && revision === workspaceState.evidence.revision
                && workspaceState.evidence.nativeRead.sourceRevision === workspaceState.route.nativeSourceRevision;
            if (currentRoot) boundedNative.acceptReaderTarget(nativeTarget, workspaceState.evidence.nativeRead);
            const originalRoot = boundedNative.hasReaderTarget(nativeTarget);
            if (!boundedContract.sourceIds.includes(workspaceState.route.nativeSource) || !/^[a-f0-9]{64}$/.test(workspaceState.route.request ?? "")
                || exposed && exposed.sourceId !== workspaceState.route.nativeSource
                || workspaceState.scope.filters.sources?.length && !workspaceState.scope.filters.sources.includes(workspaceState.route.nativeSource)
                    && !selectedNative().items.some(item => item.id === workspaceState.route.request && item.sourceId === workspaceState.route.nativeSource)
                || !Number.isSafeInteger(revision) || revision < 0
                || ordinal !== undefined && (!Number.isSafeInteger(ordinal) || ordinal < 0)
                || !/^[a-f0-9]{64}$/.test(workspaceState.route.nativeSourceRevision ?? "")
                || (nativeTarget.completedRef !== undefined ? !originalRoot : !currentRoot && !originalRoot)) {
                body.append(empty("This exact Microsoft record is unavailable", "The source or saved revision changed. Reopen it from a current page or Search result."));
                return;
            }
            if (ordinal !== undefined) sidebarPositions.delete(requestIdentity());
            readerSections = boundedNative.mountReader({ root: body, ...nativeTarget, scope: nativeReaderScope(),
                isCurrent: () => workspaceState.route.view === "request" && requestRenderKey === renderKey && !requestInvalidated });
            $("contextSidebarFooter").replaceChildren(el("p", "context-help-note",
                "Reports include the complete saved conversation."),
                reportReaderActions(workspaceState.route.request));
            updateRequestReportActions();
            return;
        }
        if (target.status === "unavailable") {
            const notice = empty("This exact record is unavailable", target.reason === "snapshot-changed"
                ? "This API-result link has no matching snapshot revision. Returned-entry identities are not stable across stored revisions. No other entry was substituted. Return to Activity and reopen the result from the current snapshot."
                : "The selected record or its recorded parent is no longer available in this interaction. No nearby action was substituted. Return to results to choose another record.");
            notice.id = "unavailableCall";
            notice.tabIndex = -1;
            body.append(notice);
            return;
        }
        const native = workspaceState.evidence.scenarios.find(record => record.scenarioId === workspaceState.route.request && nativeActivity.isNative(record));
        if (native) {
            readerSections = nativeActivity.mountReader({ root: body, record: native, target, countedIds, countedTitle,
                contextDateBasis: nativeContextDateBasis(native.scenarioId),
                isCurrent: () => workspaceState.route.view === "request" && requestRenderKey === renderKey && !requestInvalidated });
            if (!api.isCurrent(publication) || !readerSections) return;
            const blocked = workspaceState.evidence.exportCatalog?.blockedRequests?.find(item => item.scenarioId === native.scenarioId);
            if (!blocked && workspaceState.evidence.exportCatalog?.requests.some(request => request.scenarioId === native.scenarioId)) {
                $("contextSidebarFooter").append(reportReaderActions(native.scenarioId));
                updateRequestReportActions();
            } else {
                const notice = el("p", "context-help-note", reportUnavailability(blocked) || "Report availability has not been verified for this conversation.");
                const action = button("Add to report", () => {}, "quiet");
                action.disabled = true;
                $("contextSidebarFooter").append(notice, action);
            }
            return;
        }
        const context = requestContext.select(workspaceState.evidence.scenarios, workspaceState.route.request);
        if (!context.groups.length) {
            body.append(empty("This interaction is not available", "It may no longer be in the current local collection. Return to Analyze to choose another interaction."));
            return;
        }
        const contextLimit = target.status === "available"
            ? "Nearby messages are context, not additional matches."
            : context.groups.length > 1 || context.messages.some(message => message.kind === "follow-up") ? "Linked messages may be separate work; this is not the whole chat."
                : null;
        const contextNote = contextLimit ? el("p", "request-context-note", contextLimit) : null;
        const currentReader = () => workspaceState.route.view === "request" && requestRenderKey === renderKey && !requestInvalidated;
        const sections = assessmentFactories.readerSections({
            root: body, presentation, ux, isCurrent: currentReader,
        });
        readerSections = sections;
        const sectionKey = name => JSON.stringify(["reader", workspaceState.route.request, name]);
        const promptSection = sections.add("prompt", "Prompt", { key: "text:request:" + workspaceState.route.request, collapsible: false });
        const activitySection = sections.add("activity", countedTitle || "Recorded activity", { key: sectionKey("activity"), collapsible: false });
        const usageSection = sections.add("usage", "Token & cost breakdown", { key: sectionKey("usage"), collapsible: false });
        assessmentFactories.usageReading(el, usageSection.body, context.groups.find(group => group.relation === "selected").scenario,
            at => time.formatTime(at, workspaceState.scope.timeContext));
        const sourceSection = sections.add("source", "Source details", { key: sectionKey("source"), initialOpen: false });
        let responseSection, responseList;
        const jumps = el("nav", "wire-section-nav reader-section-jumps");
        jumps.setAttribute("aria-label", "In this interaction");
        function sectionJump(section, label, role) {
            const control = button(label, () => {
                if (!currentReader()) return;
                if (!section.isOpen()) section.apply(true, false);
                if (section === promptSection) textAccess.revealPrompt(section.body.querySelector(".full-text"));
                const heading = section.element.querySelector("h2");
                heading.tabIndex = -1;
                heading.focus({ preventScroll: true });
                contextBody.scrollTop += heading.getBoundingClientRect().top - contextBody.getBoundingClientRect().top - 8;
            });
            control.prepend(ux.icon(role));
            section.element.addEventListener("focusin", () => control.setAttribute("aria-current", "location"));
            section.element.addEventListener("focusout", event => {
                if (!section.element.contains(event.relatedTarget)) control.removeAttribute("aria-current");
            });
            return control;
        }
        const sourceJump = sectionJump(sourceSection, "Source", "section-source");
        jumps.append(sectionJump(promptSection, "Prompt", "section-prompt"), sectionJump(activitySection, "Activity", "section-activity"), sourceJump);
        const quickReport = underlyingRoute().view === "analyze" && namedRequest(workspaceState.route.request);
        if (quickReport) jumps.append(namedDrafts.make(quickReport.scenarioId, { reader: true }));
        if (hiddenCards.available(workspaceState.route.request)) {
            const id = workspaceState.route.request;
            jumps.append(visibilityButton("Hide", "hide", () => setCardVisibility(id)));
        }
        body.append(jumps, promptSection.element, activitySection.element, usageSection.element, sourceSection.element);
        const promptList = el("ol", "journey reader-prompt-list");
        promptSection.body.append(promptList);
        const journey = el("ol", "journey request-context-timeline");
        journey.setAttribute("aria-label", "Recorded prompts, calls and replies");
        activitySection.body.append(journey);
        const linkedContext = el("details", "detail-disclosure reader-linked-context");
        const linkedSummary = el("summary", "", "Linked context");
        const linkedList = el("ol", "journey reader-context-list");
        linkedList.setAttribute("aria-label", "Linked messages and activity");
        linkedContext.append(linkedSummary, linkedList);
        const linkedListeners = new Set();
        const linkedVisibility = {
            isCurrent: sourceSection.visibility.isCurrent,
            isOpen: () => sourceSection.visibility.isOpen() && linkedContext.open,
            subscribe(listener) { linkedListeners.add(listener); return () => linkedListeners.delete(listener); },
        };
        const updateLinked = () => {
            if (!currentReader()) return;
            const open = linkedVisibility.isOpen();
            if (!open && linkedList.contains(document.activeElement)) linkedSummary.focus({ preventScroll: true });
            for (const listener of linkedListeners) listener(open);
        };
        bindDetails(linkedContext, sectionKey("linked-context"), updateLinked);
        sourceSection.visibility.subscribe(updateLinked);
        const entries = [], seen = new Set(), rendered = [], responseHosts = [], sourceHomes = new Map(), entryLabels = new Map();
        let commonToolTiming = false;
        const timeContext = workspaceState.scope.timeContext, selectedScenario = context.groups.find(group => group.relation === "selected").scenario;
        function moment(value) {
            if (value === null || value === undefined || value === "") return el("span", "muted", "Not recorded");
            try { time.instant(value); }
            catch (error) {
                if (!(error instanceof RangeError)) throw error;
                return el("span", "reader-time-unverified", "Time not verified: " + (typeof value === "string" ? value : JSON.stringify(value)));
            }
            const node = el("time");
            node.dateTime = value;
            node.tabIndex = 0;
            ux.tooltip(node, value);
            const formatter = new Intl.DateTimeFormat(timeContext.locale, {
                timeZone: timeContext.timeZone, year: "numeric", month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit", second: "2-digit",
                timeZoneName: "shortOffset",
            });
            for (const part of formatter.formatToParts(new Date(value))) {
                node.append(part.type === "timeZoneName" ? el("span", "reader-time-offset", part.value) : document.createTextNode(part.value));
            }
            return node;
        }
        function recordedAt(value) {
            const node = el("p", "reader-recorded-at");
            node.append(value === null || value === undefined || value === "" ? "Recorded time not available." : moment(value));
            return node;
        }
        function identifier(value) { return el("code", "reader-identifier", String(value)); }
        function readerText(source, options) {
            const node = textAccess.render(source, options), coverage = requestTiming.coverage(source);
            readerTextReleases.push(() => textAccess.release(node));
            if (coverage === "Text completeness not verified") node.querySelector(".full-text-qualifiers")
                .append(el("span", "reader-state", coverage));
            if (options.actionsHost === promptSection.actions) {
                const heading = node.querySelector(".full-text-header > h2");
                const label = promptSection.toggle.querySelector("span");
                label.textContent = heading.textContent;
                label.dataset.promptActor = heading.dataset.promptActor;
                label.classList.add("reader-prompt-origin");
                label.prepend(ux.icon("author-" + heading.dataset.promptActor));
                const accessible = el("span", "visually-hidden reader-prompt-role-label", heading.textContent);
                accessible.id = heading.id;
                accessible.dataset.promptActor = heading.dataset.promptActor;
                heading.replaceWith(accessible);
            } else if (options.visibility === linkedVisibility) {
                const heading = node.querySelector(".full-text-header > h2");
                const secondary = el("h3", "reader-context-heading", options.contextTitle + " \u00b7 ");
                const author = el("span", "", heading.textContent);
                author.dataset.promptActor = heading.dataset.promptActor;
                author.classList.add("reader-prompt-origin");
                author.prepend(ux.icon("author-" + heading.dataset.promptActor));
                secondary.id = heading.id;
                secondary.append(author);
                heading.replaceWith(secondary);
            }
            return node;
        }
        function callHeading(name, result, { tool = false, duration, durationLabel = "Call duration" } = {}) {
            const heading = el("header", tool ? "call-heading tool-call-heading" : "call-heading"), identity = el("h3", "reader-call-identity");
            const toolMeta = tool ? el("span", "reader-tool-meta") : null;
            if (tool) { toolMeta.append(el("span", "reader-tool-name", name)); identity.append(toolMeta); }
            else identity.append(el("span", "reader-record-name", name));
            const summary = el("span", "reader-call-summary"), secondary = el("div", "reader-call-secondary");
            if (tool) summary.append(el("span", "reader-outcome-label", "Outcome"));
            summary.append(result);
            if (duration !== undefined) {
                const elapsed = el("span", "reader-call-duration"), value = durationValue(duration, true);
                elapsed.append(el("span", "reader-duration-label", durationLabel + ": "), value);
                if (tool) toolMeta.append(elapsed); else secondary.append(elapsed);
            }
            heading.append(identity, summary, secondary);
            return heading;
        }
        function callToggleName(toggle) {
            const expandedHeader = toggle.closest(".expanded-call");
            if (expandedHeader) {
                const ordinal = expandedHeader.querySelector(".reader-entry-label")?.textContent;
                toggle.setAttribute("aria-label", ordinal ? `Call details: ${ordinal}` : "Call details");
                return;
            }
            const copy = toggle.cloneNode(true);
            copy.querySelectorAll("[hidden]").forEach(node => node.remove());
            toggle.setAttribute("aria-label", "Inspect recorded evidence: " + copy.textContent);
        }
        function callDetails(item, heading, key, visibility, actionId, render) {
            const identity = heading.querySelector(".reader-call-identity");
            const toggle = el("button", "reader-call-toggle");
            toggle.type = "button";
            const line = el("span", "reader-call-identity-line");
            line.append(...identity.childNodes);
            const toolName = line.querySelector(".reader-tool-name")?.textContent;
            const purpose = toolName && ux.operations.toolPurpose(toolName);
            if (purpose) { ux.tooltip(toggle, () => toggle.closest(".expanded-call") ? null : purpose); toggle.setAttribute("aria-description", purpose); }
            const disclosure = ux.icon("disclosure");
            disclosure.classList.add("reader-call-disclosure");
            line.append(disclosure);
            const summary = heading.querySelector(".reader-call-summary");
            toggle.append(line, summary);
            identity.append(toggle);
            const detail = el("div", "technical-detail");
            item.classList.add("reader-call-row");
            item.append(detail);
            if (toolName) {
                // Move the actual evidence and disclosure, not copies: resize must preserve their owner.
                const undo = [];
                let wide = null;
                function move(node, parent) {
                    const slot = document.createComment("docked");
                    node.before(slot); parent.append(node);
                    undo.push(() => slot.replaceWith(node));
                }
                callHeaderLayouts.push(expanded => {
                    if (Boolean(wide) === expanded) return;
                    if (expanded) {
                        wide = el("div", "expanded-call");
                        const bar = el("div", "expanded-call-bar"), lead = el("div", "expanded-call-lead");
                        const title = el("h3", "expanded-call-operation"), meta = el("div", "expanded-call-meta");
                        heading.prepend(wide); wide.append(bar); bar.append(lead, meta); lead.append(title);
                        const operations = heading.querySelector(".reader-call-services .card-identity-field:has([data-operation])");
                        if (operations) {
                            for (const cue of [...operations.querySelector("dd").children]) move(cue, title);
                            operations.hidden = true;
                            undo.push(() => { operations.hidden = false; });
                        } else title.textContent = toolName === "workiq-fetch" ? "Fetch requested" : toolName;
                        const result = summary.querySelector(".recorded-results");
                        if (result) {
                            move(result, lead);
                            for (const note of [...result.querySelectorAll(".result-cause,.returned-coverage")]) {
                                move(note, wide); note.hidden = false;
                            }
                        }
                        for (const node of line.querySelectorAll(".reader-entry-label,.reader-tool-name,.reader-call-duration"))
                            if (!node.matches(".reader-tool-name") || title.textContent !== toolName) move(node, meta);
                        move(toggle, bar); line.hidden = summary.hidden = identity.hidden = true;
                        const label = el("span", "", "Call details");
                        toggle.append(label); move(disclosure, toggle);
                        undo.push(() => label.remove());
                        toggle.removeAttribute("aria-description");
                    } else {
                        for (const restore of undo.splice(0).reverse()) restore();
                        wide.remove(); wide = null; line.hidden = summary.hidden = identity.hidden = false;
                        if (purpose) toggle.setAttribute("aria-description", purpose);
                        if (item.dataset.resultDetails === "true") for (const reason of summary.querySelectorAll(".result-cause"))
                            reason.hidden = !detail.hidden;
                    }
                    callToggleName(toggle);
                });
            }
            sections.detail({ key: JSON.stringify(["call-detail", requestIdentity(), key]), toggle, body: detail, visibility,
                initialOpen: target.status === "available" && target.actionId === actionId && workspaceState.scope.layer !== "reported-api",
                render, onOpenChange: open => {
                    if (item.dataset.resultDetails === "true") toggle.querySelectorAll(".result-cause").forEach(node => { node.hidden = open; });
                    callToggleName(toggle);
                } });
        }
        function identityValues(rows, layer) {
            const identities = serviceIdentity(rows?.length ? rows : undefined, layer, { fieldValue: true }), values = el("ul", "reader-values");
            for (const identity of identities.children.length ? [...identities.children] : [identities]) {
                const item = el("li"); item.append(identity); values.append(item);
            }
            return values;
        }
        function recordedBlock(text, options, visibility = activitySection.visibility) {
            const pre = el("pre", "", text);
            return ux.attachCopy(pre, { ...options,
                getText: () => pre.isConnected && visibility.isCurrent() && visibility.isOpen() ? pre.textContent : null });
        }
        function recordedInput(tool, visibility) {
            const args = tool.requestArgs;
            const capabilityNames = {
                Email: ["Email", "Mail"], TeamsMessages: ["Teams messages", "Teams"],
                OneDriveAndSharePoint: ["OneDrive and SharePoint", "Files"], People: ["People", "People"],
                Meetings: ["Meetings", "Calendar"], Dataverse: ["Dataverse", null], GraphConnectors: ["Connected sources", null],
            };
            const known = args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length
                && Object.keys(args).every(key => ["question", "query", "entityUrls", "capabilities", "timeZone"].includes(key))
                && !(Object.hasOwn(args, "question") && Object.hasOwn(args, "query"))
                && ["question", "query", "timeZone"].every(key => !Object.hasOwn(args, key) || typeof args[key] === "string" && args[key].length > 0)
                && (!Object.hasOwn(args, "entityUrls") || Array.isArray(args.entityUrls) && args.entityUrls.length > 0
                    && args.entityUrls.every(value => typeof value === "string" && value.length > 0))
                && (!Object.hasOwn(args, "capabilities") || Array.isArray(args.capabilities) && args.capabilities.length > 0
                    && args.capabilities.every(value => value && typeof value === "object" && Object.keys(value).length === 1
                        && Object.hasOwn(capabilityNames, value.name)));
            const raw = JSON.stringify(args, null, 2) ?? "[Arguments unavailable]";
            if (!known) {
                const block = recordedBlock(raw, { label: "Recorded input", copyLabel: "Copy recorded arguments" }, visibility);
                block.classList.add("recorded-arguments");
                const section = el("section", "reader-request-block");
                section.append(block);
                return { node: section, targets: false };
            }
            const input = el("section", "reader-input recorded-arguments");
            const prose = args.question ?? args.query;
            const targetOnly = prose === undefined && Boolean(args.entityUrls);
            const heading = el("div", "reader-input-heading");
            heading.append(el("span", "reader-input-label", targetOnly
                ? args.entityUrls.length === 1 ? "Requested path" : "Requested paths" : "Recorded request"));
            input.append(heading);
            if (!targetOnly) {
                input.classList.add("reader-input-copy");
                input.append(ux.copyButton({ label: "Copy recorded arguments", tooltip: "Copy recorded input",
                    getText: () => input.isConnected && visibility.isCurrent() && visibility.isOpen() ? raw : null }));
            }
            const values = el("div", "reader-input-value");
            const remaining = [];
            if (prose !== undefined) values.append(el("pre", "reader-request-text", prose));
            if (args.entityUrls) {
                const paths = targetOnly
                    ? el(args.entityUrls.length === 1 ? "ul" : "ol", "reader-values reader-request-paths")
                    : el("dl", "action-fields reader-request-paths");
                results.callPaths(tool).forEach((path, index) => {
                    if (targetOnly) {
                        const item = el("li");
                        item.append(recordedPathValue(path));
                        paths.append(item);
                    } else pathField(paths, args.entityUrls.length === 1 ? "Requested path" : "Requested path " + (index + 1), path);
                });
                values.append(paths);
            }
            if (args.capabilities) {
                const list = el("ul", "reader-values");
                for (const capability of args.capabilities) {
                    const [label, service] = capabilityNames[capability.name], item = el("li");
                    item.append(service ? serviceCue("span", service, { ...categories.describe(service), label }) : el("span", "", label));
                    list.append(item);
                }
                if (prose === undefined && !args.entityUrls) values.append(fields([["Requested sources", list]]));
                else remaining.push(["Requested sources", list]);
            }
            if (args.timeZone !== undefined) remaining.push(["Time zone", args.timeZone]);
            input.append(values);
            if (remaining.length) input.append(fields(remaining));
            return { node: input, targets: Boolean(args.entityUrls) };
        }
        const responseTime = responseTimingFact(selectedScenario);
        responseTime.firstElementChild.textContent = "Prompt to final response";
        const relationLabel = relation => relation === "selected" ? "Selected interaction"
            : relation === "preceding" ? "Earlier linked context" : "Following linked context";
        function insertEntry(entry) {
            const content = entry.render(), item = content.tagName === "LI" ? content : el("li", "journey-item");
            if (content !== item) item.append(content);
            item.dataset.contextGroup = entry.scenarioId;
            item.dataset.contextKind = entry.kind ?? "action";
            if (entry.actionId) item.dataset.actionId = entry.actionId;
            viewKey(item, entry.key);
            const labelText = entry.kind === "prompt" && entry.relation === "selected" ? "Selected prompt"
                : entry.kind === "prompt" ? entry.relation === "preceding" ? "Earlier linked message" : "Next linked message"
                : entry.kind === "follow-up" ? "Follow-up message" : entryLabels.get(entry.key) ?? "Recorded response";
            const identity = entry.kind === "action" ? item.querySelector(":scope > .call-heading .reader-call-identity") : null;
            const label = el(identity ? "span" : "p", "context-entry-label"), separator = labelText.indexOf(":");
            if (separator >= 0) label.append(el("strong", "", labelText.slice(0, separator + 1)), document.createTextNode(labelText.slice(separator + 1)));
            else label.textContent = labelText;
            if (identity) (identity.querySelector(".reader-call-identity-line") || identity).prepend(label, document.createTextNode(" "));
            else item.prepend(label);
            if (entry.hideLabel || entry.kind === "follow-up" || entry.kind === "prompt" && entry.relation !== "selected") label.remove();
            if (entry.kind === "action") label.classList.add("reader-entry-label");
            if (entry.recordKind === "tool") {
                for (const parent of item.querySelectorAll(".returned-call-parent")) parent.prepend(labelText + " · ");
                for (const results of item.querySelectorAll(":scope > .returned-api-entries, :scope > .selected-api-result, :scope > .reader-returned-facts > .returned-api-entries")) {
                    results.setAttribute("role", "group");
                    results.setAttribute("aria-label", "Returned results for " + labelText);
                }
            }
            const toggle = identity?.querySelector(".reader-call-toggle");
            if (toggle) callToggleName(toggle);
            if (entry.actionId) item.id = "reader-record-" + encodeURIComponent(entry.actionId);
            if (entry.kind === "prompt" && entry.relation === "selected") {
                item.id = "selectedContext";
                if (target.status !== "available") item.setAttribute("aria-current", "true");
                label.remove();
            }
            if (entry.kind === "follow-up" || entry.kind === "prompt" && entry.relation !== "selected") item.append(recordedAt(entry.at));
            if (target.status === "available" && entry.actionId === target.actionId && entry.scenarioId === workspaceState.route.request) {
                item.dataset.selectedAction = "true";
                label.classList.add("context-selected-label");
                label.prepend(document.createTextNode(workspaceState.scope.layer === "reported-api" ? "Parent of selected API result / " : "Selected record / "));
                if (workspaceState.scope.layer !== "reported-api") {
                    item.id = "selectedCall";
                    item.tabIndex = -1;
                    item.setAttribute("aria-current", "true");
                }
            }
            const host = entry.kind === "follow-up" || entry.relation !== "selected" ? linkedList
                : entry.kind === "prompt" ? promptList : entry.kind === "response" ? responseList : journey;
            const next = rendered.find(other => other.node.parentElement === host && requestContext.compare(entry, other) < 0);
            host.insertBefore(item, next?.node ?? null);
            const index = rendered.findIndex(other => requestContext.compare(entry, other) < 0);
            if (index < 0) rendered.push({ ...entry, node: item });
            else rendered.splice(index, 0, { ...entry, node: item });
            detailOwner = "request:" + workspaceState.route.request;
        }
        references ??= chatCopy.references(workspaceState.evidence.sessions, workspaceState.evidence.scenarios);
        for (const group of context.groups) {
            if (hiddenCards.has(group.scenario.scenarioId)) continue;
        const scenario = group.scenario, isSelected = group.relation === "selected";
        const groupVisibility = isSelected ? activitySection.visibility : linkedVisibility;
        detailOwner = "request:" + scenario.scenarioId;
        const rows = rowsFor(scenario.scenarioId);
        const full = fullRowsFor(scenario.scenarioId);
        const sameScope = full && full.length === rows.length && full.every(row => rows.some(match => match.id === row.id));
        const intro = el("div", "request-intro");
        const source = sessionSource(scenario.sourceSessionId);
        const sourceProject = source || scenario;
        const originKind = authorship.originKind?.(scenario);
        if (countedIds && isSelected) {
            const allCalls = results.summarize(fullRowsFor(scenario.scenarioId, "tool"))?.count;
            if (allCalls > countedIds.size) {
                intro.append(el("p", "reader-scope", `${count(countedIds.size)} of ${count(allCalls)} recorded calls match this view.`));
                const parent = routeFor("request", { request: scenario.scenarioId });
                activitySection.actions.append(routeLink("Show full activity", parent, "button-link quiet", {
                    cardTarget: { target: parent, revision: workspaceState.evidence.revision, focus: "activity" },
                }));
            }
        } else if (!sameScope) intro.append(el("p", "reader-scope", full
            ? `${count(rows.length)} of ${count(full.length)} ${results.unit(workspaceState.scope.layer, full.length)} match the current view. The full recorded interaction follows.`
            : "Matching context unavailable. The retained interaction follows."));
        const requestText = el("section", isSelected ? "request-original" : "request-context-prompt");
        requestText.append(readerText(scenario.userPrompt, {
            key: "request:" + scenario.scenarioId, mode: "complete", initialOpen: true, contentFirst: true,
            previewTitle: isSelected ? promptSection.toggle : undefined,
            originKind, visibility: isSelected ? promptSection.visibility : linkedVisibility,
            actionsHost: isSelected ? promptSection.actions : undefined,
            contextTitle: isSelected ? undefined : group.relation === "preceding" ? "Earlier message" : "Following message",
            copyLabel: isSelected ? undefined : group.relation === "preceding" ? "Copy earlier message" : "Copy following message",
            notice: "Copy includes the complete retained prompt body only, without export masking. It does not include chat details, warnings, the response or the rest of this page. Other apps and clipboard history may access your system clipboard.",
        }));
        if (isSelected) {
            const recorded = requestTiming.entry(scenario, timeContext);
            requestText.append(el("p", "reader-recorded-at reader-interaction-time",
                (recorded.label === "Message recorded" ? "" : recorded.label + ": ") + recorded.value));
        }
        const modelFact = el("dl", "reader-fields interaction-model-fact"), model = originalModelFact(scenario);
        model.firstElementChild.textContent = model.firstElementChild.textContent.replace(/:$/, "");
        modelFact.append(model);
        const readerFacts = el("div", "reader-facts");
        const sourceFacts = el("dl", "reader-fields reader-source");
        const identity = filterState.sourceIdentity(rows);
        if (showSourceChoice() && (identity || workspaceState.evidence.nativeRead)) {
            sourceFacts.append(cardFact("Source", identity?.label ?? "Source unavailable"));
            if (identity) sourceFacts.dataset.sourceId = identity.id;
        }
        appendCardSource(sourceFacts, scenario, { compact: true, includeModel: false, includeTime: false, includeProject: false, references });
        for (const term of sourceFacts.querySelectorAll("dt")) term.textContent = term.textContent.replace(/:$/, "");
        if (isSelected) readerFacts.append(sourceFacts);
        readerFacts.append(modelFact);
        readerFacts.append(fields([["Project", sourceProject.projectId ? sourceProject.project || sourceProject.projectId
            : sourceProject.sessionId || sourceProject.sourceSessionId ? "No project associated" : "Not recorded"]]));
        (isSelected ? sourceSection.body : requestText).append(readerFacts);
        if (isSelected) {
            const timing = el("div", "reader-prompt-timing");
            timing.append(recordedAt(scenario.userPrompt?.sourceTimestamp));
            if (!responseTime.hidden) {
                const responseTiming = el("dl", "reader-fields reader-response-timing");
                responseTiming.append(responseTime);
                timing.append(responseTiming);
            }
            sourceSection.body.append(timing);
        }
        const responseHost = el("section", "interaction-response");
        responseHost.classList.add("reader-response-availability");
        responseHost.dataset.contextGroup = scenario.scenarioId;
        if (isSelected) {
            for (const gap of context.gaps) intro.append(el("p", "reader-empty", gap));
            activitySection.body.prepend(intro);
        }
        entries.push({ key: "prompt:" + scenario.scenarioId, at: scenario.userPrompt?.sourceTimestamp,
            scenarioId: scenario.scenarioId, relation: group.relation, kind: "prompt", render: () => {
                const item = el("li", "journey-item");
                item.append(requestText);
                return item;
            } });
        responseHosts.push({ scenarioId: scenario.scenarioId, relation: group.relation, host: responseHost });
        assessmentUI.detail(responseHost, scenario.scenarioId, { eager: true, contentFirst: true,
            recordedTimingHome: isSelected && !responseTime.hidden ? responseTime : null,
            placeResponse: (node, observation, position) => {
            if (!journey.isConnected || !currentReader()) return;
            if (isSelected && !responseSection) {
                responseSection = sections.add("response", "Copilot reply", { key: sectionKey("response") });
                responseList = el("ol", "journey reader-response-list");
                responseSection.body.append(responseList);
                sourceSection.element.before(responseSection.element);
                sourceJump.before(sectionJump(responseSection, "Reply", "section-reply"));
            }
            const responseName = (isSelected ? "Response" : group.relation === "preceding" ? "Earlier linked response" : "Following linked response")
                + (position?.total > 1 ? " " + (position.index + 1) : "");
            insertEntry({ key: "response:" + observation.observationRef, at: observation.occurredAt,
                scenarioId: scenario.scenarioId, relation: group.relation, kind: "response", hideLabel: true, render: () => {
                    const item = el("li", "journey-item");
                    item.append(node, recordedAt(observation.occurredAt));
                    return item;
                } });
            sections.refresh();
            return { visibility: isSelected ? responseSection.visibility : linkedVisibility,
                actionsHost: isSelected && position?.total === 1 ? responseSection.actions : undefined,
                copyLabel: isSelected && position?.total === 1 ? undefined : "Copy " + responseName.toLowerCase(),
                headingLabel: responseName };
        } });
        const original = scenario.userPrompt;
        const support = el("div", "request-support");
        const provenance = el("div", "reader-source-record");
        provenance.dataset.contextGroup = scenario.scenarioId;
        if (context.groups.length > 1) provenance.append(el("h3", "reader-source-heading", relationLabel(group.relation)));
        const association = scenario.workloadKind === "recorded-history" ? authorship.requestLink(scenario).note : scenario.promptAssociation;
        const coverage = scenario.coverageNote === "Recorded Work IQ invocation, not observed Graph HTTP. Result entity/body content excluded. Missing completions and truncated logs are disclosed in the source roster."
            && !scenario.toolCalls?.some(tool => tool.observedGraphHttp)
            ? "These records show Work IQ calls, not Graph traffic or returned content." : scenario.coverageNote;
        const identifiers = [
            ["Source event", original?.sourceEventId ?? "Not recorded"],
            ["Chat ID", scenario.sourceSessionId ?? "Not recorded"],
        ];
        const limits = el("div", "reader-record-limits");
        if (association) limits.append(el("p", "", association));
        if (isSelected && authorship.read(original).actor === "unknown") {
            const version = authorship.savedVersion(original);
            limits.append(el("p", "", `${version === null ? "Author rule version unavailable" : `Saved author rule v${version}`} · View revision ${workspaceState.evidence.revision}`));
        }
        if (coverage) limits.append(el("p", "", coverage));
        provenance.append(limits);
        support.append(provenance);
        sourceHomes.set(scenario.scenarioId, { provenance, identifiers });
        sourceSection.body.append(support);
        for (const message of context.messages.filter(message => message.scenarioId === scenario.scenarioId && message.kind === "follow-up")) {
            const followup = el("section", "request-context-prompt");
            followup.append(readerText(message.source, { key: message.key, mode: "complete", initialOpen: false, contentFirst: true,
                originKind, visibility: linkedVisibility, contextTitle: "Following message", copyLabel: "Copy following message" }));
            if (message.source.association) followup.append(el("p", "context-help-note",
                message.source.association === "Nearest following user message only; follow-up relationship inferred, not confirmed."
                    ? "This is the next saved message, not a confirmed follow-up." : message.source.association));
            entries.push({ ...message, relation: group.relation, render: () => followup });
        }
        const actions = quickReport ? null : reportReaderActions(scenario.scenarioId);
        const entryStart = entries.length;
        const ordinals = requestContext.actionOrdinals(scenario);
        const canonical = fullRowsFor(scenario.scenarioId, "tool") ?? (workspaceState.scope.layer === "tool" ? rows : undefined);
        for (const [toolIndex, member] of (scenario.toolCalls || []).entries()) {
            const matches = canonical?.filter(item => {
                if (item.sourceSessionId !== scenario.sourceSessionId) return false;
                if (member.toolCallId && item.toolCallId) return member.toolCallId === item.toolCallId;
                if (!member.startEventId) return false;
                return item.toolCallId ? sourceCallFor(item)?.startEventId === member.startEventId
                    : item.id === `event:${JSON.stringify([scenario.sourceSessionId, member.startEventId])}`;
            });
            const row = matches?.length === 1 ? matches[0] : null;
            if (row && (seen.has(row.id) || !isSelected && (row.id === target.actionId || countedIds?.has(row.id)))) continue;
            if (row) seen.add(row.id);
            const key = JSON.stringify([scenario.scenarioId, "tool", row?.id || member.toolCallId || member.startEventId || ["unidentified", workspaceState.evidence.revision, toolIndex]]);
            // The selected interaction supplies the ordinal; the canonical owner supplies the entire call.
            const tool = row ? sourceCallFor(row) : matches?.length ? null : member;
            const ordinal = ordinals.get(member);
            if (!tool) {
                entries.push({ key, actionId: row?.id, recordKind: "tool", ordinal,
                    render: () => el("p", "reader-empty", "The source record for this tool call could not be identified.") });
                continue;
            }
            const hasInputReferences = Array.isArray(tool.requestArgs?.fileUrls) && tool.requestArgs.fileUrls.length > 0;
            const attribution = categories.attributionReading(row ? { ...row, tool: tool.tool } : undefined, "tool", { hasInputReferences });
            entries.push({ key, actionId: row?.id, startedAt: tool.startedAt, recordKind: "tool", ordinal,
                identifiers: [["ID", tool.toolCallId], ["start event", tool.startEventId], ["completion event", tool.completionEventId],
                    ["parent invocation", tool.parentToolCallId], ["parallel group", tool.parallelGroup],
                    ["error code", row?.outcome === "failure" && tool.failureEvidence?.version === 1
                        && tool.failureEvidence.reason === "error-code-recorded" ? tool.failureEvidence.code : null]], render: () => {
            detailOwner = key;
            const item = viewKey(el("li", "journey-item"), key);
            item.dataset.toolCallId = tool.toolCallId || "";
            item.dataset.resultDetails = String(results.resultDetails(tool.resultEvidence).length > 0
                || results.diagnosticDetails(tool.failureEvidence?.diagnostic).length > 0);
            const operation = categories.operation(tool.tool);
            const recordLabel = callOutcomeLabel(row?.outcome);
            const apiRows = fullRowsFor(scenario.scenarioId, "reported-api")?.filter(r => r.parentCallId === row?.id);
            const issue = row?.outcome === "failure" && apiRows?.length && results.cardIssues([row], apiRows, () => tool)[0];
            const echoedCode = Boolean(issue && issue.detail === null && issue.entries.length && issue.recordedCause);
            // The call's bare BadRequest glossary adds nothing when its own entry supplies the specific diagnostic.
            const explainedBadRequest = echoedCode && issue.entries.some(({row: entry, code}) => {
                const diagnostic = results.returnedResult(tool, entry)?.errorDiagnostic;
                return code === "BadRequest" && diagnostic?.message && diagnostic.status === "recorded"
                    && !/^(?:error|failure|bad\s?request|invalid request)[.!]?$/i.test(diagnostic.message.trim());
            });
            const result = resultLine("tool", row ? results.summarize([row]) : null, { heading: results.heading("tool"), compactSingle: true, singleRecord: true, recordLabel, rows: row ? [row] : undefined, inline: true, includeReturned: !apiRows?.length, omitCallKind: explainedBadRequest ? "http-400" : undefined });
            result.classList.add("journey-result");
            const heading = callHeading(tool.tool || "Tool not recorded", result, { tool: true, duration: callInvestigation.duration(tool, "tool") });
            if (!(scenario.usage && tool.usageContextLinked) && Number.isSafeInteger(tool.returnedTextBytes)) heading.querySelector(".reader-tool-meta").append(el("span", "reader-call-duration",
                `~${count(Math.round(tool.returnedTextBytes / 4))} returned context tokens`));
            item.append(heading);
            const explanations = [...heading.querySelectorAll('[data-interpretation="true"]')];
            explanations.forEach(node => node.remove());
            if (echoedCode) {
                // The call's code matches an entry and has no independent explanation.
                heading.querySelector(".reader-issue-note")?.remove();
            }
            for (const list of heading.querySelectorAll(".call-reason-list:empty")) list.remove();
            const serviceValues = activityIdentities(row ? [{ ...row, tool: tool.tool }] : undefined, "tool", { includeTools: false });
            serviceValues.classList.add("reader-call-services");
            if (serviceValues.childElementCount) heading.querySelector(".reader-call-secondary").prepend(serviceValues);
            if (attribution && attribution.kind !== "operation") {
                const context = el("p", "reader-call-evidence reader-attribution-context", attribution.text);
                context.dataset.attributionKind = attribution.kind;
                item.append(context);
            }
            if (!sameScope && !(isSelected && countedIds)) {
                actionContext(item, workspaceState.scope.layer === "tool" ? (row ? [row] : canonical ? [] : undefined) : workspaceState.scope.layer === "reported-api" ? apiRows : []);
                const scope = item.querySelector(".action-context");
                if (workspaceState.scope.layer === "tool" && row && rows.some(match => match.id === row.id)) scope.textContent = "Matches current view";
            }
            if (row) {
                const returned = returnedDetails(tool, row, apiRows,
                    workspaceState.scope.layer === "reported-api" && target.actionId === row.id ? target.row.id : undefined);
                if (returned && canonical.length > 1 && workspaceState.scope.layer === "tool"
                    && !apiRows.some(entry => ["failure", "transport"].includes(entry.outcome)
                        || results.returnedResult(tool, entry)?.errorCode || results.diagnosticDetails(results.returnedResult(tool, entry)?.errorDiagnostic).length)) {
                    const detail = el("details", "reader-returned-facts");
                    detail.append(el("summary", "", `${count(apiRows.length)} returned ${apiRows.length === 1 ? "entry" : "entries"}`), returned);
                    item.append(detail);
                } else if (returned) item.append(returned);
            }
            if (explanations.length) {
                const interpretation = el("div", "reader-interpretation call-reason-list");
                interpretation.setAttribute("role", "list"); interpretation.append(...explanations);
                item.append(interpretation);
            }
            callDetails(item, heading, key, groupVisibility, row?.id, visibility => {
            const expert = el("div");
            expert.append(fields([["Recorded start", moment(tool.startedAt)],
                ["Recorded end", tool.completedAt == null ? null : moment(tool.completedAt)]]));
            const input = recordedInput(tool, visibility);
            if (!input.targets) {
                const targets = actionFields(tool, row, { includeTool: false, includeService: false, includePurpose: false, includeMissing: false });
                if (targets.childElementCount) expert.append(targets);
            }
            const serviceEvidence = categories.serviceEvidence(row ? { ...row, tool: tool.tool } : row, "tool");
            const explanation = el("p", "reader-call-evidence", tool.tool === "workiq-get_schema"
                ? "This checks how to use a Work IQ feature; it does not run it."
                : serviceEvidence?.reason === "missing-target" ? ""
                : serviceEvidence?.reason === "hosted-routing" ? serviceEvidence.description
                : tool.tool === "workiq-ask" ? categories.operation(tool.tool).description
                : (row ? categories.explainRows([row], "tool") : "") || serviceEvidence?.description || operation?.description);
            if (!apiRows && row?.workload !== "Discovery") explanation.append(" API result metadata is unavailable.");
            if (attribution?.kind === "operation") expert.append(el("p", "reader-call-evidence", attribution.text));
            else if (!attribution && explanation.textContent.trim()) expert.append(explanation);
            const consistentCompletion = row?.outcome === "success" && tool.reportedOutcome === "succeeded" && tool.toolSucceeded === true
                || row?.outcome === "failure" && tool.reportedOutcome === "failed" && tool.toolSucceeded === false;
            const completion = fields([
                ...(row?.outcome === "success" ? [["Completion evidence", tool.completionEventId
                    ? "The source recorded a successful tool completion. This does not establish answer correctness or overall task success."
                    : "The tool reported success, but no completion event reference was saved."]] : []),
                ...consistentCompletion ? [] : [["Reported outcome", tool.reportedOutcome], ["Execution success", tool.toolSucceeded]],
            ]);
            if (completion.childElementCount) expert.append(completion);
            if (tool.observedGraphHttp) expert.append(el("p", "reader-record-limits", "HTTP directly observed."));
            const resultFacts = resultDetailBlock(results.resultDetails(tool.resultEvidence, { retainedResultCount: tool.apiResults?.length,
                omitContent: row?.outcome === "failure" && tool.resultEvidence?.contentStatus === "not-supplied"
                    || Boolean(apiRows?.length) && tool.resultEvidence?.contentStatus === "partial" }),
                { errorContext: row?.outcome === "failure" || tool.resultEvidence?.applicationError === true });
            if (resultFacts) expert.append(resultFacts);
            if (row?.outcome === "failure") {
                const diagnostic = failureDiagnostic(tool.failureEvidence?.diagnostic, {
                    statusShown: tool.resultEvidence?.statusCode != null
                        && tool.resultEvidence.statusCode === tool.failureEvidence?.diagnostic?.statusCode,
                });
                if (diagnostic) expert.append(diagnostic);
            }
            expert.append(input.node);
            for (const key of ["command", "code", "script"]) if (typeof tool.requestArgs?.[key] === "string") expert.append(recordedBlock(tool.requestArgs[key], { label: "Recorded " + key, copyLabel: "Copy " + key }, visibility));
            return expert;
            });
            return item;
            } });
        }
        for (const [graphIndex, graph] of (scenario.graphActivities || []).entries()) {
            const layer = graph.evidenceLevel === "code-reference" ? "code-reference" : "direct-request";
            const graphRows = fullRowsFor(scenario.scenarioId, layer)?.filter(row => row.activityId === graph.activityId);
            if (graphRows?.[0] && (seen.has(graphRows[0].id) || graphRows[0].id === target.actionId && !isSelected)) continue;
            if (graphRows?.[0]) seen.add(graphRows[0].id);
            const key = JSON.stringify([scenario.scenarioId, "graph", graph.activityId || ["unidentified", workspaceState.evidence.revision, graphIndex]]);
            entries.push({ key, actionId: graphRows?.[0]?.id, startedAt: graph.startedAt, recordKind: layer === "code-reference" ? "reference" : "graph", ordinal: ordinals.get(graph),
                identifiers: [["ID", graph.activityId]], render: () => {
            detailOwner = key;
            const item = viewKey(el("li", "journey-item"), key);
            const heading = callHeading(layer === "code-reference" ? "Graph code reference" : "Direct Graph request site",
                resultLine(layer, graphRows?.length ? results.summarize(graphRows) : null, { compactSingle: true, singleRecord: true, inline: true }));
            item.append(heading, fields([[layer === "code-reference" ? "Referenced service" : "Service", identityValues(graphRows, layer)]]));
            const path = el("dl", "action-fields");
            pathField(path, layer === "code-reference" ? "Referenced API path" : "API path", results.pathText(graph.endpoint));
            item.append(path);
            actionContext(item, ["direct-request", "recorded-http", "code-reference"].includes(workspaceState.scope.layer) ? graphRows : []);
            const status = graph.evidenceLevel === "output-visible-http" ? graph.httpStatus : null;
            item.append(el("p", "", status != null ? "Visible HTTP status: " + status : graph.evidenceLevel === "code-reference" ? "Code reference only; execution is not established." : "No HTTP status observed in this record."));
            callDetails(item, heading, key, groupVisibility, graphRows?.[0]?.id, visibility =>
                recordedBlock(JSON.stringify(graph, null, 2), { label: "Recorded Graph evidence / local only", copyLabel: "Copy recorded Graph evidence" }, visibility));
            return item;
            } });
        }
        for (const [recordIndex, record] of (scenario.httpRecords || []).entries()) {
            const httpRows = fullRowsFor(scenario.scenarioId, "http")?.filter(row => row.recordId === record.recordId);
            if (httpRows?.[0] && (seen.has(httpRows[0].id) || httpRows[0].id === target.actionId && !isSelected)) continue;
            if (httpRows?.[0]) seen.add(httpRows[0].id);
            const key = JSON.stringify([scenario.scenarioId, "http", record.recordId || ["unidentified", workspaceState.evidence.revision, recordIndex]]);
            entries.push({ key, actionId: httpRows?.[0]?.id, startedAt: record.startedAt, recordKind: "http", ordinal: ordinals.get(record),
                identifiers: [["ID", record.recordId]], render: () => {
            detailOwner = key;
            const item = viewKey(el("li", "journey-item"), key);
            const heading = callHeading("Explicit HTTP recorder", resultLine("http", httpRows?.length ? results.summarize(httpRows) : null, { compactSingle: true, singleRecord: true, inline: true }),
                { duration: callInvestigation.duration(record, "http"), durationLabel: "Recorded duration" });
            item.append(heading, fields([["Service", identityValues(httpRows, "http")]]),
                el("p", "", record.status == null ? "No HTTP response recorded." : "Recorded HTTP status " + record.status));
            actionContext(item, workspaceState.scope.layer === "http" ? httpRows : []);
            const path = el("dl", "action-fields");
            pathField(path, "API path", results.pathText(record.responsePath ?? record.path ?? record.requestedPath ?? record.requestShape?.path));
            item.append(path);
            callDetails(item, heading, key, groupVisibility, httpRows?.[0]?.id, visibility =>
                recordedBlock(JSON.stringify(record, null, 2), { label: "Recorder details / local only", copyLabel: "Copy recorder details" }, visibility));
            return item;
            } });
        }
        for (const entry of entries.slice(entryStart)) Object.assign(entry, {
            at: entry.startedAt, scenarioId: scenario.scenarioId, relation: group.relation, kind: "action",
        });
        if (entryStart === entries.length) (isSelected ? intro : requestText).append(el("p", "reader-empty",
            isSelected && context.groups.length > 1 ? "No individual action details were retained for the selected interaction." : "No individual action details were retained."));
        if (isSelected) $("contextSidebarFooter").replaceChildren(...(actions ? [actions] : []));
        for (const item of workspaceState.analytics.journeys || []) {
            if (item.scenarioId !== scenario.scenarioId || item.association === "none") continue;
            const relation = item.association === "same-prompt-after-failure" ? "A Graph request follows a Work IQ failure in this prompt group." : item.association === "explicit-transition" ? "The record contains an explicit transition to Graph." : "Work IQ and Graph activity occur in the same prompt group.";
            provenance.append(el("p", "context-help-note", relation + " This is sequence evidence; it does not prove why the assistant chose Graph."));
        }
        detailOwner = "request:" + scenario.scenarioId;
        }
        entries.sort(requestContext.compare);
        const actionsInOrder = entries.filter(entry => entry.kind === "action");
        const selectedActions = actionsInOrder.filter(entry => entry.scenarioId === workspaceState.route.request);
        commonToolTiming = workspaceState.scope.layer === "tool" && selectedActions.length > 0 && selectedActions.every(entry => entry.recordKind === "tool");
        body.classList.toggle("tool-activity-log", commonToolTiming);
        if (commonToolTiming) {
            const heading = activitySection.element.querySelector(".reader-section-heading");
            const measureHeading = () => {
                if (!currentReader() || !heading.isConnected) return;
                body.style.setProperty("--reader-timing-padding", getComputedStyle(contextBody).paddingTop);
                body.style.setProperty("--reader-timing-inset", timingInset(heading) + "px");
            };
            measureHeading();
            timingHeadingObserver = new ResizeObserver(measureHeading);
            timingHeadingObserver.observe(heading);
        }
        actionsInOrder.forEach(entry => {
            const ordinal = entry.ordinal;
            const label = entry.recordKind === "tool" ? results.callLabel(ordinal)
                : ({ reference: "Reference", graph: "Request site", http: "HTTP record" })[entry.recordKind] + " " + ordinal;
            entryLabels.set(entry.key, label);
            const home = sourceHomes.get(entry.scenarioId);
            home.identifiers.push(...(entry.identifiers ?? []).filter(([, value]) => value != null && value !== "")
                .map(([kind, value]) => [label + " " + kind, value]));
        });
        if (commonToolTiming && !countedIds) activitySection.toggle.querySelector("span").textContent =
            `${count(selectedActions.length)} recorded ${selectedActions.length === 1 ? "call" : "calls"}`;
        for (const [scenarioId, home] of sourceHomes) {
            const toggle = el("button", "quiet reader-identifiers-toggle", "Record identifiers");
            toggle.type = "button";
            const detail = el("div", "reader-identifiers");
            home.provenance.append(toggle, detail);
            sections.detail({ key: sectionKey("identifiers:" + scenarioId), toggle, body: detail,
                visibility: sourceSection.visibility, render: () => fields(home.identifiers.map(([name, value]) => [name, identifier(value)])) });
        }
        for (const entry of entries) {
            if (countedIds && entry.scenarioId === workspaceState.route.request && entry.kind === "action"
                && !(entry.recordKind === "tool" && countedIds.has(entry.actionId))) continue;
            insertEntry(entry);
        }
        for (const { scenarioId, relation, host } of responseHosts) {
            if (relation === "selected") sourceSection.element.before(host);
            else {
                const last = rendered.filter(entry => entry.scenarioId === scenarioId && ["prompt", "action"].includes(entry.kind)).at(-1);
                const item = el("li", "journey-item reader-context-response");
                item.dataset.contextGroup = scenarioId;
                item.append(host);
                if (last) last.node.after(item);
            }
        }
        const selectedRecord = target.status === "available" ? body.querySelector("#selectedCall") : null;
        if (selectedRecord && contextNote) selectedRecord.prepend(contextNote);
        if (linkedList.children.length) {
            linkedContext.append(el("p", "context-help-note", context.boundary), el("p", "context-help-note", context.limitation));
            sourceSection.body.append(linkedContext);
        }
        const evidenceScope = el("p", "reader-evidence-scope");
        evidenceScope.append(link("Collection coverage", "collection-status", { setting: "collection-details" }, "text-link"));
        sourceSection.body.append(evidenceScope);
        detailOwner = "request:" + workspaceState.route.request;
        for (const layout of callHeaderLayouts) layout(contextSidebar.dataset.mode === "expanded");
        sections.refresh();
        updateRequestReportActions();
    }
    function updateRequestReportActions() {
        if (workspaceState.route.view !== "request" || !$("requestReportToggle")) return;
        const membership = reportRequestSelection(workspaceState.route.request);
        const pick = $("requestReportToggle"), next = $("requestReportContinue"), title = $("requestReportTitle");
        const fixedScope = underlyingRoute().view === "reports" && reportScope !== "selected";
        const reportOrigin = fromReportCreation();
        const readingBlock = nativeReaderSelectionBlock();
        setText(pick, membership.selected ? "Remove from report" : "Add to report");
        pick.hidden = fixedScope || Boolean(periodReport);
        pick.disabled = Boolean(readingBlock) || membership.disabled || fixedScope;
        setText(next, reportOrigin ? reportSetupReturn?.peek ? "Back to report setup" : "Back to activity" : "Continue to report");
        next.disabled = reportOrigin ? exportWriting : Boolean(readingBlock) || membership.disabled || fixedScope || !membership.selected;
        next.hidden = !reportOrigin && !membership.selected;
        setText(title, readingBlock || (periodReport ? "This report uses fixed paired periods. Return to Compare to change its activity."
            : fixedScope ? membership.included ? "Included by this report's activity scope. Change the scope in Activity."
                : "Not included with this report's scope and author choices. Change them in Activity."
            : membership.selected && !membership.included ? "Selected; not included with current report choices."
            : !membership.selected && membership.included ? "Included through the current report scope." : ""));
        title.hidden = !title.textContent;
        const block = reportSelectionBlock();
        ux.tooltip(pick, readingBlock || block || (membership.disabled ? "This interaction has no reportable activity." : ""));
        ux.tooltip(next, next.disabled ? readingBlock || block || "Add this interaction before continuing." : "");
    }
    function reportSelection(kind = reportScope) {
        if (periodReport && kind === reportScope) {
            const value = periodReport.value;
            const resolved = reportScopes.resolve(workspaceState.evidence?.exportCatalog, "selected", [],
                [...new Set(Object.values(value.periods).flatMap(side => side.scenarioIds))], authorship.selection(value.options.filters?.promptAuthors));
            return value.nativePeriods ? { ...resolved, nativeView: true,
                nativeConversationCount: new Set([...value.nativePeriods.rows.map(row => row.scenarioId),
                    ...value.nativePeriods.refinement?.contextConversationRefs ?? []]).size } : resolved;
        }
        let value = reportScopes.resolve(workspaceState.evidence?.exportCatalog, kind, workspaceState.evidence ? currentViewScenarios().map((s) => s.scenarioId) : [], [...selected], reportAuthors);
        if (usesBoundedReportView(kind)) {
            const native = draft.nativeView(reportNativeView(), workspaceState.evidence?.revision, reportNativeIntent());
            if (!native.ready || native.kind !== kind) return { ...value, available: false, nativeView: true };
            if (kind === "current") value = reportScopes.resolve(workspaceState.evidence.exportCatalog, "selected", [],
                native.request.selection.scenarioIds, reportAuthors);
            return { ...value, nativeView: true, nativeConversationCount: native.conversationCount,
                selection: () => ({ ...native.request.selection, promptAuthors: [...reportAuthors] }) };
        }
        return kind === "current" && semanticQuery !== null && !semanticComplete ? { ...value, available: false } : value;
    }
    function nativeReportUnenrolled() {
        return workspaceState.evidence?.nativeRead?.status === "unavailable"
            && workspaceState.evidence.nativeRead.reason === "microsoft-account-not-configured"
            && workspaceState.evidence.collection?.sourceAware?.microsoft?.status?.kind === "native-account-unavailable";
    }
    function usesBoundedReportView(kind = reportScope) {
        return !periodReport && sourceCollection.active && (!nativeReportUnenrolled() || selectedNative().hasSelection)
            && (kind === "all" || kind === "current" && boundedIncludesMicrosoft()
            || kind === "selected" && selectedNative().hasSelection);
    }
    function effectiveReportDates() {
        return periodReport || usesBoundedReportView(reportBaseExplicit ? reportScope : "all") ? { range: "capture" } : reportDates;
    }
    function reportNativeView(kind = reportScope) {
        return kind === "selected" ? workspaceState.evidence?.nativeRead : acceptedNativeView();
    }
    function reportNativeIntent(kind = reportScope) {
        if (kind === "selected") return { nativeSelected: selectedNative().items.map(item => item.id) };
        return { analytics: workspaceState.scope, search: search.trim(), semanticQuery, withinServices: workspaceState.route.withinServices ?? null,
            nativeGroup: workspaceState.evidence?.nativeRead?.groupId ?? null, nativeQuery: nativeAnalysisState?.query ?? null,
            nativeTextMembership: acceptedNativeView()?.textSelection?.membershipRef ?? null };
    }
    function acceptNativeReportScope() {
        if (!usesBoundedReportView()) { draft.clearNativeView(); return; }
        const scope = reportScopes.resolve(workspaceState.evidence?.exportCatalog, reportScope,
            workspaceState.evidence ? currentViewScenarios().map(scenario => scenario.scenarioId) : [], [...selected], reportAuthors);
        try {
            const native = selectedNative();
            if (reportScope === "selected") {
                if (!native.ready) throw new Error("The Microsoft selection changed. Clear it and choose current conversations.");
                draft.bindNativeView(native.view, { ...scope.selection(workspaceState.evidence.revision),
                    scenarioIds: [...scope.selection(workspaceState.evidence.revision).scenarioIds, ...native.items.map(item => item.id)] }, reportNativeIntent());
            } else draft.bindNativeView(acceptedNativeView(), scope.selection(workspaceState.evidence?.revision), reportNativeIntent());
        }
        catch (error) { announce(error.message, "stale"); }
    }
    function reportNativeSummary(value) {
        const native = value.nativeConversationCount === null ? "Microsoft conversations will be counted when preparing."
            : `${count(value.nativeConversationCount)} retained Microsoft ${value.nativeConversationCount === 1 ? "conversation" : "conversations"} ${reportScope === "selected" ? "selected" : "in the original view"}.`;
        return `${count(value.requests.length)} GitHub ${value.requests.length === 1 ? "interaction" : "interactions"}. ${native} Conversations on other pages remain included.`
            + (nativeAnalysisState && reportScope !== "selected" ? " Search widgets count matching calls; the report includes each matching conversation's complete evidence and may contain more calls." : "");
    }
    function reportSelectionBlock() {
        if (exportWriting || reportJourney?.snapshot().saveUnconfirmed) return "Check or finish the current save before changing report activity.";
        if (workspaceState.loading || workspaceState.stale || !workspaceState.evidence?.exportCatalog) return "Wait for a current activity snapshot before changing report activity.";
        if (periodReport) return "This draft uses paired periods. Return to the comparison to change its activity.";
        return "";
    }
    function reportUnavailability(blocked) {
        return blocked?.code === "native-report-provenance-unqualified" ? "Reports for Microsoft activity are not available." : blocked?.reason || "";
    }
    function hiddenReportBlock(kind = reportScope) {
        if (!hiddenCards.any()) return "";
        const scope = reportSelection(kind);
        const requests = scope.requests;
        const hiddenLinkedContext = draft.options().recordedContext && requests.some(r =>
            requestContext.select(workspaceState.evidence.scenarios, r.scenarioId).groups.some(g => hiddenCards.has(g.scenario.scenarioId)));
        if (hiddenLinkedContext || reportDatesReplaced && kind === "current" || requests.some(r => r.aliases.some(id => hiddenCards.has(id)))) {
            return "This preview could show a hidden card. Restore it in Analyze or choose other interactions. Your selection has not changed.";
        }
        return "";
    }
    function nativeReportBlock(kind = reportScope) {
        const scope = reportSelection(kind);
        if (scope.issue) return scope.issue;
        if (scope.nativeConversations && dateSelection().range !== "capture") return "Dated Microsoft report cohorts are not qualified. Use All dates for a retained-conversation report.";
        if (usesBoundedReportView(kind)) {
            if (kind !== "selected" && (search.trim() || workspaceState.route.withinServices || semanticQuery !== null && !nativeAnalysisState?.value)) {
                return "Read complete native Search membership or clear the unsupported local refinement before choosing a report view.";
            }
            if (kind === "current" && semanticQuery !== null && !semanticComplete
                && (!workspaceState.scope.filters.sources?.length || workspaceState.scope.filters.sources.includes("github-copilot"))) {
                return "GitHub Search membership is not current. A combined Current report cannot use native membership alone.";
            }
            if (!scope.available) return "Choose this scope from a current Microsoft view. A changed or expired view must be selected again.";
            if (scope.nativeConversationCount !== 0 && reportAuthors.length !== authorship.actors.length) return "Choose all prompt authors for a Microsoft conversation report.";
            if (dateSelection().range !== "capture" && scope.nativeConversationCount !== 0) {
                return "Dated Microsoft report cohorts are not qualified. Use All dates before selecting this scope.";
            }
            return "";
        }
        const blocked = workspaceState.evidence?.exportCatalog?.blockedRequests || [];
        if (!blocked.length) return "";
        const ids = periodReport && kind === reportScope ? Array.isArray(periodReport.value.selection.scenarioIds)
            ? new Set(periodReport.value.selection.scenarioIds) : null
            : kind === "all" ? null : new Set(kind === "current" ? currentViewScenarios().map(record => record.scenarioId) : selected);
        return reportUnavailability(blocked.find(record => !ids || ids.has(record.scenarioId)));
    }
    function selectedNative() {
        return draft.nativeSelection(workspaceState.evidence?.nativeRead, workspaceState.evidence?.revision, api.controlToken());
    }
    function nativeReportItem(id) {
        return selectedNative().items.find(item => item.id === id) ?? boundedNative.current()?.page.items.find(item => item.id === id);
    }
    function nativeSelectionBlock(item, view = boundedNative.current()) {
        if (!view || view.revision !== workspaceState.evidence?.revision || view.sourceRevision !== workspaceState.evidence?.nativeRead?.sourceRevision
            || !view.page.items.some(value => value.id === item.id && value.sourceId === item.sourceId)) {
            return "Choose this conversation from a current Microsoft Analyze page.";
        }
        const picks = selectedNative();
        return picks.hasSelection && (!picks.ready || picks.view.selectionRef !== view.selectionRef)
            ? "Clear the Microsoft selection before choosing conversations from a different view." : "";
    }
    function nativeSelectionCheckbox(item, view, reportPicker = false) {
        const control = el("input"), owner = api.controlToken(), publication = api.publicationToken();
        const id = item.id;
        control.type = "checkbox"; control.dataset.nativeReportRequest = item.id;
        control.id = (reportPicker ? "report-native-select-" : "select-native-request-") + item.id;
        control.checked = selectedNative().items.some(value => value.id === item.id);
        control.disabled = Boolean(reportSelectionBlock() || !control.checked && nativeSelectionBlock(item, view));
        control.setAttribute("aria-label", "Select conversation for report: " + (item.presentation ? item.title : filterState.sourceLabel(item.sourceId)));
        ux.tooltip(control, control.disabled ? reportSelectionBlock() || nativeSelectionBlock(item, view) : "");
        control.addEventListener("change", () => {
            if (!control.isConnected || control.dataset.nativeReportRequest !== id
                || !api.isCurrent(publication) || api.controlToken() !== owner) return;
            setNativeReportSelected(id, control.checked, view);
        }, reportPicker ? { signal: reportPickerEvents.signal } : undefined);
        return control;
    }
    function setNativeReportSelected(id, checked, offered = boundedNative.current()) {
        const item = nativeReportItem(id);
        const block = reportSelectionBlock() || (checked ? item ? nativeSelectionBlock(item, offered)
            : "Choose this conversation from a current Microsoft Analyze page." : "");
        if (block) { announce(block, "stale"); updateSelection(); return false; }
        try { draft.selectNative(offered && { ...offered, status: "bounded" }, id, checked, api.controlToken()); }
        catch (error) { announce(error.message, "stale"); updateSelection(); return false; }
        reportScope = "selected"; reportEntry = null;
        acceptNativeReportScope(); invalidatePreview();
        const focus = $("reportList")?.contains(document.activeElement) ? document.activeElement.id : null;
        keepAnchor(() => {
            updateSelection();
            if (underlyingRoute().view === "reports") renderReportPicker();
            if (focus) ($(focus) ?? $("reportRequestsTitle"))?.focus({ preventScroll: true });
        });
        return true;
    }
    function reportRequestSelection(scenarioId) {
        const native = nativeReportItem(scenarioId), picks = selectedNative();
        if (native) {
            const chosen = picks.items.some(item => item.id === scenarioId);
            return { selected: chosen, included: reportScope === "selected" ? chosen
                    : usesBoundedReportView() && reportSelection().available && Boolean(boundedNative.current()?.page.items.some(item => item.id === scenarioId)),
                disabled: Boolean(reportSelectionBlock() || !chosen && nativeSelectionBlock(native)) };
        }
        const catalog = workspaceState.evidence?.exportCatalog;
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
        if (nativeReportItem(scenarioId)) return setNativeReportSelected(scenarioId, checked);
        const block = reportSelectionBlock();
        const request = workspaceState.evidence?.exportCatalog?.requests.find(item => item.scenarioId === scenarioId)
            ?? workspaceState.evidence?.exportCatalog?.requests.find(item => item.aliases.includes(scenarioId));
        if (block || !request) {
            announce(block || "This interaction has no reportable activity.", "stale");
            updateSelection();
            return false;
        }
        if (checked) selected.add(scenarioId);
        else for (const id of request.aliases) selected.delete(id);
        reportScope = "selected";
        reportEntry = null;
        acceptNativeReportScope();
        invalidatePreview();
        if (sidebarIdentity) keepAnchor(updateSelection);
        else updateSelection();
        return true;
    }
    function continueSelectedReport(scenarioId) {
        const block = reportSelectionBlock();
        if (block) { announce(block, "stale"); return false; }
        if (workspaceState.route.view === "request" && underlyingRoute().view === "reports" && reportScope !== "selected") {
            announce("Return to report Activity to change this report's scope.", "stale"); return false;
        }
        if (!reportRequestSelection(scenarioId).selected) {
            announce("Add this interaction to the report before continuing.", "stale");
            return false;
        }
        const native = nativeReportItem(scenarioId);
        const request = native ? null : workspaceState.evidence.exportCatalog.requests.find(item => item.scenarioId === scenarioId)
            ?? workspaceState.evidence.exportCatalog.requests.find(item => item.aliases.includes(scenarioId));
        reportScope = "selected";
        reportBaseExplicit = true; reportDatesReplaced = false; reportDates = { range: "capture" };
        const id = native?.id ?? request?.scenarioId;
        const choices = reportPickerView("").matching, target = choices.find(item => item.id === id);
        if (!target) { announce("This interaction is no longer available in the report picker.", "stale"); return false; }
        const query = reportPickerView().matching.some(item => item.id === id) ? localQuery("reportRequestSearch") : "";
        const view = reportPickerView(query), matching = view.matching;
        if (view.plan) {
            const index = native ? boundedNative.presentation().pageIndex : view.github.findIndex(item => item.scenarioId === id) / 4;
            presentation.setPage(view.key, Math.floor(index));
        } else presentation.setPage(view.key, Math.floor(matching.findIndex(item => item.id === id) / view.size));
        reportEntry = null;
        updateSelection();
        reportJourney.go(1);
        const moved = go("reports", { task: "create", request: undefined,
            localSearch: { ...workspaceState.route.localSearch, reportRequestSearch: query } });
        const navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent;
        const reveal = loaded => {
            if (!loaded || navigation !== workspaceState.navigationGeneration || intent !== workspaceState.readingIntent) return;
            updateSelection(); void chooseReportPreset("all");
        };
        if (moved instanceof Promise) moved.then(reveal);
        else reveal(moved);
        return true;
    }
    function clearReportSelection() {
        if (exportWriting || reportJourney?.snapshot().saveUnconfirmed) return;
        namedReport = null;
        reportPreset = null;
        forgetReading(reportLandingOrigin?.reading); reportLandingOrigin = null;
        reportScope = "selected";
        reportAuthors = authorship.selection();
        reportExperience?.resetDeskFocus();
        reportEntry = null;
        periodReport = null; periodReportInvalid = false;
        selected.clear();
        draft.clearSelection();
        initialReportChoices = { range: "7", formats: ["html"] };
        reportDefaultsVisit = null;
        draft.change({ saveMode: "local", promptMode: "masked", formats: ["html"], manualTerms: [], recordedContext: false });
        reportDates = { range: "7", ...time.preset("7", viewerTime.timeZone) };
        reportBaseExplicit = reportDatesReplaced = false;
        invalidatePreview();
        reportJourney?.clear();
        if ($("overlay").open) {
            returnFocus = document.querySelector("#reportsView [data-clear-selection]");
            $("overlay").close();
        }
        $("detail").replaceChildren();
        if (workspaceState.evidence) { renderActivity(); renderRequest(); renderReports(); }
    }
    function syncSaveLocks() {
        $("closeDialog").disabled = exportWriting;
        $("clearPreviewSelection").disabled = exportWriting || Boolean(reportJourney?.snapshot().saveUnconfirmed);
        syncNativeSaveAvailability?.();
    }
    function selectedScenarios() {
        const ids = new Set(reportSelection().requests.map((r) => r.scenarioId));
        return workspaceState.evidence ? workspaceState.evidence.scenarios.filter((scenario) => ids.has(scenario.scenarioId)) : [];
    }
    function reportPickerRequests() {
        const ids = new Set((workspaceState.evidence.exportCatalog?.requests ?? []).map(request => request.scenarioId));
        return workspaceState.evidence.scenarios.filter(scenario => ids.has(scenario.scenarioId));
    }
    function matchesReportRequest(scenario, query) {
        if (hiddenCards.has(scenario.scenarioId)) return !query.trim();
        return localSearch.matches(query, [scenario.userPrompt?.text, scenario.title, scenario.sourceSessionName,
            sessionSource(scenario.sourceSessionId)?.name, scenario.project, scenario.sourceSessionId,
            nativeActivity.isNative(scenario) ? filterState.sourceLabel(scenario.sourceId) : "GitHub Copilot"]);
    }
    function reportPickerView(query = localQuery("reportRequestSearch")) {
        const picking = reportScope === "selected" && !periodReport;
        const requests = picking ? reportPickerRequests() : selectedScenarios();
        const github = requests.filter(scenario => matchesReportRequest(scenario, query));
        const native = sourceCollection.active && !periodReport ? boundedNative.current() : null, picks = selectedNative();
        const nativeItems = native && (picking || usesBoundedReportView() && reportSelection().available)
            ? [...new Map([...(native.page.items ?? []), ...(picking && picks.ready ? picks.items : [])].map(item => [item.id, item])).values()] : [];
        const nativeMatches = nativeItems.filter(item => localSearch.matches(query,
            [item.title, filterState.sourceLabel(item.sourceId), ...item.presentation?.tools ?? []]));
        const matching = [];
        for (let index = 0; index < Math.max(github.length, nativeMatches.length); index++) {
            if (github[index]) matching.push({ id: github[index].scenarioId, scenario: github[index] });
            if (nativeMatches[index]) matching.push({ id: nativeMatches[index].id, nativeItem: nativeMatches[index], nativeView: native });
        }
        const base = !periodReport && sourceCollection.active ? acceptedNativeView() : null;
        const shared = !query && base?.status === "bounded" && (picking || usesBoundedReportView() && reportSelection().available);
        const key = (shared ? "report:shared:" : "report:") + reportScope + ":" + query, size = 4;
        let plan;
        if (shared) {
            const source = boundedNative.presentation();
            plan = assessmentFactories.activityPage({ index: presentation.page(key, github.length + base.aggregates.conversations, 1),
                github: github.length, native: base.aggregates.conversations, githubSize: size, nativeSize: base.page.limit,
                ...(source.value || source.loading ? { nativeWindow: { index: source.pageIndex, offset: source.pageOffset,
                    count: source.pageCount, hasNext: source.hasNext } } : {}) });
        }
        return { picking, requests, github, nativeItems, native, base, query, matching, key, size, plan,
            page: plan?.index ?? presentation.page(key, matching.length, size) };
    }
    function updateReportPageSummary(selection = reportSelection()) {
        const summary = $("reportPageSelectionSummary");
        if (!summary || !workspaceState.evidence) return;
        if (workspaceState.loading || workspaceState.stale || !selection.available || !reportJourney?.snapshot().scopeReady) {
            summary.hidden = true;
            setText(summary, "");
            return;
        }
        const view = reportPickerView(), start = view.page * view.size;
        const pageIds = new Set(view.plan ? [
            ...view.github.slice(view.plan.githubOffset, view.plan.githubOffset + view.plan.githubLimit).map(item => item.scenarioId),
            ...(view.plan.nativePage === boundedNative.presentation().pageIndex ? view.native?.page.items.map(item => item.id) ?? [] : []),
        ] : view.matching.slice(start, start + view.size).map(entry => entry.id));
        const nativeOutside = view.picking ? selectedNative().items.filter(item => !pageIds.has(item.id)).length
            : selection.nativeView && Number.isSafeInteger(selection.nativeConversationCount)
                ? Math.max(0, selection.nativeConversationCount - [...pageIds].filter(id => view.nativeItems.some(item => item.id === id)).length) : 0;
        const outside = selection.requests.filter(request => !pageIds.has(request.scenarioId)).length + nativeOutside;
        summary.hidden = !outside;
        setText(summary, outside ? `${count(outside)} included outside this page.` : "");
    }
    function setReportMetadata(node, facts) {
        node.classList.add("report-metadata");
        if (node.childElementCount === facts.length && [...node.children].every((child, index) => child.textContent === facts[index])) return;
        node.replaceChildren(...facts.flatMap((fact, index) => [...(index ? [document.createTextNode(" ")] : []), el("span", "", fact)]));
    }
    function updateSelection({ refreshingPairedCopies = false } = {}) {
        if (clearingAccess || !api.publicationToken()) return;
        syncSaveLocks();
        if (!workspaceState.evidence) return;
        const savedCount = workspaceState.evidence.exports?.length || 0;
        const verifiedEmptyLibrary = !savedCount && !workspaceState.loading && !workspaceState.stale;
        for (const node of $("bundles").querySelectorAll(".saved-library-tools,:scope > #savedLibraryManagement")) {
            if (verifiedEmptyLibrary && node.contains(document.activeElement)) $("savedLibraryTitle").focus({ preventScroll: true });
            node.hidden = verifiedEmptyLibrary || workspaceState.route.task !== "library";
        }
        if (!savedCount) {
            const notice = $("bundleList").querySelector(":scope > p");
            if (notice) setText(notice, workspaceState.loading ? "Checking saved reports..." : workspaceState.stale ? "Saved reports could not be checked. Retry the stored view."
                : workspaceState.route.task === "library" ? "No saved reports." : "No saved reports yet. Your first local copy will appear here after Save.");
        }
        const value = reportSelection();
        const hasNativeScope = value.nativeView === true;
        const nativePicks = selectedNative(), nativePickedIds = new Set(nativePicks.items.map(item => item.id));
        const hasBaseSelection = value.baseRequests.length > 0 || reportScope === "selected" && nativePicks.hasSelection;
        if (hasNativeScope && !value.available && activePreview && !exportWriting) {
            invalidatePreview("The original Microsoft report view changed. Select a current scope before preparing again.");
        }
        const hasReportPopulation = reportDatesReplaced && reportScope === "current" || value.requests.length > 0 || hasNativeScope
            && (value.nativeConversationCount === null || value.nativeConversationCount > 0);
        const picked = new Set(reportSelection("selected").baseRequests.map(request => request.scenarioId));
        for (const control of $("reportList").querySelectorAll("input[data-report-request]")) control.checked = picked.has(control.dataset.reportRequest);
        for (const control of document.querySelectorAll("input[data-selected-request]")) control.checked = selected.has(control.dataset.selectedRequest);
        for (const control of document.querySelectorAll("input[data-native-report-request]")) {
            const id = control.dataset.nativeReportRequest, item = nativeReportItem(id);
            control.checked = nativePickedIds.has(id);
            control.disabled = Boolean(reportSelectionBlock() || !control.checked && (!item || nativeSelectionBlock(item)));
        }
        const activeAuthors = periodReport ? authorship.selection(periodReport.value.options.filters?.promptAuthors) : reportAuthors;
        if (periodReport) {
            const expected = [...new Set(Object.values(periodReport.value.periods).flatMap(side => side.scenarioIds))].sort();
            if (JSON.stringify([...selected].sort()) !== JSON.stringify(expected)) {
                periodReportInvalid = true;
                invalidatePreview("The comparison selection changed. Return to Compare and create a new report.");
            }
        }
        const unknownSelected = reportScope === "selected" && [...selected].some((id) => !workspaceState.evidence.scenarios.some((s) => s.scenarioId === id));
        if (!exportWriting && !workspaceState.loading && !workspaceState.stale && value.available && !activePreview?.collectedSourceFrozen && !reportRebuildFrom && !reportPreparing) {
            if (draft.observeContext({ revision: workspaceState.evidence.revision, assessment: workspaceState.evidence.assessment })) {
                scrubContextPreview();
                invalidatePreview("Recorded context changed. Prepare a new preview; ordinary prompt edits are kept.");
            }
            const token = draft.token();
            draft.select([reportScope, "authors:" + activeAuthors.join(","), ...value.requests.map((r) => r.scenarioId),
                ...(reportScope === "selected" ? nativePickedIds : [])]);
            draft.synchronizeTime(periodReport?.timeContext ?? viewerTime, effectiveReportDates());
            const sameSelection = draft.current(token);
            if (draft.synchronizeBasis(workspaceState.evidence, value, { paired: Boolean(periodReport) }) && periodReport) periodReportInvalid = true;
            if (periodReport && JSON.stringify(periodReport.timeContext) !== JSON.stringify(viewerTime)) periodReportInvalid = true;
            // A copy edit already retired the old preview. Rebuild its new disclosure
            // rather than cancelling that read when only the optional copy basis changed.
            const copyOnly = refreshingPairedCopies && periodReport && sameSelection && !periodReportInvalid;
            if (!draft.current(token) && !copyOnly) invalidatePreview("The report scope, source or review basis changed. Return to Setup and scan again; unchanged draft choices are kept.");
        }
        for (const kind of ["all", "current", "selected"]) {
            const scope = reportSelection(kind), size = scope.requests.length;
            const unavailable = Boolean(nativeReportBlock(kind)), counter = $("scopeCount-" + kind);
            counter.hidden = unavailable;
            setReportMetadata(counter, unavailable ? [] : scope.available && scope.nativeView
                    ? [`${count(scope.requests.length)} GitHub ${scope.requests.length === 1 ? "interaction" : "interactions"}`,
                        scope.nativeConversationCount === null ? "Microsoft count checked at preparation"
                            : `${count(scope.nativeConversationCount)} Microsoft ${scope.nativeConversationCount === 1 ? "conversation" : "conversations"}`]
                    : scope.available
                ? [scope.sourceSessionCount === null ? "Chat count unavailable" : `${count(scope.sourceSessionCount)} ${scope.sourceSessionCount === 1 ? "chat" : "chats"}`,
                    `${count(size)} ${size === 1 ? "interaction" : "interactions"}`]
                : ["Count unavailable"]);
            document.querySelector(`[name=reportScope][value=${kind}]`).checked = reportScope === kind;
        }
        setText($("reportScopeChoiceHelp"), help.reportScopes[reportScope]);
        $("reportScopeChoiceHelp").hidden = Boolean(periodReport);
        $("scopeSummary").textContent = !workspaceState.evidence.exportCatalog ? "Report scope is unavailable. Refresh before previewing." : unknownSelected ? "A selected request is no longer available. Choose a fresh selection." : reportScopes.summary(value);
        if (hasNativeScope && value.available) $("scopeSummary").textContent = reportNativeSummary(value);
        if (nativeReportBlock()) $("scopeSummary").textContent = nativeReportBlock();
        for (const option of $("reportPromptAuthorFilter").options) option.selected = activeAuthors.includes(option.value);
        $("reportPromptAuthorFilter").disabled = exportWriting || Boolean(periodReport);
        $("reportPromptAuthorFilter").closest(".report-author-choice").hidden = Boolean(periodReport);
        const reportTitleValue = draft.options().title ?? activePreview?.title ?? "";
        if ($("reportTitle").value !== reportTitleValue) $("reportTitle").value = reportTitleValue;
        $("reportTitle").placeholder = assessmentFactories.reportIdentity.defaultTitle({ kind: "report", selectionScope: { kind: reportScope },
            ...(periodReport ? { reportType: "period-comparison" } : {}) });
        $("reportTitle").disabled = exportWriting || reportJourney?.snapshot().saveUnconfirmed;
        document.querySelectorAll("[name=reportScope]").forEach(control => { control.disabled = exportWriting || Boolean(periodReport); });
        document.querySelectorAll("[name=promptMode],#formatOptions input,#manualTerms").forEach(control => { control.disabled = exportWriting; });
        $("reportRecordedContext").checked = draft.options().recordedContext === true && draft.options().promptMode !== "none";
        $("reportRecordedContext").disabled = exportWriting || draft.options().promptMode === "none";
        const usageOptions = draft.options().usageOptions ?? { tokens: true, dollars: true, rows: false };
        $("usageTokens").checked = usageOptions.tokens;
        $("usageDollars").checked = usageOptions.tokens && usageOptions.dollars;
        $("usageRows").checked = usageOptions.tokens && usageOptions.rows;
        $("usageTokens").disabled = exportWriting;
        $("usageDollars").disabled = $("usageRows").disabled = exportWriting || !usageOptions.tokens;
        $("reportResultText").checked = draft.options().resultText === true;
        $("reportResultText").disabled = exportWriting;
        $("reportRecordedContextHelp").hidden = !$("reportRecordedContext").checked && draft.options().promptMode !== "none";
        setText($("reportRecordedContextHelp"), draft.options().promptMode === "none"
            ? "No prompts also excludes linked replies."
            : $("reportRecordedContext").checked ? "Linked context does not expand the measured activity or prove one task. Unavailable replies stay excluded." : "");
        setText($("reportPromptAuthorSummary"), value.available === false ? "Interaction counts are unavailable for this scope."
            : `${count(value.requests.length)} of ${count(value.baseRequests.length)} ${value.baseRequests.length === 1 ? "interaction" : "interactions"} included.${value.authorExcludedRequestGroups ? ` ${count(value.authorExcludedRequestGroups)} excluded by authors. Your selection is kept.` : ""}`);
        $("reportPromptAuthorSummary").hidden = !periodReport && value.available !== false && !value.authorExcludedRequestGroups;
        $("scopeExplanation").replaceChildren();
        $("scopeExplanation").hidden = !hasNativeScope;
        if (hasNativeScope) $("reportScopeChoiceHelp").after($("scopeExplanation"));
        if (hasNativeScope && reportScope === "selected") {
            const clearNative = button("Clear Microsoft selection", () => {
                if (exportWriting || reportJourney?.snapshot().saveUnconfirmed) return;
                draft.clearNativeSelection(); acceptNativeReportScope(); invalidatePreview(); renderReports();
            }, "quiet");
            clearNative.disabled = exportWriting || reportJourney?.snapshot().saveUnconfirmed;
            $("scopeExplanation").append(clearNative);
        } else if (hasNativeScope && !value.available) {
            const refreshScope = button("Use current activity for this report scope", async () => {
                if (exportWriting || workspaceState.loading || workspaceState.stale) return;
                const scope = reportScope, publication = api.publicationToken();
                if (!await load({ background: true }) || !api.isCurrent(publication) || reportScope !== scope) return;
                acceptNativeReportScope(); invalidatePreview(); renderReports();
            }, "quiet");
            refreshScope.disabled = exportWriting || workspaceState.loading || workspaceState.stale;
            $("scopeExplanation").append(refreshScope);
        }
        if (hasNativeScope && !nativePublication.available(nativePublicationContext(false))) {
            $("scopeExplanation").append(el("span", "context-help-note", "Saving Microsoft reports is unavailable in this session."));
        }
        $("scopeExplanation").hidden = !$("scopeExplanation").childElementCount;
        const reportIds = new Set(value.requests.flatMap(request => request.aliases));
        const currentIds = new Set(currentViewScenarios().map(s => s.scenarioId));
        const hidden = value.requests.filter(request => !request.aliases.some(id => currentIds.has(id))).length;
        const currentMembershipAvailable = semanticQuery === null || semanticBound;
        $("reportPopulationNote").textContent = value.available && !unknownSelected && value.requests.length
            ? currentMembershipAvailable ? hidden ? `Includes ${count(hidden)} ${hidden === 1 ? "interaction" : "interactions"} outside the current Analyze view.` : "" : "Current Analyze matches are unavailable."
            : "";
        const matching = results.summarize(selectionRows().filter(row => reportIds.has(row.scenarioId) && currentIds.has(row.scenarioId)));
        $("reportMatchingContext").replaceChildren(resultLine(workspaceState.scope?.layer || "tool", matching, { scope: "Matching view results, not the full report", label: `${count(matching?.count)} matching ${results.unit(workspaceState.scope?.layer || "tool", matching?.count)} in the current view` }));
        $("reportMatchingContext").hidden = !value.requests.length || !currentMembershipAvailable || Boolean(value.nativeConversations) || hasNativeScope;
        const x = workspaceState.evidence.exportCatalog?.excluded;
        const exclusions = $("scopeExclusions");
        exclusions.replaceChildren();
        if (!x) exclusions.append(el("p", "context-help-note", "Collection exclusion counts unavailable."));
        else {
            const excluded = el("dl", "scope-facts");
            for (const [key, label] of [
                ["syntheticRequestGroups", "Synthetic request groups"],
                ["diagnosticRequestGroups", "Diagnostic request groups"],
                ["unknownSourceRequestGroups", "Request groups with unknown source identity"],
                ...(Object.hasOwn(x, "nativeProvenanceUnqualifiedRequestGroups")
                    ? [["nativeProvenanceUnqualifiedRequestGroups", "Microsoft conversations awaiting report support"]] : []),
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
            : unknownSelected ? "A selected request is no longer available" : hasNativeScope && value.available
                ? reportNativeSummary(value) : reportScopes.inclusion(value);
        const activity = workspaceState.route.view === "analyze";
        setText($("activitySelectionSummary"), inclusion);
        setReportMetadata($("previewSelectionSummary"), periodReport || unknownSelected || !value.available || hasNativeScope ? [inclusion] : !value.requests.length ? ["No interactions included"]
            : [value.sourceSessionCount === null ? "Chat count unavailable" : `${count(value.sourceSessionCount)} ${value.sourceSessionCount === 1 ? "chat" : "chats"}`,
                `${count(value.requests.length)} ${value.requests.length === 1 ? "interaction" : "interactions"}`]);
        let compactSelection = $("activitySelectionCompact");
        if (!compactSelection) {
            compactSelection = el("p");
            compactSelection.id = "activitySelectionCompact";
            compactSelection.setAttribute("aria-hidden", "true");
            $("activitySelectionSummary").before(compactSelection);
        }
        compactSelection.hidden = !activity || unknownSelected || nativePicks.hasSelection && !nativePicks.ready;
        $("activitySelectionSummary").classList.toggle("visually-hidden", activity && !unknownSelected);
        renderSelectionCount(compactSelection, value.requests.length + (value.nativeConversationCount ?? 0),
            (workspaceState.evidence.exportCatalog?.requests?.length ?? workspaceState.evidence.scenarios.length) + (workspaceState.evidence.nativeRead?.aggregates?.conversations ?? 0));
        $("activitySelectionScope").textContent = activity || hasBaseSelection ? ({ all: "All collected activity", current: "Current view", selected: "Selected requests" })[reportScope] : "";
        $("activitySelectionContext").hidden = !activity && !hasBaseSelection;
        if (workspaceState.route.view === "request") $("reportContextAction").hidden = !hasBaseSelection;
        $("activityClearSelection").hidden = !activity && !hasBaseSelection;
        $("reportSelectionBar").hidden = ["request", "reports", "settings", "help", "collection-status"].includes(workspaceState.route.view)
            || !hasBaseSelection && !unknownSelected;
        updateRequestReportActions();
        document.querySelectorAll("[data-clear-selection]").forEach(control => {
            control.disabled = exportWriting || reportJourney?.snapshot().saveUnconfirmed || control.id === "activityClearSelection" && !hasBaseSelection;
        });
        $("reportClearSelection").hidden = !hasBaseSelection && !selected.size || ["saved", "unavailable"].includes(reportJourney?.snapshot().phase);
        if (workspaceState.route.view === "reports") {
            $("reportContextAction").hidden = !hasReportPopulation;
            $("reportContextAction").classList.add("quiet");
        } else $("reportContextAction").classList.remove("quiet");
        let pairedSummary = $("periodReportScope");
        if (!pairedSummary) {
            pairedSummary = el("section", "report-period-scope"); pairedSummary.id = "periodReportScope";
            const ranges = el("div", "report-period-ranges");
            for (const [side, label] of [["baseline", "Period A"], ["later", "Period B"]]) {
                const group = el("section"); group.dataset.periodReportSide = side;
                group.append(el("h3", "", label), el("p", "report-period-dates"), el("p", "report-period-count"));
                ranges.append(group);
            }
            pairedSummary.append(ranges, el("p", "report-period-authors"),
                el("p", "context-help-note", "Authors and matching records are fixed to the accepted comparison."),
                button("Back to comparison", function changeComparison() {
                    if (exportWriting || reportJourney.snapshot().saveUnconfirmed) return;
                    const returnTo = periodReport.returnTo;
                    clearReportSelection();
                    navigate(returnTo, false, { restorePosition: true });
                }));
            $("reportsView").querySelector(".report-scope-layout").prepend(pairedSummary);
        }
        pairedSummary.hidden = !periodReport;
        $("reportsView").querySelector(".export-scope").hidden = Boolean(periodReport);
        if (periodReport) {
            for (const [side, period] of Object.entries(periodReport.value.periods)) {
                const group = pairedSummary.querySelector(`[data-period-report-side="${side}"]`);
                const from = time.formatDate(period.range.from, periodReport.timeContext, true);
                const to = time.formatDate(period.range.to, periodReport.timeContext, true);
                setText(group.querySelector(".report-period-dates"), from === to ? from : `${from} to ${to}`);
                const microsoft = periodReport.value.nativePeriods?.summary.map(item => {
                    const source = item.sourceId === "microsoft-365-chat" ? "Chat" : "Cowork";
                    const unit = item.unit === "native-tool-call" ? "calls" : item.unit === "native-returned-result-observation" ? "result observations" : "message observations";
                    return `${count(item[side].count)} ${source} ${unit}`;
                }).join("; ");
                setText(group.querySelector(".report-period-count"), `${count(period.rowIds.length)} matching ${results.unit(periodReport.value.definitions.layer, period.rowIds.length)}${microsoft ? `; ${microsoft}` : ""}`);
            }
            setText(pairedSummary.querySelector(".report-period-authors"), `Authors: ${authorship.selectionLabel(activeAuthors)}.`);
            pairedSummary.querySelector("button").disabled = exportWriting || reportJourney.snapshot().saveUnconfirmed;
            $("reportPopulationNote").textContent = "Copy text does not combine the measured activity in the two periods.";
            $("scopeSummary").textContent = "Matching records remain separate for Period A and Period B. Recorded timing keeps its original interaction scope.";
            $("reportMatchingContext").hidden = true;
        }
        const nativeBlock = nativeReportBlock() || hiddenReportBlock();
        $("exportBtn").disabled = workspaceState.loading || workspaceState.stale || periodReportInvalid || !workspaceState.evidence.exportCatalog || value.available === false || unknownSelected || !hasReportPopulation || !draft.options().formats.length
            || Boolean(nativeBlock) && !reportJourney?.snapshot().hasPreview;
        for (const notice of $("reportReviewBody")?.querySelectorAll(".rebuild-preview") || []) {
            notice.querySelector("button").disabled = $("exportBtn").disabled;
            setText(notice.querySelector("p"), nativeBlock || reportCopyRebuildMessage);
        }
        reportJourney?.update({
            requestCount: value.requests.length, sourceSessionCount: value.sourceSessionCount, scope: periodReport ? "period" : reportScope,
            nativeView: hasNativeScope, nativeConversationCount: value.nativeConversationCount ?? null,
            resolveReportView: reportDatesReplaced && reportScope === "current",
            authorLabel: authorship.selectionLabel(activeAuthors), authorFiltered: activeAuthors.length !== authorship.actors.length,
            scopeReady: !nativeBlock && !workspaceState.loading && !workspaceState.stale && !periodReportInvalid && Boolean(workspaceState.evidence.exportCatalog) && value.available !== false && !unknownSelected,
            scopeIssue: nativeBlock || (periodReportInvalid ? "The accepted comparison changed. Return to Compare and create a new report." : workspaceState.loading || workspaceState.stale ? "Wait for a current activity snapshot." : !value.available || unknownSelected ? $("scopeSummary").textContent : ""),
            promptMode: draft.options().promptMode, formats: draft.options().formats,
            prepareIssue: nativeBlock,
            timeLabel: time.label(workspaceState.scope?.timeContext || viewerTime), entry: reportEntry,
        });
        updateReportPageSummary(value);
        selectControls?.sync();
        renderStoredRefresh();
        renderReportTask();
    }
    function renderReportPicker() {
        if (sourceCollection.active) seedBoundedNative();
        const host = $("reportList"), { picking, requests, github, nativeItems, native, base, query, matching, key, size, plan } = reportPickerView();
        $("reportRequestsTitle").textContent = picking ? "Choose interactions" : "Included interactions";
        $("reportRequestsTitle").tabIndex = -1;
        reportPickerEvents?.abort();
        releaseCardPreviews(host);
        boundedNative.clearCards(host);
        reportPickerEvents = new AbortController();
        host.replaceChildren();
        $("reportRequestSearchCount").hidden = !query;
        const candidates = requests.length + nativeItems.length;
        setText($("reportRequestSearchCount"), native
            ? `${count(matching.length)} of ${count(candidates)} available cards shown. Search checks these cards and keeps your report scope unchanged.`
            : `${count(matching.length)} of ${count(requests.length)} saved interactions shown.${picking ? " Selections outside this list are kept." : ` All ${count(requests.length)} remain included.`}`);
        const listHost = el("div", "report-selection-list");
        host.append(listHost);
        const wrapList = list => {
                list.className = "report-request-page";
                list.tabIndex = 0;
                list.setAttribute("role", "region");
                list.setAttribute("aria-label", "Requests on this report page");
                updateReportPageSummary();
                return list;
        };
        const renderItem = entry => {
                const { scenario, nativeItem, nativeView } = entry;
                if (scenario && hiddenCards.has(scenario.scenarioId)) {
                    const row = el("div", "report-entry hidden-report-card");
                    if (picking) {
                        const toggle = selectionCheckbox(scenario, true);
                        toggle.disabled = reportRequestSelection(scenario.scenarioId).disabled;
                        const label = el("label", "report-selection-toggle"); label.htmlFor = toggle.id; label.append(toggle); row.append(label);
                    }
                    row.append(ux.icon("hide"), el("span", "", "Hidden card"));
                    return row;
                }
                let selection;
                if (picking) {
                    const control = nativeItem ? nativeSelectionCheckbox(nativeItem, nativeView, true) : selectionCheckbox(scenario, true);
                    if (!nativeItem) control.disabled = reportRequestSelection(scenario.scenarioId).disabled;
                    selection = el("label", "report-selection-toggle");
                    selection.htmlFor = control.id; selection.append(control);
                }
                const row = nativeItem ? boundedNative.card({ item: nativeItem, view: nativeView, selection,
                    onOpen: target => navigate(nativeTargetRoute(target)) })
                    : requestCard(scenario, { reportPicker: true });
                if (!row) return el("p", "context-help-note", "This interaction is no longer authorized.");
                row.classList.add("report-entry");
                row.dataset.viewKey = "report:" + (nativeItem?.id ?? scenario.scenarioId);
                if (!nativeItem && selection) row.prepend(selection);
                if (!nativeItem && picking) {
                    const request = workspaceState.evidence.exportCatalog.requests.find(item => item.scenarioId === scenario.scenarioId);
                    if (!reportAuthors.includes(request.promptAuthor ?? "unknown")) row.querySelector(".request-card-open").append(
                        el("p", "context-help-note", "Not included with the current prompt-author choice."));
                }
                return row;
        };
        if (plan) {
            const source = boundedNative.presentation(), ready = !source.loading && !source.error
                && (plan.nativePage === null && !source.selected || Boolean(source.value) && (plan.nativePage === null || source.pageIndex === plan.nativePage));
            const pager = viewKey(el("div", "pager list-pager"), "pager:" + key);
            pager.setAttribute("aria-label", "Report activity pages");
            const label = el("span", "", ready ? `${count(plan.first)}-${count(plan.last)} of ${count(plan.total)} available cards`
                : `Page ${count(plan.index + 1)} / Microsoft page ${source.loading ? "loading" : "unavailable"}`);
            label.tabIndex = -1; label.dataset.pagePosition = ""; pager.append(label);
            const move = async index => {
                if (!pager.isConnected || !api.publicationToken()) return;
                const publication = api.publicationToken();
                const anchor = capturePager(pager, index - plan.index);
                presentation.setPage(key, Math.max(0, index));
                const next = reportPickerView().plan;
                if (!next) return;
                if (next.nativePage !== null && (source.pageIndex !== next.nativePage || source.error)) await boundedNative.pageAt(next.nativePage);
                if (!api.isCurrent(publication) || underlyingRoute().view !== "reports") return;
                const current = reportPickerView();
                if (current.key !== key || current.base?.sourceRevision !== base.sourceRevision
                    || current.base?.selectionRef !== base.selectionRef) return;
                renderReportPicker();
                restorePager(anchor);
            };
            if (plan.pages > 1) for (const [name, offset] of [["Previous", -1], ["Next", 1]]) {
                const control = button(name, () => void move(plan.index + offset), "quiet");
                control.setAttribute("aria-label", `${name} report requests`);
                control.dataset.pageDirection = String(offset);
                control.disabled = source.loading || (offset < 0 ? plan.index === 0 : plan.index >= plan.pages - 1);
                pager.append(control);
            }
            listHost.append(pager);
            const list = wrapList(el("div"));
            const available = plan.nativePage !== null && ready ? native?.page.items ?? [] : [];
            const ordinary = github.slice(plan.githubOffset, plan.githubOffset + plan.githubLimit);
            for (let index = 0; index < Math.max(ordinary.length, available.length); index++) {
                if (ordinary[index]) list.append(renderItem({ scenario: ordinary[index] }));
                if (available[index]) list.append(renderItem({ nativeItem: available[index], nativeView: native }));
            }
            if (!ready) {
                const notice = el("p", "context-help-note", source.error || "Reading the Microsoft activity page. Your report selection is unchanged.");
                notice.setAttribute("role", source.error ? "alert" : "status");
                list.append(notice);
                if (source.error) list.append(button("Read current activity", () => {
                    presentation.setPage(key, 0);
                    boundedNative.invalidate("Reading current Microsoft activity.");
                    void load();
                }, "quiet"));
                else if (!source.loading && source.value) void boundedNative.pageAt(plan.nativePage);
            }
            if (ready && !plan.total) list.append(empty("No reportable activity saved", "Collect activity to create a report."));
            listHost.append(list);
        } else {
            if (!candidates && !(sourceCollection.active && !native && boundedIncludesMicrosoft() && !nativeReportUnenrolled())) {
                listHost.append(empty(picking ? "No reportable activity saved" : "No interactions included",
                    workspaceState.stale ? "Activity could not be checked. Retry the stored view." : picking ? "Collect activity to create a report." : "Choose another scope or include other prompt authors."));
            }
            else if (candidates && !matching.length) listHost.append(empty("No interactions match", "Clear this search to show the list. Your report selection is unchanged."));
            if (matching.length) pagedList(listHost, matching, { key, size, noun: "report requests", wrapList, renderItem,
                beforeReplace: releaseCardPreviews });
        }
        if (native) {
            host.append(el("p", "context-help-note report-candidate-coverage", picking
                ? "Selecting a Microsoft conversation includes its complete saved evidence, not just matching calls."
                : "This list shows available cards, not the full report population. The original scope is checked when the report is prepared."));
        } else if (!plan && sourceCollection.active && !periodReport && boundedIncludesMicrosoft() && !nativeReportUnenrolled()) {
            const source = boundedNative.presentation(), reason = source.error || (source.loading
                ? "Reading Microsoft activity. Your existing report selection is kept."
                : "Microsoft activity is unavailable in this source view. It has not been counted as an empty selection.");
            const notice = el("p", "context-help-note", reason);
            notice.setAttribute("role", source.loading ? "status" : "alert"); host.append(notice);
        }
        if (selectedNative().hasSelection && !selectedNative().ready) {
            host.append(el("p", "context-help-note", "The Microsoft selection changed. Clear it and choose current conversations."));
        }
    }
    function retireSavedList() {
        savedListOwner?.events.abort();
        savedListOwner = null;
        const host = $("bundleList");
        if (host.hasChildNodes()) { erasePreparedNodes(host); host.replaceChildren(); }
        setText($("savedReportCount"), "");
        setText($("savedReportSearchCount"), "");
        setText($("savedLibraryTitle"), "Saved reports");
    }
    function syncSavedLibraryTask(view) {
        const active = workspaceState.route.view === "reports" && view.landing;
        const library = active && workspaceState.route.task === "library";
        const panel = $("savedReportsPanel");
        panel.classList.toggle("saved-shelf", active && !library);
        $("reportSections").hidden = !active;
        for (const [id, selected, task] of [["reportOverviewLink", !library, undefined], ["viewAllSavedReports", library, "library"]]) {
            const link = $(id);
            if (active && selected) link.setAttribute("aria-current", "page");
            else link.removeAttribute("aria-current");
            if (active) setRouteLink(link, routeFor("reports", { task, order: undefined, request: undefined }));
        }
        if (!active && savedListOwner) retireSavedList();
        if (library) $("reportCreatePanel").hidden = true;
    }
    function hasReportDraftChoices() {
        return reportPreset || selected.size || periodReport || reportBaseExplicit || reportRebuildFrom
            || reportDates.range !== initialReportChoices.range || reportExperience?.hasDeskDraft()
            || draft.hasUnsavedChoices(initialReportChoices.formats) || reportAuthors.length !== authorship.selection().length;
    }
    function applyReportDefaults() {
        const range = pageDefaults.get("reportPeriod"), formats = pageDefaults.get("reportFormats");
        initialReportChoices = { range, formats };
        reportDates = { range, ...time.preset(range, viewerTime.timeZone) };
        if (JSON.stringify(draft.options().formats) !== JSON.stringify(formats)) draft.change({ formats });
        $("formatError").hidden = true;
    }
    function initializeReportChoices() {
        if (reportDefaultsVisit === workspaceState.navigationGeneration) return;
        const { route } = workspaceState, journey = reportJourney.snapshot();
        if (route.view !== "reports" || route.task === "library" || route.inspect || route.request
            || !assessmentFactories.reportWorkspacePresentation(route, journey).landing
            || exportWriting || reportPreparing || journey.saveUnconfirmed || journey.completed || journey.hasPreview || activePreview
            // Prepare navigates from the outline into its drawer; use the choices already shown.
            || reportLandingOrigin || hasReportDraftChoices()) return;
        reportDefaultsVisit = workspaceState.navigationGeneration;
        applyReportDefaults();
    }
    function renderReports() {
        if (workspaceState.route.bundle) { renderSavedReader(); return; }
        initializeReportChoices();
        captureReading();
        $("reportTimeContext").textContent = periodReport?.value.nativePeriods
            ? "Qualified Microsoft activity dates are included; raw source identifiers stay withheld." : "Source event timestamps stay withheld.";
        renderReportPicker();
        retireSavedList();
        if (workspaceState.route.view !== "reports" || $("savedReportsPanel").hidden) {
            if (workspaceState.route.view === "reports" && workspaceState.route.inspect) renderSavedInspector();
            updateSelection(); return;
        }
        const library = workspaceState.route.task === "library";
        const publication = api.publicationToken(), inventory = workspaceState.evidence.exports;
        const owner = { events: new AbortController(), current: () => savedListOwner === owner && api.isCurrent(publication)
            && workspaceState.evidence?.exports === inventory && workspaceState.route.view === "reports"
            && !$("savedReportsPanel").hidden && library === (workspaceState.route.task === "library") };
        savedListOwner = owner;
        const listCurrent = owner.current, listeners = { signal: owner.events.signal };
        const savedCount = workspaceState.evidence.exports?.length || 0;
        const reportCount = (workspaceState.evidence.exports || []).filter(bundle => (bundle.kind ?? "report") === "report").length;
        const comparisonCount = savedCount - reportCount;
        if (library) setText($("savedLibraryTitle"), comparisonCount ? `Saved reports and comparisons (${count(savedCount)})`
            : savedCount ? `Saved reports (${count(savedCount)})` : "Saved reports");
        setText($("savedReportCount"), library && comparisonCount ? `${count(reportCount)} report${reportCount === 1 ? "" : "s"} / ${count(comparisonCount)} comparison${comparisonCount === 1 ? "" : "s"}` : "");
        $("savedReportCount").parentElement.hidden = !library || !comparisonCount;
        $("deleteAllReports").disabled = !reportCount || workspaceState.loading || workspaceState.stale
            || workspaceState.evidence.exports.some(bundle => (bundle.kind ?? "report") === "report" && (bundle.canDelete === false || bundle.nativeEvidenceHash));
        (() => {
        if (!savedCount) {
            $("bundleList").append(el("p", "", workspaceState.stale ? "Saved reports could not be checked. Retry the stored view."
                : "No saved reports."));
            return;
        }
        const ordered = inventory.map((bundle, index) => {
            let prepared = null;
            try { prepared = Date.parse(time.instant(bundle.preparedAt)); }
            catch (error) { if (!(error instanceof RangeError)) throw error; }
            return { bundle, index, prepared };
        }).sort((a, b) => a.prepared === null ? b.prepared === null ? a.index - b.index : 1
            : b.prepared === null ? -1 : (library && workspaceState.route.order === "oldest" ? 1 : -1) * (a.prepared - b.prepared || a.index - b.index));
        if (!library) {
            const entries = ordered.slice(0, 3);
            setText($("savedLibraryTitle"), entries.length === savedCount ? `Recent reports (${count(savedCount)})`
                : `Recent reports (${count(entries.length)} of ${count(savedCount)})`);
            const recent = el("div", "saved-shelf-rows");
            for (const { bundle } of entries) {
                const control = savedTitleControl(bundle, listCurrent, true, listeners);
                control.append(ux.icon("next")); recent.append(control);
            }
            $("bundleList").append(recent);
            return;
        }
        const history = el("div");
        const query = localQuery("savedReportSearch");
        const rows = ordered.map(({ bundle }) => {
            const date = bundle.preparedAtDisplay?.trim() || time.formatTime(bundle.preparedAt, bundle.timeContext || viewerTime);
            const mode = ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[bundle.promptMode];
            const formats = (bundle.formats || []).map(format => format === "markdown" ? "Markdown" : format.toUpperCase()).join(", ");
            const groups = bundle.selectionScope?.requestGroups;
            const conversations = bundle.selectionScope?.nativeConversations;
            const hasNative = Number.isSafeInteger(conversations) && conversations >= 0;
            const title = typeof bundle.title === "string" && bundle.title.trim() ? bundle.title.trim()
                : assessmentFactories.reportIdentity.defaultTitle(bundle);
            const label = [
                title,
                date === "Time not recorded" ? "Preparation time unavailable" : `Prepared ${date}`,
                mode, formats,
                Number.isSafeInteger(groups) && groups >= 0 ? `${count(groups)} ${hasNative ? "GitHub " : ""}interaction${groups === 1 ? "" : "s"}` : "",
                hasNative ? `${count(conversations)} Microsoft conversation${conversations === 1 ? "" : "s"}` : "",
            ].filter(Boolean).join(" / ");
            return { bundle, label, preparedLabel: date, period: savedPeriodLabel(bundle) };
        });
        $("savedReportOrder").value = workspaceState.route.order || "newest";
        const matching = rows.filter(({ bundle, label, period }) => localSearch.matches(query, [
            label,
            bundle.bundleId, bundle.preparedAt, bundle.preparedAtDisplay, bundle.promptMode,
            period, bundle.reportPeriod?.from, bundle.reportPeriod?.to,
            savedPrivacyLabel(bundle),
            ...(bundle.formats || []), ...Object.keys(bundle.files || {}), bundle.timeContext?.timeZone, bundle.timeContext?.locale,
        ]));
        setText($("savedReportSearchCount"), query ? `${count(matching.length)} of ${count(savedCount)} saved ${comparisonCount ? "items" : "reports"} match.` : "");
        if (!matching.length) { $("bundleList").append(empty("No saved reports match", "Try a title, date or file format, or clear this search.")); return; }
        pagedList(history, matching, { key: savedLibraryPageKey(), noun: comparisonCount ? "saved items" : "saved reports", jump: true, pagerAfter: true,
            signal: owner.events.signal, isCurrent: listCurrent, beforeReplace: erasePreparedNodes, onPage: () => leaveSavedInspectorContext(), wrapList: list => {
                const host = el("div", "saved-report-table"), columns = el("div", "saved-library-columns");
                columns.setAttribute("aria-hidden", "true");
                columns.append(el("span", "", "Report"), el("span", "", "Report text"), el("span", "", "Actions"));
                list.classList.add("saved-report-rows");
                host.append(columns, list); return host;
            }, renderItem: ({ bundle, preparedLabel, period }, rowListeners) => {
            detailOwner = "bundle:" + bundle.bundleId;
            const outer = viewKey(el("article", "saved-library-row"), detailOwner);
            outer.dataset.bundleId = bundle.bundleId;
            outer.toggleAttribute("data-detail-active", workspaceState.route.inspect === bundle.bundleId);
            const current = () => listCurrent() && outer.isConnected && outer.dataset.bundleId === bundle.bundleId && indexedSaved(bundle);
            const title = savedTitle(bundle), summary = savedTitleControl(bundle, current, false, rowListeners, preparedLabel, period);
            const identity = el("span", "saved-report-identity");
            const privacy = savedPrivacyStatus(bundle);
            identity.append(summary);
            const files = viewKey(button("Files", () => {}, "quiet saved-report-files"), "files-bundle:" + bundle.bundleId);
            files.prepend(ux.icon("report-files")); files.setAttribute("aria-label", "Files for " + title);
            ux.tooltip(files, "Choose a saved file");
            const fileEntries = registeredReportFiles(bundle);
            files.disabled = !fileEntries.length;
            savedReportMenu(files, fileEntries.map(format => ({
                label: reportFileLabel(format),
                action: () => openSavedReport(bundle, files, format),
            })), outer, current, rowListeners);
            const actions = el("div", "saved-report-actions");
            const inspect = viewKey(button("Inspect details", () => {
                if (current()) inspectSavedReport(bundle, inspect);
            }, "quiet", rowListeners), "inspect-bundle:" + bundle.bundleId);
            const remove = viewKey(button(bundle.kind === "comparison" ? "Delete saved comparison" : "Delete report", () => {
                if (current()) savedArtifactUI.open({ artifactKind: bundle.kind ?? "report", artifactId: bundle.bundleId, label: title }, remove);
            }, "quiet danger", rowListeners), "delete-bundle:" + bundle.bundleId);
            remove.disabled = workspaceState.stale && !workspaceState.loading || bundle.canDelete === false;
            actions.append(files, inspect, remove);
            outer.prepend(identity, privacy, actions);
            return outer;
        } });
        const unlisted = matching.filter(({ bundle, period }) => bundle.kind !== "comparison" && !period).length;
        if (unlisted) {
            const note = el("p", "saved-period-availability", unlisted === 1
                ? "The activity period isn't listed for one saved entry."
                : `Activity periods aren't listed for ${unlisted === matching.length ? "these " : ""}${count(unlisted)} saved entries.`);
            $("bundleList").append(note);
        }
        $("bundleList").append(history);
        })();
        if (workspaceState.route.inspect) renderSavedInspector();
        updateSelection();
    }
    function savedTitleControl(bundle, current, shelf, listeners, preparedLabel, period = savedPeriodLabel(bundle)) {
        const summary = viewKey(button("", () => {
            if (current() && summary.isConnected && indexedSaved(bundle)) openSavedReport(bundle, summary);
        }, "saved-report-title", listeners), "open-bundle:" + bundle.bundleId);
        summary.disabled = !savedReadableFormat(bundle);
        const caption = el("span", "saved-report-caption");
        const name = bundle.title?.trim() || assessmentFactories.reportIdentity.defaultTitle(bundle);
        caption.append(el("span", "saved-report-name", name));
        if (!shelf && preparedLabel !== "Time not recorded") caption.append(el("span", "saved-report-prepared", "Prepared " + preparedLabel));
        if (period) caption.append(el("span", "saved-report-period", shelf ? period : "Report period: " + period));
        else if (shelf) caption.append(el("span", "saved-report-period", bundle.kind === "comparison" ? "Saved comparison" : "Period not recorded"));
        summary.append(ux.icon("reports"), caption);
        summary.setAttribute("aria-label", "View report: " + (shelf ? name : savedTitle(bundle)));
        const metadata = Array.from(caption.children).slice(1);
        if (metadata.length) summary.setAttribute("aria-describedby", metadata.map((node, index) => {
            node.id = "saved-report-detail-" + encodeURIComponent(bundle.bundleId) + "-" + index;
            return node.id;
        }).join(" "));
        ux.tooltip(summary, "View report");
        return summary;
    }
    function savedLibraryPageKey() { return "saved-reports:" + localQuery("savedReportSearch") + (workspaceState.route.order === "oldest" ? ":oldest" : ""); }
    function savedPeriodLabel(bundle) {
        if (bundle.kind === "comparison") return null;
        if (bundle.reportType === "period-comparison") return "Two saved periods";
        const period = bundle.reportPeriod;
        if (period?.range === "capture") return "All retained dates";
        if (!period?.from || !period.to) return null;
        const context = bundle.timeContext || viewerTime;
        // Calendar boundaries are civil dates, not instants in the browser's zone.
        const civil = value => value.length === 10 ? value : time.day(value, context.timeZone);
        try {
            return time.formatCivilRange(civil(period.from), civil(period.to), context);
        } catch (error) { if (error instanceof RangeError) return null; throw error; }
    }
    function positionSavedMenu(menu, trigger) {
        const box = trigger.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
        menu.style.left = Math.max(12, Math.min(innerWidth - bounds.width - 12, box.right - bounds.width)) + "px";
        menu.style.top = (box.bottom + bounds.height + 8 <= innerHeight ? box.bottom + 8 : Math.max(12, box.top - bounds.height - 8)) + "px";
    }
    function savedReportMenu(trigger, entries, host, current, listeners) {
        const menu = el("div", "saved-report-menu");
        menu.setAttribute("popover", "auto"); menu.setAttribute("role", "dialog");
        menu.setAttribute("aria-label", trigger.getAttribute("aria-label"));
        for (const entry of entries) {
            const control = button(entry.label, () => {
                if (!current() || !control.isConnected) return;
                menu.hidePopover(); ux.hideTooltip(); entry.action();
            }, entry.danger ? "quiet danger" : "quiet", listeners);
            control.disabled = entry.disabled === true;
            menu.append(control);
        }
        bindSavedMenu(menu, trigger, current, listeners);
        host.append(menu);
    }
    function bindSavedMenu(menu, trigger, current, listeners) {
        menu.setAttribute("role", "dialog"); menu.setAttribute("aria-label", trigger.getAttribute("aria-label"));
        trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-expanded", "false");
        menu.addEventListener("beforetoggle", event => {
            if (event.newState === "closed" && menu.contains(document.activeElement) && current() && trigger.isConnected) ux.restoreFocus(trigger);
        }, listeners);
        trigger.addEventListener("click", () => {
            if (!current() || !trigger.isConnected) return;
            ux.hideTooltip();
            if (menu.matches(":popover-open")) { menu.hidePopover(); return; }
            menu.showPopover(); positionSavedMenu(menu, trigger);
            menu.querySelector("button:not(:disabled)")?.focus();
        }, listeners);
        menu.addEventListener("toggle", () => trigger.setAttribute("aria-expanded", String(menu.matches(":popover-open"))), listeners);
    }
    function savedReadableFormat(bundle) {
        const prefix = bundle.kind === "comparison" ? "comparison-report" : "product-report";
        return ["html", "json", "markdown", "pdf"].find(format => bundle.formats?.includes(format)
            || Object.hasOwn(bundle.files ?? {}, `${prefix}.${format === "markdown" ? "md" : format}`));
    }
    function savedFileName(bundle, format) {
        return format === "manifest" ? "coverage-and-redaction-manifest.json"
            : `${bundle.kind === "comparison" ? "comparison-report" : "product-report"}.${format === "markdown" ? "md" : format}`;
    }
    function registeredReportFiles(bundle) {
        return [...Object.keys(assessmentFactories.reportFileChoices), "manifest"].filter(format =>
            Object.hasOwn(bundle.files ?? {}, savedFileName(bundle, format)));
    }
    function reportFileLabel(format) {
        if (format === "manifest") return "File list (manifest)";
        const choice = assessmentFactories.reportFileChoices[format];
        return choice ? `${choice.purpose} (${choice.name})` : format;
    }
    function reportFilenameLabel(name) {
        const ext = name.split(".").at(-1);
        const format = name === "coverage-and-redaction-manifest.json" ? "manifest" : ext === "md" ? "markdown" : ext;
        return format === "manifest" || Object.hasOwn(assessmentFactories.reportFileChoices, format) ? reportFileLabel(format) : name;
    }
    function savedTitle(bundle) {
        if (!bundle) return "Report unavailable";
        return assessmentFactories.reportIdentity.title(bundle,
            bundle?.preparedAtDisplay || time.formatTime(bundle?.preparedAt, bundle?.timeContext || viewerTime));
    }
    function savedIdentity(bundle) {
        return bundle ? JSON.stringify([bundle.bundleId, bundle.kind || "report", bundle.title, bundle.manifestHash, bundle.files, bundle.formats, bundle.reportType]) : null;
    }
    function indexedSaved(bundle) {
        return workspaceState.evidence?.exports?.some(entry => savedIdentity(entry) === savedIdentity(bundle));
    }
    function savedEntry(kind, bundle, trigger, extra = {}) {
        const key = crypto.randomUUID();
        savedEntries.set(key, { kind, bundleId: bundle?.bundleId, origin: sessionJourney.savedOrigin(workspaceState.route),
            originEntry: workspaceState.route.savedEntry, reading: captureReading(), focusKey: trigger?.dataset.viewKey,
            navigationKey: window.navigation?.currentEntry?.key, inspectorTop: savedInspector ? contextBody.scrollTop : 0, ...extra });
        return key;
    }
    function inspectSavedReport(bundle, trigger) {
        if (workspaceState.route.inspect === bundle.bundleId) { (savedInspector?.heading || $("contextSidebarTitle")).focus({ preventScroll: true }); return; }
        const key = savedEntry("inspector", bundle, trigger);
        if (workspaceState.route.inspect) {
            const previous = savedEntries.get(workspaceState.route.savedEntry);
            if (previous) Object.assign(savedEntries.get(key), { origin: previous.origin, originEntry: previous.originEntry,
                navigationKey: previous.navigationKey, reading: previous.reading });
        }
        else ownSidebarHistory(true);
        // A replaced reader entry cannot also be the sidebar's Close destination.
        if (workspaceState.route.bundle) savedEntries.get(key).navigationKey = null;
        return navigate({ ...routeFor("reports"), inspect: bundle.bundleId, savedEntry: key }, Boolean(workspaceState.route.inspect || workspaceState.route.bundle));
    }
    function updateSavedRows() {
        for (const row of $("bundleList").querySelectorAll("[data-bundle-id]")) {
            const active = row.dataset.bundleId === workspaceState.route.inspect;
            row.toggleAttribute("data-detail-active", active);
            row.querySelector(".saved-report-summary")?.setAttribute("aria-expanded", String(active));
        }
    }
    function backSaved() {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return;
        const entry = savedEntries.get(workspaceState.route.savedEntry);
        const origin = entry?.origin && entry.bundleId === (workspaceState.route.bundle || workspaceState.route.inspect) ? { ...entry.origin, savedEntry: entry.originEntry }
            : { view: "reports", order: workspaceState.route.order, localSearch: workspaceState.route.localSearch };
        // Opaque document section links can add child-frame history entries.
        if (entry?.navigationKey && window.navigation?.entries().some(item => item.key === entry.navigationKey)) {
            window.navigation.traverseTo(entry.navigationKey).finished.catch(error => {
                if (!api.isCurrent(publication)) return;
                announce("The previous history entry could not be restored. Returning to the saved origin. " + error.message, "error");
                applyRoute(origin, { restorePosition: true });
            });
        } else applyRoute(origin, { restorePosition: true });
    }
    function closeSavedInspector(restoreFocus = true, immediate = false) {
        const previous = savedInspector;
        if (!previous) return;
        savedArtifactUI?.clearEligibility();
        const navigation = workspaceState.navigationGeneration, intent = workspaceState.readingIntent;
        clearOriginalRead(previous);
        savedInspector = null;
        contextSidebar.inert = true;
        sidebarExit = { bundleId: previous.bundleId, cleanup: () => { previous.body.remove(); previous.footer.remove(); } };
        hideContextSidebar({ restoreFocus: false, onClosed: () => {
            clearSidebarExit();
            if (restoreFocus && navigation === workspaceState.navigationGeneration && intent === workspaceState.readingIntent && !savedInspector) {
                ux.restoreFocus(keyed(previous.focusKey) || keyed("inspect-bundle:" + previous.bundleId) || $("savedLibraryTitle"));
            }
        } });
        if (immediate) finishSidebarMotion();
    }
    function leaveSavedInspectorContext() {
        if (!workspaceState.route.inspect) return;
        closeSavedInspector(false, true);
        workspaceState.route = { ...workspaceState.route, inspect: undefined, savedEntry: undefined };
        rememberRoute(workspaceState.route, true);
        workspaceState.acceptedRoute = { ...workspaceState.route };
    }
    function savedDownloads(bundle, isCurrent, openFile) {
        const downloads = el("div", "saved-report-downloads"), field = el("label", "saved-file-choice", openFile ? "" : "File"), select = el("select");
        select.setAttribute("aria-label", "Saved file");
        for (const name of Object.keys(bundle.files || {}).sort((a, b) => Number(a === "coverage-and-redaction-manifest.json") - Number(b === "coverage-and-redaction-manifest.json"))) {
            select.append(option(name, reportFilenameLabel(name)));
        }
        const control = button("Download", async () => {
            if (!isCurrent() || !select.value || control.disabled) return;
            const name = select.value;
            control.disabled = select.disabled = true;
            try { await downloadReportFile(bundle, name, isCurrent); }
            catch (error) { if (isCurrent()) announce(error.message, "error"); }
            finally { if (isCurrent()) { control.disabled = select.disabled = false; selectControls?.sync(); } }
        }, "quiet");
        field.append(select); downloads.append(field);
        if (openFile) {
            select.id = "savedInspectorFormat";
            const open = viewKey(button("Open", event => {
                if (!isCurrent() || open.hidden) return;
                const extension = select.value.split(".").at(-1);
                openFile(select.value === "coverage-and-redaction-manifest.json" ? "manifest" : extension === "md" ? "markdown" : extension, event.currentTarget);
            }, "primary"), "inspector-open:" + bundle.bundleId);
            open.setAttribute("aria-label", "Open saved " + (bundle.kind === "comparison" ? "comparison" : "report"));
            downloads.append(open);
        }
        downloads.append(control);
        return downloads;
    }
    function renderSavedInspector() {
        const publication = api.publicationToken();
        const bundle = workspaceState.evidence.exports?.find(item => item.bundleId === workspaceState.route.inspect);
        savedArtifactUI?.observeEligibility();
        savedInspector?.refreshEligibility?.(workspaceState.evidence?.revision);
        if (savedInspector?.bundleId === workspaceState.route.inspect && savedInspector.metadata === JSON.stringify(bundle)) return;
        if (savedInspector) { clearOriginalRead(savedInspector); savedInspector.body.remove(); savedInspector.footer.remove(); savedInspector = null; }
        if (!contextOwner?.identity.startsWith("saved:")) finishSidebarMotion();
        const body = el("section", "saved-report-inspection"), footer = el("div", "saved-inspector-actions");
        const heading = el("h2", "saved-inspector-title");
        heading.id = "savedInspectorTitle";
        heading.tabIndex = -1;
        heading.autofocus = true;
        body.append(heading);
        const focusKey = savedEntries.get(workspaceState.route.savedEntry)?.focusKey, trigger = keyed(focusKey);
        const anchor = trigger?.closest(".saved-library-row") || trigger || keyed("bundle:" + workspaceState.route.inspect);
        const current = { body, heading, footer, bundleId: workspaceState.route.inspect, metadata: JSON.stringify(bundle), focusKey, anchor };
        savedInspector = current;
        const valid = () => api.isCurrent(publication) && savedInspector === current && bundle
            && workspaceState.evidence.exports.some(entry => entry.bundleId === bundle.bundleId && JSON.stringify(entry) === current.metadata);
        if (!bundle) body.append(el("p", "error", "This saved item is no longer available. Return to the library and refresh."));
        else {
            const facts = el("dl", "saved-inspector-facts");
            const add = (label, value) => { if (value !== undefined && value !== null && value !== "") facts.append(cardFact(label, value)); };
            add("Prepared", bundle.preparedAtDisplay || time.formatTime(bundle.preparedAt, bundle.timeContext || viewerTime));
            add("Scope", ({ all: "All saved activity", current: "Analyze selection", selected: "Selected interactions" })[bundle.selectionScope?.kind]);
            const nativeConversations = bundle.selectionScope?.nativeConversations;
            const hasNative = Number.isSafeInteger(nativeConversations) && nativeConversations >= 0;
            if (Number.isSafeInteger(bundle.selectionScope?.requestGroups) && bundle.selectionScope.requestGroups >= 0) add(hasNative ? "GitHub interactions" : "Interactions", count(bundle.selectionScope.requestGroups));
            if (hasNative) add("Microsoft conversations", count(nativeConversations));
            add("Prompts", ({ none: "None", masked: "Masked", original: "Original" })[bundle.promptMode]);
            add("Report period", savedPeriodLabel(bundle));
            add("Purpose", ({ all: "All activity", errors: "Errors & failures", completed: "Completed calls",
                mine: "Human prompts", agent: "Agent prompts", custom: "Activity report" })[bundle.reportPurpose]);
            if (bundle.timeContext) add("Timezone", time.label(bundle.timeContext));
            body.append(facts);
            if (bundle.kind !== "comparison" && !savedPeriodLabel(bundle)) body.append(el("p", "saved-period-availability",
                "Activity period not listed in this saved entry. The report itself may include its dates. Preparation time is separate from the activity period."));
            if (bundle.reportType === "period-comparison") body.append(el("p", "", "Period A and Period B are fixed saved cohorts."));
            const target = { artifactKind: bundle.kind === "comparison" ? "comparison" : "report", artifactId: bundle.bundleId };
            const remove = button(bundle.kind === "comparison" ? "Delete saved comparison" : "Delete report", event => {
                if (valid() && (!workspaceState.stale || workspaceState.loading)) savedArtifactUI.open({
                    ...target, label: savedTitle(bundle) }, event.currentTarget);
            }, "danger");
            body.append(remove);
            // Collection refresh does not change this saved item; the preview checks current authority.
            current.refreshEligibility = () => { remove.disabled = !valid() || workspaceState.stale && !workspaceState.loading; };
            current.refreshEligibility();
            ux.explainDisabled(remove, () => "The saved report view could not be verified. Retry the stored read.", { compact: true });
            if (savedReadableFormat(bundle)) {
                if (assessmentFactories.reportIdentity.legacyCandidate(bundle)) {
                    const note = el("section", "saved-original-notice");
                    note.id = "savedOriginalNotice";
                    note.append(el("h3", "", "Before opening or downloading"),
                        el("p", "", "WIRE can't confirm the privacy review from when this file was saved. It may contain information that wasn't approved for disclosure."),
                        el("p", "", "This does not judge report accuracy or account identity. File identity and integrity checks still apply. Opening or downloading does not approve sharing."));
                    body.append(note);
                    footer.append(originalFileControls(bundle, valid, current));
                } else if (Array.isArray(bundle.formats) && bundle.formats.length) {
                    footer.append(savedDownloads(bundle, valid, (format, trigger) => openSavedReport(bundle, trigger, format)));
                } else footer.append(viewKey(button("Open saved " + (bundle.kind === "comparison" ? "comparison" : "report"), event => {
                    if (valid()) openSavedReport(bundle, event.currentTarget);
                }, "primary"), "inspector-open:" + bundle.bundleId));
            } else {
                footer.append(el("p", "error", "No supported saved format is registered for this report."));
            }
        }
        showContextSidebar({ identity: "saved:" + workspaceState.route.inspect, title: savedTitle(bundle), body, bodyTitle: heading, footer,
            anchor, requestClose: backSaved, closeLabel: "Close saved report details" });
        contextBody.scrollTop = 0;
        heading.focus({ preventScroll: true });
    }
    function clearOriginalRead(owner) {
        owner?.originalBytes?.fill(0);
        if (owner) owner.originalBytes = owner.originalResult = null;
    }
    function clearSavedReader() {
        if (savedReportView) {
            savedReportView.invalid = true;
            clearOriginalRead(savedReportView);
            clearOriginalRead(savedReportView.read);
            clearOriginalRead(savedReportView.downloadRead);
            savedReportView.preview?.dispose();
            savedReportView.reportPreview?.dispose();
            savedReportView.reportValue = null;
            savedReportView.closeNotice?.();
            if (savedReportView.headingHome?.isConnected) savedReportView.headingHome.replaceWith($("pageTitle"));
            savedReportView.downloadValue = null;
            savedReportView.title = "";
        }
        savedReportView = null;
        $("savedReportReader").replaceChildren();
    }
    function invalidateSavedReader(message) {
        if (!savedReportView) return;
        savedReportView.invalid = true;
        clearOriginalRead(savedReportView);
        clearOriginalRead(savedReportView.read);
        clearOriginalRead(savedReportView.downloadRead);
        savedReportView.preview?.dispose();
        savedReportView.reportPreview?.dispose();
        savedReportView.reportValue = null;
        savedReportView.closeNotice?.();
        savedReportView.downloadValue = null;
        savedReportView.body.replaceChildren(el("p", "error", message));
        savedReportView.actions.replaceChildren();
    }
    function openSavedReport(bundle, trigger, format, original = false) {
        if (!original && assessmentFactories.reportIdentity.legacyCandidate(bundle))
            return inspectSavedReport(bundle, trigger);
        const key = savedEntry("reader", bundle, trigger, { format, original, reportView: format === undefined });
        if (workspaceState.route.view === "reports" && workspaceState.route.task === "create" && reportJourney.snapshot().step === 3) {
            const origin = periodReport?.returnTo ?? sessionJourney.returnRoute({ ...workspaceState.route, task: undefined });
            Object.assign(savedEntries.get(key), {
                origin, originEntry: undefined, navigationKey: null,
                reading: periodReport ? workspaceState.positions.get(readingKey(origin)) : null,
                focusKey: periodReport ? undefined : "open-bundle:" + bundle.bundleId,
            });
        }
        return navigate({ ...routeFor("reports"), bundle: bundle.bundleId, savedEntry: key });
    }
    function savedPrivacyLabel(bundle) {
        return ({ masked: "Detected personal details hidden", original: "Chat details kept",
            none: "Prompts and replies left out" })[bundle?.promptMode] ?? "Text treatment not recorded";
    }
    function savedPrivacyStatus(bundle) {
        const node = el("span", "saved-report-privacy");
        node.dataset.promptMode = bundle?.promptMode ?? "unknown";
        node.append(ux.icon(["masked", "original", "none"].includes(bundle?.promptMode) ? "report-" + bundle.promptMode : "unobserved"),
            el("span", "", savedPrivacyLabel(bundle)));
        return node;
    }
    async function renderSavedReader() {
        const publication = api.publicationToken();
        if (!publication || !workspaceState.evidence) return;
        if (hiddenCards.any()) {
            clearSavedReader();
            $("savedReportReader").replaceChildren(button("Back to Reports", backSaved, "quiet"),
                empty("Saved file kept closed", "While a card is hidden, WIRE keeps all saved reports and comparisons closed. A file can quote a card it didn’t count. Restore hidden cards in Analyze to open saved files again."));
            return;
        }
        if (savedReportView?.bundleId === workspaceState.route.bundle && savedReportView.entryKey === workspaceState.route.savedEntry) return;
        clearSavedReader();
        const entry = savedEntries.get(workspaceState.route.savedEntry), bundle = workspaceState.evidence.exports?.find(item => item.bundleId === workspaceState.route.bundle);
        if (workspaceState.route.savedAuthority !== "search" && bundle && !entry?.original
            && assessmentFactories.reportIdentity.legacyCandidate(bundle)) {
            inspectSavedReport(bundle, keyed("open-bundle:" + bundle.bundleId)); return;
        }
        const host = $("savedReportReader"), header = el("header", "saved-reader-heading"), body = el("div", "saved-reader-body"), actions = el("div", "saved-reader-actions");
        const backLabel = entry?.searchReturn ? "Back to search" : entry?.origin?.task === "library" ? "Back to saved reports" : entry?.origin?.compare === "periods" ? "Back to comparison" : "Back to Reports";
        const back = button(backLabel, backSaved, "quiet document-back");
        back.setAttribute("aria-label", backLabel);
        back.prepend(ux.icon("back"));
        const headingHome = document.createComment("saved reader title home");
        $("pageTitle").before(headingHome);
        const identity = el("div", "saved-reader-identity"), titleBlock = el("div", "saved-reader-title");
        titleBlock.append($("pageTitle"));
        const artifact = bundle || entry?.value?.artifact;
        const period = artifact && savedPeriodLabel(artifact);
        if (period || artifact?.preparedAt || artifact?.preparedAtDisplay) {
            const meta = el("dl", "saved-reader-meta");
            meta.append(period ? cardFact("Report period", period) : cardFact("Prepared", artifact.preparedAt
                ? time.formatDate(artifact.preparedAt, artifact.timeContext || viewerTime, true) : artifact.preparedAtDisplay));
            titleBlock.append(meta);
        }
        titleBlock.append(savedPrivacyStatus(artifact));
        identity.append(titleBlock, actions); header.append(back, identity);
        const stage = el("section", "document-stage"), toolbar = el("div", "document-file-toolbar");
        stage.append(toolbar, body); host.replaceChildren(header, stage);
        const current = { body, actions, header, toolbar, headingHome, title: savedTitle(artifact), bundleId: workspaceState.route.bundle, identity: savedIdentity(bundle), entryKey: workspaceState.route.savedEntry, invalid: false };
        savedReportView = current;
        setText($("pageTitle"), current.title);
        const ownsReader = () => api.isCurrent(publication) && savedReportView === current && !current.invalid && workspaceState.route.bundle === current.bundleId;
        const valid = () => ownsReader() && (workspaceState.route.savedAuthority === "search" ? entry?.isCurrent?.() : bundle && indexedSaved(bundle));
        if (workspaceState.route.savedAuthority === "search") {
            try {
                if (!entry?.value || !valid()) throw new Error("This Search destination is no longer current. Return to Search and open its verified current item.");
                const value = entry.value;
                delete entry.value;
                toolbar.append(el("span", "saved-reader-format", "Viewing: " + reportFileLabel(value.kind)));
                if (value.kind === "pdf") {
                    current.downloadValue = value;
                    const download = button("Download", () => {
                        if (valid() && current.downloadValue) downloadOriginalValue(current.downloadValue, valid);
                    }, "primary");
                    download.prepend(ux.icon("download")); actions.append(download);
                }
                paintSavedDocument(body, value, valid);
            } catch (error) { if (ownsReader()) body.replaceChildren(el("p", "notice error", error.message)); }
            return;
        }
        if (!bundle) { body.replaceChildren(el("p", "notice error", "This saved item is no longer available. Nothing was regenerated.")); return; }
        const originalIdentity = JSON.stringify(bundle);
        const readable = () => {
            if (!valid()) return false;
            if (!entry?.original || workspaceState.evidence.exports.some(item => item.bundleId === bundle.bundleId && JSON.stringify(item) === originalIdentity)) return true;
            invalidateSavedReader("This saved original changed. Return to the library and open it again.");
            return false;
        };
        if (entry?.original) {
            const sharing = button("Before sharing", () => showSavedFileNotice(current, readable, sharing, true), "quiet saved-sharing-action");
            sharing.prepend(ux.icon("info")); actions.append(sharing);
        }
        const selector = el("select"), viewing = el("label", "", "Viewing");
        const fileHint = el("p", "context-help-note", "Viewing a saved file leaves the saved copy unchanged.");
        fileHint.id = "savedFileViewingHint"; fileHint.hidden = true; toolbar.after(fileHint);
        selector.id = "savedReaderFormat"; viewing.htmlFor = selector.id;
        const formats = Array.isArray(bundle.formats) && bundle.formats.length
            ? registeredReportFiles(bundle).filter(format => !entry?.original || format !== "manifest")
            : [savedReadableFormat(bundle)].filter(Boolean);
        selector.append(option("report", "Report in WIRE"));
        for (const format of formats) selector.append(option(format, reportFileLabel(format)));
        current.updateViewingChoices = select => {
            // Finishing verified Open may add a reading mode, but must not move a file choice under the pointer.
            if (select !== selector || !valid() || selectControls?.isOpen(selector)
                || !current.reportHost?.classList.contains("saved-brief-host") || selector.querySelector('[value="document"]')) return;
            selector.options[0].textContent = "Brief";
            selector.options[0].after(option("document", "Full report"));
        };
        selector.value = (entry?.reportView ?? !entry?.format) ? "report"
            : formats.includes(entry?.format) ? entry.format : savedReadableFormat(bundle);
        toolbar.append(viewing, selector);
        const expand = button("Expand sections", () => {
            current.expanded = !current.expanded; void show();
        }, "quiet");
        current.expand = expand;
        toolbar.append(expand);
        const download = button("Download", async () => {
            if (!readable() || download.disabled) return;
            const read = current.read, format = selector.value, downloadRead = {};
            current.downloadRead = downloadRead;
            const active = () => readable() && current.read === read;
            download.disabled = true;
            try {
                if (entry?.original) {
                    const value = await readOriginalFile(bundle, format, active, downloadRead, true);
                    if (value && active()) downloadOriginalValue(value, active);
                } else await downloadReportFile(bundle, savedFileName(bundle, format), active);
            } catch (error) { if (active()) announce(error.message, "error"); }
            finally { if (active()) download.disabled = false; clearOriginalRead(downloadRead); }
        }, "primary");
        download.prepend(ux.icon("download"));
        download.disabled = true;
        if (Array.isArray(bundle.formats) && bundle.formats.length) actions.append(download);
        async function show() {
            if (!readable()) return;
            clearOriginalRead(current.read); clearOriginalRead(current.downloadRead);
            current.preview?.dispose(); current.preview = null;
            if (current.reportHost) current.reportHost.hidden = true;
            const showingReport = selector.value === "report" || selector.value === "document";
            const completeDocument = selector.value === "document";
            fileHint.hidden = showingReport;
            if (showingReport) selector.removeAttribute("aria-describedby"); else selector.setAttribute("aria-describedby", fileHint.id);
            const read = {}, format = showingReport ? savedReadableFormat(bundle) : selector.value;
            const kind = bundle.kind === "comparison" ? "comparison" : "report";
            if (!showingReport && current.reportValue?.kind === "pdf") {
                current.reportPreview?.dispose(); current.reportHost?.remove();
                current.reportPreview = current.reportHost = current.reportValue = null;
            }
            current.read = read;
            if (entry) { entry.format = format; entry.reportView = showingReport; }
            download.hidden = showingReport;
            expand.hidden = true;
            expand.textContent = current.expanded ? "Collapse sections" : "Expand sections";
            const active = () => readable() && current.read === read;
            download.disabled = true;
            for (const child of [...body.children]) if (child !== current.reportHost) child.remove();
            body.append(el("p", "saved-reader-loading", showingReport ? "Opening report..." : `Opening ${reportFileLabel(format)}...`));
            try {
                if (!format) throw new Error("No supported saved format is registered for this report.");
                let value;
                if (showingReport) {
                    value = await api("/api/report/open", { bundleId: bundle.bundleId, kind, view: true,
                        ...(entry?.original ? { original: true } : {}) });
                    if (!active()) return;
                    if (value.artifact?.bundleId !== bundle.bundleId || value.artifact.kind !== kind
                        || !["html", "markdown", "pdf"].includes(value.format)
                        || value.sourceFormat !== savedReadableFormat(bundle)
                        || (value.format === "pdf" ? typeof value.data !== "string" : typeof value.text !== "string")
                        || (entry?.original ? value.source !== "legacy-original" || value.verification !== "unverified"
                            : value.source !== undefined || value.verification !== undefined)) {
                        throw new Error("The saved report view did not match this report.");
                    }
                    value = { ...value, kind: value.format };
                    expand.hidden = value.kind !== "html";
                } else if (entry?.original) {
                    if (!assessmentFactories.reportIdentity.legacyCandidate(bundle)) throw new Error("This saved original changed. Open its current files from the library.");
                    value = await readOriginalFile(bundle, format, active, read);
                    if (!value || !active()) return;
                } else {
                    const result = kind === "report" && format === "html"
                        ? await api("/api/report/open", { bundleId: bundle.bundleId })
                        : await api("/api/artifact-file", { bundleId: bundle.bundleId, kind, format });
                    if (!active()) return;
                    let text = result.html;
                    if (kind !== "report" || format !== "html") {
                        if (result.artifact?.kind !== kind || result.format !== format || result.name !== savedFileName(bundle, format)
                            || result.encoding !== "base64" || result.manifestHash !== bundle.manifestHash || typeof result.data !== "string")
                            throw new Error("The verified saved file is unavailable. Nothing was regenerated.");
                        if (format !== "pdf") text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(result.data), c => c.charCodeAt(0)));
                    }
                    if (result.artifact?.bundleId !== bundle.bundleId || result.artifact.kind !== kind
                        || format !== "pdf" && typeof text !== "string" || !indexedSaved(bundle)) throw new Error("This saved artifact is no longer available.");
                    value = { kind: format, text, data: format === "pdf" ? result.data : undefined, name: result.name,
                        artifact: result.artifact, brandVersion: result.brandVersion };
                }
                if (!active()) return;
                download.disabled = false;
                paintSavedDocument(body, value, active, showingReport, completeDocument);
                if (showingReport) current.updateViewingChoices(selector);
                selectControls?.sync();
            } catch (error) {
                if (active()) {
                    expand.hidden = true;
                    current.reportPreview?.dispose(); current.reportHost?.remove();
                    current.reportPreview = current.reportHost = current.reportValue = null;
                    const notice = el("p", "notice error", error.message); notice.setAttribute("role", "alert");
                    body.replaceChildren(notice);
                }
            }
        }
        selector.addEventListener("change", show);
        selectControls?.sync(); await show();
    }
    function originalFileControls(bundle, valid, current) {
        const controls = el("div", "original-file-controls"), label = el("label", "", "File format"), format = el("select");
        format.id = "savedOriginalFormat"; label.htmlFor = format.id;
        format.setAttribute("aria-describedby", "savedOriginalNotice");
        for (const name of ["html", "json", "markdown", "pdf"]) if (bundle.formats.includes(name)) format.append(option(name, reportFileLabel(name)));
        const read = button("Open", event => {
            if (valid() && !read.disabled) openSavedReport(bundle, event.currentTarget, format.value, true);
        }, "primary");
        read.setAttribute("aria-label", "Open original file");
        const view = button("View report", event => {
            if (valid()) openSavedReport(bundle, event.currentTarget, undefined, true);
        }, "primary");
        view.setAttribute("aria-describedby", "savedOriginalNotice");
        const download = button("Download", async () => {
            if (!valid() || download.disabled) return;
            const selected = format.value;
            download.disabled = read.disabled = format.disabled = true;
            selectControls?.sync();
            try {
                const value = await readOriginalFile(bundle, selected, valid, current, true);
                if (!value || !valid()) return;
                downloadOriginalValue(value, valid);
            } catch (error) {
                if (valid()) announce("The original could not be opened. " + error.message, "error");
            } finally {
                if (valid()) {
                    download.disabled = read.disabled = format.disabled = false; selectControls?.sync();
                }
            }
        }, "quiet");
        read.setAttribute("aria-describedby", "savedOriginalNotice");
        download.setAttribute("aria-describedby", "savedOriginalNotice");
        const labelAction = () => {
            const pdf = format.value === "pdf";
            download.setAttribute("aria-label", pdf ? "Download original PDF" : "Download original file");
        };
        format.addEventListener("change", labelAction);
        labelAction();
        const field = el("div", "original-file-choice");
        field.append(label, format); controls.append(view, field, read, download);
        return controls;
    }
    async function readOriginalFile(bundle, format, valid, current, downloadOnly = false) {
        if (!valid()) return null;
        let result = await api("/api/report-original", { bundleId: bundle.bundleId, kind: "report", format });
        if (!valid()) return null;
        const extension = format === "markdown" ? "md" : format;
        if (result.source !== "legacy-original" || result.verification !== "unverified" || result.format !== format
            || result.artifact?.bundleId !== bundle.bundleId || result.artifact.kind !== "report"
            || result.name !== `product-report.${extension}` || result.encoding !== "base64" || typeof result.data !== "string"
            || !/^[a-f0-9]{64}$/.test(result.currentDigest) || result.manifestHash !== undefined) throw new Error("The original-file response did not match this report.");
        current.originalBytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
        current.originalResult = result; result = null;
        try {
            const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", current.originalBytes))].map(value => value.toString(16).padStart(2, "0")).join("");
            if (!valid()) return null;
            result = current.originalResult;
            if (digest !== result.currentDigest) throw new Error("The original-file response changed during this read.");
            return { kind: format, source: "legacy-original", verification: "unverified", artifact: result.artifact,
                name: result.name, ...(format === "pdf" || downloadOnly ? { data: result.data } : { text: new TextDecoder("utf-8", { fatal: true }).decode(current.originalBytes) }) };
        } finally { clearOriginalRead(current); }
    }
    function paintSavedDocument(body, value, valid, reportView = false, completeDocument = false) {
        if (!valid()) return;
        const artifact = value.artifact;
        if (typeof artifact?.title === "string" && artifact.title.trim()) savedReportView.title = savedTitle(artifact);
        setText($("pageTitle"), savedReportView.title);
        const current = savedReportView;
        for (const child of [...body.children]) if (child !== current.reportHost) child.remove();
        if (artifact?.sourceReports?.some(source => !source.available)) body.append(el("p", "muted",
            "An original report is no longer available. This independently reviewed saved copy is unchanged."));
        if (reportView) {
            const previous = current.reportValue;
            if (previous?.kind === value.kind && previous.completeDocument === completeDocument && previous.text === value.text && previous.data === value.data
                && previous.expanded === current.expanded) {
                current.reportHost.hidden = false;
                current.expand.hidden = value.kind !== "html" || previous.expandable === false;
                return;
            }
            current.reportPreview?.dispose(); current.reportHost?.remove();
            const preview = el("div", "saved-reader-file");
            current.reportHost = preview; body.append(preview);
            current.reportValue = { kind: value.kind, text: value.text, data: value.data, expanded: current.expanded, completeDocument };
            const publication = api.publicationToken(), held = current.reportValue;
            const currentReport = () => api.isCurrent(publication) && savedReportView === current && !current.invalid
                && current.reportValue === held && workspaceState.route.bundle === current.bundleId
                && workspaceState.evidence.exports?.some(entry => savedIdentity(entry) === current.identity);
            if (value.brief && !completeDocument) {
                current.reportPreview = assessmentFactories.mountSavedReportBrief(preview, value, { icon: ux.icon, isCurrent: currentReport });
                if (current.reportPreview) {
                    held.expandable = false;
                    current.expand.hidden = true;
                    preview.classList.add("saved-brief-host");
                    return;
                }
            }
            current.reportPreview = assessmentFactories.savedFilePreview(preview, value, {
                frozenFrame: assessmentFactories.liveSearch.frozenFrame, isCurrent: currentReport, toolbar: current.toolbar,
                icon: ux.icon, title: current.title, brand: cloneReportBrand,
                readingDocument: source => {
                    assessmentFactories.enhanceReportReading(source, { expanded: current.expanded, brand: cloneReportBrand, icon: ux.icon, saved: true });
                    // The new reading uses named, native disclosures inside the opaque frame.
                    // Never replace the verified document just to open or close one of its sections.
                    held.expandable = !source.querySelector('main[data-finding-version="1"]')
                        && Boolean(source.querySelector(".wire-reading-section,.wire-reading-interaction"));
                    current.expand.hidden = !held.expandable;
                },
                onError: error => {
                    if (!currentReport()) return;
                    current.expand.hidden = true;
                    const notice = el("p", "notice error", error.message); notice.setAttribute("role", "alert");
                    body.replaceChildren(notice);
                },
            });
            return;
        }
        const preview = el("div", "saved-reader-file");
        body.append(preview);
        const name = value.name || savedFileName(artifact || {}, value.kind);
        const mounted = mountFileInspection(preview, { [name]: value.kind === "pdf" ? { data: value.data } : value.text }, {
            id: "savedFileView", toolbar: current.toolbar, title: current.title, isCurrent: valid, brandVersion: value.brandVersion,
            onInfo: (file, format, trigger) => showSavedFileNotice(current, valid, trigger, false, { file, format,
                prepared: artifact?.preparedAtDisplay || time.formatTime(artifact?.preparedAt, artifact?.timeContext || viewerTime) }),
        });
        current.preview = mounted;
        mounted.refresh();
    }
    function showSavedFileNotice(current, valid, trigger, sharing, file) {
        if (!valid()) return;
        current.closeNotice?.();
        ux.hideTooltip();
        const dialog = el("dialog", "saved-file-notice"), heading = el("h2", "", sharing ? "Before you share this file" : "About this file");
        heading.id = "savedFileNoticeTitle"; heading.tabIndex = -1; dialog.setAttribute("aria-labelledby", heading.id);
        const top = el("div", "dialog-head"), content = el("div", "dialog-body");
        const close = button("Close", () => dismiss(), "quiet");
        close.setAttribute("aria-label", "Close file information");
        close.replaceChildren(ux.icon("close")); top.append(heading, close);
        if (sharing) {
            content.append(el("p", "saved-sharing-lead", "Check that its contents are appropriate to share."),
                el("p", "", "WIRE can't confirm the privacy review from when this older file was saved. It may contain information that wasn't approved for disclosure."),
                el("p", "", "Opening or downloading the file does not approve sharing it."),
                el("p", "saved-sharing-detail", "This notice does not mean the report is inaccurate, your account is unverified, or the file is damaged. File identity and integrity are checked separately."));
        } else {
            const facts = el("dl", "saved-inspector-facts");
            facts.append(cardFact("File", file.file), cardFact("Format", file.format), cardFact("Prepared", file.prepared));
            content.append(facts, el("p", "", "This is a read-only saved file. Download keeps its original bytes."));
        }
        content.append(button("Got it", () => dismiss(), "primary"));
        dialog.append(top, content);
        const discard = () => {
            const walker = document.createTreeWalker(dialog, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) walker.currentNode.data = "";
            dialog.replaceChildren(); dialog.remove(); current.closeNotice = null;
        };
        const cleanup = () => { discard(); if (valid() && trigger.isConnected) trigger.focus({ preventScroll: true }); };
        const dismiss = () => { dialog.removeEventListener("close", cleanup); dialog.close(); cleanup(); };
        dialog.addEventListener("close", cleanup, { once: true });
        dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
        current.closeNotice = () => { dialog.removeEventListener("close", cleanup); dialog.close(); discard(); };
        document.body.append(dialog); dialog.showModal(); heading.focus({ preventScroll: true });
    }
    function downloadOriginalValue(value, valid) {
        if (!valid()) return;
        const bytes = Uint8Array.from(atob(value.data), character => character.charCodeAt(0));
        const anchor = el("a"); anchor.href = privateObjectUrl(bytes); anchor.download = value.name || "product-report.pdf";
        bytes.fill(0);
        if (valid()) { anchor.click(); announce(value.source === "legacy-original"
            ? "Original file download started. Its privacy review is unverified." : "Saved file download started."); }
    }
    async function downloadReportFile(bundle, name, isCurrent = () => true) {
        const publication = api.publicationToken();
        if (!publication || !isCurrent()) return;
        const kind = bundle.kind === "comparison" ? "comparison" : "report";
        const prefix = kind === "comparison" ? "comparison-report" : "product-report";
        const formats = { [`${prefix}.html`]: "html", [`${prefix}.pdf`]: "pdf", [`${prefix}.json`]: "json",
            [`${prefix}.md`]: "markdown", "coverage-and-redaction-manifest.json": "manifest" };
        if (!Object.hasOwn(formats, name)) throw new Error("This saved file format is unsupported. No download was started.");
        const result = await api("/api/artifact-file", { bundleId: bundle.bundleId, kind, format: formats[name] });
        if (!api.isCurrent(publication)) return;
        if (!isCurrent() || !indexedSaved(bundle)
            || result.artifact?.bundleId !== bundle.bundleId || result.artifact?.kind !== kind || result.name !== name
            || result.format !== formats[name] || result.manifestHash !== bundle.manifestHash || result.encoding !== "base64"
            || typeof result.data !== "string") throw new Error("This verified saved file is no longer available. No download was started.");
        const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
        if (!api.isCurrent(publication) || !isCurrent()) { bytes.fill(0); return; }
        const url = privateObjectUrl(bytes);
        const anchor = el("a");
        anchor.href = url; anchor.download = name;
        if (!api.isCurrent(publication) || !isCurrent()) return;
        anchor.click();
    }
    async function move(scenario, toState, control) {
        const publication = api.publicationToken();
        if (!publication) return;
        if (workspaceState.stale || workspaceState.loading) { announce("Wait for the activity snapshot to finish updating before changing review state.", "stale"); return; }
        control.disabled = true;
        try {
            await api("/api/move", { scenarioId: scenario.scenarioId, toState });
            if (!api.isCurrent(publication)) return;
            if (await load() && api.isCurrent(publication)) announce("Review state updated. Recorded results are unchanged.");
        } catch (error) { if (api.isCurrent(publication)) { announce(error.message, "error"); control.disabled = false; } }
    }
    let coverageDetailsKey;
    function renderCoverage() {
        detailOwner = "coverage";
        const coverage = workspaceState.evidence.coverage || {};
        const c = workspaceState.analytics.coverage;
        const gaps = [];
        if (c.unknownSessionRows) gaps.push(`${count(c.unknownSessionRows)} matching records have no known source chat.`);
        if (!coverage.graphHistory && ["direct-request", "recorded-http", "code-reference"].includes(workspaceState.scope.layer))
            gaps.push("Graph history has not been scanned; coverage is unknown.");
        setText($("activityCoverageGap"), gaps.join(" "));
        $("coverageNotice").hidden = !gaps.length;
        renderCoverageDetails();
    }
    function renderCoverageDetails() {
        if (!workspaceState.evidence || !workspaceState.analytics || !workspaceState.scope) return;
        const host = $("collectionEvidenceDetails"), coverage = workspaceState.evidence.coverage || {}, c = workspaceState.analytics.coverage;
        const http = workspaceState.scope.layer === "http";
        const sources = http ? `${count(c.sessionCount)} recorder source${c.sessionCount === 1 ? "" : "s"}` : chatCopy.count(c.sessionCount);
        const unscoped = c.unscopedSessionCount
            ? ` ${count(c.unscopedSessionCount)} ${http ? "source" : "chat"}${c.unscopedSessionCount === 1 ? " has" : "s have"} no project.` : "";
        // The coverage projection describes the GitHub/recorder population, not the
        // separately paged Microsoft source. Never combine unlike denominators.
        const native = sharedNativeView(), sourceFilter = workspaceState.scope.filters.sources;
        const withGitHub = !sourceFilter?.length || sourceFilter.includes("github-copilot");
        const scope = hasMicrosoftSource() && !http ? "GitHub activity" : scopeLabels[workspaceState.scope.filters.scope] || "Selected collection";
        const membership = [];
        if (withGitHub) membership.push(`${scope}: ${count(c.scenarioCount)} ${http ? "record group" : "interaction"}${c.scenarioCount === 1 ? "" : "s"} from ${sources} in ${count(c.projectCount)} project${c.projectCount === 1 ? "" : "s"}.${unscoped}`);
        if (native) membership.push(`Microsoft: ${count(native.aggregates.conversations)} retained ${native.aggregates.conversations === 1 ? "conversation" : "conversations"}.`);
        else if (boundedIncludesMicrosoft()) membership.push("Microsoft membership unavailable.");
        const checked = collection?.config?.approved ? collection.checkedWindow : coverage;
        const key = JSON.stringify([workspaceState.evidence.revision, workspaceState.scope, membership, c.firstAt, c.lastAt, coverage, checked, workspaceState.analytics.warnings, collectionReadError, collection?.config?.approved, collection?.config?.windowDays]);
        if (key === coverageDetailsKey) return;
        coverageDetailsKey = key;
        const range = (from, to) => from && to ? `${date(from, true)} to ${date(to, true)}` : null;
        const selectedDates = workspaceState.scope.filters.from || workspaceState.scope.filters.to
            ? `${workspaceState.scope.filters.from ? date(workspaceState.scope.filters.from, true) : "Earliest saved date"} to ${workspaceState.scope.filters.to ? date(workspaceState.scope.filters.to, true) : "Latest saved date"}`
            : "All retained dates";
        const membershipLine = $("coverageBody") ?? el("p");
        setText(membershipLine, membership.join(" "));
        membershipLine.id = "coverageBody";
        host.replaceChildren(el("h3", "", "Evidence scope"), membershipLine, facts([
            ["Collection shown", scopeLabels[workspaceState.scope.filters.scope]],
            ["Selected date filter", selectedDates],
            ["Dated records in this view", range(c.firstAt, c.lastAt) || "No dated matching records"],
            ["Approved collection window", collectionReadError ? "Current approval unavailable" : collection?.config?.approved ? `${count(collection.config.windowDays)} days of local history` : "No approved collection window"],
            ["Last checked history", checked?.since && checked?.until ? `${timestamp(checked.since)} to ${timestamp(checked.until)}` : "Not recorded"],
            ["Collection window at this snapshot", range(coverage.since, coverage.until) || "Not recorded"],
            ["Snapshot coverage checked", coverage.checkedAt ? timestamp(coverage.checkedAt) : "Not recorded"],
            ["Snapshot revision", workspaceState.evidence.revision],
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
            ...(workspaceState.analytics.warnings || []).filter(warning => warning.code !== "tool-not-http").map(warning => warning.message),
            ...(coverage.notes || []),
        ])];
        if (notes.length) {
            const list = el("div", "collection-evidence-notes");
            host.append(el("h3", "", "Scan notes and exclusions"), list);
            pagedList(list, notes, { key: "coverage-notes", noun: "scan notes", listTag: "ul", listClass: "evidence-notes", renderItem: note => el("li", "", note) });
        }
    }
    function render() {
        const publication = api.publicationToken();
        if (clearingAccess || !publication || !workspaceState.evidence) return;
        if (!workspaceState.evidence || !workspaceState.analytics) return;
        if (workspaceState.loading && $("workspace").hasAttribute("data-navigation-pending")) return;
        $("workspace").removeAttribute("data-navigation-pending");
        $("navigationPending").hidden = true;
        const requestRoute = workspaceState.route.view === "request" ? workspaceState.route : null;
        if (requestRoute?.bookmark && !requestRoute.request) {
            homepage.leave();
            // Refusing a locator is not navigation to the full Analyze population.
            $("workspace").hidden = true;
            boundedNative.clearCards();
            nativeActivity.clearCards();
            if (frontendActivity) frontendActivity.withdrawAccess();
            else {
                releaseCardPreviews($("activityList"));
                $("activityList").replaceChildren();
                $("activityPager").replaceChildren();
            }
            showInteractionSidebar();
            renderRequest();
            return;
        }
        if (requestRoute) {
            const origin = underlyingRoute();
            workspaceState.route = JSON.stringify(query(origin)) === JSON.stringify(workspaceState.scope) ? origin
                : sessionJourney.returnRoute({ ...requestRoute, view: origin.view, task: origin.task, section: origin.section, setting: origin.setting }, true);
        }
        const withinServices = workspaceState.route.withinServices?.split(",") || [];
        if (semanticMembership && (semanticMembership.revision !== workspaceState.evidence.revision || semanticMembership.nativeRevision !== workspaceState.evidence.nativeRead?.revision
            || semanticMembership.scopeKey !== JSON.stringify([workspaceState.scope, withinServices]))) {
            semanticComplete = false;
            semanticBound = false;
            semanticStatus = "pending";
            semanticMembership = unavailableSearchMembership();
        }
        slice = analysisSlice(workspaceState.evidence, workspaceState.scope, search, withinServices, semanticMembership);
        workspaceState.analytics = slice.analytics;
        if (sourceCollection.active) boundedNative.syncInventories(acceptedNativeView(), workspaceState.scope,
            workspaceState.stale || Boolean(search.trim()) || Boolean(workspaceState.route.withinServices));
        const references = chatCopy.references(workspaceState.evidence.sessions, workspaceState.evidence.scenarios);
        renderTimeContext();
        renderControls(references); renderNavigation(references); renderFilterChips(); renderViewingContext();
        const sourceCoverage = renderSessionAnalysis();
        analyzeControls.sourceCoverage(sourceCoverage);
        chartReferenceSourceCoverage = sourceCoverage?.textContent || "";
        const acceptedDescription = renderPeriodFeedback();
        detailOwner = workspaceState.route.view;
        if (workspaceState.route.view === "analyze") {
            if (sourceCollection.active) seedBoundedNative();
            renderHome();
            renderActivity();
            publishAcceptedListScope(acceptedDescription);
            if (sourceCollection.active) renderBoundedAnalyze();
        }
        homepage.present(workspaceState.route.view === "analyze" && !workspaceState.route.compare
            && workspaceState.route.analyzeSection !== "guide" && (semanticQuery === null || semanticBound), publication, Boolean(requestRoute));
        if (workspaceState.route.view === "reports") renderReports();
        trendsUI.update();
        if (workspaceState.route.view === "settings" && workspaceState.route.section === "privacy") assessmentUI.setup($("assessmentSetup"));
        renderCoverage();
        updateSelection();
        if (requestRoute) {
            workspaceState.route = requestRoute;
            const entering = !sidebarIdentity;
            showInteractionSidebar();
            renderRequest(references);
            if (entering) focusSidebar();
        }
        const comparisonUpdate = periodComparisonUI.update();
        comparisonUpdate.then(() => {
            if (!api.isCurrent(publication)) return;
            restorePeriodComparisonReading(); refreshChartReference();
        });
        refreshChartReference();
        liveSearchUI?.changed();
        renderFirstConnection();
    }

    function setPageHeading(text) {
        const heading = $("pageTitle");
        let label = heading.querySelector(".page-title-text"), icon = heading.querySelector(".page-title-icon");
        if (!label || !icon) {
            icon = el("span", "page-title-icon"); icon.setAttribute("aria-hidden", "true");
            label = el("span", "page-title-text");
            heading.replaceChildren(icon, label);
        }
        const destination = workspaceState.route.view === "analyze" ? workspaceState.route.compare === "periods" ? "compare" : "analyze"
            : workspaceState.route.view === "trends" ? "trends" : workspaceState.route.view === "reports" && !workspaceState.route.task && !workspaceState.route.bundle ? "reports" : null;
        if (icon.dataset.destination !== (destination ?? "")) {
            icon.replaceChildren(...(destination ? [ux.icon(`navigation-${destination}`)] : []));
            icon.dataset.destination = destination ?? "";
        }
        icon.hidden = !destination;
        setText(label, text);
    }
    function setText(node, text) {
        if (node.id === "pageTitle") { setPageHeading(text); return; }
        if (node.textContent !== text) {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) walker.currentNode.data = "";
            node.textContent = text;
        }
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
        if (!Array.isArray(rows) || workspaceState.route.view !== "collection-status") return;
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
    async function refreshCollectionIssues(isCurrent = () => true) {
        const publication = api.publicationToken();
        if (!publication) return;
        if (workspaceState.route.view !== "collection-status" || issuesLoading) return;
        issuesLoading = true;
        const readGeneration = collectionReadGeneration, pollGeneration = collectionPollGeneration;
        const current = () => pollGeneration === collectionPollGeneration && isCurrent();
        const message = $("collectionIssuesMessage");
        if (issuesSignature === undefined) { setText(message, "Reading current local history issues..."); message.hidden = false; ux.pending(message, true); }
        try {
            const detailed = await readCollectionStatus({ details: true }, current);
            if (!api.isCurrent(publication) || readGeneration !== collectionReadGeneration || !current() || collectionBusy) return;
            if (!Array.isArray(detailed.historyIssues)) throw new Error("Affected Copilot chats are unavailable. Collection status still shows the last known counts.");
            renderCollection(detailed, publication);
            message.hidden = true;
        } catch (error) {
            if (!api.isCurrent(publication) || readGeneration !== collectionReadGeneration || !current() || collectionBusy) return;
            setText(message, "Current issue details could not be loaded. Any displayed list is from the previous check. " + error.message);
            message.hidden = false;
        } finally { if (api.isCurrent(publication)) { issuesLoading = false; ux.pending(message, false); } }
    }
    function renderCollectionNotice() {
        const publication = api.publicationToken();
        if (clearingAccess || !publication) return;
        const hasEvidence = Boolean(workspaceState.evidence?.scenarios.length || workspaceState.evidence?.nativeRead?.aggregates?.conversations);
        let notice = historyStatus.entry(collection, { hasEvidence, unavailable: Boolean(collectionReadError), reason: collectionReadReason });
        if (sourceCollection.active && collection?.sourceAware) {
            const accepted = collection, access = api.accessState(), current = sourceCollection.view(access);
            if (!api.isCurrent(publication) || collection !== accepted) return;
            notice = historyStatus.sourceEntry(accepted.sourceAware, current, {
                microsoftState: access.state?.microsoft?.state, unavailable: Boolean(collectionReadError),
                githubFailure: notice?.severity === "error" ? notice.text : "",
                microsoftOperationUnconfirmed: Boolean(refreshGesture && refreshGestureCurrent(refreshGesture)
                    && refreshGesture.branches.microsoft.state !== "superseded"
                    && refreshGesture.branches.microsoft.dispatched && refreshGesture.branches.microsoft.result?.sourceUnknown),
            });
        }
        const host = $("collectionNotice");
        const model = refreshPresentation(), recovery = (!$("freshActivity").hidden || !$("freshAwayNotice").hidden) && model.recovery;
        const sameSourceFailure = recovery && !collectionReadError && collection?.error
            && collection.state === "error" && Number.isSafeInteger(model.sourceFailure?.revision)
            && typeof model.sourceFailure?.configVersion === "string"
            && collection.configVersion === model.sourceFailure.configVersion
            && collection.revision === model.sourceFailure.revision
            && collection.lastCheck?.id === model.sourceFailure.lastCheckId
            && collection.error === model.sourceFailure.error;
        host.hidden = ["settings", "help", "collection-status"].includes(workspaceState.route.view) || !notice
            || ["reports", "request", "trends"].includes(workspaceState.route.view) && notice?.severity === "normal"
            || workspaceState.route.view === "analyze" && notice?.severity === "normal" && collection?.state === "paused" && collection?.config?.approved
            || !$("message").hidden && $("message").dataset.connectionFailure === "true"
            || Boolean(collectionReadError) && refreshOwnsReadFailure()
            || recovery && notice?.severity === "normal" && collection?.state === "paused"
            || Boolean(sameSourceFailure);
        const retryHost = workspaceState.route.view === "collection-status" ? $("collectionStatus").parentElement : host;
        if ($("collectionRetry").parentElement !== retryHost) retryHost.append($("collectionRetry"));
        $("collectionRetry").hidden = !collectionReadError || refreshOwnsReadFailure()
            || !$("message").hidden && Boolean($("message").querySelector("[data-stored-refresh-retry]"));
        $("collectionRetry").disabled = workspaceState.loading;
        if (!notice) return;
        host.dataset.severity = notice.severity;
        setText($("collectionNoticeText"), notice.text);
        $("collectionNoticeAction").hidden = false;
        setText($("collectionNoticeAction"), notice.action);
        $("collectionNoticeAction").href = notice.href || (notice.issues ? "/collection-status?setting=issues"
            : notice.severity === "error" || notice.action === "View collection details" ? "/collection-status"
                : !collection?.config?.approved ? "/settings?section=connection&setting=source" : "/settings");
    }
    function collectionUnavailable(error, reason, publication) {
        if (clearingAccess || !api.isCurrent(publication)) return;
        sourceCollection.withdraw();
        liveSearchUI?.invalidate("Current collection status could not be verified. Search results were cleared.");
        collectionReadError = error;
        collectionReadReason = reason;
        collectionSettings?.unavailable(error, publication);
        sourceSettings?.unavailable(error);
        if (reason === "runtime_unavailable") {
            connectionNeedsSnapshot = true;
            workspaceState.stale = Boolean(workspaceState.analytics);
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
        if (clearingAccess || !api.publicationToken()) return;
        const host = $("freshActivity"), model = refreshPresentation(), approved = collection?.config?.approved;
        const recovery = !refreshWorking() && refreshUsesStoredRecovery(model);
        setText($("analyzeRefreshLabel"), recovery ? "Retry" : "Refresh");
        $("analyzeRefresh").setAttribute("aria-label", recovery ? "Retry reading saved activity" : "Refresh");
        ux.pending($("analyzeRefresh"), ["checking", "applying"].includes(model.phase));
        setText($("analyzeRefreshStatus"), model.message);
        const connection = workspaceState.route.view === "settings" && settingsNavigation.resolve(workspaceState.route).section === "connection";
        const contextual = connection || workspaceState.route.view === "collection-status";
        const anchor = workspaceState.route.view === "collection-status" ? $("collectionCoverageCounts") : $("settingsRefreshSlot");
        if (host.nextElementSibling !== anchor) anchor.before(host);
        const refresh = $("checkActivity").closest(".ux-disabled-help") || $("checkActivity");
        const refreshHost = host.querySelector(".fresh-controls");
        if (refresh.parentElement !== refreshHost) refreshHost.prepend(refresh);
        if (host.querySelector(".fresh-controls").lastElementChild !== $("freshResult")) {
            host.querySelector(".fresh-controls").append($("freshResult"));
        }
        $("freshHeading").hidden = !contextual;
        setText($("freshHeading"), connection ? "One-time check" : "Recorded activity");
        const globalRecovery = !$("message").hidden && $("message").querySelector("[data-stored-refresh-retry]");
        const attention = ["checking", "applying", "waiting"].includes(model.phase) || model.recovery || model.combined?.problem
            || refreshOwnsReadFailure() || !globalRecovery && (["error", "unconfirmed"].includes(model.phase) || collectionReadError || workspaceState.stale && !workspaceState.loading);
        host.hidden = !contextual || connection && !approved && sourceCollection.copilotOnly
            && !$("sourceEditor").hidden && model.phase === "idle" && !attention;
        const reread = recollectionUI?.snapshot();
        const recollectionAttention = reread?.needsReceipt || reread?.viewNeedsRead || reread?.phase === "pending";
        const privacy = workspaceState.route.view === "settings" && settingsNavigation.resolve(workspaceState.route).section === "privacy";
        const showRecollection = !attention && recollectionAttention && !privacy;
        const toolbarPending = workspaceState.route.view === "analyze" && $("analyzeRefresh").checkVisibility() && ["checking", "applying"].includes(model.phase)
            && !model.recovery && !collectionReadError && !workspaceState.stale;
        $("freshAwayNotice").hidden = !showRecollection && (contextual || !attention || toolbarPending);
        $("freshAwayLink").href = showRecollection ? "/settings?section=privacy&setting=recollect-activity"
            : "/settings?section=connection&setting=collect-now";
        setText($("freshAwayLink"), showRecollection ? "View recollection result" : "View activity update");
        setText($("freshAwayStatus"), showRecollection ? ` ${reread.message}`
            : model.combined ? ` ${model.message}`
            : model.sourceUnknown ? " Source check outcome is unknown; no check will be repeated."
            : model.sourceBlocked ? " Source checks are read-only in this tab; review the recovery details."
            : model.phase === "checking" ? model.nativeOperationId ? " Collecting screened Microsoft activity." : " Checking approved history."
            : model.phase === "applying" ? " Reading stored activity."
            : model.phase === "waiting" ? " Waiting until the current review or edits finish."
            : model.phase === "error" || model.sourceFailure ? " " + model.message : " Stored activity or its status could not be verified.");
        host.dataset.phase = model.phase;
        host.dataset.checkId = model.check?.id || "";
        host.dataset.revision = model.check ? String(model.check.revision) : "";
        const control = $("checkActivity");
        const nativePersistence = historyStatus.persistence(collection);
        const text = nativePersistence ? "Collect now" : "Refresh";
        if (control.lastChild?.nodeType === Node.TEXT_NODE) control.lastChild.textContent = text;
        ux.pending(control, model.phase === "checking" || model.phase === "applying" && (Boolean(model.check) || !approved || Boolean(model.recovery)));
        setText($("freshHelp").querySelector("summary"), connection ? nativePersistence ? "About collection" : "About Refresh" : "Update details");
        const completed = model.combined ? Boolean(model.combined.completedAt) && !refreshWorking()
            : ["complete", "partial"].includes(model.phase) && Boolean(model.check || model.nativeReceipt?.status === "committed");
        setText($("freshChecked"), completed ? model.combined ? `Finished ${freshness(model.combined.completedAt)}`
            : model.nativeReceipt ? `Saved ${timestamp(model.nativeReceipt.committedAt)}`
            : `Checked ${freshness(model.check.completedAt)}` : "");
        $("freshChecked").hidden = !completed;
        setText($("freshStatus"), model.message || (nativePersistence ? historyStatus.persistenceReason(collection)
            || "Collect screened Microsoft activity." : approved ? "Refresh recorded activity." : "Stored activity only. No source is approved."));
        $("freshStatus").hidden = model.phase === "idle";
        const paused = model.recovery && !collectionReadError && (nativePersistence
            ? nativePersistence.configuration?.settings.paused : approved && collection?.config?.enabled === false);
        setText($("freshContextMessage"), [model.context, model.sourceWarning, paused ? "Collection is paused." : ""].filter(Boolean).join(" "));
        $("freshContextMessage").hidden = !model.context && !model.sourceWarning;
        setText($("freshCheckDetails"), model.details);
        $("freshCheckDetails").hidden = !model.details;
        setText($("freshCoverageAnnouncement"), model.coverage);
        $("freshStatus").dataset.severity = model.phase === "error" || model.sourceFailure ? "error"
            : model.combined?.problem || model.phase === "partial" ? "warning" : "normal";
        $("freshIssues").hidden = model.recovery !== "source";
        setText($("freshIssues"), "Review source");
        $("freshResult").hidden = $("freshStatus").hidden && !model.context && !model.sourceWarning && !completed && !collectionReadError && !workspaceState.stale;
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
            current.href = "/collection-status?setting=issues"; current.dataset.settingsLink = "";
            gapDetails.replaceChildren(el("p", "", "Primary reasons from this manual check. Each affected chat is grouped once; other limits and pending counts may overlap."),
                ...(groups.length ? [reasons] : [el("p", "", "No per-reason breakdown was retained for this check.")]),
                el("p", "", "Previously collected evidence stays. Current issue details may differ after a later check."), current);
        }
        renderCollectionNotice();
        renderStoredRefresh();
        renderSettingsRefresh(connection, model);
        renderAnalyzeScope();
        refreshChartReference();
        renderFirstConnection();
    }
    function clearSourceCheckMarker() {
        if (githubRecoveryPending) return;
        if (refreshGesture && !refreshGesture.withdrawn
            && (refreshWorking() || refreshSources.describe(refreshGesture.branches).recovery)) return;
        try {
            sessionStorage.removeItem(sourceCheckKey);
            if (sessionStorage.getItem(sourceCheckKey) !== null) throw new Error("Pending marker remains.");
            sourcePending = false;
        } catch {
            fresh.blockSource("This tab could not clear its source-check recovery marker. Source refresh stays read-only.");
        }
    }
    async function checkActivity(event, source = "both") {
        const deadline = Date.now() + 300000;
        if (refreshWorking()) return null;
        const control = event?.currentTarget;
        if (control && [$("checkActivity"), $("collectMicrosoftActivity")].includes(control)
            && (control.getAttribute("aria-label") || control.textContent.trim()) === "Read stored activity") return refreshStoredData(event);
        if (refreshUsesStoredRecovery()) return refreshStoredData(event);
        if (sourceCollection.active && source === "both") return checkAllActivity(event, deadline);
        refreshGesture = null;
        return checkSourceActivity(event, source === "both" ? "github" : source, null, deadline);
    }
    function refreshViewHeld() {
        const report = reportJourney?.snapshot();
        return $("overlay").open || report?.hasPreview || report?.phase === "scanning"
            || reportJourney?.isReviewOpen() || collectionSettings?.hasDraft() || sourceSettings?.hasDraft();
    }
    function deferRefreshView(gesture) {
        for (const branch of Object.values(gesture.branches)) {
            branch.flow?.defer(); settleRefreshBranch(branch);
        }
        $("workspace").setAttribute("aria-busy", "false");
        showDeferredDataNotice(true);
        renderFreshActivity();
    }
    async function checkAllActivity(event, deadline) {
        const publication = api.publicationToken(), owner = api.controlToken();
        renderStoredRefresh();
        if (!publication || clearingAccess || !owner || typeof owner.then === "function"
            || api.isControlCurrent(owner) !== true || $("checkActivity").disabled) return null;
        let plan;
        try { plan = refreshSources.capture(sourceCollection.view(api.accessState())); }
        catch (error) { collectionUnavailable(error.message, "", publication); return false; }
        const gesture = {
            publication, owner, runtimeId: api.accessState().runtimeId, plan, running: true, recovering: false,
            withdrawn: false, completedAt: null, completedRevision: null, branches: {},
        };
        for (const source of refreshSources.names) {
            const intent = source === "microsoft" && plan[source].admitted
                ? { operationId: crypto.randomUUID(), deadline, owner, confirmed: false, readbackQualification: null } : null;
            const nativeStatus = intent ? { ...historyStatus, nativeReadbackMatches(receipt, snapshot) {
                return nativeIntentCurrent(intent) && boundedContract.matchesReadback(intent.readbackQualification, snapshot?.nativeRead, receipt);
            } } : receiptStatus;
            gesture.branches[source] = {
                source, gesture, intent, dispatched: false, state: plan[source].admitted ? "queued" : "skipped",
                reason: plan[source].reason, result: null, flow: createFreshActivity({ nativeStatus }),
            };
        }
        refreshGesture = gesture;
        collectionReadGeneration++;
        collectionSettings?.setChecking(true, publication);
        sourceSettings?.setChecking(true);
        if (!Object.values(plan).some(branch => branch.admitted)) {
            fresh = createFreshActivity({ nativeStatus: receiptStatus });
            nativeCollectIntent = null;
            fresh.begin({ checkSource: false });
        }
        clearTimeout(pollTimer);
        renderFreshActivity();
        try {
            for (const source of refreshSources.names) {
                if (!refreshGestureCurrent(gesture)) return false;
                const branch = gesture.branches[source];
                if (branch.state !== "queued") continue;
                if (Object.values(gesture.branches).some(value => value.flow.snapshot().sourceBlocked)) {
                    branch.state = "skipped"; branch.reason = "recovery storage unavailable"; continue;
                }
                if (!refreshGestureCurrent(gesture)) {
                    branch.state = "skipped"; branch.reason = "access changed"; continue;
                }
                try {
                    const status = await readCollectionStatus();
                    if (!refreshGestureCurrent(gesture)) { branch.state = "skipped"; branch.reason = "access changed"; continue; }
                    renderCollection(status, publication);
                    const admission = refreshSources.admission(plan, source, sourceCollection.view(api.accessState()));
                    if (!admission.allowed) { branch.state = "skipped"; branch.reason = admission.reason; continue; }
                    fresh = branch.flow;
                    nativeCollectIntent = branch.intent;
                    branch.state = "running";
                    await checkSourceActivity(event, source, branch);
                } catch (error) {
                    if (!refreshGestureCurrent(gesture)) return false;
                    if (branch.dispatched) {
                        branch.flow.fail(branch.flow.snapshot().token, error.message, { reason: error.reason });
                        branch.state = "settled";
                    } else { branch.state = "skipped"; branch.reason = "status unavailable"; }
                    if (refreshGestureCurrent(gesture)) collectionUnavailable(error.message, error.reason, publication);
                } finally {
                    if (branch.state === "running") branch.state = "settled";
                    if (!branch.dispatched && nativeCollectIntent === branch.intent) nativeCollectIntent = null;
                    settleRefreshBranch(branch);
                }
            }
            if (!refreshGestureCurrent(gesture)) return false;
            if (refreshViewHeld()) deferRefreshView(gesture);
            else await load({ background: true, refreshOwner: gesture });
            return true;
        } finally {
            if (!gesture.withdrawn) {
                gesture.running = false;
                gesture.completedAt = new Date().toISOString();
                gesture.completedRevision = workspaceState.evidence?.revision ?? null;
            }
            if (refreshGestureCurrent(gesture)) {
                collectionSettings?.setChecking(false, publication);
                sourceSettings?.setChecking(false);
                for (const branch of Object.values(gesture.branches)) settleRefreshBranch(branch);
                clearSourceCheckMarker();
                renderFreshActivity();
                clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 5000);
            }
        }
    }
    async function recoverRefreshGesture(event) {
        const gesture = refreshGesture;
        renderStoredRefresh();
        if (!gesture || gesture.withdrawn || refreshWorking() || $("refreshBtn").disabled) return false;
        if (!refreshGestureCurrent(gesture)) {
            const unconfirmed = refreshSources.describe(gesture.branches).recovery || sourcePending;
            withdrawRefreshGesture();
            fresh = createFreshActivity({ nativeStatus: receiptStatus, sourceUnknown: unconfirmed,
                sourceWarning: unconfirmed ? "The original Refresh owner is no longer available. Only saved activity can be read." : "" });
            if (nativeCollectIntent) fresh.restoreNative(nativeCollectIntent.operationId);
            return refreshStoredSourceData(event);
        }
        gesture.recovering = true;
        collectionReadGeneration++;
        collectionSettings?.setChecking(true, gesture.publication);
        sourceSettings?.setChecking(true);
        renderFreshActivity();
        let expectedSource, statusError;
        try {
            for (const source of refreshSources.names) {
                if (!refreshGestureCurrent(gesture)) return false;
                const branch = gesture.branches[source], result = branch.result;
                if (!branch.dispatched || !result || !(result.sourceUnknown || result.readFailed || result.sourceBlocked)) continue;
                if (!refreshGestureCurrent(gesture)) return false;
                fresh = branch.flow;
                nativeCollectIntent = branch.intent;
                const recovered = await refreshStoredSourceData(event, true);
                if (recovered?.expectedSource !== undefined) expectedSource = recovered.expectedSource;
                if (recovered?.statusError) statusError = recovered.statusError;
                settleRefreshBranch(branch);
            }
            if (!refreshGestureCurrent(gesture)) return false;
            if (refreshViewHeld()) { deferRefreshView(gesture); return false; }
            const loaded = await load({ background: true, expectedSource, refreshOwner: gesture });
            if (!refreshGestureCurrent(gesture)) return false;
            if (statusError && (!loaded || !workspaceState.evidence?.collection)) collectionUnavailable(statusError.message, statusError.reason, gesture.publication);
            return loaded;
        } finally {
            if (!gesture.withdrawn) gesture.recovering = false;
            if (refreshGestureCurrent(gesture)) {
                collectionSettings?.setChecking(false, gesture.publication);
                sourceSettings?.setChecking(false);
                clearSourceCheckMarker(); renderFreshActivity();
                clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 5000);
            }
        }
    }
    async function checkSourceActivity(event, source = "github", branch = null, deadline = Date.now() + 300000) {
        const publication = branch ? branch.gesture?.publication : api.publicationToken();
        if (!publication || clearingAccess) return false;
        const microsoft = sourceCollection.active && source === "microsoft";
        renderFreshActivity();
        if (branch) {
            if (!refreshGestureCurrent(branch.gesture)) { branch.state = "skipped"; branch.reason = "access changed"; return null; }
            const admission = refreshSources.admission(branch.gesture.plan, source, sourceCollection.view(api.accessState()));
            if (!admission.allowed) { branch.state = "skipped"; branch.reason = admission.reason; return null; }
        } else if (microsoft ? !sourceSettings?.canCollect() : $("checkActivity").disabled) return null;
        if (!branch && refreshUsesStoredRecovery()) return refreshStoredData(event);
        const expectedBasis = branch?.gesture.plan[source].expectedBasis;
        if (sourceCollection.controlsActive && !microsoft) {
            try { sourceCollection.authorize("/api/collection/now", expectedBasis ? { expectedBasis } : {}, api.accessState()); }
            catch (error) {
                if (branch) { branch.state = "skipped"; branch.reason = "status or access changed"; }
                collectionUnavailable(error.message, error.reason, publication); return false;
            }
        }
        const initiatingControl = document.activeElement;
        const initiatingNavigation = workspaceState.navigationGeneration, initiatingIntent = workspaceState.readingIntent;
        const nativePersistence = historyStatus.persistence(microsoft ? nativeCollectionStatus(collection) : collection);
        const checkSource = Boolean(nativePersistence) || collection?.config?.approved === true;
        let intent = null;
        if (nativePersistence) {
            const control = historyStatus.native(collection);
            if (!nativePersistence.actions.includes("collect-now")
                || !microsoft && (!control?.enabled || !control.retained || !control.connected)) {
                announce(historyStatus.persistenceReason(collection) || "Microsoft collection is unavailable.", "stale");
                return false;
            }
            const owner = api.controlToken();
            if (!owner || typeof owner.then === "function" || api.isControlCurrent(owner) !== true) {
                announce("The current panel cannot own this Microsoft collection operation.", "stale");
                return false;
            }
            intent = branch?.intent ?? { operationId: crypto.randomUUID(), deadline, owner };
            if (microsoft) {
                try { sourceCollection.authorize("/api/collection/microsoft/now",
                    { operationId: intent.operationId, deadline: intent.deadline, ...(expectedBasis ? { expectedBasis } : {}) }, api.accessState()); }
                catch (error) {
                    if (branch) { branch.state = "skipped"; branch.reason = "status or access changed"; }
                    collectionUnavailable(error.message, error.reason, publication); return false;
                }
            }
        } else if (nativeCollectIntent?.confirmed) {
            nativeCollectIntent = null;
            fresh.retireNativeResult();
        }
        const token = fresh.begin({ checkSource, nativeOperationId: intent?.operationId });
        if (token === null) return null;
        if (intent) nativeCollectIntent = intent;
        recollectionNoticeVisible = false;
        const sourceIdentity = { configVersion: collection?.configVersion, revision: collection?.revision, lastCheckId: collection?.lastCheck?.id };
        collectionBusy = true;
        collectionReadGeneration++;
        clearTimeout(pollTimer);
        collectionSettings?.setChecking(true, publication);
        sourceSettings?.setChecking(true);
        renderFreshActivity();
        try {
            if (!checkSource) return await load({ background: true });
            try {
                sessionStorage.setItem(sourceCheckKey, "pending");
                if (sessionStorage.getItem(sourceCheckKey) !== "pending") throw new Error("Pending marker was not saved.");
                sourcePending = true;
            } catch {
                fresh.blockSource("This tab cannot preserve source-check recovery state. No source check was sent; Refresh and Retry remain read-only.");
                if (branch) { branch.state = "skipped"; branch.reason = "recovery storage unavailable"; }
                return false;
            }
            const prefix = microsoft ? "/api/collection/microsoft" : "/api/collection";
            if (branch && !refreshGestureCurrent(branch.gesture)) { branch.state = "skipped"; branch.reason = "access changed"; return false; }
            if (branch) branch.dispatched = true;
            let result = await api(prefix + "/now", { ...(intent ? { operationId: intent.operationId,
                ...(microsoft ? { deadline: intent.deadline } : {}) } : {}), ...(expectedBasis ? { expectedBasis } : {}) });
            if (!api.isCurrent(publication)) return false;
            if (intent) {
                if (intent !== nativeCollectIntent || !nativeIntentCurrent(intent)) throw new Error("The original panel owner changed. This Microsoft operation remains unconfirmed.");
                if (result.nativePersistenceReceipt) {
                    const receipt = historyStatus.nativeReceipt(result.nativePersistenceReceipt);
                    if (receipt.operationId !== intent.operationId) throw new Error("The runtime returned a different Microsoft operation receipt.");
                }
                result = await api(prefix + "/status", { operationId: intent.operationId });
                if (!api.isCurrent(publication)) return false;
                if (intent !== nativeCollectIntent || !nativeIntentCurrent(intent)) throw new Error("The original panel owner changed. This Microsoft operation remains unconfirmed.");
                const committed = receiveNativeReceipt(result, intent);
                if (sourceCollection.active && committed) await qualifyNativeReadback(intent);
                if (!sourceCollection.controlsActive) renderCollection(result, publication);
                renderFreshActivity();
                if (!committed) return false;
            } else {
                if (!fresh.collected(token, result.check)) return false;
                clearSourceCheckMarker();
            }
            const status = sourceCollection.controlsActive ? await readCollectionStatus() : result;
            renderCollection(status, publication);
            renderFreshActivity();
            if (branch) return result;
            if ($("overlay").open || reportJourney?.isReviewOpen() || collectionSettings?.hasDraft()) {
                fresh.defer();
                showDeferredDataNotice(true);
            } else await load({ background: true });
            if (!api.isCurrent(publication)) return false;
            return { ...result, checkMessage: fresh.snapshot().message };
        } catch (error) {
            if (!api.isCurrent(publication)) return false;
            if (branch && ["NATIVE_RETENTION_EXPECTED_BASIS_CHANGED", "COLLECTION_EXPECTED_BASIS_CHANGED"].includes(error.reason)) {
                branch.state = "skipped"; branch.reason = "settings or access changed"; branch.dispatched = false;
                branch.flow = fresh = createFreshActivity({ nativeStatus: receiptStatus });
                if (nativeCollectIntent === branch.intent) nativeCollectIntent = null;
                return false;
            }
            if (sourceCollection.controlsActive) collectionUnavailable(error.message, error.reason, publication);
            // A generic 422 can follow dispatch; only a specific pre-read source code settles it.
            const failed = fresh.fail(token, error.message, { rejected: error.code === "request_rejected" && error.status !== 422, reason: error.reason, ...sourceIdentity });
            if (failed && !fresh.snapshot().sourceUnknown) clearSourceCheckMarker();
            return false;
        } finally {
            if (api.isCurrent(publication)) {
            collectionBusy = false;
            collectionSettings?.setChecking(refreshWorking(), publication);
            sourceSettings?.setChecking(refreshWorking());
            renderFreshActivity();
            if ([$("checkActivity"), $("analyzeRefresh")].includes(initiatingControl) && workspaceState.navigationGeneration === initiatingNavigation && workspaceState.readingIntent === initiatingIntent
                && document.activeElement === document.body) {
                const recovery = [$("refreshBtn"), $("collectionRetry"), ...document.querySelectorAll("[data-stored-refresh-retry]")]
                    .find(control => control.checkVisibility() && !control.disabled);
                ux.restoreFocus(initiatingControl.checkVisibility() ? initiatingControl : recovery);
            }
            clearTimeout(pollTimer);
            pollTimer = setTimeout(pollCollection, 5000);
            }
        }
    }
    function renderCollection(status, publication) {
        if (clearingAccess || !api.isCurrent(publication)) return;
        acceptSourceCollection(status);
        const nativeStatus = nativeCollectionStatus(status), previousNative = nativeCollectionStatus(collection);
        const nativeControl = historyStatus.native(status);
        const nativePersistence = historyStatus.persistence(nativeStatus);
        const nativeUnavailable = historyStatus.nativeUnavailable(nativeStatus);
        if (nativeUnavailable) {
            const observed = api.accessState().state;
            if (!historyStatus.nativeUnavailableCurrent(nativeStatus, observed)) {
                throw new Error("Microsoft account setup status does not match current WIRE access.");
            }
            if (!historyStatus.nativeUnavailableCurrent(nativeStatus, observed, previousNative)) return;
        }
        if (nativePersistence) {
            const access = api.accessState();
            if (!api.isCurrent(publication)) return;
            if (access.state?.generation !== nativePersistence.generation) {
                throw new Error("Microsoft collection status does not match current WIRE access.");
            }
            const previous = historyStatus.persistence(previousNative);
            if (previous?.accountRef === nativePersistence.accountRef && previous.generation === nativePersistence.generation
                && previous.revision > nativePersistence.revision) return;
        }
        if (nativeControl && historyStatus.native(collection)?.revision > nativeControl.revision) return;
        if (collection && status.configVersion !== undefined && collection.configVersion !== undefined && status.configVersion !== collection.configVersion) {
            invalidatePreview();
            invalidateDialog("Collection settings changed. Prepare a fresh report preview; source approval is not disclosure review.");
            issuesStatus = undefined; issueRows = undefined; issuesSignature = undefined;
            $("collectionIssueGroups").replaceChildren();
            setText($("issueSearchCount"), "Reading current issues...");
        }
        const newProfileSource = sourceCollection.copilotOnly && collection && status.config?.approved
            && (!collection.config?.approved || collection.config.appDbPath !== status.config.appDbPath
                || collection.config.sessionRoot !== status.config.sessionRoot);
        collection = status;
        if (newProfileSource) void accountProfile?.receiveSourceChange();
        collectionReadError = "";
        collectionReadReason = "";
        if (!sourceCollection.active && nativePersistence && workspaceState.evidence && !historyStatus.nativeReadbackCurrent(workspaceState.evidence, nativeStatus)) {
            connectionNeedsSnapshot = true;
            if (nativeCollectIntent?.confirmed && nativeIntentCurrent()) fresh.nativeApplied(workspaceState.evidence, nativeStatus);
        }
        if (Array.isArray(status.historyIssues)) issuesStatus = status;
        // Keep counts, source coverage and rows on the same detailed response while it is visible.
        const detail = workspaceState.route.view === "collection-status" && issuesStatus ? issuesStatus : status;
        const c = detail.historyCoverage, view = historyStatus.page({ ...status, historyCoverage: c });
        setText($("collectionStatus"), view.label);
        $("collectionStatus").dataset.severity = view.severity || "normal";
        setText($("collectionStatusGuidance"), view.guidance);
        const statusAction = $("collectionStatusAction");
        statusAction.hidden = !view.action;
        if (view.action) { setText(statusAction, view.action.label); statusAction.href = view.action.href; }
        $("collectionSourceLink").hidden = Boolean(nativeControl) || view.action?.href === "/settings?section=source-access&setting=source";
        $("collectionHistoryLink").hidden = Boolean(nativeControl);
        for (const id of ["collectionTimes", "collectionCoverageCounts", "collectionIssues", "collectionSetup"]) $(id).hidden = Boolean(nativeControl);
        setText($("collectionChecked"), status.lastCheckedAt ? `Last checked ${freshness(status.lastCheckedAt)}` : "Not checked yet");
        setText($("collectionNewActivity"), status.lastNewDataAt ? `Last new evidence ${freshness(status.lastNewDataAt)}` : "No new evidence collected yet");
        ux.tooltip($("collectionChecked"), status.lastCheckedAt ? `Last local check: ${timestamp(status.lastCheckedAt)}` : "");
        $("collectionChecked").tabIndex = status.lastCheckedAt ? 0 : -1;
        ux.tooltip($("collectionNewActivity"), status.lastNewDataAt ? `Last newly collected activity: ${timestamp(status.lastNewDataAt)}` : "");
        $("collectionNewActivity").tabIndex = status.lastNewDataAt ? 0 : -1;
        setText($("settingsDiagnosticError"), status.error || status.lastCheckWarning || "");
        $("settingsDiagnosticError").hidden = !status.error && !status.lastCheckWarning;
        const unavailable = c?.unavailable ?? detail.sourceErrors ?? 0, limited = c?.limited ?? 0;
        $("collectionIssues").dataset.severity = c?.eligible > 0 && unavailable === c.eligible ? "error" : "normal";
        const issueCounts = $("collectionIssueCounts");
        issueCounts.replaceChildren();
        if (c) for (const [total, label] of [[unavailable, "unavailable"], [limited, "limited"]]) {
            const fact = el("span", "history-status-count");
            fact.append(el("span", "history-status-value", count(total)), document.createTextNode(` ${label}`));
            if (issueCounts.childNodes.length) issueCounts.append(document.createTextNode(" "));
            issueCounts.append(fact);
        }
        setText($("collectionIssueImpact"), unavailable || limited ? "Analyze, Search and new reports use only collected activity and known links. Refresh does not rewrite saved reports." : "");
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
        $("collectionCoveragePending").hidden = Boolean(nativeControl) || !c?.pending;
        collectionSettings.receive(status, publication);
        if (sourceCollection.controlsActive) sourceSettings?.receive(status.sourceAware, publication);
        if (sourceCollection.active) {
            const native = workspaceState.evidence?.nativeRead;
            const counts = native?.aggregates;
            sourceSettings?.receiveSavedActivity((savedMicrosoftSummary(native) + (counts
                ? ` ${count(counts.conversations)} ${counts.conversations === 1 ? "conversation" : "conversations"} / ${count(counts.calls)} ${counts.calls === 1 ? "tool call" : "tool calls"}.` : "")).trim(), publication);
        }
        if (!api.isCurrent(publication)) return;
        renderSettingsSearch();
        renderCollectionNotice();
        const m = detail.metrics, inventory = detail.discovery?.counts, diagnostics = $("collectionDiagnostics");
        diagnostics.replaceChildren();
        const savedCounts = workspaceState.evidence?.nativeRead?.aggregates;
        if (sourceCollection.active && savedCounts) {
            diagnostics.append(el("h3", "", "Saved Microsoft observations"),
                el("p", "", savedMicrosoftSummary(workspaceState.evidence.nativeRead)),
                facts([["Saved observations", count(savedCounts.variants)], ["Message observations", count(savedCounts.messages)],
                    ["Message parts", count(savedCounts.parts)], ["Task-state observations", count(savedCounts.taskStates)]], { inlineHelp: false }),
                el("p", "", "Observations may include repeated or partial messages. They are not a count of complete replies."));
        }
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
            ["Messages with an unsupported text format", count(m.unsupportedPromptContents)],
            ["Chats waiting for an unfinished entry", count(m.partialSources)],
            ["History data read in the last check (bytes)", count(m.lastBytesRead)],
            ["Time spent in the last check", timingPresentation.duration(Number.isFinite(m.lastDurationMs) && m.lastDurationMs >= 0 ? m.lastDurationMs : null)],
        ], { inlineHelp: false }));
        diagnostics.append(el("p", "", "The initial read covers at most the last 64 MiB per history file within the selected history window. Older saved activity outside that window is not newly collected; previously collected evidence stays."),
            el("p", "", "Each check reads at most 32 MiB in 4 MiB portions. Pending history needs further checks; an unfinished entry is read after Copilot finishes saving it."),
            el("p", "", "Up to 2,000 context records are kept: 512 KiB of linking context plus one accepted original message, capped at 1 MiB plus 2 KiB of metadata. Older links can still be incomplete. Privacy exclusions are not tool failures; older exclusion totals may also include unsupported message formats."),
            el("p", "", "Closing this panel does not stop collection. Pausing does not erase evidence. Remote-only history and Work IQ's internal network requests are not visible to this local collector."));
        renderCoverageDetails();
        renderCollectionIssues(status);
        renderFreshActivity();
    }
    async function pollCollection() {
        const publication = api.publicationToken();
        if (!publication || clearingAccess || pageInactive || document.hidden || !workspaceState.evidence?.collection) return;
        const readGeneration = collectionReadGeneration;
        let pollGeneration = collectionPollGeneration;
        const current = () => readGeneration === collectionReadGeneration && pollGeneration === collectionPollGeneration;
        try {
            if (appUpdate?.locked() || collectionBusy || refreshWorking()) return;
            if (exportWriting ? !Number.isSafeInteger(draft.contextRevision()) : !ensureCurrentTime()) return;
            // A visibility-triggered read can overtake a pending poll without changing evidence revision.
            pollGeneration = ++collectionPollGeneration;
            const status = await readCollectionStatus({}, current);
            if (appUpdate?.locked() || !api.isCurrent(publication) || !current() || collectionBusy || refreshWorking()) return;
            observeNativeReaderStatus(status);
            updateRequestReportActions();
            savedArtifactUI?.observeEligibility(status.revision);
            savedInspector?.refreshEligibility?.(status.revision);
            const native = status.sourceAware?.microsoft?.status;
            const original = workspaceState.evidence.nativeRead?.readback?.current;
            const preserveNativeSource = Boolean((activePreview || reportJourney?.isReviewOpen()) && original && native?.configured
                && native.accountRef === workspaceState.evidence.collection?.sourceAware?.microsoft?.status?.accountRef
                && native.generation === original.generation
                && native.configuration?.configurationRevision === original.configurationRevision
                && native.configuration?.privacyRevision === original.privacyRevision
                && status.deletionVersion === workspaceState.evidence.deletionVersion);
            const github = status.sourceAware?.github?.status ?? status;
            const originalGithub = workspaceState.evidence.collection?.sourceAware?.github?.status ?? workspaceState.evidence.collection;
            const preserveCollectedSource = Boolean((activePreview?.collectedSourceFrozen || reportJourney?.snapshot().phase === "scanning")
                && github.config?.approved === true && JSON.stringify(github.config) === JSON.stringify(originalGithub?.config)
                && status.assessment?.basis && status.deletionVersion === workspaceState.evidence.deletionVersion);
            if (draft.observeContext(status, { writing: exportWriting, preserveNativeSource, preserveCollectedSource })) {
                scrubContextPreview();
                if (!exportWriting) invalidatePreview("Recorded context changed or became unavailable. Prepare a new preview; ordinary prompt edits are kept.");
            }
            periodComparisonUI.observe(status.assessment);
            if (exportWriting) return;
            ignoringStaleContextStatus = Number.isSafeInteger(draft.contextRevision()) && status.revision < draft.contextRevision();
            try { assessmentUI.observe(status.assessment); }
            finally { ignoringStaleContextStatus = false; }
            if (status.assessment?.pendingCleanup) {
                if (status.assessment.kind === "artifact-deletion") {
                    artifactRefreshRequired = true;
                    savedArtifactUI?.invalidate();
                    announce("Saved-object cleanup is pending. This does not delete collected activity or its insights.", "stale");
                    return;
                }
                workspaceState.stale = true;
                invalidatePreview();
                invalidateDialog("Local evidence cleanup is pending. Prepare a fresh report after cleanup.");
                announce("Local evidence cleanup is pending. Private responses and dependent insights are unavailable.", "stale");
                updateSelection();
                return;
            }
            if (artifactRefreshRequired || (status.artifactRevision ?? 0) !== (workspaceState.evidence.artifactRevision ?? 0)) {
                savedArtifactUI?.invalidate();
                if (await load({ background: true })) artifactRefreshRequired = false;
                return;
            }
            if ((status.deletionVersion ?? 0) !== (workspaceState.evidence.deletionVersion ?? 0)) {
                clearDeletedDraft();
                await load({ background: true });
                return;
            }
            renderCollection(status, publication);
            await refreshCollectionIssues(current);
            if (!api.isCurrent(publication) || !current()) return;
            const action = live.observe(status.revision, workspaceState.evidence?.revision, {
                reviewing: $("overlay").open || deletionUI.isOpen() || recollectionUI.isOpen() || Boolean(activePreview) || reportJourney?.isReviewOpen(), loading: workspaceState.loading || collectionBusy || fresh.snapshot().phase === "error",
                editing: collectionSettings.hasDraft() || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) || Boolean(document.querySelector(".select-popup:not([hidden])")),
            });
            showDeferredDataNotice(action === "defer");
            const canApply = !workspaceState.loading && !$("overlay").open && !deletionUI.isOpen() && !recollectionUI.isOpen() && !activePreview && !reportJourney?.isReviewOpen() && !collectionSettings.hasDraft()
                && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && !document.querySelector(".select-popup:not([hidden])");
            if ((action === "refresh" || (connectionNeedsSnapshot || ["applying", "waiting"].includes(fresh.snapshot().phase)) && canApply) && workspaceState.evidence) await load({ background: true });
        } catch (error) {
            if (!api.isCurrent(publication) || !current() || collectionBusy) return;
            assessmentUI.clearPrivateText();
            collectionUnavailable(error.message, error.reason, publication);
        } finally {
            if (api.isCurrent(publication) && current() && !pageInactive) {
                clearTimeout(pollTimer);
                pollTimer = setTimeout(pollCollection, 5000);
            }
        }
    }
    async function writeCollection(endpoint, input) {
        const publication = api.publicationToken();
        if (!publication) throw new Error("Current WIRE access is required before changing collection.");
        if (sourceCollection.controlsActive) sourceCollection.authorize(endpoint, input, api.accessState());
        const nativePrefix = sourceCollection.active ? "/api/collection/microsoft" : "/api/collection";
        const nativeChange = endpoint === nativePrefix + "/enabled" && Object.hasOwn(input, "expectedNativeRevision");
        const nativeConfigurationChange = endpoint === nativePrefix + "/configure" && input.schemaVersion === (sourceCollection.active ? 2 : 1)
            && ["enable", "save"].includes(input.intent);
        if (endpoint === "/api/collection/now") return checkActivity();
        if (collectionBusy) throw new Error("A collection change is already in progress. It has not been repeated.");
        collectionBusy = true;
        collectionReadGeneration++;
        collectionSettings?.setChecking(true, publication);
        sourceSettings?.setChecking(true);
        setText($("collectionStatus"), nativeConfigurationChange ? "Saving Microsoft collection settings..."
            : nativeChange ? "Updating Microsoft reads..." : "Updating local collection...");
        try {
            const result = await api(endpoint, input);
            if (!api.isCurrent(publication)) throw Object.assign(new Error("Access changed after this collection action was sent. Its outcome remains unknown."),
                { code: "request_outcome_unknown", outcome: "unknown" });
            if (nativeChange && historyStatus.native(result)?.enabled !== input.enabled) {
                throw new Error("The Microsoft read change was not confirmed. Read the current connection before trying again.");
            }
            const status = sourceCollection.controlsActive ? await readCollectionStatus() : result;
            renderCollection(status, publication);
            if (nativeChange && !historyStatus.persistence(result)) return result;
            if (!$("overlay").open && !reportJourney?.isReviewOpen()) await load({ background: true });
            else if (connectionNeedsSnapshot || collection.revision !== workspaceState.evidence?.revision) showDeferredDataNotice(true);
            return result;
        } catch (error) {
            if (sourceCollection.controlsActive && api.isCurrent(publication) && error.configuration !== "not-saved") {
                collectionUnavailable(error.message, error.reason, publication);
            }
            throw error;
        } finally {
            if (api.isCurrent(publication)) {
                collectionBusy = false;
                collectionSettings?.setChecking(false, publication);
                sourceSettings?.setChecking(false);
                // This operation retired any pending poll, including its scheduling finalizer.
                clearTimeout(pollTimer);
                if (!pageInactive) pollTimer = setTimeout(pollCollection, 5000);
            }
        }
    }
    function openDialog(title) {
        if (clearingAccess || !api.publicationToken()) throw new Error("Current WIRE access is required to open private content.");
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
                const text = el("pre", "report-exact-text", code.join("\n") + (index < lines.length ? "\n" : ""));
                text.tabIndex = 0; text.setAttribute("aria-label", "Report code");
                current().append(text);
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
    const reportCopyRebuildMessage = "Review your changes in a new preview before saving.";
    async function chooseReportPreset(preset, trigger) {
        if (periodReport && !exportWriting && !reportJourney.snapshot().saveUnconfirmed) clearReportSelection();
        if (reportSelectionBlock() || reportPreparing) return;
        const latestDraft = namedReport && namedDrafts.read()?.drafts.find(d => d.id === namedReport.id);
        const updatedDraft = namedReport && latestDraft?.revision !== namedReport.revision;
        if (namedReport && (updatedDraft || !(reportPreset === preset && (activePreview || reportRebuildFrom)))) {
            const latest = latestDraft;
            if (!latest || latest.unavailable || !latest.scenarioIds.length) {
                announce("This draft has no complete available selection. Choose another draft or update its interactions.", "stale");
                return;
            }
            namedReport = { ...latest, source: namedDrafts.read().source };
            selected.clear();
            for (const id of latest.scenarioIds) selected.add(id);
        }
        const publication = api.publicationToken();
        if (workspaceState.route.view === "reports" && assessmentFactories.reportWorkspacePresentation(workspaceState.route, reportJourney.snapshot()).landing) {
            forgetReading(reportLandingOrigin?.reading);
            reportLandingOrigin = { route: sessionJourney.returnRoute({ ...workspaceState.route, task: undefined }), reading: captureReading() };
            if (workspaceState.route.task === "create") {
                const normalized = await navigate({ ...workspaceState.route, task: undefined }, true, { keepFocus: true });
                if (!normalized || !api.isCurrent(publication)) return;
            }
            const moved = await navigate(routeFor("reports", { task: "create", inspect: undefined }), false, { keepFocus: true });
            if (!moved || !api.isCurrent(publication)) return;
        }
        if (!updatedDraft && reportPreset === preset && activePreview && reportJourney.snapshot().hasPreview) {
            reportJourney.go(3);
            return;
        }
        if (!updatedDraft && reportPreset === preset && reportRebuildFrom) {
            await previewExport({ contentOnly: true });
            return;
        }
        const dates = time.preset(reportDates.range, viewerTime.timeZone);
        if (dates) reportDates = { range: reportDates.range, ...dates };
        if (!reportBaseExplicit) reportScope = "all";
        const bounded = usesBoundedReportView();
        if (bounded && preset !== "all") {
            announce("Microsoft conversation reports use All activity. Choose an interaction-only scope for this focus.", "stale");
            return;
        }
        reportPreset = preset;
        reportAuthors = authorship.selection(preset === "mine" ? ["user"] : preset === "agent" ? ["agent"] : undefined);
        invalidatePreview();
        draft.change({
            saveMode: "local", title: namedReport?.name, overrides: [], manualTerms: [],
            reportNotes: [], recordedContext: false, resultText: preset === "errors", resultTextKind: "errors",
            reportFocus: bounded ? undefined : { version: 1, preset, outcome: ["errors", "completed"].includes(preset) ? preset : "all", services: [] },
        });
        draft.synchronizeTime(viewerTime, effectiveReportDates());
        acceptNativeReportScope(); updateSelection();
        if ($("exportBtn").disabled) {
            const reason = reportJourney.reason(2) || reportJourney.snapshot().prepareIssue || "No readable interactions match this report. Change its activity or dates.";
            announce(reason, "stale");
            return;
        }
        await previewExport();
    }
    function updateReportContent({ hide = false, delay = 350, prepare = true } = {}) {
        if (exportWriting || reportJourney.snapshot().saveUnconfirmed) return;
        const selectedView = $("preparedReportView");
        if (selectedView) pendingReportReading = { view: selectedView.value, file: preparedFileInspection?.selection(),
            copyKey: $("reportReviewBody").querySelector(".prompt-comparison")?.dataset.copyKey,
            document: hide ? null : preparedReportReader?.reading() ?? pendingReportReading?.document,
            outer: hide ? null : captureReading(),
            intent: workspaceState.readingIntent, navigation: workspaceState.navigationGeneration,
            focusCopy: Boolean(document.activeElement?.closest(".report-copy-controls")) };
        saveAfterMask = false;
        clearTimeout(reportUpdateTimer);
        if (activePreview?.snapshot?.reportPopulation) reportRebuildFrom ??= activePreview.previewId;
        else if (activePreview) invalidatePreview("");
        activePreview = null;
        reportJourney.invalidate("");
        $("reportSaveActions").querySelectorAll("button").forEach(control => { control.disabled = true; });
        if (hide) { clearPreparedReaders(); clearPreviewPayload?.(); $("reportReviewBody").replaceChildren(); }
        if (!prepare) { reportExperience?.sync(); return; }
        if (reportPreparing) { reportUpdateAgain = true; return; }
        reportUpdateTimer = setTimeout(() => { void previewExport({ contentOnly: true }); }, delay);
        reportExperience?.sync();
    }
    async function changeReportDates(dates) {
        if (exportWriting || reportJourney.snapshot().saveUnconfirmed || periodReport || usesBoundedReportView(reportBaseExplicit ? reportScope : "all")) return;
        const prepared = reportJourney.snapshot().step === 3;
        invalidatePreview(undefined, { preserveFileView: true });
        reportDates = dates; reportDatesReplaced = reportBaseExplicit && reportScope === "current";
        draft.change({ reportNotes: [], overrides: [] });
        draft.synchronizeTime(viewerTime, reportDates);
        updateSelection();
        if (prepared) await previewExport();
    }
    async function previewExport({ contentOnly = false, focus = !contentOnly } = {}) {
        const publication = api.publicationToken();
        if (!publication || clearingAccess) return;
        const blocked = nativeReportBlock() || hiddenReportBlock();
        if (blocked) {
            updateSelection();
            const issue = [$("reportPrepareIssue"), $("reportReviewBody")?.querySelector(".rebuild-preview")].find(node => node?.checkVisibility());
            if (issue) {
                issue.tabIndex = -1; issue.focus({ preventScroll: true });
                issue.scrollIntoView({ block: "nearest" });
            } else announce(blocked, "stale");
            return;
        }
        if (exportWriting || reportJourney?.snapshot().phase === "scanning" || !ensureCurrentTime() || workspaceState.loading || workspaceState.stale || $("exportBtn").disabled) return;
        let selection = reportSelection().selection(workspaceState.evidence.revision);
        const nativeRequest = usesBoundedReportView() ? draft.nativeView(reportNativeView(), workspaceState.evidence.revision, reportNativeIntent()).request : null;
        if (usesBoundedReportView() && !nativeRequest) { updateSelection(); return; }
        const rebuilding = contentOnly && reportRebuildFrom;
        if (workspaceState.route.view === "reports" && workspaceState.route.task !== "create") {
            const moved = await navigate(routeFor("reports", { task: "create", inspect: undefined }), false, { keepFocus: true });
            if (!moved || !api.isCurrent(publication)) return;
        }
        if (!rebuilding) {
            const pendingMaskSave = contentOnly && saveAfterMask;
            invalidatePreview(undefined, { preserveFileView: true });
            saveAfterMask = pendingMaskSave;
        }
        draft.change({ saveMode: "local", ...(!periodReport && !nativeRequest && !draft.options().reportFocus ? {
            reportFocus: { version: 1, preset: "custom", outcome: "all", services: [] }, resultTextKind: "errors",
        } : {}) });
        clearPreviewPayload?.();
        const body = reportJourney.beginScan({ focus });
        if (!body) return;
        const preparationOwner = {};
        reportPreparationOwner = preparationOwner;
        reportPreparing = true;
        const operation = draft.token();
        const publicationContext = nativePublicationContext(), previewStartedAt = performance.now();
        const progress = el("p", "", "Scanning selected evidence locally. No files are being written.");
        progress.setAttribute("role", "status");
        ux.pending(progress, true);
        body.append(progress);
        try {
            const refused = nativeReportBlock() || hiddenReportBlock();
            if (refused) { body.replaceChildren(); reportJourney.failed(refused); return; }
            const reportView = !rebuilding && !periodReport && !nativeRequest && reportScope === "current" && draft.options().reportFocus ? {
                analytics: workspaceState.scope,
                withinServices: workspaceState.route.withinServices?.split(",").filter(Boolean) ?? [],
                ...(search.trim() ? { withinScenarioIds: analysisSlice.legacyScenarioIds(workspaceState.evidence, search) } : {}),
                ...(semanticQuery !== null ? { semanticSelection: { receipt: semanticMembership?.receipt } } : {}),
            } : null;
            const preview = await api("/api/preview", { ...(rebuilding ? { rebuildFrom: rebuilding } : periodReport ? { periodComparison: periodReport.value,
                ...(periodReport.semanticSelection ? { semanticSelection: periodReport.semanticSelection } : {}) } : { selection,
                    ...(nativeRequest ? { nativeViewId: nativeRequest.nativeViewId } : {}),
                    ...(namedReport ? { namedDraft: { id: namedReport.id, revision: namedReport.revision } } : {}),
                    ...(reportView ? { reportView } : {}) }), options: draft.options() });
            if (!api.isCurrent(publication)) return;
            if (!ensureCurrentTime() || !draft.current(operation) || !reportJourney.isReviewOpen()) {
                if (reportUpdateAgain && preview.snapshot?.reportPopulation) reportRebuildFrom = preview.previewId;
                else if (preview.previewId) await api("/api/cancel-preview", { previewId: preview.previewId });
                return;
            }
            if (preview.privacy?.allSelectedFieldsScanned !== true || !preview.files || !preview.previewId) throw new Error("The local privacy scan is incomplete. Export is blocked.");
            if (!draft.bindContext(preview)) {
                await api("/api/cancel-preview", { previewId: preview.previewId });
                throw new Error("Recorded context changed while preparing this preview. Read current activity and prepare a new preview.");
            }
            activePreview = preview;
            reportRebuildFrom = null;
            if (preview.snapshot?.nativeEvidence) nativePublication.preview(preview, publicationContext, previewStartedAt);
            renderPreview(body, preview, operation, { focus });
            if (saveAfterMask && preview.promptMode === "masked" && draft.current(operation)) {
                saveAfterMask = false;
                $("reportSaveActions").querySelector("button")?.click();
            }
        } catch (error) {
            if (!api.isCurrent(publication) || !draft.current(operation)) return;
            if (nativeRequest) draft.rejectNativeView();
            body.replaceChildren();
            reportJourney.failed(error.message + " No files were written. Prepare a new preview.");
            if (nativeRequest) updateSelection();
        } finally {
            if (reportPreparationOwner === preparationOwner) {
                reportPreparing = false; reportPreparationOwner = null;
                if (api.isCurrent(publication)) reportExperience?.sync();
                if (api.isCurrent(publication) && reportUpdateAgain) {
                    reportUpdateAgain = false;
                    reportUpdateTimer = setTimeout(() => { void previewExport({ contentOnly: true }); }, 0);
                }
            }
        }
    }
    function renderPreview(body, preview, operation, { focus = true } = {}) {
        const readingSelection = pendingReportReading;
        pendingReportReading = null;
        clearPreviewPayload?.();
        const publication = api.publicationToken();
        if (document.activeElement !== $("reportTitle") && !draft.options().title?.trim()) $("reportTitle").value = preview.title ?? "";
        detailOwner = "preview:" + preview.previewId;
        body.replaceChildren();
        body.dataset.recordedContext = String(Boolean(preview.snapshot?.recordedContext || preview.snapshot?.nativeEvidence || preview.snapshot?.resultText));
        const contextToken = draft.contextToken();
        const nativeReport = Boolean(preview.snapshot?.nativeEvidence);
        const localSave = preview.localSaveRequest?.version === 1;
        const modeLabels = { none: "No prompts", masked: "Masked prompts", original: "Original prompts" };
        const mode = preview.promptMode || "none";
        const formats = (preview.formats || ["markdown"]).map((f) => f === "markdown" ? "Markdown" : f.toUpperCase()).join(", ");
        function readableCopy(label, text) {
            const block = el("div", "report-read-copy");
            text.tabIndex = 0; text.setAttribute("aria-label", label);
            block.append(el("p", "report-copy-label", label), text);
            return block;
        }
        body.append(el("p", "report-privacy-note", mode === "original" ? "Original wording included; detected credentials removed." : mode === "none"
            ? preview.snapshot?.resultText ? "Prompt text is omitted. Chosen result text is included only as masked, reviewed copies."
                : preview.snapshot?.nativeEvidence ? "Microsoft message and context text is omitted."
                : "Local originals are excluded from saved files."
            : "Detected personal details are hidden. Check names and sensitive wording."));
        if (preview.snapshot?.recordedContext) {
            const context = preview.snapshot.recordedContext;
            const note = el("section", "report-context-review");
            const coverage = [`${count(context.coverage.included)} included`,
                ...["omitted", "unavailable", "partial"].filter(key => context.coverage[key]).map(key => `${count(context.coverage[key])} ${key}`)];
            note.append(el("h3", "", "Recorded context"), el("p", "", coverage.join(" / ")),
                el("p", "muted", "Context does not prove a single task or add measured activity."));
            for (const gap of new Set(context.anchors.flatMap(anchor => anchor.gaps))) note.append(el("p", "context-help-note", gap));
            body.append(note);
        }
        const changed = () => {
            if (!api.isCurrent(publication) || preview === null || !body.isConnected) return;
            if (localSave) { updateReportContent(); return; }
            const canRebuild = activePreview === preview || body.querySelector(".rebuild-preview");
            invalidatePreview(canRebuild ? "" : undefined);
            body.querySelectorAll("[data-review-control]").forEach((node) => { node.disabled = true; });
            if (canRebuild && !body.querySelector(".rebuild-preview")) {
                const warning = el("div", "notice stale rebuild-preview");
                warning.setAttribute("role", "status");
                const rebuild = button("Rebuild preview", previewExport);
                rebuild.disabled = Boolean(nativeReportBlock());
                warning.append(el("p", "", nativeReportBlock() || reportCopyRebuildMessage), rebuild);
                body.prepend(warning);
            }
        };
        const reviewCopies = [...(preview.promptReview ?? []), ...(preview.contextReview ?? []), ...(preview.nativeReview ?? []), ...(preview.resultReview ?? [])];
        let shownCopy;
        clearPreviewPayload = () => {
            clearTimeout(nativePreviewExpiryTimer); syncNativeSaveAvailability = null;
            clearPreparedReaders();
            erasePreparedNodes(body);
            if (shownCopy && !body.contains(shownCopy)) erasePreparedNodes(shownCopy);
            shownCopy = null;
            for (const copy of reviewCopies) for (const key of Object.keys(copy)) delete copy[key];
            reviewCopies.length = 0;
            for (const record of preview?.records ?? []) for (const copy of record.prompts ?? []) copy.text = null;
            for (const copy of preview?.snapshot?.resultText?.copies ?? []) copy.text = null;
            for (const copy of preview?.snapshot?.recordedContext?.entries ?? []) copy.text = null;
            for (const copy of preview?.snapshot?.nativeEvidence?.disclosure?.copies ?? []) copy.text = null;
            for (const note of preview?.snapshot?.reportNotes?.entries ?? []) note.text = "";
            for (const key of Object.keys(preview?.files ?? {})) delete preview.files[key];
            for (const key of Object.keys(preview?.snapshot ?? {})) delete preview.snapshot[key];
            if (preview) { preview.previewHtml = ""; preview.title = ""; renderedContextBundles.delete(preview); }
            preview = null;
            clearPreviewPayload = null;
        };
        if (reviewCopies.length) {
            const comparisons = el("section", "prompt-comparisons");
            comparisons.setAttribute("aria-label", "Text in your report");
            if (preview.nativeReview?.length) comparisons.append(el("p", "context-help-note",
                "Saved Microsoft text may be incomplete. Replies are not verified as final."));
            const incomplete = reviewCopies.filter(prompt => (prompt.availability
                ? !["recorded", "recorded-empty"].includes(prompt.availability) : prompt.status !== "full") || prompt.original === null).length;
            if (incomplete) {
                const summary = el("p", "prompt-review-summary");
                setReportMetadata(summary, [`${count(incomplete)} incomplete, excluded or unavailable sources`]);
                comparisons.append(summary);
            }
            const copies = el("div");
            const copiesKey = "copies:" + preview.previewId;
            if (readingSelection?.copyKey) presentation.setPage(copiesKey, Math.max(0, reviewCopies.findIndex(copy => copy.key === readingSelection.copyKey)));
            pagedList(copies, reviewCopies, { key: copiesKey, size: 1, noun: "report copies", renderItem: prompt => {
                if (shownCopy) erasePreparedNodes(shownCopy);
                detailOwner = "preview:" + preview.previewId + ":" + prompt.key;
                const nativeCopy = typeof prompt.key === "string" && prompt.key.startsWith("native-copy-");
                const resultCopy = typeof prompt.key === "string" && prompt.key.startsWith("result-copy-");
                const displayLabel = resultCopy ? `${prompt.label}${prompt.entryIndex !== null ? ` / returned API entry ${prompt.entryIndex + 1}` : ""} / masked retained result text`
                    : nativeCopy ? (`Microsoft ${prompt.purpose === "prompt" ? "user message" : "recorded context"} / ${prompt.author === "unknown" ? "author unknown" : prompt.author} / ${(prompt.kind === "native-message" ? prompt.representationKind || "message" : prompt.kind).replaceAll("-", " ").replaceAll("_", " ")}`)
                    : prompt.kind === "response" ? "Recorded reply (context; finality unverified)"
                    : prompt.kind === "origin" ? textAccess.caption(prompt) : prompt.kind === "tool" ? `Recorded tool argument (${prompt.label})` : `${prompt.label} / ${textAccess.caption(prompt)}`;
                const item = el("article", "prompt-comparison");
                shownCopy = item;
                item.dataset.copyKey = prompt.key;
                const interaction = preview.records.findIndex(record => record.prompts?.some(copy => copy.key === prompt.key)
                    || record.scenarioId === prompt.scenarioRef);
                item.append(el("h4", "", `${interaction >= 0 ? `Interaction ${interaction + 1} · ` : ""}${displayLabel}${prompt.omitted ? " (omitted)" : ""}`));
                const pair = el("div", "prompt-pair");
                const original = el("div", "prompt-original"), copy = el("div", "prompt-report");
                original.hidden = true;
                const versions = el("div", "report-copy-versions");
                versions.setAttribute("role", "group"); versions.setAttribute("aria-label", "Text version");
                const showCopy = button("Report copy", () => showVersion(false), "quiet");
                const showOriginal = button("Local original", () => showVersion(true), "quiet");
                function showVersion(local) {
                    original.hidden = !local; copy.hidden = local;
                    showCopy.setAttribute("aria-pressed", String(!local)); showOriginal.setAttribute("aria-pressed", String(local));
                }
                showVersion(false);
                versions.append(showCopy, showOriginal); item.append(versions);
                if (prompt.original === null) original.append(el("p", "", "Original text is unavailable."));
                else {
                    original.append(readableCopy("Retained on this device; report edits do not change it.", el("pre", "", prompt.original)));
                    if (!nativeCopy && prompt.status !== "full") original.append(el("p", "muted", "Only part of the original was recorded. Missing text is not reconstructed."));
                }
                const rendered = el("pre");
                if (prompt.text === null) copy.append(el("p", "", prompt.omitted ? nativeCopy || resultCopy ? "No text included in this copy." : prompt.kind === "response" ? "No reply text included." : "No prompt text included." : "Source text unavailable; not reconstructed."));
                else {
                    for (const segment of prompt.segments) {
                        if (segment.category) {
                            const mark = el("mark", segment.mandatory ? "mandatory" : "", segment.text);
                            mark.tabIndex = 0;
                            rendered.append(ux.tooltip(mark, segment.mandatory ? "Credentials are always removed from saved files." : `${segment.category.replaceAll("_", " ")} masked; original unchanged.`));
                        } else rendered.append(document.createTextNode(segment.text));
                    }
                    copy.append(readableCopy("Included in the report", rendered));
                }
                for (const category of [...new Set(prompt.changes.map((c) => c.category))]) copy.append(el("p", "muted", `${category.replaceAll("_", " ")}: ${prompt.changes.filter((c) => c.category === category).length} removal(s).`));
                if (prompt.edited) copy.append(el("p", "muted", "Edited report copy."));
                pair.append(original, copy);
                item.append(pair);
                if ((mode !== "none" || resultCopy) && prompt.original !== null) {
                    const edit = el("details", "detail-disclosure");
                    edit.append(el("summary", "", "Edit or omit this report copy"));
                    edit.addEventListener("toggle", () => {
                        const reading = copy.querySelector(".report-read-copy");
                        if (reading) reading.hidden = edit.open;
                    });
                    const fields = el("fieldset", "report-copy-controls");
                    fields.disabled = exportWriting || reportJourney.snapshot().saveUnconfirmed;
                    const omit = el("input"), omitLabel = el("label", "attestation");
                    omit.type = "checkbox"; omit.checked = prompt.omitted;
                    omitLabel.append(omit, el("span", "", prompt.scenarioRef || resultCopy ? "Omit this copy from the report" : "Omit this prompt from the report"));
                    const textarea = el("textarea");
                    const override = draft.options().overrides.find(value => value.key === prompt.key);
                    omit.checked = override?.omit ?? prompt.omitted;
                    textarea.rows = 5; textarea.value = override?.text ?? prompt.text ?? ""; textarea.disabled = omit.checked;
                    textarea.setAttribute("aria-label", `Report copy: ${displayLabel}`);
                    const saveEdit = () => {
                        if (!api.isCurrent(publication) || preview === null || !textarea.isConnected || !body.contains(textarea)) return;
                        if (exportWriting || reportJourney.snapshot().saveUnconfirmed) return;
                        const overrides = draft.options().overrides.filter((o) => o.key !== prompt.key);
                        overrides.push({ key: prompt.key, omit: omit.checked, ...(omit.checked || prompt.omitted && !textarea.value ? {} : { text: textarea.value }) });
                        draft.change({ overrides });
                        changed();
                    };
                    omit.addEventListener("change", () => {
                        if (!api.isCurrent(publication) || preview === null || !omit.isConnected || !body.contains(omit)) return;
                        if (exportWriting || reportJourney.snapshot().saveUnconfirmed) return;
                        textarea.disabled = omit.checked;
                        if (!localSave) saveEdit();
                    });
                    if (!localSave) textarea.addEventListener("input", saveEdit);
                    fields.append(el("p", "", "Changes affect this report copy only."),
                        omitLabel, textarea, el("p", "muted", mode === "masked" || resultCopy ? "Personal details and credentials are masked again." : "Credentials are removed again."));
                    if (localSave) fields.append(button("Update report copy", saveEdit));
                    edit.append(fields);
                    copy.prepend(edit);
                }
                return viewKey(item, detailOwner);
            } });
            comparisons.append(copies);
            body.append(comparisons);
        }
        const report = el("div", "report-document"), exactFiles = el("section", "report-file-inspection");
        function showExactFiles(value) {
            if (!api.isCurrent(publication)) return;
            if ((value.snapshot?.recordedContext || value.snapshot?.nativeEvidence || value.snapshot?.resultText) && !draft.contextCurrent(contextToken)) return;
            if (value.snapshot?.recordedContext || value.snapshot?.nativeEvidence || value.snapshot?.resultText) renderedContextBundles.add(value);
            const selection = preparedFileInspection?.selection() ?? readingSelection?.file;
            preparedFileInspection?.dispose();
            preparedFileInspection = mountFileInspection(exactFiles, value.files, {
                id: "preparedReportFile", selection, hideRail: localSave, brandVersion: value.snapshot?.presentation?.brandVersion,
                isCurrent: () => api.isCurrent(publication) && draft.current(operation) && activePreview?.previewId === value.previewId
                    && (!(value.snapshot?.recordedContext || value.snapshot?.nativeEvidence || value.snapshot?.resultText) || draft.contextCurrent(contextToken)),
            });
            preparedFileInspection.refresh();
        }
        function showFiles(value) {
            if (!api.isCurrent(publication)) return;
            if ((value.snapshot?.recordedContext || value.snapshot?.nativeEvidence || value.snapshot?.resultText) && !draft.contextCurrent(contextToken)) return;
            if (value.snapshot?.recordedContext || value.snapshot?.nativeEvidence || value.snapshot?.resultText) renderedContextBundles.add(value);
            report.replaceChildren();
            if (value.previewHtml) {
                preparedReportReader?.dispose();
                preparedReportReader = assessmentFactories.preparedFrame(value.previewHtml, assessmentFactories.liveSearch.frozenFrame, {
                    isCurrent: () => api.isCurrent(publication),
                    contained: localSave,
                    reading: readingSelection?.document,
                    isReadingCurrent: () => readingSelection?.intent === workspaceState.readingIntent
                        && readingSelection.navigation === workspaceState.navigationGeneration,
                    onReadingIntent: () => workspaceState.noteReading(),
                    onReadingRestored: () => {
                        restoreReading(readingSelection?.outer);
                        forgetReading(readingSelection?.outer);
                    },
                    onReady: (source, refresh) => {
                        if (localSave) assessmentFactories.enhanceReportReading(source, { icon: ux.icon });
                        return assessmentFactories.decoratePreparedReport(source, {
                            preview: value, notes: draft.options().reportNotes ?? [],
                            current: () => api.isCurrent(publication) && draft.current(operation) && activePreview?.previewId === value.previewId,
                            refresh,
                            onNote: (scenarioId, text) => {
                                const reportNotes = (draft.options().reportNotes ?? []).filter(note => note.scenarioId !== scenarioId);
                                if (text.trim()) reportNotes.push({ scenarioId, text });
                                draft.change({ reportNotes }); updateReportContent();
                            },
                            onCopy: (key, text, omit) => {
                                const overrides = draft.options().overrides.filter(copy => copy.key !== key);
                                overrides.push({ key, ...(omit ? { omit: true } : { text }) });
                                draft.change({ overrides }); updateReportContent();
                            },
                        });
                    },
                    onError: message => {
                        if (!api.isCurrent(publication) || !draft.current(operation) || exportWriting) return;
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
        for (const [category, occurrences] of Object.entries(preview.privacy.categories || {})) if (occurrences) scan.append(el("p", "", `${category.replaceAll("_", " ")}: ${occurrences} source occurrence(s).`));
        for (const limitation of preview.privacy.limitations || []) scan.append(el("p", "", limitation));
        if (preview.privacy.context) {
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
        if (!localSave) approval.append(attestation);
        body.append(approval);
        const feedback = el("p", "muted");
        feedback.setAttribute("role", "status");
        const review = button("Approve for local saving", async () => {
            if (!api.isCurrent(publication)) return;
            if (workspaceState.loading || workspaceState.stale || !ensureCurrentTime() || !checkbox.checked || !draft.current(operation)) return;
            review.disabled = checkbox.disabled = true;
            feedback.textContent = "Recording your disclosure review...";
            ux.pending(review, true);
            try {
                const result = await api("/api/privacy-review", { previewId: activePreview.previewId, disclosureReviewed: true, timeContext: viewerTime });
                if (!api.isCurrent(publication) || !ensureCurrentTime() || !draft.current(operation) || !reportJourney.isReviewOpen()) return;
                if (result.privacy?.reviewerConfirmed !== true || result.privacy?.allSelectedFieldsScanned !== true) throw new Error("The review was not confirmed.");
                const nativeReady = !nativeReport || nativePublication.review(result, nativePublicationContext());
                activePreview = result;
                showExactFiles(result);
                review.textContent = "Disclosure reviewed";
                feedback.textContent = !nativeReady ? "Disclosure reviewed. " + nativePublication.reason()
                    : "Reviewed. Not saved yet.";
                confirm.disabled = !nativeReady;
                reportJourney.reviewed();
            } catch (error) {
                if (!api.isCurrent(publication) || !draft.current(operation) || !review.isConnected) return;
                feedback.className = "notice error"; feedback.setAttribute("role", "alert"); feedback.textContent = error.message + " Prepare a new preview."; review.textContent = "Review not confirmed"; reportJourney.failed(feedback.textContent);
            }
            finally { if (api.isCurrent(publication) && review.isConnected) ux.pending(review, false); }
        });
        ux.pending(review, false);
        review.disabled = true;
        review.dataset.reviewControl = "";
        checkbox.addEventListener("change", () => { if (api.isCurrent(publication)) review.disabled = !checkbox.checked || !draft.current(operation); });
        const confirm = button("Save report", async () => {
            if (!api.isCurrent(publication) || exportWriting || !draft.current(operation) || !activePreview || hiddenReportBlock()) return;
            let keepChatDetailsConfirmed = false;
            if (localSave && activePreview.promptMode === "original") {
                confirm.disabled = true;
                const choice = await reportSaveWarning.choose(activePreview.formats.map(format => assessmentFactories.reportFileChoices[format].name));
                if (!api.isCurrent(publication) || !draft.current(operation) || !activePreview || !confirm.isConnected || hiddenReportBlock()) return;
                confirm.disabled = false;
                if (!choice) return;
                if (choice === "masked") {
                    draft.change({ promptMode: "masked" });
                    updateReportContent({ hide: true, delay: 0 });
                    saveAfterMask = true;
                    return;
                }
                keepChatDetailsConfirmed = true;
            }
            if (nativeReport) syncNativeSaveAvailability?.();
            if (nativeReport && !nativePublication.canSave(nativePublicationContext())) {
                syncNativeSaveAvailability?.(); return;
            }
            if (!api.isCurrent(publication) || exportWriting || workspaceState.loading || workspaceState.stale || !ensureCurrentTime() || !draft.current(operation)
                || !localSave && activePreview?.privacy?.reviewerConfirmed !== true || !reportJourney.isReviewOpen()) return;
            confirm.disabled = true;
            ux.pending(confirm, true);
            let exportResponseReceived = false, dispatched = false;
            const saving = {};
            const offerSaveRecovery = () => $("reportSaveBody").append(button("Check save status", () => reportJourney.recoverSave()));
            try {
                const identity = await reportJourney.prepareSaveIdentity(activePreview);
                if (!identity || !api.isCurrent(publication)) return;
                if (nativeReport) syncNativeSaveAvailability?.();
                if (nativeReport && !nativePublication.canSave(nativePublicationContext())) {
                    syncNativeSaveAvailability?.(); return;
                }
                if (reportJourney.writing(true) === false) return;
                exportWriting = true; dispatched = true; pendingSaveOwner = saving;
                $("clearPreviewSelection").disabled = true;
                $("closeDialog").disabled = true;
                feedback.textContent = "Saving on this device. This save cannot be cancelled or repeated.";
                let response = await api("/api/export", { previewId: identity.previewId, confirmed: true, timeContext: viewerTime,
                    ...(localSave ? { localSave: { ...activePreview.localSaveRequest, keepChatDetailsConfirmed } } : {}) });
                if (!api.isCurrent(publication)) { response = null; return; }
                pendingSaveResult = response; response = null;
                exportResponseReceived = true;
                const matched = await reportJourney.matchesSaveIdentity(pendingSaveResult.bundle);
                if (!api.isCurrent(publication)) return;
                if (!matched) throw new Error("The saved report receipt did not match the dispatched report.");
                activePreview = null;
                presentation.setPage(savedLibraryPageKey(), 0);
                const loaded = await load({ afterExport: true });
                if (!api.isCurrent(publication)) return;
                if (!loaded) {
                    reportJourney.failed("The report save was confirmed, but its availability could not be checked. Read saved history before downloading; do not save it again.");
                    offerSaveRecovery();
                    announce("The report save was confirmed. Current saved files could not be checked; use Retry without repeating the save.", "stale", true);
                    return;
                }
                const revision = workspaceState.evidence.revision;
                let indexed = workspaceState.evidence.exports.find(bundle => bundle.bundleId === identity.bundleId);
                const available = Boolean(indexed), verified = indexed ? reportJourney.matchesSaveIdentity(indexed) : Promise.resolve(true);
                indexed = null;
                const indexMatches = await verified;
                if (!api.isCurrent(publication)) return;
                if (!indexMatches || workspaceState.evidence.revision !== revision) throw new Error("The registered saved report identity changed while checking this save.");
                clearPreparedReaders();
                reportJourney.saved(pendingSaveResult.bundle, { available });
                if (workspaceState.route.view !== "reports") announce(available ? "Local report saved: " + savedTitle(pendingSaveResult.bundle) + "."
                    : "The saved report is no longer available. Its downloads have been removed.", available ? "" : "stale");
            } catch (error) {
                if (!api.isCurrent(publication)) return;
                activePreview = null;
                const original = reportJourney.saveIdentity();
                const refusedBeforePublication = error.reportSave?.outcome === "not-published"
                    && error.reportSave.kind === "report" && error.reportSave.previewId === original?.previewId
                    && error.reportSave.bundleId === original?.bundleId;
                const saveRejected = !dispatched || !exportResponseReceived && (error.code === "request_rejected" || refusedBeforePublication);
                feedback.className = "notice error"; feedback.setAttribute("role", "alert");
                const lostResponse = error.code === "request_outcome_unknown"
                    && ["runtime_unavailable", "invalid_response"].includes(error.reason);
                feedback.textContent = !saveRejected && lostResponse
                    ? `${error.reason === "invalid_response" ? "The Save response could not be read." : "WIRE did not return a Save response."} The local write may have completed. Check save status; do not save again.`
                    : error.message + (saveRejected
                    ? " No report was saved. Read current activity, then prepare a new report."
                    : " Check save status; do not repeat the save.");
                confirm.textContent = saveRejected ? "Save not sent" : "Export not confirmed";
                reportJourney.failed(feedback.textContent, { saveRejected });
                if (!saveRejected) offerSaveRecovery();
            }
            finally {
                const ownsCompletion = pendingSaveOwner === saving;
                if (ownsCompletion) { pendingSaveOwner = pendingSaveResult = null; exportWriting = false; }
                if (api.isCurrent(publication) && (ownsCompletion || !dispatched && !pendingSaveOwner)) {
                    retirePendingSaveMessage();
                    ux.pending(confirm, false); reportJourney.writing(false);
                    syncSaveLocks(); updateSelection();
                }
            }
        }, "primary");
        confirm.prepend(ux.icon("export"));
        ux.pending(confirm, false);
        confirm.disabled = !localSave;
        confirm.dataset.reviewControl = "";
        const controls = el("div", "dialog-actions");
        if (!localSave) controls.append(review);
        controls.append(confirm);
        const saveAvailability = el("p", "muted");
        saveAvailability.hidden = true;
        approval.append(feedback, saveAvailability);
        if (nativeReport) {
            syncNativeSaveAvailability = () => {
                if (!api.isCurrent(publication) || !confirm.isConnected || preview === null) return;
                if (!exportWriting && nativePublication.expired()) {
                    draft.rejectNativeView();
                    invalidatePreview("This report preview expired. Read current activity, then prepare and review a new copy. Your draft choices and edits are kept.");
                    updateSelection();
                    return;
                }
                const ready = nativePublication.canSave(nativePublicationContext());
                confirm.disabled = !ready || exportWriting || workspaceState.loading || workspaceState.stale || !draft.current(operation)
                    || !localSave && activePreview?.privacy?.reviewerConfirmed !== true;
                if (!exportWriting) {
                    const issue = nativePublication.reason();
                    setText(saveAvailability, issue);
                    saveAvailability.hidden = !issue;
                }
            };
            const deadline = nativePublication.deadline();
            if (deadline !== null) nativePreviewExpiryTimer = setTimeout(() => syncNativeSaveAvailability?.(),
                Math.max(0, Math.ceil(deadline - performance.now())));
        }
        body.append(controls);
        if (localSave) {
            const viewBar = el("div", "report-reading-toolbar"), label = el("label", "", "Viewing"), view = el("select");
            view.id = "preparedReportView";
            view.append(option("report", "Report in WIRE"));
            view.append(option("text", "Report text"));
            for (const name of Object.keys(preview.files)) view.append(option(name, reportFilenameLabel(name)));
            label.append(view);
            let expanded = false;
            const expand = button("Expand sections", () => {
                expanded = !expanded; preparedReportReader?.expand(expanded);
                expand.textContent = expanded ? "Collapse sections" : "Expand sections";
            }, "quiet");
            const fileHint = el("p", "context-help-note", "File preview only. Choose output in Formats.");
            fileHint.id = "preparedFileViewingHint"; fileHint.hidden = true;
            viewBar.append(label, expand); report.prepend(viewBar, fileHint);
            exactFiles.id = "reportFileInspection"; exactFiles.hidden = true;
            const reportFrame = preparedReportReader?.frame;
            const optionalText = el("section", "report-copy-inspection document-reading-pane");
            optionalText.id = "reportTextInspection"; optionalText.hidden = true;
            if (!reviewCopies.length) optionalText.append(el("p", "", "No text copies in this report."));
            for (const node of body.querySelectorAll(":scope > .report-privacy-note,:scope > .report-context-review,:scope > .prompt-comparisons,:scope > .report-privacy-findings")) optionalText.append(node);
            report.append(optionalText);
            function showView() {
                if (!api.isCurrent(publication) || !view.isConnected) return;
                const reading = view.value === "report", text = view.value === "text";
                fileHint.hidden = reading || text;
                if (fileHint.hidden) view.removeAttribute("aria-describedby"); else view.setAttribute("aria-describedby", fileHint.id);
                if (reportFrame) reportFrame.hidden = !reading;
                exactFiles.hidden = reading || text; optionalText.hidden = !text; expand.hidden = !reading;
                if (!reading && !text) {
                    if (preparedFileInspection.selection().name !== view.value) preparedFileInspection.select(view.value);
                    else preparedFileInspection.refresh();
                }
                renderReportTask();
            }
            view.addEventListener("change", showView);
            if ([...view.options].some(option => option.value === readingSelection?.view)) view.value = readingSelection.view;
            showView();
            reportJourney.previewReady({ ...preview, promptReview: reviewCopies }, { confirm, feedback, focus });
            reportExperience?.sync(); selectControls?.sync();
            if (view.value === "text" && readingSelection?.focusCopy) {
                const heading = optionalText.querySelector(".prompt-comparison h4");
                if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
            }
            return;
        }
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
                renderReportTask();
                if (index === 2) window.scrollTo(0, 0);
                else window.scrollBy(0, tab.getBoundingClientRect().top - top);
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
            tabControls[0].click();
            const offset = (parseFloat(getComputedStyle(tabs).top) || 0) + tabs.getBoundingClientRect().height + 12;
            window.scrollBy(0, approval.getBoundingClientRect().top - offset);
            (checkbox.disabled ? confirm : checkbox).focus({ preventScroll: true });
        }, "quiet"));
        body.prepend(tabs);
        approval.before(report, textPanel, filesPanel);
        reportJourney.previewReady({ ...preview, promptReview: reviewCopies }, { confirm, feedback });
        selectControls?.sync();
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
        if (api.accessState().mode !== "unbound") { api.startAccess(); return; }
        draft.clearContext({ writing: exportWriting });
        scrubContextPreview();
        if (exportWriting) return;
        invalidatePreview();
        invalidateDialog("The panel reconnected. Close and prepare a new report preview before continuing.");
        if (workspaceState.analytics) { workspaceState.stale = true; updateSelection(); }
        return load({ background: Boolean(workspaceState.analytics) });
    }
    function handleVisibilityChange() {
        if (api.accessState().mode !== "unbound") {
            if (!document.hidden) api.startAccess();
            return;
        }
        draft.clearContext({ writing: exportWriting });
        scrubContextPreview();
        if (document.hidden && workspaceState.route.view === "request") {
            if (!requestInvalidated) saveSidebarPosition();
            requestInvalidated = true;
            clearReaderSections();
            requestRenderKey = null;
        }
        if (exportWriting) return;
        invalidatePreview();
        invalidateDialog("The panel changed visibility. Close and prepare a new report preview before continuing.");
        if (workspaceState.analytics) { workspaceState.stale = true; updateSelection(); }
        if (!document.hidden) load({ background: Boolean(workspaceState.analytics) });
    }
    function activateNavigation(node, event) {
        if (node.id === "comparePeriods" && api.publicationToken()) return;
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (!api.publicationToken()) { navigateAccessShell(node.dataset.nav); return; }
        if (node.dataset.nav === "analyze") navigateBrowse("analyze");
        else if (node.dataset.nav === "trends") navigateBrowse("trends");
        else go(node.dataset.nav, { request: undefined, task: undefined });
    }
    if (assessmentFactories.bindNavigation) assessmentFactories.bindNavigation(activateNavigation);
    // The React shell owns its navigation clicks, but Settings uses native links in both renderers.
    const nativeNavigationRoot = assessmentFactories.bindNavigation ? $("settingsView") : document;
    nativeNavigationRoot.querySelectorAll("[data-nav]").forEach(node => node.addEventListener("click", event => activateNavigation(node, event)));
    for (const id of ["pageAction", "reportContextAction", "exploreLink", "reportLibraryLink", "reportCreateLink"]) $(id).addEventListener("click", (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (id === "reportLibraryLink") { backToReports(); return; }
        const reportTask = ["reportLibraryLink", "reportCreateLink"].includes(id);
        if (!reportTask && (workspaceState.loading || workspaceState.stale)) return;
        if (["pageAction", "reportCreateLink"].includes(id) && ["saved", "unavailable"].includes(reportJourney.snapshot().phase)) clearReportSelection();
        navigate({ ...linkTargets.get(event.currentTarget), search: workspaceState.route.search, returnToSessions: workspaceState.route.returnToSessions,
            ...(reportTask ? { localSearch: workspaceState.route.localSearch } : {}) });
    });
    $("resetView").addEventListener("click", resetView);
    document.querySelectorAll("[data-chart]").forEach((node) => node.addEventListener("click", () => go("home", {
        chart: node.dataset.chart, nativeGroup: undefined, request: undefined }, true)));
    for (const [id, key] of Object.entries({ layerFilter: "layer", sourceFilter: "source", toolFilter: "tool", serviceAssociationFilter: "services", serviceFilter: "service", projectFilter: "project", chatFilter: "session", scopeFilter: "scope" })) $(id).addEventListener("change", () => {
        if (restoring) return;
        refineScope({ [key]: $(id).value === "all" && key !== "scope" ? undefined : $(id).value,
            ...(key === "layer" ? { nativeGroup: undefined } : {}),
            ...(key === "layer" && $(id).value !== "tool" && workspaceState.route.service === "Discovery" ? { service: undefined } : {}),
            ...(key === "services" ? { includeMissingService: $(id).value !== "all" ? true : undefined, withinServices: undefined } : {}) });
    });
    $("addServiceContext").addEventListener("click", () => {
        ux.restoreFocus($("serviceAssociationFilter-control"));
        refineScope({ includeMissingService: true });
    });
    $("outcomeFilter").addEventListener("change", () => {
        if (restoring) return;
        const values = [...$("outcomeFilter").selectedOptions].map(option => option.value);
        refineScope({ result: results.filterValue(values) });
    });
    $("clearResultFilter").addEventListener("click", () => {
        ux.hideTooltip();
        const trigger = $("outcomeFilter-control");
        if (trigger.disabled) $("resultFilterLabel").tabIndex = -1;
        ux.restoreFocus(trigger.disabled ? $("resultFilterLabel") : trigger);
        refineScope({ result: undefined });
    });
    $("promptAuthorFilter").addEventListener("change", () => {
        if (restoring) return;
        const values = [...$("promptAuthorFilter").selectedOptions].map(option => option.value);
        refineScope({ authors: authorship.filterValue(values) });
    });
    $("clearPromptAuthorFilter").addEventListener("click", () => {
        ux.hideTooltip();
        ux.restoreFocus($("promptAuthorFilter-control"));
        refineScope({ authors: undefined });
    });
    const analyzeCalendarHost = el("div","historical-calendar");
    $("dateFields").prepend(analyzeCalendarHost);
    const dateSource = $("dateFilter"), dateField = dateSource.closest(".filter-field");
    dateSource.hidden = true; dateSource.dataset.nativeSelect = "";
    const analyzeDatesTrigger = el("button");
    analyzeDatesTrigger.id = "dateFilter-control";
    analyzeDatesTrigger.dataset.selectId = dateSource.id;
    dateField.querySelector("label").htmlFor = analyzeDatesTrigger.id;
    const analyzeDatesPanel = el("section"); analyzeDatesPanel.id = "analyzeDates";
    dateField.append(analyzeDatesTrigger); dateField.after(analyzeDatesPanel); analyzeDatesPanel.append($("dateFields"));
    const dateActions = $("applyDates").parentElement;
    dateActions.className = "report-popover-actions"; $("applyDates").classList.add("primary");
    dateActions.prepend(button("Cancel", () => analyzeDatesPicker.close(), "quiet"));
    const analyzeCalendar = assessmentFactories.createDateRangeCalendar({
        root:analyzeCalendarHost, id:"analyzeCalendar", existingFields:{from:$("fromFilter"),to:$("toFilter")},
        inputIds:{from:"fromFilter",to:"toFilter"}, time, ux, context:()=>viewerTime,
        current:()=>Boolean(api.publicationToken()) && !clearingAccess,
        onEdit:()=>{ workspaceState.dateDraft=analyzeCalendar.value(); },
        onChange:()=>{ $("applyDates").disabled=!analyzeCalendar.valid(); }
    });
    const analyzeDatesPicker = ux.datesPicker({ panel: analyzeDatesPanel, trigger: analyzeDatesTrigger, editor: $("dateFields"), embedded: true,
        current: () => Boolean(api.publicationToken()) && !clearingAccess && !dateField.inert && $("analyzeFilterDialog").open,
        options: Array.from(dateSource.options, o => [o.value, o.textContent]), selected: () => dateSelection().range,
        onCustom() {
            const { from, to } = dateSelection();
            workspaceState.dateDraft ??= { from: dateInput(from), to: dateInput(to) };
            analyzeCalendar.reset(workspaceState.dateDraft);
        },
        onClose() { workspaceState.dateDraft = null; analyzeCalendar.clear(); dateError(""); },
        onPreset(range) {
            const dates = range === "capture" ? { range: undefined, from: undefined, to: undefined }
                : { range, ...time.preset(range, viewerTime.timeZone) };
            refineScope(dates);
        } });
    $("filters").addEventListener("submit", (event) => {
        event.preventDefault();
        if ($("dateFields").hidden || dateField.inert || !$("analyzeFilterDialog").open || !api.publicationToken() || clearingAccess) return;
        const from = $("fromFilter").value, to = $("toFilter").value;
        try {
            if (!from || !to) throw new RangeError("Choose both dates. For one day, use the same date twice.");
            time.calendar(from); time.calendar(to); time.range({ from, to }, viewerTime.timeZone);
            if (!analyzeCalendar.valid()) throw new RangeError("Choose today or an earlier date.");
        } catch (error) { dateError(error.message); return; }
        dateError("");
        workspaceState.dateDraft = null;
        analyzeDatesPicker.close();
        if (workspaceState.loading && workspaceState.route.from === from && workspaceState.route.to === to) return;
        refineScope({ range: "custom", from, to });
    });
    function dateError(message) {
        setText($("dateError"), message);
        $("dateError").hidden = !message;
        for (const id of ["fromFilter", "toFilter"]) $(id).setAttribute("aria-invalid", String(Boolean(message)));
    }
    $("activitySearch").addEventListener("input", () => {
        search = $("activitySearch").value; activityPage = 0;
        workspaceState.route = { ...workspaceState.route, search, page: undefined };
        rememberRoute(workspaceState.route, true);
        if (workspaceState.loading) return;
        workspaceState.acceptedRoute = { ...workspaceState.route };
        render();
    });
    $("clearActivitySearch").addEventListener("click", () => {
        $("activitySearch").value = ""; $("activitySearch").dispatchEvent(new Event("input")); $("activitySearch").focus();
    });
    $("activitySearch").addEventListener("keydown", event => {
        if (event.key === "Escape" && search) { event.preventDefault(); $("clearActivitySearch").click(); }
    });
    for (const [id, clearLabel] of Object.entries({
        settingsSearch: "Clear settings search", issueSearch: "Clear affected chat search",
        savedReportSearch: "Clear saved report search", reportRequestSearch: "Clear report request search",
    })) {
        scopedSearches[id] = searchFields.mount($(id), { clearLabel, onInput() {
            if (id === "savedReportSearch") leaveSavedInspectorContext();
            const localSearch = { ...workspaceState.route.localSearch, [id]: $(id).value };
            workspaceState.route = { ...workspaceState.route, localSearch,
                ...(id === "reportRequestSearch" && workspaceState.route.view === "request" && underlyingRoute().view === "reports"
                    ? { returnToResults: { ...underlyingRoute(), localSearch } } : {}) };
            rememberRoute(workspaceState.route, true); workspaceState.acceptedRoute = { ...workspaceState.route };
            syncLocalSearchFields();
            if (id === "settingsSearch") renderSettingsSearch();
            else if (id === "issueSearch") { if (issueRows) renderCollectionIssues({ historyIssues: issueRows }); }
            else renderReports();
        }, focusAfterClear() {
            if (id === "issueSearch" && !$(id).checkVisibility()) ux.restoreFocus($("collectionIssuesTitle"));
            else $(id).focus();
        } });
        $(id).addEventListener("keydown", event => {
            if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented && $(id).value) { event.preventDefault(); scopedSearches[id].clear(); }
        });
    }
    $("savedReportOrder").addEventListener("change", () => {
        leaveSavedInspectorContext();
        navigate({ ...workspaceState.route, order: $("savedReportOrder").value === "oldest" ? "oldest" : undefined }, true, { keepFocus: true });
    });
    $("settingsSearchResults").addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); $("clearSettingsSearch").click(); }
    });
    const categoryNav = $("settingsCategoryNav"), defaultsGroup = el("div", "settings-default-links");
    const defaultsHeading = el("span", "settings-nav-group", "WIRE defaults");
    defaultsHeading.id = "settingsDefaultsHeading";
    defaultsGroup.setAttribute("role", "group");
    defaultsGroup.setAttribute("aria-labelledby", defaultsHeading.id);
    defaultsGroup.append(defaultsHeading);
    for (const category of settingsNavigation.categories) {
        const group = category.group === "defaults" ? defaultsGroup : categoryNav;
        if (group === defaultsGroup && !group.parentNode) categoryNav.append(group);
        const anchor = el("a");
        setRouteLink(anchor, routeFor("settings", { section: category.id, setting: undefined, issues: undefined }));
        // Static shell links use live navigation guards, not a pre-admission data publication.
        anchor.dataset.settingsLink = "";
        anchor.dataset.category = category.id;
        anchor.append(ux.icon("settings-" + category.id), el("span", "settings-category-label", category.title));
        group.append(anchor);
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
    $("freshStoredRead").addEventListener("click", refreshStoredData);
    if (assessmentFactories.bindRefresh) assessmentFactories.bindRefresh(control => checkActivity({ currentTarget: control }));
    else $("analyzeRefresh").addEventListener("click", checkActivity);
    $("deleteAllReports").addEventListener("click", () => {
        if (!savedListOwner?.current() || workspaceState.route.task !== "library" || $("deleteAllReports").disabled) return;
        $("savedLibraryManagement").hidePopover();
        ux.hideTooltip();
        savedArtifactUI.open({ scope: "all-reports" }, $("savedLibraryOptions"));
    });
    $("collectionRetry").addEventListener("click", refreshStoredData);
    $("collectionRetry").setAttribute("aria-describedby", "storedRefreshHelp");
    $("clearDates").addEventListener("click", () => {
        if (dateField.inert || !api.publicationToken() || clearingAccess) return;
        analyzeDatesPicker.close();
        workspaceState.dateDraft = null;
        analyzeCalendar.clear();
        ux.restoreFocus($("dateFilter-control"));
        go(workspaceState.route.view, { from: undefined, to: undefined, range: undefined, request: undefined, page: undefined });
    });
    $("checkActivity").addEventListener("click", checkActivity);
    $("settingsGeneralBack").onclick = () => { if (!$("settingsGeneralBack").hidden && !appUpdate?.locked()) history.back(); };
    function renderWireHelp() {
        const topic = workspaceState.route.section || "reports";
        for (const article of $("wireHelpView").querySelectorAll("[data-help-article]")) article.hidden = article.dataset.helpArticle !== topic;
        for (const link of $("wireHelpView").querySelectorAll("[data-help-topic]")) {
            if (link.dataset.helpTopic === topic) link.setAttribute("aria-current", "page");
            else link.removeAttribute("aria-current");
        }
    }
    for (const link of [$("openEvidenceHelp"), ...$("wireHelpView").querySelectorAll("[data-help-topic]")]) {
        link.addEventListener("click", event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (!api.publicationToken()) { navigateAccessShell("help"); return; }
            const section = link.dataset.helpTopic || "reports";
            if (workspaceState.route.view === "help" && (workspaceState.route.section || "reports") === section) return;
            navigate({ view: "help", section, analysisQuery: null });
        });
    }
    document.querySelectorAll("[data-settings-link]").forEach(node => node.addEventListener("click", event => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        const target = readRoute(node.getAttribute("href"), null);
        const changes = { section: target.section, setting: target.setting, issues: undefined };
        const mode = new URLSearchParams(node.search).get("mode");
        if (target.view === "analyze" && ["calls", "interactions"].includes(mode)) {
            changes.page = undefined;
        }
        if (node.hasAttribute("data-general-shortcut")) {
            node.focus({ preventScroll: true });
            navigate(routeFor(target.view, changes), false, { generalShortcut: true });
        } else go(target.view, changes);
    }));
    recorderUI = mountRecorderDiagnostics({ api, openDialog, el, button });
    const recorderLink = $("recorderResultLink"), recorderRoute = { view: "analyze", layer: "http" };
    setRouteLink(recorderLink, recorderRoute);
    recorderLink.addEventListener("click", event => {
        if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); navigate(recorderRoute);
    });
    $("exportBtn").addEventListener("click", previewExport);
    document.querySelectorAll("[data-clear-selection]").forEach(control => {
        control.addEventListener("click", clearReportSelection);
        ux.tooltip(control, "Empty this report selection and discard its preview and per-copy edits. Keep captured evidence, review labels, saved reports, filters and prompt/format choices.");
    });
    document.querySelectorAll("[name=reportScope]").forEach((control) => control.addEventListener("change", () => {
        if (exportWriting || periodReport) return;
        reportScope = control.value;
        reportBaseExplicit = true; reportDatesReplaced = false;
        reportDates = reportScope === "current" ? dateSelection() : { range: "capture" };
        draft.synchronizeTime(viewerTime, reportDates);
        reportEntry = null;
        acceptNativeReportScope();
        invalidatePreview(); renderReports();
    }));
    $("reportPromptAuthorFilter").addEventListener("change", () => {
        if (exportWriting || periodReport) return;
        reportAuthors = authorship.selection([...$("reportPromptAuthorFilter").selectedOptions].map(option => option.value));
        const prepared = reportJourney.snapshot().step === 3;
        invalidatePreview(undefined, { preserveFileView: true });
        draft.change({ reportNotes: [], overrides: [] });
        renderReports();
        if (prepared) void previewExport({ focus: false });
    });
    ux.explainDisabled($("exportBtn"), () => workspaceState.stale || workspaceState.loading ? "Wait for a current activity snapshot." : !draft.options().formats.length ? "Select at least one file format." : "Choose interactions in Activity, or use Current Analyze view or All saved sessions.");
    $("reportTitle").addEventListener("input", () => {
        if (exportWriting || reportJourney.snapshot().saveUnconfirmed) {
            updateSelection();
            announce(reportJourney.reason(1), "stale");
            return;
        }
        draft.change({ title: $("reportTitle").value });
        preparedReportReader?.setTitle($("reportTitle").value || activePreview?.title || "Activity report");
        updateReportContent();
    });
    document.querySelectorAll("[name=promptMode]").forEach((control) => control.addEventListener("change", () => {
        if (exportWriting || reportJourney.snapshot().saveUnconfirmed) return;
        draft.changePromptMode(control.value);
        const prepared = assessmentFactories.reportWorkspacePresentation(workspaceState.route, reportJourney.snapshot()).prepared;
        if (prepared || activePreview || reportRebuildFrom) updateReportContent({ hide: true, prepare: prepared });
        updateSelection({ refreshingPairedCopies: prepared });
    }));
    for (const [id, key] of [["usageTokens", "tokens"], ["usageDollars", "dollars"], ["usageRows", "rows"]]) $(id).addEventListener("change", () => {
        if (exportWriting || clearingAccess || !api.publicationToken()) return;
        draft.change({ usageOptions: { tokens: true, dollars: true, rows: false, ...draft.options().usageOptions, [key]: $(id).checked } });
        updateReportContent({ hide: true }); render();
    });
    $("reportRecordedContext").addEventListener("change", () => {
        if (exportWriting) return;
        draft.changeRecordedContext($("reportRecordedContext").checked);
        updateReportContent({ hide: true }); updateSelection({ refreshingPairedCopies: true });
    });
    $("reportResultText").addEventListener("change", () => {
        if (exportWriting) return;
        draft.change({ resultText: $("reportResultText").checked,
            overrides: draft.options().overrides.filter(edit => !edit.key.startsWith("result-copy-")) });
        updateReportContent({ hide: !$("reportResultText").checked });
        updateSelection();
    });
    $("formatOptions").querySelectorAll("input[type=checkbox]").forEach((control) => control.addEventListener("change", () => {
        const journey = reportJourney.snapshot(), surface = assessmentFactories.reportWorkspacePresentation(workspaceState.route, journey);
        if (exportWriting || journey.saveUnconfirmed || surface.saved
            || surface.prepared && ["saved", "unavailable"].includes(journey.phase)) return;
        const formats = [...$("formatOptions").querySelectorAll("input:checked")].map((node) => node.value);
        draft.change({ formats });
        $("formatError").hidden = formats.length > 0;
        if (surface.prepared || activePreview || reportRebuildFrom) updateReportContent({ prepare: surface.prepared && formats.length > 0, hide: !formats.length });
        updateSelection();
    }));
    $("manualTerms").addEventListener("input", () => {
        draft.change({ manualTerms: $("manualTerms").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) });
        updateReportContent({ hide: true });
    });
    $("closeDialog").addEventListener("click", () => $("overlay").close());
    $("overlay").addEventListener("close", () => {
        if (clearingAccess || !api.publicationToken()) return;
        invalidatePreview(); if (returnFocus?.isConnected) ux.restoreFocus(returnFocus);
    });
    $("overlay").addEventListener("cancel", (event) => { if (exportWriting) event.preventDefault(); });
    document.querySelector(".skip-link").addEventListener("click", event => {
        event.preventDefault();
        const heading = $("pageTitle");
        heading.tabIndex = -1;
        ux.restoreFocus(heading);
        heading.scrollIntoView({ block: "start" });
    });
    function traverse() {
        if (appUpdate?.locked()) { rememberRoute(workspaceState.route, true); return; }
        pendingFreshBrowse = false;
        initialRoute = null;
        initialHistory = null;
        if (!api.publicationToken()) {
            workspaceState.route = readRoute(currentAddress(), null);
            if (paths.legacy(location.hash)) {
                const { url } = routeAddress(workspaceState.route);
                initialRoute = { url, value: workspaceState.route };
                history.replaceState(null, "", url);
            }
            showAccessUnavailable(api.accessState());
            return;
        }
        if (location.hash && !paths.legacy(location.hash) && currentAddress() === acceptedAddress && !history.state?.evidenceView) {
            // A real document anchor (e.g. Skip to content) stays in the same private view.
            historyPosition++;
            rememberRoute(workspaceState.route, true);
            return;
        }
        incomingNavigationError = null;
        const next = readRoute();
        if (location.search && new URLSearchParams(location.search).has("privateView") && !historyViews.has(history.state?.evidenceView?.privateKey)
            && !analysisNavigations.has(history.state?.evidenceView?.analysisKey)) {
            incomingNavigationError = "This tab no longer has the private view. Open it again from its original records.";
        }
        if (next.view === "request" || next.inspect) ownSidebarHistory();
        else if (workspaceState.route.view !== "request" && !workspaceState.route.inspect) restoreSidebarHistoryMode();
        const originPosition = historyPosition, position = history.state?.evidenceView?.position;
        historyPosition = Number.isSafeInteger(position) ? position : historyPosition + 1;
        applyRoute(next, { restorePosition: true, originPosition });
    }
    window.addEventListener("popstate", traverse);
    // A native fragment navigation can emit both events. popstate canonicalizes
    // synchronously; do not dispatch the already-replaced fragment a second time.
    window.addEventListener("hashchange", () => { if (paths.legacy(location.hash)) traverse(); });
    window.addEventListener("pageshow", (event) => {
        if (!event.persisted) return;
        pageInactive = false;
        const identity = sidebarIdentity, intent = workspaceState.readingIntent;
        void recoverRead()?.then(accepted => {
            if (accepted && identity === sidebarIdentity && intent === workspaceState.readingIntent && workspaceState.route.view === "request") focusSidebar();
        });
    });
    window.addEventListener("online", recoverRead);
    window.addEventListener("focus", () => {
        if (!exportWriting) ensureCurrentTime();
        void accountProfile?.refresh();
        void microsoftProfile?.refresh();
    });
    window.addEventListener("languagechange", () => { if (!exportWriting) ensureCurrentTime(); });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", () => {
        pageInactive = true;
        if (api.accessState().mode !== "unbound") { api.suspendAccess(); return; }
        workspaceState.invalidateRead();
        if (workspaceState.route.view === "request") {
            if (!requestInvalidated) saveSidebarPosition();
            requestRenderKey = null;
            requestInvalidated = true;
            $("requestContent").replaceChildren(el("p", "notice", "Read current evidence before reopening this interaction."));
        }
        clearReaderSections(); clearSavedReader(); savedEntries.clear(); clearSidebarExit(); finishSidebarMotion();
        restoreSidebarHistoryMode(); clearPreparedReaders();
        assessmentUI.leave(); savedArtifactUI?.leave(); clearTimeout(pollTimer);
    });
    window.addEventListener("pageshow", () => {
        pageInactive = false;
        if (api.accessState().mode !== "unbound") { api.startAccess(); return; }
        clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 250);
    });
    document.addEventListener("visibilitychange", () => { if (sidebarExit) { clearSidebarExit(); finishSidebarMotion(); } assessmentUI.clearPrivateText(); if (!document.hidden) { clearTimeout(pollTimer); pollTimer = setTimeout(pollCollection, 250); } });
    for (const node of document.querySelectorAll("details[id]")) {
        if (!node.dataset.disclosureKey && node.id !== "settingsCategories") bindDetails(node, node.id, undefined, node.id === "bundles");
    }
    // The shared panel stays put; the plot's top changes with mode-specific heading controls.
    viewKey($("chart").closest(".analyze-chart-main"), "chart");
    reportJourney = createReportJourney({
        reportFirst: true,
        api, createSaveIdentity: assessmentFactories.createReportSaveIdentity,
        readSavedReports: async () => {
            const publication = api.publicationToken(), accepted = workspaceState.evidence, request = workspaceState.readGeneration;
            const currentRead = () => api.isCurrent(publication) && request === workspaceState.readGeneration && !pageInactive && !clearingAccess;
            if (!accepted || !currentRead()) return null;
            const current = await api("/api/snapshot", query());
            if (!currentRead() || workspaceState.evidence !== accepted || !Number.isSafeInteger(current.revision)
                || current.revision < accepted.revision || !Array.isArray(current.exports)) return null;
            if (JSON.stringify(accepted.exports || []) !== JSON.stringify(current.exports)) savedArtifactUI?.invalidate();
            if (!currentRead() || workspaceState.evidence !== accepted) return null;
            // Publish only the authorized file inventory; recovery does not replace the accepted activity/source frame.
            workspaceState.evidence = { ...accepted, exports: current.exports };
            return syncSavedReportPresence(currentRead) ? workspaceState.evidence.exports : null;
        },
        presentStep: presentReportStep,
        onStateChange: () => { syncSaveLocks(); renderStoredRefresh(); renderReportTask(); updateRequestReportActions(); },
        root: $("reportsView"), cancelReview: invalidatePreview, clearSelection: clearReportSelection,
        readCurrent: () => load(),
        showSourceIssues: async () => {
            await go("collection-status", { setting: "issues" });
        },
        downloadFile: downloadReportFile, fileLabel: reportFilenameLabel,
        openSavedReport,
        icon: name => ux.icon(name),
        utility: (...args) => ux.utility(...args),
    });
    function selectNamedReport(id) {
        if (exportWriting || reportPreparing || reportJourney.snapshot().saveUnconfirmed) return;
        const item = namedDrafts.read()?.drafts.find(d => d.id === id);
        if (id && !item) { announce("This draft is no longer available.", "stale"); return; }
        clearReportSelection();
        applyReportDefaults();
        if (item) {
            namedReport = { ...item, source: namedDrafts.read().source }; reportScope = "selected"; reportBaseExplicit = true;
            reportDates = { range: "capture" };
            for (const id of item.scenarioIds) selected.add(id);
            draft.change({ title: item.name });
            draft.synchronizeTime(viewerTime, reportDates);
        }
        updateSelection(); reportExperience.sync();
    }
    function syncNamedReport() {
        const catalog = namedDrafts.read();
        if (namedReport && catalog?.source === namedReport.source && !catalog.drafts.some(d => d.id === namedReport.id)
            && !reportPreparing && !exportWriting && !reportJourney.snapshot().saveUnconfirmed) {
            // Keep a frozen preview even if its editable draft is gone.
            if (activePreview || reportRebuildFrom) namedReport = null;
            else selectNamedReport("");
        }
        if (workspaceState.route.view === "reports") reportExperience?.sync();
    }
    async function deleteNamedReport(id, offered) {
        const publication = api.publicationToken();
        if (!publication || namedReport?.id !== id || namedReport.source !== offered.source || reportPreparing || reportSelectionBlock()
            || offered.version !== namedDrafts.read()?.version) {
            announce("The draft changed. Review it again before deleting.", "stale"); return;
        }
        const current = () => api.isCurrent(publication) && namedDrafts.read()?.source === offered.source;
        let latest, failure;
        try {
            ({ catalog: latest } = await api("/api/report-drafts/edit", { action: "delete", id, expected: offered.version }));
        } catch (error) {
            if (!current()) return;
            failure = error;
            try { latest = await api("/api/report-drafts/list", {}); }
            catch (readError) {
                if (current()) announce(`${error.message} Reload Reports to check the draft. ${readError.message}`, "stale");
                return;
            }
        }
        if (!current()) return;
        if (latest.source !== offered.source) { announce("The source changed. Reload Reports to check your drafts.", "stale"); return; }
        namedDrafts.accept(latest); syncNamedReport();
        const present = namedDrafts.read().drafts.some(d => d.id === id);
        if (!present) namedDrafts.notifyDeleted();
        announce(present ? `The draft is still here. ${failure?.message ?? "Review it before deleting."}`
            : failure ? "The draft is no longer in Reports." : "Draft deleted.", present ? "stale" : "info");
    }
    function revealAddedDraft(ref) {
        const catalog = namedDrafts.read();
        if (catalog?.source !== ref.source || !catalog?.drafts.some(d => d.id === ref.id)) {
            announce("This draft is no longer available for the current source.", "stale"); return;
        }
        selectNamedReport(ref.id);
        ($("namedReportDraft-control") || $("namedReportDraft"))?.focus({ preventScroll: true });
    }
    async function openAddedDraft(ref, publication) {
        if (!api.isCurrent(publication)) return;
        if (workspaceState.loading || workspaceState.stale || !workspaceState.evidence) { announce("Wait for current activity before opening the draft.", "stale"); return; }
        // A separate Reports tab preserves the other outline's choices, preview and any uncertain Save.
        if (hasReportDraftChoices() || activePreview || reportPreparing || pendingSaveOwner || exportWriting || reportJourney.snapshot().saveUnconfirmed) {
            const target = "/reports?privateView=required", recipient = window.open(target, "_blank");
            if (!recipient) { announce("Allow a new tab to open this draft without replacing your unfinished report.", "stale"); return; }
            const snapshot = workspaceState.evidence;
            const value = { namedDraft: ref, fields: {}, search: "", analysisQuery: null, revision: snapshot.revision,
                nativeRevision: snapshot.nativeRead?.revision, sourceVersion: snapshot.collection?.configVersion,
                deletionVersion: snapshot.deletionVersion, timeContext: structuredClone(workspaceState.scope.timeContext) };
            privateNavigations.set(recipient, { publication, recipient, target, value, expiresAt: performance.now() + privateNavigationLifetimeMs,
                timer: setTimeout(() => forgetPrivateNavigation(recipient), privateNavigationLifetimeMs) });
            return;
        }
        const intent = workspaceState.captureIntent(publication);
        let fresh;
        try { fresh = await api("/api/report-drafts/list", {}); }
        catch (error) { if (workspaceState.intentCurrent(intent)) announce(error.message, "stale"); return; }
        if (!workspaceState.intentCurrent(intent)) return;
        if (fresh.source !== ref.source || !fresh.drafts.some(d => d.id === ref.id)) {
            announce("This draft is no longer available for the current source.", "stale"); return;
        }
        namedDrafts.accept(fresh);
        const moved = navigate({ view: "reports" }), navigation = workspaceState.navigationGeneration;
        if (await moved && api.isCurrent(publication) && navigation === workspaceState.navigationGeneration && workspaceState.route.view === "reports") revealAddedDraft(ref);
    }
    reportExperience = assessmentFactories.createReportExperience({
        viewUsageTrend: () => {
            if (!api.publicationToken() || reportSelectionBlock() || reportBaseExplicit || namedReport) return;
            const {question,threshold=30000,author,tool} = draft.options().usageOptions ?? {};
            const {from,to} = effectiveReportDates();
            if (!question || !from || !to) return;
            const key = crypto.randomUUID();
            trendEntries.set(key,{reportVisit:true,scope:{family:"usage",period:"custom",range:{from,to},filters:{...(author ? {author} : {}),...(tool ? {tool} : {})},
                usageChoice:{question,threshold}},publication:api.publicationToken(),revision:workspaceState.evidence.revision,timeZone:viewerTime.timeZone});
            navigate({view:"trends",trendSection:"charts",trendEntry:key,search:"",analysisQuery:null});
        },
        questionControls: assessmentFactories.questionControls,
        changeUsage: (key, value) => {
            if (exportWriting || reportJourney.snapshot().saveUnconfirmed || clearingAccess || !api.publicationToken()) return;
            const options = { tokens:true, dollars:true, rows:false, ...draft.options().usageOptions };
            if (value === "" || key === "question" && value === "all") delete options[key]; else options[key] = value;
            if (key === "question") {
                if (value !== "tool") delete options.threshold;
                if (value === "all") { delete options.author; delete options.tool; }
            }
            const prepared = assessmentFactories.reportWorkspacePresentation(workspaceState.route, reportJourney.snapshot()).prepared;
            // A different cohort must prepare from the original selection, never broaden an inherited preview.
            if (activePreview || reportRebuildFrom) invalidatePreview("", {preserveFileView:true});
            draft.change({usageOptions:options});
            if (prepared) updateReportContent({hide:true,prepare:true});
            updateSelection();
        },
        root: $("reportsView"), time, ux,
        current: () => !clearingAccess && Boolean(api.publicationToken()),
        selectNamed: selectNamedReport, deleteNamed: deleteNamedReport,
        read: () => ({
            draftCatalog: namedDrafts.read(), namedReport,
            dates: effectiveReportDates(), nativeScope: usesBoundedReportView(reportBaseExplicit ? reportScope : "all"),
            timeContext: viewerTime, options: draft.options(),
            resumePreset: (activePreview && reportJourney.snapshot().hasPreview || reportRebuildFrom) ? reportPreset : null,
            explicitScope: reportBaseExplicit, scopeIssue: reportJourney.reason(2),
            hiddenCardIssue: hiddenReportBlock(reportBaseExplicit ? reportScope : "all"),
            prepared: assessmentFactories.reportWorkspacePresentation(workspaceState.route, reportJourney.snapshot()).prepared,
            saved: ["saved", "unavailable"].includes(reportJourney.snapshot().phase),
            paired: Boolean(periodReport), locked: exportWriting || reportJourney.snapshot().saveUnconfirmed,
            loading: workspaceState.loading || workspaceState.stale || reportPreparing,
            preparing: reportJourney.snapshot().phase === "scanning",
            unavailable: workspaceState.loading || workspaceState.stale,
            scopeLabel: namedReport ? namedReport.name : !reportBaseExplicit ? "All retained activity"
                : reportScope === "current" ? reportDatesReplaced ? "Based on Analyze filters" : "Current Analyze view"
                    : reportScope === "selected" ? "Selected interactions" : "All retained activity",
            services: categories.entries.filter(entry => !["Multiple workloads", "Platform metadata", "Unknown"].includes(entry.id)).map(entry => entry.id),
        }),
        choose: chooseReportPreset, changeDates: changeReportDates, closePreview: backToReports,
        openDeskActivity: () => {
            if (reportSelectionBlock() || reportBaseExplicit || reportScope === "all") return;
            reportScope = "all";
            acceptNativeReportScope();
            renderReports();
        },
        changeFocus: patch => {
            if (exportWriting || reportJourney.snapshot().saveUnconfirmed || !draft.options().reportFocus) return;
            invalidatePreview(undefined, { preserveFileView: true });
            draft.change({ reportFocus: { ...draft.options().reportFocus, preset: "custom", ...patch }, reportNotes: [], overrides: [] });
            updateSelection(); void previewExport();
        },
    });
    const savedTools = $("bundles").querySelector(".saved-library-tools");
    // Both presentations use the same panel and inventory; DOM order is also Tab order.
    $("reportCreatePanel").before($("reportSections"));
    $("reportCreatePanel").after($("savedReportsPanel"));
    for (const [id, role] of [["reportOverviewLink", "section-overview"], ["viewAllSavedReports", "report-files"]]) {
        const link = $(id);
        link.prepend(ux.icon(role));
        link.addEventListener("click", event => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            if (!savedListOwner?.current() || link.hasAttribute("aria-current")) return;
            navigate(linkTargets.get(link), false, { restorePosition: id === "reportOverviewLink" });
        });
    }
    const libraryOptions = button("", () => {}, "quiet");
    libraryOptions.id = "savedLibraryOptions";
    ux.utility(libraryOptions, "report-options", "Saved-report options");
    bindSavedMenu($("savedLibraryManagement"), libraryOptions, () => savedListOwner?.current() && workspaceState.route.task === "library");
    savedTools.append(libraryOptions);
    ux.tooltip($("exportBtn"), () => $("exportBtn").textContent);
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
                reportJourney.invalidateSavedReport(item.artifactId);
            }
            return load({ background: true });
        },
    });
    displayTimeSettings = mountDisplayTimeSettings({ time, onChange: () => { if (!exportWriting) load(); } });
    assessmentFactories.bindPageDefaults(pageDefaults, () => selectControls?.sync());
    const optionFinders = {
        trendsPairMeasure1: "Find a measure", trendsPairMeasure2: "Find a measure",
        displayTimeZone: "Find a city or time zone", toolFilter: "Find a tool", trendsTool: "Find a tool",
        projectFilter: "Find a project", chatFilter: "Find a chat", comparisonEndpoint: "Find a path or operation",
        serviceFilter: "Find a category", serviceAssociationFilter: "Find a service", comparisonServices: "Find a service",
        comparisonWithinServices: "Find a service", trendsService: "Find a service", reportService: "Find a service",
    };
    selectControls = createSelectControls(ux, {
        searchFields,
        finderFor: (select, count) => {
            if (!Object.hasOwn(optionFinders, select.id) || count < 10 && !select.id.startsWith("trendsPairMeasure")) return null;
            return select.id === "chatFilter" && workspaceState.scope?.layer === "http" ? "Find a recorder source" : optionFinders[select.id];
        },
        matchesOption: (query, label) => localSearch.matches(query, [label]),
        pagingFor: nativeInventoryPaging,
        onClose: select => {
            savedReportView?.updateViewingChoices?.(select);
            boundedNative.cancelInventory(nativeFilterDimensions[select.id]);
            queueMicrotask(refreshInventoryControls);
        },
        decorateOption: (node, { id, value, label }) => {
            if (id === "comparisonQuickChoice") {
                node.classList.add("comparison-preset-option");
                node.dataset.preset = value;
                const glyph = { all: "report-all", errors: "scope-issues", completed: results.icon("success"), mine: "author-user", agent: "author-agent" }[value];
                if (glyph) node.prepend(ux.icon(glyph));
                return;
            }
            if (id === "toolFilter" && label.includes("__")) {
                const text = document.createDocumentFragment();
                label.split("__").forEach((part, index) => {
                    if (index) text.append("__", el("wbr"));
                    text.append(part);
                });
                replacePrivateChoices(node, text);
                return;
            }
            if (["promptAuthorFilter", "reportPromptAuthorFilter"].includes(id)) {
                if (authorship.actors.includes(value)) {
                    node.dataset.promptActor = value;
                    node.classList.add("author-option-value");
                    replacePrivateChoices(node, ux.icon("author-" + value), el("span", "", label));
                }
                else delete node.dataset.promptActor;
                return;
            }
            if (id !== "outcomeFilter") return;
            node.classList.add("result-option-value");
            node.dataset.resultLayer = workspaceState.scope?.layer ?? "tool";
            replacePrivateChoices(node, el("span", "result-option-label", label));
            if (resultKeys.includes(value) && (workspaceState.scope?.layer !== "code-reference" || value === "unknown")) {
                const icon = el("span", `result-legend-icon result-tone-${value}`);
                icon.append(ux.icon(results.icon(value)));
                node.prepend(icon);
            }
        },
    });
    collectionSettings = mountCollectionSettings({
        api, ux, collectionStatus: historyStatus,
        sourceCollection,
        createNativeConfigurationState: assessmentFactories.createNativeConfigurationState,
        write: writeCollection,
        read: async () => {
            const publication = api.publicationToken();
            const status = await readCollectionStatus();
            if (!api.isCurrent(publication)) throw new Error("This collection read was retired when WIRE access changed.");
            renderCollection(status, publication); return status;
        },
        invalidate: () => { invalidatePreview(); invalidateDialog("Collection settings are changing. Prepare a fresh report preview."); },
        onDraftChange: changed => {
            retirePendingSaveMessage();
            $("settingsDraftNotice").hidden = workspaceState.route.view === "settings" || !changed;
            $("settingsDraftNotice").querySelector("a").href = $("sourceEditor").hidden ? "/settings?section=connection&setting=history-window" : "/settings?section=connection&setting=source";
            renderSettingsSearch();
            renderFreshActivity();
        },
    });
    sourceSettings = assessmentFactories.mountSourceCollectionSettings({
        api, ux, sourceCollection, collectionStatus: historyStatus,
        createNativeConfigurationState: assessmentFactories.createNativeConfigurationState,
        write: writeCollection,
        read: async () => {
            const publication = api.publicationToken(), status = await readCollectionStatus();
            if (!api.isCurrent(publication)) throw new Error("This collection read was retired when WIRE access changed.");
            renderCollection(status, publication); return status;
        },
        collect: event => checkActivity(event, "microsoft"),
        needsStoredRead: refreshUsesStoredRecovery,
        onDraftChange: changed => {
            $("settingsDraftNotice").hidden = workspaceState.route.view === "settings" || !(changed || githubHasDraft());
            if (changed) $("settingsDraftNotice").querySelector("a").href = "/settings?section=connection&setting=microsoft-collection";
            renderFreshActivity();
        },
    });
    const githubHasDraft = collectionSettings.hasDraft;
    collectionSettings.hasDraft = () => githubHasDraft() || sourceSettings.hasDraft();
    firstConnection = assessmentFactories.mountFirstConnection({ api, ux, reviewSource: reviewFirstConnection, collectionStatus: historyStatus });
    const privateContentIds = [
        "activityList", "activityListSummary", "activityListScope", "activityPager", "analyzeUsageContent", "costRateReference", "sessionAnalysis", "homeInsights", "homeFindings",
        "requestContent", "contextSidebarFooter", "contextSidebarTitle", "savedReportReader", "bundleList", "savedReportCount",
        "detail", "reportList", "reportReviewBody", "reportSaveBody", "reportMatchingContext", "scopeExclusions",
        "pageTitle", "pageIdentity", "pageIntro", "pageProject", "breadcrumbs", "viewingContext", "serviceEvidenceSummary",
        "contextReturn", "filterChips", "serviceFocusScope", "resultFilterScope", "promptAuthorFilterHelp",
        "activitySelectionSummary", "activitySelectionScope", "periodResult", "periodLabel", "meaningMatched", "meaningSources", "meaningBody",
        "takeaway", "chart", "chartTitle", "chartDataTitle", "chartFooter", "chartReadingNotes", "countTable", "serviceDefinitions", "coverageBody", "activityCoverageGap",
        "collectionEvidenceDetails", "collectionIssueGroups", "collectionIssuesMessage", "collectionDiagnostics",
        "collectionStatus", "collectionStatusGuidance", "collectionChecked", "collectionNewActivity", "collectionIssueCounts",
        "collectionIssueImpact", "collectionExactCheck", "collectionExactNew", "collectionExactTimes", "collectionCoverageCounts",
        "collectionCoveragePending", "collectionNoticeText", "settingsDiagnosticError", "settingsSearchResults", "settingsSearchCount",
        "wireAnalysisSearchNotice", "freshCoverageDetails", "freshContextMessage", "freshStatus", "freshCheckDetails", "analyzeRefreshStatus",
        "freshCoverageAnnouncement", "freshChecked", "freshAwayStatus", "freshIssues",
        "recollectionUpdateStatus", "newDataNotice",
    ];
    function accessOwners() {
        return [...(frontendActivity ? [frontendActivity] : []), firstConnection, liveSearchUI, chartReferenceUI, periodComparisonUI, trendsUI, analyzeControls, percentages, nativeActivity, boundedNative, assessmentUI,
            draft, reportJourney, reportExperience, reportSaveWarning, deletionUI, recollectionUI, savedArtifactUI, collectionSettings, sourceSettings, recorderUI,
            ...(accountProfile ? [accountProfile] : []), ...(microsoftProfile ? [microsoftProfile] : []), ...(accountUI ? [accountUI] : [])];
    }
    function withdrawPrivateContent() {
        hiddenCards.bind(null); undoCard = null; closeHiddenDialog(); $("cardVisibilityActions")?.remove();
        homepage.leave();
        analyzeDatesPicker.close(false); analyzeDatesPicker.showRange("");
        analyzeCalendar.clear();
        namedDrafts.withdrawAccess(); namedReport = null;
        trendPeriodVisit = null; periodBackToTrends.hidden = true;
        appUpdate?.beforeOwnerRetirement();
        const privateNarrowing = Boolean(search.trim() || semanticQuery !== null || incomingNavigation || new URLSearchParams(location.search).has("privateView")
            || workspaceState.route && Object.keys(paths.project(workspaceState.route, publicField).privateFields).some(key => paths.isScope(key) || key === "trendEntry"));
        clearingAccess = true;
        retireSavedList();
        forgetReading(reportLandingOrigin?.reading); reportLandingOrigin = null; reportPreset = null;
        clearTimeout(reportUpdateTimer); reportRebuildFrom = null; reportUpdateAgain = saveAfterMask = false;
        reportPreparing = false; reportPreparationOwner = null;
        pendingReportReading = null;
        reportBaseExplicit = reportDatesReplaced = false;
        initialReportChoices = { ...initialReportChoices, range: "7" };
        reportDates = { range: "7", ...time.preset("7", viewerTime.timeZone) };
        reportPickerEvents?.abort(); reportPickerEvents = null;
        nativePublication.withdraw(); clearTimeout(nativePreviewExpiryTimer); syncNativeSaveAvailability = null;
        nativeAnalysisState = null; nativeAnalysisRender++;
        pendingInventoryUpdates.clear();
        sourceCollection.withdraw();
        workspaceState.retire(); collectionReadGeneration++;
        clearTimeout(pollTimer);
        $("workspace").hidden = true;
        contextSidebar.hidden = true;
        for (const dialog of document.querySelectorAll("dialog:not(#navigationDrawer,#appUpdateFence)")) dialog.style.visibility = "hidden";
        if (contextOwner?.identity === "report-setup" && contextOwner.footer) $("contextSidebarParking").append(contextOwner.footer);
        const roots = [...privateContentIds.map($), savedInspector?.body, savedInspector?.footer].filter(Boolean);
        const privateSelects = ["sourceFilter", "projectFilter", "chatFilter", "toolFilter", "serviceFilter", "serviceAssociationFilter", "outcomeFilter"].map($);
        const options = privateSelects.flatMap(select => [...select.querySelectorAll("option,optgroup")]);
        const reusable = new Set([...roots, homeCount, homeUnit]);
        const textNodes = [], attributes = [], fields = [];
        // Keep handles until every owner has retired, including nodes they detach during teardown.
        for (const node of new Set([...roots.flatMap(root => [root, ...root.querySelectorAll("*")]), ...options])) {
            textNodes.push(...[...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE));
            attributes.push(...[...node.attributes].filter(attribute => !reusable.has(node)
                || attribute.name.startsWith("data-")
                || ["title", "alt", "aria-label", "aria-description", "href", "src", "srcdoc", "value", "placeholder", "label"].includes(attribute.name)));
            if (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(node.tagName)) fields.push(node);
        }
        ux.withdrawAccess(roots);
        ux.hideTooltip();
        const selection = window.getSelection();
        if (selection && roots.some(root => root.contains(selection.anchorNode) || root.contains(selection.focusNode))) selection.removeAllRanges();
        returnFocus = null; cancelSidebarReading?.(); cancelSidebarReading = null;
        endReaderResize();
        readerWidth = null; readerExpanded = false; sidebarTextAnchor = null;
        document.body.removeAttribute("data-reader-expanded");
        document.body.style.removeProperty("--context-sidebar-width");
        document.body.style.removeProperty("--context-anchor-height");
        $("main").inert = false;
        sidebarAnimationFinish = null;
        if (sidebarAnimation) sidebarAnimation.onfinish = null;
        sidebarAnimation?.cancel(); sidebarColumnAnimation?.cancel();
        cancelAnimationFrame(sidebarColumnFrame);
        sidebarColumnFrame = null;
        sidebarAnimation = sidebarColumnAnimation = sidebarColumnAnchor = null;
        sidebarIdentity = sidebarOrigin = sidebarReadingFocus = contextOwner = cardEntry = reportPickerOrigin = null;
        sidebarExit = null; requestRenderKey = null; requestInvalidated = true;
        for (const node of document.querySelectorAll("iframe")) { node.removeAttribute("src"); node.srcdoc = ""; node.title = ""; node.remove(); }
        clearReaderSections();
        releaseCardPreviews(document);
        for (const node of document.querySelectorAll(".full-text")) textAccess.release(node);
        clearPreparedReaders();
        clearPreviewPayload?.();
        clearSavedReader();
        clearOriginalRead(savedInspector);
        savedInspector?.body.remove(); savedInspector?.footer.remove();
        for (const chart of document.querySelectorAll(".dimensional-scroll")) dimensional.disposeView(chart);
        for (const url of privateObjectUrls) URL.revokeObjectURL(url);
        privateObjectUrls.clear();
        for (const key of privateNavigations.keys()) forgetPrivateNavigation(key);
        for (const saved of workspaceState.positions.values()) forgetReading(saved);
        forgetReading(chartReferenceOrigin);
        forgetReading(pendingChartReferenceReading?.position);
        forgetReading(periodReturnReading?.position);
        for (const saved of sidebarPositions.values()) for (const key of Object.keys(saved)) delete saved[key];
        for (const entry of savedEntries.values()) {
            forgetReading(entry.reading);
            for (const key of Object.keys(entry)) delete entry[key];
        }
        workspaceState.positions.clear(); sidebarPositions.clear(); savedEntries.clear(); issueAttempts.clear();
        presentation.withdrawAccess();
        selected.clear();
        workspaceState.clear(); slice = undefined;
        collection = issueRows = issuesStatus = undefined;
        issuesSignature = settingsSearchSignature = undefined;
        issuesLoading = false; collectionReadError = collectionReadReason = "";
        workspaceState.loading = false; workspaceState.stale = true; connectionNeedsSnapshot = true;
        collectionBusy = false;
        activePreview = pendingSaveOwner = pendingSaveResult = periodReport = reportEntry = contextReturnKey = savedInspector = reportSetupReturn = periodReturnReading = null;
        exportWriting = false;
        chartReferenceAccepted = chartReferenceInput = chartReferenceOrigin = pendingChartReferenceReading = null;
        chartReferenceKeys.clear(); chartReferenceRevision = null; chartReferenceVersion++;
        chartReferenceSourceCoverage = ""; coverageDetailsKey = undefined;
        renderedContextBundles.clear();
        semanticMembership = undefined; semanticQuery = null; semanticComplete = semanticBound = false; semanticStatus = "stale";
        browseStates.clear();
        analyzeTrends.leave();
        trendEntries.clear();
        analysisNavigations.clear();
        historyViews.clear();
        linkTargets = new WeakMap();
        initialRoute = null;
        initialHistory = null;
        searchOpenedRequest = searchReturnMarker = null; searchTargetInvalid = true;
        incomingNavigation = null;
        if (privateNarrowing) incomingNavigationError = "The earlier private selection was cleared when WIRE access changed. Search again or explicitly open this view without that selection.";
        search = ""; searchReturnMarker = null;
        refreshReadFailure = deferredReviewIdentity = null;
        deferredDataNotice = false;
        withdrawRefreshGesture();
        fresh = createFreshActivity({ sourceUnknown: sourcePending, sourceWarning: sourceStorageWarning, nativeStatus: receiptStatus });
        if (nativeCollectIntent?.confirmed) nativeCollectIntent = null;
        else if (nativeCollectIntent) {
            fresh.restoreNative(nativeCollectIntent.operationId);
        }
        for (const select of privateSelects) {
            select.replaceChildren();
            delete select.dataset.optionsSignature; delete select.dataset.pendingValue;
        }
        $("outcomeFilter").dataset.allLabel = "All results";
        for (const id of ["homeView", "activityView", "resultSummary", "promptAuthorSummary", "freshActivity", "freshCoverageDetails"]) {
            for (const name of ["data-revision", "data-check-id", "data-check-key"]) $(id)?.removeAttribute(name);
        }
        for (const link of document.querySelectorAll("[data-nav]")) link.href = link.dataset.nav === "analyze" ? "/" : "/" + link.dataset.nav;
        $("pageAction").href = "/reports?task=create";
        $("reportContextAction").href = "/";
        for (const id of ["activitySearch", "settingsSearch", "savedReportSearch", "reportRequestSearch", "issueSearch",
            "reportTitle", "manualTerms", "sourceDatabase", "sourceSessions"]) {
            if ($(id)) { $(id).value = ""; $(id).removeAttribute("value"); }
        }
        const failures = [];
        for (const owner of accessOwners()) {
            try {
                if (typeof owner?.withdrawAccess !== "function") throw new Error("A private-content owner does not support access withdrawal.");
                owner.withdrawAccess();
            } catch (error) { failures.push(error); }
        }
        for (const node of textNodes) node.data = "";
        for (const attribute of attributes) eraseRetiredAttribute(attribute);
        for (const field of fields) {
            field.value = "";
            if ("checked" in field) field.checked = false;
            if ("selected" in field) field.selected = false;
        }
        for (const root of roots) {
            if (frontendActivity && ["activityList", "activityPager"].includes(root.id)) continue;
            root.replaceChildren();
            for (const name of ["title", "aria-label", "data-revision", "data-view-key", "data-recorded-context"]) root.removeAttribute(name);
        }
        homeCount.textContent = homeUnit.textContent = "";
        $("savedLibraryTitle").textContent = "Saved reports";
        for (const dialog of document.querySelectorAll("dialog:not(#navigationDrawer,#appUpdateFence)")) if (dialog.open) dialog.close();
        document.body.removeAttribute("data-context-docked");
        selectControls?.withdrawAccess();
        syncSaveLocks();
        workspaceState.route = readRoute(currentAddress(), null);
        clearingAccess = false;
        if (failures.length) throw new AggregateError(failures, "Private-content clearance is incomplete. Reload before reading activity.");
    }
    function showAccessUnavailable(value) {
        $("workspace").hidden = true;
        $("workspace").setAttribute("aria-busy", "false");
        $("analyzeTools").hidden = true;
        $("analyzeToolbar").hidden = true;
        document.body.classList.remove("analyze-reading");
        $("loading").hidden = true;
        $("accessShell").hidden = false;
        const active = compareDestination(workspaceState.route) ? "compare" : workspaceState.route.view === "request" ? "analyze" : workspaceState.route.view === "collection-status" ? "settings" : workspaceState.route.view;
        workspaceState.present({ active, view: workspaceState.route.view });
        const title = { analyze: "Analyze", compare: "Compare", settings: "Settings", reports: "Reports", trends: "Trends", help: "WIRE Help" }[active] || "Analyze";
        setText($("accessPageTitle"), title);
        document.title = title + " | WIRE";
        $("accessSettings").hidden = active === "settings";
        $("accessAccount").disabled = value.mode !== "enforced";
        $("accessRetry").hidden = !["freshness-expired", "watch-timeout", "watch-unavailable", "connection-unavailable", "invalid-bootstrap"].includes(value.reason);
        for (const node of document.querySelectorAll("[data-nav]")) {
            node.href = node.dataset.nav === "analyze" ? "/" : "/" + node.dataset.nav;
            if (node.dataset.nav === active) node.setAttribute("aria-current", "page");
            else node.removeAttribute("aria-current");
        }
        const connectionFeedback = accountUI?.unavailableConnectionFeedback() || "";
        const awaitingUpdate = value.reason === "connection-unavailable" && value.state?.wire !== "signed-out" && appUpdate?.locked();
        if (awaitingUpdate) appUpdate.reconnecting();
        $("message").textContent = value.state?.wire === "signed-out"
            ? "WIRE is signed out. Collection is stopped and saved activity is hidden. Use WIRE account to sign in."
            : value.reason === "connection-unavailable"
                ? [awaitingUpdate ? "Waiting for WIRE to reconnect." : "WIRE is not responding.", connectionFeedback, "Saved activity is hidden until access can be checked."].filter(Boolean).join(" ")
                : [connectionFeedback, "Checking WIRE access before showing saved activity."].filter(Boolean).join(" ");
        $("message").hidden = false;
        $("message").setAttribute("role", "status");
        const { evidenceView, wireSearchReturn, wirePrivateNavigation, wireAccess, ...safe } = history.state || {};
        history.replaceState(safe, "");
    }
    function navigateAccessShell(view) {
        if (!["analyze", "compare", "reports", "settings", "trends", "help"].includes(view) || clearingAccess) return;
        sidebar.close(false);
        initialRoute = null;
        initialHistory = null;
        const url = view === "analyze" ? "/" : "/" + view;
        if (api.publicationToken()) return navigate(Object.hasOwn(browseDefaults, view) ? freshBrowseRoute(view) : readRoute(url, null));
        pendingFreshBrowse = true;
        history.pushState({}, "", url);
        workspaceState.route = readRoute(url, null);
        showAccessUnavailable(api.accessState());
    }
    $("accessSettings").addEventListener("click", event => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateAccessShell("settings");
    });
    $("accessAccount").addEventListener("click", () => {
        const trigger = $("wireAccountTrigger");
        if (trigger && !$("wireAccountEntry").hidden) {
            if (!trigger.checkVisibility()) $("navigationToggle").click();
            trigger.click();
        }
    });
    $("accessRetry").addEventListener("click", () => api.startAccess());
    function showConnectionSettings(value) {
        if (workspaceState.route.view !== "settings" || !["connection", "source-access"].includes(settingsNavigation.resolve(workspaceState.route).section)
            || value.mode !== "enforced" || value.state?.wire !== "signed-in"
            || !value.readable && value.reason !== "generation-changed") return false;
        for (const id of ["homeView", "activityView", "requestView", "reportsView", "wireHelpView", "collectionStatusView",
            "filters", "appliedFilters", "filterChips", "coverageNotice", "pagePrimaryActions",
            "pageIntro", "pageIdentity", "pageProject", "analyzeTools", "analyzeToolbar"]) $(id).hidden = true;
        $("settingsView").hidden = false;
        setText($("pageTitle"), "Settings");
        const home = el("a", "", "Analyze");
        home.href = "/";
        $("breadcrumbs").replaceChildren(home, document.createTextNode(" / Settings"));
        renderSettingsNavigation();
        const latest = api.accessState();
        if (latest.epoch !== value.epoch || latest.reason !== value.reason || latest.readable !== value.readable) return false;
        $("loading").hidden = true;
        $("accessShell").hidden = true;
        $("workspace").hidden = false;
        return true;
    }
    let connectedSettingsReady = false, firstConnectionReadPending = false;
    api.subscribeAccess(value => {
        const ready = sourceCollection.active && value.readable && value.state?.microsoft?.state === "connected"
            && value.state.microsoft.actions.includes("microsoft-connect");
        const firstConnectionReady = ready && !connectedSettingsReady;
        connectedSettingsReady = ready;
        if (!ready) firstConnectionReadPending = false;
        else if (firstConnectionReady) firstConnectionReadPending = true;
        if (value.mode === "enforced" && !accountUI) {
            accountUI = assessmentFactories.mountAccountSettings({ api, ux, accountSlot: $("wireAccountEntry"),
                connectionSlot: $("microsoftConnectionHost"), refreshProfile: () => accountProfile?.refresh(),
                refreshMicrosoftProfile: () => microsoftProfile?.refresh(),
                placeMicrosoftCollection: container => sourceSettings.placeInConnection(container),
                onConnectionChange: () => {
                    const current = api.accessState();
                    if (!current.readable && current.reason !== "clearance-failed" && !$("accessShell").hidden) showAccessUnavailable(current);
                } });
            accountProfile = assessmentFactories.createAccountProfile({
                api, visible: () => !document.hidden && !pageInactive,
                present: (github, token) => accountUI.receive({ github, lifecycle: null }, token),
            });
            microsoftProfile = sourceCollection.copilotOnly ? null : assessmentFactories.createAccountProfile({
                api, provider: "microsoft", visible: () => !document.hidden && !pageInactive,
                present: (profile, token) => accountUI.receiveMicrosoft(profile, token),
            });
        }
        if (!value.readable) {
            accountProfile?.withdrawAccess();
            microsoftProfile?.withdrawAccess();
            const wasReadable = accessToken !== null;
            accessToken = null;
            const currentScope = wasReadable && history.state?.evidenceView?.viewScope
                && paths.project(workspaceState.route, publicField).viewScope;
            showAccessUnavailable(value);
            if (wasReadable) {
                try {
                    withdrawPrivateContent();
                    if (currentScope && !incomingNavigationError) initialRoute = { url: currentAddress(), value: currentScope };
                }
                catch (error) {
                    $("message").textContent = error.message;
                    $("message").setAttribute("role", "alert");
                    throw error;
                }
            }
            accountUI?.receiveAccess(value);
            if (showConnectionSettings(value)) clearMessage();
            return;
        }
        accountUI?.receiveAccess(value);
        void accountProfile?.receiveAccess();
        void microsoftProfile?.receiveAccess();
        collectionSettings?.receiveAccess?.();
        sourceSettings?.receiveAccess();
        savedArtifactUI?.observeEligibility();
        const current = api.publicationToken();
        if (accessToken === current) {
            if (workspaceState.evidence && workspaceState.evidence.nativeRead?.reason !== "microsoft-account-not-configured") firstConnectionReadPending = false;
            if (firstConnectionReadPending
                && !pageInactive && !document.hidden && !exportWriting && !collectionBusy
                && !collectionSettings?.isBusy() && !sourceSettings?.isBusy() && !collectionSettings?.hasDraft()
                && !activePreview && !reportJourney?.isReviewOpen() && !$("overlay").open
                && !deletionUI?.isOpen() && !recollectionUI?.isOpen()) {
                firstConnectionReadPending = false;
                void load({ background: Boolean(workspaceState.analytics) });
            }
            return;
        }
        if (value.mode === "unbound" && accessToken) { accessToken = current; return; }
        accessToken = current;
        if (value.mode !== "unbound") {
            for (const owner of accessOwners()) owner?.resumeAccess?.();
            for (const dialog of document.querySelectorAll("dialog:not(#navigationDrawer)")) dialog.style.removeProperty("visibility");
        }
        claimIncomingNavigation();
        workspaceState.route = readRoute();
        const freshPage = pendingFreshBrowse && browseName(workspaceState.route);
        if (freshPage && workspaceState.route.view !== "request") workspaceState.route = freshBrowseRoute(freshPage, displayTimeSettings.resolve());
        pendingFreshBrowse = false;
        search = workspaceState.route.search || "";
        initialHistory = null;
        initialRoute = null;
        syncControls();
        rememberRoute(workspaceState.route, true);
        const firstSettingsRead = !mounted, connectionSettings = showConnectionSettings(value);
        if (connectionSettings) clearMessage();
        firstConnectionReadPending = false;
        load().then(ok => {
            if (!ok || !api.isCurrent(current)) return;
            if (workspaceState.route.view === "settings" && (firstSettingsRead || !connectionSettings)) revealSetting();
            else if (workspaceState.route.view === "collection-status") revealCollectionStatus();
        });
        pollTimer = setTimeout(pollCollection, 250);
    });
    api.startAccess();
    const formatChecked = value => time.formatMoment(new Date(value).toISOString(), viewerTime);
    appUpdate = assessmentFactories.mountAppUpdate?.({ capability, formatChecked, blocked() {
        const report = reportJourney?.snapshot();
        if (collectionSettings?.hasDraft() || sourceSettings?.hasDraft() || assessmentUI?.hasUnfinishedChange()) {
            return { kind: "settings", message: "Save or cancel your Settings changes and resolve any unconfirmed changes before updating." };
        }
        if (exportWriting || pendingSaveOwner || reportPreparing || report?.saveUnconfirmed || report?.phase === "scanning"
            || !report?.completed && (report?.hasPreview || hasReportDraftChoices())) {
            return { kind: "report", message: "Finish or discard your report draft and resolve any unconfirmed save before updating." };
        }
        const reread = recollectionUI?.snapshot(), refresh = fresh.snapshot();
        if (collectionSettings?.isBusy() || sourceSettings?.isBusy() || collectionSettings?.hasUnconfirmedChange()
            || sourceSettings?.hasUnconfirmedChange() || accountUI?.hasUnfinishedChange() || savedArtifactUI?.hasUnfinishedChange()
            || recorderUI?.hasUnfinishedChange() || deletionUI?.hasUnfinishedChange() || reread?.busy || reread?.needsReceipt || reread?.hasReceipt
            || nativeCollectIntent || sourcePending || githubRecoveryPending || refresh.sourceUnknown || refresh.sourceBlocked || artifactRefreshRequired || collection?.assessment?.pendingCleanup
            || refreshWorking() || fresh.busy() || workspaceState.loading || collectionBusy) {
            return { kind: "operation", message: "Finish the current operation or check its original result before updating." };
        }
        if (workspaceState.dateDraft || document.querySelector("dialog[open]:not(#appUpdateFence),.select-popup:not([hidden])")) {
            return { kind: "operation", message: "Finish the open edit or dialog before updating." };
        }
        return null;
    } });
}
