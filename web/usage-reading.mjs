export function createUsageReading({ formatUsd, tokenKinds, usageSummary, pricingSnapshot, usageQuestions, usageThresholds, usageTools }) {
const number = new Intl.NumberFormat().format;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format;
const names = { freshInput: "Fresh input", cacheRead: "Cache reads", cacheWrite: "Cache writes", output: "Output" };
function questionControls(doc, prefix, change, { filters = false, units = false } = {}) {
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
    if (units) select("unit", "Measure", [["tokens","Tokens"],["usd","Est. USD"]]);
    function sync(options = {}, disabled = false, fixedScope = false) {
        for (const [key,{field,group}] of controls) {
            field.value = String(options[key] ?? ({question:"all",threshold:30000,unit:"tokens"})[key] ?? "");
            group.hidden = key === "threshold" && options.question !== "tool" || ["author","tool","unit"].includes(key) && (!options.question || options.question === "all")
                || fixedScope && ["author","tool"].includes(key);
            field.disabled = disabled || group.hidden;
        }
    }
    sync(); return { host, sync };
}
const usageChip = u => `${compact(u.total)} tok · ${formatUsd(u.usd)}`;
function usageReading(el, host, scenario, formatTime) {
    const u = scenario?.usage;
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
        host.append(el("p", "", reasons[scenario?.usageGap] ?? "No token counts were recorded.")); return;
    }
    host.classList.add("usage-reading");
    host.append(el("p", "usage-headline", `${formatUsd(u.usd)} · ${number(u.total)} tokens · ${u.steps.length} model ${u.steps.length === 1 ? "call" : "calls"}`));
    const bar = el("div", "usage-bar"); bar.setAttribute("aria-hidden", "true");
    const table = el("table", "usage-table"), head = table.createTHead().insertRow();
    for (const label of ["Token type", "Tokens", ...(u.amounts ? ["Est. USD"] : [])]) head.append(el("th", "", label));
    const body = table.createTBody();
    for (const key of tokenKinds) {
        const segment = el("span"); segment.dataset.kind = key; segment.style.flexGrow = String(u.tokens[key]); bar.append(segment);
        const tr = body.insertRow(); tr.append(el("th", "", names[key]), el("td", "", u.tokens[key] === null ? "Not recorded" : number(u.tokens[key])));
        if (u.amounts) tr.append(el("td", "", formatUsd(u.amounts[key])));
    }
    if (tokenKinds.every(k => u.tokens[k] !== null)) host.append(bar);
    host.append(table);
    if (u.usd === null) {
        const unlisted = [...new Set(u.steps.filter(s=>s.reason === "model-not-listed").map(s=>s.model))];
        if (unlisted.length) host.append(el("p", "muted", `No retail rate for ${unlisted.join(", ")} (${u.rateDate}).`));
        if (u.steps.some(s=>s.reason === "cache-split-missing")) host.append(el("p", "muted", "A cache count is missing, so the cost is unknown."));
    }
    const tools = scenario.toolCalls ?? [], sized = tools.filter(c => c.usageContextLinked && Number.isSafeInteger(c.returnedTextBytes) && c.returnedTextBytes >= 0);
    const footprint = Math.round(sized.reduce((n, c) => n + c.returnedTextBytes, 0) / 4);
    host.append(el("p", "usage-context", sized.length ? `Work IQ returned ~${number(footprint)} tokens${sized.length < tools.length ? ` (${sized.length} of ${tools.length} calls measured)` : ""}.`
        : tools.some(c=>Number.isSafeInteger(c.returnedTextBytes)) ? "Returned text could not be linked to this prompt."
        : "Work IQ return size was not recorded."));
    const steps = [...u.steps.map(s => ({ at: s.at, label: s.model, detail: `${number(s.total - s.tokens.output)} in / ${number(s.tokens.output)} out${s.usd === null ? "" : ` · ${formatUsd(s.usd)}`}` })),
        ...sized.map(c => ({ at: c.completedAt, label: c.tool, detail: `~${number(Math.round(c.returnedTextBytes / 4))} tokens returned` }))];
    const timeline = el("ol", "usage-timeline");
    for (const step of steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const row = el("li"), label = el("strong", "", step.label), detail = el("span", "", step.detail);
        const clock = el("time", "muted", formatTime(step.at)); clock.dateTime = step.at;
        row.append(label, detail, clock); timeline.append(row);
    }
    host.append(el("h3", "", "Model receipts and tool completions"), timeline);
}
function modelShareReading(el, host, s, nativeCount) {
    for (const row of s.models) {
        const block = el("div", "usage-model"), token = s.total ? row.total / s.total : null,
            money = s.usd && row.usd !== null ? row.usd / s.usd : null;
        block.append(el("strong", "", row.model), el("span", "", `${token === null ? "No token share" : `${Math.round(token * 100)}% tokens`} · ${money === null ? "No priced share" : `${Math.round(money * 100)}% cost (${formatUsd(row.usd)})`}`));
        for (const [kind, value] of [["tokens", token], ["usd", money]]) {
            const track = el("div", "usage-share-track"), fill = el("span");
            fill.dataset.kind = kind; fill.style.width = `${100 * (value ?? 0)}%`; track.setAttribute("aria-hidden", "true"); track.append(fill); block.append(track);
        }
        host.append(block);
    }
    host.append(el("p", "muted", `${number(s.metered)} of ${number(s.eligible + nativeCount)} interactions metered${s.priced !== s.metered ? `; ${number(s.priced)} priced` : ""}.`));
}
function homepageUsage(el, host, summary, nativeCount) {
            const { eligible, metered, priced, total, usd, tokens } = summary;
            const population = eligible + nativeCount;
            if (!metered) {
                host.replaceChildren(el("p", "percentage-empty", population
                    ? `No verified token totals for the ${number(population)} matching ${population === 1 ? "interaction" : "interactions"}.`
                    : "No matching interactions."));
                return;
            }
            const facts = el("dl", "usage-overview-facts");
            for (const [label, value, detail] of [
                ["Recorded tokens", number(total), `${number(metered)} of ${number(population)} interactions`],
                ["Est. retail cost", usd === null ? "Unpriced" : formatUsd(usd),
                    priced < metered ? `${number(priced)} of ${number(population)} interactions` : ""],
            ]) {
                const fact = el("div");
                fact.append(el("dt", "", label), el("dd", "", value));
                if (detail) fact.append(el("dd", "usage-overview-detail", detail));
                facts.append(fact);
            }
            const composition = el("div", "usage-composition"), bar = el("div", "usage-bar");
            bar.setAttribute("aria-hidden", "true");
            const legend = el("ul", "usage-overview-legend");
            for (const key of tokenKinds) {
                const segment = el("span"); segment.dataset.kind = key; segment.style.flexGrow = String(tokens[key] ?? 0); bar.append(segment);
                const item = el("li"), swatch = el("i"); swatch.dataset.kind = key; swatch.setAttribute("aria-hidden", "true");
                item.append(swatch, `${names[key]}: ${tokens[key] === null ? "not recorded" : number(tokens[key])}`); legend.append(item);
            }
            if (total > 0 && tokenKinds.every(k => tokens[k] !== null)) composition.append(bar);
            composition.append(legend);
            host.replaceChildren(facts, composition);
}
function rateReference(el, host, scenarios) {
    host.replaceChildren();
    host.append(el("h3", "", "Retail rates"), el("p", "", `USD per million tokens · ${pricingSnapshot.date}. These rates estimate model use, not your Copilot bill.`));
    const wrap = el("div", "usage-table-wrap"), table = el("table", "usage-table");
    wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "Offline retail rates per million tokens");
    const head = table.createTHead().insertRow(), body = table.createTBody();
    for (const value of ["Model", ...Object.values(names)]) head.append(el("th", "", value));
    for (const [model, rate] of Object.entries(pricingSnapshot.models)) {
        const row = body.insertRow(); row.append(el("th", "", model), ...tokenKinds.map(k => el("td", "",
            rate[k].toLocaleString("en-US", { style:"currency", currency:"USD", minimumFractionDigits:2, maximumFractionDigits:3 }))));
    }
    wrap.append(table); host.append(wrap, el("p", "", "Claude cache writes use the 5-minute rate. Above 100,000 input tokens per call, Haiku rates rise 5×. Above 272,000, GPT-6.1 Sol input and cache rise 2×, output 1.5×."));
    const unknown = [...new Set(scenarios.flatMap(s => s.usage?.steps.filter(x => x.reason === "model-not-listed").map(x => x.model) ?? []))];
    if (unknown.length) host.append(el("p", "", `Unpriced models: ${unknown.join(", ")}.`));
}
return { usageChip, usageReading, rateReference, modelShareReading, homepageUsage, usageSummary, formatUsd, questionControls };
}
