// The same adapter is serialized for the controller and bundled for the React shell.
export function createAnalyzeTrendsEntry({ time, results, authorship, categories }) {
    const subjects = {
        rhythm: "Tool calls", problems: "Errors & failures", tools: "Tool usage",
        authors: "Prompt authors", models: "Response models", services: "Services", usage: "Tokens & estimated cost",
    };
    function project(family, { scope, route, revision, hasSearch, includesNative, hasEarlier, otherSources, supportedTools }) {
        if (!Object.hasOwn(subjects, family)) throw new RangeError("Unknown Analyze widget.");
        const f = scope.filters, zone = scope.timeContext.timeZone, filters = {}, changes = [];
        if (family === "problems") changes.push("Analyze counts recorded outcomes. Errors & failures counts affected interactions, not failed calls; a completed call can contain an API error.");
        if (scope.layer !== "tool") changes.push(`Analyze shows ${results.unit(scope.layer, 2)}. Trends uses recorded Work IQ tool calls and their originating interactions.`);
        if (f.outcomes?.length) changes.push("The Outcome filter does not carry over. Trends includes all recorded call outcomes.");
        if (hasSearch) changes.push("Search matches do not carry over. Trends includes activity outside those results.");
        if (includesNative || otherSources || f.sources?.some(source => source !== "github-copilot") || route.nativeGroup) {
            changes.push("Trends uses retained GitHub Copilot activity only. Other sources and Microsoft groups do not carry over.");
        }
        if (f.scope === "legacy" || f.scope === "history" && hasEarlier) changes.push("Trends uses both retained collections, not just the selected collection.");
        const omitted = [
            [f.projectIds, "project"], [f.sourceSessionIds, "chat or recorder source"], [f.endpoints, "path or operation"],
            [f.workloads, "activity category"], [f.activityTypes, "activity type"],
        ].filter(([values]) => values?.length).map(([, label]) => label);
        if (omitted.length) changes.push(`Trends does not apply these filters: ${omitted.join(", ")}.`);
        if (family === "rhythm" && (scope.bucket !== "day" || route.chart && route.chart !== "time")) {
            changes.push("The Analyze grouping does not carry over. Tool calls shows one count per calendar day.");
        }
        const single = (key, values, label) => {
            if (values?.length === 1) filters[key] = values[0];
            else if (values?.length) changes.push(`Trends supports one ${label} at a time. This selection opens with all ${label === "prompt author" ? "prompt authors" : "tools"}.`);
        };
        single("tool", f.tools, "tool");
        if (filters.tool && (!supportedTools.has(filters.tool) || filters.tool.length > 100)) {
            delete filters.tool;
            changes.push("The selected tool is unavailable in Trends. It opens with all retained Work IQ tools.");
        }
        if (authorship.filterValue(f.promptAuthors)) single("author", f.promptAuthors, "prompt author");
        const services = [...new Set([...(f.services || []), ...(route.withinServices?.split(",") || [])])];
        if (services.length === 1 && categories.entries.some(item => item.id === services[0])
            && !["Unknown", "Multiple workloads", "Platform metadata"].includes(services[0])) {
            filters.service = services[0];
            if (f.includeMissingService && !route.withinServices) changes.push("Trends keeps the selected service but excludes context-only calls with missing service details.");
        } else if (services.length) changes.push("Trends cannot apply this service selection. It opens with all services.");
        const civil = value => /^\d{4}-\d\d-\d\d$/.test(value);
        let period = ["7", "14", "30"].includes(route.range) ? route.range : "custom", range;
        if (f.from && f.to) {
            range = { from: civil(f.from) ? f.from : time.day(f.from, zone), to: civil(f.to) ? f.to : time.day(f.to, zone) };
            if (!civil(f.from) || !civil(f.to)) changes.push("Trends includes whole calendar days, not partial days.");
        } else {
            period = "7"; range = time.preset(period, zone);
            changes.push(`Analyze has ${f.from || f.to ? "an open-ended period" : "no date limit"}. Trends opens the last 7 days (${range.from} – ${range.to}).`);
        }
        return { changes, entry: { revision, family, measure: family === "usage" ? "tokens" : family === "rhythm" ? "count" : "share",
            period, range, timeContext: { ...scope.timeContext }, filters, date: range.from === range.to ? range.from : null,
            series: ({ tools: filters.tool, authors: filters.author, services: filters.service })[family] ?? null } };
    }

    function mount({ getContext, open, announce }) {
        let dismiss = null;
        const create = (tag, text, cls) => {
            const node = document.createElement(tag); if (text) node.textContent = text; if (cls) node.className = cls; return node;
        };
        function link(family) {
            const label = "View trend";
            const node = create("a", label, "text-link analyze-trend-link");
            node.href = "/trends"; node.id = `analyze-trend-${family}`;
            node.setAttribute("aria-label", `${label}: ${subjects[family]}`);
            function activate(event) {
                if (event.type === "auxclick" && event.button !== 1) return;
                event.preventDefault();
                if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
                    announce("Open this link in the current tab to carry the widget’s scope.", "info"); return;
                }
                const context = getContext();
                if (!context) { announce("Wait for a current Analyze view before opening this trend.", "stale"); return; }
                const { changes, entry } = project(family, context);
                if (!changes.length) { open(entry, node); return; }
                dismiss?.();
                const dialog = create("dialog", "", "analyze-trend-decision");
                const head = create("div", "", "dialog-head"), title = create("h2", `Open ${subjects[family]} in Trends?`);
                title.id = "analyzeTrendDecisionTitle"; head.append(title); dialog.setAttribute("aria-labelledby", title.id);
                const body = create("div", "", "dialog-body"), list = create("ul");
                list.append(...changes.map(text => create("li", text)));
                const actions = create("div", "", "dialog-actions"), cancel = create("button", "Stay in Analyze", "quiet"), accept = create("button", "Open trend", "primary");
                cancel.type = accept.type = "button"; actions.append(cancel, accept); body.append(list, actions); dialog.append(head, body);
                dismiss = () => { dismiss = null; dialog.close(); dialog.replaceChildren(); dialog.remove(); };
                const stay = () => { dismiss?.(); node.focus({ preventScroll: true }); };
                cancel.onclick = stay;
                dialog.addEventListener("cancel", event => { event.preventDefault(); stay(); });
                accept.onclick = () => {
                    const latest = getContext(); stay();
                    // A read, Search change or history traversal while deciding invalidates that decision.
                    if (!latest || latest.snapshot !== context.snapshot || latest.route !== context.route || latest.hasSearch !== context.hasSearch
                        || latest.searchMembership !== context.searchMembership || JSON.stringify(project(family, latest)) !== JSON.stringify({ changes, entry })) {
                        announce("Analyze changed. Open the trend again to review its current scope.", "stale"); return;
                    }
                    open(entry, node);
                };
                document.body.append(dialog); dialog.showModal(); cancel.focus();
            }
            node.addEventListener("click", activate); node.addEventListener("auxclick", activate);
            return node;
        }
        return { link, leave: () => dismiss?.() };
    }
    return { project, mount };
}
