export function chartReferenceFacts(analytics, model) {
    if (!analytics || !model?.models || !Array.isArray(analytics.workloadGroups)
        || model.layer !== analytics.layer || model.total !== analytics.totals?.count) {
        throw new TypeError("Chart reference facts require the matching accepted chart model.");
    }
    const freeze = Object.freeze;
    const outcomes = ["success", "failure", "unknown", "partial", "other", "transport"];
    const coverage = ["recorded", "partial", "unavailable", "unverified", "conflicting"];
    return freeze({
        facts: freeze({
            totals: freeze(Object.fromEntries(["count", ...outcomes].map(key => [key, analytics.totals[key]]))),
            undatedCount: analytics.timeSeries?.undatedCount,
            categories: freeze(analytics.workloadGroups.map(group => group.label)),
        }),
        model: freeze({
            layer: model.layer, total: model.total, unit: model.unit,
            ...(model.separateUnits ? { separateUnits: true } : {}),
            outcomes: freeze({ rows: freeze(model.outcomes.rows.map(({ id, count, percentage }) => freeze({ id, count, percentage }))) }),
            services: freeze({
                missingDetailCount: model.services.missingDetailCount, partialCount: model.services.partialCount,
                recordedRows: freeze(model.services.recordedRows.map(({ id, label, count, fraction, percentage }) =>
                    freeze({ id, label, count, fraction, percentage }))),
            }),
            models: freeze({ total: model.models.total,
                coverage: freeze(Object.fromEntries(coverage.map(key => [key, model.models.coverage[key]]))) }),
            ...(model.authors ? { authors: freeze({ total: model.authors.total }) } : {}),
        }),
    });
}

export const chartReferenceMarkup = `
<dialog id="meaning" class="chart-reference" aria-labelledby="chartReferenceTitle">
  <div class="chart-reference-heading"><h2 id="chartReferenceTitle" tabindex="-1">Guide</h2><button id="closeChartReference" class="quiet" type="button" aria-label="Close Guide">Close</button></div>
  <div id="chartReferenceBody" class="chart-reference-body">
  <p id="chartReferenceNotice" class="notice" role="status" hidden></p>
  <p id="chartReferenceStatus" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>
  <section id="chartReferenceIndex" class="chart-reference-index" aria-labelledby="chartReferenceIndexTitle" hidden>
    <h3 id="chartReferenceIndexTitle" tabindex="-1">Choose a chart</h3>
    <button id="chartReferenceTopicToggle" type="button" class="quiet" aria-expanded="false" aria-controls="chartReferenceTopics" hidden>Topics</button>
    <nav id="chartReferenceTopics" class="chart-reference-topics" aria-label="Chart guide topics"></nav>
  </section>
  <div id="chartReferenceGuide" class="chart-reference-layout">
    <button id="chartReferenceAllTopics" class="chart-reference-return quiet" type="button">All charts</button>
    <section id="chartReferenceExplanation" class="chart-reference-explanation" aria-labelledby="chartReferenceTopicTitle"></section>
    <div id="chartReferenceActions" class="chart-reference-actions"></div>
  </div>
  <section id="chartReferenceExact" class="chart-reference-exact" hidden>
    <button id="chartReferenceBack" type="button" class="quiet">Back to guide</button>
    <h3 id="chartReferenceDataTitle" tabindex="-1">Exact numbers</h3>
    <p id="chartReferenceQualification" class="chart-reference-qualification" hidden></p>
    <div id="chartReferenceFind" class="chart-reference-find" hidden><label for="chartReferenceFindInput">Find in this table</label><input id="chartReferenceFindInput" type="search" autocomplete="off" spellcheck="false"></div>
    <div id="chartReferenceData"></div>
    <details id="chartReferenceSource" class="chart-reference-source"><summary>About these numbers</summary>
      <section aria-labelledby="meaningScopeTitle"><h4 id="meaningScopeTitle">Current scope</h4><dl class="scope-facts"><div><dt>Period</dt><dd id="periodLabel"></dd></div><div><dt>Matched activity</dt><dd id="meaningMatched"></dd></div><div><dt>Sources</dt><dd id="meaningSources"></dd></div></dl><p id="takeaway" hidden></p></section>
      <section aria-labelledby="meaningResultsTitle"><h4 id="meaningResultsTitle">Result meanings</h4><div id="meaningBody"></div></section>
      <section id="meaningReading"><h4>Reading counts and dates</h4><div id="chartReadingNotes"></div></section>
      <section id="serviceDefinitions"></section>
      <section><h4>Timing</h4><p>Tool duration and time to the final response are separate measurements. Concurrent tool durations are not added.</p></section>
    </details>
  </section>
  <div id="chartReferenceSources" hidden><section id="tableDisclosure"><h3 id="chartDataTitle">Chart counts</h3><div id="countTable" role="region" aria-label="Exact chart data, scroll horizontally for more columns" tabindex="0"></div></section><div id="percentageData"></div></div>
  </div>
</dialog>`;

