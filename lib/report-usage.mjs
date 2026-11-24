import { pricingSnapshot, usageMembers, usageSummary, formatUsd } from "./interaction-usage.mjs";

// Unlisted model IDs may be private deployment names. Do not turn them into new report text.
export function freezeUsage(scenarios, copies, options = { tokens: true, dollars: true, rows: false }, period, nativeCount = 0) {
    if (!options.tokens) return null;
    const refs = new Map(scenarios.map((s, i) => [s.scenarioId, copies[i].scenarioId]));
    function cohort(input, additional) {
        const members = usageMembers(input);
        const safe = members.map(({usage}) => usage && ({ ...usage, steps: usage.steps.map(s => ({ ...s, model: Object.hasOwn(pricingSnapshot.models, s.model) ? s.model : "Unlisted model" })) }));
        const { eligible, metered, total, tokens, cacheReadShare, usd, priced, unpriced, models } = usageSummary(safe);
        return { eligible: eligible + additional, metered, total, tokens, cacheReadShare,
            models: models.map(({ usd, ...m }) => ({ ...m, ...(options.dollars ? { usd } : {}) })),
            ...(options.dollars ? { usd, priced, unpriced } : {}),
            ...(options.rows ? { rows: members.map(({ record, usage, bytes }) => ({ ref: refs.get(record.scenarioId),
                total: usage?.total ?? null, contextEstimate: bytes.size ? Math.round([...bytes.values()].reduce((a,b) => a+b,0)/4) : null,
                ...(options.dollars ? { usd: usage?.usd ?? null } : {}) })).sort((a,b) => (b.total ?? -1) - (a.total ?? -1)) } : {}) };
    }
    const cohorts = period ? Object.fromEntries(Object.entries(period.periods).map(([side, p]) => {
        const included = new Set(p.scenarioRefs);
        const native = new Set((period.nativePeriods?.rows ?? []).filter(r => r.startedAt && r.startedAt >= p.dateRange.from
            && r.startedAt < p.dateRange.to).map(r => r.scenarioId));
        return [side, cohort(scenarios.filter(s => included.has(refs.get(s.scenarioId))), native.size)];
    })) : { selected: cohort(scenarios, nativeCount) };
    const { models, ...basis } = pricingSnapshot;
    return { version: 1, ...(options.dollars ? { pricing: { ...structuredClone(basis),
        models: Object.fromEntries(Object.entries(models).map(([id, { source, ...rate }]) => [id, rate])) } } : {}), cohorts };
}

const num = x => x === null ? "Not recorded" : x.toLocaleString("en-US");
const share = (x, basis) => basis && x !== null ? `${(100*x/basis).toFixed(1)}%` : "—";
function reading(snapshot) {
    const u = snapshot?.usageFacts;
    if (!u) return [];
    const copies = new Map(snapshot.records.map((r,i) => {
        const prompt = r.prompts?.find(p => p.kind === "origin" && !p.omitted)?.text;
        return [r.scenarioId, snapshot.promptMode !== "none" && prompt ? `${i+1}. ${prompt.slice(0,100)}${prompt.length>100?"…":""}` : `Interaction ${i+1}`];
    }));
    return Object.entries(u.cohorts).map(([side, s]) => {
        const labels = { selected: "Token & cache breakdown", baseline: "Baseline: token & cache breakdown", later: "Selected period: token & cache breakdown" };
        const dollars = !!u.pricing, tables = [];
        if (s.tokens) tables.push([["Token type", "Tokens"], [
            ["Fresh input", num(s.tokens.freshInput)], ["Cache reads", num(s.tokens.cacheRead)],
            ["Cache writes", num(s.tokens.cacheWrite)], ["Output", num(s.tokens.output)],
        ]]);
        if (s.models.length) tables.push([["Model", "Prompts", "Input incl. cache", "Output", ...(dollars ? ["Est. USD", "Cost share"] : ["Token share"])],
            s.models.map(m => [m.model, num(m.interactions), num(m.input), num(m.output), ...(dollars ? [formatUsd(m.usd), share(m.usd,s.usd)] : [share(m.total,s.total)])])]);
        if (s.rows?.length) tables.push([["Interaction", "Total tokens", "Work IQ context (est.)", ...(dollars ? ["Est. USD"] : [])],
            s.rows.map(r => [copies.get(r.ref), num(r.total), r.contextEstimate === null ? "Not recorded" : `~${num(r.contextEstimate)}`, ...(dollars ? [r.total === null ? "Not recorded" : formatUsd(r.usd)] : [])])]);
        const summary = `${s.metered} of ${s.eligible} interactions metered. ${s.total === null ? "No recorded token total." : `${num(s.total)} tokens.`}`
            + (dollars ? ` ${s.usd === null ? "No fully priced interactions" : formatUsd(s.usd)}; ${s.priced} priced, ${s.unpriced} unpriced. Retail API-equivalent estimate, rates ${u.pricing.date}. Not billed Copilot spend.` : "");
        return { id:`usage-${side}`, title:labels[side], summary, tables };
    });
}
export function usageHtml(snapshot, escape) {
    return reading(snapshot).map(({id,title,summary,tables}) => `<section id="${id}"><h2>${escape(title)}</h2><p>${escape(summary)}</p>${tables.map(([head, rows]) =>
        `<table class="native-table"><thead><tr>${head.map((h,i)=>`<th scope="col"${i?' class="report-numeric"':""}>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row =>
            `<tr><th scope="row">${escape(row[0])}</th>${row.slice(1).map((c,i)=>`<td class="report-numeric" data-label="${escape(head[i+1])}">${escape(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`).join("")}</section>`).join("");
}
export function usageMarkdown(snapshot, escape) {
    return reading(snapshot).flatMap(({title,summary,tables}) => [`## ${title}`, "", summary, "", ...tables.flatMap(([head,rows]) =>
        [head,head.map(()=>"---"),...rows].map(row=>`| ${row.map(escape).join(" | ")} |`).concat(""))]);
}
