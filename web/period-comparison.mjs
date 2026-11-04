// Serialized with the shell. Private text is used only to select the accepted roster.
export function createPeriodComparisonState({ time, search, contract, projection, categories, comparePeriodCohorts, validateNativePeriods, searchContract, resultContract }) {
    if (typeof comparePeriodCohorts !== "function") throw new TypeError("The shared comparison derivation is required.");
    let generation = 0, pending = null, accepted = null;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && same([...a].sort(), [...b].sort());
    const orderedRows = rows => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const require = condition => { if (!condition) throw new Error("Comparison facts do not match the accepted revision, definitions or exact membership. Read the current Analyze view."); };
    function semanticScope(value, revision) {
        const receipt = value?.receipt;
        require(value?.status === "ready" && value.coverage === "whole-retained-corpus"
            && searchContract?.analysisReceipt(receipt) && receipt.revision === revision
            && ["scenarioIds", "actionIds", "parentScenarioIds"].every(key => Array.isArray(value[key])
                && value[key].every(id => typeof id === "string" && id.length) && new Set(value[key]).size === value[key].length));
        return { scenarioIds: [...value.scenarioIds], actionIds: [...value.actionIds], parentScenarioIds: [...value.parentScenarioIds] };
    }
    function validateNarrowing(ids, scenarios) {
        require(ids === undefined || Array.isArray(ids) && new Set(ids).size === ids.length
            && ids.every(id => typeof id === "string" && scenarios.some(record => record.scenarioId === id)));
    }
    function prepare(snapshot, options, periods, query = "", withinServices = [], semanticSearch, nativeView = snapshot?.nativeRead) {
        if (!Array.isArray(snapshot?.scenarios)) throw new Error("The complete retained interaction roster is unavailable.");
        const sources = new Map((snapshot.sessions ?? []).map(source => [source.sessionId, source]));
        if (semanticSearch !== undefined) {
            semanticScope(semanticSearch, snapshot.revision);
            validateNarrowing(semanticSearch.withinScenarioIds, snapshot.scenarios);
            require(!query.trim() || semanticSearch.withinScenarioIds !== undefined);
        }
        const scenarioIds = semanticSearch === undefined ? snapshot.scenarios.filter(record => {
            const source = sources.get(record.sourceSessionId);
            return !query.trim() || search.phrase(query, [record.userPrompt?.text, record.title, source?.project, source?.name,
                record.project, record.sourceSessionName, record.sourceSessionId]);
        }).map(record => record.scenarioId).sort() : null;
        for (const range of Object.values(periods)) {
            time.calendar(range.from); time.calendar(range.to); time.range(range, options.timeContext.timeZone);
        }
        const { from, to, ...filters } = options.filters;
        const includeNative = snapshot.nativeRead?.status === "bounded"
            && (!filters.sources?.length || filters.sources.some(source => source.startsWith("microsoft-")));
        const refined = includeNative && Boolean(nativeView?.textSelection || nativeView?.groupId);
        if (includeNative && (!nativeView || query.trim() || semanticSearch !== undefined && !refined)) {
            throw new Error("Read the complete Microsoft Search view and clear any additional local text refinement before comparing periods.");
        }
        if (includeNative && (snapshot.nativeGroupBinding || snapshot.nativeRead.groupId) && !nativeView?.groupId) {
            throw new Error("The original Microsoft group receipt is unavailable. Read its current view.");
        }
        const nativeViewId = refined ? nativeView.viewId : nativeView?.allViewId;
        if (includeNative && !/^[a-f0-9]{64}$/.test(nativeViewId ?? "")) {
            throw new Error("Read the complete Microsoft source view before comparing periods.");
        }
        return { schemaVersion: 1, expectedRevision: snapshot.revision, options: { ...options, filters },
            ...(includeNative ? { nativeViewId, ...(refined ? { nativeViewKind: "current" } : {}) } : {}),
            periods: structuredClone(periods), ...(semanticSearch === undefined ? { scenarioIds } : { semanticSelection: {
                receipt: structuredClone(semanticSearch.receipt),
                ...(semanticSearch.withinScenarioIds === undefined ? {} : { withinScenarioIds: [...semanticSearch.withinScenarioIds] }),
            } }), withinServices: [...withinServices] };
    }
    function begin(input, snapshot, semanticSearch, hasSearch = false) {
        accepted = null;
        require(Array.isArray(snapshot.assessment?.catalog) && typeof hasSearch === "boolean");
        const filters = input.options.filters;
        pending = { token: ++generation, input: structuredClone(input),
            basis: structuredClone(snapshot.assessment.basis), source: structuredClone(snapshot.assessment.source),
            catalog: structuredClone(snapshot.assessment.catalog), unit: snapshot.analytics.unit,
            scenarios: structuredClone(snapshot.scenarios),
            scope: {
                hasSearch: hasSearch || input.semanticSelection !== undefined,
                projects: (filters.projectIds ?? []).filter(id => id !== null).map(id => ({
                    id, name: snapshot.scenarios.find(record => record.projectId === id)?.project || null,
                })),
                sessions: (filters.sourceSessionIds ?? []).map(id => ({
                    id, name: snapshot.sessions?.find(source => source.sessionId === id)?.name
                        || snapshot.scenarios.find(record => record.sourceSessionId === id)?.sourceSessionName || null,
                })),
            },
            semanticMembership: input.semanticSelection ? semanticScope(semanticSearch, snapshot.revision) : null };
        if (input.semanticSelection) {
            validateNarrowing(input.semanticSelection.withinScenarioIds, snapshot.scenarios);
            require(searchContract.sameReceipt(input.semanticSelection.receipt, semanticSearch.receipt)
                && same(input.semanticSelection.withinScenarioIds, semanticSearch.withinScenarioIds));
        }
        return generation;
    }
    function accept(token, value) {
        if (pending?.token !== token) return false;
        accepted = null;
        const { input, basis, source, catalog, unit, scenarios, semanticMembership } = pending;
        const datedLegacyUnit = ({
            "source-qualified tool calls": "Work IQ tool calls",
            "source-qualified returned-result observations": "reported API result units",
        })[unit];
        const supportedUnits = {
            tool: ["Work IQ tool calls", "source-qualified tool calls"],
            "reported-api": ["reported API result units", "source-qualified returned-result observations"],
            http: ["direct HTTP records"], "direct-request": ["recorded Graph request sites"],
            "recorded-http": ["recorded Graph request sites"], "code-reference": ["Graph code references"],
        };
        const nativeDatesExcluded = typeof datedLegacyUnit === "string" && datedLegacyUnit === value?.definitions?.unit
            && ["baseline", "later"].every(side => value.periods?.[side]?.analytics?.measurementEligibility?.nativeActivityDates === "unqualified"
                && Array.isArray(value.periods[side].analytics.rows)
                && value.periods[side].analytics.rows.every(row => !row.countUnit?.startsWith("native-")));
        require(value?.kind === "retained-period-comparison" && value.schemaVersion === 1 && value.revision === input.expectedRevision
            && same(value.assessmentBasis, basis) && same(value.source, source)
            && same(value.timeContext, time.normalize(input.options.timeContext))
            && same(value.options, input.options) && same(value.selection, { ...(semanticMembership ? { semanticMembership,
                ...(input.semanticSelection.withinScenarioIds === undefined ? {} : { withinScenarioIds: input.semanticSelection.withinScenarioIds }) }
                : { scenarioIds: input.scenarioIds }), withinServices: input.withinServices })
            && value.definitions?.activitySchemaVersion === 2 && value.definitions.layer === (input.options.layer ?? "tool")
            && supportedUnits[value.definitions.layer]?.includes(value.definitions.unit)
            && (value.definitions.unit === unit || nativeDatesExcluded)
            && value.definitions.metricProjectionVersion === contract.METRIC_PROJECTION_VERSION
            && same(value.definitions.serviceInvolvement, categories.involvementDefinition));
        contract.validateBasis(value.assessmentBasis);
        for (const key of ["baseline", "later"]) {
            const side = value.periods?.[key], analytics = side?.analytics;
            require(side && analytics && same(side.range, input.periods[key])
                && same(side.dateRange, time.range(side.range, value.timeContext.timeZone))
                && same(side.dateRange, analytics.dateRange)
                && same(analytics.timeContext, value.timeContext) && analytics.revision === value.revision
                && analytics.schemaVersion === value.definitions.activitySchemaVersion
                && analytics.groupBy === (input.options.groupBy ?? "workload")
                && analytics.layer === value.definitions.layer && analytics.unit === value.definitions.unit
                && Array.isArray(analytics.rows)
                && sameIds(side.interactionRefs, side.assessment?.interactionRefs)
                && new Set(side.interactionRefs).size === side.interactionRefs.length
                && Array.isArray(side.interactionCoverage));
            const filters = { ...input.options.filters, ...side.dateRange };
            const validRows = (rows, scope) => Array.isArray(rows) && new Set(rows.map(row => row?.id)).size === rows.length
                && rows.every(row => row && typeof row.id === "string" && row.id.length > 0
                    && typeof row.scenarioId === "string" && (semanticMembership
                        ? semanticMembership.scenarioIds.includes(row.scenarioId) || semanticMembership.actionIds.includes(row.id)
                        : input.scenarioIds.includes(row.scenarioId))
                    && (input.semanticSelection?.withinScenarioIds === undefined || input.semanticSelection.withinScenarioIds.includes(row.scenarioId))
                    && (row.sourceSessionId === null || typeof row.sourceSessionId === "string")
                    && (row.projectId === null || typeof row.projectId === "string")
                    && typeof row.tool === "string" && row.tool.length > 0 && typeof row.scope === "string" && row.scope.length > 0
                    && typeof row.workload === "string" && ["user", "agent", "unknown"].includes(row.promptAuthor)
                    && typeof row.endpoint?.id === "string" && typeof row.endpoint.label === "string"
                    && Array.isArray(row.serviceAssociation?.services) && row.serviceAssociation.services.every(service => typeof service === "string")
                    && Array.isArray(row.serviceAssociation.gaps)
                    && (row.durationMs === null || Number.isFinite(row.durationMs) && row.durationMs >= 0)
                    && typeof row.startedAt === "string" && Number.isFinite(Date.parse(row.startedAt))
                    && projection.selected(row, scope)
                    && input.withinServices.every(service => row.serviceAssociation.services.includes(service)));
            const facet = analytics.resultFacet;
            require(validRows(analytics.rows, filters) && sameIds(side.rowIds, analytics.rows.map(row => row.id))
                && new Set(side.rowIds).size === side.rowIds.length
                && sameIds(side.scenarioIds, [...new Set(analytics.rows.map(row => row.scenarioId))])
                && facet?.scope === "before-outcome"
                && validRows(facet.rows, { ...filters, outcomes: undefined })
                && same(facet.totals, projection.summarize(facet.rows))
                && same(orderedRows(analytics.rows), orderedRows(facet.rows.filter(row => projection.selected(row, filters)))));
            const projected = projection.project(analytics.rows, {
                groupBy: input.options.groupBy ?? "workload", limit: input.options.limit ?? 10, bucket: input.options.bucket ?? "day",
                filters: { ...input.options.filters, ...side.range }, timeContext: value.timeContext, dateRange: side.dateRange,
            }, scenarios);
            require(Object.entries(projected).every(([field, expected]) => same(analytics[field], expected)));
            if (semanticMembership && analytics.apiCoverage) {
                const parents = new Set([...semanticMembership.scenarioIds, ...semanticMembership.parentScenarioIds]);
                require(Array.isArray(analytics.apiCoverage.calls) && analytics.apiCoverage.calls.every(call => parents.has(call.scenarioId)
                    && (input.semanticSelection.withinScenarioIds === undefined || input.semanticSelection.withinScenarioIds.includes(call.scenarioId)))
                    && same(analytics.apiCoverage, projection.apiCoverage(analytics.apiCoverage.calls, analytics.rows)));
            }
            const associations = side.scenarioIds.map(id => catalog.find(item => item.scenarioId === id));
            const refs = [...new Set(associations.filter(item => item?.status === "retained" && item.interactionRef).map(item => item.interactionRef))];
            require(sameIds(side.interactionRefs, refs) && sameIds(side.unmappedScenarioIds, side.scenarioIds.filter((id, index) =>
                !associations[index]?.interactionRef || associations[index].status !== "retained"))
                && same(side.reviewStatusRevisions, associations.filter(item => item?.interactionRef).map(item => ({
                    scenarioId: item.scenarioId, interactionRef: item.interactionRef, revision: item.reviewStatusRevision ?? null,
                }))));
            side.assessment.metrics.forEach(contract.validateMetric);
            const coverage = side.assessment.metrics.map(metric => ({
                metricRef: metric.metricRef, slot: contract.metricSlotKey(metric),
                eligibleUnitRefs: metric.eligibleUnitRefs, coveredUnitRefs: metric.coveredUnitRefs,
            }));
            require(same(coverage, side.interactionCoverage) && new Set(coverage.map(item => item.slot)).size === coverage.length
                && side.assessment.metrics.every(metric => same(metric.basis, basis)));
            contract.validateAssessmentAttempts(side.assessment.assessmentAttempts);
            require(side.assessment.assessmentAttempts.every(item => side.interactionRefs.includes(item.interactionRef))
                && sameIds(side.assessment.reviewStatuses.map(item => item.interactionRef),
                    [...new Set(side.reviewStatusRevisions.filter(item => item.revision !== null).map(item => item.interactionRef))]));
            for (const item of side.assessment.reviewStatuses) {
                require(side.interactionRefs.includes(item.interactionRef));
                contract.validateReviewStatus(item.reviewStatus);
            }
        }
        require(same(value.comparison, comparePeriodCohorts(value.periods.baseline, value.periods.later)));
        require(value.nativeViewId === input.nativeViewId);
        require(value.nativeViewKind === input.nativeViewKind);
        if (input.nativeViewId !== undefined) {
            require(typeof validateNativePeriods === "function");
            validateNativePeriods(value.nativePeriods, { baseline: value.periods.baseline.dateRange, later: value.periods.later.dateRange });
            require(input.nativeViewKind === "current" ? value.nativePeriods.schemaVersion === 2 : value.nativePeriods.schemaVersion === 1);
        } else require(value.nativePeriods === undefined);
        if (value.definitions.resultProjectionVersion !== undefined) {
            require(value.definitions.resultProjectionVersion === 1 && typeof resultContract?.compareReportResultFacts === "function");
            if (value.definitions.layer === "tool") {
                for (const side of Object.values(value.periods)) {
                    require(Array.isArray(side.resultMembership));
                    resultContract.validateReportResultFacts(side.resultFacts, { memberRefs: side.resultMembership.map(item => item.memberRef) });
                    const nativeRows = (value.nativePeriods?.rows ?? []).filter(row => row.unit === "native-tool-call"
                        && row.startedAt !== null && row.startedAt >= side.dateRange.from && row.startedAt < side.dateRange.to);
                    require(side.resultFacts.calls.length === side.analytics.rows.length + nativeRows.length
                        && new Set(side.resultMembership.map(item => item.rowRef)).size === side.resultMembership.length);
                }
                require(same(value.resultComparison, resultContract.compareReportResultFacts(value.periods.baseline.resultFacts, value.periods.later.resultFacts)));
            } else require(value.periods.baseline.resultFacts === null && value.periods.later.resultFacts === null
                && same(value.resultComparison, { version: 1, status: "unavailable", reason: "not-tool-call-cohort", groups: [] }));
        }
        pending.scope.endpoints = (input.options.filters.endpoints ?? []).map(id => {
            const names = ["baseline", "later"].map(side => value.periods[side].analytics.filterOptions?.endpoints?.find(entry => entry.id === id)?.label ?? null);
            require(names[0] === names[1]);
            return { id, name: names[0] };
        });
        accepted = structuredClone(value);
        return true;
    }
    function leave() { generation++; pending = null; accepted = null; }
    function observe(status) {
        if (!status?.basis || !pending) return false;
        if (same(status.basis, pending.basis) && !(status.pendingCleanup && status.kind !== "artifact-deletion")) return false;
        leave(); return true;
    }
    return { prepare, begin, accept, leave, observe, consumer: () => accepted ? structuredClone(accepted) : null,
        scope: () => accepted ? structuredClone(pending.scope) : null };
}

