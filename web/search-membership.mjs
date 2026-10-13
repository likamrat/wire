export function createSearchMembership(snapshot, options, withinServices, hits, receipt, contract) {
    if (!contract?.analysisReceipt(receipt) || receipt.revision !== snapshot.revision
        || !Array.isArray(hits) || hits.some(hit => !hit || !["exact", "prefix", "semantic"].includes(hit.match)
            || hit.purpose === "navigate-only")) {
        throw new TypeError("Search membership requires a current strict analysis receipt and its matched items.");
    }
    const records = new Set(snapshot.scenarios.map(record => record.scenarioId));
    const actions = new Map((snapshot.requestActivity?.[options.layer] ?? []).map(row => [row.id, row]));
    const scenarios = new Set(), actionIds = new Set(), parents = new Set();
    for (const hit of hits) {
        if (!["interaction", "context", "reply", "action"].includes(hit.type) || hit.target?.kind !== "route") continue;
        const [view, query] = hit.target.href.split("?");
        if (view !== "#request") continue;
        const parameters = new URLSearchParams(query), id = parameters.get("request");
        if (!records.has(id)) continue;
        if (hit.type === "action") {
            const row = actions.get(parameters.get("call"));
            if (parameters.get("layer") !== options.layer || !row || row.scenarioId !== id) continue;
            actionIds.add(row.id); parents.add(id);
        } else { scenarios.add(id); parents.add(id); }
    }
    return { revision: snapshot.revision, scopeKey: JSON.stringify([options, withinServices]), receipt,
        scenarioIds: [...scenarios].sort(), actionIds: [...actionIds].sort(), parentScenarioIds: [...parents].sort() };
}
