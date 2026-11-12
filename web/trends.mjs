export function mountTrends({ root, api, time, ux, createCalendar, mountChart, getContext, recordLink, reload }) {
    const doc = root.ownerDocument;
    const families = {
        authors: { label: "Prompt authors", title: "Who is starting the work?", description: "My prompts and agent prompts", icon: "account", modes: [["share", "Share"], ["count", "Interactions"]],
            help: "Each originating interaction counts once per day with a matching call. Unverified authors remain in the denominator. This is not a count of messages sent that day or who executed each call." },
        tools: { label: "Tools", title: "Which tools are becoming more common?", description: "Frequency and reach", icon: "search-tool", modes: [["reach", "Interaction reach"], ["count", "Calls"], ["share", "Call share"]],
            help: "Reach counts an interaction once per tool. Tools overlap. Call share uses all matching calls; a multi-target call is one call. Hiding a series never changes either denominator." },
        services: { label: "Services", title: "Which services appear in the work?", description: "Service involvement", icon: "settings-connection", modes: [["share", "Call share"], ["count", "Calls"]],
            help: "Each share uses all matching calls. A call may involve several services. Discovery is preparation, not service execution. Missing targets do not establish which backend services ran." },
        problems: { label: "Errors & failures", title: "Where are recorded problems appearing?", description: "Failures and their reasons", icon: "warning", modes: [["share", "Interaction share"], ["count", "Interactions"]],
            help: "Interactions with a failed tool or explicit application/API error, divided by all matching interactions. Tool completion can coexist with an API error. Unknown results are not failures; completion is not answer correctness." },
        timing: { label: "Timing", title: "How is recorded tool latency changing?", description: "Call latency", icon: "clock", modes: [["median", "Median"], ["p95", "P95"]],
            help: "Qualified tool-start-to-completion intervals only, using nearest-rank median or P95. Missing samples are not zero. Concurrent calls are not added into a task duration; prompt-to-final-response timing is a different clock." },
        models: { label: "Response models", title: "Which recorded models appear over time?", description: "Model usage", icon: "settings-ai", modes: [["share", "Interaction share"], ["count", "Interactions"]],
            help: "Each recorded model divided by all matching originating interactions, including missing model names. Models can overlap. Tool hints and the current model cannot fill historical provenance gaps." },
        rhythm: { label: "Activity rhythm", title: "When does recorded activity occur?", description: "Activity by day", icon: "activity", modes: [["share", "Share within week"], ["count", "Calls"]],
            help: "Each day remains separate. Its share uses matching calls within that calendar week and the selected dates. This describes recorded call activity, not hours worked or productivity." },
    };
    const number = value => new Intl.NumberFormat(data?.timeContext.locale ?? "en-US", { maximumFractionDigits: 1 }).format(value);
    const rate = value => value === null ? "Unavailable" : `${number(value)}%`;
    const el = (tag, cls, text) => {
        const node = doc.createElement(tag); if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text; return node;
    };
    const button = (label, action, cls = "quiet") => {
        const node = el("button", cls, label); node.type = "button"; node.addEventListener("click", action); return node;
    };
    const select = (name, choices, change) => {
        const label = el("label", "trends-control"), field = el("select");
        field.id = "trends" + name.replace(/[^A-Za-z0-9]/g, "");
        if (name === "Show") field.dataset.selectWidth = "options";
        label.append(el("span", "", name), field);
        for (const [value, text] of choices) { const option = el("option", "", text); option.value = value; field.append(option); }
        field.addEventListener("change", () => change(field.value)); return { label, field };
    };
    const fixedColors = { user: "var(--screen-prompt-user)", agent: "var(--screen-prompt-agent)", unknown: "var(--muted)",
        Files: "var(--screen-service-files)", Mail: "var(--trends-mail)", Calendar: "var(--trends-calendar)", Teams: "var(--trends-teams)",
        problems: "var(--danger)" };
    const color = (id, family) => fixedColors[id] ?? ["var(--screen-prompt-user)", "var(--screen-service-files)", "var(--screen-prompt-agent)", "var(--screen-activity-assistance)"]
        [Math.max(0, data?.definitions[family]?.findIndex(value => value.id === id) ?? 0) % 4];
    let data = null, selection = null, hidden = new Set(), family = null, mode = "share", period = "7", filters = {};
    let range = null, offset = 0, pending = 0, requestedKey = "", acceptedKey = "", enabled = false, bound = null, lastRevision = null;
    let choices = null, preferenceRead = false, overviewScroll = 0, overviewTrigger = null, inspectionKey = "";
    const preferenceKey = "wire.trends.highlights.v1";
    const toolbar = el("div", "trends-toolbar"), periodChoices = el("div", "trends-periods"), caption = el("p", "trends-caption");
    const status = el("p", "notice"), overview = el("section", "trends-overview"), detail = el("section", "trends-detail");
    status.setAttribute("role", "status"); status.hidden = true;
    const guide = button("Chart guide", openGuide), filtersButton = button("Filters", openFilters);
    guide.prepend(ux.icon("info")); filtersButton.prepend(ux.icon("filter"));
    periodChoices.append(el("span", "muted", "Period"));
    for (const days of ["7", "14", "30"]) {
        const control = button(`Last ${days} days`, () => {
            const next = time.preset(days, getContext().timeContext.timeZone);
            void read({ range: next, period: days, filters, offset: 0 });
        });
        control.dataset.trendPeriod = days; periodChoices.append(control);
    }
    const custom = button("Custom dates", openDates); custom.dataset.trendPeriod = "custom"; periodChoices.append(custom);
    const retry = button("Read stored activity", () => { requestedKey = ""; void reload(); }); retry.hidden = true;
    toolbar.append(periodChoices, guide, filtersButton);
    const restrictions = el("div", "trends-restrictions"), clearFilters = button("Clear filters", () => void read({ range, period, filters: {}, offset: 0 }));
    const restrictionText = el("span"); restrictions.append(restrictionText, clearFilters); restrictions.hidden = true;
    const detailBar = el("div", "trends-detail-bar"), back = button("Back to Trends", () => {
        family = null; chart.hide(); paint(); window.scrollTo({ top: overviewScroll, behavior: "instant" });
        overview.querySelector(`[data-family="${overviewTrigger}"]`)?.focus({ preventScroll: true });
    });
    back.prepend(ux.icon("back"));
    const chooser = select("Trend", Object.entries(families).map(([id, value]) => [id, value.label]), chooseFamily);
    detailBar.append(back, chooser.label);
    const panel = el("section", "trends-panel"), heading = el("div", "trends-heading"), title = el("h2");
    const measure = select("Show", [], value => { mode = value; paintStable(); });
    heading.append(title, measure.label);
    const totals = el("div", "trends-totals"), qualification = el("p", "trends-qualification"), unitRow = el("div", "trends-unit-row");
    const unit = el("span"), shown = el("span", "muted"); shown.title = "Hiding series does not change the denominator"; unitRow.append(unit, shown);
    const plot = el("div", "trends-plot"); plot.id = "trendsPlot"; plot.tabIndex = 0; plot.setAttribute("role", "region");
    plot.setAttribute("aria-label", "Daily trend. Arrow keys move between dates and series.");
    const tooltip = el("aside", "trends-tooltip"); tooltip.id = "trendsTooltip"; tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
    const legend = el("div", "trends-legend"), paging = el("div", "trends-paging"), exact = el("div", "trends-exact"); exact.hidden = true;
    const exactButton = button("View numbers", () => { exact.hidden = !exact.hidden; exactButton.textContent = exact.hidden ? "View numbers" : "Hide numbers"; });
    const inspection = el("section", "trends-inspection"), inspectionHeader = el("div", "trends-inspection-heading");
    const selectedDate = el("h3"), selectedScope = el("span", "muted"), evidenceButton = button("View evidence", showEvidence, "trends-outline");
    inspectionHeader.append(selectedDate, selectedScope, evidenceButton);
    const inspectionBody = el("div", "trends-inspection-body"); inspection.append(inspectionHeader, inspectionBody);
    panel.append(heading, totals, qualification, unitRow, plot, legend, paging, exactButton, inspection, exact);
    detail.append(detailBar, panel);
    const dialog = el("dialog", "trends-dialog"), dialogTitle = el("h2"), close = button("Close", () => dialog.close());
    const dialogBody = el("div"), dialogHeader = el("div", "trends-dialog-heading");
    dialogTitle.id = "trendsDialogTitle"; dialog.setAttribute("aria-labelledby", dialogTitle.id);
    dialogHeader.append(dialogTitle, close); dialog.append(dialogHeader, dialogBody);
    root.append(toolbar, caption, restrictions, status, retry, overview, detail, tooltip, dialog);
    let dialogOrigin = null;
    dialog.addEventListener("close", () => { scrub(dialogBody); dialogOrigin?.focus({ preventScroll: true }); dialogOrigin = null; });
    const chart = mountChart({ root: plot, tooltip, color, canInspect: current, formatDate: date => time.formatDate(date, data.timeContext),
        onSelect(date, id) { selection = { date, id }; paintInspection(); } });
    let plotWidth = 0;
    const observer = new ResizeObserver(() => {
        if (enabled && data && family && plot.checkVisibility()) {
            if (Math.round(plot.clientWidth) !== plotWidth) {
                plotWidth = Math.round(plot.clientWidth);
                inspectionKey = "";
                paintInspection();
            }
            if (current()) chart.render(data, family, mode, hidden);
        }
    }); observer.observe(plot);
    function current() { return enabled && bound && api.isCurrent(bound) && !getContext().stale && data?.revision === getContext().revision; }
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
    function readPreference() {
        if (preferenceRead) return; preferenceRead = true;
        try {
            const raw = localStorage.getItem(preferenceKey);
            if (raw === null) return;
            const value = JSON.parse(raw);
            if (!Array.isArray(value) || !value.length || value.length > 7 || new Set(value).size !== value.length || value.some(id => !Object.hasOwn(families, id))) throw new TypeError("Saved Trends choices are invalid.");
            choices = value;
        } catch (error) {
            if (!["SecurityError", "SyntaxError", "TypeError"].includes(error.name)) throw error;
            notice("Saved highlight choices are unavailable. Suggestions are shown.");
        }
    }
    function savePreference(value) {
        try { value === null ? localStorage.removeItem(preferenceKey) : localStorage.setItem(preferenceKey, JSON.stringify(value)); }
        catch (error) {
            if (!["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
            notice("Highlight choices could not be saved. They apply to this view only.");
        }
        choices = value;
    }
    function validate(value, request) {
        if (value?.kind !== "retained-trends" || value.schemaVersion !== 1 || value.revision !== request.expectedRevision
            || value.from !== request.from || value.to !== request.to || JSON.stringify(value.filters) !== JSON.stringify(request.filters)
            || value.timeContext?.timeZone !== request.timeContext.timeZone || !Array.isArray(value.days)
            || value.days.length !== value.window?.count || value.days.length > 90 || !value.totals || !value.definitions
            || value.window.offset !== request.offset || value.days.some(day => !day.date || !Number.isSafeInteger(day.calls)
                || !Number.isSafeInteger(day.interactions) || Object.keys(families).some(id => !Array.isArray(day.values?.[id])))
            || !Array.isArray(value.members) || !Array.isArray(value.suggestions)
            || Object.keys(families).some(id => !Array.isArray(value.definitions[id]))) {
            throw new Error("Trends returned an invalid or mismatched population. No values were inferred.");
        }
    }
    async function read(next) {
        if (!enabled) return;
        const context = getContext(), token = api.publicationToken(), generation = ++pending;
        if (!token || context.stale) { notice("Current stored activity is unavailable. Read the current view before changing Trends."); return; }
        const request = { expectedRevision: context.revision, from: next.range.from, to: next.range.to,
            filters: next.filters, offset: next.offset, timeContext: context.timeContext };
        requestedKey = JSON.stringify(request); root.setAttribute("aria-busy", "true");
        if (!data) { notice("Loading Trends…"); overview.hidden = true; detail.hidden = true; }
        retry.hidden = true;
        try {
            const value = await api("/api/trends", request);
            if (!enabled || generation !== pending) return;
            if (!api.isCurrent(token)) { withdrawAccess(); return; }
            validate(value, request);
            data = value; bound = token; range = next.range; period = next.period; filters = { ...next.filters }; offset = next.offset;
            if (family) hidden = new Set([...hidden].filter(id => data.definitions[family].some(value => value.id === id)));
            acceptedKey = requestedKey; lastRevision = context.revision; notice(""); readPreference();
            selection = next.selectedDate ? { date: next.selectedDate, id: next.selectedSeries ?? null } : null;
            if (next.family) {
                family = next.family; mode = families[family].modes[0][0]; hidden = new Set(); inspectionKey = "";
                exact.hidden = true; paint(); chart.reveal(selection?.date);
                title.tabIndex = -1; title.focus({ preventScroll: true });
            } else paintStable();
        } catch (error) {
            if (generation !== pending || !enabled) return;
            if (!api.isCurrent(token)) { withdrawAccess(); return; }
            if (next.family && data) paint();
            notice(error.message); retry.hidden = false;
        } finally { if (generation === pending) root.setAttribute("aria-busy", "false"); }
    }
    function chooseFamily(id, selectedDay = null, selectedSeries = null) {
        if (!Object.hasOwn(families, id) || !current()) return;
        if (!family) overviewScroll = scrollY;
        if (selectedDay && !data.days.some(day => day.date === selectedDay)) {
            const index = (Date.parse(selectedDay + "T00:00:00Z") - Date.parse(range.from + "T00:00:00Z")) / 86400000;
            overview.hidden = true; detail.hidden = true;
            notice(`Opening ${time.formatDate(selectedDay, data.timeContext)}…`);
            void read({ range, period, filters, offset: Math.floor(index / 90) * 90, family: id, selectedDate: selectedDay, selectedSeries });
            return;
        }
        family = id; mode = families[id].modes[0][0]; hidden = new Set();
        selection = selectedDay ? { date: selectedDay, id: selectedSeries } : null; inspectionKey = "";
        exact.hidden = true; paint(); chart.reveal(selection?.date); title.tabIndex = -1; title.focus({ preventScroll: true });
    }
    function openDialog(name) {
        if (!current()) return false;
        chart.hide(); dialogOrigin = doc.activeElement; dialogTitle.textContent = name; scrub(dialogBody);
        if (!dialog.open) dialog.showModal(); return true;
    }
    function openDates() {
        if (!openDialog("Custom dates")) return;
        const calendarHost = el("div"), actions = el("div", "trends-dialog-actions");
        const calendar = createCalendar({ root: calendarHost, id: "trendsCalendar", label: "Trends", time, ux,
            context: () => getContext().timeContext, current, onChange: () => {} });
        calendar.reset(range);
        actions.append(button("Cancel", () => dialog.close()), button("Apply dates", () => {
            if (!calendar.valid()) return;
            const selected = calendar.value(); dialog.close(); void read({ range: selected, period: "custom", filters, offset: 0 });
        }));
        dialogBody.append(calendarHost, actions);
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
            dialog.close(); void read({ range, period, filters: next, offset: 0 });
        })); dialogBody.append(actions);
    }
    function openGuide() {
        if (!openDialog("Chart guide")) return;
        const topic = families[family];
        dialogBody.append(el("h3", "", topic?.label ?? "Suggested highlights"),
            el("p", "", topic?.help ?? "Suggestions describe observed share changes, not significance or causes. They require at least three complete days with five eligible records at each endpoint and a change of at least five percentage points."),
            el("h3", "", "Filters and series"), el("p", "", "Filters change the population. Series checkboxes only change what is drawn. Exact numbers include hidden series. A zero denominator has no percentage."),
            el("h3", "", "Dates and evidence"), el("p", "", "Daily call-start dates use your display time zone. Missing timestamps remain undated. One interaction can appear on several days; period totals count it once. Lines moving together establish neither correlation nor cause."));
    }
    function customize() {
        if (!openDialog("Choose highlights")) return;
        const selected = choices ?? data.suggestions.map(value => value.family), inputs = [];
        for (const [id, value] of Object.entries(families)) {
            const label = el("label", "trends-choice"), input = el("input"); input.type = "checkbox"; input.value = id; input.checked = selected.includes(id);
            label.append(input, doc.createTextNode(value.label)); dialogBody.append(label); inputs.push(input);
        }
        const error = el("p", "error"); error.setAttribute("role", "alert");
        const actions = el("div", "trends-dialog-actions");
        actions.append(button("Use suggestions", () => { savePreference(null); dialog.close(); paint(); }),
            button("Use my choices", () => {
                const next = inputs.filter(input => input.checked).map(input => input.value);
                if (!next.length) { error.textContent = "Choose a trend, or use suggestions."; return; }
                savePreference(next); dialog.close(); paint();
            })); dialogBody.append(error, actions);
    }
    function paintOverview() {
        scrub(overview);
        const bar = el("div", "trends-overview-heading"); bar.append(el("h2", "", choices ? "Your overview" : "Suggested highlights"), button("Choose highlights", customize));
        overview.append(bar);
        const cards = el("div", "trends-highlights"), selected = choices ?? data.suggestions.map(value => value.family);
        for (const id of selected) {
            const suggestion = data.suggestions.find(value => value.family === id), card = button("", () => { overviewTrigger = id; chooseFamily(id, suggestion?.last.date, suggestion?.id); }, "trends-highlight");
            card.dataset.family = id; card.append(el("h3", "", suggestion?.first.value.label ?? families[id].label));
            if (suggestion) {
                for (const side of [suggestion.first, suggestion.last]) {
                    const value = side.value, n = id === "tools" ? value.interactions : value.count, d = id === "tools" ? value.reachEligible : value.eligible;
                    const line = el("div", "trends-preview-values"); line.append(el("span", "", time.formatDate(side.date, data.timeContext)), el("span", "", `${rate(side.fraction)} (${n} of ${d})`));
                    const track = el("div", "trends-value-track"), fill = el("span", "trends-value-fill"); fill.style.width = `${side.fraction}%`; fill.style.background = color(value.id, id); track.append(fill); card.append(line, track);
                }
                const unit = id === "tools" ? "Interaction reach" : id === "services" ? "Call share" : "Interaction share";
                card.append(el("p", "trends-preview-delta", `${unit} · ${number(Math.abs(suggestion.difference))} percentage points ${suggestion.difference > 0 ? "higher" : "lower"}`));
            } else card.append(el("p", "muted", "No comparable change to highlight"));
            cards.append(card);
        }
        if (!selected.length) cards.append(el("p", "muted", "No supported changes to highlight. Explore the trends below."));
        overview.append(cards, el("h2", "trends-market-title", "What would you like to explore?"));
        for (const [id, value] of Object.entries(families)) {
            const entry = button("", () => { overviewTrigger = id; chooseFamily(id); }, "trends-option"); entry.dataset.family = id;
            entry.append(ux.icon(value.icon), el("strong", "", value.label), el("span", "muted", value.description), ux.icon("next")); overview.append(entry);
        }
    }
    function paintStable() {
        const top = detail.getBoundingClientRect().top, left = plot.scrollLeft, staying = Boolean(family);
        paint(); plot.scrollLeft = left;
        if (staying) window.scrollBy({ top: detail.getBoundingClientRect().top - top, behavior: "instant" });
    }
    function valueText(value) {
        const amount = chart.metric(value, family, mode);
        return amount === null ? "Unavailable" : family === "timing" ? `${number(amount)} ms`
            : mode === "count" ? number(amount) : `${rate(amount)} (${family === "tools" && mode === "reach" ? value.interactions : value.count})`;
    }
    function paintInspection() {
        if (!current() || !family) return;
        const day = data.days.find(day => day.date === selection?.date) ?? data.days.at(-1), key = `${family}:${Math.round(inspectionBody.clientWidth)}`;
        const changedLayout = inspectionKey !== key;
        if (changedLayout) { inspectionKey = key; inspectionBody.style.minHeight = ""; inspectionHeader.style.minHeight = ""; }
        const prior = changedLayout ? 0 : inspectionBody.getBoundingClientRect().height;
        const priorHeader = changedLayout ? 0 : inspectionHeader.getBoundingClientRect().height;
        const selected = day.values[family].find(value => value.id === selection?.id);
        selectedDate.textContent = time.formatDate(day.date, data.timeContext);
        const scope = family === "timing" ? `${day.timedCalls} of ${day.calls} calls timed`
            : ["authors", "models", "problems"].includes(family) || mode === "reach" ? `${day.interactions} interactions` : `${day.calls} calls`;
        const measureName = families[family].modes.find(([id]) => id === mode)[1];
        selectedScope.textContent = selected ? `${selected.label}${hidden.has(selected.id) ? " (hidden)" : ""} · ${measureName} · ${scope}`
            : `${day.values[family].length > 1 ? "Shown series" : measureName} · ${scope}`;
        inspectionHeader.style.minHeight = `${Math.max(priorHeader, inspectionHeader.getBoundingClientRect().height)}px`;
        scrub(inspectionBody);
        for (const value of day.values[family].filter(value => !hidden.has(value.id))) {
            const row = el("div", "trends-value-row"), name = el("span", "trends-value-name"), swatch = el("i", "trends-swatch");
            row.dataset.selected = String(value.id === selection?.id);
            swatch.style.background = color(value.id, family); name.append(swatch, el("span", "trends-series-label", value.label));
            const track = el("span", "trends-value-track"), fill = el("span", "trends-value-fill");
            fill.style.background = color(value.id, family);
            fill.style.width = `${chart.barPercent(value)}%`; track.append(fill);
            if (family === "timing") track.style.visibility = "hidden";
            row.append(name, track, el("span", "trends-value", valueText(value))); inspectionBody.append(row);
        }
        inspectionBody.style.minHeight = `${Math.max(prior, inspectionBody.getBoundingClientRect().height)}px`;
        evidenceButton.disabled = !evidenceValues(day).some(value => value.rowIds.length);
    }
    function evidenceValues(day) {
        return day.values[family].filter(value => selection?.id ? value.id === selection.id : !hidden.has(value.id));
    }
    function showEvidence() {
        if (!current()) return;
        const day = data.days.find(day => day.date === selection?.date) ?? data.days.at(-1), values = evidenceValues(day);
        const ids = new Set(values.flatMap(value => value.rowIds));
        if (!openDialog(`${time.formatDate(day.date, data.timeContext)} · ${values.length === 1 ? values[0].label : "Shown series"}`)) return;
        dialogBody.append(el("p", "muted", `${number(ids.size)} matching calls. Opening a call shows its full interaction.`));
        for (const member of data.members.filter(row => ids.has(row.id))) {
            const row = el("div", "trends-evidence-row");
            const link = recordLink(member);
            if (!current()) {
                for (const attribute of [...link.attributes]) { attribute.value = ""; link.removeAttributeNode(attribute); }
                scrub(link); return;
            }
            link.addEventListener("click", () => dialog.close());
            row.append(link, el("span", "muted", member.operation)); dialogBody.append(row);
        }
    }
    function paint() {
        if (!current()) return;
        for (const node of periodChoices.querySelectorAll("[data-trend-period]")) node.setAttribute("aria-pressed", String(node.dataset.trendPeriod === period));
        caption.textContent = `${time.formatDate(range.from, data.timeContext, true)} – ${time.formatDate(range.to, data.timeContext, true)} · Daily · ${time.displayLabel(data.timeContext)}`;
        const applied = Object.values(filters); restrictionText.textContent = applied.join(" · "); restrictions.hidden = !applied.length;
        overview.hidden = Boolean(family); detail.hidden = !family; guide.hidden = filtersButton.hidden = !family;
        if (!family) { chart.hide(); paintOverview(); return; }
        const spec = families[family]; chooser.field.value = family; title.textContent = spec.title;
        if (measure.field.dataset.family !== family) {
            measure.field.replaceChildren(...spec.modes.map(([id, name]) => { const node = el("option", "", name); node.value = id; return node; }));
            measure.field.dataset.family = family;
        }
        measure.field.value = mode;
        const stats = [[data.totals.interactions, "Interactions"], [data.totals.calls, "Tool calls"]];
        if (family === "timing") stats.push([data.totals.timingCoverage === null ? "Unavailable" : `${rate(data.totals.timingCoverage)} (${data.totals.timedCalls})`, "Calls with timing"]);
        if (family === "models") stats.push([data.totals.modelMissingShare === null ? "Unavailable" : `${rate(data.totals.modelMissingShare)} (${data.totals.missingModels})`, "Model unavailable"]);
        if (family === "services") stats.push([data.totals.serviceMissingShare === null ? "Unavailable" : `${rate(data.totals.serviceMissingShare)} (${data.totals.missingServices})`, "No service detail"]);
        totals.replaceChildren(...stats.map(([value, name]) => { const stat = el("div", "trends-stat"); stat.append(el("span", "trends-stat-value", typeof value === "number" ? number(value) : value), el("span", "muted", name)); return stat; }));
        const limits = [];
        if (data.coverage.history === "partial") limits.push("Incomplete history");
        if (data.coverage.undatedCalls) limits.push(`${data.coverage.undatedCalls} undated calls excluded`);
        if (data.days.some(day => !day.complete && day.calls)) limits.push("Current day incomplete");
        if (family === "models") for (const [status, caption] of [["partial", "partial"], ["unverified", "unverified"], ["conflicting", "conflicting"]]) {
            if (data.totals.modelCoverage[status]) limits.push(`${data.totals.modelCoverage[status]} ${caption} model records`);
        }
        qualification.textContent = limits.join(" · "); qualification.hidden = !limits.length;
        unit.textContent = family === "timing" ? "Tool latency · milliseconds" : family === "rhythm" ? mode === "count" ? "Calls by day" : "Daily share within each week"
            :             `${["authors", "models", "problems"].includes(family) || mode === "reach" ? "Interactions" : "Calls"}${["services", "models"].includes(family) || mode === "reach" ? " · overlapping" : ""}`;
        shown.textContent = hidden.size ? `${data.definitions[family].length - hidden.size}/${data.definitions[family].length} shown` : "";
        if (legend.dataset.key !== `${family}:${JSON.stringify(data.definitions[family])}`) {
            scrub(legend);
            for (const definition of data.definitions[family]) {
                if (["timing", "problems", "rhythm"].includes(family)) continue;
                const label = el("label", "trends-series"), check = el("input"), swatch = el("i", "trends-swatch");
                check.type = "checkbox"; check.dataset.series = definition.id; check.setAttribute("aria-label", `Show ${definition.label}`);
                check.addEventListener("change", () => { if (check.checked) hidden.delete(definition.id); else hidden.add(definition.id); paintStable(); });
                swatch.style.background = color(definition.id, family);
                if (data.definitions[family].length > 1) label.append(check);
                label.append(swatch, el("span", "trends-series-label", definition.label)); legend.append(label);
            }
            legend.dataset.key = `${family}:${JSON.stringify(data.definitions[family])}`;
        }
        legend.querySelectorAll("input").forEach(node => { node.checked = !hidden.has(node.dataset.series); });
        chart.render(data, family, mode, hidden);
        paging.replaceChildren(); paging.hidden = data.window.totalDays <= 90;
        if (!paging.hidden) {
            const previous = button("Earlier days", () => void read({ range, period, filters, offset: Math.max(0, offset - 90) }));
            const next = button("Later days", () => void read({ range, period, filters, offset: offset + 90 }));
            previous.disabled = offset === 0; next.disabled = offset + data.window.count >= data.window.totalDays;
            paging.append(previous, el("span", "muted", `${offset + 1}–${offset + data.window.count} of ${data.window.totalDays} days`), next);
        }
        scrub(exact);
        const table = el("table"), header = el("tr");
        for (const label of ["Date", ...data.definitions[family].map(value => value.label), "Interactions", "Calls"]) header.append(el("th", "", label));
        table.append(header);
        for (const day of data.days) {
            const row = el("tr"); row.append(el("th", "", time.formatDate(day.date, data.timeContext)));
            for (const value of day.values[family]) row.append(el("td", "", valueText(value)));
            row.append(el("td", "", number(day.interactions)), el("td", "", number(day.calls))); table.append(row);
        }
        exact.append(table); paintInspection();
    }
    function withdrawAccess() {
        pending++; enabled = false; bound = null; data = null; selection = null; requestedKey = acceptedKey = ""; lastRevision = null;
        range = null; filters = {}; hidden.clear(); family = null; offset = 0; period = "7";
        chart.withdrawAccess();
        const selectedText = doc.getSelection();
        if (selectedText && (root.contains(selectedText.anchorNode) || root.contains(selectedText.focusNode))) selectedText.removeAllRanges();
        if (dialog.open) dialog.close(); scrub(dialogBody); dialogTitle.textContent = ""; dialogOrigin = null;
        for (const node of [overview, totals, qualification, legend, inspectionBody, exact, paging, caption, status, selectedDate, selectedScope, restrictionText]) scrub(node);
        const keyAttribute = legend.getAttributeNode("data-key");
        if (keyAttribute) { keyAttribute.value = ""; legend.removeAttributeNode(keyAttribute); }
        inspectionBody.style.minHeight = ""; inspectionHeader.style.minHeight = ""; inspectionKey = ""; root.setAttribute("aria-busy", "false");
    }
    function update() {
        const wasEnabled = enabled, context = getContext();
        if (!context.active) {
            enabled = false; pending++; requestedKey = acceptedKey; root.setAttribute("aria-busy", "false");
            chart.hide(); if (dialog.open) dialog.close(); return;
        }
        enabled = true;
        if (!context.publication || context.stale) { chart.hide(); return; }
        if (data && !api.isCurrent(bound)) { withdrawAccess(); enabled = true; }
        if (!range) range = time.preset("7", context.timeContext.timeZone);
        const input = { expectedRevision: context.revision, from: range.from, to: range.to, filters, offset, timeContext: context.timeContext };
        const key = JSON.stringify(input);
        if (key !== requestedKey || lastRevision !== context.revision && key === acceptedKey) void read({ range, period, filters, offset });
        else if (data && key === acceptedKey && !wasEnabled) paint();
    }
    return { update, withdrawAccess, leave: () => { chart.hide(); if (dialog.open) dialog.close(); } };
}

