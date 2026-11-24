export function mountTrends({ root, api, time, ux, authorship, questionControls, createCalendar, mountChart, createTrendPairModel, mountTrendPair, getContext, recordLink, reload, returnToAnalyze, onScopeChange, onSectionChange, onComparePeriods, onUsageReport, hiddenInteraction = () => false }) {
    const doc = root.ownerDocument, ns = "http://www.w3.org/2000/svg";
    const order = ["problems", "rhythm", "tools", "services", "timing", "authors", "models", "usage"];
    const families = {
        usage: { label: "Tokens & est. cost", modes: [["usd", "Est. USD"], ["tokens", "Tokens"]],
            help: "Each whole interaction counts once, on its first matching call date in this period. Later matching calls from that interaction do not add its tokens again. These are not per-tool charges." },
        authors: { label: "Prompt authors", modes: [["share", "Interactions %"], ["count", "Interactions"]],
            help: "Each originating interaction counts once per day with a matching call, even if its sender is unclear. The sender is who asked, not who ran the tool." },
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
    const directionButton = (label, action, direction = "forward", cls = "quiet") => {
        const node = button("", action, `${cls} icon-action`), text = el("span", "", label);
        node.append(text);
        if (direction === "back") node.prepend(ux.icon(direction));
        else node.append(ux.icon(direction));
        return node;
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
        if (family === "usage" && id === "usage") return cards.get("usage")?.mode === "usd" ? "var(--usage-cost)" : "var(--accent)";
        if (family === "usage" && id.startsWith("author:")) return authorColors[({"Human":"user","Agent":"agent","Author unverified":"unknown"})[id.slice(7)]];
        if (family === "authors") return authorColors[id];
        if (family === "services") return `var(--chart-service-${id.toLowerCase()}-label)`;
        if (family === "problems") return "var(--chart-mark-high)";
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
    function authorIcon(id) {
        const node = ux.icon("author-" + id);
        node.classList.add("trends-author-icon");
        return node;
    }
    function sample(id, family) {
        if (family === "authors") return authorIcon(id);
        const svg = svgNode("svg", { viewBox: "0 0 36 16", class: "trends-sample", "aria-hidden": "true" });
        svg.append(svgNode("line", { x1: 1, x2: 35, y1: 8, y2: 8, stroke: color(id, family), "stroke-width": 3 }));
        return svg;
    }
    let data = null, timingData = null, family = null, period = "7", filters = {}, range = null, offset = 0;
    let usageChoice = { question:"all", threshold:30000 };
    let pending = 0, requestedKey = "", acceptedKey = "", enabled = false, bound = null, lastRevision = null;
    let overviewScroll = 0, dialogOrigin = null, inspecting = null, allCollapsed = null, inspectionKey = "";
    let evidenceReturn = null, pendingTimer = 0;
    let activeMeasure = "rhythm", allCharts = false, compared = new Set(), entryKey = null, acceptedEntry = null, readingRevision = null, readingZone = null, failedRead = null;
    let routeScopeKey, section = "overview";
    function rememberScope(kind) {
        onScopeChange?.({ family: family ?? activeMeasure, period, range, filters }, kind);
        routeScopeKey = JSON.stringify(getContext().routeScope ?? null);
    }
    const cards = new Map();
    const toolbar = el("div", "trends-toolbar workspace-command-row"), toolbarContext = el("span","workspace-command-context"),
        toolbarTools = el("div","workspace-command-tools");
    const status = el("p", "notice"), qualification = el("p", "trends-qualification"), restrictions = el("div", "trends-restrictions");
    const pendingNotice = el("p", "trends-pending");
    pendingNotice.setAttribute("role", "status");
    status.setAttribute("role", "status"); status.hidden = true;
    const filtersButton = button("", openFilters, "quiet filter-entry");
    filtersButton.append(ux.icon("filter"), el("span", "filter-entry-label", "Filters"));
    filtersButton.setAttribute("aria-haspopup", "dialog");
    filtersButton.setAttribute("aria-expanded", "false");
    const sections = el("nav", "wire-section-nav"), guide = el("section", "trends-guide");
    sections.setAttribute("aria-label", "Trends sections");
    for (const [id, label, icon] of [["overview","Overview","section-overview"],["charts","Charts","section-charts"],["guide","Chart guide","section-guide"]]) {
        const control = button(label, () => {
            if (!enabled || section === id || !getContext().publication || getContext().stale) return;
            hideHover(); onSectionChange(id);
        });
        control.id = `trends-section-${id}`; control.dataset.section = id; control.prepend(ux.icon(icon)); sections.append(control);
    }
    guide.hidden = true;
    const guideIndex = el("nav"), guideArticle = el("article");
    const guideContext = el("p","trends-guide-context"), guideBack = directionButton("Back to charts",()=>{if(current())onSectionChange("charts");},"back");
    guideIndex.setAttribute("aria-label","Chart guide topics"); guide.append(guideIndex,guideArticle);
    const guideTopics = [
        ["Compare measures", "Do two measures change on the same days?", "Choose any two readings. One graph is available when their units and counting groups match. For call volume and duration, read the same date on aligned charts with separate scales.", "In four interactions, two can have an error and three can use a tool. That is 50% and 75%; it does not tell you which interactions overlap."],
        ["Dates and evidence", "Which calls contributed to this point?", "Select a date, then open its matching calls. The reader shows the full interaction, which may contain other calls.", "Calls are dated by their recorded start. An undated call cannot be placed on the graph."],
        ["Filters and series", "Why did the total change?", "Filters change which calls are counted. Showing or hiding a line changes only the drawing.", "No matching calls gives a count of zero. With nothing to divide by, a percentage is unavailable."],
        ...order.map(id => [families[id].label, {
            problems:"How many interactions had a recorded error?",rhythm:"How many calls started each day?",tools:"How widely or often was a tool used?",
            services:"Which services appeared in calls?",timing:"How long did measured calls take?",authors:"Who wrote the originating prompts?",models:"Which models were recorded?",usage:"How did token volume and estimated cost change?",
        }[id],families[id].help,{
            problems:"Two failed calls in one interaction count as one affected interaction that day.",rhythm:"Three calls on Monday and one on Tuesday make Monday’s share 75% if those were the week’s only matching calls.",
            tools:"Three uses of one tool in a single interaction count as three calls but one interaction reached.",services:"One call naming both Mail and Files contributes to both series, but is still one call.",
            timing:"With no qualified interval, the duration is unavailable, not zero milliseconds.",authors:"A human prompt followed by three calls counts as one originating interaction that day.",
            models:"An interaction with two recorded models contributes to both model series.",
            usage:"Two matching tool calls from the same prompt do not double its tokens. Unpriced interactions add tokens but no dollar estimate.",
        }[id]])];
    function readTopic(i, focus=false) {
        const [label,question,reading,example]=guideTopics[i];
        for(const [j,node] of [...guideIndex.children].entries()) {
            if(i===j) node.setAttribute("aria-current","page"); else node.removeAttribute("aria-current");
        }
        const h=el("h2","",label);h.tabIndex=-1;guideArticle.replaceChildren(h,el("h3","",question),el("p","",reading),el("h3","","For example"),el("p","",example));
        guideArticle.append(guideContext,guideBack); if(focus) h.focus({preventScroll:true});
    }
    guideTopics.forEach(([name],i)=>guideIndex.append(button(name,()=>readTopic(i,true))));
    readTopic(0);
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
    const filterActions = el("div", "trends-filter-actions");
    filterActions.append(filtersButton); toolbarTools.append(collapseAll, filterActions); toolbar.append(toolbarContext,toolbarTools);
    const restrictionText = el("span"), clearFilters = button("Clear filters", () => void read({ range, period, filters: {}, offset, remember: "filters" }));
    restrictions.append(restrictionText, clearFilters); restrictions.hidden = true;
    const retry = button("Read stored activity", () => {
        const context = getContext();
        if (failedRead && api.isCurrent(failedRead.token) && !context.stale && context.revision === failedRead.revision
            && (!failedRead.next.entry || context.entry?.key === failedRead.next.entry.key) && context.timeContext.timeZone === failedRead.zone) {
            void read(failedRead.next);
        } else { requestedKey = ""; entryKey = null; void reload(); }
    }); retry.hidden = true;
    const detailBar = el("div", "trends-detail-bar"), back = button("Back to overview", restore);
    back.prepend(ux.icon("back"));
    const chooser = select("Trend", order.map(id => [id, families[id].label]), maximize);
    detailBar.append(back, chooser.label); detailBar.hidden = true;
    const overview = el("div", "trends-overview");
    const index = el("nav", "trends-measure-index"), workspace = el("div", "trends-workspace");
    index.setAttribute("aria-label", "Trend measures");
    for (const id of order) {
        const link = button(families[id].label, () => chooseMeasure(id), "trends-measure");
        link.dataset.measure = id; link.setAttribute("aria-controls", `trendsHeading-${id}`); index.append(link);
    }
    const periodButton = el("button");
    periodButton.id = "trendsPeriod";
    periodButton.disabled = true; filtersButton.disabled = true;
    const comparePeriods = button("Compare periods", () => {
        if (!current() || !openDialog("Compare periods")) return;
        const from=range.from, to=range.to, days=data.window.totalDays;
        // The preceding range can fall outside the supported calendar for an early custom period.
        const earliest = Date.parse("0001-01-01T00:00:00Z");
        if (Date.parse(from + "T00:00:00Z") - days * 86400000 < earliest) {
            dialogBody.append(el("p","","There is no earlier period of this length in the supported calendar. Choose a shorter or later period."));
            return;
        }
        const priorEnd=time.addDays(from,-1), priorStart=time.addDays(from,-days);
        const selectedFilters={...filters}, revision=data.revision;
        const clearMissing = selectedFilters.service === "missing";
        dialogBody.append(el("p","",`${time.formatCivilRange(priorStart,priorEnd,data.timeContext)} compared with ${time.formatCivilRange(from,to,data.timeContext)}`));
        if (getContext().hasMicrosoftSource) dialogBody.append(el("p","muted","This comparison includes GitHub Copilot calls only."));
        if (clearMissing) dialogBody.append(el("p","muted","The Missing service detail filter does not carry over."));
        const actions=el("div","trends-dialog-actions");
        actions.append(button("Cancel",()=>dialog.close()),directionButton("Open comparison",()=>{
            if (!current() || data.revision!==revision || range.from!==from || range.to!==to || JSON.stringify(filters)!==JSON.stringify(selectedFilters)) return;
            dialog.close(); comparePeriods.focus({preventScroll:true});
            onComparePeriods({aFrom:priorStart,aTo:priorEnd,bFrom:from,bTo:to},selectedFilters,
                (family ?? activeMeasure) === "usage" ? {...usageChoice,unit:cards.get("usage").mode} : undefined);
        },"forward","primary"));dialogBody.append(actions);
    });
    comparePeriods.id="trendsComparePeriods";toolbarTools.prepend(periodButton,comparePeriods);
    const homeBack = button("Back to Analyze", () => { if (current() && getContext().entry) returnToAnalyze?.(); });
    homeBack.prepend(ux.icon("back")); homeBack.hidden = true; toolbar.prepend(homeBack);
    const primaryColumn = el("div", "trends-primary-column");
    primaryColumn.append(toolbar, overview); workspace.append(index, primaryColumn);
    const tooltip = el("aside", "trends-tooltip"); tooltip.id = "trendsTooltip"; tooltip.setAttribute("role", "tooltip"); tooltip.hidden = true;
    const paging = el("div", "trends-paging"), inspection = el("section", "trends-inspection");
    const earlierDays = button("Earlier days", () => { if (current()) void read({ range, period, filters, offset: Math.max(0, offset - 90) }); });
    const laterDays = button("Later days", () => { if (current()) void read({ range, period, filters, offset: offset + 90 }); });
    const pageSpan = el("span", "muted");
    paging.append(earlierDays, pageSpan, laterDays);
    paging.hidden = true;
    const exactButton = button("View numbers", () => {
        exact.hidden = !exact.hidden; exactButton.textContent = exact.hidden ? "View numbers" : "Hide numbers";
        if (!exact.hidden) paintExact();
    });
    const inspectionCaption = el("h3", "trends-inspection-caption"), inspectionBody = el("div", "trends-inspection-body"), exact = el("div", "trends-exact"); exact.hidden = true; inspection.hidden = true;
    inspectionCaption.id = "trendsInspectionCaption"; inspection.setAttribute("aria-labelledby", inspectionCaption.id);
    exact.tabIndex = 0; exact.setAttribute("role", "region"); exact.setAttribute("aria-label", "Daily exact values");
    inspection.append(inspectionCaption, inspectionBody, exact);
    const dialog = el("dialog", "trends-dialog"), dialogTitle = el("h2"), dialogBody = el("div", "trends-dialog-body"), dialogHeader = el("div", "trends-dialog-heading");
    const localPanel = el("section","trends-local-choices"), local = el("div");
    localPanel.id = "trendsLocalChoices"; localPanel.setAttribute("role","dialog"); localPanel.append(local); root.append(localPanel);
    const localChoices = ux.anchoredChoices(localPanel);
    const datePanel = el("section"), editor = el("div"), dateActions = el("div", "report-popover-actions");
    datePanel.id = "trendsDates"; datePanel.append(editor); root.append(datePanel);
    const calendar = createCalendar({ root: editor, id: "trendsCalendar", label: "Trends", time, ux,
        context: () => getContext().timeContext, current, onChange: () => { applyDates.disabled = !calendar.valid(); } });
    const datePicker = ux.datesPicker({ panel: datePanel, editor, trigger: periodButton, current, selected: () => period, optionKey: "trendPeriod",
        onCustom: () => calendar.reset(range), onClose: () => calendar.clear(),
        onPreset: days => void read({ range: time.preset(days, getContext().timeContext.timeZone), period: days, filters, remember: "period" }) });
    const applyDates = button("Apply dates", () => {
        if (!current() || !calendar.valid()) return;
        const selected = calendar.value(); datePicker.close();
        void read({ range: selected, period: "custom", filters, remember: "period" });
    }, "primary");
    dateActions.append(button("Cancel", () => datePicker.close()), applyDates); editor.append(dateActions);
    localPanel.addEventListener("toggle", () => { if (!localPanel.matches(":popover-open")) scrub(local); });
    function beginChoices(title, trigger) {
        if (!current()) return false;
        hideHover(); scrub(local); localPanel.setAttribute("aria-label",title);
        localChoices.open(trigger); return true;
    }
    dialogTitle.id = "trendsDialogTitle"; dialog.setAttribute("aria-labelledby", dialogTitle.id);
    dialogHeader.append(dialogTitle, button("Close", () => dialog.close())); dialog.append(dialogHeader, dialogBody);
    const feedback = el("div", "trends-read-feedback");
    feedback.append(pendingNotice, status, retry, qualification);
    const chartSection = el("div"), landing = el("section", "trends-landing");
    const landingTitle = el("h2", "", "Errors & failures"), landingScope = el("p", "trends-index-scope");
    const landingPlot = el("div", "trends-plot"), landingWindow = el("p", "trends-visible-days");
    landingPlot.id = "trendsOverviewPlot";
    landingPlot.tabIndex = 0; landingPlot.setAttribute("role", "region"); landingPlot.setAttribute("aria-label", "Affected interactions by day");
    landingWindow.hidden = true;
    const landingEmpty = el("div", "trends-no-activity"), landingDetail = el("p", "muted");
    const landingRecover = button("", recoverWeek);
    landingEmpty.append(el("h3", "", "No matching calls in this period"), landingDetail, landingRecover);
    const landingOpen = directionButton("View chart", () => openErrorsChart());
    landingOpen.id = "trends-open-errors";
    const landingHead = el("div", "trends-landing-head"); landingHead.append(landingTitle, landingOpen);
    landing.append(landingHead, landingScope, landingEmpty, landingPlot, landingWindow); landing.hidden = true;
    let landingSource;
    const landingChart = mountChart({ root: landingPlot, tooltip, color, authorIcon, canInspect: () => current() && section === "overview",
        formatDate: fullDate, formatAxisDate: axisDate, weekContext, onInspect: () => {}, onSelect: date => openErrorsChart(date),
        onWindow(first, last, count) {
            landingWindow.hidden = !first;
            landingWindow.textContent = first ? `${axisDate(first)} – ${axisDate(last)} in view · ${count} days in this chart` : "";
        } });
    function openErrorsChart(date) {
        if (!current() || section !== "overview") return;
        pairActive = false;
        onSectionChange("charts", "problems");
        if (getContext().section !== "charts" || !current()) return;
        const card = cards.get("problems");
        activeMeasure = "problems"; family = null; allCharts = false; compared.clear();
        card.mode = "count"; card.type = "lines"; card.selection = date ? { date, id: "problems" } : null;
        paint(); if (date) card.chart.reveal(date); card.title.focus();
    }
    const pairHost=el("section","trends-panel-pair"), landingExtra=el("div","trends-discover");
    let pairActive=false;
    pairHost.hidden=landingExtra.hidden=true;
    const pair = mountTrendPair({root:pairHost,el,button,directionButton,scrub,model:createTrendPairModel(),mountChart,tooltip,current,color,number,axisDate,fullDate,weekContext,
        evidence:(choice,day,ids,origin)=>openMembers(day,choice.label,ids,origin,choice.key),
        close:()=>{pairActive=false;paint();index.querySelector(`[data-measure="${activeMeasure}"]`).focus();}});
    const examples=el("section","trends-start"), explore=el("section","trends-start trends-explore");
    examples.append(el("h2","","Compare two measures"),directionButton("Compare measures",()=>startPair(),"forward","primary"),el("h3","","Examples"));
    const presets=[["Errors and tool usage",["problems","share"],["tools","reach"]],["Call volume and duration",["rhythm","count"],["timing","median"]],["Response models and errors",["models","share"],["problems","share"]]];
    const exampleControls=presets.map(([label,first,second])=>{
        const node=button(label,()=>startPair(pair.choice(...first),pair.choice(...second)),"quiet trends-example");
        node.append(ux.icon("forward"));examples.append(node);return node;
    });
    explore.append(el("h2","","Explore a measure"));
    for (const id of order) {const node=button(families[id].label,()=>{if(!current())return;pairActive=false;onSectionChange("charts",id);});
        node.append(ux.icon("forward"));explore.append(node);}
    landingExtra.append(examples,explore);
    function startPair(first,second,when) {
        if (!current()) return;
        if(section!=="charts")onSectionChange("charts");
        if(getContext().section!=="charts")return;
        allCharts=false;family=null;pairActive=true;paint();pair.start(first,second,when);
    }
    chartSection.append(restrictions, detailBar, feedback, workspace, pairHost, paging, inspection);
    const landingGrid=el("div","trends-landing-grid");landingGrid.append(landing,landingExtra);
    root.append(sections, guide, landingGrid, chartSection, tooltip, dialog);
    toolbar.setAttribute("role", "group"); toolbar.setAttribute("aria-label", "Trend scope and options");
    dialog.addEventListener("close", () => {
        if (dialog.open) return;
        filtersButton.setAttribute("aria-expanded", "false");
        scrub(dialogBody); scrub(dialogTitle);
        // Native close can restore focus before this queued event. Don't take it
        // back from a chart mark or another control the reader has since reached.
        if (current() && dialogOrigin?.checkVisibility() && (doc.activeElement === doc.body || dialog.contains(doc.activeElement)))
            dialogOrigin.focus({ preventScroll: true });
        dialogOrigin = null;
    });

    const plotCards = new Map();
    const observer = new ResizeObserver(entries => {
        if (!current()) return;
        const changed = entries.flatMap(({ target }) => {
            if (!target.checkVisibility()) return [];
            if (target === landingPlot) { landingChart.resize({ width: target.clientWidth, height: target.clientHeight }); return []; }
            const card = plotCards.get(target), width = target.clientWidth, height = target.clientHeight;
            return width === card.width && height === card.height ? [] : [{ card, width, height }];
        });
        observer.observe(landingPlot);
        for (const { card, width, height } of changed) {
            card.width = width; card.height = height;
            card.chart.resize({ width, height });
        }
        if (changed.some(({ card }) => card.id === family)) { inspectionKey = ""; paintInspection(); }
    });
    for (const id of order) {
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
                if (id === "timing") {
                    card.hidden.clear();
                    if (value !== "both") card.hidden.add(value === "median" ? "p95" : "timing");
                } else card.mode = value;
                paintStable(card);
            });
            control.dataset.trendMode = value; modes.append(control);
        }
        const indexModes = el("div", "trends-index-modes");
        if (id !== "timing") {
            const units = el("div", "trends-switch");
            units.setAttribute("role", "group"); units.setAttribute("aria-label", `${spec.label} units`);
            for (const [value, label] of id === "usage" ? spec.modes : [["count", "Count"], ["share", id === "rhythm" ? "Share within week" : "Percentage"]]) {
                const control = button(label, () => {
                    if (!current()) return;
                    card.mode = value === "share" && id === "tools" ? card.percentMode : value;
                    paintStable(card);
                }, "trends-choice");
                control.dataset.unit = value; units.append(control);
            }
            indexModes.append(units);
        }
        const basis = id === "tools" ? select("Percentage of", [["share", "Calls"], ["reach", "Interactions"]], value => {
            if (!current()) return;
            card.percentMode = value; card.mode = value; paintStable(card);
        }) : null;
        if (basis) {
            basis.host = el("div");
            basis.host.append(basis.label); indexModes.append(basis.host);
        }
        const types = el("div", "trends-switch trends-chart-types");
        types.setAttribute("role", "group"); types.setAttribute("aria-label", `${spec.label} chart type`);
        for (const [value, label] of [["columns", "Columns"], ["lines", "Lines"]]) {
            const control = button(label, () => {
                if (!current()) return;
                card.type = value; paintStable(card);
            }, "trends-choice");
            control.dataset.chartType = value; types.append(control);
        }
        const body = el("div", "trends-chart-body"), summary = el("div", "trends-summary"), totals = el("div", "trends-totals");
        const legend = el("div", "trends-legend"), plot = el("div", "trends-plot");
        plot.id = `trendsPlot-${id}`; plot.tabIndex = 0; plot.setAttribute("role", "region");
        plot.setAttribute("aria-label", `${spec.label} by day. Arrow keys move between dates and series.`);
        const limits = el("p", "trends-limits"), indexScope = el("p", "trends-index-scope");
        const empty = el("div", "trends-no-activity"), emptyTitle = el("h3"), emptyDetail = el("p", "muted");
        const showWeek = button("", recoverWeek);
        empty.append(emptyTitle, emptyDetail, showWeek); empty.hidden = true;
        const visibleDays = el("p", "trends-visible-days"); visibleDays.hidden = true;
        const actions = el("div", "trends-secondary");
        const comparison = directionButton("Compare measures", () => {
            const mode = id === "timing" ? card.selection?.id === "p95" ? "p95" : "median" : card.mode;
            const subject = id === "timing" ? "timing" : card.selection?.id;
            startPair(pair.choice(id,mode,subject),null,card.selection?.date);
        }), numbers = directionButton("Data table", () => openTable(card));
        const arrange = button("Arrange charts", () => openComparison(card));
        const remove = button("Remove chart", () => {
            if (!current() || !compared.has(id)) return;
            compared.delete(id); card.indexCollapsed=false; paint(); cards.get(activeMeasure).comparison.focus();
        });
        const fold = button("Collapse chart", () => {
            if (!current()) return;
            card.indexCollapsed=!card.indexCollapsed;paintStable(card);fold.focus({preventScroll:true});
        });
        actions.append(comparison, arrange, numbers); identity.append(fold,remove);
        const reportQuestion = id === "usage" ? directionButton("Preview this report", () => {
            if (!current() || root.getAttribute("aria-busy") === "true" || failedRead) return;
            onUsageReport({ revision:data.revision, range:{...range}, filters:{...filters}, question:data.usageQuestion, threshold:data.usageThreshold,
                scenarioIds:[...new Set(data.members.map(m=>m.scenarioId))] });
        }) : null;
        if (reportQuestion) actions.append(reportQuestion);
        const point = el("div", "trends-point"), pointDate = el("h3"), pointScope = el("div", "trends-point-scope");
        const pointText = el("span"), pointSpace = el("span", "trends-point-space"), pointActions = el("div", "trends-point-actions");
        pointSpace.setAttribute("aria-hidden", "true");
        const evidence = directionButton("View evidence", () => showEvidence(card));
        evidence.id = `trendsEvidence-${id}`;
        pointScope.append(pointSpace, pointText); pointActions.append(evidence); point.append(pointDate, pointScope, pointActions);
        identity.append(totals, indexScope); indexModes.append(types); summary.append(legend); body.append(summary, plot, visibleDays);
        heading.insertBefore(modes, sizing);
        heading.append(indexModes);
        content.append(empty, body, point, limits, actions); panel.append(heading, content); overview.append(panel);
        const questions = id === "usage" ? questionControls(doc, "trends", (key, value) => {
            if (!current() || !range) return;
            usageChoice = { ...usageChoice, [key]:value };
            questions.sync(usageChoice);
            card.hidden.clear(); card.selection = null;
            void read({range,period,filters,offset});
        }) : null;
        if (questions) content.prepend(questions.host);
        const card = { id, panel, title, periodLabel, expand, collapse, content, modes, body, summary, totals, legend, plot, limits,
            point, pointDate, pointScope, pointText, pointSpace, pointActions, evidence, pointKey: "", empty, emptyTitle, emptyDetail, showWeek, visibleDays,
            types, indexModes, indexScope, basis, comparison, numbers, actions, remove, fold, arrange, indexCollapsed:false, type: "columns", percentMode: "share",
            mode: id === "usage" ? "usd" : id === "timing" ? "both" : "count", hidden: new Set(), selection: null, collapsed: false, key: "", width: 0, height: 0 };
        card.questions = questions; card.reportQuestion = reportQuestion; cards.set(id, card);
        panel.addEventListener("click", event => {
            // Painting can replace the clicked glyph before this event reaches the row.
            if (event.defaultPrevented || event.composedPath().some(node => node instanceof Element
                && node.matches("button,a,input,select,textarea,summary,[role=button]"))) return;
            if (allCharts && (card.collapsed || heading.contains(event.target))) toggleCollapsed(card);
        });
        card.chart = mountChart({ root: plot, tooltip, color, authorIcon, canInspect: current, formatDate: fullDate, formatAxisDate: axisDate, weekContext,
            onWindow(first, last, count) {
                visibleDays.hidden = !first;
                const text = first ? `${axisDate(first)} – ${axisDate(last)} in view · ${count} days in this chart` : "";
                if (visibleDays.textContent !== text) visibleDays.textContent = text;
            },
            onInspect() { if (inspecting !== card) inspecting?.chart.hide(); inspecting = card; },
            onSelect(date, series) {
                evidenceReturn = null;
                card.selection = { date, id: series };
                card.chart.select(card.selection);
                paintPoint(card);
                if (family === id) paintInspection();
            } });
        plotCards.set(plot, card);
        observer.observe(plot);
    }
    doc.fonts.ready.then(() => {
        for (const card of cards.values()) card.drawing = null;
        if (current()) paint();
    });
    doc.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.defaultPrevented || dialog.open || localPanel.matches(":popover-open") || datePanel.matches(":popover-open") || !enabled) return;
        if (!tooltip.hidden) { hideHover(); return; }
        if (family) { event.preventDefault(); restore(); }
    });
    function current() { return enabled && bound && api.isCurrent(bound) && !getContext().stale && data?.revision === getContext().revision; }
    function recoverWeek() {
        if (!current() || !data.coverage.latestMatchingDate) return;
        const to = data.coverage.latestMatchingDate;
        void read({ range: { from: time.addDays(to, -6), to }, period: "latest", filters, remember: "period" });
    }
    function chooseMeasure(id) {
        if (!Object.hasOwn(families, id) || !current()) return;
        hideHover(); pairActive=false; activeMeasure = id; family = null; allCharts = false; compared.delete(id);
        evidenceReturn = null; paint();
        rememberScope("measure");
        const card = cards.get(id);
        if (card.plot.getBoundingClientRect().top >= innerHeight) {
            card.title.focus({ preventScroll: true });
            card.title.scrollIntoView({ block: "start", behavior: "instant" });
        }
    }
    function openComparison(card) {
        if (!beginChoices("Arrange charts",card.arrange)) return;
        const choices = el("div", "trends-compare-choices");
        for (const id of order.filter(id => id !== activeMeasure)) {
            const label = el("label"), check = el("input");
            check.type = "checkbox"; check.value = id; check.checked = compared.has(id);
            label.append(check, el("span", "", families[id].label)); choices.append(label);
        }
        const actions = el("div", "trends-dialog-actions");
        actions.append(button("All charts", () => {
            localChoices.close(); family = null; allCharts = true; hideHover(); paint();
            collapseAll.focus({ preventScroll: true });
        }), button("Cancel", () => localChoices.close()), button("Apply comparison", () => {
            compared = new Set([...choices.querySelectorAll("input:checked")].map(check => check.value));
            localChoices.close(); paintStable(card);
        }, "primary"));
        local.append(choices, actions); localChoices.place(); choices.querySelector("input")?.focus({preventScroll:true});
    }
    function openTable(card) {
        if (!openDialog("Data table")) return;
        const region = el("div", "trends-exact"); region.tabIndex = 0; region.setAttribute("role", "region");
        region.setAttribute("aria-label", `${families[card.id].label} exact values`);
        drawTable(card, region, true); dialogBody.append(region);
        if (card.id === "services") {
            const { missingServices, partialServices, preparationCalls } = data.totals;
            dialogBody.append(el("h3", "", "How services are counted"),
                el("p", "muted", `Each call counts once per named service; a call can appear under several services. ${number(data.totals.calls)} dated calls are in the period denominator.`));
            if (missingServices > partialServices) dialogBody.append(el("p", "", `No service identified: ${number(missingServices - partialServices)} calls.`));
            if (partialServices) dialogBody.append(el("p", "", `Some service names known, others missing: ${number(partialServices)} calls.`));
            if (preparationCalls) dialogBody.append(el("p", "", `Preparation only (not service use): ${number(preparationCalls)} calls.`));
        }
        if (data.coverage.undatedCalls) dialogBody.append(el("p", "muted", `${number(data.coverage.undatedCalls)} calls without a start date are outside the table.`));
    }
    function hideHover() { landingChart.hide(); for (const card of cards.values()) card.chart.hide(); inspecting = null; }
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
    function clearPending() { clearTimeout(pendingTimer); pendingTimer = 0; scrub(pendingNotice); }
    function validate(value, request) {
        const history = value?.coverage?.historySummary;
        if (value?.kind !== "retained-trends" || value.schemaVersion !== 1 || value.revision !== request.expectedRevision
            || value.from !== request.from || value.to !== request.to || JSON.stringify(value.filters) !== JSON.stringify(request.filters)
            || (value.usageQuestion ?? "all") !== (request.usageQuestion ?? "all") || (value.usageThreshold ?? 30000) !== (request.usageThreshold ?? 30000)
            || value.timeContext?.timeZone !== request.timeContext.timeZone || !Array.isArray(value.days)
            || value.days.length !== value.window?.count || value.days.length > 90 || !value.totals || !value.definitions
            || value.window.offset !== request.offset || value.days.some(day => !day.date || !Number.isSafeInteger(day.calls)
                || !Number.isSafeInteger(day.interactions) || Object.keys(families).some(id => !Array.isArray(day.values?.[id])))
            || !Array.isArray(value.members) || Object.keys(families).some(id => !Array.isArray(value.definitions[id]))
            || value.coverage?.latestMatchingDate != null && !/^\d{4}-\d\d-\d\d$/.test(value.coverage.latestMatchingDate)
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
        clearPending(); evidenceReturn = null;
        if (!token || context.stale) { notice("Current stored activity is unavailable. Read the current view before changing Trends."); return; }
        const request = { expectedRevision: context.revision, from: next.range.from, to: next.range.to,
            filters: next.filters, offset: next.offset ?? latestOffset(next.range), timeContext: context.timeContext,
            ...(usageChoice.question !== "all" ? { usageQuestion:usageChoice.question, usageThreshold:usageChoice.threshold } : {}) };
        failedRead = null; readingRevision = context.revision; readingZone = context.timeContext.timeZone;
        requestedKey = JSON.stringify(request); root.setAttribute("aria-busy", "true"); hideHover();
        if (!data) { notice("Loading Trends…"); overview.hidden = true; }
        else {
            notice("");
            pendingTimer = setTimeout(() => {
                if (!enabled || generation !== pending || !api.isCurrent(token)) return;
                const dates = `${time.formatDate(request.from, request.timeContext, true)} – ${time.formatDate(request.to, request.timeContext, true)}`;
                pendingNotice.textContent = `Loading ${["custom","latest"].includes(next.period) ? dates : `Last ${next.period} days · ${dates}`}…`;
            }, 300);
        }
        if (doc.activeElement === retry && data) filtersButton.focus({ preventScroll: true });
        retry.hidden = true;
        try {
            const value = await api("/api/trends", request);
            if (!enabled || generation !== pending) return;
            if (!api.isCurrent(token)) { withdrawAccess(); return; }
            validate(value, request);
            if (next.initial && !value.totals.calls && value.coverage.latestMatchingDate && value.coverage.latestMatchingDate < request.from) {
                const to = value.coverage.latestMatchingDate;
                return await read({ ...next, initial: false, range: { from: time.addDays(to, -6), to }, period: "latest" });
            }
            evidenceReturn = null;
            localChoices.close(false); datePicker.close(false);
            if (dialog.open) { dialogOrigin = null; dialog.close(); scrub(dialogBody); scrub(dialogTitle); }
            const changedRange = !range || range.from !== next.range.from || range.to !== next.range.to || offset !== request.offset;
            const changedPopulation = changedRange || JSON.stringify(filters) !== JSON.stringify(next.filters) || lastRevision !== context.revision;
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
                if (changedPopulation) card.selection = null;
                for (const definition of data.definitions[id]) color(definition.id, id);
            }
            if (next.routeFamily) { activeMeasure = next.routeFamily; family = null; allCharts = false; compared.clear(); }
            if (next.entry && getContext().entry?.key === next.entry.key) {
                const entry = next.entry, card = cards.get(entry.family);
                acceptedEntry = entry.key;
                activeMeasure = entry.family; family = null; allCharts = false; compared.clear();
                card.mode = entry.measure; card.percentMode = entry.measure === "reach" ? "reach" : "share"; card.hidden.clear();
                const day = entry.date ? data.days.find(day => day.date === entry.date) : selectedDay(card);
                card.selection = day && (entry.date || entry.series) ? { date: day.date,
                    id: entry.series && data.definitions[entry.family].some(d => d.id === entry.series) ? entry.series : null } : null;
                paint(); card.chart.reveal(entry.date); card.title.focus({ preventScroll: true }); card.title.scrollIntoView({ block: "nearest", behavior: "instant" });
            } else if (replacing) paintStable(family ? cards.get(family) : null);
            else paint();
            if (next.remember && generation === pending && current()) rememberScope(next.remember);
        } catch (error) {
            if (generation !== pending || !enabled) return;
            if (!api.isCurrent(token)) { withdrawAccess(); return; }
            failedRead = { token, revision: context.revision, zone: context.timeContext.timeZone, next }; notice(error.message); retry.hidden = false;
        } finally { if (generation === pending) { clearPending(); root.setAttribute("aria-busy", "false"); } }
    }
    function maximize(id) {
        if (!Object.hasOwn(families, id) || !current()) return;
        if (!family) overviewScroll = scrollY;
        hideHover(); family = id; cards.get(id).collapsed = false; allCollapsed = null; inspectionKey = "";
        paint(); window.scrollTo({ top: 0, behavior: "instant" }); cards.get(id).title.focus({ preventScroll: true });
        rememberScope("measure");
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
        hideHover(); dialogOrigin = doc.activeElement; scrub(dialogTitle); dialogTitle.append(doc.createTextNode(name)); scrub(dialogBody);
        if (!dialog.open) dialog.showModal(); return true;
    }
    function openFilters() {
        if (!beginChoices("Filter activity",filtersButton)) return;
        filtersButton.setAttribute("aria-expanded", "true");
        const author = select("Prompt authors", [["", "All prompts"], ...data.definitions.authors.map(row => [row.id, row.label])], () => {});
        const tool = select("Tool", [["", "All tools"], ...data.definitions.tools.map(row => [row.id, row.label])], () => {});
        const service = select("Service", [["", "All services"], ...data.definitions.services.map(row => [row.id, row.label]), ["Discovery", "Discovery / preparation"], ["missing", "Missing service detail"]], () => {});
        author.field.value = filters.author ?? ""; tool.field.value = filters.tool ?? ""; service.field.value = filters.service ?? "";
        local.append(author.label, tool.label, service.label);
        const actions = el("div", "trends-dialog-actions");
        if (Object.keys(filters).length) actions.append(button("Clear filters", () => {
            localChoices.close(); void read({ range, period, filters: {}, offset, remember: "filters" });
        }));
        actions.append(button("Cancel", () => localChoices.close()), button("Apply filters", () => {
            const next = Object.fromEntries([["author", author.field.value], ["tool", tool.field.value], ["service", service.field.value]].filter(([, value]) => value));
            localChoices.close(); void read({ range, period, filters: next, offset, remember: "filters" });
        }, "primary")); local.append(actions); localChoices.place();
        requestAnimationFrame(() => {
            if (current() && localPanel.matches(":popover-open") && doc.activeElement === filtersButton)
                (local.querySelector(".select-trigger") || author.field).focus({preventScroll:true});
        });
    }
    function valueText(value, card) {
        const amount = card.chart.metric(value, card.id, card.mode);
        if (card.id === "usage") return amount === null ? "Unavailable" : card.mode === "usd" ? (amount > 0 && amount < .01 ? "<$0.01" : `~$${amount.toFixed(2)}`) : `${number(amount)} tokens`;
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
        if (card.id === "timing") card.mode = card.hidden.has("timing") ? card.hidden.has("p95") ? "none" : "p95"
            : card.hidden.has("p95") ? "median" : "both";
        const { id, panel, hidden, mode } = card, spec = families[id], source = viewData(card), totals = source.totals;
        if (!compared.size || activeMeasure !== id && !compared.has(id)) card.indexCollapsed=false;
        const collapsed = allCharts ? card.collapsed : card.indexCollapsed;
        card.content.hidden = collapsed;
        panel.hidden = allCharts ? Boolean(family && family !== id) : activeMeasure !== id && !compared.has(id);
        panel.dataset.maximized = String(allCharts && family === id); panel.dataset.collapsed = String(collapsed);
        if (card.reportQuestion) {
            card.reportQuestion.hidden = !source.usageQuestion || source.usageQuestion === "all";
            card.reportQuestion.disabled = !totals.usagePopulation?.eligible;
        }
        panel.style.order = !allCharts && id === activeMeasure ? "-1" : "";
        panel.dataset.manySeries = String(source.definitions[id].length > 6);
        card.modes.hidden = collapsed || !allCharts;
        card.remove.hidden = allCharts || !compared.has(id);
        card.fold.hidden = allCharts || !compared.size;
        card.fold.textContent = card.indexCollapsed ? "Expand chart" : "Collapse chart";
        card.fold.setAttribute("aria-expanded",String(!card.indexCollapsed));
        card.arrange.hidden = !allCharts && id !== activeMeasure;
        card.totals.hidden = collapsed || !allCharts;
        const noCalls = !totals.calls, noMeasure = !allCharts && totals.calls && (
            id === "timing" && !totals.timedCalls || id === "models" && totals.missingModels === totals.interactions
            || id === "services" && !totals.values.services.some(value => value.calls));
        const unavailable = noCalls || Boolean(noMeasure) || id === "usage" && !source.definitions.usage.length;
        card.indexModes.hidden = allCharts || unavailable || collapsed;
        card.body.hidden = unavailable;
        card.plot.hidden = unavailable;
        card.empty.hidden = !unavailable;
        if (unavailable) {
            const latest = source.coverage.latestMatchingDate;
            card.emptyTitle.textContent = noCalls ? "No matching calls in this period"
                : id === "timing" ? "No calls with recorded duration" : id === "models" ? "No recorded response models" : "No identified services";
            card.emptyDetail.textContent = noCalls ? latest ? `Most recent matching call: ${fullDate(latest)}.`
                : source.coverage.undatedCalls ? "Matching calls without a start date cannot be placed on a daily chart."
                : Object.keys(filters).length ? "Try a different filter or date range." : "WIRE has no saved calls with a start date to show here."
                : id === "timing" ? "A duration needs a recorded start and completion." : "The calls are included in the period count.";
            card.showWeek.hidden = !(noCalls && latest);
            if (!card.showWeek.hidden) card.showWeek.textContent = `Show week ending ${axisDate(latest)}`;
            if (!noCalls && id === "usage") {
                card.emptyTitle.textContent = "No matching usage groups";
                card.emptyDetail.textContent = "Change the question, filters or dates to see a reading.";
            }
            card.visibleDays.hidden = true;
            if (card.drawing) { card.chart.withdrawAccess(); card.drawing = null; }
        }
        card.indexScope.hidden = allCharts;
        card.actions.hidden = allCharts;
        card.types.hidden = allCharts;
        card.comparison.hidden = !allCharts && id !== activeMeasure;
        card.periodLabel.hidden = !allCharts;
        const unit = id === "usage" ? mode : mode === "count" ? "count" : "share";
        for (const control of card.indexModes.querySelectorAll("[data-unit]")) control.setAttribute("aria-pressed", String(control.dataset.unit === unit));
        if (card.basis) { card.basis.host.hidden = mode === "count"; card.basis.field.value = mode === "reach" ? "reach" : "share"; }
        for (const control of card.types.children) control.setAttribute("aria-pressed", String(control.dataset.chartType === card.type));
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
        const definitions = allCharts && (id === "tools" || id === "services" || id === "models") ? [...source.definitions[id]].sort((a, b) =>
            amount(b) - amount(a) || a.label.localeCompare(b.label)) : source.definitions[id];
        const key = JSON.stringify(definitions);
        if (card.key !== key) {
            scrub(card.legend); card.key = key;
            if (["tools", "authors", "services", "models", "timing"].includes(id) || id === "usage" && source.usageQuestion !== "all" && source.usageQuestion) for (const definition of definitions) {
                const row = el("div", "trends-legend-row"), label = el("label", "trends-series"), check = el("input");
                label.style.setProperty("--series-color", color(definition.id, id));
                check.type = "checkbox"; check.dataset.series = definition.id; check.setAttribute("aria-label", `Show ${definition.label}`);
                check.addEventListener("change", () => {
                    if (!current()) return;
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
        const usageMaximum = id === "usage" ? Math.max(.000001, ...definitions.map(amount)) : null;
        for (const row of card.legend.children) {
            const check = row.querySelector("input"), value = totals.values[id].find(value => value.id === check.dataset.series);
            check.checked = !hidden.has(value.id); row.dataset.hidden = String(!check.checked);
            row.querySelector(".trends-legend-value").textContent = valueText(value, card);
            const amount = card.chart.metric(value, id, mode);
            const maximum = usageMaximum ?? (mode === "count" ? Math.max(1, totals.calls) : id === "timing" ? Math.max(1, ...totals.values.timing.map(value => card.chart.metric(value, id, mode) ?? 0)) : 100);
            row.querySelector(".trends-value-fill").style.width = `${(amount ?? 0) * 100 / maximum}%`;
        }
        card.summary.hidden = !card.legend.childElementCount;
        card.body.dataset.summary = String(!card.summary.hidden);
        const limits = [];
        if (id === "usage") {
            const u = totals.usagePopulation ?? totals.values.usage[0];
            if (source.usageQuestion === "tool") limits.push(`At least ${number(source.usageThreshold)} tokens; ${u.unranked} could not be ranked. Tool groups overlap. No per-tool charges.`);
            if (source.usageQuestion === "model") limits.push("Each model contributes only its recorded calls.");
            limits.push(`${valueText(u, card)} · ${u.metered} of ${u.eligible} metered; ${u.unpriced} unpriced`);
            if (u.cacheReadShare !== null) limits.push(`${rate(100*u.cacheReadShare)} of input read from cache`);
            limits.push(`Retail API-equivalent estimate (${u.rateDate}); not billed Copilot spend.`);
        }
        const shown = definitions.filter(definition => !hidden.has(definition.id)).length;
        const seriesSubset = shown < definitions.length ? `${shown} of ${definitions.length} series shown` : "";
        if (allCharts && seriesSubset) limits.push(seriesSubset);
        if (id === "services") {
            if (allCharts && totals.missingServices) limits.push(`Service names incomplete for ${number(totals.missingServices)} calls`);
            if (allCharts && totals.preparationCalls) limits.push(`${number(totals.preparationCalls)} preparation calls`);
        } else if (id === "models") {
            if (totals.missingModels) limits.push(`Model not recorded: ${rate(totals.modelMissingShare)} (${number(totals.missingModels)})`);
            for (const [status, description] of [["partial", "Partly recorded model names"], ["unverified", "Unverified model names"], ["conflicting", "Conflicting model names"]])
                if (totals.modelCoverage[status]) limits.push(`${description}: ${number(totals.modelCoverage[status])} interactions`);
        } else if (id === "timing" && allCharts) limits.push(totals.calls ? `${rate(totals.timingCoverage)} (${number(totals.timedCalls)}) calls measured` : "No calls with timing in this period");
        else if (id === "problems" && totals.values.problems[0].unknownCalls) limits.push(`Outcome unknown for ${number(totals.values.problems[0].unknownCalls)} ${totals.values.problems[0].unknownCalls === 1 ? "call" : "calls"}`);
        else if (id === "rhythm" && mode === "share" && source.days.some(day => weekContext(day).partial))
            limits.push("Underlined weeks include only the selected dates.");
        card.limits.textContent = limits.join(" · "); card.limits.hidden = !limits.length;
        const unitIsInteraction = ["authors", "models", "problems"].includes(id) || mode === "reach";
        const summary = id === "timing" ? `${number(totals.timedCalls)} of ${number(totals.calls)} calls timed`
            : `${number(unitIsInteraction ? totals.interactions : totals.calls)} ${unitIsInteraction ? "originating interactions" : "dated calls"}`;
        const captions = [id === "usage" && totals.usagePopulation ? `${number(totals.usagePopulation.eligible)} matching interactions in this period` : summary + " in this period"];
        if (seriesSubset) captions.push(seriesSubset);
        if (id === activeMeasure && compared.size) captions.push(`Comparing ${compared.size + 1} measures`);
        if (id === "timing") captions.push("milliseconds");
        if (id === "services" && totals.missingServices) captions.push(`Service names incomplete for ${number(totals.missingServices)} calls`);
        if (source.coverage.undatedCalls && id === activeMeasure) captions.push(`${number(source.coverage.undatedCalls)} undated excluded`);
        if (Object.keys(filters).length) captions.push(restrictionText.textContent);
        card.indexScope.textContent = captions.join(" · ");
        paintPoint(card);
        if (section === "charts" && !pairActive && !panel.hidden && !collapsed && !unavailable) {
            const encoding = JSON.stringify([mode, card.type, [...hidden].sort(), allCharts, family === id]);
            if (source !== card.drawing?.source || encoding !== card.drawing.encoding) {
                card.chart.render(source, id, mode, hidden, card.selection, card.type, !allCharts);
                card.drawing = { source, encoding };
            } else if (card.width !== card.plot.clientWidth || card.height !== card.plot.clientHeight) {
                card.chart.resize({ width: card.plot.clientWidth, height: card.plot.clientHeight });
            }
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
        const visible = day.values[card.id].filter(value => card.selection?.id ? value.id === card.selection.id : shown(value, card));
        return card.id === "usage" ? visible.map(v => ({...v,rowIds:card.mode === "usd" ? v.pricedRows : v.meteredRows})) : visible;
    }
    function shown(value, card) {
        return !card.hidden.has(value.id);
    }
    function weekContext(day) {
        const from = time.bucketDate(time.midnight(day.date, data.timeContext.timeZone), "week", data.timeContext.timeZone), to = time.addDays(from, 6);
        const selectedFrom = from < data.from ? data.from : from, selectedTo = to > data.to ? data.to : to;
        const partial = from !== selectedFrom || to !== selectedTo;
        const dates = (from, to) => from === to ? time.formatDate(from, data.timeContext, true)
            : `${time.formatDate(from, data.timeContext)} – ${time.formatDate(to, data.timeContext, true)}`;
        return { from, to, partial, label: `Week ${dates(from, to)}`,
            detail: `${number(day.values.rhythm[0].eligible)} ${day.values.rhythm[0].eligible === 1 ? "call" : "calls"} on selected dates ${dates(selectedFrom, selectedTo)}${partial ? " (partial week)" : ""}` };
    }
    function dayScope(day, card) {
        const usage = day.usagePopulation ?? day.values.usage?.[0];
        const scope = card.id === "usage" ? `${usage.metered} of ${usage.eligible} interactions metered`
            : card.id === "timing" ? `${day.timedCalls} of ${day.calls} calls timed`
            : ["authors", "models", "problems"].includes(card.id) || card.mode === "reach" ? `${day.interactions} interactions` : `${day.calls} calls`;
        const measure = card.id === "timing" ? "" : `${families[card.id].modes.find(([id]) => id === card.mode)[1]} · `;
        if (card.id === "rhythm" && card.mode === "share") {
            const week = weekContext(day);
            return `${week.label} · ${week.detail}`;
        }
        return `${measure}${scope}`;
    }
    function pointScope(day, card, label, hidden = false) {
        return `${label ?? "Call activity"}${hidden ? " (hidden)" : ""} · ${dayScope(day, card)}`;
    }
    function paintPoint(card) {
        const day = selectedDay(card), source = viewData(card);
        const selected = day.values[card.id].find(value => value.id === card.selection?.id);
        if (!allCharts) {
            card.point.hidden = !card.selection;
            if (!card.selection) return;
            const ids = new Set(evidenceValues(day, card).flatMap(value => value.rowIds));
            const unit = ["authors", "models", "problems"].includes(card.id) || card.mode === "reach" ? "interactions" : "calls";
            let measure = `${number(ids.size)} matching calls`;
            if (selected) {
                if (card.id === "usage") measure = `${valueText(selected, card)} · ${selected.metered} of ${selected.eligible} metered`;
                else if (card.id === "timing") measure = `${valueText(selected, card)} · ${number(day.timedCalls)} of ${number(day.calls)} calls timed`;
                else if (card.mode === "count") measure = `${number(selected.count)} ${unit}`;
                else {
                    const reach = card.mode === "reach", share = reach ? selected.reach : selected.percent;
                    measure = `${rate(share)} (${number(reach ? selected.interactions : selected.count)} of ${number(reach ? selected.reachEligible : selected.eligible)} ${unit})`;
                    if (card.id === "rhythm") measure += ` · ${weekContext(day).detail}`;
                }
            }
            card.pointDate.textContent = axisDate(day.date);
            card.pointText.textContent = [selected?.label ?? "Shown series", measure,
                selected && card.hidden.has(selected.id) ? "Hidden in chart" : ""].filter(Boolean).join(" · ");
            card.evidence.firstChild.textContent = `View ${number(ids.size)} ${ids.size === 1 ? "call" : "calls"}`;
            card.evidence.disabled = ids.size === 0;
            return;
        }
        card.point.hidden = !source.totals.calls; card.evidence.firstChild.textContent = "View evidence";
        card.point.classList.toggle("trends-inspection-heading", family === card.id);
        scrub(card.pointDate); card.pointDate.append(doc.createTextNode(axisDate(day.date)));
        scrub(card.pointText); card.pointText.append(doc.createTextNode(pointScope(day, card, selected?.label ?? "Shown series", selected && !shown(selected, card))));
        // Reserve the available subject labels before selection, so selecting long
        // source names never resizes this chart or shifts the widgets beneath it.
        const key = `${acceptedKey}:${card.mode}`;
        if (card.pointKey !== key) {
            card.pointKey = key; scrub(card.pointSpace);
            const largest = source.days.reduce((a, b) => a.calls + a.interactions > b.calls + b.interactions ? a : b);
            const labels = ["Shown series", ...source.definitions[card.id].map(value => value.label)];
            const texts = card.id === "rhythm" && card.mode === "share"
                ? [...new Set(source.days.map(day => pointScope(day, card)))]
                : labels.map(label => pointScope(largest, card, label, true));
            for (const text of texts) card.pointSpace.append(el("span", "", text));
        }
        card.evidence.disabled = !evidenceValues(day, card).some(value => value.rowIds.length);
        if (family === card.id) card.pointActions.append(exactButton);
    }
    function paintInspection() {
        if (!current() || !family) return;
        const card = cards.get(family), day = selectedDay(card), key = `${family}:${Math.round(inspectionBody.clientWidth)}`;
        const changedLayout = inspectionKey !== key;
        if (changedLayout) { inspectionKey = key; inspectionBody.style.minHeight = ""; }
        const prior = changedLayout ? 0 : inspectionBody.getBoundingClientRect().height;
        scrub(inspectionCaption);
        inspectionCaption.append(doc.createTextNode(`${fullDate(day.date)} · ${dayScope(day, card)}`));
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
    }
    function showEvidence(card) {
        if (!current()) return;
        const day = selectedDay(card), values = evidenceValues(day, card), ids = new Set(values.flatMap(value => value.rowIds));
        openMembers(day, values.length === 1 ? values[0].label : "Shown series", ids, card.evidence, card.id);
    }
    function openMembers(day, label, members, origin, subject) {
        if (!current()) return;
        const ids = new Set(members), source = data, key = JSON.stringify([acceptedKey, subject, day.date, [...ids]]);
        const saved = evidenceReturn?.key === key ? evidenceReturn : null;
        if (!openDialog(`${fullDate(day.date)} · ${label}`)) return;
        dialogOrigin = origin;
        dialogBody.append(el("p", "muted", `${number(ids.size)} matching calls. Opening a call shows its full interaction.`));
        let returnLink = null;
        for (const member of data.members.filter(row => ids.has(row.id))) {
            if (hiddenInteraction(member.scenarioId)) { dialogBody.append(el("p", "trends-evidence-row", "Hidden card")); continue; }
            const row = el("div", "trends-evidence-row"), link = recordLink(member);
            if (!current()) { for (const attribute of [...link.attributes]) { attribute.value = ""; link.removeAttributeNode(attribute); } scrub(link); return; }
            link.append(ux.icon("forward"));
            const open = event => {
                if (!current() || data !== source || !dialog.open || !link.isConnected) { event.preventDefault(); event.stopImmediatePropagation(); return; }
                if (event.type !== "click" || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
                evidenceReturn = { key, origin, member: member.id, top: dialogBody.scrollTop };
                // The existing reader captures its origin during the link handler.
                // Give it a durable control, not the soon-to-be-scrubbed list link.
                dialogOrigin = null; dialog.close(); origin.focus({ preventScroll: true });
            };
            link.addEventListener("click", open, { capture: true });
            link.addEventListener("auxclick", open, { capture: true });
            if (member.id === saved?.member) returnLink = link;
            row.append(link, el("span", "muted", member.operation)); dialogBody.append(row);
        }
        if (returnLink) { dialogBody.scrollTop = saved.top; returnLink.focus({ preventScroll: true }); }
    }
    function paintExact() {
        scrub(exact); if (!family || exact.hidden) return;
        drawTable(cards.get(family), exact, false);
    }
    function dayPage() {
        return `${offset + 1}–${offset + data.window.count} of ${data.window.totalDays} days`;
    }
    function drawTable(card, target, includePeriod) {
        const family = card.id, source = viewData(card), table = el("table", "exact-data-table"), header = el("tr");
        const head = el("thead"), body = el("tbody");
        const windowLabel = source.window.count < source.window.totalDays ? ` · Daily rows: ${dayPage()}` : "";
        table.append(el("caption", "", `${families[family].label} · ${formatRange()}${windowLabel}`));
        for (const label of ["Date", ...source.definitions[family].map(value => value.label), "Interactions", "Calls"]) {
            const cell = el("th", "", label); cell.scope = "col"; header.append(cell);
        }
        head.append(header); table.append(head, body);
        for (const day of includePeriod ? [source.totals, ...source.days] : source.days) {
            const row = el("tr"), date = el("th", "", day.date ? fullDate(day.date) : "Entire period"); date.scope = "row"; row.append(date);
            for (const value of day.values[family]) row.append(el("td", "", !day.date && family === "rhythm" && card.mode === "share" ? "Not a daily share" : valueText(value, card)));
            row.append(el("td", "", number(day.interactions)), el("td", "", number(day.calls))); body.append(row);
        }
        target.append(table);
        if (family === "usage" && source.usageQuestion && source.usageQuestion !== "all") {
            const groups = el("table","exact-data-table"), head = groups.createTHead().insertRow();
            groups.append(el("caption","","Usage in the entire period"));
            const tool = source.usageQuestion === "tool";
            for (const label of ["Group","Metered / all","Tokens","Input read from cache",...(card.mode === "usd" ? ["Priced / all","Est. USD"] : []),...(tool ? ["Returned context (est.)"] : [])]) {
                const th = el("th","",label); th.scope = "col"; head.append(th);
            }
            const body = groups.createTBody();
            for (const v of source.totals.values.usage) {
                const row = body.insertRow(), label = el("th","",v.label); label.scope = "row"; row.append(label);
                const c = v.context;
                for (const text of [`${v.metered} / ${v.eligible}`, v.total === null ? "Not recorded" : number(v.total),rate(v.cacheReadShare === null ? null : 100*v.cacheReadShare),
                    ...(card.mode === "usd" ? [`${v.priced} / ${v.eligible}`,valueText(v,card)] : []),
                    ...(tool ? [c?.tokens == null ? "Not recorded" : `~${number(c.tokens)} tokens (${c.sized} / ${c.calls} calls)`] : [])]) row.append(el("td","",text));
            }
            target.append(groups);
        }
    }
    function formatRange() {
        const end = axisDate(range.to) === "Today" ? "Today" : time.formatDate(range.to, data.timeContext, true);
        if (range.from === range.to) return end;
        if (end !== "Today") return time.formatCivilRange(range.from, range.to, data.timeContext);
        return `${time.formatDate(range.from, data.timeContext, range.from.slice(0, 4) !== range.to.slice(0, 4))} – ${end}`;
    }
    function paint() {
        if (!current()) return;
        filtersButton.disabled = false; periodButton.disabled = false;
        root.dataset.layout = allCharts ? "all" : "index";
        const inPair = section === "charts" && pairActive;
        const toolbarHost = section === "overview" ? root : allCharts || inPair ? chartSection : primaryColumn;
        if (toolbar.parentElement !== toolbarHost) {
            if (toolbarHost === root) landingGrid.before(toolbar); else toolbarHost.prepend(toolbar);
        }
        toolbar.hidden = section === "guide";
        toolbarContext.hidden = section === "guide" || (!inPair && !allCharts && section !== "overview");
        toolbarContext.textContent = toolbarContext.hidden ? "" : `${number(data.totals.calls)} dated ${data.totals.calls === 1 ? "call" : "calls"}`;
        landingExtra.hidden = section !== "overview"; workspace.hidden=inPair;
        pair.update(data,inPair);
        const pairGuide = section === "guide" && pairActive ? pair.selection() : [];
        guideContext.hidden = !pairGuide.length;
        guideContext.textContent = pairGuide.length ? `Your chart: ${pairGuide.join(" / ")}${pair.date() ? ` · ${fullDate(pair.date())}` : ""}.` : "";
        exampleControls.forEach((node,i)=>{
            const [,first,second]=presets[i];node.disabled=!(pair.choice(...first)&&pair.choice(...second));
            node.title=node.disabled?"One of these measures is unavailable in the retained activity.":"";
        });
        overview.hidden = false; overview.classList.toggle("trends-maximized", Boolean(family));
        detailBar.hidden = !allCharts || !family; inspection.hidden = !allCharts || !family; collapseAll.hidden = !allCharts || Boolean(family);
        exactButton.hidden = !allCharts || !family;
        periodButton.hidden = false; homeBack.hidden = !getContext().entry;
        if (section !== "charts") collapseAll.hidden = true;
        for (const control of index.children) {
            const active = !allCharts && activeMeasure === control.dataset.measure;
            if (active) control.setAttribute("aria-current", "page"); else control.removeAttribute("aria-current");
        }
        collapseAll.textContent = allCollapsed || [...cards.values()].every(card => card.collapsed) ? "Restore all" : "Collapse all";
        if (family) chooser.field.value = family;
        datePicker.sync();
        const dateRange = formatRange();
        datePicker.showRange(`${period === "latest" ? "Latest activity · " : ""}${time.formatCivilRange(range.from,range.to,data.timeContext)}`);
        const filterName = (key, value) => (data.definitions[key === "author" ? "authors" : key === "tool" ? "tools" : "services"].find(row => row.id === value)?.label
            ?? ({ Discovery: "Discovery / preparation", missing: "Missing service detail" }[value]) ?? value);
        restrictionText.textContent = Object.entries(filters).map(([key, value]) => filterName(key, value)).join(" · ");
        restrictions.hidden = !allCharts || !Object.keys(filters).length;
        if (!Object.keys(filters).length && doc.activeElement === clearFilters) filtersButton.focus({ preventScroll: true });
        clearFilters.disabled = !Object.keys(filters).length;
        ux.paintFilterEntry(filtersButton, Object.keys(filters).length);
        filtersButton.title = restrictionText.textContent || "Filter activity";
        clearFilters.hidden = restrictions.hidden;
        const limits = [];
        if (allCharts && data.coverage.undatedCalls) limits.push(`${number(data.coverage.undatedCalls)} calls have no start date and are left out.`);
        qualification.textContent = limits.join(" "); qualification.hidden = !limits.length;
        for (const card of cards.values()) paintCard(card, dateRange);
        const feedbackHost = section === "overview" ? landing : inPair ? pairHost : cards.get(family ?? (allCharts ? order[0] : activeMeasure)).panel;
        if (feedback.parentElement !== feedbackHost) feedbackHost.append(feedback);
        if (section === "overview") {
            const card = cards.get("problems");
            landingOpen.disabled = false;
            landingScope.textContent = ["Interactions with an error or failed call each day", data.totals.calls && data.days.some(day => !day.calls) ? "No matching dated calls on days marked with a cross" : "",
                restrictionText.textContent, card.limits.textContent,
                data.coverage.undatedCalls ? `${number(data.coverage.undatedCalls)} undated calls excluded` : ""].filter(Boolean).join(" · ");
            landingEmpty.hidden = Boolean(data.totals.calls); landingPlot.hidden = !landingEmpty.hidden;
            landingDetail.textContent = card.emptyDetail.textContent;
            landingRecover.hidden = card.showWeek.hidden; landingRecover.textContent = card.showWeek.textContent;
            if (landingSource !== data) {
                landingSource = data;
                if (data.totals.calls) landingChart.render(data, "problems", "count", new Set(), null, "lines", true, {distinguishEmpty:true});
                else { landingChart.withdrawAccess(); landingWindow.hidden = true; }
            }
        }
        const pageHost = section === "overview" ? landing : chartSection;
        if (paging.parentElement !== pageHost) {
            if (pageHost === landing) landing.append(paging); else inspection.before(paging);
        }
        paging.hidden = data.window.totalDays <= 90;
        if (!paging.hidden) {
            const focused = doc.activeElement;
            earlierDays.disabled = offset === 0; laterDays.disabled = offset + data.window.count >= data.window.totalDays;
            pageSpan.textContent = dayPage();
            if (focused === earlierDays && earlierDays.disabled) laterDays.focus({ preventScroll: true });
            else if (focused === laterDays && laterDays.disabled) earlierDays.focus({ preventScroll: true });
        }
        if (section === "charts") { paintInspection(); paintExact(); }
    }
    function withdrawAccess() {
        usageChoice = {question:"all",threshold:30000}; cards.get("usage").questions.sync(usageChoice);
        toolbarContext.textContent = "";
        localChoices.close(false); datePicker.close(false); scrub(local);
        clearPending(); evidenceReturn = null;
        pending++; enabled = false; bound = null; data = timingData = null; requestedKey = acceptedKey = ""; lastRevision = null;
        workspace.before(feedback);
        landingChart.withdrawAccess(); landingSource = null; landing.hidden = true; guide.hidden = true;
        pairActive=false;pair.clear();landingExtra.hidden=true;
        for (const node of [landingScope, landingDetail, landingRecover, landingWindow]) scrub(node);
        range = null; routeScopeKey = undefined; filters = {}; family = null; offset = 0; period = "7"; colors.clear(); allCollapsed = null; inspecting = null;
        activeMeasure = "rhythm"; compared.clear(); allCharts = false; acceptedEntry = entryKey = null; failedRead = null; readingRevision = null; readingZone = null; homeBack.hidden = true;
        datePicker.showRange(""); filtersButton.removeAttribute("title"); periodButton.hidden = true;
        ux.paintFilterEntry(filtersButton, 0);
        filtersButton.setAttribute("aria-expanded", "false");
        clearFilters.disabled = true;
        filtersButton.disabled = true; periodButton.disabled = true;
        for (const card of cards.values()) {
            card.chart.withdrawAccess(); card.drawing = null; card.hidden.clear(); card.selection = null; card.key = ""; card.collapsed = card.indexCollapsed = false;
            card.mode = card.id === "usage" ? "usd" : card.id === "timing" ? "both" : "count"; card.type = "columns"; card.percentMode = "share";
            card.pointKey = "";
            for (const node of [card.periodLabel, card.totals, card.indexScope, card.legend, card.limits, card.pointDate, card.pointText, card.pointSpace, card.evidence.firstChild,
                card.emptyTitle, card.emptyDetail, card.showWeek, card.visibleDays]) scrub(node);
        }
        const selectedText = doc.getSelection();
        if (selectedText && (root.contains(selectedText.anchorNode) || root.contains(selectedText.focusNode))) selectedText.removeAllRanges();
        if (dialog.open) dialog.close(); scrub(dialogBody); scrub(dialogTitle); dialogOrigin = null;
        paging.hidden = true; earlierDays.disabled = laterDays.disabled = true;
        for (const node of [qualification, inspectionCaption, inspectionBody, exact, pageSpan, status, restrictionText,guideContext]) scrub(node);
        inspectionBody.style.minHeight = ""; inspectionKey = ""; root.setAttribute("aria-busy", "false");
    }
    function update() {
        const wasEnabled = enabled, context = getContext();
        if (!context.active) {
            clearPending(); evidenceReturn = null; failedRead = null;
            if (entryKey !== acceptedEntry) entryKey = null;
            enabled = false; pending++; requestedKey = acceptedKey; root.setAttribute("aria-busy", "false");
            hideHover(); localChoices.close(false); datePicker.close(false); if (dialog.open) dialog.close(); return;
        }
        enabled = true;
        if (!context.publication || context.stale) { hideHover(); localChoices.close(false); datePicker.close(false); return; }
        if (data && !api.isCurrent(bound)) { withdrawAccess(); enabled = true; }
        const nextSection = context.section ?? "charts", changedSection = nextSection !== section;
        section = nextSection; guide.hidden = section !== "guide"; landing.hidden = section !== "overview"; chartSection.hidden = section !== "charts";
        landingGrid.hidden=section!=="overview";landingExtra.hidden=section!=="overview"||!data;
        if (changedSection) { hideHover(); localChoices.close(false); datePicker.close(false); }
        for (const node of sections.children) {
            if (node.dataset.section === section) node.setAttribute("aria-current", "page"); else node.removeAttribute("aria-current");
        }
        if (!data && section === "overview") landing.append(feedback);
        if (!data) { landingPlot.hidden = true; landingEmpty.hidden = true; landingOpen.disabled = true; }
        const entry = context.entry, routeScope = context.routeScope, routeKey = JSON.stringify(routeScope ?? null);
        if (entry && entry.key !== entryKey && entry.revision === context.revision && entry.timeContext.timeZone === context.timeContext.timeZone
            && Object.hasOwn(families, entry.family) && families[entry.family].modes.some(([id]) => entry.measure === id)) {
            if (entry.family === "usage") {
                usageChoice = {question:routeScope?.usageChoice?.question ?? "all",threshold:routeScope?.usageChoice?.threshold ?? 30000};
                cards.get("usage").questions.sync(usageChoice);
            }
            pairActive = false; entryKey = entry.key; routeScopeKey = routeKey; evidenceReturn = null; homeBack.hidden = false;
            const start = entry.date && entry.date >= entry.range.from && entry.date <= entry.range.to
                ? 90 * Math.floor((Date.parse(entry.date) - Date.parse(entry.range.from)) / (86400000 * 90)) : latestOffset(entry.range);
            void read({ entry, period: entry.period, range: entry.range, filters: entry.filters, offset: start }); return;
        }
        if (routeScopeKey !== routeKey && (routeScope || routeScopeKey !== undefined)) {
            routeScopeKey = routeKey;
            const target = routeScope ?? { family: "rhythm", period: "7", range: time.preset("7",context.timeContext.timeZone), filters: {}, adaptive:true };
            if (target.usageChoice) {
                usageChoice = target.usageChoice; cards.get("usage").questions.sync(usageChoice);
            }
            const samePeriod = target.range.from === range?.from && target.range.to === range?.to && period === target.period
                || target.adaptive && period === "latest" && target.filters && Object.keys(target.filters).length === 0;
            const same = current() && samePeriod && JSON.stringify(target.filters) === JSON.stringify(filters) && data.timeContext.timeZone === context.timeContext.timeZone
                && (data.usageQuestion ?? "all") === usageChoice.question && (data.usageThreshold ?? 30000) === usageChoice.threshold;
            if (!same || root.getAttribute("aria-busy") === "true") {
                void read({ ...target, initial: Boolean(target.adaptive), routeFamily: target.family }); return;
            }
            activeMeasure = target.family; family = null; compared.clear(); allCharts = false; paint(); return;
        }
        routeScopeKey = routeKey;
        if (root.getAttribute("aria-busy") === "true" && readingRevision === context.revision && readingZone === context.timeContext.timeZone) {
            if (changedSection && current()) paint();
            return;
        }
        if (!entry) { acceptedEntry = entryKey = null; homeBack.hidden = true; }
        const initial = !range;
        if (initial) range = time.preset("7", context.timeContext.timeZone);
        const input = { expectedRevision: context.revision, from: range.from, to: range.to, filters, offset, timeContext: context.timeContext,
            ...(usageChoice.question !== "all" ? { usageQuestion:usageChoice.question, usageThreshold:usageChoice.threshold } : {}) };
        const key = JSON.stringify(input);
        if (key !== requestedKey || lastRevision !== context.revision && key === acceptedKey) void read({ range, period, filters, offset, initial });
        else if (data && key === acceptedKey && (!wasEnabled || changedSection)) paint();
    }
    return { update, withdrawAccess,
        evidenceOrigin: () => current() ? evidenceReturn?.origin ?? null : null,
        leave: () => { hideHover(); clearPending(); localChoices.close(false); datePicker.close(false); if (dialog.open) dialog.close(); } };
}

export const trendsStyles = `
.trends-local-choices .trends-control{display:grid;gap:var(--space-xs);margin-block-end:var(--space-md)}
.trends-local-choices .trends-control>label{padding:0}
.trends-local-choices .trends-control>.select-control{width:100%}
:root{--trends-series-1:#315fad;--trends-series-2:#007a78;--trends-series-3:#7957a0;--trends-series-4:#967000;--trends-series-5:#b14767;--trends-series-6:#467435;--trends-series-7:#006b97;--trends-series-8:#4d56ab;--trends-series-9:#ab6029;--trends-series-10:#8e3f91;--trends-series-11:#b04435;--trends-series-12:#526c80}
:root[data-evidence-theme=dark]{--trends-series-1:#8fb6f2;--trends-series-2:#65c8c0;--trends-series-3:#b99add;--trends-series-4:#d9b866;--trends-series-5:#ed8aa3;--trends-series-6:#9ac58c;--trends-series-7:#63bee4;--trends-series-8:#9da4ec;--trends-series-9:#e5a377;--trends-series-10:#d899d9;--trends-series-11:#e8998b;--trends-series-12:#9eb8ce}
#trendsView{min-width:0;container-type:inline-size}
.trends-landing-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(16rem,1fr);gap:1rem}
.trends-discover{display:contents}.trends-start{display:flex;align-items:flex-start;flex-direction:column;gap:.25rem}
.trends-start h2{margin:0;font-size:var(--type-section)}.trends-start h3{font-size:var(--type-small);margin:.7rem 0 .2rem}
.trends-example,.trends-explore button{display:flex;align-items:center;justify-content:space-between;width:100%;text-align:start}
.trends-example .wire-icon,.trends-explore button .wire-icon{width:1em;height:1em;flex:none}
.trends-discover>.trends-explore{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:2rem}.trends-explore h2{grid-column:1/-1}
.trends-panel-pair{background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);padding:1rem 1.25rem;min-width:0;--trends-plot-height:clamp(13rem,29vh,19rem)}
.trends-panel-pair h2{margin:0;font-size:var(--type-section)}.trend-pair-picks,.trend-pair-readings{display:flex;align-items:end;flex-wrap:wrap;gap:.5rem 1rem;margin:.7rem 0}
.trend-pair-picks .trends-control{display:grid;justify-items:start;gap:.25rem;min-width:0;max-width:100%}.trend-pair-picks select{width:auto;max-width:100%}
.trend-pair-body>.trends-switch{width:fit-content}.trend-pair-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(12rem,24%);gap:1rem;margin:.75rem 0}
.trend-pair-grid>.trend-pair-readings{display:block;margin:0;align-self:start}.trend-pair-readings>div{margin:.8rem 0}.trend-pair-key{display:inline-block;width:1.5em;border-top:3px solid var(--series-color);margin-inline-end:.5em;vertical-align:middle}.trend-pair-key[data-secondary=true]{border-top-style:dashed}
.trend-pair-readings{align-items:start;padding:.7rem;background:var(--canvas)}.trend-pair-readings h3{width:100%;margin:0}.trend-pair-readings p{margin:.25rem 0}
.trend-pair-scene h3,.trend-pair-readings h3{font-size:var(--type-body)}.trend-pair-scene{min-width:0}.trends-panel-pair summary{padding:.6rem 0;cursor:pointer}
#trendsView .trends-guide{display:grid;grid-template-columns:minmax(10rem,15rem) minmax(0,1fr);max-width:none;gap:1.5rem}
.trends-guide nav{display:grid;align-content:start}.trends-guide nav button{justify-content:start;text-align:start}.trends-guide nav [aria-current=page]{background:var(--accent-soft);color:var(--ink)}.trends-guide article{max-width:64ch}
@container(max-width:48rem){.trends-landing-grid,.trend-pair-grid{grid-template-columns:minmax(0,1fr)}#trendsView .trends-guide{grid-template-columns:minmax(0,1fr)}.trends-guide nav{display:flex;flex-wrap:wrap}.trend-pair-picks label{width:100%}}
.trends-landing-head{display:flex;align-items:center;justify-content:space-between;gap:1em}.trends-landing-head h2,.trends-guide h2{margin:0;font-size:var(--type-section)}
.trends-landing .trends-index-scope{margin-block:.5em 1em}.trends-guide{max-width:65ch;padding:1rem 1.25rem;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius)}
.trends-guide details{border-bottom:1px solid var(--surface-divider)}.trends-guide details:last-child{border:0}.trends-guide summary{padding-block:.75em;cursor:pointer}.trends-guide p{margin:0 0 1em}
.trends-toolbar,.trends-detail-bar,.trends-heading,.trends-inspection-heading,.trends-dialog-heading,.trends-dialog-actions,.trends-restrictions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.trends-toolbar{margin-bottom:var(--space-sm)}
.trends-pending{min-height:1.5em;margin:-8px 0 8px;color:var(--muted);font-size:var(--type-small);line-height:1.5}
.trends-toolbar>button,.trends-detail-bar>button{display:inline-flex;align-items:center;gap:8px}
.trends-filter-actions{display:inline-flex;align-items:center;gap:4px;max-inline-size:100%}
.trends-filter-actions .filter-entry{display:inline-flex;align-items:center;gap:8px}
.trends-filter-actions .filter-entry>.wire-icon{flex:none;width:1rem;height:1rem}
.trends-modes button[aria-pressed=true]{--pill-fill:var(--accent-soft);--pill-border:var(--control);--pill-hover:var(--accent-hover);--pill-pressed:var(--accent-pressed)}
.trends-restrictions{margin-bottom:12px}
.trends-detail-bar{justify-content:space-between;margin-bottom:16px}
.trends-control{display:flex;align-items:center;gap:8px;max-width:100%;min-width:0;flex-wrap:wrap}.trends-control select{min-width:0;max-width:100%;width:13rem}
.trends-control .select-control{min-width:0;max-width:100%}
.trends-overview{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;min-width:0;align-content:start}
.trends-panel,.trends-landing,.trends-start{--trends-plot-height:18rem;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius);padding:16px 20px;min-width:0;container:trend-card / inline-size}
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
.trends-plot{position:relative;min-width:0;width:100%;height:var(--trends-plot-height);background:var(--paper);overflow-x:auto;overflow-y:hidden;overflow-anchor:none;overscroll-behavior-x:contain}
.trends-plot svg{display:block;max-width:none}.trends-plot text{fill:var(--muted);font:var(--type-small) var(--font)}
.trends-grid{stroke:var(--screen-grid);stroke-width:1}.trends-baseline{stroke:var(--muted)}.trends-plot [data-trend-mark]{outline:none;cursor:pointer}
.trends-plot [data-trend-mark]:focus-visible{stroke:var(--focus);stroke-width:2}
.trends-chart-empty{position:absolute;inset:30px auto auto 70px;background:var(--paper);padding:8px;max-width:calc(100% - 80px)}
.trends-legend{display:grid;gap:0;min-width:0;margin:0}
.trends-legend-row{display:flex;flex-wrap:wrap;align-items:center;gap:2px 12px;min-width:0;padding-bottom:6px}
.trends-series{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-content:center;align-items:start;flex:1 1 auto;width:max-content;gap:6px;min-height:44px;min-width:0;max-width:100%;padding:var(--space-xs) var(--space-sm);border-radius:var(--radius-small);cursor:pointer}
.trends-series:hover:has(input:enabled){background:var(--hover)}
.trends-series:active:has(input:enabled){background:var(--accent-pressed)}
.trends-series:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:-2px}
.trends-series:has(input:focus-visible)>input{outline:none}
.trends-series input{width:18px;height:18px;min-height:0;margin:0;margin-block-start:max(0px,calc((1lh - 18px)/2));font:inherit;accent-color:var(--toggle-on)}
.trends-series>.trends-sample{margin-block-start:max(0px,calc((1lh - 12px)/2))}
.trends-series-label{min-width:0;overflow-wrap:anywhere;white-space:normal}
.trends-sample{display:inline-block;width:20px;height:12px;flex:none}
.trends-author-icon{flex:none;width:1em;height:1em;align-self:center}
.trends-legend-value{flex:none;margin-inline-start:auto;font-size:var(--type-body);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.trends-value-track{display:block;height:4px;background:var(--canvas)}.trends-value-fill{display:block;height:100%}
.trends-legend-row>.trends-value-track{flex:0 0 100%}
.trends-legend-row[data-hidden=true]>.trends-value-track{visibility:hidden}
.trends-panel:is([data-family=authors],[data-family=services]) .trends-series-label{white-space:nowrap;overflow-wrap:normal}
.trends-panel:is([data-family=authors],[data-family=models],[data-family=timing]) .trends-legend-row>.trends-value-track{display:none}
.trends-limits,.trends-qualification{font-size:var(--type-small);color:var(--muted);margin:12px 0 0}
.trends-qualification{margin:0 0 16px}.trends-limits:empty{display:none}
.trends-panel[data-maximized=true]{--trends-plot-height:clamp(22rem,48vh,34rem)}
.trends-point{display:grid;grid-template-columns:6rem minmax(0,1fr) auto;align-items:center;gap:4px 12px;margin:12px 0;min-height:44px}
.trends-point h3{margin:0;font-size:var(--type-body);font-weight:var(--weight-medium)}
.trends-point-scope,.trends-point-space{display:grid;min-width:0;overflow-wrap:anywhere;font-size:var(--type-small);color:var(--muted)}
.trends-point-scope>span,.trends-point-space>span{grid-area:1/1}
.trends-point-space{visibility:hidden;pointer-events:none}
.trends-point-actions{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;min-width:0}
.trends-point-actions>button{max-width:100%;white-space:normal}
.trends-inspection{margin-top:20px;padding:20px;background:var(--paper);border:1px solid var(--surface-edge);border-radius:var(--radius)}
.trends-inspection-caption{margin:0 0 12px;font-size:var(--type-small);font-weight:var(--weight-regular);line-height:var(--leading-ui);overflow-wrap:anywhere}
.trends-inspection-body{display:grid;gap:8px;align-content:start;overflow-anchor:none}
.trends-value-row{display:grid;grid-template-columns:minmax(140px,1fr) minmax(50px,2fr) minmax(90px,1fr);align-items:center;gap:16px;min-height:36px}
.trends-value-row[data-selected=true] .trends-sample{outline:1px solid var(--ink);outline-offset:3px}
.trends-value-name{display:flex;align-items:center;gap:8px;min-width:0}.trends-value{text-align:right;font-variant-numeric:tabular-nums}
.trends-paging{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:16px 0}
.trends-exact{overflow:auto;max-height:65dvh;overscroll-behavior:contain;container-type:inline-size}
.trends-exact:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.trends-exact table{min-width:100%;border-collapse:separate;border-spacing:0;font-variant-numeric:tabular-nums}
.trends-exact th,.trends-exact td{font-weight:400;text-align:right;padding:10px;border-bottom:1px solid var(--surface-divider);white-space:nowrap}
.trends-exact th:first-child{text-align:left;position:sticky;left:0;background:var(--paper)}
.trends-exact thead{position:sticky;top:0;z-index:1}.trends-exact thead th{background:var(--canvas)}
.trends-dialog{width:min(560px,calc(100dvw - 32px));max-height:calc(100dvh - 48px);overflow:hidden;background:var(--floating-paper);color:var(--ink);border:1px solid var(--rule);border-radius:var(--radius);padding:24px}
.trends-dialog[open]{display:flex;flex-direction:column}
.trends-dialog-heading{display:grid;grid-template-columns:minmax(0,1fr) auto;flex:none;gap:12px;margin-bottom:20px}.trends-dialog-heading h2{font-size:1.25rem;margin:0;min-width:0;overflow-wrap:anywhere}
.trends-dialog-body{min-height:0;overflow:auto;overscroll-behavior:contain;container:trend-dialog / inline-size}
.trends-dialog .trends-control{display:flex;flex-direction:column;align-items:stretch;margin:16px 0}
.trends-dialog .trends-control .select-control{width:100%}
.trends-dialog input[type=date]:enabled:hover{border-color:var(--ink)}
.trends-dialog .trends-control select{width:100%;min-height:44px}.trends-dialog-actions{justify-content:flex-end;margin-top:20px}
.trends-evidence-row{display:flex;flex-direction:column;gap:6px;padding:14px 0;border-bottom:1px solid var(--surface-divider)}
.trends-evidence-row>a{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 8px;min-width:0;min-height:44px;padding-inline:4px;overflow-wrap:anywhere}
.trends-evidence-row>a:is(:hover,:active){background:transparent;text-decoration:none}
.trends-evidence-row>a:focus-visible{outline-offset:-2px}
.trends-evidence-row [data-icon-role=forward]{grid-column:2;grid-row:1 / span 3;align-self:start;width:1.55em;height:1.55em;padding:.22em;border-radius:4px}
.trends-evidence-row>a:is(:hover,:focus-visible)>[data-icon-role=forward]{background:color-mix(in srgb,currentColor 12%,transparent)}
.trends-evidence-row>a:active>[data-icon-role=forward]{background:color-mix(in srgb,currentColor 24%,transparent)}
.trends-evidence-context{color:var(--ink);font:var(--weight-regular) var(--type-body)/1.5 var(--font);overflow-wrap:anywhere}
.trends-evidence-time{color:var(--muted);font:var(--weight-regular) var(--type-small)/1.5 var(--font)}
.trends-tooltip{position:fixed;z-index:var(--layer-tooltip);width:max-content;max-width:20.625rem;overflow:auto;background:var(--floating-paper);color:var(--ink);border:1px solid var(--surface-divider);border-radius:10px;box-shadow:var(--surface-shadow);padding:14px 16px;opacity:0;transition:opacity 110ms ease-out;font-variant-numeric:tabular-nums}
.trends-tooltip.open{opacity:1}.trends-tip-heading{display:flex;justify-content:space-between;gap:22px;margin-bottom:8px}.trends-tip-heading>span:first-child{min-width:0;overflow-wrap:anywhere}.trends-tip-heading>span:last-child{flex:none}.trends-tip-value{font-size:var(--type-title);line-height:1.2}
.trends-tip-series{display:flex;align-items:center;gap:6px}
.trends-tip-caption{color:var(--muted);margin-top:4px}.trends-tip-facts{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px 20px;margin:10px 0 0}.trends-tip-facts dt{color:var(--muted);overflow-wrap:anywhere}.trends-tip-facts dd{margin:0;text-align:right}
.trends-tip-table{border-collapse:collapse}.trends-tip-table th,.trends-tip-table td{font-weight:400;text-align:right;padding:5px 8px}.trends-tip-table th:first-child,.trends-tip-table td:first-child{text-align:left;padding-left:0}
@container (max-width:22rem){
 .trends-dialog .trends-exact :is(th,td):first-child{min-width:36cqi;width:36cqi;max-width:36cqi;white-space:normal}
}
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
 .trends-point{grid-template-columns:max-content minmax(0,1fr)}
 .trends-point-scope{grid-column:1/-1;grid-row:2}
 .trends-point-actions{grid-column:2;grid-row:1}
}
@container trend-card (max-width:22rem){
 .trends-panel[data-collapsed=true] .trends-title-group h2{min-height:calc(2 * var(--type-section) * var(--leading-section))}
}
@media(max-width:800px){.trends-panel,.trends-inspection{padding:16px}}
@media(max-width:440px){.trends-dialog{width:calc(100dvw - 24px);max-width:calc(100dvw - 24px);padding:16px}.trends-dialog-heading{margin-bottom:12px}}
@media(max-width:600px){.trends-value-row{grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}.trends-value-row>.trends-value-track{grid-column:1/-1;grid-row:2;margin-bottom:8px}.trends-value{grid-row:1;grid-column:2}}
@media(prefers-reduced-motion:reduce){.trends-tooltip{transition:none}}
.trends-workspace{min-width:0;display:grid;grid-template-columns:clamp(10rem,16%,13rem) minmax(0,1fr);gap:clamp(12px,2vw,28px);align-items:start}
.trends-primary-column{min-width:0}.trends-measure-index{display:grid;gap:2px;align-content:start;padding-inline-end:12px;border-inline-end:1px solid var(--surface-divider)}
.trends-measure-index .trends-measure{display:flex;align-items:center;text-align:start;justify-content:flex-start;background:transparent;color:var(--ink);border:0;box-shadow:none;border-radius:var(--radius-small);min-height:44px;padding:6px 12px;width:100%;font:inherit;text-decoration:none}
.trends-measure:focus-visible,.trends-choice:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.trends-index-modes,.trends-switch,.trends-secondary{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.trends-switch{border:1px solid var(--surface-edge);border-radius:var(--radius-small);padding:2px;gap:2px}
.trends-switch .trends-choice{background:transparent;color:var(--ink);box-shadow:none;border:0;border-radius:var(--radius-small);font:inherit;min-height:36px;padding:4px 8px}
.trends-index-scope{margin:4px 0 0;color:var(--muted);font-size:var(--type-small);overflow-wrap:anywhere}
#trendsView[data-layout=index] .trends-panel{--trends-plot-height:clamp(13rem,29vh,19rem);border-radius:var(--radius);padding:16px 20px}
#trendsView[data-layout=index] .trends-heading{display:flex;justify-content:space-between;align-items:start;gap:8px 12px;flex-wrap:wrap;cursor:default}
#trendsView[data-layout=index] .trends-identity{display:block;min-width:0}#trendsView[data-layout=index] .trends-sizing{display:none}
#trendsView[data-layout=index] .trends-chart-body{display:flex;flex-direction:column;gap:4px;margin-top:8px}
#trendsView[data-layout=index] .trends-summary{display:flex;align-items:center;flex-wrap:wrap;justify-content:space-between;gap:6px 12px;max-height:none;overflow:visible}
#trendsView[data-layout=index] .trends-legend{display:flex;flex:1;align-items:center;flex-wrap:wrap;gap:0 6px;max-height:none;overflow:visible}
#trendsView[data-layout=index] .trends-legend-row{display:block;padding:0;max-width:100%}#trendsView[data-layout=index] .trends-legend-row>.trends-value-track,#trendsView[data-layout=index] .trends-legend-value{display:none}
#trendsView[data-layout=index] .trends-series{padding:4px 8px;max-width:100%;width:auto;min-height:44px;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:6px}
#trendsView[data-layout=index] .trends-series input{accent-color:var(--series-color,var(--toggle-on));margin:0}#trendsView[data-layout=index] .trends-series .trends-sample{display:none}
#trendsView[data-layout=index] .trends-series-label{white-space:normal;overflow-wrap:anywhere}
#trendsView[data-layout=index] [data-family=authors] .trends-series{grid-template-columns:auto auto minmax(0,1fr)}
#trendsView[data-layout=index] .trends-point{display:flex;flex-wrap:wrap;gap:6px 12px;margin:6px 0;padding:4px 8px;background:var(--canvas);border-radius:var(--radius-small)}
#trendsView[data-layout=index] .trends-point-actions{margin-left:auto}#trendsView[data-layout=index] .trends-point-space{display:none}
.trends-secondary{border-top:1px solid var(--surface-divider);justify-content:space-between;padding-top:4px;margin-top:8px}.trends-secondary>button{--pill-border:transparent;--pill-fill:transparent;color:var(--muted)}
.trends-secondary>button:last-child{margin-inline-start:auto}.trends-chart-types{margin-inline-start:auto}.trends-index-modes .trends-control{font-size:var(--type-small);gap:4px}
.trends-index-modes .trends-control select{width:auto}.trends-compare-choices{display:grid;gap:4px}
.trends-compare-choices label{display:grid;grid-template-columns:auto minmax(0,1fr);align-content:center;align-items:start;gap:8px;min-height:44px;padding:6px 12px;border-radius:var(--radius-small);cursor:pointer}
.trends-compare-choices input{width:18px;height:18px;margin:0;margin-block-start:max(0px,calc((1lh - 18px)/2));font:inherit}
.trends-compare-choices label:where(:has(input:checked)){background:var(--accent-soft);--choice-hover:var(--trends-selected-hover)}
.trends-compare-choices label:hover{background:var(--choice-hover,var(--hover))}
.trends-compare-choices label:active{background:var(--accent-pressed)}
.trends-compare-choices label:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:-2px}
.trends-compare-choices input:focus-visible{outline:none}
.trends-toolbar [hidden],#trendsView [hidden]{display:none!important}
#trendsView[data-layout=all] .trends-workspace{display:block}#trendsView[data-layout=all] .trends-measure-index{display:flex;flex-wrap:wrap;border:0;margin-bottom:12px}#trendsView[data-layout=all] .trends-measure{width:auto}
#trendsView[data-layout=all] .trends-plot{contain:layout paint}
#trendsView[data-layout=all] .trends-plot svg{content-visibility:auto}
#trendsView .trends-toolbar{justify-content:flex-end;gap:var(--space-xs) var(--space-md)}
#trendsView .wire-section-nav{margin-bottom:var(--space-sm)}
#trendsView[data-layout=index] .trends-index-modes{justify-content:flex-end;gap:6px 12px}
#trendsView[data-layout=index] .trends-no-activity{margin-block:16px 8px}
.trends-no-activity h3{margin:0;font:var(--weight-medium) var(--type-body)/1.5 var(--font)}
.trends-no-activity p,.trends-visible-days{margin:4px 0;color:var(--muted);font-size:var(--type-small);overflow-wrap:anywhere}
.trends-no-activity button{margin-top:4px}
.trends-visible-days{grid-column:1/-1}
.trends-read-feedback .trends-pending,.trends-read-feedback .trends-qualification{min-height:0;margin:8px 0 0;overflow-wrap:anywhere}
.trends-read-feedback .trends-pending:empty{display:none}
#trendsView{position:relative;--trends-selected-hover:color-mix(in srgb,var(--accent-soft),var(--accent-pressed))}#trendsView[data-layout=index] .trends-toolbar button:disabled{visibility:hidden}
#trendsView .trends-measure::before,#trendsView .trends-choice::before{display:none}
#trendsView :is(.trends-choice[aria-pressed=true],.trends-measure[aria-current=page]){--choice-hover:var(--trends-selected-hover);background:var(--accent-soft);color:var(--ink);font-weight:var(--weight-medium);box-shadow:inset 0 0 0 1px var(--control)}
#trendsView :is(.trends-choice,.trends-measure):enabled:hover{background:var(--choice-hover,var(--hover))}
#trendsView :is(.trends-choice,.trends-measure):enabled:active{background:var(--accent-pressed)}
#trendsView[data-layout=index] .trends-heading{display:flex;align-items:start}
#trendsView[data-layout=index] .trends-identity{flex:1 1 11rem}
#trendsView[data-layout=index] .trends-index-modes{min-width:0;max-width:100%}
@container trend-card (max-width:34rem){
 #trendsView[data-layout=index] .trends-legend{flex:1 1 100%;max-height:min(28vh,12rem);overflow-y:auto}
 #trendsView[data-layout=index] .trends-chart-types{margin-inline-start:0}
 #trendsView[data-layout=index] .trends-index-modes{justify-content:flex-start;flex-basis:100%}
}
@container (max-width:52rem){.trends-workspace{grid-template-columns:minmax(0,1fr);gap:8px}.trends-measure-index{display:flex;flex-wrap:wrap;gap:2px;border-inline-end:0;border-bottom:1px solid var(--surface-divider);padding:0 0 8px}.trends-measure-index .trends-measure{width:auto}.trends-heading .trends-identity{flex:1 1 17rem}}
@container (max-width:27rem){.trends-measure-index{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.trends-measure-index .trends-measure{padding:4px 8px;white-space:normal}#trendsView[data-layout=index] .trends-panel{padding:12px}.trends-switch{max-width:100%}}
@media(forced-colors:active){
 .trends-evidence-row>a:is(:hover,:active)>[data-icon-role=forward]{outline:1px solid LinkText}
 #trendsView :is(.trends-measure[aria-current=page],.trends-choice[aria-pressed=true]){border:1px solid SelectedItem}
 #trendsView :is(.trends-measure,.trends-choice):focus-visible{outline:2px solid Highlight;outline-offset:-3px}
}
`;
