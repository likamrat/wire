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
    assessmentFactories, getContext, navigate, onSearch, recordLink, syncFilters, createReport, openSearch, onAccepted }) {
    const doc = root.ownerDocument;
    let machine, metricSlotKey, contractPromise, contextKey = "", requestKey = "", generation = 0, lastRoute = "", shown = false, blockedSnapshot = null, outcomeObserver = null, datesEdited = false;
    let selectedPeriod = "baseline", rosterKey = "";
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
    const title = el("h2", "Compare periods", "visually-hidden");
    title.id = "periodComparisonTitle"; title.tabIndex = -1;
    const stop = button("Stop comparing", () => { navigate({ compare: undefined }); toggle.focus(); });
    stop.title = "Return to Analyze with your dates and filters kept";
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
    form.append(apply, stop);
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
        if (status.classList.contains("comparison-progress")) output.append(status);
        else setup.insertBefore(status, scopeRow);
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
    scopeRow.append(dateHint, scope);
    if (typeof openSearch === "function") scopeRow.append(button("Search this comparison", openSearch));
    setup.append(title, form, status, scopeRow, searchLabel);
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
    function ready() {
        if (!contractPromise) contractPromise = Promise.all([
            import("/assets/assessment-contract.mjs"), import("/assets/period-comparison-math.mjs"),
        ]).then(([contract, { comparePeriodCohorts }]) => {
            machine = createState({ time, search, contract, projection, categories, comparePeriodCohorts });
            metricSlotKey = contract.metricSlotKey;
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
        node.append(el("caption", caption, "visually-hidden"));
        for (const label of headers) { const th = el("th", label); th.scope = "col"; line.append(th); }
        head.append(line);
        for (const cells of rows) {
            const tr = el("tr");
            cells.forEach((value, index) => {
                const cell = el(index ? "td" : "th"); if (!index) cell.scope = "row";
                if (index) cell.dataset.label = headers[index];
                if (value instanceof doc.defaultView.Node) cell.append(value); else cell.textContent = value;
                tr.append(cell);
            });
            body.append(tr);
        }
        node.append(head, body); wrap.append(node); return wrap;
    }
    const signed = value => value === null ? "Not comparable" : `${value > 0 ? "+" : ""}${number(value)}`;
    const exactNumber = value => Number.isSafeInteger(value) ? number(value) : String(value);
    const duration = value => `${exactNumber(value)} ms`;
    const counted = (value, unit) => `${number(value)} ${unit}${value === 1 ? "" : "s"}`;
    const numeric = text => el("span", text, "compare-number");
    const identity = name => el("span", name, `compare-identity compare-identity-${name.toLowerCase()}`);
    function deltaNode(value, unit, lowerIsBetter = false) {
        const smallShare = value !== null && value !== 0 && Math.abs(value) < 0.01 && unit === "pp";
        const text = value === null ? "Not comparable" : smallShare
            ? `${value > 0 ? "+" : ""}${assessmentFactories.createReportComparison().formatValue(value, "percentage-points")}` : unit.startsWith("ms")
            ? `${value > 0 ? "+" : ""}${exactNumber(value)} ${unit}` : `${signed(value)} ${unit}`;
        const node = el("span", text, "compare-delta");
        if (lowerIsBetter && value !== null && value !== 0) node.classList.add(value > 0 ? "compare-worse" : "compare-better");
        return node;
    }
    function panel(name, className) {
        const node = el("section", undefined, `compare-panel ${className}`);
        node.append(el("h3", name)); return node;
    }
    function syncOutcomeChoices(value = null) {
        const control = doc.getElementById("outcomeFilter"), labels = results.labels(getContext().options.layer);
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
    function outcomePanel(value, sides, labels) {
        const node = panel("Recorded outcomes", "compare-outcomes"), finding = el("p", undefined, "compare-finding");
        const change = value.comparison.outcomes.change.failure;
        if (value.definitions.layer === "code-reference") finding.textContent = "Execution not observed";
        else finding.append(deltaNode(change, "pp", true), el("span", change === null ? "failure-share comparison unavailable"
            : change > 0 ? "higher failure share" : change < 0 ? "lower failure share" : "failure share unchanged"));
        node.append(finding, el("p", `${value.definitions.layer === "tool" ? "Share of matching calls" : value.definitions.unit} · Change in percentage points`, "compare-caption"));
        const percent = (count, eligible) => eligible ? `${(count * 100 / eligible).toFixed(2)}%` : "Not applicable";
        for (const [, side, name] of sides) {
            const row = el("div", undefined, "compare-outcome-row"), heading = el("div", undefined, "compare-bar-heading");
            heading.append(identity(name), numeric(`${number(side.rowIds.length)} ${results.columnUnit(value.definitions.layer, side.rowIds.length)}`));
            const bar = el("div", undefined, "compare-outcome-bar"); bar.setAttribute("role", "img");
            bar.setAttribute("aria-label", `${name}: ` + Object.entries(labels).map(([key, label]) =>
                `${label} ${side.analytics.totals[key]} (${percent(side.analytics.totals[key], side.rowIds.length)})`).join(", "));
            for (const key of Object.keys(labels)) {
                if (!side.analytics.totals[key]) continue;
                const mark = el("span", undefined, "compare-mark-" + key); mark.dataset.outcome = key;
                mark.style.width = `${side.analytics.totals[key] * 100 / side.rowIds.length}%`; bar.append(mark);
            }
            row.append(heading, bar);
            if (!side.rowIds.length) row.append(el("p", "No matching records", "compare-caption"));
            node.append(row);
        }
        const a = sides[0][1], b = sides[1][1];
        const legend = el("div", undefined, "compare-outcome-values"), header = el("div", undefined, "compare-outcome-value-row compare-caption");
        header.append(el("span", "Outcome"), el("span", "A"), el("span", "B")); legend.append(header);
        for (const [key, label] of Object.entries(labels)) {
            if (!a.analytics.totals[key] && !b.analytics.totals[key]) continue;
            const row = el("div", undefined, "compare-outcome-value-row"), name = el("span", undefined, "compare-outcome-label");
            name.append(el("span", undefined, "compare-swatch compare-mark-" + key), label);
            row.append(name, numeric(`${number(a.analytics.totals[key])} · ${percent(a.analytics.totals[key], a.rowIds.length)}`),
                numeric(`${number(b.analytics.totals[key])} · ${percent(b.analytics.totals[key], b.rowIds.length)}`));
            legend.append(row);
        }
        const volume = el("p", undefined, "compare-caption compare-volume");
        volume.append("Volume change: ", deltaNode(b.rowIds.length - a.rowIds.length, results.columnUnit(value.definitions.layer, Math.abs(b.rowIds.length - a.rowIds.length))));
        node.append(legend, volume); return node;
    }
    function matchingTimingPanel(value) {
        const node = panel("Matching tool latency", "compare-latency");
        node.append(el("p", "Call start to recorded completion", "compare-caption"));
        const matching = value.comparison.matchingCallTiming;
        if (!matching) {
            node.append(el("p", "Unavailable for this evidence layer. These records are not timed tool calls.", "compare-empty"));
            return node;
        }
        const svgNode = (tag, attributes, text) => {
            const node = doc.createElementNS("http://www.w3.org/2000/svg", tag);
            for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
            if (text !== undefined) node.textContent = text;
            return node;
        };
        for (const [key, label] of [["median", "Median"], ["p95", "95th percentile"]]) {
            const item = matching[key], metric = el("section", undefined, "compare-timing-metric"), heading = el("div", undefined, "compare-metric-heading");
            const measurable = fact => fact.state === "available" && (key !== "p95" || fact.coverage.count > 1);
            const delta = item.delta && measurable(item.baseline) && measurable(item.later) ? item.delta.value : null;
            heading.append(el("h4", label), deltaNode(delta, "ms" + (delta > 0 ? " slower" : delta < 0 ? " faster" : ""), true));
            const values = el("div", undefined, "compare-timing-values");
            for (const [name, fact] of [["A", item.baseline], ["B", item.later]]) {
                const cell = el("p");
                cell.append(identity(name), numeric(measurable(fact) ? duration(fact.value)
                    : key === "p95" && fact.coverage.count === 1 ? "One sample; not shown" : "Not measured"));
                values.append(cell);
            }
            metric.append(heading, values);
            const available = [item.baseline, item.later].filter(measurable);
            if (available.length) {
                const max = Math.max(...available.map(fact => fact.value)), magnitude = max ? Math.max(Number.MIN_VALUE, 10 ** Math.floor(Math.log10(max))) : 1;
                const top = max ? Math.min(Number.MAX_VALUE, Math.ceil(max / magnitude + 0.01) * magnitude) : 1;
                const x = fact => 14 + fact.value / top * 432;
                const chart = svgNode("svg", { viewBox: "0 0 460 56", role: "img", "aria-label": `${label}; linear scale 0 to ${exactNumber(top)} ms. A hollow, B filled.` });
                chart.append(svgNode("line", { x1: 14, y1: 18, x2: 446, y2: 18, class: "compare-axis" }));
                if (available.length === 2) chart.append(svgNode("line", { x1: x(item.baseline), y1: 18, x2: x(item.later), y2: 18, class: "compare-connector" }));
                for (const [name, fact] of [["a", item.baseline], ["b", item.later]]) if (measurable(fact)) {
                    chart.append(svgNode("circle", { cx: x(fact), cy: 18, r: name === "a" ? 6 : 4, class: "compare-dot-" + name }));
                }
                for (const ratio of [0, 0.5, 1]) chart.append(svgNode("text", { x: 14 + ratio * 432, y: 47,
                    "text-anchor": ratio === 0 ? "start" : ratio === 1 ? "end" : "middle" }, duration(top * ratio)));
                metric.append(chart);
            }
            node.append(metric);
        }
        const coverage = matching.median;
        const missing = [["A", coverage.baseline], ["B", coverage.later]].filter(([, fact]) => fact.coverage.count < fact.coverage.eligible)
            .map(([name, fact]) => `${name}: ${fact.coverage.eligible - fact.coverage.count} missing`);
        node.append(el("p", `Timed calls: A ${coverage.baseline.coverage.count}/${coverage.baseline.coverage.eligible} · B ${coverage.later.coverage.count}/${coverage.later.coverage.eligible}`
            + (missing.length ? ` · ${missing.join("; ")} (excluded)` : ""), "compare-caption"));
        return node;
    }
    function recordPanel(value, sides, labels, membershipKey) {
        const node = panel("Evidence behind the comparison", "compare-evidence");
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
        for (const [key, side, name] of sides) {
            const tab = button(`${name} · ${counted(side.rowIds.length, "record")}`, () => select(key));
            tab.id = "comparisonRecords" + name; tab.setAttribute("role", "tab");
            const body = el("section", undefined, "compare-record-panel"); body.id = "comparisonExactRecords" + name;
            body.dataset.periodSide = key; body.setAttribute("role", "tabpanel"); body.setAttribute("aria-labelledby", tab.id);
            tab.setAttribute("aria-controls", body.id);
            body.append(el("p", `Period ${name} · ${number(side.rowIds.length)} matching ${results.columnUnit(value.definitions.layer, side.rowIds.length)} in ${number(side.interactionRefs.length)} whole ${side.interactionRefs.length === 1 ? "interaction" : "interactions"}`, "compare-caption"));
            if (side.rowIds.length) {
                const exact = table(`Period ${name}: Exact matching records (${side.rowIds.length})`, ["Record / interaction", "Recorded start", "Outcome", value.definitions.layer === "tool" ? "Tool latency" : "Duration"],
                    side.analytics.rows.map(row => {
                        const nameCell = el("div"), link = recordLink(row, side, value); link.id = `comparison-record-${name}-${row.id}`;
                        nameCell.append(link, el("span", records.get(row.scenarioId)?.title || "Retained interaction", "compare-record-context"));
                        return [nameCell, time.formatTime(row.startedAt, value.timeContext),
                            el("span", labels[row.outcome], "compare-record-outcome compare-record-" + row.outcome),
                            row.durationMs === null ? el("span", "Not measured", "compare-caption") : numeric(duration(row.durationMs))];
                    }));
                exact.id = "comparison-record-scroll-" + name; body.append(exact);
            } else body.append(el("p", "No matching retained activity in this period.", "compare-empty"));
            if (side.unmappedScenarioIds.length) body.append(el("p", `${side.unmappedScenarioIds.length} request groups have no verified interaction association.`, "compare-scope-note"));
            const services = side.analytics.serviceInvolvement;
            if (services.selection.services.length) body.append(el("p", `${services.selection.knownMatchIds.length} known service matches · ${counted(services.selection.contextOnlyIds.length, "missing-service context record")}.`, "compare-caption"));
            else if (services.missingDetailCount) body.append(el("p", `${services.missingDetailCount} matching records have missing service details.`, "compare-caption"));
            if (side.analytics.apiCoverage) body.append(el("p", `${side.analytics.apiCoverage.selectedResultUnits} matching returned entries; ${side.analytics.apiCoverage.eligibleToolCalls} parent calls before outcome/path filters. Separate populations.`, "compare-caption"));
            entries.push({ key, tab, body }); tabs.append(tab);
            tab.addEventListener("keydown", event => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? entries[0] : event.key === "End" ? entries[1] : entries.find(entry => entry.key !== key);
                select(next.key); next.tab.focus();
            });
        }
        node.append(tabs, ...entries.map(entry => entry.body)); select(selectedPeriod); return node;
    }
    function wholeTimingPanel(value, sides) {
        const node = panel("Whole-interaction timing", "compare-full-timing");
        node.querySelector("h3").id = "periodInteractionDetailsTitle";
        node.append(el("p", `A ${counted(sides[0][1].interactionRefs.length, "interaction")} · B ${counted(sides[1][1].interactionRefs.length, "interaction")} · Includes calls outside the selected dates or filters`, "compare-caption"));
        const formatter = assessmentFactories.createReportComparison();
        for (const item of value.comparison.metrics) {
            const section = el("section", undefined, "compare-whole-measure");
            const timed = sides.map(([key, side]) => {
                const metric = side.assessment.metrics.find(metric => metricSlotKey(metric) === item.key);
                return metric && item[key]?.kind === "duration" ? assessmentFactories.timing.fromMetric(metric) : null;
            });
            section.append(el("h4", timed.find(Boolean)?.label || formatter.comparisonLabel(item)));
            const values = el("div", undefined, "compare-whole-values");
            sides.forEach(([key, , name], index) => {
                const fact = item[key], timing = timed[index], cell = el("div"); cell.append(identity(name));
                if (fact?.state === "available" && timing) {
                    cell.append(numeric(timing.timed > 1 ? `Median ${duration(timing.distribution.p50Ms)}` : `${duration(timing.measurement.value)} · single sample`));
                    if (timing.timed > 1) cell.append(numeric(`P95 ${duration(timing.distribution.p95Ms)}`));
                } else cell.append(el("span", fact ? formatter.metricPresentation(fact, fact.metric, { includeOrigin: false }).value
                    : formatter.absentPeerLabel(item[key === "baseline" ? "later" : "baseline"])));
                const definition = formatter.sideDefinitionLabel(item, key);
                if (definition) cell.append(el("span", definition, "compare-caption"));
                values.append(cell);
            });
            section.append(values);
            const coverage = timed.map((timing, index) => timing ? `${index ? "B" : "A"} ${timing.timed}/${timing.eligible} ${timing.coverage.unit}` : null).filter(Boolean);
            if (coverage.length) section.append(el("p", "Timed: " + coverage.join(" · "), "compare-caption"));
            const change = el("p", undefined, "compare-caption");
            change.append("Median change: ", item.result?.status === "incompatible" ? el("span", "Incompatible definitions")
                : deltaNode(item.result?.delta?.value ?? null, item.result?.delta?.unit ?? "", true));
            section.append(change);
            const warnings = item.result?.warnings.filter(code => !["partial-coverage", "coverage-decreased"].includes(code)) ?? [];
            if (warnings.length) section.append(el("p", warnings.map(code => formatter.warningLabel(code, item)).join("; "), "compare-caption"));
            node.append(section);
        }
        return node;
    }
    function paint(value) {
        syncReport(value); resultHeading.hidden = false; syncOutcomeChoices(value);
        const { baseline: a, later: b } = value.periods, sides = [["baseline", a, "A"], ["later", b, "B"]];
        const membershipKey = JSON.stringify([value.definitions.layer, a.rowIds, b.rowIds]);
        if (membershipKey !== rosterKey) { rosterKey = membershipKey; selectedPeriod = "baseline"; }
        const dayCount = side => Math.round((Date.parse(side.range.to) - Date.parse(side.range.from)) / 86400000) + 1;
        const dateRange = side => side.range.from === side.range.to ? time.formatDate(side.range.from, value.timeContext, true)
            : `${time.formatDate(side.range.from, value.timeContext, true)} – ${time.formatDate(side.range.to, value.timeContext, true)}`;
        const pair = el("div", undefined, "compare-period-key");
        for (const [, side, name] of sides) {
            const line = el("p");
            line.append(identity(name), el("span", `${dateRange(side)} · ${dayCount(side)} ${dayCount(side) === 1 ? "day" : "days"}`)); pair.append(line);
        }
        const collection = { history: "Current collection", legacy: "Earlier snapshot", all: "Both collections" }[value.options.filters.scope ?? "history"];
        output.replaceChildren(pair, el("p", `${collection} · Both dates included · ${time.label(value.timeContext)} · Change is B minus A`, "compare-caption"));
        const sharedInteractions = a.interactionRefs.filter(ref => b.interactionRefs.includes(ref)).length, sharedRecords = value.comparison.outcomes.overlap.sharedCount;
        if (dayCount(a) !== dayCount(b)) output.append(el("p",
            `Unequal windows: A ${dayCount(a)} ${dayCount(a) === 1 ? "day" : "days"}, B ${dayCount(b)} ${dayCount(b) === 1 ? "day" : "days"}. Counts are not normalized per day.`, "compare-scope-note"));
        if (sharedRecords || sharedInteractions) output.append(el("p",
            `Overlap: ${number(sharedRecords)} matching records and ${number(sharedInteractions)} whole ${sharedInteractions === 1 ? "interaction" : "interactions"} belong to both periods.`, "compare-scope-note"));
        if (!a.rowIds.length && !b.rowIds.length) {
            output.append(el("p", "No matching retained activity in either period. Change the dates or shared filters.", "compare-empty")); return;
        }
        const labels = results.labels(value.definitions.layer), answers = el("div", undefined, "compare-answer-grid");
        answers.append(outcomePanel(value, sides, labels), matchingTimingPanel(value));
        output.append(answers, recordPanel(value, sides, labels, membershipKey), wholeTimingPanel(value, sides),
            el("p", "Retained history; undated records excluded. Recorded outcomes are not answer quality, and differences do not establish causes.", "compare-caption"));
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
        const pageTitle = doc.getElementById("pageTitle");
        if (active && pageTitle) pageTitle.textContent = "Compare periods";
        shown = active; root.hidden = !active; setup.hidden = !active; toggle.hidden = context.route.view !== "analyze";
        toggle.setAttribute("aria-expanded", String(active));
        toggle.textContent = active ? "Close period comparison" : "Compare periods";
        doc.body.classList.toggle("period-comparing", active);
        if (!active) {
            completionIntent = null;
            generation++; machine?.leave(); requestKey = ""; contextKey = ""; datesEdited = false; lastRoute = "";
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
        scope.hidden = !context.semanticSearch && !context.search.trim();
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
        setStatus("Reading both periods...", "context-help-note comparison-progress");
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
            onAccepted?.();
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
        clearResults();
        setStatus("Retained evidence or its permission changed. Read the current stored Analyze view before comparing again.", "notice");
    }
    const workspace = doc.getElementById("workspace");
    if (workspace) new MutationObserver(() => { if (shown) update(); }).observe(workspace, { attributes: true, attributeFilter: ["aria-busy"] });
    return { update, consumer, observe };
}

export const periodComparisonStyles = `
.period-comparing #homeView,.period-comparing #activityView,
.period-comparing #periodFeedback :is(#periodResult,#periodHint,#periodActions,#periodCoverage),
.period-comparing #viewingContext,.period-comparing #serviceEvidenceSummary,.period-comparing #sessionAnalysis,
.period-comparing #pageAction,.period-comparing #createSessionReport,.period-comparing #reportSelectionBar,
.period-comparing #resultsLink,.period-comparing #filters .filter-field:has(#dateFilter),
.period-comparing #dateFields,.period-comparing #filterChips [aria-label^="Remove date filter:"]{display:none!important}
.period-comparing #filterHeading{display:none}
.period-comparing #analyzePopulation{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;padding:16px 20px;container:compare-scope / inline-size}
.period-comparing #periodComparisonSetup,.period-comparing #filters{grid-column:1/-1}
.period-comparing #filters{margin-block:0}
.period-comparing #filters .period-controls{gap:8px}
.period-comparing #collectionNotice{grid-column:1;grid-row:3;align-self:center;font-size:.75rem;margin-block:0;padding-block:4px}
.period-comparing #appliedFilters{grid-column:2;grid-row:3;margin-block:0}
.period-comparing #appliedFilters:has(#filterChips:not(:empty)){grid-column:1/-1;grid-row:4}
.period-comparing .page-heading{margin-bottom:16px}
.period-comparison{margin-block:20px var(--space-lg);min-width:0;container:comparison-results / inline-size}
.period-comparison:has(>#periodComparisonResults:empty){margin:0}
#periodComparisonSetup{min-width:0;container:comparison-setup / inline-size}
.period-comparison-heading{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px 16px;margin-bottom:8px}
.period-comparison-heading h2{margin:0;font-size:var(--type-section)}
.period-comparison-heading button{min-height:44px;max-width:100%;white-space:normal}
.period-comparison-controls{display:flex;gap:12px 20px;align-items:end;flex-wrap:wrap;margin:0}
.period-comparison-controls fieldset{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));flex:1 1 16rem;min-width:0;gap:8px;border:0;padding:0;margin:0}
.period-comparison-controls legend{font-size:.875rem;font-weight:var(--weight-strong);padding:0;margin:0}
.period-comparison-controls label{display:grid;gap:2px;min-width:0;font-size:var(--type-small)}
.period-comparison-controls input{display:block;box-sizing:border-box;min-width:0;width:100%;min-height:44px;font:inherit;padding-block:8px}
.period-comparison-controls>button{min-height:44px;white-space:normal;max-width:100%}
.period-comparison-controls>button.quiet{font-size:.8125rem}
#periodComparisonSetup .search-label{max-width:32rem}
#periodComparisonSetup .context-help-note{max-width:none;margin:4px 0;font-size:.75rem}
#periodComparisonStatus.error,#periodComparisonStatus.notice{margin:8px 0;overflow-wrap:anywhere}
.period-comparison-scope{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:0 16px;overflow-wrap:anywhere}
.period-comparison-scope #comparisonDateHint{flex:1 1 16rem;min-width:0}
.period-comparison-scope>p:not(#comparisonDateHint){flex-basis:100%;order:1}
.period-comparison-scope>button{min-height:44px;max-width:100%;white-space:normal;text-align:start;font-size:.75rem}
#periodComparisonResultsTitle{scroll-margin-top:0}
.compare-period-key{display:flex;flex-wrap:wrap;gap:8px 28px;align-items:center}
.compare-period-key p,.compare-timing-values p{display:flex;align-items:center;gap:10px;margin:0}
.compare-caption{font-size:.8125rem;line-height:1.5;color:var(--muted);margin:6px 0 0}
.compare-period-key+.compare-caption{margin-top:8px}
.compare-identity{display:inline-flex;align-items:center;justify-content:center;width:1.5rem;height:1.5rem;flex:none;font-size:.75rem;font-weight:var(--weight-strong);border:1px solid var(--control);border-radius:4px;color:var(--ink)}
.compare-identity-b{color:var(--paper);background:var(--ink);border-color:var(--ink)}
.compare-answer-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px;margin:18px 0}
.compare-panel{min-width:0;padding:18px 20px;background:var(--paper);border-radius:var(--radius)}
.compare-panel h3{font-size:1.125rem;margin:0 0 8px}
.compare-panel h4{font-size:.875rem;margin:0}
.compare-finding{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;margin:8px 0;font-size:1.1875rem}
.compare-finding .compare-delta{font-size:1.5rem}
.compare-number,.compare-delta{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.compare-worse{color:var(--chart-failure)}.compare-better{color:var(--chart-success)}
.compare-outcome-row{margin-top:18px}
.compare-bar-heading,.compare-metric-heading{display:flex;align-items:center;justify-content:space-between;gap:8px}
.compare-bar-heading{margin-bottom:8px}
.compare-outcome-bar{height:18px;display:flex;background:var(--canvas);border-radius:2px;overflow:hidden}
.compare-mark-success{background:var(--chart-success)}.compare-mark-failure{background:var(--chart-failure)}
.compare-mark-partial{background:var(--chart-partial)}.compare-mark-unknown{background:var(--chart-unknown)}
.compare-mark-other{background:var(--warning)}.compare-mark-transport{background:var(--danger)}
.compare-outcome-values{display:grid;grid-template-columns:minmax(0,1fr) repeat(2,minmax(7rem,auto));margin-top:16px}
.compare-outcome-value-row{display:grid;grid-column:1/-1;grid-template-columns:subgrid;gap:12px;align-items:baseline;padding-block:5px}
.compare-outcome-value-row>:not(:first-child){text-align:right}
.compare-outcome-label{font-size:.875rem}
.compare-swatch{width:8px;height:8px;display:inline-block;margin-right:8px}
.compare-volume{margin-top:14px}
.compare-scope-note{font-size:.8125rem;line-height:1.5;margin:12px 0 0;padding-left:10px;border-left:2px solid var(--control);color:var(--muted)}
.compare-timing-metric{margin-top:16px}
.compare-timing-values{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:10px}
.compare-timing-values .compare-number{font-size:1.125rem}
.compare-timing-metric svg{display:block;width:100%;height:auto;margin-top:4px;max-height:56px;overflow:visible}
.compare-axis{stroke:var(--rule);stroke-width:1}.compare-connector{stroke:var(--control);stroke-width:2}
.compare-dot-a{stroke:var(--ink);stroke-width:2;fill:var(--paper)}.compare-dot-b{stroke:var(--ink);stroke-width:2;fill:var(--ink)}
.compare-timing-metric svg text{font-family:var(--font);font-size:12px;fill:var(--muted)}
.compare-empty{padding:18px 0;color:var(--muted);font-size:.875rem}
.compare-evidence,.compare-full-timing{margin-top:20px}
.compare-evidence-tabs{display:flex;gap:16px;margin-top:6px}
.compare-evidence-tabs button{min-height:44px;border-radius:0}
.compare-evidence-tabs button[aria-selected=true]{box-shadow:inset 0 -2px var(--ink)}
.period-comparison-table{overflow:auto;max-width:100%;max-height:340px;margin:12px 0 0}
.period-comparison-table table{width:100%;border-collapse:collapse;font-size:.875rem;font-variant-numeric:tabular-nums}
.period-comparison-table thead{background:var(--paper)}
.period-comparison-table thead th{font-weight:var(--weight-regular);color:var(--muted);position:sticky;top:0;background:var(--paper);z-index:1}
.period-comparison-table th,.period-comparison-table td{text-align:left;vertical-align:top;border-bottom:1px solid var(--surface-divider);padding:10px 8px;white-space:normal;overflow-wrap:anywhere}
.period-comparison-table tr>:first-child{padding-left:0;width:36%}
.period-comparison-table tr>:last-child{text-align:right;padding-right:0}
.compare-record-context{display:block;font-size:.8125rem;color:var(--muted);font-weight:var(--weight-regular);margin-top:4px}
.compare-record-failure,.compare-record-transport{color:var(--chart-failure)}.compare-record-success{color:var(--chart-success)}
.compare-whole-measure{padding:14px 0;border-top:1px solid var(--surface-divider);margin-top:14px}
.compare-whole-values{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:10px}
.compare-whole-values>div{display:flex;align-items:center;flex-wrap:wrap;gap:6px 12px}
.compare-whole-values>div>.compare-caption{flex-basis:100%}
@container comparison-results (max-width:58rem){.compare-answer-grid{grid-template-columns:minmax(0,1fr)}.compare-panel{padding:16px}}
@container comparison-results (max-width:42rem){
 .period-comparison-table{max-height:420px}.period-comparison-table thead{display:none}
 .period-comparison-table tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;border-bottom:1px solid var(--surface-divider);padding:12px 0}
 .period-comparison-table tr>*{display:block;width:auto!important;border:0;padding:0}
 .period-comparison-table tr>:first-child,.period-comparison-table tr>:last-child{grid-column:1/-1}
 .period-comparison-table td[data-label]::before{content:attr(data-label);display:block;color:var(--muted)}
}
@container comparison-results (max-width:24rem){
 .compare-outcome-values{grid-template-columns:repeat(2,minmax(0,1fr))}
 .compare-outcome-value-row>:first-child{grid-column:1/-1}.compare-outcome-value-row.compare-caption{display:none}
 .compare-outcome-value-row>:nth-child(2)::before{content:"A ";color:var(--muted)}.compare-outcome-value-row>:nth-child(3)::before{content:"B ";color:var(--muted)}
 .compare-timing-values{display:grid;gap:8px}
}
@media(max-width:600px){
 .period-comparing #analyzePopulation{display:block;padding:12px}
 .period-comparison-controls fieldset{flex-basis:100%}.period-comparison-controls>button{margin-left:auto}
 .compare-outcome-value-row{gap:8px;font-size:.8125rem}.compare-panel h3{font-size:1.0625rem}
 .compare-period-key{gap:10px}.compare-finding{font-size:1.0625rem}.compare-metric-heading{align-items:baseline;flex-wrap:wrap}
 .period-comparing #filters .filter-scroll{overflow:visible}
 .period-comparing #filters .period-controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}
 .period-comparing #filters .primary-single-fields,.period-comparing #filters .primary-multiple-fields{display:contents}
 .period-comparing #filters .select-control,.period-comparing #filters .local-filter-row,.period-comparing #filters .select-control>button{min-width:0}
 .period-comparing #appliedFilters{float:right}.period-comparing #collectionNotice{clear:both}
}
@container compare-scope (max-width:16rem){.period-comparison-controls fieldset,.period-comparing #filters .period-controls{grid-template-columns:minmax(0,1fr)}}
@media(forced-colors:active){.compare-outcome-bar>span{border:1px solid CanvasText}.compare-evidence-tabs button[aria-selected=true]{border-bottom:2px solid Highlight}}
`;