export const trendsStyles = `
:root{--trends-mail:#91460e;--trends-calendar:#215bd1;--trends-teams:#6842ba}
:root[data-evidence-theme=dark]{--trends-mail:#e98d4a;--trends-calendar:#5792fa;--trends-teams:#ad88f0}
#trendsView{min-width:0}
.trends-toolbar,.trends-periods,.trends-detail-bar,.trends-heading,.trends-overview-heading,.trends-inspection-heading,.trends-dialog-heading,.trends-dialog-actions,.trends-restrictions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.trends-toolbar{margin-bottom:10px}.trends-toolbar>button:first-of-type{margin-left:auto}
.trends-toolbar>button,.trends-detail-bar>button{display:inline-flex;align-items:center;gap:8px}
.trends-periods button[aria-pressed=true]{--pill-fill:var(--accent-soft);--pill-border:var(--control);--pill-hover:var(--accent-hover);--pill-pressed:var(--accent-pressed)}
.trends-caption{color:var(--muted);margin:10px 0 22px}.trends-restrictions{margin-bottom:12px}
.trends-detail-bar,.trends-overview-heading{justify-content:space-between;margin-bottom:16px}
.trends-control{display:flex;flex-direction:row;align-items:center;gap:8px;max-width:100%;min-width:0;flex-wrap:wrap}.trends-control select{min-width:0;max-width:100%;width:13rem}
.trends-control .select-control{min-width:0;max-width:100%}
.trends-heading{justify-content:space-between}.trends-heading h2{flex:1 1 16rem;min-width:0;font-size:var(--type-section);font-weight:500;margin:0}
.trends-panel{background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);padding:24px;min-width:0}
.trends-totals{display:flex;flex-wrap:wrap;gap:32px;margin:26px 0}.trends-stat{display:flex;flex-direction:column;gap:2px;min-width:110px}
.trends-stat-value{font-size:1.625rem;line-height:1.2;font-variant-numeric:tabular-nums}
.trends-unit-row{display:grid;grid-template-columns:minmax(0,1fr) 3.75rem;align-items:center;min-height:calc(2em * var(--leading-ui));gap:12px;margin:8px 0 12px;color:var(--muted)}
.trends-unit-row>span:last-child{text-align:right;font-size:var(--type-caption)}.trends-qualification{padding:10px;background:var(--accent-soft);border-radius:6px;color:var(--muted)}
.trends-plot{position:relative;min-width:0;width:100%;min-height:22.875rem;overflow:auto;overflow-anchor:none;overscroll-behavior-x:contain}
.trends-plot svg{display:block;max-width:none;height:22.125rem}.trends-plot text{fill:var(--muted);font:.8125rem var(--font)}
.trends-grid{stroke:var(--surface-divider);stroke-width:1}.trends-plot [data-trend-mark]{outline:none;cursor:pointer}
.trends-plot [data-trend-mark]:focus-visible{stroke:var(--focus);stroke-width:2}
.trends-chart-empty{position:absolute;inset:30px auto auto 70px;background:var(--paper);padding:12px}
.trends-calendar{display:grid;grid-template-columns:5.3125rem repeat(7,minmax(5.125rem,1fr));gap:8px;min-width:46.25rem;padding:20px 0}
.trends-day-name{text-align:center;color:var(--muted)}.trends-week-name{align-self:center;color:var(--muted)}
.trends-day-cell{--trends-cell-fill:color-mix(in srgb,var(--screen-prompt-user) calc(var(--trends-heat)*40%),var(--paper));--pill-fill:var(--trends-cell-fill);--pill-hover:var(--trends-cell-fill);--pill-pressed:var(--trends-cell-fill);--pill-border:var(--surface-divider);min-height:48px;border-radius:6px;font-variant-numeric:tabular-nums}
.trends-day-cell:hover{outline:1px solid var(--control)}
.trends-legend{display:flex;flex-wrap:wrap;gap:8px 24px;margin-top:16px;margin-bottom:18px}
.trends-series{display:flex;align-items:center;gap:8px;min-height:44px;min-width:0;max-width:100%;cursor:pointer}.trends-series input{accent-color:var(--toggle-on);flex:none}
.trends-series-label{min-width:0;overflow-wrap:anywhere;white-space:normal}
.trends-swatch{display:inline-block;width:12px;height:12px;border-radius:2px;flex:none}
.trends-inspection{margin-top:20px;padding-top:20px;border-top:1px solid var(--surface-divider)}
.trends-inspection-heading{margin-bottom:12px}.trends-inspection-heading h3{margin:0;font-size:1.0625rem;font-weight:500}.trends-inspection-heading button{margin-left:auto}
.trends-inspection-heading .muted{min-width:0;max-width:100%;overflow-wrap:anywhere}
.trends-inspection-body{display:grid;gap:8px;align-content:start;overflow-anchor:none}
.trends-value-row{display:grid;grid-template-columns:minmax(140px,1fr) minmax(50px,2fr) minmax(90px,1fr);align-items:center;gap:16px;min-height:36px}
.trends-value-row[data-selected=true] .trends-swatch{outline:1px solid var(--ink);outline-offset:3px}
.trends-value-name{display:flex;align-items:center;gap:8px;min-width:0}.trends-value{text-align:right;font-variant-numeric:tabular-nums}
.trends-value-track{display:block;height:8px;background:var(--canvas)}.trends-value-fill{display:block;height:100%}
.trends-paging{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0}
.trends-exact{overflow:auto}.trends-exact table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.trends-exact th,.trends-exact td{font-weight:400;text-align:right;padding:10px;border-bottom:1px solid var(--surface-divider);white-space:nowrap}
.trends-exact th:first-child{text-align:left}
.trends-highlights{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:16px;margin-bottom:26px}
.trends-highlight{display:flex;flex-direction:column;align-items:stretch;justify-content:flex-start;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);padding:18px;text-align:left;white-space:normal}
.trends-highlight h3{font-size:var(--type-reading);font-weight:500;margin:0 0 12px;overflow-wrap:anywhere}.trends-preview-values{display:flex;justify-content:space-between;gap:12px;margin:10px 0 5px}
.trends-preview-delta{font-size:var(--type-body);color:var(--muted);margin:12px 0 0}.trends-market-title{font-size:1.1875rem;font-weight:500;margin:0 0 12px}
.trends-option{display:grid;grid-template-columns:20px 11rem minmax(0,1fr) 16px;align-items:center;gap:12px;width:100%;min-height:62px;padding:10px 12px;border:0;border-bottom:1px solid var(--surface-divider);border-radius:0;background:transparent;text-align:left;white-space:normal}
.trends-option[data-family=authors]{--trends-option-ink:var(--screen-prompt-user)}
.trends-option[data-family=problems]{--trends-option-ink:var(--danger)}
.trends-option>strong,.trends-option>svg:first-child{color:var(--trends-option-ink,var(--ink))}
.trends-option>strong{font-size:var(--type-reading);font-weight:500}.trends-option>svg{width:20px;height:20px}.trends-option>svg:last-child{width:16px;height:16px}
.trends-dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;background:var(--floating-paper);color:var(--ink);border:1px solid var(--rule);border-radius:var(--radius);padding:24px}
.trends-dialog-heading{justify-content:space-between;margin-bottom:20px}.trends-dialog-heading h2{font-size:1.25rem;margin:0;min-width:0;overflow-wrap:anywhere}
.trends-dialog .trends-control{display:flex;flex-direction:column;align-items:stretch;margin:16px 0}
.trends-dialog .trends-control select{width:100%;min-height:44px}.trends-dialog-actions{justify-content:flex-end;margin-top:20px}
.trends-choice{display:flex;align-items:center;gap:12px;min-height:48px;border-bottom:1px solid var(--surface-divider)}
.trends-evidence-row{display:flex;flex-direction:column;gap:6px;padding:14px 0;border-bottom:1px solid var(--surface-divider)}
.trends-tooltip{position:fixed;z-index:var(--layer-tooltip);width:max-content;max-width:20.625rem;overflow:auto;background:var(--floating-paper);color:var(--ink);border:1px solid var(--surface-divider);border-radius:10px;box-shadow:var(--surface-shadow);padding:14px 16px;opacity:0;transition:opacity 110ms ease-out;font-variant-numeric:tabular-nums}
.trends-tooltip.open{opacity:1}.trends-tip-heading{display:flex;justify-content:space-between;gap:22px;margin-bottom:8px}.trends-tip-heading>span:first-child{min-width:0;overflow-wrap:anywhere}.trends-tip-heading>span:last-child{flex:none}.trends-tip-value{font-size:var(--type-title);line-height:1.2}
.trends-tip-caption{color:var(--muted);margin-top:4px}.trends-tip-facts{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 20px;margin:10px 0 0}.trends-tip-facts dt{color:var(--muted);overflow-wrap:anywhere}.trends-tip-facts dd{margin:0;text-align:right}
.trends-tip-table{border-collapse:collapse}.trends-tip-table th,.trends-tip-table td{font-weight:400;text-align:right;padding:5px 8px}.trends-tip-table th:first-child,.trends-tip-table td:first-child{text-align:left;padding-left:0}
@media(max-width:800px){.trends-option{grid-template-columns:20px minmax(0,1fr) 16px;gap:4px 12px}.trends-option>svg:first-child{grid-row:1/3}.trends-option>strong{grid-column:2;grid-row:1}.trends-option>span{grid-column:2;grid-row:2}.trends-option>svg:last-child{grid-column:3;grid-row:1/3}.trends-panel{padding:16px}}
@media(max-width:600px){.trends-value-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}.trends-value-track{grid-column:1/-1;grid-row:2;margin-bottom:8px}.trends-value{grid-row:1;grid-column:2}}
@media(prefers-reduced-motion:reduce){.trends-tooltip{transition:none}}
`;