export function createPeriodComparisonPresentation(time) {
    const choices = { "previous-week": "Previous week", "this-week": "This week",
        "previous-month": "Previous month", "this-month": "This month", custom: "Custom dates" };
    function preset(name, context, now) {
        if (name === "custom") return null;
        if (!Object.hasOwn(choices, name)) throw new RangeError("Unknown comparison date preset.");
        const bucket = name.endsWith("week") ? "week" : "month";
        const current = time.preset(bucket, context.timeZone, now);
        if (name.startsWith("this-")) return current;
        const to = time.addDays(current.from, -1);
        return { from: bucket === "week" ? time.addDays(to, -6) : time.calendar(to.slice(0, 7) + "-01"), to };
    }
    function names(ranges, context, now) {
        const showYear = new Set(ranges.flatMap(range => [range.from.slice(0, 4), range.to.slice(0, 4)])).size > 1;
        const resolved = Object.keys(choices).filter(key => key !== "custom").map(key => [key, preset(key, context, now)]);
        return ranges.map(range => {
            const match = resolved.find(([, value]) => value.from === range.from && value.to === range.to);
            if (match) {
                const key = match[0], label = choices[key];
                return { label, phrase: (key.startsWith("previous") ? "the " : "") + label.toLowerCase(), preset: key };
            }
            const label = time.formatDate(range.from, context, showYear)
                + (range.from === range.to ? "" : " – " + time.formatDate(range.to, context, showYear));
            return { label, phrase: "during " + label, preset: "custom" };
        });
    }
    function rates(baseline, later, outcome = "failure") {
        const values = [baseline, later].map(side => side.count ? side[outcome] * 100 / side.count : null);
        let digits = 2;
        if (values.every(value => value !== null) && values[0] !== values[1]) {
            while (digits < 15 && values[0].toFixed(digits) === values[1].toFixed(digits)) digits++;
        }
        return values.map(value => value === null ? null : value.toFixed(digits) + "%");
    }
    return { choices, preset, names, rates };
}

