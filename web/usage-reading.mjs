export function createUsageReading({ firstUsageDays, tokenKinds, usageSummary, usageQuestions, usageThresholds, usageTools, modelName }) {
const number = new Intl.NumberFormat().format;
const names = { freshInput: "Uncached input", cacheRead: "Input reused from cache", cacheWrite: "Input saved to cache", output: "Generated output" };
function questionControls(doc, prefix, change, { filters = false } = {}) {
    const host = doc.createElement("div"), controls = new Map();
    host.className = "usage-question-controls";
    function select(key, title, choices) {
        const group = doc.createElement("div"), label = doc.createElement("label"), field = doc.createElement("select");
        group.className = "report-form-field";
        label.textContent = title; field.id = `${prefix}Usage${key}`; label.htmlFor = field.id;
        for (const [value,text] of choices) field.add(new Option(text, value));
        field.addEventListener("change", () => change(key, key === "threshold" ? Number(field.value) : field.value));
        group.append(label,field); host.append(group); controls.set(key,{group,field});
    }
    select("question", "Usage question", Object.entries(usageQuestions));
    select("threshold", "High usage means", usageThresholds.map(n => [n, `At least ${number(n)} tokens`]));
    if (filters) {
        select("author", "Prompt author", [["","All authors"],["user","Human"],["agent","Agent"],["unknown","Sender unclear"]]);
        select("tool", "Interaction used", [["","All Work IQ tools"], ...usageTools.map(k => [k,k.replace(/^workiq-/,"")])]);
    }
    function sync(options = {}, disabled = false, fixedScope = false) {
        for (const [key,{field,group}] of controls) {
            field.value = String(options[key] ?? ({question:"all",threshold:30000})[key] ?? "");
            group.hidden = key === "threshold" && options.question !== "tool" || ["author","tool"].includes(key) && (!options.question || options.question === "all")
                || fixedScope && ["author","tool"].includes(key);
            field.disabled = disabled || group.hidden;
        }
    }
    sync(); return { host, sync };
}
function textSize(bytes) {
    if (bytes === 0) return "0 bytes";
    const estimate = Math.round(bytes / 4);
    const tokens = estimate === 0 ? "<1 token" : `~${number(estimate)} ${estimate === 1 ? "token" : "tokens"}`;
    return `${number(bytes)} ${bytes === 1 ? "byte" : "bytes"} (${tokens})`;
}
function toolTokenFields(call) {
    const u = call.toolTokens;
    const split = u && [u.input === null ? "input not recorded" : `${number(u.input)} input`,
        u.output === null ? "output not recorded" : `${number(u.output)} output`].join(", ");
    const usage = !u ? "No verified count for this call. Model counts cover the model request."
        : u.total === null ? split : `${number(u.total)} tokens (${split})`;
    return [["Tool operation tokens",usage], ["Returned text", Number.isSafeInteger(call.returnedTextBytes) && call.returnedTextBytes >= 0
        ? textSize(call.returnedTextBytes) : "Size unavailable"]];
}
function usageReading(el, host, scenario, formatTime, callLabel, resolveName = modelName) {
    const u = scenario?.usage;
    const tools = scenario.toolCalls ?? [], sized = tools.filter(c => c.usageContextLinked && Number.isSafeInteger(c.returnedTextBytes) && c.returnedTextBytes >= 0);
    if (!u) {
        const reasons = {
            "interaction-link-or-boundary":"The prompt and final response could not be linked.",
            "outside-read-window":"The saved history does not cover the full exchange.",
            "history-gap":"Part of this exchange's saved history could not be read.",
            "incomplete-or-nested":"A history gap or nested agent work prevents a complete count.",
            "conflicting-link":"More than one request may own these calls.",
            "unverified-model-call":"A model call could not be identified.",
            "invalid-receipt":"A model receipt has invalid counts or conflicting source details.",
            "conflicting-receipt":"Token counts disagree for the same model call.",
            "partial-receipts":"Some model calls have no token counts.",
            "no-linked-receipt":"No token counts matched this prompt's model calls.",
            "index-unreadable":"Copilot's token records couldn't be read. WIRE tries again on the next collection.",
        };
        host.append(el("p", "", reasons[scenario?.usageGap] ?? "No token counts have been verified for this interaction."));
    } else {
        renderModelCounts(el, host, u);
        if (scenario.usageBasis === "copilot-usage-index") host.append(el("p", "usage-context",
            `Counted from the Copilot app's own per-call usage records for this prompt${scenario.usageSubagentCalls
                ? `, including ${number(scenario.usageSubagentCalls)} sub-agent ${scenario.usageSubagentCalls === 1 ? "call" : "calls"}` : ""}.`));
        if (scenario.usageUnfinished) host.append(el("p", "usage-context", "This exchange stopped before a final answer. The count covers every model call it recorded."));
    }
    host.classList.add("usage-reading");
    if (tools.length && (sized.length !== 1 || tools.length !== 1)) {
        host.append(el("p", "usage-context", sized.length ? `Work IQ returned ${textSize(sized.reduce((n,c) => n + c.returnedTextBytes,0))} of text.${sized.length < tools.length ? ` Measured for ${sized.length} of ${tools.length} calls.` : ""}`
            : tools.some(c=>Number.isSafeInteger(c.returnedTextBytes) && c.returnedTextBytes >= 0) ? "Returned-text sizes are available in Call details, but could not be linked to this prompt."
            : "No returned-text size was saved for this interaction."));
    }
    if (!u && !sized.length) return;
    const steps = [...(u?.steps ?? []).map(s => ({ at: s.at, label: s.model, model: true, detail: `${number(s.total - s.tokens.output)} in / ${number(s.tokens.output)} out` })),
        ...sized.map(c => ({ at: c.completedAt, label: `${callLabel(c)} · ${c.tool}`, detail: `${textSize(c.returnedTextBytes)} of returned text` }))];
    const timeline = el("ol", "usage-timeline");
    for (const step of steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const row = el("li"), label = step.model ? modelLabel(el, "strong", step.label, resolveName) : el("strong", "", step.label), detail = el("span", "", step.detail);
        const clock = el("time", "muted", formatTime(step.at)); clock.dateTime = step.at;
        row.append(label, detail, clock); timeline.append(row);
    }
    host.append(el("h3", "", u && sized.length ? "Model receipts and tool completions" : u ? "Model receipts" : "Tool completions"), timeline);
}
function renderModelCounts(el, host, u) {
    host.append(el("p", "usage-headline", `${number(u.total)} tokens · ${u.steps.length} model ${u.steps.length === 1 ? "call" : "calls"}`));
    const table = el("table", "usage-table"), head = table.createTHead().insertRow();
    for (const label of ["Token type", "Tokens"]) head.append(el("th", "", label));
    const body = table.createTBody();
    for (const key of tokenKinds) {
        const tr = body.insertRow(); tr.append(el("th", "", names[key]), el("td", "", u.tokens[key] === null ? "Not recorded" : number(u.tokens[key])));
    }
    host.append(table);
}
function modelLabel(el, tag, id, resolveName) {
    const name = resolveName ? resolveName(id) : { label:id }, node = el(tag, "model-name", name.label);
    node.dataset.recordedModel = id; node.dataset.modelName = name.label;
    return node;
}
function modelShareReading(el, host, s, nativeCount, linkForModel, resolveName = modelName) {
    if (!s.models.length) {
        host.append(el("p","percentage-empty",s.eligible+nativeCount ? "No model token counts available." : "No matching interactions."));
        return;
    }
    const list = el("ul", "percentage-legend percentage-tool-list");
    const compareShares = s.models.length > 1 && s.total > 0;
    for (const row of s.models) {
        const block = el("li", "percentage-legend-row usage-model");
        const value = el("span", "percentage-value");
        if (compareShares) value.append(el("strong", "", `${Math.round(row.total*100/s.total)}%`), " ", el("span", "", `(${number(row.total)} tokens)`));
        else value.textContent = `${number(row.total)} tokens`;
        const label = linkForModel?.(row.model) ?? el("span");
        label.classList.add("percentage-label");
        const name = modelLabel(el, "span", row.model, resolveName);
        label.replaceChildren(...name.childNodes); label.dataset.recordedModel = row.model; label.dataset.modelName = name.dataset.modelName;
        if (linkForModel) {
            label.dataset.viewKey = `percentage:metered-model:${row.model}`;
            label.setAttribute("aria-label", `${name.dataset.modelName}${name.dataset.modelName === row.model ? "" : ` (${row.model})`}: ${value.textContent}. View ${number(row.interactions)} metered ${row.interactions === 1 ? "interaction" : "interactions"}.`);
        }
        block.append(label, value);
        if (compareShares) {
            const track = el("div", "percentage-bar-track"), fill = el("span", "percentage-bar");
            fill.style.width = `${100 * row.total / s.total}%`; track.setAttribute("aria-hidden", "true"); track.append(fill); block.append(track);
        }
        list.append(block);
    }
    list.setAttribute("aria-label",`Model token counts from ${number(s.metered)} of ${number(s.eligible+nativeCount)} matching interactions`);
    host.append(list);
}
function usageCalendar(scenarios,rows,identity,dayOf) {
    const records = new Map(scenarios.filter(s => s.recordKind !== "native-conversation").map(s => [s.scenarioId,s]));
    const origins = new Map([...records].map(([id,s]) => [id,identity(s)]));
    const dated = rows.filter(r => origins.has(r.scenarioId) && r.startedAt)
        .map(r => ({originId:origins.get(r.scenarioId),date:dayOf(r.startedAt)}));
    const first = firstUsageDays(dated), active = Map.groupBy(dated,r => r.date);
    let range = null;
    for (const {date} of dated) {
        if (!range) range = {from:date,to:date};
        else if (date < range.from) range.from = date;
        else if (date > range.to) range.to = date;
    }
    const usage = new Map([...records.values()].map(s => [origins.get(s.scenarioId),s.usage]));
    const days = new Map();
    for (const [origin,u] of usage) {
        const date = first.get(origin) ?? null;
        const d = days.get(date) ?? {date,total:0,metered:0,eligible:0};
        d.eligible++;
        if (u) { d.total+=u.total; d.metered++; }
        days.set(date,d);
    }
    for (const [date,rows] of active) {
        const d = days.get(date) ?? {date,total:0,metered:0,eligible:0};
        d.active = new Set(rows.map(r=>r.originId)).size;
        days.set(date,d);
    }
    return {range,days:[...days.values()].sort((a,b) => (b.date ?? "").localeCompare(a.date ?? ""))};
}
return { usageReading, toolTokenFields, modelShareReading, usageCalendar, usageSummary, questionControls };
}
