// Self-contained for the nonce-authorized browser shell.
export function createRecordedResults() {
    const keys = ["success", "failure", "unknown", "partial", "other", "transport"];
    const icons = { success: "check", failure: "result-failure", unknown: "unobserved", partial: "result-partial", other: "result-other", transport: "result-transport" };
    function icon(key) {
        if (!Object.hasOwn(icons, key)) throw new TypeError("Result icons require a recorded outcome.");
        return icons[key];
    }
    const units = {
        tool: ["Work IQ tool call", "Work IQ tool calls"],
        "reported-api": ["tool-returned API result", "tool-returned API results"],
        "direct-request": ["recorded Graph request site", "recorded Graph request sites"],
        "recorded-http": ["Graph request site with visible status", "Graph request sites with visible status"],
        http: ["owned HTTP record", "owned HTTP records"],
        "code-reference": ["Graph code reference", "Graph code references"],
    };
    function labels(layer) {
        if (layer === "tool") return { success: "Worked", failure: "Tool failed", unknown: "No result recorded", partial: "Partly worked", other: "Other HTTP status", transport: "Connection failed" };
        return { success: "HTTP 2xx", failure: layer === "reported-api" ? "Error result" : "HTTP 4xx/5xx", unknown: layer === "code-reference" ? "Execution not observed" : "No status recorded", partial: "Partial result", other: "Other HTTP status", transport: "Connection failed" };
    }
    function selection(value) {
        if (value == null || value === "" || value === "all") return [];
        const values = [...new Set(Array.isArray(value) ? value : value.split(","))];
        return [...keys.filter(key => values.includes(key)), ...values.filter(key => !keys.includes(key)).sort()];
    }
    function filterValue(value) {
        const values = selection(value);
        if (values.some(key => !keys.includes(key))) return Array.isArray(value) ? value.join(",") : value;
        return values.length && values.length !== keys.length ? values.join(",") : undefined;
    }
    function summarize(rows) {
        if (!Array.isArray(rows)) return null;
        const unique = new Map();
        for (const row of rows) {
            if (!row || typeof row.id !== "string" || !keys.includes(row.outcome)) return null;
            if (unique.has(row.id) && unique.get(row.id).outcome !== row.outcome) return null;
            unique.set(row.id, row);
        }
        const counts = { count: unique.size, ...Object.fromEntries(keys.map(key => [key, 0])) };
        for (const row of unique.values()) counts[row.outcome]++;
        return counts;
    }
    function valid(summary) {
        return summary && Number.isSafeInteger(summary.count) && summary.count >= 0
            && keys.every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
            && keys.reduce((sum, key) => sum + summary[key], 0) === summary.count;
    }
    function entries(layer, summary) {
        if (!valid(summary)) return null;
        if (layer === "code-reference") return summary.count ? [{ key: "unknown", label: "Execution not observed", count: summary.count, icon: "unobserved" }] : [];
        const names = labels(layer);
        return keys.filter(key => summary[key] > 0).map(key => ({ key, label: names[key], count: summary[key], icon: icon(key) }));
    }
    function failureCause(call) {
        const evidence = call?.failureEvidence;
        if (evidence?.version !== 1) return null;
        // These signals were qualified at retention. Never re-read error prose or infer from HTTP status.
        if (evidence.messageStatus === "text-excluded") {
            if (evidence.messageSignal === "workiq-sign-in-required") return "Sign-in was required";
            if (evidence.messageSignal === "access-denial") return "Access was denied";
            if (evidence.messageSignal === "request-timeout") return "Request timed out (MCP -32001)";
        }
        if (evidence.reason === "error-code-recorded" && evidence.code && evidence.code !== "failure") return "Recorded error: " + evidence.code;
        return null;
    }
    function failureReason(call) {
        const cause = failureCause(call);
        if (cause) return cause;
        const evidence = call?.failureEvidence;
        if (evidence?.version !== 1) return "Error detail not recorded";
        if (evidence.messageStatus === "sensitive-excluded") return "Error detail excluded for privacy";
        if (["error-details-excluded", "result-content-excluded", "unsupported-error-format"].includes(evidence.reason)
            || ["text-excluded", "size-excluded", "unsupported-format"].includes(evidence.messageStatus)) return "Error detail not retained";
        return "Error detail not recorded";
    }
    function explainedEntries(layer, rows, callFor, { concise = false } = {}) {
        const summary = summarize(rows), ordinary = entries(layer, summary);
        if (!ordinary || layer !== "tool") return ordinary;
        const failures = new Map();
        for (const row of new Map(rows.map(row => [row.id, row])).values()) {
            if (row.outcome !== "failure") continue;
            const call = callFor(row), reason = failureReason(call);
            const previous = failures.get(reason);
            failures.set(reason, { count: (previous?.count ?? 0) + 1, reasonOnly: Boolean(failureCause(call)) });
        }
        return ordinary.flatMap(entry => entry.key === "failure"
            ? [...failures].map(([reason, detail]) => ({ ...entry, count: detail.count, reason,
                ...concise ? { reasonOnly: detail.reasonOnly } : {} })) : [entry]);
    }
    function unit(layer, count) { return units[layer]?.[count === 1 ? 0 : 1] || "records"; }
    function columnUnit(layer, count) {
        const name = unit(layer, count);
        return layer === "tool" ? name.replace("Work IQ tool ", "") : name;
    }
    function canInspect(layer, outcome) {
        return Object.hasOwn(units, layer) && layer !== "code-reference" && ["success", "failure", "transport"].includes(outcome);
    }
    function countLabel(layer, matching, total) {
        if (!Number.isSafeInteger(matching) || matching < 0) return "Result counts unavailable";
        if (total === undefined) return `${matching.toLocaleString()} ${unit(layer, matching)}`;
        if (!Number.isSafeInteger(total) || total < matching) return `${matching.toLocaleString()} matching ${unit(layer, matching)}; full-request count unavailable`;
        return `${matching.toLocaleString()} of ${total.toLocaleString()} ${unit(layer, total)} ${matching === 1 ? "matches" : "match"} this view`;
    }
    function heading(layer) {
        return { tool: "Tool completion", "reported-api": "API metadata from tool",
            "direct-request": "Recorded Graph requests", http: "Directly recorded HTTP",
            "code-reference": "Code references", "recorded-http": "Visible Graph status" }[layer];
    }
    function pathText(value) {
        const text = typeof value === "string" ? value : value?.path;
        return typeof text === "string" && text.length ? text : null;
    }
    function callPaths(call) {
        const args = call?.requestArgs ?? {};
        const targets = Array.isArray(args.entityUrls) && args.entityUrls.length ? args.entityUrls
            : [call?.requestedApiPath ?? args.functionUrl ?? args.actionUrl ?? args.entityUrl ?? args.parentUrl ?? args.path];
        return targets.map(pathText);
    }
    function returnedResult(call, row) {
        // Canonical result identities use the offset after metadata-only filtering,
        // not the optional (and potentially repeated) source result index.
        const metadata = (call?.apiResults ?? []).filter(value => value && typeof value === "object"
            && (Number.isSafeInteger(value.index) || Object.hasOwn(value, "statusCode") || Object.hasOwn(value, "status") || Object.hasOwn(value, "errorCode")));
        return metadata.find((_, offset) => row.id === `result:${JSON.stringify([row.parentCallId, offset])}`);
    }
    function returnedPath(call, row, { discovery = false } = {}) {
        const result = returnedResult(call, row);
        const explicit = result?.requestedApiPath ?? result?.path;
        if (explicit != null) return { path: pathText(explicit), source: "returned" };
        if (discovery) return { path: null, source: "missing" };
        const paths = callPaths(call);
        return paths.length === 1 && paths[0] !== null
            ? { path: paths[0], source: "call" }
            : { path: null, source: paths.length > 1 ? "unattributed" : "missing" };
    }
    return { labels, icon, selection, filterValue, summarize, valid, entries, failureReason, explainedEntries, unit, columnUnit, canInspect, countLabel, heading, pathText, callPaths, returnedResult, returnedPath, layers: Object.keys(units) };
}