export function mountPeriodComparison({ root, setup = root, toggle, api, time, search, categories, results, projection, createState,
    assessmentFactories, getContext, navigate, onSearch, recordLink, syncFilters, createReport, openSearch, onAccepted, onPairChange }) {
    const doc = root.ownerDocument;
    const presentation = assessmentFactories.periodComparison.createPresentation(time);
    let machine, metricSlotKey, contractPromise, contextKey = "", requestKey = "", generation = 0, lastRoute = "", shown = false, blockedSnapshot = null, outcomeObserver = null, datesEdited = false;
    let selectedPeriod = "baseline", rosterKey = "";
    let completionIntent = null, entryIntent = null;
    let accessWithdrawn = false, acceptedPublication = null, outcomeLayer = "tool";
    const publicationToken = () => typeof api.publicationToken === "function" ? api.publicationToken() : null;
    const publicationCurrent = token => !accessWithdrawn && token != null
        && typeof api.isCurrent === "function" && api.isCurrent(token) === true;
    const readCurrent = (started, token) => {
        if (started !== generation) return false;
        if (publicationCurrent(token)) return true;
        withdrawAccess(); return false;
    };
    const snapshotKey = context => JSON.stringify([context.snapshot?.revision, context.snapshot?.nativeRead?.revision, context.snapshot?.assessment?.basis, context.snapshot?.assessment?.source]);
    const number = value => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
    const el = (tag, text, cls) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    };
    const button = (label, action) => {
        const node = el("button", label, "quiet"); node.type = "button"; node.addEventListener("click", action); return node;
    };
    const title = el("h2", "Compare periods", "visually-hidden");
    title.id = "periodComparisonTitle"; title.tabIndex = -1;
    function stop() { navigate({ compare: undefined }); toggle.focus(); }
    const form = el("form", undefined, "period-comparison-controls");
    form.setAttribute("aria-label", "Comparison periods");
    const inputs = {}, presets = {}, presetRanges = {};
    for (const [side, label] of [["a", "Period A"], ["b", "Period B"]]) {
        const group = el("fieldset"); group.append(el("legend", label));
        const presetLabel = el("label", undefined, "comparison-preset-field"), select = el("select");
        presetLabel.append(el("span", "Dates", "visually-hidden"));
        select.id = `comparison${side.toUpperCase()}Preset`;
        select.setAttribute("aria-label", `${label} dates`);
        for (const [value, text] of Object.entries(presentation.choices)) {
            const option = el("option", text); option.value = value; select.append(option);
        }
        select.value = "custom"; presets[side] = select;
        presetLabel.append(select); group.append(presetLabel);
        for (const [bound, text] of [["From", "From"], ["To", "To"]]) {
            const field = el("label", undefined, "comparison-date-field"), input = el("input");
            field.append(el("span", text));
            input.type = "date"; input.id = `comparison${side.toUpperCase()}${bound}`; input.required = true;
            input.setAttribute("aria-label", `${label} ${text.toLowerCase()}`);
            input.setAttribute("aria-describedby", "comparisonDateHint periodComparisonStatus");
            inputs[side + bound] = input;
            field.append(input); group.append(field);
        }
        presetRanges[side] = el("p", undefined, "comparison-preset-range"); presetRanges[side].hidden = true;
        group.append(presetRanges[side]);
        form.append(group);
    }
    const apply = el("button", "Compare periods", "primary"); apply.type = "submit"; apply.id = "applyPeriodComparison";
    form.append(apply);
    const dateHint = el("p", undefined, "visually-hidden"); dateHint.id = "comparisonDateHint";
    const scopeRow = el("div", undefined, "period-comparison-scope");
    const scope = el("p", undefined, "visually-hidden");
    const searchLabel = el("label", "Search these interactions", "search-label"), searchInput = el("input");
    searchInput.type = "search"; searchInput.autocomplete = "off"; searchInput.id = "comparisonSearch";
    searchLabel.append(searchInput);
    searchLabel.hidden = typeof openSearch === "function";
    searchInput.addEventListener("input", () => {
        if (!publicationCurrent(publicationToken())) { searchInput.value = ""; searchInput.defaultValue = ""; return; }
        onSearch(searchInput.value);
    });
    searchInput.addEventListener("keydown", event => {
        if (!publicationCurrent(publicationToken())) return;
        if (event.key === "Escape" && searchInput.value) { searchInput.value = ""; onSearch(""); event.preventDefault(); }
    });
    const status = el("p", undefined, "context-help-note"); status.id = "periodComparisonStatus"; status.setAttribute("role", "status");
    status.hidden = true;
    function setStatus(message, className = "context-help-note") {
        status.textContent = message; status.className = className; status.hidden = !message;
        if (status.classList.contains("comparison-progress")) output.append(status);
        else setup.insertBefore(status, scopeRow);
    }
    const output = el("div"); output.id = "periodComparisonResults"; output.tabIndex = -1;
    const report = button("Create comparison report", () => {
        const publication = acceptedPublication;
        const value = consumer();
        if (!value) return;
        const context = getContext();
        const selection = context.semanticSearch ? { receipt: structuredClone(context.semanticSearch.receipt),
            ...(value.selection.withinScenarioIds === undefined ? {} : { withinScenarioIds: [...value.selection.withinScenarioIds] }),
        } : undefined;
        if (publicationCurrent(publication)) createReport?.(value, selection);
    });
    report.id = "createPeriodReport"; report.disabled = true; report.hidden = true;
    const resultHeading = el("div", undefined, "period-comparison-heading");
    const resultTitle = el("h2", "Comparison results"); resultTitle.id = "periodComparisonResultsTitle"; resultTitle.tabIndex = -1;
    resultHeading.append(resultTitle, report); resultHeading.hidden = true;
    scopeRow.append(dateHint, scope);
    setup.append(title, form, status, scopeRow, searchLabel);
    root.append(resultHeading, output);
    function syncReport(value = null) {
        report.disabled = !createReport || !value || !(Object.values(value.periods).some(side => side.scenarioIds.length)
            || value.nativePeriods?.rows.length || value.nativePeriods?.refinement?.contextConversationRefs.length);
        report.hidden = report.disabled;
    }
    function clearResults() {
        acceptedPublication = null;
        syncReport(); resultHeading.hidden = true; resultTitle.textContent = "Comparison results";
        output.replaceChildren(); output.removeAttribute("aria-busy");
        onPairChange?.(null);
    }
    function syncPreset(side) {
        const custom = presets[side].value === "custom";
        for (const bound of ["From", "To"]) inputs[side + bound].parentElement.hidden = !custom;
        presetRanges[side].hidden = custom;
        if (!custom) {
            const context = getContext().options.timeContext;
            presetRanges[side].textContent = time.formatDate(inputs[side + "From"].value, context, true)
                + " – " + time.formatDate(inputs[side + "To"].value, context, true);
        }
    }
    function editDates() {
        completionIntent = null; entryIntent = null;
        datesEdited = true;
        if (!publicationCurrent(publicationToken())) { withdrawAccess(); return; }
        generation++; machine?.leave(); requestKey = "";
        clearResults(); syncOutcomeChoices();
        for (const field of Object.values(inputs)) field.removeAttribute("aria-invalid");
        setStatus(Object.values(periods(getContext().route)).every(period => period.from && period.to)
            ? "Dates changed. Compare periods to see the updated results." : "");
    }
    for (const [key, input] of Object.entries(inputs)) {
        input.addEventListener("input", () => {
            presets[key[0]].value = "custom"; syncPreset(key[0]); editDates();
        });
        input.addEventListener("invalid", () => {
            if (!publicationCurrent(publicationToken())) return;
            completionIntent = null;
            input.setAttribute("aria-invalid", "true");
            setStatus("Choose a valid start and end date for both periods.", "error");
        });
    }
    for (const [side, select] of Object.entries(presets)) select.addEventListener("change", () => {
        editDates();
        if (!publicationCurrent(publicationToken())) return;
        try {
            const range = presentation.preset(select.value, getContext().options.timeContext, new Date().toISOString());
            if (range) { inputs[side + "From"].value = range.from; inputs[side + "To"].value = range.to; }
            select.removeAttribute("aria-invalid"); syncPreset(side);
        } catch (error) {
            select.setAttribute("aria-invalid", "true"); setStatus(error.message, "error");
        }
    });
    toggle.setAttribute("aria-controls", setup === root ? root.id : `${setup.id} ${root.id}`);
    // Capture the activation before the enclosing drawer returns focus to its opener.
    doc.addEventListener("click", event => {
        if (!event.isTrusted || !toggle.contains(event.target)) return;
        const publication = publicationToken();
        if (!publicationCurrent(publication)) { entryIntent = null; return; }
        entryIntent = shown ? null : { readingIntent: getContext().readingIntent, focus: doc.activeElement, activating: true,
            publication, drawerReturn: toggle.closest("#navigationDrawer[open]") ? doc.getElementById("navigationToggle") : null };
    }, { capture: true });
    doc.addEventListener("focusin", event => {
        if (!entryIntent || !event.isTrusted) return;
        if (entryIntent.activating && event.target === entryIntent.drawerReturn) entryIntent.focus = event.target;
        else if (event.target !== entryIntent.focus) entryIntent = null;
    }, { capture: true });
    function focusEntry(context) {
        const intent = entryIntent;
        if (!intent?.ready) return;
        if (!publicationCurrent(intent.publication)) { withdrawAccess(); return; }
        if (intent.navigation !== context.navigationGeneration || intent.readingIntent !== context.readingIntent
            || context.route.view !== "analyze" || context.route.compare !== "periods") { entryIntent = null; return; }
        const target = doc.getElementById("comparisonAPreset-control") || presets.a;
        if (!target.checkVisibility() || target.matches(":disabled") || target.closest("[inert]")) return;
        entryIntent = null;
        target.focus();
    }
    toggle.addEventListener("click", () => {
        if (!publicationCurrent(publicationToken())) return;
        const intent = entryIntent;
        if (intent) {
            intent.activating = false;
            intent.navigation = getContext().navigationGeneration + 1;
        }
        const pending = navigate({ compare: shown ? undefined : "periods" });
        if (!intent || entryIntent !== intent) return;
        const finished = loaded => {
            if (entryIntent !== intent) return;
            if (!publicationCurrent(intent.publication)) { withdrawAccess(); return; }
            if (loaded === false) { entryIntent = null; return; }
            intent.ready = true; focusEntry(getContext());
        };
        // The existing navigation finishes its own focus handoff before entry is oriented.
        if (pending instanceof Promise) pending.then(finished);
        else finished(pending);
    });
    form.addEventListener("submit", event => {
        event.preventDefault();
        const publication = publicationToken();
        if (!publicationCurrent(publication)) return;
        let invalidSide;
        try {
            const context = getContext(), labelTime = new Date().toISOString();
            for (const side of ["a", "b"]) {
                invalidSide = side;
                const range = presentation.preset(presets[side].value, context.options.timeContext, labelTime);
                if (range) { inputs[side + "From"].value = range.from; inputs[side + "To"].value = range.to; syncPreset(side); }
            }
            const changes = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
            for (const prefix of ["a", "b"]) {
                invalidSide = prefix;
                time.calendar(changes[prefix + "From"]); time.calendar(changes[prefix + "To"]);
                time.range({ from: changes[prefix + "From"], to: changes[prefix + "To"] }, getContext().options.timeContext.timeZone);
            }
            for (const input of Object.values(inputs)) input.removeAttribute("aria-invalid");
            if (!publicationCurrent(publication)) { withdrawAccess(); return; }
            completionIntent = { trigger: doc.activeElement, readingIntent: context.readingIntent, labelTime, publication,
                key: signature({ ...context, route: { ...context.route, ...changes, compare: "periods" } }) };
            datesEdited = false; requestKey = ""; navigate({ ...changes, compare: "periods" });
        } catch (error) {
            if (!publicationCurrent(publication)) { withdrawAccess(); return; }
            completionIntent = null;
            setStatus(`Period ${invalidSide.toUpperCase()}: ${error.message}`, "error");
            inputs[invalidSide + "From"].setAttribute("aria-invalid", "true");
            inputs[invalidSide + "To"].setAttribute("aria-invalid", "true");
            inputs[invalidSide + "From"].focus();
        }
    });
    async function ready(started, publication) {
        if (!contractPromise) contractPromise = Promise.all([
            import("/assets/assessment-contract.mjs"), import("/assets/period-comparison-math.mjs"),
            import("/assets/report-result-contract.mjs"),
        ]);
        const pending = contractPromise;
        try {
            const [contract, { comparePeriodCohorts, validateNativePeriods }, resultContract] = await pending;
            if (!readCurrent(started, publication)) return false;
            if (!machine) {
                machine = createState({ time, search, contract, projection, categories, comparePeriodCohorts, validateNativePeriods, resultContract });
                metricSlotKey = contract.metricSlotKey;
            }
            return true;
        } catch (error) {
            if (contractPromise === pending) contractPromise = null;
            throw error;
        }
    }
    const periods = route => ({ baseline: { from: route.aFrom, to: route.aTo }, later: { from: route.bFrom, to: route.bTo } });
    function signature(context) {
        return JSON.stringify([context.route.view, context.route.compare, context.snapshot?.revision, context.snapshot?.nativeRead?.revision, context.snapshot?.assessment?.basis,
            context.snapshot?.assessment?.source, context.options, periods(context.route), context.search, context.route.withinServices, context.semanticSearch,
            context.nativeView?.viewId, context.nativeView?.sourceRevision, context.nativeView?.textSelection?.membershipRef, context.nativeView?.groupId]);
    }
    function dataTable(caption, headers, rows, rowHeadings = true) {
        const node = el("table"), head = el("thead"), line = el("tr"), body = el("tbody");
        node.append(el("caption", caption, "visually-hidden"));
        for (const label of headers) { const th = el("th", label); th.scope = "col"; line.append(th); }
        head.append(line);
        for (const cells of rows) {
            const tr = el("tr");
            cells.forEach((value, index) => {
                const heading = !index && rowHeadings, cell = el(heading ? "th" : "td");
                if (heading) cell.scope = "row"; else cell.dataset.label = headers[index];
                if (value instanceof doc.defaultView.Node) cell.append(value); else cell.textContent = value;
                tr.append(cell);
            });
            body.append(tr);
        }
        node.append(head, body); return node;
    }
    function table(caption, headers, rows) {
        const wrap = el("div", undefined, "period-comparison-table");
        wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", caption);
        wrap.append(dataTable(caption, headers, rows)); return wrap;
    }
    const signed = value => value === null ? "Not comparable" : `${value > 0 ? "+" : ""}${number(value)}`;
    const duration = value => assessmentFactories.timing.duration(value);
    const durationChange = value => assessmentFactories.createReportComparison().formatChange(value, "ms");
    const counted = (value, unit) => `${number(value)} ${unit}${value === 1 ? "" : "s"}`;
    const numeric = text => el("span", text, "compare-number");
    const identity = name => el("span", name, "compare-period-name");
    function deltaNode(value, unit, lowerIsBetter = false) {
        const smallShare = value !== null && value !== 0 && Math.abs(value) < 0.01 && unit === "pp";
        const text = value === null ? "Not comparable" : smallShare
            ? `${value > 0 ? "+" : ""}${assessmentFactories.createReportComparison().formatValue(value, "percentage-points")}` : unit.startsWith("ms")
            ? `${durationChange(value)}${unit.slice(2)}` : `${signed(value)} ${unit}`;
        const node = el("span", text, "compare-delta");
        if (lowerIsBetter && value !== null && value !== 0) node.classList.add(value > 0 ? "compare-worse" : "compare-better");
        return node;
    }
    function panel(name, className) {
        const node = el("section", undefined, `compare-panel ${className}`);
        node.append(el("h3", name)); return node;
    }
    function syncOutcomeChoices(value = null) {
        if (!publicationCurrent(publicationToken())) return;
        const control = doc.getElementById("outcomeFilter"), labels = results.labels(getContext().options.layer);
        outcomeLayer = getContext().options.layer;
        if (doc.getElementById("outcomeFilter-control")?.getAttribute("aria-expanded") === "true") return;
        const a = value?.periods.baseline.analytics.resultFacet.totals, b = value?.periods.later.analytics.resultFacet.totals;
        for (const option of control.options) {
            const count = a && b ? `A: ${number(a[option.value])}; B: ${number(b[option.value])}` : null;
            option.textContent = labels[option.value] + (count ? ` (${count})` : "");
            option.dataset.optionLabel = labels[option.value];
            if (count) option.dataset.count = count;
            else delete option.dataset.count;
        }
        control.dataset.allLabel = "All results";
        // Ordinary renderControls must rebuild its own date-scoped labels on exit.
        delete control.dataset.optionsSignature;
        const serviceScope = doc.getElementById("serviceFocusScope");
        if (serviceScope) serviceScope.textContent = "Known service matches and missing-service context are counted separately in the results.";
        syncFilters();
    }
    function outcomePanel(value, sides, labels, names) {
        const tool = value.definitions.layer === "tool";
        const node = panel(tool ? "Call results" : "Recorded results", "compare-outcomes"), finding = el("p", undefined, "compare-finding");
        const a = sides[0][1], b = sides[1][1], noun = results.columnUnit(value.definitions.layer, 2);
        const rates = Object.fromEntries(Object.keys(labels).map(key => [key, presentation.rates(a.analytics.totals, b.analytics.totals, key)]));
        const explanation = el("p", undefined, "compare-caption");
        const change = value.comparison.outcomes.change.failure;
        const failure = tool ? "failed" : `were recorded as "${labels.failure}"`;
        if (value.definitions.layer === "code-reference") {
            finding.textContent = "Execution not observed";
            explanation.textContent = "Code references show mentions, not executed operations.";
        } else if (!a.rowIds.length || !b.rowIds.length) {
            const missing = a.rowIds.length ? 1 : 0, present = missing ? a : b;
            finding.textContent = `No ${noun} were found ${names[missing].phrase}.`;
            explanation.textContent = `${names[1 - missing].label}: ${present.analytics.totals.failure} of ${present.rowIds.length} ${noun} ${failure} (${rates.failure[1 - missing]}).`;
        } else {
            const rate = el("span", rates.failure[1], change > 0 ? "compare-worse" : change < 0 ? "compare-better" : "");
            finding.append(rate, ` of ${noun} ${failure} ${names[1].phrase}.`);
            const direction = a.range.to < b.range.from && change !== null
                ? change > 0 ? "Up from" : change < 0 ? "Down from" : "Also" : "Compared with";
            explanation.textContent = `${direction} ${rates.failure[0]} ${names[0].phrase}.`;
        }
        const findings = el("div", undefined, "compare-findings");
        findings.append(finding, explanation); node.append(findings);
        const distributions = [];
        for (const [index, [, side]] of sides.entries()) {
            const row = el("div", undefined, "compare-outcome-row"), heading = el("div", undefined, "compare-bar-heading");
            heading.append(identity(names[index].label), numeric(`${number(side.rowIds.length)} ${results.columnUnit(value.definitions.layer, side.rowIds.length)}`));
            const bar = el("div", undefined, "compare-outcome-bar"); bar.setAttribute("role", "img");
            bar.setAttribute("aria-label", `${names[index].label}: ` + Object.entries(labels).map(([key, label]) =>
                `${label} ${side.analytics.totals[key]} (${rates[key][index] ?? "Not applicable"})`).join(", "));
            for (const key of Object.keys(labels)) {
                if (!side.analytics.totals[key]) continue;
                const mark = el("span", undefined, "compare-mark-" + key); mark.dataset.outcome = key;
                mark.style.width = `${side.analytics.totals[key] * 100 / side.rowIds.length}%`; bar.append(mark);
            }
            row.append(heading, bar);
            if (!side.rowIds.length) row.append(el("p", "No matching records", "compare-caption"));
            distributions.push(row);
        }
        const rows = [];
        for (const [key, label] of Object.entries(labels)) {
            if (!a.analytics.totals[key] && !b.analytics.totals[key]) continue;
            const name = el("span", undefined, "compare-outcome-label");
            name.append(el("span", undefined, "compare-swatch compare-mark-" + key), label);
            rows.push([name, ...[a, b].map((side, index) => numeric(`${number(side.analytics.totals[key])} (${rates[key][index] ?? "Not applicable"})`))]);
        }
        const legend = dataTable("Recorded results by period", ["Outcome", ...names.map(name => name.label)], rows);
        legend.className = "compare-values-table compare-outcome-values";
        distributions.forEach((row, index) => legend.tHead.rows[0].cells[index + 1].replaceChildren(row));
        node.append(legend);
        if (tool) node.append(el("p", "Results describe tool calls, not the quality of the answers.", "compare-caption"));
        return node;
    }
    function matchingTimingPanel(value, names) {
        const node = panel("Tool latency", "compare-latency");
        node.append(el("p", "Call start to completion; recorded timings only.", "compare-caption"));
        const matching = value.comparison.matchingCallTiming;
        if (!matching) {
            node.append(el("p", "Unavailable for this evidence layer. These records are not timed tool calls.", "compare-empty"));
            return node;
        }
        const rows = [];
        for (const [key, label] of [["median", "Typical call (median)"], ["p95", "95% finished within"]]) {
            const item = matching[key], cells = [label];
            const measurable = fact => fact.state === "available" && (key !== "p95" || fact.coverage.count > 1);
            const delta = item.delta && measurable(item.baseline) && measurable(item.later) ? item.delta.value : null;
            for (const [index, fact] of [item.baseline, item.later].entries()) {
                const cell = el("div", undefined, "compare-timing-value"), measured = numeric(measurable(fact) ? duration(fact.value)
                    : key === "p95" && fact.coverage.count === 1 ? "Not shown (one timing)" : "Not measured");
                if (index && delta !== null && delta !== 0) measured.classList.add(delta < 0 ? "compare-better" : "compare-worse");
                cell.append(measured);
                if (index) cell.append(el("p", delta === null ? "Cannot compare" : delta === 0 ? "Unchanged"
                    : `${durationChange(delta)}\u00a0${delta < 0 ? "faster" : "slower"}`,
                "compare-value-detail" + (delta === null || delta === 0 ? "" : delta < 0 ? " compare-better" : " compare-worse")));
                cells.push(cell);
            }
            rows.push(cells);
        }
        const coverage = matching.median;
        rows.push(["Calls with timing", ...[coverage.baseline, coverage.later].map(fact => {
            const cell = el("div", undefined, "compare-timing-value"), missing = fact.coverage.eligible - fact.coverage.count;
            cell.append(numeric(`${number(fact.coverage.count)} of ${number(fact.coverage.eligible)}`));
            if (missing) cell.append(el("p", `${number(missing)} without timing`, "compare-value-detail"));
            return cell;
        })]);
        const values = dataTable("Tool latency by period", ["Measure", ...names.map(name => name.label)], rows);
        values.className = "compare-values-table";
        node.append(values);
        return node;
    }
    function recordPanel(value, sides, labels, membershipKey, names, started, publication) {
        const node = panel(value.definitions.layer === "tool" ? "Calls in each period" : "Records in each period", "compare-evidence");
        node.dataset.viewKey = "period-evidence:" + membershipKey;
        const tabs = el("div", undefined, "compare-evidence-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Exact period records");
        const entries = [], records = new Map(getContext().snapshot.scenarios.map(record => [record.scenarioId, record]));
        const select = key => {
            selectedPeriod = key;
            for (const entry of entries) {
                const current = entry.key === key;
                entry.tab.setAttribute("aria-selected", String(current)); entry.tab.tabIndex = current ? 0 : -1;
                entry.body.hidden = !current;
            }
        };
        for (const [index, [key, side, name]] of sides.entries()) {
            const tab = button(`${names[index].label} (${number(side.rowIds.length)})`, () => {
                if (node.isConnected && readCurrent(started, publication)) select(key);
            });
            tab.id = "comparisonRecords" + name; tab.setAttribute("role", "tab");
            const body = el("section", undefined, "compare-record-panel"); body.id = "comparisonExactRecords" + name;
            body.dataset.periodSide = key; body.setAttribute("role", "tabpanel"); body.setAttribute("aria-labelledby", tab.id);
            tab.setAttribute("aria-controls", body.id);
            body.append(el("p", `${number(side.rowIds.length)} ${results.columnUnit(value.definitions.layer, side.rowIds.length)} across ${counted(side.interactionRefs.length, "interaction")}`, "compare-caption"));
            if (side.rowIds.length) {
                const exact = table(`${names[index].label}: ${number(side.rowIds.length)} exact ${results.columnUnit(value.definitions.layer, side.rowIds.length)}`,
                    [value.definitions.layer === "tool" ? "Call and interaction" : "Record and interaction", "Started", "Result", value.definitions.layer === "tool" ? "Latency" : "Duration"],
                    side.analytics.rows.map((row, rowIndex) => {
                        const nameCell = el("div", undefined, "compare-record-identity"), link = recordLink(row, side, value);
                        const title = records.get(row.scenarioId)?.title, startedAt = time.formatTime(row.startedAt, value.timeContext);
                        const knownTool = typeof row.tool === "string" && row.tool.length > 0;
                        const toolName = knownTool ? row.tool : "Tool not recorded";
                        if (!knownTool) link.textContent = toolName;
                        link.id = `comparison-record-${name}-${row.id}`;
                        link.setAttribute("aria-label", `${toolName}, ${title || "Retained interaction"}, ${startedAt}, record ${rowIndex + 1}`);
                        link.addEventListener("click", event => {
                            if (link.isConnected && readCurrent(started, publication)) return;
                            event.preventDefault(); event.stopImmediatePropagation();
                        }, { capture: true });
                        nameCell.append(link);
                        if (title && (!knownTool || title !== `Recorded ${row.tool.replace(/^workiq-/, "")} scenario`))
                            nameCell.append(el("span", title, "compare-record-context"));
                        return [nameCell, startedAt,
                            el("span", labels[row.outcome], "compare-record-outcome compare-record-" + row.outcome),
                            row.durationMs === null ? el("span", "Not measured", "compare-caption") : numeric(duration(row.durationMs))];
                    }));
                exact.id = "comparison-record-scroll-" + name; body.append(exact);
            } else body.append(el("p", "No matching activity was found in this period.", "compare-empty"));
            if (side.unmappedScenarioIds.length) body.append(el("p", `${counted(side.unmappedScenarioIds.length, "request group")} could not be matched to an interaction.`, "compare-scope-note"));
            const services = side.analytics.serviceInvolvement;
            if (services.selection.services.length) {
                const coverage = el("p", undefined, "compare-caption compare-peer-facts compare-service-coverage");
                const known = el("span"), context = el("span");
                known.append("Known service matches: ", numeric(number(services.selection.knownMatchIds.length)));
                context.append("Missing-service context: ", numeric(counted(services.selection.contextOnlyIds.length, "record")));
                coverage.append(known, " ", context); body.append(coverage);
            }
            else if (services.missingDetailCount) body.append(el("p", `${counted(services.missingDetailCount, "matching record")} ${services.missingDetailCount === 1 ? "has" : "have"} missing service details.`, "compare-caption"));
            if (side.analytics.apiCoverage) body.append(el("p", `${side.analytics.apiCoverage.selectedResultUnits} matching returned entries; ${side.analytics.apiCoverage.eligibleToolCalls} parent calls before outcome/path filters. Separate populations.`, "compare-caption"));
            entries.push({ key, tab, body }); tabs.append(tab);
            tab.addEventListener("keydown", event => {
                if (!node.isConnected || !readCurrent(started, publication)) return;
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? entries[0] : event.key === "End" ? entries[1] : entries.find(entry => entry.key !== key);
                select(next.key); next.tab.focus();
            });
        }
        node.append(tabs, ...entries.map(entry => entry.body)); select(selectedPeriod); return node;
    }
    function wholeTimingPanel(value, sides, names) {
        const node = panel("Timing of the full interactions", "compare-full-timing");
        node.querySelector("h3").id = "periodInteractionDetailsTitle";
        const counts = el("p", undefined, "compare-caption compare-peer-facts compare-interaction-counts");
        for (const [index, [, side]] of sides.entries()) {
            const fact = el("span");
            fact.append(`${names[index].label}: `, numeric(counted(side.interactionRefs.length, "interaction")));
            if (index) counts.append(" ");
            counts.append(fact);
        }
        node.append(counts, el("p", "Includes other calls in those interactions, even outside these dates or filters.", "compare-caption compare-population-note"));
        const formatter = assessmentFactories.createReportComparison();
        for (const item of value.comparison.metrics) {
            const section = el("section", undefined, "compare-whole-measure");
            const timed = sides.map(([key, side]) => {
                const metric = side.assessment.metrics.find(metric => metricSlotKey(metric) === item.key);
                return metric && item[key]?.kind === "duration" ? assessmentFactories.timing.fromMetric(metric) : null;
            });
            section.append(el("h4", timed.find(Boolean)?.label || formatter.comparisonLabel(item)));
            const cells = sides.map(([key], index) => {
                const fact = item[key], timing = timed[index], cell = el("div");
                if (fact?.state === "available" && timing) {
                    const typical = el("p");
                    if (timing.timed > 1) typical.textContent = `Typical (median): ${duration(timing.distribution.p50Ms)}`;
                    else typical.append(numeric(duration(timing.measurement.value)), " ", el("span", "(one timing)", "compare-observation"));
                    cell.append(typical);
                    if (timing.timed > 1) cell.append(el("p", `95% finished within: ${duration(timing.distribution.p95Ms)}`));
                } else {
                    const text = fact ? formatter.metricPresentation(fact, fact.metric, { includeOrigin: false }).value
                        : formatter.absentPeerLabel(item[key === "baseline" ? "later" : "baseline"]);
                    cell.append(el("p", text === "Not measured" ? "No timing recorded" : text));
                }
                const definition = formatter.sideDefinitionLabel(item, key);
                if (definition) cell.append(el("span", definition, "compare-caption"));
                return cell;
            });
            const values = dataTable(section.querySelector("h4").textContent + " by period", names.map(name => name.label), [cells], false);
            values.className = "compare-whole-table";
            section.append(values);
            const coverage = timed.flatMap((timing, index) => {
                if (!timing) return [];
                const fact = el("span");
                fact.append(`${names[index].label}: `, numeric(`${timing.timed} of ${timing.eligible} ${timing.coverage.unit}`));
                return [fact];
            });
            if (coverage.length) {
                const line = el("div", undefined, "compare-caption compare-timing-coverage"), peers = el("p", undefined, "compare-peer-facts");
                coverage.forEach((fact, index) => { if (index) peers.append(" "); peers.append(fact); });
                line.append(el("span", "Timing recorded:"), " ", peers);
                section.append(line);
            }
            const change = el("p", undefined, "compare-caption");
            const delta = item.result?.delta;
            if (item.result?.status === "incompatible") change.textContent = "These timings use different definitions and cannot be compared.";
            else if (delta?.unit === "ms") change.textContent = delta.value === 0 ? "Typical time was unchanged."
                : `Typical time changed by ${durationChange(delta.value)} ${names[1].phrase} (${delta.value < 0 ? "faster" : "slower"}).`;
            else if (delta) change.append("Change: ", deltaNode(delta.value, delta.unit, true));
            if (change.hasChildNodes()) section.append(change);
            const warnings = item.result?.warnings.filter(code => !["partial-coverage", "coverage-decreased"].includes(code)) ?? [];
            if (warnings.length) section.append(el("p", warnings.map(code => formatter.warningLabel(code, item)).join("; "), "compare-caption"));
            node.append(section);
        }
        return node;
    }
    function paint(value, labelTime, started, publication) {
        const { baseline: a, later: b } = value.periods, sides = [["baseline", a, "A"], ["later", b, "B"]];
        const names = presentation.names([a.range, b.range], value.timeContext, labelTime);
        const heading = `${names[1].label} vs ${names[0].preset === "custom" ? names[0].label : names[0].label.toLowerCase()}`;
        const membershipKey = JSON.stringify([value.definitions.layer, a.rowIds, b.rowIds]);
        if (membershipKey !== rosterKey) { if (rosterKey !== null) selectedPeriod = "baseline"; rosterKey = membershipKey; }
        const dayCount = side => Math.round((Date.parse(side.range.to) - Date.parse(side.range.from)) / 86400000) + 1;
        const dateRange = side => side.range.from === side.range.to ? time.formatDate(side.range.from, value.timeContext, true)
            : `${time.formatDate(side.range.from, value.timeContext, true)} – ${time.formatDate(side.range.to, value.timeContext, true)}`;
        const pair = el("div", undefined, "compare-period-key");
        for (const [index, [, side]] of sides.entries()) {
            const line = el("p");
            line.append(identity(names[index].preset === "custom" ? `Period ${index ? "B" : "A"}` : names[index].label),
                el("span", `${dateRange(side)} (${dayCount(side)} ${dayCount(side) === 1 ? "day" : "days"})`, "compare-date-qualification")); pair.append(line);
        }
        const collection = { history: "Saved collection", legacy: "Earlier snapshot", all: "Both collections" }[value.options.filters.scope ?? "history"];
        const content = doc.createDocumentFragment(); content.append(pair);
        if (value.options.filters.scope && value.options.filters.scope !== "history") content.append(el("p", collection, "compare-caption"));
        if (value.resultComparison) assessmentFactories.createReportComparison().renderResultComparison(content, value.resultComparison);
        if (value.nativePeriods) {
            const section = el("section", undefined, "compare-native");
            section.append(el("h3", "Microsoft activity"), el("p",
                "Each source and unit is counted separately. Undated evidence remains visible below, but is not assigned to either period. Message dates are not call start times.", "compare-caption"));
            if (value.nativePeriods.refinement) section.append(el("p",
                `Period A and B replace the original Dates filter; the original Search, group and other source filters are preserved. ${number(value.nativePeriods.refinement.contextConversationRefs.length)} matching conversation${value.nativePeriods.refinement.contextConversationRefs.length === 1 ? " is" : "s are"} context-only; exact message-date cohorts are not established.`,
                "compare-caption"));
            const rows = value.nativePeriods.summary.flatMap(item => {
                const source = item.sourceId === "microsoft-365-chat" ? "Microsoft 365 Chat" : "Microsoft 365 Cowork";
                const unit = item.unit === "native-tool-call" ? "native calls" : item.unit === "native-returned-result-observation" ? "returned results" : "message observations";
                const outcomes = item.unit === "message-representation-observation" ? [] : ["success", "failure", "unknown", "other"]
                    .filter(key => item.baseline[key] || item.later[key]).map(key => {
                        const label = el("span", `${source}: ${unit} / ${key}`);
                        if (key === "failure") label.style.color = "var(--danger)";
                        return [label, number(item.baseline[key]), number(item.later[key]), signed(item.later[key] - item.baseline[key]), "-"];
                    });
                return [[`${source}: ${unit}`, number(item.baseline.count), number(item.later.count),
                    signed(item.later.count - item.baseline.count), number(item.undated)], ...outcomes];
            });
            section.append(rows.length ? table("Microsoft period populations", ["Source and measure", "A", "B", "Change", "Undated"], rows)
                : el("p", "No Microsoft observations match this source, record type and filter selection.", "compare-empty"));
            content.append(section);
        }
        const nativeDatesUnavailable = (!value.options.filters.sources?.length
            || value.options.filters.sources.some(source => source.startsWith("microsoft-365-")))
            && sides.some(([, side]) => side.analytics.measurementEligibility?.nativeActivityDates === "unqualified");
        if (nativeDatesUnavailable && !value.nativePeriods) content.append(el("p",
            "Microsoft call dates are unavailable; undated calls are excluded from both periods.", "compare-scope-note"));
        if (value.definitions.layer !== "tool") content.append(el("p", results.unit(value.definitions.layer, 2), "compare-caption"));
        const sharedInteractions = a.interactionRefs.filter(ref => b.interactionRefs.includes(ref)).length, sharedRecords = value.comparison.outcomes.overlap.sharedCount;
        if (dayCount(a) !== dayCount(b)) content.append(el("p",
            "Totals are not adjusted for the different lengths.", "compare-scope-note compare-length-note"));
        if (sharedRecords || sharedInteractions) content.append(el("p",
            `${number(sharedRecords)} records and ${counted(sharedInteractions, "interaction")} appear in both periods.`, "compare-scope-note"));
        if (!a.rowIds.length && !b.rowIds.length) {
            content.append(el("p", value.nativePeriods ? "No GitHub records match these periods. Microsoft activity is shown separately."
                : nativeDatesUnavailable ? "No dated records match these periods. This is not a count of Microsoft calls."
                : "No activity was found in either period. Try different dates or filters.", "compare-empty"));
        } else {
            const labels = results.labels(value.definitions.layer), answers = el("div", undefined, "compare-answer-grid");
            answers.append(outcomePanel(value, sides, labels, names), matchingTimingPanel(value, names));
            content.append(answers, recordPanel(value, sides, labels, membershipKey, names, started, publication), wholeTimingPanel(value, sides, names),
                el("p", "Stored, dated activity only; differences do not establish cause.", "compare-caption"));
        }
        if (!readCurrent(started, publication)) return;
        syncOutcomeChoices(value);
        if (!readCurrent(started, publication)) return;
        syncReport(value); resultHeading.hidden = false; resultTitle.textContent = heading;
        output.replaceChildren(content);
    }
    // Keep private context/signature locals out of suspended read continuations.
    async function update() { return updateView(); }
    function updateView() {
        if (accessWithdrawn) return;
        const publication = publicationToken();
        if (!publicationCurrent(publication)) { withdrawAccess(); return; }
        syncReport();
        const outcomeTrigger = doc.getElementById("outcomeFilter-control");
        if (outcomeTrigger && !outcomeObserver) {
            outcomeObserver = new MutationObserver(() => {
                if (shown && outcomeTrigger.getAttribute("aria-expanded") !== "true") syncOutcomeChoices(consumer());
            });
            outcomeObserver.observe(outcomeTrigger, { attributes: true, attributeFilter: ["aria-expanded"] });
        }
        const context = getContext(), active = context.route.view === "analyze" && context.route.compare === "periods";
        const pageTitle = doc.getElementById("pageTitle");
        if (active && pageTitle) pageTitle.textContent = "Compare periods";
        shown = active; root.hidden = !active; setup.hidden = !active; toggle.hidden = false;
        toggle.setAttribute("aria-expanded", String(active));
        doc.body.classList.toggle("period-comparing", active);
        if (!active) {
            completionIntent = null; entryIntent = null;
            generation++; machine?.leave(); requestKey = ""; contextKey = ""; datesEdited = false; lastRoute = "";
            onPairChange?.(null);
            return;
        }
        const routeKey = JSON.stringify(periods(context.route));
        if (routeKey !== lastRoute) {
            for (const [key, input] of Object.entries(inputs)) {
                input.value = context.route[key] ?? ""; input.removeAttribute("aria-invalid");
            }
            const now = new Date().toISOString();
            for (const side of ["a", "b"]) {
                const range = presentation.preset(presets[side].value, context.options.timeContext, now);
                if (range && (range.from !== inputs[side + "From"].value || range.to !== inputs[side + "To"].value)) presets[side].value = "custom";
                syncPreset(side);
            }
            lastRoute = routeKey; datesEdited = false;
        }
        if (searchInput.value !== context.search) searchInput.value = context.search;
        const refinedNative = Boolean(context.nativeView?.textSelection || context.nativeView?.groupId);
        dateHint.className = context.options.timeContext.timeZoneFallback || refinedNative ? "context-help-note" : "visually-hidden";
        dateHint.textContent = context.options.timeContext.timeZoneFallback
            ? "Dates use UTC because the browser timezone is unavailable." : "Start and end dates are included.";
        if (refinedNative) dateHint.textContent += " Period A and B replace the original Dates filter; Search, group and other source filters stay fixed.";
        scope.hidden = !context.semanticSearch && !context.search.trim();
        scope.textContent = "The same non-date filters apply to both periods."
            + (context.semanticSearch ? " Search uses matching interactions and individual records across all pages."
                + (context.semanticSearch.withinScenarioIds !== undefined ? " The private phrase filter narrows that selection further." : "")
                : context.search.trim() ? " The private phrase filter also applies to both periods, across all retained interactions." : "");
        const key = signature(context);
        if (completionIntent?.key !== key) completionIntent = null;
        if (completionIntent && !publicationCurrent(completionIntent.publication)) completionIntent = null;
        syncOutcomeChoices(consumer());
        focusEntry(context);
        if (!publicationCurrent(publication)) { withdrawAccess(); return; }
        if (context.isLoading || context.isStale || context.semanticSearch && context.semanticSearch.status !== "ready" || blockedSnapshot === snapshotKey(context)) {
            completionIntent = null;
            generation++; machine?.leave(); contextKey = key; requestKey = "";
            clearResults();
            setStatus(context.semanticSearch && context.semanticSearch.status !== "ready"
                ? context.semanticSearch.status === "pending" ? "Search is finding matches. Wait for it to finish before comparing."
                    : "Search cannot provide a complete current selection. Check Search status before comparing."
                : "The retained view is updating or stale. Read the current stored view before comparing.", "notice"); return;
        }
        if (datesEdited) {
            completionIntent = null;
            if (!Object.values(inputs).some(input => input.hasAttribute("aria-invalid"))) setStatus(
                Object.values(periods(context.route)).every(period => period.from && period.to)
                    ? "Dates changed. Compare periods to see the updated results." : "");
            return;
        }
        if (key === contextKey && requestKey) { syncReport(consumer()); return; }
        contextKey = key; requestKey = "";
        const started = ++generation; machine?.leave(); clearResults();
        if (!readCurrent(started, publication)) return;
        if (!Object.values(periods(context.route)).every(period => period.from && period.to)) {
            setStatus(""); return;
        }
        setStatus("Reading both periods...", "context-help-note comparison-progress");
        output.setAttribute("aria-busy", "true");
        return readComparison(started, publication);
    }
    function beginRead(started, publication) {
        if (!readCurrent(started, publication)) return null;
        const context = getContext();
        if (signature(context) !== contextKey || context.isLoading || context.isStale) return null;
        const input = machine.prepare(context.snapshot, context.options, periods(context.route), context.search, context.route.withinServices?.split(",") ?? [], context.semanticSearch, context.nativeView);
        const token = machine.begin(input, context.snapshot, context.semanticSearch, Boolean(context.search.trim()));
        if (!readCurrent(started, publication)) return null;
        requestKey = contextKey;
        return { token, pending: api("/api/period-comparison", input) };
    }
    async function readComparison(started, publication) {
        try {
            if (!await ready(started, publication)) return;
            const request = beginRead(started, publication);
            if (!request) return;
            const value = await request.pending;
            if (!readCurrent(started, publication)) return;
            const current = getContext();
            if (signature(current) !== requestKey || current.isLoading || current.isStale) return;
            if (!machine.accept(request.token, value) || !readCurrent(started, publication)) return;
            const submitted = completionIntent;
            acceptedPublication = publication;
            paint(value, submitted?.labelTime || new Date().toISOString(), started, publication);
            if (!readCurrent(started, publication)) return;
            setStatus("Comparison ready.", "visually-hidden");
            onPairChange?.(acceptedPair());
            if (!readCurrent(started, publication)) return;
            onAccepted?.();
            if (!readCurrent(started, publication)) return;
            const orient = submitted && publicationCurrent(submitted.publication) && completionIntent === submitted && submitted.readingIntent === current.readingIntent
                && doc.activeElement === submitted.trigger;
            completionIntent = null;
            if (orient) {
                resultTitle.focus({ preventScroll: true });
                resultTitle.scrollIntoView({ block: "start" });
            }
        } catch (error) {
            if (!readCurrent(started, publication) || signature(getContext()) !== contextKey) return;
            completionIntent = null;
            machine?.leave(); clearResults();
            if (!readCurrent(started, publication)) return;
            setStatus(error.message, "error");
            syncOutcomeChoices();
            if (!readCurrent(started, publication)) return;
            const retry = button("Retry comparison read", () => {
                if (!retry.isConnected || !readCurrent(started, publication)) return;
                requestKey = ""; update();
            });
            output.append(retry);
        } finally {
            if (publicationCurrent(publication) && started === generation) output.removeAttribute("aria-busy");
        }
    }
    function consumer() {
        if (!publicationCurrent(acceptedPublication)) return null;
        const context = getContext();
        const value = shown && !datesEdited && !context.isLoading && !context.isStale && blockedSnapshot !== snapshotKey(context)
            && signature(context) === requestKey ? machine?.consumer() ?? null : null;
        return publicationCurrent(acceptedPublication) ? value : null;
    }
    function acceptedPair() {
        const comparison = consumer();
        if (!comparison) return null;
        const scope = machine?.scope();
        return scope && publicationCurrent(acceptedPublication) ? { key: `period:${generation}`, revision: comparison.revision, comparison, scope } : null;
    }
    function recordsTarget(entry) {
        const pair = acceptedPair();
        if (!pair || entry?.key !== pair.key || entry.revision !== pair.revision) return null;
        const side = selectedPeriod === "later" ? "B" : "A";
        const tab = root.querySelector("#comparisonRecords" + side);
        const region = root.querySelector("#comparison-record-scroll-" + side) || root.querySelector("#comparisonExactRecords" + side);
        return tab?.isConnected && region?.isConnected && publicationCurrent(acceptedPublication) ? { tab, region } : null;
    }
    function observe(value) {
        if (!publicationCurrent(publicationToken())) { withdrawAccess(); return; }
        const context = getContext();
        if (!value?.basis || JSON.stringify(value.basis) === JSON.stringify(context.snapshot?.assessment?.basis)
            && !(value.pendingCleanup && value.kind !== "artifact-deletion")) return;
        machine?.observe(value); machine?.leave(); generation++; requestKey = ""; blockedSnapshot = snapshotKey(context);
        completionIntent = null;
        syncReport();
        clearResults();
        setStatus("Retained evidence or its permission changed. Read the current stored Analyze view before comparing again.", "notice");
    }
    function withdrawAccess() {
        if (accessWithdrawn) return;
        accessWithdrawn = true; generation++;
        machine?.leave(); machine = null;
        contextKey = ""; requestKey = ""; blockedSnapshot = null; rosterKey = null;
        if (lastRoute) {
            const dates = JSON.parse(lastRoute);
            for (const side of Object.values(dates)) for (const bound of ["from", "to"])
                if (typeof side[bound] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(side[bound])) delete side[bound];
            lastRoute = JSON.stringify(dates);
        }
        completionIntent = null; entryIntent = null;
        outcomeObserver?.disconnect(); outcomeObserver = null;
        const clearText = host => {
            const walker = doc.createTreeWalker(host, doc.defaultView.NodeFilter.SHOW_TEXT | doc.defaultView.NodeFilter.SHOW_COMMENT);
            while (walker.nextNode()) walker.currentNode.data = "";
        };
        for (const host of [scope, status, resultTitle, output]) clearText(host);
        scope.textContent = ""; scope.hidden = true;
        searchInput.value = ""; searchInput.defaultValue = "";
        for (const input of [...Object.values(inputs), ...Object.values(presets)]) input.removeAttribute("aria-invalid");
        const control = doc.getElementById("outcomeFilter"), labels = results.labels(outcomeLayer);
        if (control) {
            for (const option of [...control.options]) {
                const label = labels[option.value];
                clearText(option);
                if (option.hasAttribute("data-count")) option.getAttributeNode("data-count").value = "";
                if (label === undefined) {
                    for (const attribute of [...option.attributes]) attribute.value = "";
                    option.remove(); continue;
                }
                option.textContent = label; option.dataset.optionLabel = label;
                delete option.dataset.count;
            }
            if (control.hasAttribute("data-options-signature")) control.getAttributeNode("data-options-signature").value = "";
            delete control.dataset.optionsSignature;
        }
        setStatus("");
        // Scrub retained node handles as well as removing the mounted subtree.
        for (const node of output.querySelectorAll("*")) {
            node.replaceChildren();
            for (const attribute of [...node.attributes]) {
                if (node.namespaceURI !== "http://www.w3.org/2000/svg" || !(node.localName === "svg" && ["width", "height", "viewBox"].includes(attribute.name))
                    && !(node.localName === "rect" && ["width", "height", "x", "y", "rx", "ry"].includes(attribute.name))
                    && !(node.localName === "circle" && ["cx", "cy", "r"].includes(attribute.name))
                    && !(node.localName === "ellipse" && ["cx", "cy", "rx", "ry"].includes(attribute.name))
                    && !(["line", "linearGradient"].includes(node.localName) && ["x1", "x2", "y1", "y2"].includes(attribute.name))
                    && !(node.localName === "stop" && attribute.name === "offset")) attribute.value = "";
                node.removeAttributeNode(attribute); attribute.value = "";
            }
        }
        shown = false; root.hidden = true; setup.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
        clearResults();
    }
    function resumeAccess() {
        const token = publicationToken();
        if (token == null || typeof api.isCurrent !== "function" || api.isCurrent(token) !== true) return false;
        accessWithdrawn = false;
        return true;
    }
    const workspace = doc.getElementById("workspace");
    if (workspace) new MutationObserver(() => { if (shown) update(); }).observe(workspace, { attributes: true, attributeFilter: ["aria-busy"] });
    return { update, consumer, observe, acceptedPair, recordsTarget, stop, withdrawAccess, resumeAccess };
}

