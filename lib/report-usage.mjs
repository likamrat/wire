import { usageMembers, usageSummary, usageQuestionGroups, usageTools } from "./interaction-usage.mjs";

// Preserve the disclosure allowlist: a private deployment name is not new report text.
const publicModels = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-4.1", "gpt-6.1-sol"]);
export function freezeUsage(scenarios, copies, options = { tokens: true, rows: false }, period, nativeCount = 0, excludedUnranked) {
    if (!options.tokens) return null;
    const detailed = options.overview === true && options.rows && !period && nativeCount === 0;
    const refs = new Map(scenarios.map((s, i) => [s.scenarioId, copies[i].scenarioId]));
    function cohort(input, additional) {
        const question = options.question ?? "all", modelLabel = name => publicModels.has(name) ? name : "Other model";
        const { selected: members, groups, unranked } = usageQuestionGroups(usageMembers(input), question, options.threshold, {
            author: options.author, tool: options.tool, modelLabel, toolLabel: name => usageTools.includes(name) ? name : null,
        });
        const includeAdditional = question !== "tool" && !options.author && !options.tool;
        const safe = members.map(({usage}) => usage && ({ ...usage, steps: usage.steps.map(s => ({ ...s, model:modelLabel(s.model) })) }));
        const { eligible, metered, total, tokens, cacheReadShare, models } = usageSummary(safe);
        return { eligible: eligible + (includeAdditional ? additional : 0), metered, total, tokens, cacheReadShare,
            ...(detailed && question !== "author" ? { authors: usageQuestionGroups(members, "author").groups.map(({ label, summary }) =>
                ({ label, eligible: summary.eligible, metered: summary.metered, total: summary.total })) } : {}),
            ...(question === "author" && additional && includeAdditional ? { nativeWithoutOrigin:additional } : {}),
            ...(question === "all" ? {} : { question, ...(question === "tool" ? { threshold: options.threshold ?? 30000, unranked: excludedUnranked ?? unranked + (options.author || options.tool ? 0 : additional) } : {}),
                groups: groups.map(({label, summary: s, context}) => ({ label, eligible:s.eligible, metered:s.metered, total:s.total, cacheReadShare:s.cacheReadShare,
                    ...(context ? { context } : {}) })) }),
            ...(options.author ? { author:options.author } : {}), ...(options.tool ? { tool:options.tool } : {}),
            models,
            ...(options.rows ? { rows: members.map(({ record, usage, bytes, calls }) => ({ ref: refs.get(record.scenarioId),
                total: usage?.total ?? null, contextEstimate: bytes.size && bytes.size === calls.size ? Math.round([...bytes.values()].reduce((a,b) => a+b,0)/4) : null })).sort((a,b) => (b.total ?? -1) - (a.total ?? -1)) } : {}) };
    }
    const cohorts = period ? Object.fromEntries(Object.entries(period.periods).map(([side, p]) => {
        const included = new Set(p.scenarioRefs);
        const native = new Set((period.nativePeriods?.rows ?? []).filter(r => r.startedAt && r.startedAt >= p.dateRange.from
            && r.startedAt < p.dateRange.to).map(r => r.scenarioId));
        return [side, cohort(scenarios.filter(s => included.has(refs.get(s.scenarioId))), native.size)];
    })) : { selected: cohort(scenarios, nativeCount) };
    return { version: detailed ? 2 : 1, readingVersion: detailed ? 4 : 3, cohorts };
}

