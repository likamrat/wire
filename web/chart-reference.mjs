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
        }),
    });
}

export const chartReferenceMarkup = `
<dialog id="meaning" class="chart-reference" aria-labelledby="chartReferenceTitle">
  <div class="chart-reference-heading"><h2 id="chartReferenceTitle" tabindex="-1">Chart guide</h2><button id="closeChartReference" class="quiet" type="button" aria-label="Close chart guide">Close</button></div>
  <div id="chartReferenceBody" class="chart-reference-body">
  <p id="chartReferenceNotice" class="notice" role="status" hidden></p>
  <p id="chartReferenceStatus" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></p>
  <section id="chartReferenceIndex" class="chart-reference-index" aria-labelledby="chartReferenceIndexTitle" hidden>
    <h3 id="chartReferenceIndexTitle" tabindex="-1">Choose a chart</h3>
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
    renderExact, openComparisonRecords, onUnavailable, publicationToken, isCurrent, motionTiming }) {
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
        ["services", "Services and operations"], ["models", "Response models"],
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
    const control = (text, action, className = "quiet") => {
        const button = el("button", text, className), token = contextToken;
        button.type = "button";
        button.addEventListener("click", () => {
            if (button.isConnected && root.open && !closing && ["guide", "index"].includes(state.value().view)
                && button.checkVisibility() && currentView(token)) action();
        });
        return button;
    };
    let context, contextToken = null, renderKey, exactRender = null, size = null, lastFocused = null, returnFocus = trigger, rowQuery = "";
    let motion = null, closing = false;
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
        move(false);
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
    function countShare(tag, { count, percentage }) {
        const value = el(tag, undefined, "chart-reference-value");
        value.append(doc.createTextNode(number(count)));
        if (!context.model?.separateUnits) value.append(doc.createTextNode(" "), el("span", `(${percentage})`, "chart-reference-share"));
        return value;
    }
    function definition(label, description, { value, outcome } = {}) {
        const row = el("div", undefined, "chart-reference-definition"), term = el("dt"), detail = el("dd", description, "chart-reference-definition-copy");
        if (outcome) {
            const cue = el("span", undefined, `chart-reference-outcome result-tone-${outcome}`);
            cue.setAttribute("aria-hidden", "true"); cue.append(icon(outcome)); term.append(cue);
            detail.classList.add("chart-reference-cued");
        }
        term.append(doc.createTextNode(label)); row.append(term);
        if (description) row.append(detail);
        if (value !== undefined) row.append(countShare("dd", value));
        return row;
    }
    function topicName(topic) {
        if (topic === "outcomes") return context.mode === "comparison" ? "Results by period"
            : results.outcomeTitle(context.layer, context.model);
        if (context.mode === "comparison") {
            return { time: context.layer === "tool" ? "Call timing" : "Recorded timing",
                categories: "Reading the comparison" }[topic];
        }
        if (context.layer !== "tool") {
            if (topic === "tools") return "Tools behind these records";
            if (topic === "categories") return "Service categories";
            if (topic === "paths") return "API paths";
        }
        return topics.find(([id]) => id === topic)[1];
    }
    function intro(topic) {
        if (context.mode === "comparison") {
            if (topic === "outcomes") return "Shares use the matching records in each period. Recorded results do not establish whole-task correctness.";
            if (topic === "time") return context.layer === "code-reference" ? help.layers[context.layer] : help.facts.Duration;
            return "Change is Period B minus Period A. The periods keep their own records and coverage.";
        }
        if (topic === "outcomes") return context.layer === "tool"
            ? "Worked means tool completion, not answer correctness."
            : help.layers[context.layer];
        if (topic === "time") return "";
        if (topic === "services") return "A record can involve several services, so counts can overlap.";
        if (topic === "models") return "Counts interactions by original response model. One interaction may use several models.";
        if (topic === "tools") return "";
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
        else section.append(el("p", topic === "paths" ? "Paths were not recorded." : "Service targets were not recorded."));
        host.append(section);
    }
    function outcomeGuide(host) {
        const names = results.labels(context.layer), section = group();
        const header = el("div", undefined, "chart-reference-group-heading");
        if (showFacts()) header.append(el("span", `${number(context.model.total)} ${results.unit(context.layer, context.model.total)}`, "muted"));
        section.append(header);
        const keys = context.layer === "code-reference" ? ["unknown"] : outcomeKeys;
        const rows = keys => {
            const list = el("dl", undefined, "chart-reference-definitions");
            for (const key of keys) {
                const fact = context.model?.outcomes.rows.find(row => row.id === key);
                list.append(definition(names[key], context.layer === "tool" && ["success", "failure"].includes(key) ? "" : help.resultMeaning(key, context.layer), {
                    outcome: key, value: showFacts() ? fact : undefined,
                }));
            }
            return list;
        };
        section.append(rows(keys));
        if (context.model?.separateUnits && !context.nativeView) section.append(el("p", "These results use different source units.", "chart-reference-help"));
        host.append(section);
    }
    function serviceGuide(host) {
        const section = group(), data = context.model?.services;
        if (showFacts()) {
            if (data.missingDetailCount) section.append(el("p",
                `${number(data.missingDetailCount)} records have missing service details${data.partialCount ? `; ${number(data.partialCount)} also have a known service` : ""}.`));
            const list = el("div", undefined, "chart-reference-services");
            for (const row of data.recordedRows) {
                const item = el("div", undefined, `chart-reference-service dimensional-tone-${dimensional.tone(row.id)}`);
                const line = el("div"), label = el("span", undefined, "chart-reference-service-name"), swatch = el("i", undefined, "chart-reference-service-key");
                swatch.setAttribute("aria-hidden", "true"); label.append(swatch, doc.createTextNode(row.label));
                line.append(label, countShare("span", row));
                const track = el("span", undefined, "chart-reference-service-track"), fill = el("i");
                track.setAttribute("aria-hidden", "true"); track.hidden = Boolean(context.model.separateUnits);
                fill.style.width = `${row.fraction * 100}%`;
                track.append(fill); item.append(line, track); list.append(item);
            }
            section.append(list);
            host.append(section);
        }
        const meanings = group(), list = el("dl", undefined, "chart-reference-definitions");
        if (context.layer === "tool") list.append(definition("Search / retrieval", "A tool-purpose association, not proof of downstream service execution."),
            definition(categories.operation("workiq-ask").label, categories.operation("workiq-ask").description));
        else list.append(definition("Evidence", help.layers[context.layer]));
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
            list.append(definition("Dates and grouping", "Weeks start Monday, in the display time zone."));
        } else if (topic === "models") {
            if (showFacts()) {
                const section = group(), data = context.model.models;
                section.append(el("p", `${number(data.total)} matching interactions. Model counts can overlap.`));
                const coverage = { recorded: "Recorded", partial: "Partly recorded", unavailable: "Not recorded", unverified: "Not verified", conflicting: "Conflicting" };
                for (const [key, label] of Object.entries(coverage)) list.append(definition(label, `${number(data.coverage[key])} interactions`));
                host.append(section);
            } else list.append(definition("Not recorded", "Original response model names are unavailable."),
                definition("Partly recorded", "Some model information is missing."));
        } else if (topic === "tools") {
            list.append(definition("Discovery / preparation", "API, schema or agent lookup, not data-service execution."),
                definition("Tool outcome", help.facts["Tool outcome"]));
        } else if (topic === "categories") {
            const used = showFacts() ? categories.used(context.facts.categories) : categories.entries;
            for (const item of used) list.append(definition(item.label, item.description));
        } else {
            list.append(definition("Path not recorded", "No usable path was saved."),
                definition("Other", "Smaller groups; listed individually in Exact numbers."));
        }
        const section = group(); section.append(list); host.append(section);
    }
    function renderIndex() {
        const topic = state.value().topic, navigation = $("chartReferenceTopics");
        navigation.replaceChildren();
        const visible = context.mode === "comparison" ? topics.filter(([id]) => ["outcomes", "time", "categories"].includes(id)) : topics;
        for (const [key] of visible) {
            const button = control(topicName(key), () => navigate("guide", key), "chart-reference-topic");
            button.append(ux.icon("next"));
            button.dataset.referenceTopic = key; button.setAttribute("aria-pressed", String(key === topic));
            button.setAttribute("aria-controls", "chartReferenceExplanation"); navigation.append(button);
        }
        $("chartReferenceIndexTitle").textContent = context.mode === "comparison" ? "Compare periods" : "Choose a chart";
        $("chartReferenceAllTopics").replaceChildren(ux.icon("back"), doc.createTextNode(context.mode === "comparison" ? "All topics" : "All charts"));
    }
    function renderGuide() {
        const topic = state.value().topic;
        renderIndex();
        const host = $("chartReferenceExplanation");
        const title = el("h3", topicName(topic)); title.id = "chartReferenceTopicTitle"; title.tabIndex = -1;
        host.replaceChildren(title);
        const introduction = context.nativeOnly ? topic === "outcomes" && context.layer === "tool"
            ? "Worked means tool completion, not answer correctness." : "" : intro(topic);
        if (introduction) host.append(el("p", introduction, "chart-reference-intro"));
        qualify(host);
        if (context.nativeView) nativeGuide(host, topic);
        if (!context.nativeOnly) {
            if (context.nativeView) host.append(el("h3", "GitHub Copilot"));
            if (topic === "outcomes") outcomeGuide(host);
            else if (topic === "services") serviceGuide(host);
            else otherGuide(host, topic);
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
        exactRender = null;
        exactQualification();
        $("chartReferenceGuide").hidden = !guide;
        $("chartReferenceIndex").hidden = !index;
        $("chartReferenceExact").hidden = current.view !== "data";
        $("chartReferenceSource").hidden = !context.canOpenData;
        $("chartReferenceNotice").textContent = context.notice || "";
        $("chartReferenceNotice").hidden = !context.notice;
        root.dataset.revision = context.revision === undefined ? "" : String(context.revision);
        root.dataset.referenceView = current.view; root.dataset.referenceTopic = current.topic;
        if (index) renderIndex();
        else if (guide) renderGuide();
        else {
            $("chartReferenceDataTitle").textContent = topicName(current.topic);
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
    function sync({ view = "closed", topic = state.value().topic, restoreFocus = false, restoreQuery } = {}) {
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
            if (restoreFocus && currentView(token) && !root.open && state.value().view === "closed"
                && returnFocus?.checkVisibility()) returnFocus.focus({ preventScroll: true });
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
        const key = JSON.stringify([context.key, view, topic, context.notice, context.qualification, context.qualificationParts,
            context.coverage, context.available, context.canOpenData, rowQuery]);
        const focus = activeFocus();
        if (key !== renderKey) {
            paint();
            if (!currentView(token)) return false;
            renderKey = key;
            if (previous.view !== view || previous.topic !== topic) readingRegion().scrollTop = 0;
        }
        if (!opening && context.available && context.canOpenData && previousContextKey !== context.key) {
            $("chartReferenceStatus").textContent = context.mode === "comparison" ? "Period records are now available." : topicName(topic) + " values updated.";
        }
        if (!currentView(token)) return false;
        if (opening) {
            returnFocus = trigger;
            host.hidden = false;
            watchSize(token);
            root.showModal();
            if (!currentView(token) || !root.open) return false;
            trigger.setAttribute("aria-expanded", "true");
            $("chartReferenceTitle").focus({ preventScroll: true });
            move(true);
        } else if (reopening) {
            move(true);
            $("chartReferenceTitle").focus({ preventScroll: true });
        } else if (previous.view !== view) {
            const target = view === "data" ? $("chartReferenceDataTitle")
                : view === "index" ? $("chartReferenceTopics").querySelector("[aria-pressed=true]") || $("chartReferenceIndexTitle")
                    : previous.view === "data" ? $("chartReferenceShowData") : $("chartReferenceTopicTitle");
            target.focus({ preventScroll: true });
        } else if (focus) {
            const target = findFocus(focus) || (view === "data" ? $("chartReferenceDataTitle") : $("chartReferenceTopicTitle"));
            target.focus({ preventScroll: true });
            keepFocusVisible();
        }
        return currentView(token) && root.open && state.value().view !== "closed";
    }
    $("closeChartReference").replaceChildren(ux.icon("close"));
    trigger.setAttribute("aria-controls", root.id);
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    $("closeChartReference").addEventListener("click", requestClose);
    $("chartReferenceBack").addEventListener("click", () => {
        if (root.open && !closing && state.value().view === "data" && currentView()) navigate("guide", state.value().topic);
    });
    $("chartReferenceAllTopics").addEventListener("click", () => {
        if (root.open && !closing && state.value().view === "guide" && currentView()) navigate("index");
    });
    $("chartReferenceFindInput").addEventListener("input", event => {
        if (!root.open || closing || state.value().view !== "data" || state.value().topic !== "paths" || !currentView() || !context.canOpenData) return;
        rowQuery = event.target.value;
        paint({ resetPage: true });
    });
    root.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
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
        rowQuery = ""; lastFocused = null; returnFocus = null;
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
        return { ...state.value(), publicationToken: contextToken, key: context.key, revision: context.revision, scrollTop: readingRegion().scrollTop, rowQuery,
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
        readingRegion().scrollTop = saved.scrollTop;
        const target = findFocus(saved);
        if (!currentView(saved.publicationToken)) return false;
        target?.focus({ preventScroll: true });
        keepFocusVisible(saved.publicationToken);
        return currentView(saved.publicationToken) && root.open;
    }
    return {
        open: topic => sync({ view: "guide", topic }),
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
