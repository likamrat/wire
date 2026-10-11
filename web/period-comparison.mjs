// Serialized with the shell. Private text is used only to select the accepted roster.
export function createPeriodComparisonState({ time, search, contract, projection, categories, comparePeriodCohorts }) {
    if (typeof comparePeriodCohorts !== "function") throw new TypeError("The shared comparison derivation is required.");
    let generation = 0, pending = null, accepted = null;
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const sameIds = (a, b) => Array.isArray(a) && Array.isArray(b) && same([...a].sort(), [...b].sort());
    const orderedRows = rows => [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const require = condition => { if (!condition) throw new Error("Comparison facts do not match the accepted revision, definitions or exact membership. Read the current Analyze view."); };
    function semanticScope(value, revision) {
        const receipt = value?.receipt;
        require(value?.status === "ready" && value.coverage === "whole-retained-corpus"
            && receipt && Object.keys(receipt).length === 8
            && typeof receipt.panelId === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(receipt.panelId)
            && ["epoch", "requestId", "generation", "revision"].every(key => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0)
            && ["indexId", "modelId"].every(key => typeof receipt[key] === "string" && /^[a-f0-9]{64}$/.test(receipt[key]))
            && ["hybrid", "lexical-only"].includes(receipt.mode) && receipt.revision === revision
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
            require(same(input.semanticSelection.receipt, semanticSearch.receipt)
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

export function mountPeriodComparison({ root, toggle, api, time, search, categories, results, projection, createState,
    assessmentFactories, bindDetails, getContext, navigate, onSearch, recordLink, syncFilters, createReport }) {
    const doc = root.ownerDocument;
    let machine, presentation, contractPromise, contextKey = "", requestKey = "", generation = 0, lastRoute = "", shown = false, blockedSnapshot = null, outcomeObserver = null;
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
    const heading = el("div", undefined, "section-heading"), title = el("h2", "Compare retained periods");
    title.id = "periodComparisonTitle"; title.tabIndex = -1;
    heading.append(title, button("Stop comparing", () => { navigate({ compare: undefined }); toggle.focus(); }));
    const form = el("form", undefined, "period-comparison-controls");
    form.setAttribute("aria-label", "Comparison periods");
    const inputs = {};
    for (const [side, label] of [["a", "Period A"], ["b", "Period B"]]) {
        const group = el("fieldset"); group.append(el("legend", label));
        for (const [bound, text] of [["From", "From"], ["To", "To"]]) {
            const field = el("label", text), input = el("input");
            input.type = "date"; input.id = `comparison${side.toUpperCase()}${bound}`; input.required = true;
            input.setAttribute("aria-label", `${label} ${text.toLowerCase()}`);
            input.setAttribute("aria-describedby", "comparisonDateHint");
            inputs[side + bound] = input;
            field.append(input); group.append(field);
        }
        form.append(group);
    }
    const apply = el("button", "Compare periods", "primary"); apply.type = "submit"; apply.id = "applyPeriodComparison";
    form.append(apply);
    const dateHint = el("p", undefined, "context-help-note"); dateHint.id = "comparisonDateHint";
    const scope = el("p", undefined, "period-comparison-scope");
    const searchLabel = el("label", "Search these interactions", "search-label"), searchInput = el("input");
    searchInput.type = "search"; searchInput.autocomplete = "off"; searchInput.id = "comparisonSearch";
    searchLabel.append(searchInput);
    searchInput.addEventListener("input", () => onSearch(searchInput.value));
    searchInput.addEventListener("keydown", event => {
        if (event.key === "Escape" && searchInput.value) { searchInput.value = ""; onSearch(""); event.preventDefault(); }
    });
    const status = el("p", undefined, "context-help-note"); status.id = "periodComparisonStatus"; status.setAttribute("role", "status");
    const output = el("div"); output.id = "periodComparisonResults"; output.tabIndex = -1;
    const report = button("Create comparison report", () => {
        const value = consumer();
        if (value) createReport?.(value, getContext().semanticSearch ? { receipt: structuredClone(getContext().semanticSearch.receipt),
            ...(value.selection.withinScenarioIds === undefined ? {} : { withinScenarioIds: [...value.selection.withinScenarioIds] }),
        } : undefined);
    });
    report.id = "createPeriodReport"; report.disabled = true;
    const notice = el("p", "Prepare exactly this comparison through Setup, disclosure Review and a separate local Save. No earlier reports are needed.", "context-help-note");
    root.append(heading, form, dateHint, searchLabel, scope, status, output, report, notice);
    toggle.setAttribute("aria-controls", root.id);
    toggle.addEventListener("click", () => navigate({ compare: shown ? undefined : "periods" }));
    form.addEventListener("submit", event => {
        event.preventDefault();
        const changes = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value]));
        try {
            for (const prefix of ["a", "b"]) {
                time.calendar(changes[prefix + "From"]); time.calendar(changes[prefix + "To"]);
                time.range({ from: changes[prefix + "From"], to: changes[prefix + "To"] }, getContext().options.timeContext.timeZone);
            }
            for (const input of Object.values(inputs)) input.removeAttribute("aria-invalid");
            requestKey = ""; navigate({ ...changes, compare: "periods" });
        } catch (error) {
            status.textContent = error.message; status.className = "error";
            for (const input of Object.values(inputs)) input.setAttribute("aria-invalid", "true");
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
    function syncOutcomeChoices(value = null) {
        const control = doc.getElementById("outcomeFilter"), labels = results.labels(getContext().options.layer);
        if (doc.getElementById("outcomeFilter-control")?.getAttribute("aria-expanded") === "true") return;
        const a = value?.periods.baseline.analytics.resultFacet.totals, b = value?.periods.later.analytics.resultFacet.totals;
        for (const option of control.options) option.textContent = labels[option.value] + (a && b ? ` (A: ${number(a[option.value])}; B: ${number(b[option.value])})` : "");
        control.dataset.allLabel = a && b ? `All results (A: ${number(a.count)}; B: ${number(b.count)})` : "All results";
        // Ordinary renderControls must rebuild its own date-scoped labels on exit.
        delete control.dataset.optionsSignature;
        const serviceScope = doc.getElementById("serviceFocusScope");
        if (serviceScope) serviceScope.textContent = "Service choices apply to both periods. Known matches and missing-service context are counted separately on each side below.";
        syncFilters();
    }
    function paint(value) {
        report.disabled = !createReport;
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
        output.replaceChildren(el("p", `Period A: ${a.range.from} to ${a.range.to}. Period B: ${b.range.from} to ${b.range.to}. ${time.label(value.timeContext)}. Stored revision ${value.revision}.`, "period-comparison-basis"),
            table(`Matching ${value.definitions.unit}; B minus A`, ["Measure", "Period A", "Period B", "Observed difference"], rows),
            el("p", value.scope.interpretation, "context-help-note"));
        if (value.comparison.outcomes.overlap.sharedCount) output.append(el("p",
            `${number(value.comparison.outcomes.overlap.sharedCount)} matching records appear in both periods. Each is counted once per side; the cohorts are not independent.`, "notice"));
        const sharedInteractions = a.interactionRefs.filter(ref => b.interactionRefs.includes(ref)).length;
        if (sharedInteractions) output.append(el("p", `${number(sharedInteractions)} full retained interactions appear on both sides, even when their matching calls differ. Do not add their quality or timing populations.`, "context-help-note"));
        if (value.comparison.matchingCallTiming) {
            const timingRows = ["median", "p95"].map(aggregation => {
                const comparison = value.comparison.matchingCallTiming[aggregation];
                const display = fact => `${aggregation === "p95" && fact.coverage.count < 2 ? "Not shown without multiple samples"
                    : fact.state === "available" ? number(fact.value) + " ms" : "Not measured"}; ${fact.coverage.count} / ${fact.coverage.eligible} calls timed${fact.coverage.count === 1 ? "; single sample" : ""}`;
                return [aggregation === "median" ? "Median call duration" : "P95 call duration", display(comparison.baseline), display(comparison.later),
                    comparison.delta && (aggregation !== "p95" || Math.min(comparison.baseline.coverage.count, comparison.later.coverage.count) > 1)
                        ? signed(comparison.delta.value) + " ms" : "Not comparable"];
            });
            output.append(table("Matching calls only: call start to recorded completion", ["Timing", "Period A", "Period B", "Observed difference"], timingRows),
                el("p", "Nearest-rank timing uses retained raw samples only. One sample is not overall performance; missing timing is not zero. Request-to-final-response time is separate below.", "context-help-note"));
        } else output.append(el("p", "Matching-call duration comparison is available for the Work IQ calls layer only. This evidence layer keeps its own units; full-interaction timing remains separate below.", "context-help-note"));
        const sides = el("div", undefined, "period-comparison-sides");
        for (const [key, side, label] of [["baseline", a, "Period A"], ["later", b, "Period B"]]) {
            const section = el("section", undefined, "period-comparison-side"); section.dataset.periodSide = key;
            section.append(el("h3", `${label}: ${side.range.from} to ${side.range.to}`),
                el("p", `${side.rowIds.length} matching records across all pages; ${side.scenarioIds.length} request groups; ${side.interactionRefs.length} verified full interactions.`),
                el("p", side.analytics.serviceInvolvement.selection.services.length
                    ? `${side.analytics.serviceInvolvement.selection.knownMatchIds.length} known selected-service matches; ${side.analytics.serviceInvolvement.selection.contextOnlyIds.length} missing-service context records. Service associations can overlap; each record counts once.`
                    : `No selected-service restriction. ${side.analytics.serviceInvolvement.missingDetailCount} records lack some service detail; no service is inferred.`, "context-help-note"),
                el("p", value.scope.findings, "context-help-note"));
            if (side.unmappedScenarioIds.length) section.append(el("p", `${side.unmappedScenarioIds.length} request groups have no verified interaction association. Their findings are unavailable.`, "notice"));
            if (side.analytics.apiCoverage) section.append(el("p",
                `${side.analytics.apiCoverage.selectedResultUnits} matching returned entries; ${side.analytics.apiCoverage.eligibleToolCalls} eligible parent tool calls before entry outcome/endpoint filters. These are different populations, not extra calls.`, "context-help-note"));
            if (!side.rowIds.length) section.append(el("p", "No matching retained activity in this period. No findings or timing are inferred.", "assessment-empty"));
            const findingsHost = el("div"), insights = el("div");
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
            const exact = el("details", undefined, "reading-section"); exact.append(el("summary", `Exact matching records (${side.rowIds.length})`));
            exact.append(table(`${label} exact record membership`, ["Tool or record", "Recorded start", "Outcome", "Duration"], side.analytics.rows.map(row => [
                recordLink(row, side, value), time.formatTime(row.startedAt, value.timeContext), labels[row.outcome],
                Number.isFinite(row.durationMs) ? number(row.durationMs) + " ms" : "Not measured",
            ])));
            bindDetails(exact, "period-records:" + key + ":" + JSON.stringify(side.rowIds));
            section.append(exact); sides.append(section);
        }
        output.append(sides);
        const deltas = el("details", undefined, "reading-section"); deltas.append(el("summary", "Compare saved checks and full-interaction timing"));
        const factLabel = fact => {
            if (!fact) return "No compatible saved lane on this side";
            const counts = `${fact.coverage.count} / ${fact.coverage.eligible} covered`;
            if (fact.state !== "available") return `${fact.reason}; ${counts}`;
            return (fact.kind === "pass-rate" ? `${fact.numerator} / ${fact.denominator} passed (${number(fact.numerator * 100 / fact.denominator)}%)`
                : `${number(fact.value)} ${fact.unit}`) + `; ${counts}`;
        };
        deltas.append(table("Each origin, evaluator and rubric remains a separate lane", ["Measure and origin", "Period A", "Period B", "Observed difference"],
            value.comparison.metrics.map(item => {
                const fact = item.baseline ?? item.later;
                const label = [fact.metric, fact.qualifiers.checkId ?? fact.definitionId, fact.basis, fact.qualifiers.evaluatorModel,
                    fact.qualifiers.rubricId && `${fact.qualifiers.rubricId} v${fact.qualifiers.rubricVersion}`, fact.boundary].filter(Boolean).join(" / ");
                const result = item.result;
                const delta = result?.delta ? signed(result.delta.value) + " " + result.delta.unit : result?.status === "incompatible"
                    ? "Incompatible definitions" : "Not comparable";
                return [label, factLabel(item.baseline), factLabel(item.later), delta + (result?.warnings.length ? "; " + result.warnings.join(", ") : "")];
            })));
        bindDetails(deltas, "period-deltas:" + JSON.stringify([a.interactionRefs, b.interactionRefs]));
        output.append(deltas, el("p", value.scope.dates, "context-help-note"));
    }
    async function update() {
        report.disabled = true;
        const outcomeTrigger = doc.getElementById("outcomeFilter-control");
        if (outcomeTrigger && !outcomeObserver) {
            outcomeObserver = new MutationObserver(() => {
                if (shown && outcomeTrigger.getAttribute("aria-expanded") !== "true") syncOutcomeChoices(consumer());
            });
            outcomeObserver.observe(outcomeTrigger, { attributes: true, attributeFilter: ["aria-expanded"] });
        }
        const context = getContext(), active = context.route.view === "analyze" && context.route.compare === "periods";
        shown = active; root.hidden = !active; toggle.hidden = context.route.view !== "analyze";
        toggle.setAttribute("aria-expanded", String(active));
        toggle.textContent = active ? "Close period comparison" : "Compare periods";
        doc.body.classList.toggle("period-comparing", active);
        if (!active) {
            generation++; machine?.leave(); requestKey = ""; contextKey = "";
            if (dialog.open) dialog.close();
            return;
        }
        const routeKey = JSON.stringify(periods(context.route));
        if (routeKey !== lastRoute) {
            for (const [key, input] of Object.entries(inputs)) input.value = context.route[key] ?? "";
            lastRoute = routeKey;
        }
        if (searchInput.value !== context.search) searchInput.value = context.search;
        dateHint.textContent = `Both dates included in ${time.label(context.options.timeContext)}. Ordinary Analyze dates are kept for when you stop comparing.`;
        const names = { scope: "Collection", includeMetadata: "Platform metadata", services: "Service", includeMissingService: "Missing-service context",
            sourceSessionIds: "Chat", projectIds: "Project", tools: "Tool", workloads: "Category", outcomes: "Outcome", promptAuthors: "Author", endpoints: "Endpoint", activityTypes: "Activity type" };
        const choices = { scope: { history: "Current", legacy: "Earlier snapshot", all: "Both" },
            promptAuthors: { user: "Your prompts", agent: "Agent prompts", unknown: "Unverified author" },
            outcomes: results.labels(context.options.layer) };
        const display = (value, key) => choices[key]?.[value] ?? (typeof value === "boolean" ? value ? "included" : "excluded" : value ?? "Unscoped");
        const filters = Object.entries(context.options.filters).filter(([key]) => !["from", "to"].includes(key));
        scope.textContent = "Both periods use: " + filters.map(([key, value]) => `${names[key] ?? key}: ${Array.isArray(value) ? value.map(item => display(item, key)).join(", ") : display(value, key)}`).join("; ")
            + (!context.options.filters.promptAuthors ? "; All authors" : "") + (!context.options.filters.outcomes ? "; All outcomes" : "")
            + (!context.options.filters.tools ? "; All tools" : "") + (!context.options.filters.services ? "; All services" : "")
            + (!context.options.filters.sourceSessionIds ? "; All chats" : "") + (!context.options.filters.projectIds ? "; All projects" : "")
            + (context.route.withinServices ? "; also within every named service: " + context.route.withinServices : "")
            + (context.semanticSearch ? ". Search membership applies across the whole retained corpus: interaction hits and exact action hits, not only displayed matches."
                + (context.semanticSearch.withinScenarioIds !== undefined ? " The existing interaction phrase filter also narrows this membership." : "")
                : context.search.trim() ? ". Private search applied to the complete retained interaction roster." : ". No private search.");
        const key = signature(context);
        syncOutcomeChoices(consumer());
        if (context.isLoading || context.isStale || context.semanticSearch && context.semanticSearch.status !== "ready" || blockedSnapshot === snapshotKey(context)) {
            generation++; machine?.leave(); contextKey = key; requestKey = "";
            output.replaceChildren(); output.removeAttribute("aria-busy");
            status.textContent = "The Analyze snapshot is updating or stale. Read the current stored view before comparing.";
            status.className = "notice"; return;
        }
        if (key === contextKey && requestKey) { report.disabled = !createReport || !consumer(); return; }
        contextKey = key; requestKey = "";
        const started = ++generation; machine?.leave(); output.replaceChildren();
        if (!Object.values(periods(context.route)).every(period => period.from && period.to)) {
            status.textContent = "Choose a start and end date for both periods. No comparison has been run.";
            status.className = "context-help-note"; return;
        }
        status.textContent = "Reading both periods from one stored revision..."; status.className = "context-help-note";
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
            status.textContent = "Comparing retained activity only. No source check, capture or assessment was requested.";
        } catch (error) {
            if (started !== generation || signature(getContext()) !== key) return;
            machine?.leave(); output.replaceChildren(); status.textContent = error.message; status.className = "error";
            syncOutcomeChoices();
            output.append(button("Retry comparison read", () => { requestKey = ""; update(); }));
        } finally {
            if (started === generation) output.removeAttribute("aria-busy");
        }
    }
    function consumer() {
        const context = getContext();
        return shown && !context.isLoading && !context.isStale && blockedSnapshot !== snapshotKey(context)
            && signature(context) === requestKey ? machine?.consumer() ?? null : null;
    }
    function observe(value) {
        const context = getContext();
        if (!value?.basis || JSON.stringify(value.basis) === JSON.stringify(context.snapshot?.assessment?.basis)
            && !(value.pendingCleanup && value.kind !== "artifact-deletion")) return;
        machine?.observe(value); machine?.leave(); generation++; requestKey = ""; blockedSnapshot = snapshotKey(context);
        report.disabled = true;
        if (dialog.open) dialog.close();
        output.replaceChildren(); output.removeAttribute("aria-busy");
        status.className = "notice";
        status.textContent = "Retained evidence or its permission changed. Read the current stored Analyze view before comparing again.";
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
.period-comparison{margin-block:var(--space-xl);min-width:0}
.period-comparison-controls{display:flex;gap:var(--space-lg);align-items:end;flex-wrap:wrap;margin-block:var(--space-lg)}
.period-comparison-controls fieldset{display:flex;flex:1 1 20rem;min-width:0;gap:var(--space-md);border:1px solid var(--rule);padding:var(--space-md)}
.period-comparison-controls legend{font-weight:var(--weight-strong)}
.period-comparison-controls label{flex:1;min-width:0}
.period-comparison-controls input{display:block;box-sizing:border-box;min-width:0;width:100%;min-height:44px;font:inherit}
.period-comparison .search-label{max-width:32rem}
.period-comparison-scope,.period-comparison-basis{overflow-wrap:anywhere}
.period-comparison-sides{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-xl);margin-block:var(--space-xl)}
.period-comparison-side{min-width:0}
.period-comparison-side h3{font-size:var(--type-section)}
.period-comparison-table{overflow:auto;max-width:100%;margin-block:var(--space-lg)}
.period-comparison-table table{width:100%;border-collapse:collapse;font-size:var(--type-body)}
.period-comparison-table caption{text-align:left;font-weight:var(--weight-strong);margin-block-end:var(--space-sm)}
.period-comparison-table th,.period-comparison-table td{text-align:left;vertical-align:top;white-space:normal;overflow-wrap:anywhere;padding:var(--space-sm);border-bottom:1px solid var(--rule)}
.period-comparison-table thead{background:var(--canvas)}
.period-comparison .assessment-dialog{max-width:min(52rem,calc(100vw - 2rem))}
@media(max-width:900px){.period-comparison-sides{grid-template-columns:minmax(0,1fr)}}
@media(max-width:480px){.period-comparison-controls fieldset{flex-wrap:wrap}.period-comparison-controls label{flex-basis:100%}.period-comparison-table table{min-width:30rem}}
`;
