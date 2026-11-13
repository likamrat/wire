export function mountTrends({ root, api, time, ux, createCalendar, mountChart, getContext, recordLink, reload }) {
    const doc = root.ownerDocument, ns = "http://www.w3.org/2000/svg";
    const families = {
        authors: { label: "Prompt authors", modes: [["share", "Interactions %"], ["count", "Interactions"]],
            help: "Each originating interaction counts once per day with a matching call. Unverified authors remain in the denominator. This is not a count of messages sent that day or who executed each call." },
        tools: { label: "Tool usage", modes: [["reach", "Interactions %"], ["share", "Calls %"], ["count", "Calls"]],
            help: "Reach counts an interaction once per tool. Tools overlap. Call share uses all matching calls; a multi-target call is one call. Hiding a series never changes either denominator." },
        services: { label: "Services", modes: [["share", "Calls %"], ["count", "Calls"]],
            help: "Each share uses all matching calls. A call may involve several services. Discovery is preparation, not service execution. Missing targets do not establish which backend services ran." },
        problems: { label: "Errors & failures", modes: [["share", "Interactions %"], ["count", "Interactions"]],
            help: "Interactions with a failed tool or explicit application/API error, divided by all matching interactions. Tool completion can coexist with an API error. Unknown results are not failures; completion is not answer correctness." },
        timing: { label: "Call duration", modes: [["both", "Both"], ["median", "Median"], ["p95", "95th percentile"]],
            help: "Qualified tool-start-to-completion intervals only, using nearest-rank median or P95. Missing samples are not zero. Concurrent calls are not added into a task duration; prompt-to-final-response timing is a different clock." },
        models: { label: "Response models", modes: [["share", "Interactions %"], ["count", "Interactions"]],
            help: "Each recorded model divided by all matching originating interactions, including missing model names. Models can overlap. Tool hints and the current model cannot fill historical provenance gaps." },
        rhythm: { label: "Tool calls", modes: [["count", "Calls"], ["share", "Share within week"]],
            help: "Each day remains separate. Its share uses matching calls within that calendar week and the selected dates. This describes recorded call activity, not hours worked or productivity." },
    };
    const el = (tag, cls, text) => {
        const node = doc.createElement(tag); if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text; return node;
    };
    const svgNode = (tag, attrs) => {
        const node = doc.createElementNS(ns, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        return node;
    };
    const button = (label, action, cls = "quiet") => {
        const node = el("button", cls, label); node.type = "button"; node.addEventListener("click", action); return node;
    };
    const select = (name, choices, change) => {
        const label = el("label", "trends-control"), field = el("select");
        field.id = "trends" + name.replace(/[^A-Za-z0-9]/g, "");
        label.append(el("span", "", name), field);
        for (const [value, text] of choices) { const option = el("option", "", text); option.value = value; field.append(option); }
        field.addEventListener("change", () => change(field.value)); return { label, field };
    };
    const number = value => new Intl.NumberFormat(data?.timeContext.locale ?? "en-US", { maximumFractionDigits: 1 }).format(value);
    const rate = value => value === null ? "Unavailable" : `${number(value)}%`;
    const axisDate = date => date === time.day(new Date().toISOString(), data.timeContext.timeZone) ? "Today" : time.formatDate(date, data.timeContext);
    const fullDate = date => `${axisDate(date) === "Today" ? "Today · " : ""}${time.formatDate(date, data.timeContext, true)}`;
    const authorColors = { user: "var(--screen-prompt-user)", agent: "var(--screen-prompt-agent)", unknown: "var(--muted)" };
    const colors = new Map(), tools = ["fetch", "retrieve", "ask", "get_schema", "call_function", "do_action",
        "search_paths", "fetch_blob", "create_entity", "update_entity", "delete_entity", "list_agents"];
    function color(id, family) {
        if (family === "authors") return authorColors[id];
        if (family === "services") return `var(--chart-service-${id.toLowerCase()}-label)`;
        if (family === "problems") return "var(--danger)";
        if (family === "rhythm") return "var(--trends-series-1)";
        if (family === "timing") return id === "timing" ? "var(--trends-series-1)" : "var(--trends-series-3)";
        const key = `${family}:${id}`;
        if (!colors.has(key)) {
            const known = family === "tools" ? tools.indexOf(id.replace(/^workiq-/, "")) : -1;
            let slot = known >= 0 ? known : [...id].reduce((hash, char) => (hash * 31 + char.codePointAt(0)) >>> 0, 7) % 12;
            if (known < 0) {
                const used = new Set([...colors].filter(([key]) => key.startsWith(family + ":")).map(([, slot]) => slot));
                if (used.size < 12) while (used.has(slot)) slot = (slot + 1) % 12;
            }
            colors.set(key, slot);
        }
        return `var(--trends-series-${colors.get(key) + 1})`;
    }
    function sample(id, family) {
        const svg = svgNode("svg", { viewBox: "0 0 36 16", class: "trends-sample", "aria-hidden": "true" });
        svg.append(svgNode("line", { x1: 1, x2: 35, y1: 8, y2: 8, stroke: color(id, family), "stroke-width": 3 }));
        return svg;
    }
    let data = null, timingData = null, family = null, period = "7", filters = {}, range = null, offset = 0;
    let pending = 0, requestedKey = "", acceptedKey = "", enabled = false, bound = null, lastRevision = null;
    let overviewScroll = 0, dialogOrigin = null, inspecting = null, allCollapsed = null, inspectionKey = "";
    const cards = new Map();
    const toolbar = el("div", "trends-toolbar"), periods = el("div", "trends-periods");
    const status = el("p", "notice"), qualification = el("p", "trends-qualification"), restrictions = el("div", "trends-restrictions");
    status.setAttribute("role", "status"); status.hidden = true;
    for (const days of ["7", "14", "30"]) {
        const control = button(`Last ${days} days`, () => void read({ range: time.preset(days, getContext().timeContext.timeZone), period: days, filters }));
        control.dataset.trendPeriod = days; periods.append(control);
    }
    const custom = button("Custom dates", openDates, "quiet trends-date-range"); custom.dataset.trendPeriod = "custom";
    custom.prepend(ux.icon("calendar")); periods.append(custom);
    const guide = button("Chart guide", openGuide), filtersButton = button("Filters", openFilters);
    guide.prepend(ux.icon("info")); filtersButton.prepend(ux.icon("filter"));
    const collapseAll = button("Collapse all", () => {
        if (!current()) return;
        hideHover();
        if (allCollapsed) {
            for (const [id, collapsed] of allCollapsed) cards.get(id).collapsed = collapsed;
            allCollapsed = null;
        } else if ([...cards.values()].every(card => card.collapsed)) {
            for (const card of cards.values()) card.collapsed = false;
        } else {
            allCollapsed = new Map([...cards].map(([id, card]) => [id, card.collapsed]));
            for (const card of cards.values()) card.collapsed = true;
        }
        paint();
    });
    toolbar.append(periods, filtersButton, guide, collapseAll);
    const restrictionText = el("span"), clearFilters = button("Clear filters", () => void read({ range, period, filters: {}, offset }));
    restrictions.append(restrictionText, clearFilters); restrictions.hidden = true;
    const retry = button("Read stored activity", () => { requestedKey = ""; void reload(); }); retry.hidden = true;
    const detailBar = el("div", "trends-detail-bar"), back = button("Back to overview", restore);
    back.prepend(ux.icon("back"));
    const chooser = select("Trend", Object.entries(families).map(([id, spec]) => [id, spec.label]), maximize);
    detailBar.append(back, chooser.label); detailBar.hidden = true;
    const overview = el("div", "trends-overview");
    const tooltip = el("aside", "trends-tooltip"); tooltip.id = "trendsTooltip"; tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
    const paging = el("div", "trends-paging"), inspection = el("section", "trends-inspection");
    const inspectionHeader = el("div", "trends-inspection-heading"), selectedDate = el("h3"), selectedScope = el("span", "muted");
    const evidenceButton = button("View evidence", showEvidence), exactButton = button("View numbers", () => {
        exact.hidden = !exact.hidden; exactButton.textContent = exact.hidden ? "View numbers" : "Hide numbers";
        if (!exact.hidden) paintExact();
    });
    const inspectionBody = el("div", "trends-inspection-body"), exact = el("div", "trends-exact"); exact.hidden = true; inspection.hidden = true;
    inspectionHeader.append(selectedDate, selectedScope, evidenceButton, exactButton); inspection.append(inspectionHeader, inspectionBody, exact);
    const dialog = el("dialog", "trends-dialog"), dialogTitle = el("h2"), dialogBody = el("div"), dialogHeader = el("div", "trends-dialog-heading");
    dialogTitle.id = "trendsDialogTitle"; dialog.setAttribute("aria-labelledby", dialogTitle.id);
    dialogHeader.append(dialogTitle, button("Close", () => dialog.close())); dialog.append(dialogHeader, dialogBody);
    root.append(toolbar, restrictions, status, retry, qualification, detailBar, overview, paging, inspection, tooltip, dialog);
    dialog.addEventListener("close", () => { scrub(dialogBody); dialogOrigin?.focus({ preventScroll: true }); dialogOrigin = null; });

    for (const id of ["tools", "authors", "rhythm", "services", "problems", "models", "timing"]) {
        const spec = families[id], panel = el("section", "trends-panel"), heading = el("div", "trends-heading"), title = el("h2", "", spec.label);
        panel.dataset.family = id; title.id = `trendsHeading-${id}`; title.tabIndex = -1; panel.setAttribute("aria-labelledby", title.id);
        const sizing = el("div", "trends-sizing"), expand = button("", () => family === id ? restore() : maximize(id), "quiet icon-only");
        const collapse = button("", () => toggleCollapsed(cards.get(id)), "quiet icon-only");
        const identity = el("div", "trends-identity"), titleGroup = el("div", "trends-title-group"), periodLabel = el("span", "trends-period-label");
        periodLabel.id = `trendsPeriod-${id}`; panel.setAttribute("aria-describedby", periodLabel.id);
        titleGroup.append(title, periodLabel); identity.append(titleGroup);
        sizing.append(expand, collapse); heading.append(identity, sizing);
        const content = el("div", "trends-content"), modes = el("div", "trends-modes");
        content.id = `trendsContent-${id}`; collapse.setAttribute("aria-controls", content.id);
        modes.setAttribute("role", "group"); modes.setAttribute("aria-label", `${spec.label} measure`);
        for (const [value, label] of spec.modes) {
            const control = button(label, () => {
                if (!current()) return;
                card.mode = value; paintStable(card);
            });
            control.dataset.trendMode = value; modes.append(control);
        }
        const body = el("div", "trends-chart-body"), summary = el("div", "trends-summary"), totals = el("div", "trends-totals");
        const legend = el("div", "trends-legend"), plot = el("div", "trends-plot");
        plot.id = `trendsPlot-${id}`; plot.tabIndex = 0; plot.setAttribute("role", "region");
        plot.setAttribute("aria-label", `${spec.label} by day. Arrow keys move between dates and series.`);
        const limits = el("p", "trends-limits");
        identity.append(totals); summary.append(legend); body.append(summary, plot);
        heading.insertBefore(modes, sizing);
        content.append(body, limits); panel.append(heading, content); overview.append(panel);
        const card = { id, panel, title, periodLabel, expand, collapse, content, modes, body, summary, totals, legend, plot, limits,
            mode: spec.modes[0][0], hidden: new Set(), selection: null, collapsed: false, key: "", width: 0, height: 0 };
        cards.set(id, card);
        panel.addEventListener("click", event => {
            // Painting can replace the clicked glyph before this event reaches the row.
            if (event.defaultPrevented || event.composedPath().some(node => node instanceof Element
                && node.matches("button,a,input,select,textarea,summary,[role=button]"))) return;
            if (card.collapsed || heading.contains(event.target)) toggleCollapsed(card);
        });
        card.chart = mountChart({ root: plot, tooltip, color, canInspect: current, formatDate: fullDate, formatAxisDate: axisDate,
            onInspect() { if (inspecting !== card) inspecting?.chart.hide(); inspecting = card; },
            onSelect(date, series) { card.selection = { date, id: series }; if (family !== id) maximize(id); else paintInspection(); } });
        const observer = new ResizeObserver(() => {
            if (!current() || !plot.checkVisibility()) return;
            const width = Math.round(plot.clientWidth), height = Math.round(plot.clientHeight);
            if (width === card.width && height === card.height) return;
            card.width = width; card.height = height;
            card.chart.render(viewData(card), id, card.mode, card.hidden);
            if (family === id) { inspectionKey = ""; paintInspection(); }
        });
        observer.observe(plot);
    }
    doc.fonts.ready.then(() => { if (current()) paint(); });
    doc.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.defaultPrevented || dialog.open || !enabled) return;
        if (!tooltip.hidden) { hideHover(); return; }
        if (family) { event.preventDefault(); restore(); }
    });
    function current() { return enabled && bound && api.isCurrent(bound) && !getContext().stale && data?.revision === getContext().revision; }
    function hideHover() { for (const card of cards.values()) card.chart.hide(); inspecting = null; }
    function scrub(node) {
        const walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) text.data = "";
        node.querySelectorAll("*").forEach(child => {
            for (const attribute of [...child.attributes]) { attribute.value = ""; child.removeAttributeNode(attribute); }
            if ("value" in child) child.value = "";
        });
        node.replaceChildren();
    }
    function notice(message) { status.textContent = message; status.hidden = !message; }
    function validate(value, request) {
        const history = value?.coverage?.historySummary;
        if (value?.kind !== "retained-trends" || value.schemaVersion !== 1 || value.revision !== request.expectedRevision
            || value.from !== request.from || value.to !== request.to || JSON.stringify(value.filters) !== JSON.stringify(request.filters)
            || value.timeContext?.timeZone !== request.timeContext.timeZone || !Array.isArray(value.days)
            || value.days.length !== value.window?.count || value.days.length > 90 || !value.totals || !value.definitions
            || value.window.offset !== request.offset || value.days.some(day => !day.date || !Number.isSafeInteger(day.calls)
                || !Number.isSafeInteger(day.interactions) || Object.keys(families).some(id => !Array.isArray(day.values?.[id])))
            || !Array.isArray(value.members) || Object.keys(families).some(id => !Array.isArray(value.definitions[id]))
            || history && (history.scope !== "saved-chats" || history.affectedDates !== "unknown"
                || ["unreadableChats", "limitedChats", "pendingChats"].some(key => !Number.isSafeInteger(history[key]) || history[key] < 0)
                || !history.reasons || Object.values(history.reasons).some(count => !Number.isSafeInteger(count) || count < 0))) {
            throw new Error("Trends returned an invalid or mismatched population. No values were inferred.");
        }
    }
    function latestOffset(next) {
        const days = Math.round((Date.parse(next.to + "T00:00:00Z") - Date.parse(next.from + "T00:00:00Z")) / 86400000) + 1;
        return Math.floor((days - 1) / 90) * 90;
    }
    async function read(next) {
        if (!enabled) return;
        const context = getContext(), token = api.publicationToken(), generation = ++pending, replacing = Boolean(data);
        if (!token || context.stale) { notice("Current stored activity is unavailable. Read the current view before changing Trends."); return; }
        const request = { expectedRevision: context.revision, from: next.range.from, to: next.range.to,
            filters: next.filters, offset: next.offset ?? latestOffset(next.range), timeContext: context.timeContext };
        requestedKey = JSON.stringify(request); root.setAttribute("aria-busy", "true"); hideHover();
        if (!data) { notice("Loading Trends…"); overview.hidden = true; }
        retry.hidden = true;
        try {
            const value = await api("/api/trends", request);
            if (!enabled || generation !== pending) return;
            if (!api.isCurrent(token)) { withdrawAccess(); return; }
            validate(value, request);
            const changedRange = !range || range.from !== next.range.from || range.to !== next.range.to || offset !== request.offset;
            data = value; bound = token; range = next.range; period = next.period; filters = { ...next.filters }; offset = request.offset;
            // These are two encodings of server-qualified samples, not browser-side aggregation.
            const durationValues = values => ({ ...values, timing: [
                { ...values.timing[0], label: "Median" }, { ...values.timing[0], id: "p95", label: "95th percentile" },
            ] });
            timingData = { ...data, definitions: { ...data.definitions, timing: [{ id: "timing", label: "Median" }, { id: "p95", label: "95th percentile" }] },
                totals: { ...data.totals, values: durationValues(data.totals.values) },
                days: data.days.map(day => ({ ...day, values: durationValues(day.values) })) };
            acceptedKey = requestedKey; lastRevision = context.revision; notice("");
            for (const [id, card] of cards) {
                if (changedRange) card.selection = null;
                for (const definition of data.definitions[id]) color(definition.id, id);
            }
            if (replacing) paintStable(family ? cards.get(family) : null);
            else paint();
        } catch (error) {
            if (generation !== pending || !enabled) return;
            if (!api.isCurrent(token)) { withdrawAccess(); return; }
            notice(error.message); retry.hidden = false;
        } finally { if (generation === pending) root.setAttribute("aria-busy", "false"); }
    }
    function maximize(id) {
        if (!Object.hasOwn(families, id) || !current()) return;
        if (!family) overviewScroll = scrollY;
        hideHover(); family = id; cards.get(id).collapsed = false; allCollapsed = null; inspectionKey = "";
        paint(); window.scrollTo({ top: 0, behavior: "instant" }); cards.get(id).title.focus({ preventScroll: true });
    }
    function restore() {
        if (!family) return;
        const card = cards.get(family); hideHover(); family = null; paint();
        window.scrollTo({ top: overviewScroll, behavior: "instant" }); card.expand.focus({ preventScroll: true });
    }
    function toggleCollapsed(card) {
        if (!current()) return;
        hideHover(); allCollapsed = null;
        if (family === card.id) restore();
        card.collapsed = !card.collapsed;
        paintStable(card); card.collapse.focus({ preventScroll: true });
    }
    function openDialog(name) {
        if (!current()) return false;
        hideHover(); dialogOrigin = doc.activeElement; dialogTitle.textContent = name; scrub(dialogBody);
        if (!dialog.open) dialog.showModal(); return true;
    }
    function openDates() {
        if (!openDialog("Custom dates")) return;
        const host = el("div"), actions = el("div", "trends-dialog-actions");
        const calendar = createCalendar({ root: host, id: "trendsCalendar", label: "Trends", time, ux,
            context: () => getContext().timeContext, current, onChange: () => {} });
        calendar.reset(range);
        actions.append(button("Cancel", () => dialog.close()), button("Apply dates", () => {
            if (!calendar.valid()) return;
            const selected = calendar.value(); dialog.close(); void read({ range: selected, period: "custom", filters });
        }));
        dialogBody.append(host, actions);
    }
    function openFilters() {
        if (!openDialog("Filter activity")) return;
        const author = select("Prompt authors", [["", "All, including unverified"], ...data.definitions.authors.map(row => [row.id, row.label])], () => {});
        const tool = select("Tool", [["", "All tools"], ...data.definitions.tools.map(row => [row.id, row.label])], () => {});
        const service = select("Service", [["", "All services"], ...data.definitions.services.map(row => [row.id, row.label]), ["Discovery", "Discovery / preparation"], ["missing", "Missing service detail"]], () => {});
        author.field.value = filters.author ?? ""; tool.field.value = filters.tool ?? ""; service.field.value = filters.service ?? "";
        dialogBody.append(author.label, tool.label, service.label);
        const actions = el("div", "trends-dialog-actions");
        actions.append(button("Cancel", () => dialog.close()), button("Apply filters", () => {
            const next = Object.fromEntries([["author", author.field.value], ["tool", tool.field.value], ["service", service.field.value]].filter(([, value]) => value));
            dialog.close(); void read({ range, period, filters: next, offset });
        })); dialogBody.append(actions);
    }
    function openGuide() {
        if (!openDialog("Chart guide")) return;
        for (const spec of family ? [families[family]] : Object.values(families))
            dialogBody.append(el("h3", "", spec.label), el("p", "", spec.help));
        dialogBody.append(el("h3", "", "Filters and series"), el("p", "", "Filters change the population. Series checkboxes only change what is drawn. Exact numbers include hidden series. A zero denominator has no percentage."),
            el("h3", "", "Dates and evidence"), el("p", "", "Daily call-start dates use your display time zone. Missing timestamps remain undated. One interaction can appear on several days; period totals count it once. Lines moving together establish neither correlation nor cause."));
    }
    function valueText(value, card) {
        const amount = card.chart.metric(value, card.id, card.mode);
        return amount === null ? "Unavailable" : card.id === "timing" ? `${number(amount)} ms`
            : card.mode === "count" ? number(amount) : `${rate(amount)} (${number(card.id === "tools" && card.mode === "reach" ? value.interactions : value.count)})`;
    }
    function metricStat(value, label) {
        const stat = el("div", "trends-stat"); stat.append(el("span", "trends-stat-value", value));
        if (label) stat.append(el("span", "muted", label));
        return stat;
    }
    function viewData(card) { return card.id === "timing" ? timingData : data; }
    function paintCard(card, dateRange) {
        const { id, panel, hidden, mode } = card, spec = families[id], source = viewData(card), totals = source.totals;
        panel.hidden = Boolean(family && family !== id); panel.dataset.maximized = String(family === id); panel.dataset.collapsed = String(card.collapsed);
        panel.dataset.manySeries = String(source.definitions[id].length > 6);
        card.content.hidden = card.collapsed;
        card.modes.hidden = card.collapsed;
        card.totals.hidden = card.collapsed;
        const periodText = `(${dateRange})`;
        if (card.periodLabel.textContent !== periodText) { scrub(card.periodLabel); card.periodLabel.append(doc.createTextNode(periodText)); }
        card.expand.setAttribute("aria-label", `${family === id ? "Restore" : "Maximize"} ${spec.label}`);
        card.expand.replaceChildren(ux.icon(family === id ? "reader-restore" : "reader-maximize"));
        card.collapse.setAttribute("aria-label", `${card.collapsed ? "Expand" : "Collapse"} ${spec.label}`);
        card.collapse.setAttribute("aria-expanded", String(!card.collapsed));
        card.collapse.replaceChildren(ux.icon(card.collapsed ? "chevron" : "chart-collapse"));
        for (const control of card.modes.children) control.setAttribute("aria-pressed", String(control.dataset.trendMode === mode));
        scrub(card.totals);
        if (id === "tools") card.totals.append(metricStat(number(mode === "reach" ? totals.interactions : totals.calls), mode === "reach" ? "interactions" : "tool calls"));
        else if (id === "authors") card.totals.append(metricStat(number(totals.interactions), "interactions"));
        else if (id === "rhythm") card.totals.append(metricStat(number(totals.calls), ""));
        else if (id === "problems") card.totals.append(metricStat(valueText(totals.values[id][0], card), "interactions with errors"));
        const amount = definition => card.chart.metric(totals.values[id].find(value => value.id === definition.id), id, mode) ?? -1;
        const definitions = id === "tools" || id === "services" || id === "models" ? [...source.definitions[id]].sort((a, b) =>
            amount(b) - amount(a) || a.label.localeCompare(b.label)) : source.definitions[id];
        const key = JSON.stringify(definitions);
        if (card.key !== key) {
            scrub(card.legend); card.key = key;
            if (["tools", "authors", "services", "models", "timing"].includes(id)) for (const definition of definitions) {
                const row = el("div", "trends-legend-row"), label = el("label", "trends-series"), check = el("input");
                check.type = "checkbox"; check.dataset.series = definition.id; check.setAttribute("aria-label", `Show ${definition.label}`);
                check.addEventListener("change", () => {
                    if (check.checked) hidden.delete(definition.id); else hidden.add(definition.id);
                    paintStable(card);
                });
                label.append(check, sample(definition.id, id), el("span", "trends-series-label", definition.label));
                const value = el("span", "trends-legend-value"), track = el("span", "trends-value-track"), fill = el("span", "trends-value-fill");
                fill.style.background = color(definition.id, id); track.append(fill); row.append(label, value, track);
                row.addEventListener("pointerenter", () => card.chart.emphasize(definition.id));
                row.addEventListener("pointerleave", () => card.chart.emphasize(null));
                check.addEventListener("focus", () => card.chart.emphasize(definition.id));
                check.addEventListener("blur", () => card.chart.emphasize(null));
                card.legend.append(row);
            }
        }
        for (const row of card.legend.children) {
            const check = row.querySelector("input"), value = totals.values[id].find(value => value.id === check.dataset.series);
            check.checked = !hidden.has(value.id); row.dataset.hidden = String(!check.checked);
            row.querySelector(".trends-legend-value").textContent = valueText(value, card);
            const amount = card.chart.metric(value, id, mode);
            const maximum = mode === "count" ? Math.max(1, totals.calls) : id === "timing" ? Math.max(1, ...totals.values.timing.map(value => card.chart.metric(value, id, mode) ?? 0)) : 100;
            row.querySelector(".trends-value-fill").style.width = `${(amount ?? 0) * 100 / maximum}%`;
        }
        card.summary.hidden = !card.legend.childElementCount;
        card.body.dataset.summary = String(!card.summary.hidden);
        const limits = [];
        if (id === "services") {
            if (totals.missingServices) limits.push(`No service detail: ${rate(totals.serviceMissingShare)} (${number(totals.missingServices)})`);
            if (totals.preparationCalls) limits.push(`${number(totals.preparationCalls)} preparation calls`);
        } else if (id === "models") {
            if (totals.missingModels) limits.push(`Model not recorded: ${rate(totals.modelMissingShare)} (${number(totals.missingModels)})`);
            for (const [status, description] of [["partial", "Partly recorded model names"], ["unverified", "Unverified model names"], ["conflicting", "Conflicting model names"]])
                if (totals.modelCoverage[status]) limits.push(`${description}: ${number(totals.modelCoverage[status])} interactions`);
        } else if (id === "timing") limits.push(totals.calls ? `${rate(totals.timingCoverage)} (${number(totals.timedCalls)}) calls measured` : "No calls with timing in this period");
        else if (id === "problems" && totals.values.problems[0].unknownCalls) limits.push(`Outcome unknown for ${number(totals.values.problems[0].unknownCalls)} ${totals.values.problems[0].unknownCalls === 1 ? "call" : "calls"}`);
        card.limits.textContent = limits.join(" · "); card.limits.hidden = !limits.length;
        if (!panel.hidden && !card.collapsed) {
            card.chart.render(source, id, mode, hidden);
            card.width = Math.round(card.plot.clientWidth); card.height = Math.round(card.plot.clientHeight);
        }
    }
    function paintStable(card) {
        const anchor = card?.panel ?? overview, before = anchor.getBoundingClientRect().top;
        paint();
        window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: "instant" });
    }
    function selectedDay(card) {
        const source = viewData(card);
        return source.days.find(day => day.date === card.selection?.date) ?? source.days.findLast(day => day.calls) ?? source.days.at(-1);
    }
    function evidenceValues(day, card) {
        return day.values[card.id].filter(value => card.selection?.id ? value.id === card.selection.id : shown(value, card));
    }
    function shown(value, card) {
        return !card.hidden.has(value.id) && (card.id !== "timing" || card.mode === "both" || value.id === (card.mode === "p95" ? "p95" : "timing"));
    }
    function paintInspection() {
        if (!current() || !family) return;
        const card = cards.get(family), day = selectedDay(card), key = `${family}:${Math.round(inspectionBody.clientWidth)}`;
        const changedLayout = inspectionKey !== key;
        if (changedLayout) { inspectionKey = key; inspectionBody.style.minHeight = ""; inspectionHeader.style.minHeight = ""; }
        const prior = changedLayout ? 0 : inspectionBody.getBoundingClientRect().height, priorHeader = changedLayout ? 0 : inspectionHeader.getBoundingClientRect().height;
        const selected = day.values[family].find(value => value.id === card.selection?.id);
        selectedDate.textContent = axisDate(day.date);
        const scope = family === "timing" ? `${day.timedCalls} of ${day.calls} calls timed`
            : ["authors", "models", "problems"].includes(family) || card.mode === "reach" ? `${day.interactions} interactions` : `${day.calls} calls`;
        const measure = families[family].modes.find(([id]) => id === card.mode)[1];
        selectedScope.textContent = `${selected ? selected.label + (!shown(selected, card) ? " (hidden)" : "") : "Shown series"} · ${measure} · ${scope}`;
        inspectionHeader.style.minHeight = `${Math.max(priorHeader, inspectionHeader.getBoundingClientRect().height)}px`;
        scrub(inspectionBody);
        for (const value of day.values[family].filter(value => shown(value, card))) {
            const row = el("div", "trends-value-row"), name = el("span", "trends-value-name");
            row.dataset.selected = String(value.id === card.selection?.id);
            name.append(sample(value.id, family), el("span", "trends-series-label", value.label));
            const track = el("span", "trends-value-track"), fill = el("span", "trends-value-fill");
            fill.style.background = color(value.id, family); fill.style.width = `${card.chart.barPercent(value)}%`; track.append(fill);
            if (family === "timing") track.style.visibility = "hidden";
            row.append(name, track, el("span", "trends-value", valueText(value, card))); inspectionBody.append(row);
        }
        inspectionBody.style.minHeight = `${Math.max(prior, inspectionBody.getBoundingClientRect().height)}px`;
        evidenceButton.disabled = !evidenceValues(day, card).some(value => value.rowIds.length);
    }
    function showEvidence() {
        if (!current() || !family) return;
        const card = cards.get(family), day = selectedDay(card), values = evidenceValues(day, card), ids = new Set(values.flatMap(value => value.rowIds));
        if (!openDialog(`${fullDate(day.date)} · ${values.length === 1 ? values[0].label : "Shown series"}`)) return;
        dialogBody.append(el("p", "muted", `${number(ids.size)} matching calls. Opening a call shows its full interaction.`));
        for (const member of data.members.filter(row => ids.has(row.id))) {
            const row = el("div", "trends-evidence-row"), link = recordLink(member);
            if (!current()) { for (const attribute of [...link.attributes]) { attribute.value = ""; link.removeAttributeNode(attribute); } scrub(link); return; }
            link.addEventListener("click", () => dialog.close()); row.append(link, el("span", "muted", member.operation)); dialogBody.append(row);
        }
    }
    function paintExact() {
        scrub(exact); if (!family || exact.hidden) return;
        const card = cards.get(family), source = viewData(card), table = el("table"), header = el("tr");
        for (const label of ["Date", ...source.definitions[family].map(value => value.label), "Interactions", "Calls"]) header.append(el("th", "", label));
        table.append(header);
        for (const day of source.days) {
            const row = el("tr"); row.append(el("th", "", fullDate(day.date)));
            for (const value of day.values[family]) row.append(el("td", "", valueText(value, card)));
            row.append(el("td", "", number(day.interactions)), el("td", "", number(day.calls))); table.append(row);
        }
        exact.append(table);
    }
    function formatRange() {
        const end = axisDate(range.to) === "Today" ? "Today" : time.formatDate(range.to, data.timeContext, true);
        if (range.from === range.to) return end;
        const differentYears = range.from.slice(0, 4) !== range.to.slice(0, 4);
        return `${time.formatDate(range.from, data.timeContext, differentYears)} – ${end}`;
    }
    function paint() {
        if (!current()) return;
        overview.hidden = false; overview.classList.toggle("trends-maximized", Boolean(family));
        detailBar.hidden = !family; inspection.hidden = !family; collapseAll.hidden = Boolean(family);
        collapseAll.textContent = allCollapsed || [...cards.values()].every(card => card.collapsed) ? "Restore all" : "Collapse all";
        if (family) chooser.field.value = family;
        for (const node of periods.children) node.setAttribute("aria-pressed", String(node.dataset.trendPeriod === period));
        const dateRange = formatRange();
        const filterName = (key, value) => (data.definitions[key === "author" ? "authors" : key === "tool" ? "tools" : "services"].find(row => row.id === value)?.label
            ?? ({ Discovery: "Discovery / preparation", missing: "Missing service detail" }[value]) ?? value);
        restrictionText.textContent = Object.entries(filters).map(([key, value]) => filterName(key, value)).join(" · "); restrictions.hidden = !Object.keys(filters).length;
        const limits = [];
        if (data.coverage.undatedCalls) limits.push(`${number(data.coverage.undatedCalls)} calls have no start date and are left out.`);
        if (!data.totals.calls) limits.push("No matching calls in this period. Change the dates or clear filters.");
        qualification.textContent = limits.join(" "); qualification.hidden = !limits.length;
        for (const card of cards.values()) paintCard(card, dateRange);
        paging.replaceChildren(); paging.hidden = data.window.totalDays <= 90;
        if (!paging.hidden) {
            const previous = button("Earlier days", () => void read({ range, period, filters, offset: Math.max(0, offset - 90) }));
            const next = button("Later days", () => void read({ range, period, filters, offset: offset + 90 }));
            previous.disabled = offset === 0; next.disabled = offset + data.window.count >= data.window.totalDays;
            paging.append(previous, el("span", "muted", `${offset + 1}–${offset + data.window.count} of ${data.window.totalDays} days`), next);
        }
        paintInspection(); paintExact();
    }
    function withdrawAccess() {
        pending++; enabled = false; bound = null; data = timingData = null; requestedKey = acceptedKey = ""; lastRevision = null;
        range = null; filters = {}; family = null; offset = 0; period = "7"; colors.clear(); allCollapsed = null; inspecting = null;
        for (const card of cards.values()) {
            card.chart.withdrawAccess(); card.hidden.clear(); card.selection = null; card.key = ""; card.collapsed = false;
            card.mode = families[card.id].modes[0][0];
            for (const node of [card.periodLabel, card.totals, card.legend, card.limits]) scrub(node);
        }
        const selectedText = doc.getSelection();
        if (selectedText && (root.contains(selectedText.anchorNode) || root.contains(selectedText.focusNode))) selectedText.removeAllRanges();
        if (dialog.open) dialog.close(); scrub(dialogBody); dialogTitle.textContent = ""; dialogOrigin = null;
        for (const node of [qualification, inspectionBody, exact, paging, status, selectedDate, selectedScope, restrictionText]) scrub(node);
        inspectionBody.style.minHeight = ""; inspectionHeader.style.minHeight = ""; inspectionKey = ""; root.setAttribute("aria-busy", "false");
    }
    function update() {
        const wasEnabled = enabled, context = getContext();
        if (!context.active) {
            enabled = false; pending++; requestedKey = acceptedKey; root.setAttribute("aria-busy", "false");
            hideHover(); if (dialog.open) dialog.close(); return;
        }
        enabled = true;
        if (!context.publication || context.stale) { hideHover(); return; }
        if (data && !api.isCurrent(bound)) { withdrawAccess(); enabled = true; }
        if (!range) range = time.preset("7", context.timeContext.timeZone);
        const input = { expectedRevision: context.revision, from: range.from, to: range.to, filters, offset, timeContext: context.timeContext };
        const key = JSON.stringify(input);
        if (key !== requestedKey || lastRevision !== context.revision && key === acceptedKey) void read({ range, period, filters, offset });
        else if (data && key === acceptedKey && !wasEnabled) paint();
    }
    return { update, withdrawAccess, leave: () => { hideHover(); if (dialog.open) dialog.close(); } };
}

