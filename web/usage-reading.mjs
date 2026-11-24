export function createUsageReading({ firstUsageDays, tokenKinds, usageSummary, usageQuestions, usageThresholds, usageTools }) {
const number = new Intl.NumberFormat().format;
const percent = new Intl.NumberFormat(undefined,{maximumFractionDigits:2}).format;
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
const usageChip = u => `${number(u.total)} tokens`;
function textSize(bytes) {
    if (bytes === 0) return "0 bytes";
    const estimate = Math.round(bytes / 4);
    return estimate === 0 ? "<1 token" : `~${number(estimate)} ${estimate === 1 ? "token" : "tokens"}`;
}
function toolTokenFields(call) {
    const u = call.toolTokens;
    const split = u && [u.input === null ? "input not recorded" : `${number(u.input)} input`,
        u.output === null ? "output not recorded" : `${number(u.output)} output`].join(", ");
    const usage = !u ? "No verified count for this call. Model counts cover the model request."
        : u.total === null ? split : `${number(u.total)} tokens (${split})`;
    return [["Tool operation tokens",usage], ["Returned text (estimate)", Number.isSafeInteger(call.returnedTextBytes) && call.returnedTextBytes >= 0
        ? textSize(call.returnedTextBytes) : "Size not recorded"]];
}
function usageReading(el, host, scenario, formatTime, callLabel) {
    const u = scenario?.usage;
    const tools = scenario.toolCalls ?? [], sized = tools.filter(c => c.usageContextLinked && Number.isSafeInteger(c.returnedTextBytes) && c.returnedTextBytes >= 0);
    if (!u) {
        const reasons = {
            "interaction-link-or-boundary":"The prompt and final response could not be linked.",
            "outside-read-window":"The saved history does not cover the full exchange.",
            "incomplete-or-nested":"A history gap or nested agent work prevents a complete count.",
            "conflicting-link":"More than one request may own these calls.",
            "unverified-model-call":"A model call could not be identified.",
            "invalid-receipt":"A model receipt has invalid counts or conflicting source details.",
            "conflicting-receipt":"Token counts disagree for the same model call.",
            "partial-receipts":"Some model calls have no token counts.",
            "no-linked-receipt":"No token counts matched this prompt's model calls.",
        };
        host.append(el("p", "", reasons[scenario?.usageGap] ?? "No token counts were recorded."));
        if (!sized.length) return;
    } else {
        renderModelCounts(el, host, u);
    }
    host.classList.add("usage-reading");
    if (sized.length !== 1 || tools.length !== 1) {
        host.append(el("p", "usage-context", sized.length ? `Work IQ returned ${textSize(sized.reduce((n,c) => n + c.returnedTextBytes,0))}${sized.length < tools.length ? ` (${sized.length} of ${tools.length} calls measured)` : ""}.`
            : tools.some(c=>Number.isSafeInteger(c.returnedTextBytes)) ? "Returned text could not be linked to this prompt."
            : "Work IQ return size was not recorded."));
    }
    const steps = [...(u?.steps ?? []).map(s => ({ at: s.at, label: s.model, detail: `${number(s.total - s.tokens.output)} in / ${number(s.tokens.output)} out` })),
        ...sized.map(c => ({ at: c.completedAt, label: `${callLabel(c)} · ${c.tool}`, detail: `${textSize(c.returnedTextBytes)} of returned text` }))];
    const timeline = el("ol", "usage-timeline");
    for (const step of steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const row = el("li"), label = el("strong", "", step.label), detail = el("span", "", step.detail);
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
function modelShareReading(el, host, s, nativeCount) {
    for (const row of s.models) {
        const block = el("div", "usage-model"), fraction = s.total ? row.total / s.total : null;
        block.append(el("strong", "", row.model), el("span", "", fraction === null ? `${number(row.total)} tokens` : `${Math.round(fraction*100)}% (${number(row.total)} tokens)`));
        const track = el("div", "usage-share-track"), fill = el("span");
        fill.style.width = `${100 * (fraction ?? 0)}%`; track.setAttribute("aria-hidden", "true"); track.append(fill); block.append(track);
        host.append(block);
    }
    host.append(el("p", "muted", `${number(s.metered)} of ${number(s.eligible + nativeCount)} interactions metered.`));
}
function usageCalendar(scenarios,rows,identity,dayOf) {
    const records = new Map(scenarios.filter(s => s.recordKind !== "native-conversation").map(s => [s.scenarioId,s]));
    const origins = new Map([...records].map(([id,s]) => [id,identity(s)]));
    const first = firstUsageDays(rows.map(r => ({originId:origins.get(r.scenarioId),date:r.startedAt && dayOf(r.startedAt)})));
    const usage = new Map([...records.values()].map(s => [origins.get(s.scenarioId),s.usage]));
    const days = new Map();
    for (const [origin,u] of usage) {
        const date = first.get(origin) ?? null;
        const d = days.get(date) ?? {date,total:0,metered:0,eligible:0};
        d.eligible++;
        if (u) { d.total+=u.total; d.metered++; }
        days.set(date,d);
    }
    return [...days.values()].sort((a,b) => (b.date ?? "").localeCompare(a.date ?? ""));
}
function homepageUsage(el, host, summary, nativeCount, days, dateLink) {
    const {eligible,metered,total,tokens} = summary, population = eligible + nativeCount;
    if (!metered) {
        host.replaceChildren(el("p","percentage-empty",population
            ? `No verified token totals for the ${number(population)} matching ${population === 1 ? "interaction" : "interactions"}.`
            : "No matching interactions."));
        return;
    }
    const grid = el("div","usage-overview"), overview = el("div","usage-by-day"), mix = el("div","usage-mix");
    const headline = el("p","usage-total",number(total));
    headline.append(el("span",""," tokens"));
    const coverage = el("p","usage-coverage",`Counts available for ${number(metered)} of ${number(population)} ${population === 1 ? "interaction" : "interactions"}.`);
    const measured = days.filter(d => d.metered);
    overview.append(headline,coverage);
    if (measured.length === 1) {
        const when = el("p","usage-only-day","Measured on ");
        if (measured[0].date) when.append(dateLink(measured[0].date));
        else when.textContent = "Date not recorded";
        overview.append(when);
    } else {
        const label = el("h4","",measured.length>3 ? "Latest 3 days with counts" : "Days with counts"), list = el("ul","usage-days");
        list.setAttribute("aria-label",label.textContent);
        for (const d of measured.slice(0,3)) {
            const row = el("li");
            row.append(d.date ? dateLink(d.date) : el("span","","Date not recorded"),el("span","usage-day-total",number(d.total)));
            list.append(row);
        }
        overview.append(label,list);
    }
    const breakdown = el("dl","usage-breakdown");
    for (const kind of tokenKinds) {
        const n=tokens[kind], row=el("div"), val=el("dd");
        if (n === null) val.textContent="Not recorded";
        else {
            const share = total ? n/total*100 : null;
            if (share !== null) val.append(el("span","usage-part-share",share>0 && share<0.01 ? "<0.01%" : `${percent(share)}%`));
            if (share !== null) val.append(" ");
            val.append(el("span","usage-part-count",share===null?number(n):`(${number(n)})`));
        }
        row.append(el("dt","",names[kind]),val); breakdown.append(row);
    }
    mix.append(el("h4","","Share of measured tokens"),breakdown);
    grid.append(overview,mix); host.replaceChildren(grid);
}
return { usageChip, usageReading, toolTokenFields, modelShareReading, homepageUsage, usageCalendar, usageSummary, questionControls };
}
