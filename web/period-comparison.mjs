// Serialized with the shell. Private text is used only to select the accepted roster.
export function createPeriodComparisonState({ time, search, contract, projection, categories, comparePeriodCohorts, searchContract }) {
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
    function prepare(snapshot, options, periods, query = "", withinServices = [], semanticSearch) {
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
        return { schemaVersion: 1, expectedRevision: snapshot.revision, options: { ...options, filters },
            periods: structuredClone(periods), ...(semanticSearch === undefined ? { scenarioIds } : { semanticSelection: {
                receipt: structuredClone(semanticSearch.receipt),
                ...(semanticSearch.withinScenarioIds === undefined ? {} : { withinScenarioIds: [...semanticSearch.withinScenarioIds] }),
            } }), withinServices: [...withinServices] };
    }
    function begin(input, snapshot, semanticSearch) {
        require(Array.isArray(snapshot.assessment?.catalog));
        pending = { token: ++generation, input: structuredClone(input),
            basis: structuredClone(snapshot.assessment.basis), source: structuredClone(snapshot.assessment.source),
            catalog: structuredClone(snapshot.assessment.catalog), unit: snapshot.analytics.unit,
            scenarios: structuredClone(snapshot.scenarios),
            semanticMembership: input.semanticSelection ? semanticScope(semanticSearch, snapshot.revision) : null };
        if (input.semanticSelection) {
            validateNarrowing(input.semanticSelection.withinScenarioIds, snapshot.scenarios);
            require(searchContract.sameReceipt(input.semanticSelection.receipt, semanticSearch.receipt)
                && same(input.semanticSelection.withinScenarioIds, semanticSearch.withinScenarioIds));
        }
        accepted = null;
        return generation;
    }
    function accept(token, value) {
        if (pending?.token !== token) return false;
        accepted = null;
        const { input, basis, source, catalog, unit, scenarios, semanticMembership } = pending;
        require(value?.kind === "retained-period-comparison" && value.schemaVersion === 1 && value.revision === input.expectedRevision
            && same(value.assessmentBasis, basis) && same(value.source, source)
            && same(value.timeContext, time.normalize(input.options.timeContext))
            && same(value.options, input.options) && same(value.selection, { ...(semanticMembership ? { semanticMembership,
                ...(input.semanticSelection.withinScenarioIds === undefined ? {} : { withinScenarioIds: input.semanticSelection.withinScenarioIds }) }
                : { scenarioIds: input.scenarioIds }), withinServices: input.withinServices })
            && value.definitions?.activitySchemaVersion === 2 && value.definitions.layer === (input.options.layer ?? "tool")
            && value.definitions.unit === unit
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
        accepted = structuredClone(value);
        return true;
    }
    function leave() { generation++; pending = null; accepted = null; }
    function observe(status) {
        if (!status?.basis || !pending) return false;
        if (same(status.basis, pending.basis) && !(status.pendingCleanup && status.kind !== "artifact-deletion")) return false;
        leave(); return true;
    }
    return { prepare, begin, accept, leave, observe, consumer: () => accepted ? structuredClone(accepted) : null };
}

export function mountPeriodComparison({ root, setup = root, toggle, api, time, search, categories, results, projection, createState,
    assessmentFactories, bindDetails, getContext, navigate, onSearch, recordLink, syncFilters, createReport, openSearch }) {
    const doc = root.ownerDocument;
    let machine, presentation, contractPromise, contextKey = "", requestKey = "", generation = 0, lastRoute = "", shown = false, blockedSnapshot = null, outcomeObserver = null, datesEdited = false;
    let completionIntent = null;
    const snapshotKey = context => JSON.stringify([context.snapshot?.revision, context.snapshot?.assessment?.basis, context.snapshot?.assessment?.source]);
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
    const heading = el("div", undefined, "period-comparison-heading"), title = el("h2", "Compare periods");
    title.id = "periodComparisonTitle"; title.tabIndex = -1;
    const stop = button("Stop comparing", () => { navigate({ compare: undefined }); toggle.focus(); });
    stop.title = "Return to Analyze with your dates and filters kept";
    heading.append(title, stop);
    const form = el("form", undefined, "period-comparison-controls");
    form.setAttribute("aria-label", "Comparison periods");
    const inputs = {};
    for (const [side, label] of [["a", "Period A"], ["b", "Period B"]]) {
        const group = el("fieldset"); group.append(el("legend", label));
        for (const [bound, text] of [["From", "From"], ["To", "To"]]) {
            const field = el("label"), input = el("input");
            field.append(el("span", text));
            input.type = "date"; input.id = `comparison${side.toUpperCase()}${bound}`; input.required = true;
            input.setAttribute("aria-label", `${label} ${text.toLowerCase()}`);
            input.setAttribute("aria-describedby", "comparisonDateHint periodComparisonStatus");
            inputs[side + bound] = input;
            field.append(input); group.append(field);
        }
        form.append(group);
    }
    const apply = el("button", "Compare periods", "primary"); apply.type = "submit"; apply.id = "applyPeriodComparison";
    form.append(apply);
    const dateHint = el("p", undefined, "context-help-note"); dateHint.id = "comparisonDateHint";
    const scopeRow = el("div", undefined, "period-comparison-scope");
    const scope = el("p", undefined, "context-help-note");
    const searchLabel = el("label", "Search these interactions", "search-label"), searchInput = el("input");
    searchInput.type = "search"; searchInput.autocomplete = "off"; searchInput.id = "comparisonSearch";
    searchLabel.append(searchInput);
    searchLabel.hidden = typeof openSearch === "function";
    searchInput.addEventListener("input", () => onSearch(searchInput.value));
    searchInput.addEventListener("keydown", event => {
        if (event.key === "Escape" && searchInput.value) { searchInput.value = ""; onSearch(""); event.preventDefault(); }
    });
    const status = el("p", undefined, "context-help-note"); status.id = "periodComparisonStatus"; status.setAttribute("role", "status");
    status.hidden = true;
    function setStatus(message, className = "context-help-note") {
        status.textContent = message; status.className = className; status.hidden = !message;
    }
    const output = el("div"); output.id = "periodComparisonResults"; output.tabIndex = -1;
    const report = button("Create comparison report", () => {
        const value = consumer();
        if (value) createReport?.(value, getContext().semanticSearch ? { receipt: structuredClone(getContext().semanticSearch.receipt),
            ...(value.selection.withinScenarioIds === undefined ? {} : { withinScenarioIds: [...value.selection.withinScenarioIds] }),
        } : undefined);
    });
    report.id = "createPeriodReport"; report.disabled = true; report.hidden = true;
    const resultHeading = el("div", undefined, "period-comparison-heading");
    const resultTitle = el("h2", "What differs"); resultTitle.id = "periodComparisonResultsTitle"; resultTitle.tabIndex = -1;
    resultHeading.append(resultTitle, report); resultHeading.hidden = true;
    scopeRow.append(scope);
    if (typeof openSearch === "function") scopeRow.append(button("Search this comparison", openSearch));
    setup.append(heading, form, dateHint, status, scopeRow, searchLabel);
    root.append(resultHeading, output);
    function syncReport(value = null) {
        report.disabled = !createReport || !value || !Object.values(value.periods).some(side => side.scenarioIds.length);
        report.hidden = report.disabled;
    }
    function clearResults() {
        syncReport(); resultHeading.hidden = true; output.replaceChildren(); output.removeAttribute("aria-busy");
    }
    for (const input of Object.values(inputs)) {
        input.addEventListener("input", () => {
            completionIntent = null;
            datesEdited = true; generation++; machine?.leave(); requestKey = "";
            clearResults(); syncOutcomeChoices();
            for (const field of Object.values(inputs)) field.removeAttribute("aria-invalid");
            setStatus(Object.values(periods(getContext().route)).every(period => period.from && period.to)
                ? "Dates changed. Compare periods to see the updated results." : "");
        });
        input.addEventListener("invalid", () => {
            completionIntent = null;
            input.setAttribute("aria-invalid", "true");
            setStatus("Choose a valid start and end date for both periods.", "error");
        });
    }
    toggle.setAttribute("aria-controls", setup === root ? root.id : `${setup.id} ${root.id}`);
    toggle.addEventListener("click", () => navigate({ compare: shown ? undefined : "periods" }));
    form.addEventListener("submit", event => {
        event.preventDefault();
        const changes = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
        let invalidSide;
        try {
            for (const prefix of ["a", "b"]) {
                invalidSide = prefix;
                time.calendar(changes[prefix + "From"]); time.calendar(changes[prefix + "To"]);
                time.range({ from: changes[prefix + "From"], to: changes[prefix + "To"] }, getContext().options.timeContext.timeZone);
            }
            for (const input of Object.values(inputs)) input.removeAttribute("aria-invalid");
            const context = getContext();
            completionIntent = { trigger: doc.activeElement, readingIntent: context.readingIntent,
                key: signature({ ...context, route: { ...context.route, ...changes, compare: "periods" } }) };
            datesEdited = false; requestKey = ""; navigate({ ...changes, compare: "periods" });
        } catch (error) {
            completionIntent = null;
            setStatus(`Period ${invalidSide.toUpperCase()}: ${error.message}`, "error");
            inputs[invalidSide + "From"].setAttribute("aria-invalid", "true");
            inputs[invalidSide + "To"].setAttribute("aria-invalid", "true");
            inputs[invalidSide + "From"].focus();
        }
    });
    const dialog = el("dialog", undefined, "assessment-dialog"), dialogHead = el("div", undefined, "dialog-head");
    let detailTrigger;
    dialog.setAttribute("aria-label", "Comparison measure definitions");
    dialogHead.append(el("h2", "Measure definitions"), button("Close", () => dialog.close()));
    const dialogBody = el("div", undefined, "assessment-dialog-body");
    dialog.append(dialogHead, dialogBody); root.append(dialog);
    dialog.addEventListener("close", () => { if (detailTrigger?.isConnected && detailTrigger.checkVisibility()) detailTrigger.focus(); });
    function showDefinitions(model, trigger) {
        detailTrigger = trigger; dialogBody.replaceChildren(el("p", model.takeaway));
        for (const row of [...Object.values(model.groups).flat(), ...model.diagnostics]) {
            const section = el("section", undefined, "assessment-definition"), facts = el("ul");
            for (const detail of row.details) facts.append(el("li", detail));
            section.append(el("h3", row.label), facts); dialogBody.append(section);
        }
        dialog.showModal();
    }
    function ready() {
        if (!contractPromise) contractPromise = Promise.all([
            import("/assets/assessment-contract.mjs"), import("/assets/period-comparison-math.mjs"),
        ]).then(([contract, { comparePeriodCohorts }]) => {
            machine = createState({ time, search, contract, projection, categories, comparePeriodCohorts });
            presentation = assessmentFactories.createPresentation(contract);
        }).catch(error => { contractPromise = null; throw error; });
        return contractPromise;
    }
    const periods = route => ({ baseline: { from: route.aFrom, to: route.aTo }, later: { from: route.bFrom, to: route.bTo } });
    function signature(context) {
        return JSON.stringify([context.route.view, context.route.compare, context.snapshot?.revision, context.snapshot?.assessment?.basis,
            context.snapshot?.assessment?.source, context.options, periods(context.route), context.search, context.route.withinServices, context.semanticSearch]);
    }
    function table(caption, headers, rows) {
        const wrap = el("div", undefined, "period-comparison-table");
        wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", caption);
        const node = el("table"), head = el("thead"), line = el("tr"), body = el("tbody");
        node.append(el("caption", caption));
        for (const label of headers) { const th = el("th", label); th.scope = "col"; line.append(th); }
        head.append(line);
        for (const cells of rows) {
            const tr = el("tr");
            cells.forEach((value, index) => {
                const cell = el(index ? "td" : "th"); if (!index) cell.scope = "row";
                if (value instanceof doc.defaultView.Node) cell.append(value); else cell.textContent = value;
                tr.append(cell);
            });
            body.append(tr);
        }
        node.append(head, body); wrap.append(node); return wrap;
    }
    const signed = value => value === null ? "Not comparable" : `${value > 0 ? "+" : ""}${number(value)}`;
    const share = (count, total) => `${number(count)} / ${number(total)} (${total ? number(count * 100 / total) + "%" : "Not applicable"})`;
    function countFacts(entries) {
        const facts = el("dl", undefined, "period-count-facts");
        for (const [label, count] of entries) {
            const fact = el("div");
            fact.append(el("dt", label), el("dd", number(count))); facts.append(fact);
        }
        return facts;
    }
    function syncOutcomeChoices(value = null) {
        const control = doc.getElementById("outcomeFilter"), labels = results.labels(getContext().options.layer);
        if (doc.getElementById("outcomeFilter-control")?.getAttribute("aria-expanded") === "true") return;
        const a = value?.periods.baseline.analytics.resultFacet.totals, b = value?.periods.later.analytics.resultFacet.totals;
        for (const option of control.options) option.textContent = labels[option.value] + (a && b ? ` (A: ${number(a[option.value])}; B: ${number(b[option.value])})` : "");
        control.dataset.allLabel = a && b ? `All results (A: ${number(a.count)}; B: ${number(b.count)})` : "All results";
        // Ordinary renderControls must rebuild its own date-scoped labels on exit.
        delete control.dataset.optionsSignature;
        const serviceScope = doc.getElementById("serviceFocusScope");
        if (serviceScope) serviceScope.textContent = "Known service matches and missing-service context are counted separately in the results.";
        syncFilters();
    }
    function paint(value) {
        syncReport(value); resultHeading.hidden = false;
        const { baseline: a, later: b } = value.periods;
        syncOutcomeChoices(value);
        const labels = results.labels(value.definitions.layer);
        const totals = side => side.analytics.totals;
        const rows = [
            ["Matching records", number(a.rowIds.length), number(b.rowIds.length), signed(b.rowIds.length - a.rowIds.length) + " records"],
            ["Selected interactions", number(a.interactionRefs.length), number(b.interactionRefs.length), signed(b.interactionRefs.length - a.interactionRefs.length) + " interactions"],
            ...Object.entries(labels).map(([key, label]) => [label, share(totals(a)[key], a.rowIds.length), share(totals(b)[key], b.rowIds.length),
                value.comparison.outcomes.change[key] === null ? "Not comparable" : signed(value.comparison.outcomes.change[key]) + " percentage points"]),
        ];
        const dateRange = side => side.range.from === side.range.to ? time.formatDate(side.range.from, value.timeContext, true)
            : `${time.formatDate(side.range.from, value.timeContext, true)} - ${time.formatDate(side.range.to, value.timeContext, true)}`;
        const summary = el("p", `A: ${dateRange(a)}. B: ${dateRange(b)}. Differences are B minus A.`, "period-comparison-basis");
        output.replaceChildren(summary);
        if (!a.rowIds.length && !b.rowIds.length) {
            output.append(el("p", "No matching retained activity in either period. Change the dates or filters to compare.", "assessment-empty"));
            return;
        }
        const measures = el("div", undefined, "period-comparison-measures");
        measures.append(table(`Matching ${value.definitions.unit}`, ["Measure", "Period A", "Period B", "Difference"], rows));
        output.append(measures);
        const sharedInteractions = a.interactionRefs.filter(ref => b.interactionRefs.includes(ref)).length;
        if (value.comparison.outcomes.overlap.sharedCount || sharedInteractions) output.append(el("p",
            `Shared across periods: ${number(value.comparison.outcomes.overlap.sharedCount)} matching records; ${number(sharedInteractions)} whole interactions. Counts overlap.`, "notice"));
        if (value.comparison.matchingCallTiming) {
            const timingRows = ["median", "p95"].map(aggregation => {
                const comparison = value.comparison.matchingCallTiming[aggregation];
                const display = fact => `${aggregation === "p95" && fact.coverage.count < 2 ? "Not shown without multiple samples"
                    : fact.state === "available" ? number(fact.value) + " ms" : "Not measured"}; ${fact.coverage.count} / ${fact.coverage.eligible} calls timed${fact.coverage.count === 1 ? "; single sample" : ""}`;
                return [aggregation === "median" ? "Median call duration" : "P95 call duration", display(comparison.baseline), display(comparison.later),
                    comparison.delta && (aggregation !== "p95" || Math.min(comparison.baseline.coverage.count, comparison.later.coverage.count) > 1)
                        ? signed(comparison.delta.value) + " ms" : "Not comparable"];
            });
            const timing = el("div");
            timing.append(table("Matching call duration", ["Timing", "Period A", "Period B", "Difference"], timingRows),
                el("p", "Recorded start to completion; timed calls only.", "context-help-note"));
            measures.append(timing);
        } else measures.append(el("p", "Call duration is unavailable for this evidence type.", "context-help-note"));
        const detailTitle = el("h2", "Whole interactions"); detailTitle.id = "periodInteractionDetailsTitle";
        output.append(detailTitle, el("p", "Includes calls outside the selected dates or filters.", "context-help-note"));
        const sides = el("div", undefined, "period-comparison-sides");
        for (const [key, side, label] of [["baseline", a, "Period A"], ["later", b, "Period B"]]) {
            const section = el("section", undefined, "period-comparison-side"); section.dataset.periodSide = key;
            section.append(el("h3", label), countFacts([["Interactions", side.interactionRefs.length]]));
            const service = side.analytics.serviceInvolvement;
            const coverage = service.selection.services.length ? [
                ["Known service matches", service.selection.knownMatchIds.length],
                ["Missing-service context", service.selection.contextOnlyIds.length],
            ] : service.missingDetailCount ? [["Missing service details", service.missingDetailCount]] : [];
            if (coverage.length) {
                const scope = el("div", undefined, "period-matching-coverage");
                scope.append(el("h4", "Matching records"), countFacts(coverage)); section.append(scope);
            }
            if (side.unmappedScenarioIds.length) section.append(el("p", `${side.unmappedScenarioIds.length} request groups could not be linked to interactions. Findings unavailable.`, "notice"));
            if (side.analytics.apiCoverage) section.append(countFacts([
                ["Matching returned entries", side.analytics.apiCoverage.selectedResultUnits],
                ["Parent calls before outcome/path filters", side.analytics.apiCoverage.eligibleToolCalls],
            ]));
            if (!side.rowIds.length) section.append(el("p", "No matching retained activity in this period. No findings or timing are inferred.", "assessment-empty"));
            const findingsHost = el("div"), insights = el("div");
            findingsHost.dataset.presentation = "comparison";
            section.append(findingsHost, insights);
            if (side.interactionRefs.length) {
                const model = presentation.summarize(side.assessment.metrics, {
                    membershipStatus: side.unmappedScenarioIds.length ? "partial" : "complete-retained",
                    reviewStatuses: side.assessment.reviewStatuses, assessmentAttempts: side.assessment.assessmentAttempts,
                });
                assessmentFactories.renderSummary(insights, model, { findingsHost, bindDetails,
                    disclosureKey: "period:" + key + ":" + JSON.stringify(side.interactionRefs),
                    detailsLabel: "Measure definitions", onDetails: trigger => showDefinitions(model, trigger) });
            }
            if (side.rowIds.length) {
                const exact = el("details", undefined, "reading-section"); exact.append(el("summary", `Exact matching records (${side.rowIds.length})`));
                exact.append(table(`${label} exact record membership`, ["Tool or record", "Recorded start", "Outcome", "Duration"], side.analytics.rows.map(row => [
                    recordLink(row, side, value), time.formatTime(row.startedAt, value.timeContext), labels[row.outcome],
                    Number.isFinite(row.durationMs) ? number(row.durationMs) + " ms" : "Not measured",
                ])));
                bindDetails(exact, "period-records:" + key + ":" + JSON.stringify(side.rowIds));
                section.append(exact);
            }
            sides.append(section);
        }
        output.append(sides);
        const deltas = el("details", undefined, "reading-section"); deltas.append(el("summary", "Compare saved checks and full-interaction timing"));
        const formatter = assessmentFactories.createReportComparison();
        const factLabel = (fact, peer) => {
            if (!fact) return formatter.absentPeerLabel(peer);
            const counts = `${fact.coverage.count} / ${fact.coverage.eligible} ${fact.kind === "pass-rate" ? "assessed" : fact.kind === "cost" ? "priced" : "timed"} ${formatter.coverageUnit(fact)}`;
            if (fact.state !== "available") {
                const view = formatter.metricPresentation(fact, fact.metric, { includeOrigin: false });
                return `${view.value}; ${view.note}`;
            }
            return (fact.kind === "pass-rate" ? `${fact.numerator} / ${fact.denominator} passed (${number(fact.numerator * 100 / fact.denominator)}%)`
                : `${number(fact.value)} ${fact.unit}`) + `; ${counts}`;
        };
        deltas.append(table("Saved reviews and measurements by source and method", ["Measure and origin", "Period A", "Period B", "Observed difference"],
            value.comparison.metrics.map(item => {
                const shared = formatter.definitionLabel(item);
                const label = formatter.comparisonLabel(item) + (shared ? " / " + shared : "");
                const side = (name, peer) => {
                    const detail = formatter.sideDefinitionLabel(item, name);
                    return (detail ? detail + ". " : "") + factLabel(item[name], item[peer]);
                };
                const result = item.result;
                const delta = result?.delta ? signed(result.delta.value) + " " + (result.delta.unit === "percentage-points" ? "percentage points" : result.delta.unit) : result?.status === "incompatible"
                    ? "Incompatible definitions" : "Not comparable";
                return [label, side("baseline", "later"), side("later", "baseline"),
                    delta + (result?.warnings.length ? "; " + result.warnings.map(code => formatter.warningLabel(code, item)).join("; ") : "")];
            })));
        bindDetails(deltas, "period-deltas:" + JSON.stringify([a.interactionRefs, b.interactionRefs]));
        output.append(deltas, el("p", "Retained history only. Undated records excluded.", "context-help-note"));
    }
    async function update() {
        syncReport();
        const outcomeTrigger = doc.getElementById("outcomeFilter-control");
        if (outcomeTrigger && !outcomeObserver) {
            outcomeObserver = new MutationObserver(() => {
                if (shown && outcomeTrigger.getAttribute("aria-expanded") !== "true") syncOutcomeChoices(consumer());
            });
            outcomeObserver.observe(outcomeTrigger, { attributes: true, attributeFilter: ["aria-expanded"] });
        }
        const context = getContext(), active = context.route.view === "analyze" && context.route.compare === "periods";
        const entering = active && !shown;
        shown = active; root.hidden = !active; setup.hidden = !active; toggle.hidden = context.route.view !== "analyze";
        toggle.setAttribute("aria-expanded", String(active));
        toggle.textContent = active ? "Close period comparison" : "Compare periods";
        doc.body.classList.toggle("period-comparing", active);
        if (!active) {
            completionIntent = null;
            generation++; machine?.leave(); requestKey = ""; contextKey = ""; datesEdited = false; lastRoute = "";
            if (dialog.open) dialog.close();
            return;
        }
        const routeKey = JSON.stringify(periods(context.route));
        if (routeKey !== lastRoute) {
            for (const [key, input] of Object.entries(inputs)) {
                input.value = context.route[key] ?? ""; input.removeAttribute("aria-invalid");
            }
            lastRoute = routeKey; datesEdited = false;
        }
        if (entering && doc.activeElement === toggle) inputs.aFrom.focus();
        if (searchInput.value !== context.search) searchInput.value = context.search;
        dateHint.textContent = `Both dates included. ${time.label(context.options.timeContext)}.`;
        scope.textContent = "Filters below apply to both periods."
            + (context.semanticSearch ? " Search uses matching interactions and individual records across all pages."
                + (context.semanticSearch.withinScenarioIds !== undefined ? " The private phrase filter narrows that selection further." : "")
                : context.search.trim() ? " The private phrase filter also applies to both periods, across all retained interactions." : "");
        const key = signature(context);
        if (completionIntent?.key !== key) completionIntent = null;
        syncOutcomeChoices(consumer());
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
        const submitted = completionIntent;
        const started = ++generation; machine?.leave(); clearResults();
        if (!Object.values(periods(context.route)).every(period => period.from && period.to)) {
            setStatus(""); return;
        }
        setStatus("Reading both periods...");
        output.setAttribute("aria-busy", "true");
        try {
            await ready();
            if (started !== generation || signature(getContext()) !== key) return;
            const input = machine.prepare(context.snapshot, context.options, periods(context.route), context.search, context.route.withinServices?.split(",") ?? [], context.semanticSearch);
            const token = machine.begin(input, context.snapshot, context.semanticSearch);
            requestKey = key;
            const value = await api("/api/period-comparison", input);
            const current = getContext();
            if (started !== generation || signature(current) !== key || current.isLoading || current.isStale) return;
            if (!machine.accept(token, value)) return;
            paint(value);
            setStatus("Comparison ready.", "visually-hidden");
            const orient = submitted && completionIntent === submitted && submitted.readingIntent === current.readingIntent
                && doc.activeElement === submitted.trigger;
            completionIntent = null;
            if (orient) {
                resultTitle.focus({ preventScroll: true });
                resultTitle.scrollIntoView({ block: "start" });
            }
        } catch (error) {
            if (started !== generation || signature(getContext()) !== key) return;
            completionIntent = null;
            machine?.leave(); clearResults(); setStatus(error.message, "error");
            syncOutcomeChoices();
            output.append(button("Retry comparison read", () => { requestKey = ""; update(); }));
        } finally {
            if (started === generation) output.removeAttribute("aria-busy");
        }
    }
    function consumer() {
        const context = getContext();
        return shown && !datesEdited && !context.isLoading && !context.isStale && blockedSnapshot !== snapshotKey(context)
            && signature(context) === requestKey ? machine?.consumer() ?? null : null;
    }
    function observe(value) {
        const context = getContext();
        if (!value?.basis || JSON.stringify(value.basis) === JSON.stringify(context.snapshot?.assessment?.basis)
            && !(value.pendingCleanup && value.kind !== "artifact-deletion")) return;
        machine?.observe(value); machine?.leave(); generation++; requestKey = ""; blockedSnapshot = snapshotKey(context);
        completionIntent = null;
        syncReport();
        if (dialog.open) dialog.close();
        clearResults();
        setStatus("Retained evidence or its permission changed. Read the current stored Analyze view before comparing again.", "notice");
    }
    const workspace = doc.getElementById("workspace");
    if (workspace) new MutationObserver(() => { if (shown) update(); }).observe(workspace, { attributes: true, attributeFilter: ["aria-busy"] });
    return { update, consumer, observe };
}

export const periodComparisonStyles = `
.period-comparing #homeView,.period-comparing #activityView,.period-comparing #periodFeedback,
.period-comparing #viewingContext,.period-comparing #serviceEvidenceSummary,.period-comparing #sessionAnalysis,
.period-comparing #pageAction,.period-comparing #createSessionReport,.period-comparing #reportSelectionBar,
.period-comparing #resultsLink,.period-comparing #filters .filter-field:has(#dateFilter),
.period-comparing #dateFields,.period-comparing #filterChips [aria-label^="Remove date filter:"]{display:none!important}
.period-comparison{margin-block:var(--space-lg);min-width:0;container:comparison-results / inline-size}
.period-comparison:has(>#periodComparisonResults:empty){margin:0}
#periodComparisonSetup{min-width:0;container:comparison-setup / inline-size;border-bottom:1px solid var(--rule);padding-bottom:8px;margin-bottom:8px}
.period-comparison-heading{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px 16px;margin-bottom:12px}
.period-comparison-heading h2{margin:0;font-size:var(--type-section)}
.period-comparison-heading button{min-height:44px;max-width:100%;white-space:normal}
.period-comparison-controls{display:flex;gap:12px 24px;align-items:end;flex-wrap:wrap;margin:0;max-width:66rem}
.period-comparison-controls fieldset{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));flex:1 1 19rem;min-width:0;gap:8px;border:0;padding:0;margin:0}
.period-comparison-controls legend{font-weight:var(--weight-strong);padding:0;margin-bottom:4px}
.period-comparison-controls label{display:grid;gap:4px;min-width:0;font-size:var(--type-small)}
.period-comparison-controls input{display:block;box-sizing:border-box;min-width:0;width:100%;min-height:44px;font:inherit}
.period-comparison-controls>button{min-height:44px;white-space:normal;max-width:100%}
#periodComparisonSetup .search-label{max-width:32rem}
#periodComparisonSetup .context-help-note{max-width:none;margin:8px 0}
#periodComparisonStatus.error,#periodComparisonStatus.notice{margin:8px 0;overflow-wrap:anywhere}
.period-comparison-scope{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:0 16px;overflow-wrap:anywhere}
.period-comparison-scope>p{flex:1 1 22rem}
.period-comparison-scope>button{min-height:44px;max-width:100%;white-space:normal;text-align:start}
.period-comparison-basis{overflow-wrap:anywhere;font-size:var(--type-small);color:var(--muted);margin:0}
.period-comparison-measures{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:24px;align-items:start}
.period-comparison-measures>div{min-width:0}
.period-comparison .context-help-note{max-width:90ch}
.period-comparison-sides{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-block:16px}
.period-comparison-side{min-width:0;border-top:1px solid var(--rule);padding-top:12px}
.period-comparison-side h3{font-size:var(--type-section)}
.period-comparison-side>p{font-size:var(--type-small);margin:8px 0}
.period-count-facts{display:flex;flex-wrap:wrap;gap:8px 24px;margin:8px 0;font-size:var(--type-small)}
.period-count-facts>div{display:flex;gap:8px;align-items:baseline}
.period-count-facts dt{color:var(--muted)}
.period-count-facts dd{margin:0;font-weight:var(--weight-strong);font-variant-numeric:tabular-nums}
.period-matching-coverage{margin:12px 0}
.period-matching-coverage h4{font-size:var(--type-small);margin:0;font-weight:var(--weight-regular)}
.period-comparison-side .assessment-findings{font-size:var(--type-small);margin:16px 0}
.period-outcome-heading{font-size:var(--type-small);font-weight:var(--weight-strong);margin:0 0 8px}
.period-outcome-counts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:0 0 12px}
.period-outcome-counts>div{display:grid;grid-template-rows:auto 1fr;gap:4px;min-width:0}
.period-outcome-counts dt{grid-row:2;font-size:var(--type-small)}
.period-outcome-counts dd{grid-row:1;margin:0;font-size:var(--type-data-value);font-weight:var(--weight-strong);font-variant-numeric:tabular-nums}
.period-cause{display:flex;align-items:baseline;justify-content:space-between;gap:8px;border-top:1px solid var(--rule);padding-top:8px}
.period-cause-count{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.period-comparison-side .assessment-compact-verdicts{display:grid;grid-template-columns:fit-content(50%) minmax(0,1fr) auto;gap:8px 12px}
.period-comparison-side .assessment-compact-verdicts li{display:grid;grid-column:1/-1;grid-template-columns:subgrid;gap:4px 12px;align-items:baseline}
.period-review-result{display:flex;flex-wrap:wrap;gap:4px 8px;min-width:0}
.period-review-coverage{color:var(--muted);font-size:var(--type-caption)}
.period-comparison-side .assessment-summary{margin-block:8px}
.period-comparison-table{overflow:auto;max-width:100%;margin-block:var(--space-lg)}
.period-comparison-table table{width:100%;border-collapse:collapse;font-size:var(--type-small);font-variant-numeric:tabular-nums}
.period-comparison-table caption{text-align:left;font-weight:var(--weight-strong);margin-block-end:var(--space-sm)}
.period-comparison-table th,.period-comparison-table td{text-align:left;vertical-align:top;white-space:normal;overflow-wrap:anywhere;padding:8px;border-bottom:1px solid var(--rule)}
.period-comparison-table thead{background:var(--canvas)}
.period-comparison .assessment-dialog{max-width:min(52rem,calc(100vw - 2rem))}
@container comparison-results (max-width:58rem){.period-comparison-measures{grid-template-columns:minmax(0,1fr);gap:0}}
@container comparison-results (max-width:42rem){.period-comparison-sides{grid-template-columns:minmax(0,1fr)}.period-comparison-table table{min-width:30rem}}
@container comparison-results (max-width:42rem){.period-comparison-side .assessment-compact-verdicts{grid-template-columns:fit-content(50%) minmax(0,1fr)}.period-review-coverage{grid-column:2}}
@container comparison-setup (max-width:25rem){.period-comparison-controls fieldset{grid-template-columns:minmax(0,1fr)}}
`;