export const trendsStyles = `
:root{--trends-series-1:#315fad;--trends-series-2:#007a78;--trends-series-3:#7957a0;--trends-series-4:#967000;--trends-series-5:#b14767;--trends-series-6:#467435;--trends-series-7:#006b97;--trends-series-8:#4d56ab;--trends-series-9:#ab6029;--trends-series-10:#8e3f91;--trends-series-11:#b04435;--trends-series-12:#526c80}
:root[data-evidence-theme=dark]{--trends-series-1:#8fb6f2;--trends-series-2:#65c8c0;--trends-series-3:#b99add;--trends-series-4:#d9b866;--trends-series-5:#ed8aa3;--trends-series-6:#9ac58c;--trends-series-7:#63bee4;--trends-series-8:#9da4ec;--trends-series-9:#e5a377;--trends-series-10:#d899d9;--trends-series-11:#e8998b;--trends-series-12:#9eb8ce}
#trendsView{min-width:0;container-type:inline-size}
.trends-toolbar,.trends-periods,.trends-detail-bar,.trends-heading,.trends-inspection-heading,.trends-dialog-heading,.trends-dialog-actions,.trends-restrictions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.trends-toolbar{margin-bottom:16px;gap:8px}.trends-periods{gap:4px;margin-right:auto}
.trends-toolbar>button,.trends-detail-bar>button{display:inline-flex;align-items:center;gap:8px}
.trends-periods button[aria-pressed=true],.trends-modes button[aria-pressed=true]{--pill-fill:var(--accent-soft);--pill-border:var(--control);--pill-hover:var(--accent-hover);--pill-pressed:var(--accent-pressed)}
.trends-date-range{display:inline-flex;align-items:center;gap:8px;max-width:100%;white-space:normal}.trends-date-range>.wire-icon{width:16px;height:16px;flex:none}
.trends-restrictions{margin-bottom:12px}
.trends-detail-bar{justify-content:space-between;margin-bottom:16px}
.trends-control{display:flex;align-items:center;gap:8px;max-width:100%;min-width:0;flex-wrap:wrap}.trends-control select{min-width:0;max-width:100%;width:13rem}
.trends-control .select-control{min-width:0;max-width:100%}
.trends-overview{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0;align-content:start}
.trends-panel{--trends-plot-height:18rem;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);padding:16px 20px;min-width:0;container:trend-card / inline-size}
.trends-panel[data-collapsed=true]{cursor:pointer}
.trends-panel[data-collapsed=true]:hover{border-color:var(--rule)}
.trends-panel[data-collapsed=true] .trends-heading{min-height:max(44px,calc(2 * var(--type-section) * var(--leading-section)))}
.trends-heading{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px 12px;align-items:center;cursor:pointer}
.trends-heading .trends-modes{cursor:default}
.trends-heading h2{min-width:0;font-size:var(--type-section);font-weight:var(--weight-medium);margin:0}
.trends-heading>.trends-sizing{grid-column:3;grid-row:1}
.trends-heading>.trends-modes{grid-column:2;grid-row:1}
.trends-identity{display:flex;align-items:baseline;gap:8px 20px;flex-wrap:wrap;min-width:0}
.trends-title-group{display:flex;align-items:baseline;gap:4px 8px;flex-wrap:wrap;min-width:0}
.trends-period-label{font-size:var(--type-small);line-height:var(--leading-ui);font-weight:var(--weight-regular);color:var(--muted)}
.trends-sizing{display:flex;flex:none;gap:8px}
.trends-sizing>button{width:max(44px,2rem);height:max(44px,2rem);min-width:44px;padding:0}
.trends-sizing>button svg{width:1.125rem;height:1.125rem}
.trends-modes{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:2px;margin:0;min-height:44px}
.trends-modes>button{font-size:var(--type-control);white-space:normal}
.trends-chart-body{display:grid;grid-template-columns:22rem minmax(0,1fr);gap:24px;min-width:0;margin-top:12px}
.trends-chart-body[data-summary=false]{grid-template-columns:minmax(0,1fr)}
.trends-summary{min-width:0;container:trend-summary / inline-size;max-height:var(--trends-plot-height);overflow:auto;scrollbar-gutter:stable}
.trends-totals{display:flex;flex-wrap:wrap;gap:16px;margin:0}.trends-totals:empty{display:none}.trends-stat{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.trends-stat-value{font-size:1.25rem;line-height:var(--leading-heading);font-weight:var(--weight-regular);font-variant-numeric:tabular-nums}
.trends-plot{position:relative;min-width:0;width:100%;height:var(--trends-plot-height);overflow-x:auto;overflow-y:hidden;overflow-anchor:none;overscroll-behavior-x:contain}
.trends-plot svg{display:block;max-width:none}.trends-plot text{fill:var(--muted);font:var(--type-small) var(--font)}
.trends-grid{stroke:var(--surface-divider);stroke-width:1}.trends-plot [data-trend-mark]{outline:none;cursor:pointer}
.trends-plot [data-trend-mark]:focus-visible{stroke:var(--focus);stroke-width:2}
.trends-chart-empty{position:absolute;inset:30px auto auto 70px;background:var(--paper);padding:8px;max-width:calc(100% - 80px)}
.trends-legend{display:grid;gap:0;min-width:0;margin:0}
.trends-legend-row{display:grid;grid-template-columns:minmax(0,1fr) max-content;align-items:center;gap:2px 12px;min-width:0;padding-bottom:6px}
.trends-series{display:flex;align-items:center;gap:6px;min-height:44px;min-width:0;max-width:100%;cursor:pointer}
.trends-series input{accent-color:var(--toggle-on);flex:none}.trends-series-label{min-width:0;overflow-wrap:anywhere;white-space:normal}
.trends-sample{display:inline-block;width:20px;height:12px;flex:none}
.trends-legend-value{font-size:var(--type-body);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.trends-value-track{display:block;height:4px;background:var(--canvas)}.trends-value-fill{display:block;height:100%}
.trends-legend-row>.trends-value-track{grid-column:1/-1}
.trends-legend-row[data-hidden=true]>.trends-value-track{visibility:hidden}
.trends-panel:is([data-family=authors],[data-family=services]) .trends-series-label{white-space:nowrap;overflow-wrap:normal}
.trends-panel:is([data-family=authors],[data-family=models],[data-family=timing]) .trends-legend-row>.trends-value-track{display:none}
.trends-limits,.trends-qualification{font-size:var(--type-small);color:var(--muted);margin:12px 0 0}
.trends-qualification{margin:0 0 16px}.trends-limits:empty{display:none}
.trends-panel[data-maximized=true]{--trends-plot-height:clamp(22rem,48vh,34rem)}
.trends-inspection{margin-top:20px;padding:20px;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius)}
.trends-inspection-heading{margin-bottom:12px}.trends-inspection-heading h3{margin:0;font-size:1.0625rem;font-weight:500}
.trends-inspection-heading>button:first-of-type{margin-left:auto}.trends-inspection-heading .muted{min-width:0;max-width:100%;overflow-wrap:anywhere}
.trends-inspection-body{display:grid;gap:8px;align-content:start;overflow-anchor:none}
.trends-value-row{display:grid;grid-template-columns:minmax(140px,1fr) minmax(50px,2fr) minmax(90px,1fr);align-items:center;gap:16px;min-height:36px}
.trends-value-row[data-selected=true] .trends-sample{outline:1px solid var(--ink);outline-offset:3px}
.trends-value-name{display:flex;align-items:center;gap:8px;min-width:0}.trends-value{text-align:right;font-variant-numeric:tabular-nums}
.trends-paging{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:16px 0}
.trends-exact{overflow:auto}.trends-exact table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.trends-exact th,.trends-exact td{font-weight:400;text-align:right;padding:10px;border-bottom:1px solid var(--surface-divider);white-space:nowrap}
.trends-exact th:first-child{text-align:left}
.trends-dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;background:var(--floating-paper);color:var(--ink);border:1px solid var(--rule);border-radius:var(--radius);padding:24px}
.trends-dialog-heading{justify-content:space-between;margin-bottom:20px}.trends-dialog-heading h2{font-size:1.25rem;margin:0;min-width:0;overflow-wrap:anywhere}
.trends-dialog .trends-control{display:flex;flex-direction:column;align-items:stretch;margin:16px 0}
.trends-dialog .trends-control select{width:100%;min-height:44px}.trends-dialog-actions{justify-content:flex-end;margin-top:20px}
.trends-evidence-row{display:flex;flex-direction:column;gap:6px;padding:14px 0;border-bottom:1px solid var(--surface-divider)}
.trends-tooltip{position:fixed;z-index:var(--layer-tooltip);width:max-content;max-width:20.625rem;overflow:auto;background:var(--floating-paper);color:var(--ink);border:1px solid var(--surface-divider);border-radius:10px;box-shadow:var(--surface-shadow);padding:14px 16px;opacity:0;transition:opacity 110ms ease-out;font-variant-numeric:tabular-nums}
.trends-tooltip.open{opacity:1}.trends-tip-heading{display:flex;justify-content:space-between;gap:22px;margin-bottom:8px}.trends-tip-heading>span:first-child{min-width:0;overflow-wrap:anywhere}.trends-tip-heading>span:last-child{flex:none}.trends-tip-value{font-size:var(--type-title);line-height:1.2}
.trends-tip-series{display:flex;align-items:center;gap:6px}
.trends-tip-caption{color:var(--muted);margin-top:4px}.trends-tip-facts{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 20px;margin:10px 0 0}.trends-tip-facts dt{color:var(--muted);overflow-wrap:anywhere}.trends-tip-facts dd{margin:0;text-align:right}
.trends-tip-table{border-collapse:collapse}.trends-tip-table th,.trends-tip-table td{font-weight:400;text-align:right;padding:5px 8px}.trends-tip-table th:first-child,.trends-tip-table td:first-child{text-align:left;padding-left:0}
@container trend-card (max-width:52rem){
 .trends-chart-body{grid-template-columns:minmax(0,1fr);gap:12px}
 .trends-plot{grid-row:1}
 .trends-summary{grid-row:2;max-height:none;overflow:visible}
 .trends-panel[data-many-series=true] .trends-legend{max-height:18rem;overflow:auto;scrollbar-gutter:stable}
}
@container trend-card (max-width:40rem){
 .trends-heading{grid-template-columns:minmax(0,1fr) auto}
 .trends-heading>.trends-sizing{grid-column:2}
 .trends-heading>.trends-modes{grid-column:1/-1;grid-row:2;justify-content:flex-start}
 .trends-panel[data-collapsed=true] .trends-title-group{flex-direction:column;align-items:flex-start}
}
@container trend-card (max-width:22rem){
 .trends-panel[data-collapsed=true] .trends-title-group h2{min-height:calc(2 * var(--type-section) * var(--leading-section))}
}
@container trend-summary (max-width:21rem){
 .trends-legend-row{grid-template-columns:minmax(0,1fr)}
 .trends-legend-value{text-align:left;padding-inline-start:48px}
}
@media(max-width:800px){.trends-panel,.trends-inspection{padding:16px}.trends-toolbar{gap:4px}}
@media(max-width:600px){.trends-value-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}.trends-value-row>.trends-value-track{grid-column:1/-1;grid-row:2;margin-bottom:8px}.trends-value{grid-row:1;grid-column:2}}
@media(prefers-reduced-motion:reduce){.trends-tooltip{transition:none}}
`;