// Display only previously frozen dollar values on verified historical reports.
const formatUsd = value => value === null ? "Unpriced" : value > 0 && value < .01 ? "<$0.01" : `~$${value.toFixed(2)}`;
const num = x => x === null ? "Not recorded" : x.toLocaleString("en-US");
const share = (x, basis) => basis && x !== null ? `${(100*x/basis).toFixed(1)}%` : "—";
function usageLead(s, pricing) {
    const coverage = s.metered === s.eligible ? num(s.metered) : `${num(s.metered)} of ${num(s.eligible)}`;
    const facts = [s.total === null ? "No recorded token total" : `${num(s.total)} tokens across ${coverage} ${s.eligible === 1 ? "interaction" : "interactions"}`];
    if (pricing) facts.push(s.usd === null ? "No priced interactions" : `Est. retail cost: ${formatUsd(s.usd)} (${num(s.priced)} priced; ${pricing.date} rates)`);
    facts.push(...usageContext(s));
    return facts.join(". ") + ".";
}
function usageContext(s) {
    const facts = [];
    const scope = [s.author && ({user:"Human prompts",agent:"Agent prompts",unknown:"Sender unclear"})[s.author],s.tool,
        s.question === "tool" && `at least ${num(s.threshold)} tokens`].filter(Boolean);
    if (scope.length) facts.push(scope.join(" · "));
    if (s.question === "tool" && s.unranked) facts.push(`${num(s.unranked)} without a token count`);
    if (s.question === "tool" && s.groups.reduce((n,g)=>n+g.eligible,0)>s.eligible) facts.push("An interaction can appear under several tools");
    if (s.nativeWithoutOrigin) facts.push(`${num(s.nativeWithoutOrigin)} Microsoft conversations have no single prompt author`);
    return facts;
}
function contributorFinding(s) {
    const missing = s.eligible - s.metered;
    const context = usageContext(s);
    const coverage = `${num(s.metered)} of ${num(s.eligible)} ${s.eligible === 1 ? "interaction" : "interactions"} measured.`
        + (missing ? ` ${num(missing)} ${missing === 1 ? "interaction has" : "interactions have"} no verified token count; missing usage is not estimated.` : "")
        + (context.length ? " " + context.join(". ") + "." : "");
    if (s.total === null) return { title: "No verified token counts", detail: coverage };
    if (s.total === 0) return { title: "The recorded token total is 0", detail: coverage };
    const largest = s.rows.filter(row => row.total !== null && row.total > 0).sort((a,b) => b.total-a.total).slice(0,3);
    const total = largest.reduce((sum,row) => sum+row.total,0);
    return {
        title: `${largest.length} ${largest.length === 1 ? "interaction accounts" : "interactions account"} for ${share(total,s.total)} of recorded tokens`,
        detail: `${num(total)} of ${num(s.total)} recorded tokens. ${coverage}`,
    };
}
function reading(snapshot) {
    const u = snapshot?.usageFacts;
    if (!u) return [];
    const copies = new Map(snapshot.records.map((r,i) => {
        const prompt = r.prompts?.find(p => p.kind === "origin" && !p.omitted)?.text;
        return [r.scenarioId, snapshot.promptMode !== "none" && prompt ? `${i+1}. ${prompt.slice(0,100)}${prompt.length>100?"…":""}` : `Interaction ${i+1}`];
    }));
    return Object.entries(u.cohorts).map(([side, s]) => {
        const labels = { selected: "Token & cache breakdown", baseline: "Baseline: token & cache breakdown", later: "Selected period: token & cache breakdown" };
        const detailed = u.readingVersion === 4 && Array.isArray(s.rows);
        const dollars = !!u.pricing, tables = [];
        if (s.tokens) tables.push([["Token type", "Tokens"], [
            ["Fresh input", num(s.tokens.freshInput)], ["Cache reads", num(s.tokens.cacheRead)],
            ["Cache writes", num(s.tokens.cacheWrite)], ["Output", num(s.tokens.output)],
        ]]);
        if (s.groups) tables.unshift([[s.question === "author" ? "Prompt author" : s.question === "tool" ? "Interactions that used" : "Model", "Metered / all", "Tokens", "Input read from cache",
            ...(dollars ? ["Priced / all", "Est. USD"] : []), ...(s.question === "tool" ? ["Returned context (est.)"] : [])],
            s.groups.map(g => [g.label, `${g.metered} / ${g.eligible}`, num(g.total), share(g.cacheReadShare, 1),
                ...(dollars ? [`${g.priced} / ${g.eligible}`, g.metered ? formatUsd(g.usd) : "Not recorded"] : []),
                ...(g.context ? [g.context.tokens === null ? "Not recorded" : `~${num(g.context.tokens)} tokens (${g.context.sized}/${g.context.calls} calls)`] : [])])]);
        if (!s.groups && s.models.length) tables.push([["Model", "Prompts", "Input incl. cache", "Output", ...(dollars ? ["Est. USD", "Cost share"] : ["Token share"])],
            s.models.map(m => [m.model, num(m.interactions), num(m.input), num(m.output), ...(dollars ? [formatUsd(m.usd), share(m.usd,s.usd)] : [share(m.total,s.total)])])]);
        if (detailed && s.authors?.length) tables.unshift([["Prompt author", "Measured / eligible", "Share (recorded tokens)"],
            s.authors.map(g => [g.label, `${g.metered} / ${g.eligible}`, g.total === null ? "Not recorded"
                : s.total > 0 ? `${share(g.total,s.total)} (${num(g.total)})` : num(g.total)])]);
        if (s.rows?.length) tables.push([["Interaction", "Total tokens", "Work IQ context (est.)", ...(dollars ? ["Est. USD"] : [])],
            s.rows.map(r => [copies.get(r.ref), num(r.total), r.contextEstimate === null ? "Not recorded" : `~${num(r.contextEstimate)}`, ...(dollars ? [r.total === null ? "Not recorded" : formatUsd(r.usd)] : [])])]);
        const summary = u.readingVersion >= 2 ? usageLead(s, u.pricing) : `${s.metered} of ${s.eligible} interactions metered. ${s.total === null ? "No recorded token total." : `${num(s.total)} tokens.`}`
            + (dollars ? ` ${s.usd === null ? "No fully priced interactions" : formatUsd(s.usd)}; ${s.priced} priced${s.unpriced ? `, ${s.unpriced} unpriced` : ""}.` : "")
            + (s.author || s.tool ? ` Usage scope: ${[s.author && ({user:"Human prompts",agent:"Agent prompts",unknown:"Author unverified"})[s.author],s.tool].filter(Boolean).join(", ")}.` : "")
            + (s.question === "tool" ? ` At least ${num(s.threshold)} tokens per interaction.${s.unranked ? ` ${s.unranked} without a token count could not be ranked.` : ""} Tool groups overlap; the total counts each interaction once. Returned context is not extra model usage.` : "")
            + (s.question === "model" ? " Each model contributes only its recorded calls. Mixed-model interactions may appear in more than one row." : "")
            + (s.nativeWithoutOrigin ? ` ${num(s.nativeWithoutOrigin)} Microsoft conversations have no single originating prompt author.` : "")
            + (dollars ? ` Retail API-equivalent estimate, rates ${u.pricing.date}. Not billed Copilot spend.` : "");
        const groupTitle = {author:"Usage by prompt author",tool:"Usage by tool group",model:"Usage by model"};
        return { id:`usage-${side}`, tokenOnly:u.readingVersion >= 3, question:s.question,
            title: s.question ? `${side === "selected" ? "" : side === "baseline" ? "Baseline: " : "Selected period: "}${groupTitle[s.question]}` : detailed ? "Usage overview" : labels[side],
            summary, tables, finding: detailed ? contributorFinding(s) : null, rankedTable: detailed && s.rows.length > 0,
            links: detailed && snapshot.reportPopulation ? new Map(s.rows.map(row => [copies.get(row.ref), row.ref])) : null };
    });
}
export function usageHtml(snapshot, escape) {
    return reading(snapshot).map(({id,title,question,tokenOnly,summary,tables,finding,rankedTable,links}) => `<section id="${id}"${tokenOnly ? " data-token-summary" : ""}${finding ? ' data-token-overview="4"' : ""}${question ? ' data-usage-question=""' : ""}><h2>${escape(title)}</h2>${finding
        ? `<h3>${escape(finding.title)}</h3><p>${escape(finding.detail)}</p>${rankedTable ? `<p><a class="report-count-link" href="#${id}-interactions">View ranked interactions</a></p>` : ""}`
        : `<p>${escape(summary)}</p>`}${tables.map(([head, rows]) =>
        `<div${finding && head[0] === "Interaction" ? ` id="${id}-interactions"` : ""} class="table-wrap" role="region" tabindex="0" aria-label="${escape(head[0])} breakdown"><table class="native-table"><thead><tr>${head.map((h,i)=>`<th scope="col"${i?' class="report-numeric"':""}>${escape(h)}</th>`).join("")}</tr></thead><tbody>${rows.map(row =>
            `<tr><th scope="row">${head[0] === "Interaction" && links?.has(row[0])
                ? `<a class="report-count-link" href="#${escape(links.get(row[0]))}">${escape(row[0])}</a>` : escape(row[0])}</th>${row.slice(1).map((c,i)=>`<td class="report-numeric" data-label="${escape(head[i+1])}">${escape(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`).join("")}</section>`).join("");
}
export function usageMarkdown(snapshot, escape) {
    return reading(snapshot).flatMap(({id,title,summary,tables,finding,rankedTable,links}) => [
        ...(finding ? [`<section id="${id}" data-token-overview="4">`, ""] : []), `## ${title}`, "",
        ...(finding ? [`### ${finding.title}`, "", finding.detail, "", ...(rankedTable ? [`[View ranked interactions](#${id}-interactions)`, ""] : [])] : [summary, ""]),
        ...tables.flatMap(([head,rows]) => [
            ...(finding && head[0] === "Interaction" ? [`<a id="${id}-interactions"></a>`, ""] : []),
            `| ${head.map(escape).join(" | ")} |`, `| ${head.map(()=>"---").join(" | ")} |`,
            ...rows.map(row => `| ${row.map((cell,i) => i === 0 && head[0] === "Interaction" && links?.has(cell)
                ? `[${escape(cell)}](#${links.get(cell)})` : escape(cell)).join(" | ")} |`), "",
        ]), ...(finding ? ["</section>", ""] : [])]);
}
