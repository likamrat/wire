export function createUsageReading({ formatUsd, tokenKinds, usageSummary, pricingSnapshot }) {
const number = new Intl.NumberFormat().format;
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format;
const names = { freshInput: "Fresh input", cacheRead: "Cache reads", cacheWrite: "Cache writes", output: "Output" };
const usageChip = u => `${compact(u.total)} tok · ${formatUsd(u.usd)}`;
function usageReading(el, host, scenario, formatTime) {
    const u = scenario?.usage;
    if (!u) {
        const reasons = {
            "interaction-link-or-boundary":"The retained events do not establish both the originating prompt and its final model response.",
            "outside-read-window":"The bounded read did not contain the complete prompt and response.",
            "incomplete-or-nested":"The interaction contains a history gap or nested agent work. Its whole-interaction total cannot be verified.",
            "conflicting-link":"The recorded request identifiers do not identify a single owner.",
            "unverified-model-call":"A response lacks a consistent model and request identifier.",
            "invalid-receipt":"A receipt has unsupported or inconsistent counts, model, or source ownership.",
            "conflicting-receipt":"Receipts for the same model call disagree.",
            "partial-receipts":"At least one linked model call has no matching usage receipt.",
            "no-linked-receipt":"No per-call usage receipt matched the recorded responses in this read.",
        };
        host.append(el("p", "", `Usage not recorded. ${reasons[scenario?.usageGap] ?? "This retained record has no verified token total."}`)); return;
    }
    host.classList.add("usage-reading");
    host.append(el("p", "usage-headline", `${formatUsd(u.usd)} · ${number(u.total)} tokens · ${u.steps.length} model ${u.steps.length === 1 ? "call" : "calls"}`));
    const bar = el("div", "usage-bar"); bar.setAttribute("aria-hidden", "true");
    const table = el("table", "usage-table"), head = table.createTHead().insertRow();
    for (const label of ["Token type", "Tokens", "Est. USD"]) head.append(el("th", "", label));
    const body = table.createTBody();
    for (const key of tokenKinds) {
        const segment = el("span"); segment.dataset.kind = key; segment.style.flexGrow = String(u.tokens[key]); bar.append(segment);
        const tr = body.insertRow(); tr.append(el("th", "", names[key]), el("td", "", u.tokens[key] === null ? "Not recorded" : number(u.tokens[key])), el("td", "", formatUsd(u.amounts?.[key] ?? null)));
    }
    if (tokenKinds.every(k => u.tokens[k] !== null)) host.append(bar);
    host.append(table);
    if (u.usd === null) {
        const unlisted = [...new Set(u.steps.filter(s=>s.reason === "model-not-listed").map(s=>s.model))];
        if (unlisted.length) host.append(el("p", "muted", `No verified retail rate for ${unlisted.join(", ")} in the ${u.rateDate} snapshot.`));
        if (u.steps.some(s=>s.reason === "cache-split-missing")) host.append(el("p", "muted", "Total input and output were recorded, but a cache count is missing. WIRE cannot price that call without guessing."));
    }
    const tools = scenario.toolCalls ?? [], sized = tools.filter(c => Number.isSafeInteger(c.returnedTextBytes) && c.returnedTextBytes >= 0
        && c.promptLink && c.promptLink.promptEventId === scenario.userPrompt?.sourceEventId);
    const footprint = Math.round(sized.reduce((n, c) => n + c.returnedTextBytes, 0) / 4);
    host.append(el("p", "usage-context", sized.length ? `Work IQ context footprint: ~${number(footprint)} tokens returned by ${sized.length} of ${tools.length} calls. Estimated from returned text size, not a separate charge.`
        : "Work IQ context footprint: returned text size was not recorded."));
    const steps = [...u.steps.map(s => ({ at: s.at, label: `Model · ${s.model}`, detail: `${number(s.total - s.tokens.output)} in / ${number(s.tokens.output)} out · ${formatUsd(s.usd)}` })),
        ...sized.map(c => ({ at: c.completedAt, label: `Work IQ · ${c.tool.replace(/^workiq-/, "")}`, detail: `~${number(Math.round(c.returnedTextBytes / 4))} context tokens returned` }))];
    const timeline = el("ol", "usage-timeline");
    for (const step of steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const row = el("li"), label = el("strong", "", step.label), detail = el("span", "", step.detail);
        const clock = el("time", "muted", formatTime(step.at)); clock.dateTime = step.at;
        row.append(label, detail, clock); timeline.append(row);
    }
    host.append(el("h3", "", "Step-by-step context timeline"), timeline,
        el("p", "muted", `Model receipt and tool completion times. Retail API-equivalent estimate (${u.rateDate}); not billed Copilot spend.`));
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
    host.append(el("p", "muted", `${s.metered} of ${s.eligible + nativeCount} interactions metered; ${s.priced} priced. Token shares include unpriced interactions. Cost shares use only fully priced interactions.`));
}
function rateReference(el, host, scenarios) {
    host.replaceChildren();
    host.append(el("h3", "", "Estimated cost rates (read-only)"), el("p", "", `${pricingSnapshot.date} · ${pricingSnapshot.basis}`));
    const wrap = el("div", "usage-table-wrap"), table = el("table", "usage-table");
    wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", "Offline retail rates per million tokens");
    const head = table.createTHead().insertRow(), body = table.createTBody();
    for (const value of ["Model", ...Object.values(names)]) head.append(el("th", "", value));
    for (const [model, rate] of Object.entries(pricingSnapshot.models)) {
        const row = body.insertRow(); row.append(el("th", "", model), ...tokenKinds.map(k => el("td", "",
            rate[k].toLocaleString("en-US", { style:"currency", currency:"USD", minimumFractionDigits:2, maximumFractionDigits:3 }))));
    }
    wrap.append(table); host.append(wrap, el("p", "", "Above 100,000 input tokens, Haiku 5.5 uses 5× rates. Above 272,000, GPT-6.1 Sol uses 2× input and cache rates and 1.5× output. Thresholds apply per request, including cached input."));
    const unknown = [...new Set(scenarios.flatMap(s => s.usage?.steps.filter(x => x.reason === "model-not-listed").map(x => x.model) ?? []))];
    if (unknown.length) host.append(el("p", "", `Not in the bundled rate list: ${unknown.join(", ")}. Shown as Unpriced.`));
}
return { usageChip, usageReading, rateReference, modelShareReading, usageSummary, formatUsd };
}