export const periodComparisonStyles = `
.compare-native :is(th,td):not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
.compare-native thead{background:transparent}
.period-comparing #homeView,.period-comparing #activityView,
.period-comparing :is(#periodResult,#periodHint,#periodCoverage),
.period-comparing #viewingContext,.period-comparing #serviceEvidenceSummary,.period-comparing #sessionAnalysis,
.period-comparing #createSessionReport,.period-comparing #reportSelectionBar,
.period-comparing #filters .filter-field:has(#dateFilter),
.period-comparing #dateFields,.period-comparing #filterChips [aria-label^="Remove date filter:"]{display:none!important}
.period-comparing #filterHeading{display:none}
.period-comparing #workspace>:is(.page-heading,#analyzePopulation,#periodComparison,#coverage){width:100%;max-width:82rem}
.period-comparing #workspace>#analyzePopulation{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;padding:20px;container:compare-scope / inline-size}
.period-comparing #periodComparisonSetup,.period-comparing #filters{grid-column:1/-1}
.period-comparing #filters{margin-block:0}
.period-comparing #collectionNotice{grid-column:1;grid-row:3;align-self:center;font-size:.75rem;margin-block:0;padding-block:4px}
.period-comparing #appliedFilters{grid-column:2;grid-row:3;margin-block:0}
.period-comparing #appliedFilters:has(#filterChips:not(:empty)){grid-column:1/-1;grid-row:4}
.period-comparing .page-heading{align-items:center;gap:8px 24px;margin-bottom:16px}
.period-comparing .page-heading>div:first-child{flex-basis:20rem}
.period-comparing #analyzeToolbar{margin:0;container-type:normal}
.period-comparing #coverage{margin-top:20px;border-top:1px solid var(--surface-divider)}
.period-comparing #coverage>summary{min-height:44px;padding-block:12px;font-size:var(--type-control);font-weight:var(--weight-regular);color:var(--muted)}
.period-comparison{margin-block:16px var(--space-lg);min-width:0;container:comparison-results / inline-size}
.period-comparison:has(>#periodComparisonResults:empty){margin:0}
#periodComparisonSetup{min-width:0;container:comparison-setup / inline-size}
.period-comparison-heading{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px 16px;margin-bottom:8px}
.period-comparison-heading h2{margin:0;font-size:var(--type-section)}
.period-comparison-heading button{min-height:44px;max-width:100%;white-space:normal}
.period-comparison-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 32px;align-items:start;margin:0}
.period-comparison-controls fieldset{position:relative;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));min-width:0;gap:8px 12px;border:0;padding:0;margin:0;align-items:start}
.period-comparison-controls fieldset+fieldset::before{content:"";position:absolute;inset-block:0;inset-inline-start:-16px;border-inline-start:1px solid var(--surface-divider)}
.period-comparison-controls legend{float:left;grid-column:1/-1;font-size:var(--type-body);line-height:var(--leading-ui);font-weight:var(--weight-medium);padding:0;margin:0}
.comparison-preset-field,.comparison-preset-range{grid-column:1/-1}
.period-comparison-controls .comparison-preset-field{gap:0}
.comparison-preset-field .select-control,.comparison-preset-field button{width:100%;min-width:0}
.comparison-preset-field button{min-height:var(--task-field-height)}
.comparison-preset-field .select-trigger::before{inset:0;box-shadow:none}
.comparison-preset-range{margin:0;font-size:var(--type-control);line-height:var(--leading-ui);color:var(--muted);overflow-wrap:anywhere}
.period-comparison-controls label{display:grid;gap:4px;min-width:0;font-size:var(--type-control);line-height:var(--leading-ui);font-weight:var(--weight-regular)}
.period-comparison-controls input{display:block;box-sizing:border-box;min-width:0;width:100%;height:var(--task-field-height);font:var(--type-control)/var(--leading-control) var(--font);padding-block:8px}
.period-comparison-controls>button{grid-column:1/-1;justify-self:end;min-height:44px;white-space:normal;max-width:100%;margin:0}
#periodComparisonSetup .search-label{max-width:32rem}
#periodComparisonSetup .context-help-note{max-width:none;margin:4px 0;font-size:.75rem}
#periodComparisonStatus.error,#periodComparisonStatus.notice{margin:8px 0;overflow-wrap:anywhere}
.period-comparison-scope{overflow-wrap:anywhere}
#periodComparisonResultsTitle{scroll-margin-top:0}
.compare-period-key{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:start}
.compare-period-key p{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin:0;min-width:0;max-width:100%}
.compare-period-key p+p{border-left:1px solid var(--control);padding-left:24px}
.compare-period-name{font:inherit;color:var(--ink)}
.compare-period-key .compare-period-name{font-weight:var(--weight-medium)}
.compare-caption{font-size:.8125rem;line-height:1.5;color:var(--muted);margin:6px 0 0;max-width:none}
.compare-date-qualification,.compare-observation{color:var(--muted)}
.compare-peer-facts{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-sm) var(--space-lg)}
.compare-peer-facts>span{min-width:0;max-width:100%;overflow-wrap:anywhere}
.compare-peer-facts .compare-number{color:var(--ink)}
.compare-timing-coverage{display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--space-xs) var(--space-lg)}
.compare-timing-coverage>.compare-peer-facts{flex:1 1 20rem;min-width:0;margin:0;font:inherit}
.compare-period-key+.compare-caption{margin-top:8px}
.compare-answer-grid{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:12px 28px;margin:16px 0;padding:20px;background:var(--paper);border-radius:var(--radius)}
.compare-panel{min-width:0;padding:16px;background:var(--paper);border-radius:var(--radius);container:comparison-panel / inline-size}
.compare-answer-grid>.compare-panel{display:grid;grid-template-rows:subgrid;grid-row:span 4;align-items:start;padding:0;background:none;border-radius:0}
.compare-answer-grid>.compare-panel>:is(h3,.compare-findings,.compare-caption,.compare-values-table){margin:0}
.compare-panel h3{font-size:1.125rem;margin:0 0 8px}
.compare-panel h4{font-size:.875rem;margin:0}
.compare-findings{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 8px;margin:8px 0}
.compare-findings>p{margin:0}
.compare-finding{font-size:1.125rem;line-height:1.5}
.compare-number,.compare-delta{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.compare-worse{color:var(--chart-failure)}.compare-better{color:var(--chart-success)}
.compare-outcome-row{min-width:0}
.compare-bar-heading{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px}
.compare-outcome-bar{height:12px;display:flex;background:var(--canvas);border-radius:2px;overflow:hidden;margin-top:6px}
.compare-mark-success{background:var(--chart-success)}.compare-mark-failure{background:var(--chart-failure)}
.compare-mark-partial{background:var(--chart-partial)}.compare-mark-unknown{background:var(--chart-unknown)}
.compare-mark-other{background:var(--warning)}.compare-mark-transport{background:var(--danger)}
.compare-values-table,.compare-whole-table{width:100%;table-layout:fixed;border-collapse:collapse;margin:14px 0 0;font-size:.875rem}
.compare-values-table th,.compare-values-table td,.compare-whole-table th,.compare-whole-table td{font:inherit;font-weight:var(--weight-regular);text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--surface-divider);overflow-wrap:normal;font-variant-numeric:tabular-nums}
.compare-values-table tr>:first-child{width:34%;padding-left:0}
.compare-latency .compare-values-table tr>:first-child{width:28%}
.compare-latency .compare-values-table tr>:last-child{width:44%}
.compare-values-table tr>:last-child,.compare-whole-table tr>:last-child{padding-right:0}
.compare-values-table tr>*+*,.compare-whole-table tr>*+*{border-left:1px solid var(--surface-divider)}
.compare-values-table thead th,.compare-whole-table thead th{color:var(--muted);padding-top:0;padding-bottom:8px}
.compare-outcome-values thead th:not(:first-child){vertical-align:bottom}
.compare-values-table p,.compare-whole-table p{font:inherit;margin:0}
.compare-timing-value{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.compare-whole-table p+p{margin-top:4px}
.compare-whole-table tr>:first-child{padding-left:0}
.compare-whole-table{margin-top:8px}
.compare-swatch{width:8px;height:8px;display:inline-block;margin-right:8px}
.compare-scope-note{font-size:.8125rem;line-height:1.5;margin:12px 0 0;padding-left:10px;border-left:2px solid var(--control);color:var(--muted)}
.compare-empty{padding:18px 0;color:var(--muted);font-size:.875rem}
.compare-evidence,.compare-full-timing{margin-top:16px}
.compare-evidence-tabs{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:6px}
.compare-evidence-tabs button{min-height:44px;max-width:100%;border-radius:0;white-space:normal;text-align:left;overflow-wrap:anywhere}
.compare-evidence-tabs button[aria-selected=true]{box-shadow:inset 0 -2px var(--ink)}
.period-comparison-table{overflow:auto;max-width:100%;max-height:340px;margin:8px 0 0}
.period-comparison-table table{width:100%;border-collapse:collapse;font-size:.875rem;font-variant-numeric:tabular-nums}
.period-comparison-table thead{background:var(--paper)}
.period-comparison-table thead th{font-weight:var(--weight-regular);color:var(--muted);position:sticky;top:0;background:var(--paper);z-index:1}
.period-comparison-table th,.period-comparison-table td{text-align:left;vertical-align:top;border-bottom:1px solid var(--surface-divider);padding:7px 10px;white-space:normal;overflow-wrap:anywhere;font-weight:var(--weight-regular)}
.period-comparison-table tr>:first-child{padding-left:0;width:34%}
.period-comparison-table tr>:nth-child(2){width:30%}
.period-comparison-table tr>:nth-child(3){width:14%}
.period-comparison-table tr>:last-child{padding-right:0}
.period-comparison-table tr>*+*{border-left:1px solid var(--surface-divider)}
.compare-record-identity{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.compare-record-identity>a{flex-shrink:0;max-width:100%}
.compare-record-context{font-size:.8125rem;color:var(--muted);font-weight:var(--weight-regular);min-width:0;max-width:100%}
.compare-record-failure,.compare-record-transport{color:var(--chart-failure)}.compare-record-success{color:var(--chart-success)}
.compare-full-timing{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:24px}
.compare-full-timing>h3,.compare-full-timing>.compare-caption{grid-column:1/-1}
.compare-whole-measure{padding:10px 0 0;border-top:1px solid var(--surface-divider);margin-top:12px;min-width:0}
@container comparison-results (max-width:64rem){
 .compare-answer-grid,.compare-full-timing{grid-template-columns:minmax(0,1fr)}
 .compare-answer-grid{row-gap:12px;padding:16px}
 .compare-answer-grid>.compare-panel+.compare-panel{border-top:1px solid var(--surface-divider);padding-top:16px;margin-top:4px}
}
@container comparison-setup (min-width:66rem){
 .period-comparison-controls fieldset{grid-template-columns:minmax(0,1.2fr) repeat(2,minmax(0,1fr))}
 .period-comparison-controls legend{grid-column:1;grid-row:1}
 .comparison-preset-field{grid-column:1;grid-row:2}
 .period-comparison-controls .comparison-date-field{grid-row:1/span 2;grid-template-rows:subgrid;row-gap:inherit;align-self:stretch}
 .comparison-preset-range{grid-column:2/-1;grid-row:2;align-self:center}
}
@container comparison-setup (max-width:44rem){
 .period-comparison-controls{grid-template-columns:minmax(0,1fr);gap:16px}
 .period-comparison-controls fieldset+fieldset{border-top:1px solid var(--surface-divider);padding-top:12px}
 .period-comparison-controls fieldset+fieldset::before{display:none}
}
@container comparison-results (max-width:38rem){
 .compare-period-key{display:block}.compare-period-key p+p{border:0;padding-left:0;margin-top:12px}
}
@container comparison-panel (max-width:27rem){
 .compare-values-table thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
 .compare-values-table tbody{display:block}
 .compare-values-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:auto auto auto;border-top:1px solid var(--surface-divider)}
 .compare-values-table tr>:first-child{grid-column:1/-1;border:0;padding:10px 0 0}
 .compare-panel .compare-values-table tr>:is(:first-child,:last-child){width:auto}
 .compare-values-table td{display:grid;grid-template-rows:subgrid;grid-row:2/span 2;padding:8px 0 10px;border-bottom:0;border-left:0}
 .compare-values-table td:nth-child(2){grid-column:1;padding-right:12px}
 .compare-values-table td:last-child{grid-column:2;padding-left:12px;border-left:1px solid var(--control)}
 .compare-values-table td::before{content:attr(data-label);display:block;line-height:1.5;margin-bottom:6px;color:var(--muted)}
 .compare-outcome-values thead{display:block;position:static;width:auto;height:auto;overflow:visible;clip-path:none}
 .compare-outcome-values thead tr{grid-template-rows:auto;align-items:end;border:0}
 .compare-outcome-values thead tr>th:first-child{display:none}
 .compare-outcome-values thead th{padding:0 12px 10px 0}
 .compare-outcome-values thead th:last-child{padding:0 0 10px 12px}
}
@container comparison-results (max-width:42rem){
 .period-comparison-table{max-height:420px}.period-comparison-table thead{display:none}
 .period-comparison-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;border-bottom:1px solid var(--surface-divider);padding:12px 0}
 .period-comparison-table tr>*{display:block;width:auto!important;border:0!important;padding:0}
 .period-comparison-table tr>:first-child,.period-comparison-table tr>:last-child{grid-column:1/-1}
 .period-comparison-table td[data-label]::before{content:attr(data-label);display:block;color:var(--muted)}
}
@media(max-width:600px){
 .period-comparing #workspace>#analyzePopulation{display:block;padding:16px}
 .compare-panel h3{font-size:1.0625rem}
 .compare-period-key{display:block}.compare-period-key p+p{border:0;padding-left:0;margin-top:12px}
 .compare-finding{font-size:1.0625rem}.compare-answer-grid{gap:16px}
}
@container compare-scope (max-width:16rem){.period-comparison-controls fieldset{grid-template-columns:minmax(0,1fr)}}
@media(forced-colors:active){.compare-outcome-bar>span{border:1px solid CanvasText}.compare-evidence-tabs button[aria-selected=true]{border-bottom:2px solid Highlight}}
`;