// The caller supplies accepted chart facts and the existing navigation/table owners.
export function mountChartReference({ host, root, trigger, createState, ux, results, help, categories, dimensional, readContext, renderQualification,
    renderExact, openComparisonRecords, onUnavailable, onAnalyzeExit, publicationToken, isCurrent, motionTiming }) {
    if (typeof publicationToken !== "function" || typeof isCurrent !== "function") {
        throw new TypeError("Chart help requires publicationToken and isCurrent.");
    }
    if (!motionTiming || !Number.isFinite(motionTiming.duration) || typeof motionTiming.easing !== "string") {
        throw new TypeError("Chart help requires the shared sidebar motion timing.");
    }
    const doc = root.ownerDocument, $ = id => doc.getElementById(id), state = createState();
    const privateContents = ["periodLabel", "meaningMatched", "meaningSources", "periodHint", "takeaway", "meaningBody",
        "chartReadingNotes", "serviceDefinitions", "countTable", "percentageData", "chartReferenceData",
        "chartReferenceQualification", "chartReferenceNotice", "chartReferenceStatus", "chartReferenceExplanation",
        "chartReferenceActions"].map($).filter(Boolean);
    const retainedHosts = new Set(privateContents);
    function clearPrivateContents(host) {
        function erase(node) {
            for (const child of node.childNodes) erase(child);
            if (node.nodeType === 3 || node.nodeType === 4 || node.nodeType === 8) node.data = "";
            if (node.nodeType === 1 && !retainedHosts.has(node)) {
                if (node.matches("input,textarea,select")) node.value = "";
                for (const attribute of [...node.attributes]) {
                    if (node.namespaceURI !== "http://www.w3.org/2000/svg" || !(node.localName === "svg" && ["width", "height", "viewBox"].includes(attribute.name))
                        && !(node.localName === "rect" && ["width", "height", "x", "y", "rx", "ry"].includes(attribute.name))
                        && !(node.localName === "circle" && ["cx", "cy", "r"].includes(attribute.name))
                        && !(node.localName === "ellipse" && ["cx", "cy", "rx", "ry"].includes(attribute.name))
                        && !(["line", "linearGradient"].includes(node.localName) && ["x1", "x2", "y1", "y2"].includes(attribute.name))
                        && !(node.localName === "stop" && attribute.name === "offset")) attribute.value = "";
                    node.removeAttributeNode(attribute);
                    attribute.value = "";
                }
            }
        }
        // Clear the same Text/Attr objects held by readers before releasing them.
        for (const child of host.childNodes) erase(child);
        host.replaceChildren();
    }
    const topics = [
        ["outcomes", "Results"], ["time", "Activity over time"],
        ["services", "Services and operations"], ["models", "Response models"], ["authors", "Prompt authors"],
        ["tools", "Tools"], ["categories", "Activity categories"],
        ["paths", "Paths and operations"],
    ];
    const outcomeKeys = ["success", "failure", "unknown", "partial", "other", "transport"];
    const number = value => value.toLocaleString();
    const el = (tag, text, className) => {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (className) node.className = className;
        return node;
    };
    const control = (text, action, className = "quiet", views = ["guide", "index"]) => {
        const button = el("button", text, className), token = contextToken;
        button.type = "button";
        button.addEventListener("click", () => {
            if (button.isConnected && root.open && !closing && views.includes(state.value().view)
                && button.checkVisibility() && currentView(token)) action();
        });
        return button;
    };
    let context, contextToken = null, renderKey, exactRender = null, size = null, lastFocused = null, returnFocus = trigger, rowQuery = "";
    let motion = null, closing = false, lastAnalyzeTopic = null, returnY = 0;
    const currentPublication = token => token != null && typeof token.then !== "function" && isCurrent(token) === true;
    function currentView(token = contextToken) {
        if (currentPublication(token)) return true;
        if (!currentPublication(contextToken)) withdrawAccess();
        return false;
    }
    const navigate = (view, topic) => sync({ view, topic, restoreFocus: view === "closed" });
    function cancelMotion() {
        motion?.cancel(); motion = null; closing = false;
        $("chartReferenceBody").inert = false;
        root.removeAttribute("data-closing");
    }
    function move(entering) {
        const token = contextToken, style = doc.defaultView.getComputedStyle(root);
        const offscreen = `translateX(calc(100% + ${style.right}))`;
        const from = motion ? style.transform : entering ? offscreen : "translateX(0)";
        cancelMotion();
        if (!currentView(token)) return;
        closing = !entering;
        $("chartReferenceBody").inert = closing;
        root.toggleAttribute("data-closing", closing);
        const animation = root.animate([{ transform: from }, { transform: entering ? "translateX(0)" : offscreen }], motionTiming);
        motion = animation;
        animation.onfinish = () => {
            if (motion !== animation || !currentView(token)) return;
            if (closing) navigate("closed");
            else cancelMotion();
        };
    }
    function requestClose() {
        if (!root.open || closing || !currentView()) return;
        ux.hideTooltip();
        if (root.dataset.mode === "analyze" && onAnalyzeExit) onAnalyzeExit();
        else if (root.dataset.mode === "analyze") navigate("closed");
        else move(false);
    }
    function dismiss() {
        if (!root.open || closing || !currentView()) return;
        if (state.value().view === "data") navigate("guide");
        else requestClose();
    }
    function readingRegion() {
        return $(state.value().view === "data" ? "chartReferenceExact"
            : state.value().view === "index" ? "chartReferenceIndex" : "chartReferenceExplanation");
    }
    function readingScroll() {
        return root.dataset.mode === "analyze" ? doc.scrollingElement : readingRegion();
    }
    function keepFocusVisible(token = contextToken) {
        if (!root.open || closing || !currentView(token)) return;
        let focused = doc.activeElement;
        if ((focused === doc.body || !focused.checkVisibility())
            && lastFocused?.isConnected && root.contains(lastFocused) && !lastFocused.checkVisibility()) {
            focused = $("chartReferenceTitle");
            if (!currentView(token)) return;
            focused.focus({ preventScroll: true });
        }
        if (focused !== root && root.contains(focused) && currentView(token)) focused.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    function activeFocus() {
        const focused = root.contains(doc.activeElement) ? doc.activeElement : null;
        return focused ? { focusId: focused.id, focusKey: focused.dataset.viewKey, topicFocus: focused.dataset.referenceTopic } : null;
    }
    function findFocus(saved) {
        return saved?.focusId ? $(saved.focusId) : saved?.focusKey
            ? [...root.querySelectorAll("[data-view-key]")].find(node => node.dataset.viewKey === saved.focusKey)
            : saved?.topicFocus ? [...root.querySelectorAll("[data-reference-topic]")].find(node => node.dataset.referenceTopic === saved.topicFocus) : null;
    }
    const icon = key => ux.icon(results.icon(key));
    function group() {
        return el("section", undefined, "chart-reference-group");
    }
    function definition(label, description, { outcome } = {}) {
        const row = el("div", undefined, "chart-reference-definition"), term = el("dt"), detail = el("dd", description, "chart-reference-definition-copy");
        if (outcome) {
            const cue = el("span", undefined, `chart-reference-outcome result-tone-${outcome}`);
            cue.setAttribute("aria-hidden", "true"); cue.append(icon(outcome)); term.append(cue);
            detail.classList.add("chart-reference-cued");
        }
        term.append(doc.createTextNode(label)); row.append(term);
        if (description) row.append(detail);
        return row;
    }
    function topicName(topic) {
        if (topic === "outcomes") return context.mode === "comparison" ? "Results by period"
            : context.layer === "tool" ? "Tool call outcomes" : results.outcomeTitle(context.layer, context.model);
        if (context.mode === "comparison") {
            return { time: context.layer === "tool" ? "Call timing" : "Recorded timing",
                categories: "Reading the comparison" }[topic];
        }
        if (context.layer !== "tool") {
            if (topic === "tools") return "Tools behind these records";
            if (topic === "categories") return "Service categories";
            if (topic === "paths") return "API paths";
        }
        return topic === "tools" ? "Calls by tool" : topics.find(([id]) => id === topic)[1];
    }
    function intro(topic) {
        if (context.mode === "comparison") {
            if (topic === "outcomes") return "Shares use the matching records in each period. Recorded results do not establish whole-task correctness.";
            if (topic === "time") return context.layer === "code-reference" ? help.layers[context.layer] : help.facts.Duration;
            return "Change is Period B minus Period A. The periods keep their own records and coverage.";
        }
        if (topic === "outcomes") return context.layer === "tool"
            ? "Each call counts once. A completed call means the tool finished, not that the answer was correct or that every returned item succeeded."
            : help.layers[context.layer];
        if (topic === "time") return context.layer === "tool" ? "Each bar counts calls by their recorded start. Undated calls stay in the period total, outside the bars."
            : "Each interval counts qualifying dated records. A record without a usable date cannot be placed on the timeline.";
        if (topic === "services") return "A service is unidentified when the record does not name an app or WIRE cannot map the saved target to one. Each service’s share uses all matching records, and one record can name several services.";
        if (topic === "models") return "Each interaction counts once for each recorded response model. Interactions without a recorded model name stay in the denominator.";
        if (topic === "authors") return "One originating prompt per matching interaction, across all pages. Tool calls and follow-ups do not add prompts.";
        if (topic === "tools") return context.layer === "tool" ? "Count each invocation under its recorded tool name. Repeated uses count separately; one call with several targets still counts once."
            : "Group matching records by their associated tool, not by the number of invocations.";
        if (topic === "categories") return context.layer === "tool" ? help.charts.activityCategory : help.charts.workload;
        return context.layer === "tool" ? help.charts.endpoint
            : help.layers[context.layer];
    }
    function showFacts() {
        return context.available && context.mode !== "comparison" && !context.nativeOnly;
    }
    function qualification(host) {
        if (!context.available) return false;
        if (context.qualificationParts === undefined) {
            host.textContent = context.qualification || "";
            return Boolean(context.qualification);
        }
        if (!context.qualificationParts.length) return false;
        if (typeof renderQualification !== "function") throw new TypeError("Chart qualification parts require the shared scope presenter.");
        renderQualification(host, { parts: context.qualificationParts, text: context.qualification });
        return true;
    }
    function qualify(host) {
        const scope = el("p", undefined, "chart-reference-qualification");
        if (qualification(scope)) host.append(scope);
        if (context.coverage) host.append(el("p", context.coverage, "chart-reference-qualification"));
    }
    function exactQualification() {
        const host = $("chartReferenceQualification"), scope = el("span", undefined, "chart-reference-scope");
        host.replaceChildren();
        const hasScope = qualification(scope);
        if (hasScope) host.append(scope);
        if (context.coverage) {
            if (hasScope) host.append(doc.createTextNode(" "));
            host.append(el("span", context.coverage, "chart-reference-coverage"));
        }
        host.hidden = !hasScope && !context.coverage;
    }
    function nativeGuide(host, topic) {
        const value = context.nativeView;
        if (!value || value.status !== "bounded" || context.mode === "comparison") return;
        const section = group(), a = value.aggregates;
        section.append(el("h3", "Microsoft 365"));
        if (topic === "time") section.append(el("p", `${number(value.timeSeries.datedRows)} dated records; ${number(value.timeSeries.undatedRows)} undated.`),
            el("p", "Call starts and returned results use their own recorded dates."));
        else if (topic === "outcomes") {
            section.append(el("p", `${number(a.selectedRows)} ${a.layer === "tool" ? "tool calls" : "returned results"}.`));
            const list = el("dl", undefined, "chart-reference-definitions"), labels = results.labels(a.layer);
            for (const key of outcomeKeys.filter(key => a.outcomes[key])) list.append(definition(labels[key],
                `${number(a.outcomes[key])} ${a.layer === "tool" ? a.outcomes[key] === 1 ? "call" : "calls" : a.outcomes[key] === 1 ? "result" : "results"}`));
            section.append(list);
        } else if (topic === "tools") section.append(el("p", a.layer === "tool"
            ? "Repeated updates of a call count once." : "A call can return several results."));
        else if (topic === "models") section.append(el("p", "Original response model names are unavailable."));
        else if (topic === "authors") section.append(el("p", "Prompt authorship is unavailable. These conversations are not part of the prompt denominator."));
        else section.append(el("p", topic === "paths" ? "Paths were not recorded." : "Service targets were not recorded."));
        host.append(section);
    }
    function outcomeGuide(host) {
        const names = results.labels(context.layer), section = group();
        const header = el("div", undefined, "chart-reference-group-heading");
        if (showFacts()) header.append(el("span", `${number(context.model.total)} ${results.unit(context.layer, context.model.total)}`, "muted"));
        section.append(header);
        const keys = context.mode === "comparison" ? (context.layer === "code-reference" ? ["unknown"] : outcomeKeys) : applicableOutcomes();
        const rows = keys => {
            const list = el("dl", undefined, "chart-reference-definitions");
            for (const key of keys) {
                const meaning = context.mode === "analyze" && context.layer === "tool" && key === "failure"
                    ? "The failure belongs to the call itself. Look for a diagnostic on that call, not an HTTP error on a returned item."
                    : context.mode === "comparison" && context.layer === "tool" && ["success", "failure"].includes(key) ? "" : help.resultMeaning(key, context.layer);
                list.append(definition(names[key], meaning, {
                    outcome: key,
                }));
            }
            return list;
        };
        section.append(rows(keys));
        if (context.model?.separateUnits && !context.nativeView) section.append(el("p", "These results use different source units.", "chart-reference-help"));
        host.append(section);
    }
    function applicableOutcomes() {
        const usual = { tool: ["success", "failure", "partial", "unknown"], "reported-api": ["success", "failure", "unknown", "other"],
            "direct-request": ["success", "failure", "unknown", "other"], "recorded-http": ["success", "failure", "other"],
            http: ["success", "failure", "unknown", "other", "transport"], "code-reference": ["unknown"] }[context.layer];
        return [...new Set([...usual, ...outcomeKeys.filter(key => context.model?.outcomes.rows.some(row => row.id === key && row.count > 0))])];
    }
    function workedExample(topic) {
        if (topic === "outcomes" && !context.nativeOnly && ["tool", "reported-api"].includes(context.layer)) return "Two calls in one interaction can report different kinds of errors. The retrieval below failed; the fetch finished but returned an error for one item.";
        if (topic === "services" && !context.nativeOnly && context.layer === "tool") return "One interaction asks Copilot for help, then fetches two targets. Only one target is recognized as Files. That tells you about the fetch, not which apps Copilot used.";
        if (topic === "categories" && context.layer === "tool") return "A fetch targeting Files and Mail counts once under More than one service, rather than once in each service category.";
        if (topic === "authors") return "A human prompt followed by four tool calls contributes one human prompt, not four agent prompts.";
        if (topic === "models") return "An interaction with two model names appears in both rows. One without a name appears in neither, but still counts toward the total.";
        if (topic === "time") return "An undated record can count toward the selected period but cannot be assigned to Tuesday. Moving the visible window does not change the period total.";
        if (topic === "tools") return context.layer === "tool" ? "Three separate fetch calls count three times. One fetch requesting three targets counts once." : "One tool can account for several records. Its record count is not a separate count of invocations.";
        if (topic === "paths") return context.layer === "code-reference" ? "A path mentioned in code is still a reference when no execution or response was observed." : "Two paths on one batch do not prove that the first returned item belongs to the first path.";
        if (topic === "outcomes" && context.layer === "code-reference") return "A request mentioned in a script is a reference, not a successful or failed execution.";
        if (topic === "outcomes" && context.layer === "tool") return "A call without a usable result is not a failed call. A source that explicitly reports partial completion has supplied a different outcome.";
        if (topic === "outcomes") return "An HTTP 403 is evidence about that recorded response, not proof that the entire interaction failed.";
        if (topic === "services" || topic === "categories") return "A record with no qualified service target cannot be counted as activity in Mail simply because another record mentions Mail.";
        return "";
    }
    function examplePanel(topic) {
        const example = el("aside", undefined, "chart-reference-example");
        example.append(el("h4", "Worked example"), el("p", "Illustrative, not from your activity", "guide-example-caption"), el("p", workedExample(topic)));
        const cases = !context.nativeOnly && context.layer === "tool" && ({
            outcomes: [["workiq-retrieve", "Tool failed · ToolUnavailable", "The tool was unavailable. This invocation counts as one failed call."],
                ["workiq-fetch", "Tool completed · HTTP 200 and 403", "The file entry returned HTTP 200. The message entry returned HTTP 403. That is one completed call with an error on the message entry."]],
            services: [["workiq-ask", "No downstream app list", "The request to Copilot is recorded; the apps used internally are not."],
                ["workiq-fetch", "One of two targets identified", "One path identifies Files. The other path was saved, but WIRE cannot classify it."]],
        })[topic];
        if (cases) {
            const list = el("div", undefined, "guide-example-calls");
            cases.forEach(([tool, result, detail], i) => {
                const entry = el("details"), summary = el("summary");
                summary.dataset.viewKey = `guide-example:${topic}:${tool}`;
                summary.append(el("span", `Call ${i + 1} · ${tool}`, "guide-example-caption"), el("span", result), ux.icon("next"));
                entry.append(summary, el("p", detail)); list.append(entry);
            });
            example.append(list);
        }
        return example;
    }
    function serviceGuide(host) {
        const section = group(), data = context.model?.services;
        if (showFacts()) {
            if (data.missingDetailCount) section.append(el("p",
                `${number(data.missingDetailCount)} records have missing service details${data.partialCount ? `; ${number(data.partialCount)} also have a known service` : ""}.`));
            if (section.childElementCount) host.append(section);
        }
        const meanings = group(), list = el("dl", undefined, "chart-reference-definitions");
        if (context.layer === "tool") {
            const hosted = categories.displayEvidence({ reason: "hosted-routing" }, { screen: true });
            const unmapped = categories.displayEvidence({ reason: "unrecognized-path" }, { screen: true });
            list.append(definition("Search requested", "Counts a search request, not confirmed use of a named app."),
                definition("Search endpoint", "The recorded target identifies a search endpoint."),
                definition(categories.operation("workiq-ask").label, hosted.description),
                definition(unmapped.label, unmapped.description));
            meanings.append(list, el("p", "Use View call beside a service or operation to inspect its evidence. If several calls match, the link opens the earliest one. The tool-call count opens the whole interaction. A service label does not tell you who wrote the prompt or whether the call failed."));
            host.append(meanings); return;
        }
        list.append(definition("Evidence", help.layers[context.layer]));
        list.append(definition("Missing service details", "Missing targets are not assigned to a service. A record can have both known targets and missing details."));
        meanings.append(list); host.append(meanings);
    }
    function otherGuide(host, topic) {
        const list = el("dl", undefined, "chart-reference-definitions");
        if (context.mode === "comparison") {
            if (topic === "time" && context.layer === "code-reference") {
                list.append(definition("Execution not observed", help.layers[context.layer]),
                    definition("Unavailable timing", "A code reference alone does not establish an execution time."));
            } else if (topic === "time") {
                list.append(definition("Median", "The middle available recorded time; the lower middle is used for an even number of samples."),
                    definition("P95", "At least 95% of the available recorded timings are at or below this value."),
                    definition("Coverage", help.glossary.coverage.definition),
                    definition("Whole interactions", "Full interactions can include calls outside the selected dates or filters. Their timing boundaries and coverage stay separate."));
            } else {
                list.append(definition("Percentage points", "For example, a share changing from 50% to 60% increases by 10 percentage points."),
                    definition("Overlapping periods", "A record or interaction can belong to both periods. Their counts are not a combined total."),
                    definition("Unequal periods", "Counts are not automatically adjusted for different period lengths."));
            }
            const section = group(); section.append(list); host.append(section);
            return;
        }
        if (topic === "time") {
            if (showFacts()) {
                const section = group(), missing = context.facts.undatedCount;
                section.append(el("p", Number.isSafeInteger(missing) && missing >= 0 && missing <= context.model.total
                    ? `${number(context.model.total - missing)} dated records; ${number(missing)} without a usable date.`
                    : "Dated and undated counts are unavailable."));
                host.append(section);
            }
            list.append(definition("Dates and grouping", "Individual calendar days by default. Long timelines page through 90 intervals; Timeline dates below the chart reaches earlier or later dates without changing the selected-period totals. Explicit weekly or monthly views keep their intervals; weeks start Monday."));
        } else if (topic === "models") {
            if (showFacts()) {
                const section = group(), data = context.model.models;
                section.append(el("p", `${number(data.total)} matching interactions.`));
                const coverage = { recorded: "Recorded", partial: "Partly recorded", unavailable: "Not recorded", unverified: "Not verified", conflicting: "Conflicting" };
                for (const [key, label] of Object.entries(coverage)) list.append(definition(label, `${number(data.coverage[key])} interactions`));
                host.append(section);
            } else list.append(definition("Not recorded", "Original response model names are unavailable."),
                definition("Partly recorded", "Some model information is missing."));
        } else if (topic === "authors") {
            if (showFacts() && context.model.authors) {
                const section = group();
                const total = context.model.authors.total;
                section.append(el("p", `${number(total)} matching ${total === 1 ? "interaction" : "interactions"}. Each belongs to one author category.`));
                host.append(section);
            }
            list.append(definition("Human prompts", "Recorded user origin, not verified account identity."),
                definition("Agent prompts", "Recorded agent origin, including qualified automatic continuations."),
                definition("Author unverified", "The saved record does not establish a human or agent sender. These interactions still count. Filter to Author unverified and open an interaction to see its recorded reason."),
                definition("Missing prompt text", "Text availability does not determine authorship. Stored aliases count once."));
        } else if (topic === "tools") {
            list.append(definition("Discovery / preparation", "API, schema or agent lookup, not data-service execution."),
                definition("Tool outcome", help.facts["Tool outcome"]));
        } else if (topic === "categories") {
            const used = showFacts() ? categories.used(context.facts.categories) : categories.entries;
            for (const item of used) list.append(definition(item.label, item.description));
        } else {
            list.append(definition("Path not recorded", "No usable path was saved."),
                definition("Other", "Smaller groups; listed individually in Exact numbers."));
            if (context.layer === "tool") {
                const unmapped = categories.displayEvidence({ reason: "unrecognized-path" }, { screen: true });
                list.append(definition(unmapped.label, `${unmapped.description} Choose See exact numbers, select the path or batch, then open the prompt. Expand the numbered call marked “Matches current view” to inspect its recorded evidence.`));
            }
        }
        const section = group(); section.append(list); host.append(section);
    }
    function readingTopic(key) {
        const tool = context.layer === "tool";
        return {
            outcomes: tool ? ["A tool call failed", "Did the tool fail, or did it return an error?"]
                : context.layer === "code-reference" ? ["Execution not observed", "Does a reference mean the code ran?"]
                    : ["Recorded outcomes", "What do the recorded statuses tell me?"],
            services: ["A service is unidentified", "Why is the service unidentified?"],
            time: tool ? ["When calls happened", "When did calls start?"] : ["Activity over time", "When was the activity recorded?"],
            tools: tool ? ["Which tools ran", "How often was each tool used?"] : ["Tools behind records", "Which tools are associated with these records?"],
            authors: ["Recorded prompt authors", "What is recorded about the prompt author?"],
            models: ["Which models appeared", "Which response models were recorded?"],
            categories: ["How activity is grouped", tool ? "How are calls with several targets grouped?" : "How are records assigned to a category?"],
            paths: ["Which path was requested", "Which path or operation was requested?"],
        }[key];
    }
    function setTopicChooser(open) {
        $("chartReferenceTopicToggle").setAttribute("aria-expanded", String(open));
    }
    function renderIndex() {
        const { topic, view } = state.value(), navigation = $("chartReferenceTopics");
        navigation.replaceChildren();
        const comparison = context.mode === "comparison";
        const sets = comparison ? [["", ["outcomes", "time", "categories"]]] : [
            ["Investigate a result", ["outcomes", "services"]], ["Read a measure", ["time", "tools", "authors", "models", "categories", "paths"]],
        ];
        for (const [title, keys] of sets) {
            const list = el("div", undefined, "chart-reference-topic-group");
            if (title) list.append(el("h4", title));
            for (const key of keys) {
                const button = control(comparison ? topicName(key) : readingTopic(key)[0], () => {
                    setTopicChooser(false);
                    if (navigate("guide", key) && !comparison && currentView()) $("chartReferenceTopicTitle").focus({ preventScroll: true });
                }, "chart-reference-topic", comparison ? ["guide", "index"] : ["guide", "data"]);
                button.dataset.referenceTopic = key;
                if (view !== "index" && key === topic) button.setAttribute("aria-current", "page");
                button.setAttribute("aria-controls", "chartReferenceExplanation"); list.append(button);
            }
            navigation.append(list);
        }
        $("chartReferenceIndexTitle").textContent = comparison ? "Compare" : "Topics";
        const toggle = $("chartReferenceTopicToggle");
        toggle.hidden = comparison;
        if (!comparison) toggle.replaceChildren(doc.createTextNode("Topics · " + readingTopic(topic)[0]), ux.icon("next"));
        $("chartReferenceAllTopics").replaceChildren(ux.icon("back"), doc.createTextNode("All topics"));
    }
    function renderGuide() {
        const topic = state.value().topic;
        renderIndex();
        const host = $("chartReferenceExplanation");
        const analyze = context.mode === "analyze";
        const title = el("h3", analyze ? readingTopic(topic)[1] : topicName(topic)); title.id = "chartReferenceTopicTitle"; title.tabIndex = -1;
        host.replaceChildren(title);
        if (analyze) {
            const chartName = el("p", undefined, "guide-chart-name");
            chartName.append(ux.icon("section-guide"), doc.createTextNode(topicName(topic))); title.before(chartName);
        }
        const introduction = context.nativeOnly ? topic === "outcomes" && context.layer === "tool"
            ? "Each call counts once. Completion does not establish answer correctness." : "" : intro(topic);
        if (introduction) host.append(el("p", introduction, "chart-reference-intro"));
        qualify(host);
        const reading = analyze ? el("div", undefined, "guide-reading") : host;
        if (analyze) reading.append(el("h4", "How to read it"));
        if (context.nativeView) nativeGuide(reading, topic);
        if (!context.nativeOnly) {
            if (context.nativeView) reading.append(el("h4", "GitHub Copilot"));
            if (topic === "outcomes") outcomeGuide(reading);
            else if (topic === "services") serviceGuide(reading);
            else otherGuide(reading, topic);
        }
        if (analyze) {
            const spread = el("div", undefined, "guide-reading-spread");
            spread.append(reading, examplePanel(topic)); host.append(spread);
        }
        if (topic === "outcomes" && context.mode === "analyze" && context.layer === "tool" && !context.nativeOnly) {
            const related = el("details", undefined, "chart-reference-related");
            const summary = el("summary", "Returned API entries");
            summary.dataset.viewKey = "guide-outcomes:returned-entries";
            related.append(summary, el("p", help.layers["reported-api"]),
                el("p", "A retained entry with no usable status is still an entry. A call with no returned entries adds nothing to that total. A recorder connection failure without a response is a separate HTTP record."));
            reading.append(related);
        }
        const actions = $("chartReferenceActions");
        actions.replaceChildren();
        const exact = control(context.mode === "comparison" ? "View period records" : "See exact numbers", () => {
            if (context.mode === "comparison") openComparisonRecords({ key: context.key, revision: context.revision });
            else navigate("data", state.value().topic);
        });
        exact.id = "chartReferenceShowData";
        exact.append(ux.icon("forward"));
        exact.disabled = !context.canOpenData;
        actions.append(exact);
        if (!context.canOpenData) actions.append(el("p", context.unavailableReason, "chart-reference-help"));
    }
    function paint({ resetPage = false } = {}) {
        const token = contextToken;
        if (!currentView(token)) return;
        const current = state.value(), guide = current.view === "guide", index = current.view === "index";
        root.dataset.mode = context.mode;
        $("chartReferenceTitle").textContent = context.mode === "comparison" ? "Chart guide" : "Guide";
        const backToPage = $("closeChartReference");
        backToPage.setAttribute("aria-label", context.mode === "comparison" ? "Close chart guide" : "Back to Analyze");
        if (backToPage.dataset.mode !== context.mode) {
            backToPage.replaceChildren(...(context.mode === "comparison" ? [ux.icon("close")] : [ux.icon("back"), doc.createTextNode("Back to Analyze")]));
            backToPage.dataset.mode = context.mode;
        }
        exactRender = null;
        exactQualification();
        $("chartReferenceGuide").hidden = !guide;
        $("chartReferenceIndex").hidden = !index && context.mode !== "analyze";
        $("chartReferenceAllTopics").hidden = context.mode === "analyze";
        $("chartReferenceExact").hidden = current.view !== "data";
        $("chartReferenceSource").hidden = !context.canOpenData;
        $("chartReferenceNotice").textContent = context.notice || "";
        $("chartReferenceNotice").hidden = !context.notice;
        root.dataset.revision = context.revision === undefined ? "" : String(context.revision);
        root.dataset.referenceView = current.view; root.dataset.referenceTopic = current.topic;
        if (index) renderIndex();
        else if (guide) renderGuide();
        else {
            if (context.mode === "analyze") renderIndex();
            $("chartReferenceDataTitle").textContent = topicName(current.topic);
            $("chartReferenceBack").replaceChildren(ux.icon("back"), doc.createTextNode("Back to explanation"));
            $("chartReferenceFind").hidden = current.topic !== "paths";
            $("chartReferenceFindInput").value = rowQuery;
            $("chartReferenceFindInput").disabled = !context.canOpenData;
            const data = $("chartReferenceData");
            data.replaceChildren();
            if (context.canOpenData) {
                const owner = {};
                exactRender = owner;
                let rendered;
                try {
                    rendered = renderExact(current.topic, data, { key: context.key, revision: context.revision }, {
                        isCurrent: () => currentView(token) && exactRender === owner && root.open && !closing
                            && state.value().view === "data" && state.value().topic === current.topic,
                        rowQuery: current.topic === "paths" ? rowQuery : "", resetPage,
                        ...(current.topic === "outcomes" ? { outcomeKeys: applicableOutcomes() } : {}),
                    });
                } catch (error) {
                    if (!currentView(token)) return;
                    throw error;
                }
                if (!currentView(token)) return;
                if (rendered?.status === "unavailable" && rendered.reason) {
                    data.replaceChildren(el("p", rendered.reason, "notice"));
                    $("chartReferenceSource").hidden = true;
                }
                else if (rendered?.status !== "ready") throw new TypeError("Exact chart data must confirm its accepted context.");
            }
            else data.append(el("p", context.unavailableReason, "notice"));
        }
    }
    function sync({ view = "closed", topic = state.value().topic, restoreFocus = false, restoreQuery, keepSearchFocus = false } = {}) {
        if (view === "closed") {
            if (contextToken !== null && !currentPublication(contextToken)) { withdrawAccess(); return false; }
            const token = contextToken;
            cancelMotion();
            state.close(); renderKey = undefined; exactRender = null; lastFocused = null;
            size?.disconnect(); size = null;
            $("chartReferenceStatus").textContent = "";
            trigger.setAttribute("aria-expanded", "false");
            if (root.open) root.close();
            host.hidden = true;
            setTopicChooser(false);
            if (restoreFocus && currentView(token) && !root.open && state.value().view === "closed" && returnFocus?.checkVisibility()) {
                if (root.dataset.mode === "analyze") doc.defaultView.scrollTo(0, returnY);
                returnFocus.focus({ preventScroll: true });
            }
            return true;
        }
        const token = publicationToken();
        if (!currentView(token)) return false;
        const previous = state.value(), opening = !root.open, reopening = closing, previousContextKey = context?.key;
        let next;
        try { next = readContext(); }
        catch (error) { if (!currentView(token)) return false; throw error; }
        if (!currentView(token)) return false;
        context = next; contextToken = token;
        if (!context || typeof context.key !== "string" || !context.key
            || !["analyze", "comparison"].includes(context.mode) || !results.layers.includes(context.layer)
            || context.available && (!Number.isSafeInteger(context.revision) || context.revision < 0)
            || context.available && (!context.model || !context.facts?.totals) && context.mode !== "comparison"
            || !context.canOpenData && !context.unavailableReason) {
            throw new TypeError("Chart help requires an accepted chart context or an explicit unavailable state.");
        }
        if (showFacts() && (context.model.layer !== context.layer || context.model.total !== context.facts.totals.count)) {
            throw new TypeError("Chart help facts must share the accepted layer and denominator.");
        }
        if (context.qualificationParts !== undefined && (!Array.isArray(context.qualificationParts)
            || context.qualificationParts.some(part => typeof part !== "string") || typeof context.qualification !== "string")) {
            throw new TypeError("Chart qualification requires complete parts and canonical plain text.");
        }
        if (typeof restoreQuery === "string") rowQuery = restoreQuery;
        else if (previousContextKey !== context.key) rowQuery = "";
        if (previous.view === "closed") state.open(topic); else state.selectTopic(topic);
        if (context.mode === "comparison" && !["outcomes", "time", "categories"].includes(topic)) {
            topic = "outcomes"; state.selectTopic(topic);
        }
        if (view === "data") state.showData();
        else if (view === "index") state.showIndex();
        else if (state.value().view === "data") state.back();
        if (context.mode === "analyze" && view === "guide") lastAnalyzeTopic = topic;
        const key = JSON.stringify([context.key, view, topic, context.notice, context.qualification, context.qualificationParts,
            context.coverage, context.available, context.canOpenData, rowQuery]);
        const focused = doc.activeElement, focus = activeFocus();
        if (key !== renderKey) {
            paint();
            if (!currentView(token)) return false;
            renderKey = key;
            if (previous.view !== view || previous.topic !== topic) {
                if (!opening && context.mode === "analyze") root.scrollIntoView({ block: "start" });
                else readingRegion().scrollTop = 0;
            }
        }
        if (!opening && context.available && context.canOpenData && previousContextKey !== context.key) {
            $("chartReferenceStatus").textContent = context.mode === "comparison" ? "Period records are now available." : topicName(topic) + " values updated.";
        }
        if (!currentView(token)) return false;
        if (opening) {
            returnFocus = trigger;
            host.hidden = false;
            watchSize(token);
            if (context.mode === "comparison") root.showModal();
            else if (keepSearchFocus) {
                // Restoring a nonmodal Guide after Search completes must not run dialog.show()'s focusing steps.
                returnY = doc.defaultView.scrollY;
                root.open = true;
            }
            else {
                returnY = doc.defaultView.scrollY; root.show();
                if (onAnalyzeExit) doc.defaultView.scrollTo(0, 0); else root.scrollIntoView({ block: "start" });
            }
            if (!currentView(token) || !root.open) return false;
            trigger.setAttribute("aria-expanded", "true");
            if (!keepSearchFocus) (context.mode === "analyze" && onAnalyzeExit ? trigger : $("chartReferenceTitle")).focus({ preventScroll: true });
            if (context.mode === "comparison") move(true);
        } else if (reopening) {
            move(true);
            $("chartReferenceTitle").focus({ preventScroll: true });
        } else if (previous.view !== view || previous.topic !== topic) {
            const target = view === "data" ? $("chartReferenceDataTitle")
                : view === "index" ? $("chartReferenceTopics").querySelector(`[data-reference-topic="${topic}"]`) || $("chartReferenceIndexTitle")
                    : previous.view === "data" ? $("chartReferenceShowData") : $("chartReferenceTopicTitle");
            target.focus({ preventScroll: true });
        } else if (focus && (!focused.isConnected || !focused.checkVisibility())) {
            const target = findFocus(focus) || (view === "data" ? $("chartReferenceDataTitle") : $("chartReferenceTopicTitle"));
            target.focus({ preventScroll: true });
            keepFocusVisible();
        }
        return currentView(token) && root.open && state.value().view !== "closed";
    }
    $("closeChartReference").replaceChildren(ux.icon("close"));
    trigger.setAttribute("aria-controls", root.id);
    if (!onAnalyzeExit) trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    $("closeChartReference").addEventListener("click", requestClose);
    $("chartReferenceBack").addEventListener("click", () => {
        if (root.open && !closing && state.value().view === "data" && currentView()) navigate("guide", state.value().topic);
    });
    $("chartReferenceAllTopics").addEventListener("click", () => {
        if (root.open && !closing && state.value().view === "guide" && currentView()) navigate("index");
    });
    $("chartReferenceTopicToggle").addEventListener("click", () => {
        const toggle = $("chartReferenceTopicToggle");
        if (root.open && !closing && toggle.checkVisibility() && currentView()) setTopicChooser(toggle.getAttribute("aria-expanded") !== "true");
    });
    $("chartReferenceFindInput").addEventListener("input", event => {
        if (!root.open || closing || state.value().view !== "data" || state.value().topic !== "paths" || !currentView() || !context.canOpenData) return;
        rowQuery = event.target.value;
        paint({ resetPage: true });
    });
    root.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
    root.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.defaultPrevented || !root.open || root.dataset.mode !== "analyze") return;
        event.preventDefault();
        const toggle = $("chartReferenceTopicToggle");
        if (toggle.checkVisibility() && toggle.getAttribute("aria-expanded") === "true") {
            setTopicChooser(false); toggle.focus();
        } else dismiss();
    });
    ux.dismissOnOutside(root, dismiss);
    root.addEventListener("close", () => { if (!root.open && state.value().view !== "closed") navigate("closed"); });
    root.addEventListener("focusin", event => {
        if (root.open && currentView()) { lastFocused = event.target; keepFocusVisible(); }
    });
    function settleMotion() {
        if (!motion) return;
        if (!currentView()) return;
        if (closing) navigate("closed");
        else cancelMotion();
    }
    doc.defaultView.addEventListener("resize", settleMotion);
    doc.addEventListener("visibilitychange", () => { if (doc.hidden) settleMotion(); });
    function watchSize(token) {
        size?.disconnect();
        const observer = new doc.defaultView.ResizeObserver(() => {
            if (size === observer && currentView(token)) keepFocusVisible(token);
        });
        size = observer;
        for (const node of [root, $("chartReferenceGuide"), $("chartReferenceExact")]) observer.observe(node);
    }
    function withdrawAccess() {
        cancelMotion();
        state.close(); context = null; contextToken = null; renderKey = undefined; exactRender = null;
        rowQuery = ""; lastFocused = null; returnFocus = null; lastAnalyzeTopic = null;
        size?.disconnect(); size = null;
        const selection = doc.getSelection();
        if (root.contains(selection?.anchorNode) || root.contains(selection?.focusNode)) selection.removeAllRanges();
        host.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        if (root.open) {
            // Native dialog closing must not restore focus to the retired trigger.
            const inert = trigger.inert;
            trigger.inert = true;
            root.close();
            trigger.inert = inert;
        }
        for (const node of privateContents) clearPrivateContents(node);
        const find = $("chartReferenceFindInput");
        find.value = ""; find.defaultValue = ""; find.disabled = true;
        $("chartReferenceFind").hidden = true;
        $("chartReferenceExact").hidden = true;
        $("chartReferenceIndex").hidden = true;
        $("chartReferenceSource").hidden = true;
        $("chartReferenceSource").open = false;
        $("chartReferenceQualification").hidden = true;
        $("chartReferenceNotice").hidden = true;
        $("chartReferenceDataTitle").textContent = "Exact numbers";
        const revision = root.getAttributeNode("data-revision");
        if (revision) revision.value = "";
        delete root.dataset.revision;
        root.dataset.referenceView = "closed";
        context = { key: "access:unavailable", mode: "analyze", layer: "tool", available: false, canOpenData: false,
            unavailableReason: "Read the current view before opening exact data." };
        renderGuide();
        context = null;
    }
    function capture() {
        if (contextToken !== null && !currentPublication(contextToken)) { withdrawAccess(); return null; }
        if (!root.open || closing) return null;
        return { ...state.value(), publicationToken: contextToken, key: context.key, revision: context.revision, scrollTop: readingScroll().scrollTop, rowQuery,
            ...activeFocus() };
    }
    function restore(saved) {
        if (!saved) return false;
        if (!currentPublication(saved.publicationToken)) {
            if (contextToken !== null && !currentPublication(contextToken)) withdrawAccess();
            return false;
        }
        let next;
        try { next = readContext(); }
        catch (error) { if (!currentView(saved.publicationToken)) return false; throw error; }
        if (!currentPublication(saved.publicationToken)) {
            if (contextToken !== null && !currentPublication(contextToken)) withdrawAccess();
            return false;
        }
        if (!["guide", "index", "data"].includes(saved.view) || next.key !== saved.key || next.revision !== saved.revision || !next.available || !next.canOpenData) {
            onUnavailable("The earlier chart reference is no longer current. Open chart help from the current view.");
            return false;
        }
        if (!sync({ view: saved.view, topic: saved.topic, restoreQuery: saved.rowQuery })) return false;
        if (!currentView(saved.publicationToken)) return false;
        readingScroll().scrollTop = saved.scrollTop;
        const target = findFocus(saved);
        if (!currentView(saved.publicationToken)) return false;
        target?.focus({ preventScroll: true });
        keepFocusVisible(saved.publicationToken);
        return currentView(saved.publicationToken) && root.open;
    }
    return {
        open: topic => sync({ view: "guide", topic }),
        openAnalyze: (start, topic, keepSearchFocus = false) => sync({ view: "guide", keepSearchFocus,
            topic: topics.some(([id]) => id === topic) ? topic : start === "last" && lastAnalyzeTopic ? lastAnalyzeTopic : "outcomes" }),
        close: requestClose,
        leave: () => sync({ view: "closed" }),
        refresh: () => {
            if (contextToken !== null && !currentView()) return;
            if (closing) return;
            const value = state.value(); if (value.view !== "closed") sync(value);
        },
        notify(message) {
            if (!root.open || !currentView()) return false;
            $("chartReferenceNotice").textContent = message;
            $("chartReferenceNotice").hidden = false;
            return true;
        },
        capture, restore, withdrawAccess, value: state.value,
    };
}
