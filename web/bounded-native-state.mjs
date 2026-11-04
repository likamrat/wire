// Public DTOs only. A page is never a reconstructed conversation or selection receipt.
export function createBoundedNativeState() {
    const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype
        && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const object = value => value && Object.getPrototypeOf(value) === Object.prototype;
    const integer = value => Number.isSafeInteger(value) && value >= 0;
    const reference = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const sourceIds = ["microsoft-365-chat", "microsoft-365-cowork"];
    const countKeys = ["conversations", "variants", "messages", "parts", "taskStates", "calls", "returnedResults"];
    const resultKeys = ["success", "failure", "unknown", "partial", "other", "transport"];
    const invalid = () => new TypeError("Saved Microsoft activity could not be verified.");
    const counts = value => exact(value, countKeys) && countKeys.every(key => integer(value[key]));
    const outcomes = (value, total) => exact(value, resultKeys) && resultKeys.every(key => integer(value[key]))
        && resultKeys.reduce((sum, key) => sum + value[key], 0) === total;
    function readback(value) {
        if (!exact(value, ["schemaVersion", "snapshotRef", "committed", "current",
            ...(Object.hasOwn(value ?? {}, "deletionVersion") ? ["deletionVersion"] : [])]) || value.schemaVersion !== 1
            || Object.hasOwn(value, "deletionVersion") && !integer(value.deletionVersion)
            || !reference(value.snapshotRef) || !exact(value.current, ["generation", "configurationRevision", "privacyRevision"])
            || !integer(value.current.generation)
            || !["configurationRevision", "privacyRevision"].every(key => value.current[key] === null || integer(value.current[key]) && value.current[key] > 0)
            || value.committed !== null && (!exact(value.committed, ["operationId", "revision", "generation", "configurationRevision", "privacyRevision",
                ...(Object.hasOwn(value.committed, "committedAt") ? ["committedAt"] : [])])
                || Object.hasOwn(value.committed, "committedAt") && (typeof value.committed.committedAt !== "string" || !Number.isFinite(Date.parse(value.committed.committedAt)))
                || typeof value.committed.operationId !== "string"
                || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.committed.operationId)
                || !["revision", "generation", "configurationRevision", "privacyRevision"].every(key => integer(value.committed[key])))) throw invalid();
        return value;
    }
    function decodeReadback(value, operationId) {
        if (!exact(value, ["schemaVersion", "kind", "operationId", "status",
            ...(value?.status === "matched" ? ["revision", "sourceRevision", "readback"] : ["reason"])])
            || value.schemaVersion !== 1 || value.kind !== "native-operation-readback" || value.operationId !== operationId
            || !["matched", "unconfirmed"].includes(value.status)
            || value.status === "matched" && (!integer(value.revision) || !reference(value.sourceRevision))
            || value.status === "unconfirmed" && !["operation-not-committed", "different-committed-operation", "committed-readback-mismatch"].includes(value.reason)) throw invalid();
        if (value.status === "matched") readback(value.readback);
        return structuredClone(value);
    }
    function matchesReadback(value, snapshot, receipt) {
        if (!value || value.operationId !== receipt?.operationId || receipt.status !== "committed") return false;
        const result = decodeReadback(value, receipt.operationId);
        return result.status === "matched" && ["native-retained-page", "native-retained-drilldown", "native-retained-analysis"].includes(snapshot?.kind)
            && result.revision === snapshot.revision && result.sourceRevision === snapshot.sourceRevision
            && JSON.stringify(result.readback) === JSON.stringify(snapshot.readback)
            && ["operationId", "revision", "generation", "configurationRevision", "privacyRevision"]
                .every(key => result.readback.committed?.[key] === receipt[key]);
    }
    function decode(value, input, context) {
        const common = ["schemaVersion", "kind", "revision", "sourceRevision", "selectionRef", "definitions", "readback", "page"];
        const inventory = input?.dimension !== undefined, drilldown = input?.groupId !== undefined;
        const analysis = input?.viewId !== undefined && input?.query !== undefined;
        const sources = input?.sources ?? context?.sources, analytics = input?.analytics ?? context?.analytics;
        const kind = inventory ? "native-retained-inventory" : drilldown ? "native-retained-drilldown" : analysis ? "native-retained-analysis"
            : input?.analytics ? "native-retained-page" : input?.conversationId ? "native-retained-detail" : "native-retained-search";
        const hasViews = value && (Object.hasOwn(value, "viewId") || Object.hasOwn(value, "allViewId"));
        const hasPresentation = value && (Object.hasOwn(value, "toolGroups") || Object.hasOwn(value, "sourceGroups"));
        const extra = inventory ? ["dimension", "qualification", "aggregates", ...(value?.qualification === "unqualified" ? ["reason"] : [])]
            : kind === "native-retained-page" || drilldown || analysis ? ["aggregates", "coverage", "grouping", "resultFacet", "timeSeries",
            ...(hasPresentation ? ["toolGroups", "sourceGroups"] : []),
            ...(hasViews ? ["viewId", "allViewId"] : []), ...(drilldown || analysis && context?.original?.groupId ? ["groupId"] : []),
            ...(analysis || drilldown && context?.original?.textSelection ? ["textSelection"] : [])]
            : kind === "native-retained-detail" ? ["conversationId", "sourceId", "aggregates", "focusOrdinal",
                ...(input.section && input.section !== "observations" ? ["section", "sectionCount"] : [])]
                : ["aggregates", "coverage", "matchPolicyId"];
        if (!input || !Array.isArray(sources) || !sources.length
            || sources.some(source => !sourceIds.includes(source)) || new Set(sources).size !== sources.length
            || !exact(value, [...common, ...extra])
            || value.schemaVersion !== 1 || value.kind !== kind || !integer(value.revision)
            || input.revision !== null && value.revision !== input.revision
            || !reference(value.sourceRevision) || !reference(value.selectionRef)
            || !object(value.definitions) || !Object.values(value.definitions).every(item => typeof item === "string")
            || !exact(value.page, ["items", "limit", "nextCursor"]) || value.page.limit !== input.page.limit
            || !Number.isInteger(value.page.limit) || value.page.limit < 1 || value.page.limit > 100
            || !Array.isArray(value.page.items) || value.page.items.length > value.page.limit
            || value.page.nextCursor !== null && !reference(value.page.nextCursor)
            || hasViews && (!reference(value.viewId) || !reference(value.allViewId))
            || new TextEncoder().encode(JSON.stringify(value)).length > 8 * 1024 * 1024) throw invalid();
        readback(value.readback);
        if ((inventory || drilldown || analysis) && (!reference(input.viewId) || !context?.original
            || value.sourceRevision !== context.original.sourceRevision
            || JSON.stringify(value.readback) !== JSON.stringify(context.original.readback)
            || JSON.stringify(value.definitions) !== JSON.stringify(context.original.definitions))) throw invalid();
        if (inventory) {
            const available = ["tools", "outcomes", "sources", "conversations"].includes(input.dimension);
            if (value.dimension !== input.dimension || value.qualification !== (available ? "available" : "unqualified")) throw invalid();
            if (!available) {
                if (!["services", "endpoints", "workloads", "promptAuthors"].includes(input.dimension)
                    || value.reason !== `native-${input.dimension}-unqualified` || value.aggregates !== null
                    || value.page.items.length || value.page.nextCursor !== null) throw invalid();
                return structuredClone(value);
            }
            const a = value.aggregates;
            if (!exact(a, ["complete", "options", "unavailableRows", "selectedRows"]) || a.complete !== true
                || !["options", "unavailableRows", "selectedRows"].every(key => integer(a[key]))
                || a.unavailableRows > a.selectedRows || value.page.items.length > a.options) throw invalid();
            const seen = new Set();
            for (const item of value.page.items) {
                if (!exact(item, ["id", "value", "label", "count"]) || !reference(item.id)
                    || typeof item.value !== "string" || !item.value || typeof item.label !== "string"
                    || !integer(item.count) || item.count > a.selectedRows || seen.has(item.value)
                    || input.dimension === "sources" && !sources.includes(item.value)
                    || input.dimension === "outcomes" && !resultKeys.includes(item.value)
                    || input.dimension === "conversations" && !reference(item.value)) throw invalid();
                seen.add(item.value);
            }
            return structuredClone(value);
        }
        if (drilldown && (value.groupId !== input.groupId || !reference(value.groupId) || !hasViews)) throw invalid();
        if (analysis || drilldown && context?.original?.textSelection) {
            const text = value.textSelection, types = analysis ? input.types.length ? input.types : ["action", "context", "interaction", "reply"]
                : context.original.textSelection.types;
            if (!hasViews || !exact(text, ["purpose", "matchPolicyId", "coverage", "layer", "types", "membershipRef", "reportScope"])
                || text.purpose !== "analysis" || !reference(text.matchPolicyId) || text.coverage !== "complete"
                || text.layer !== (analytics?.layer ?? "tool") || !Array.isArray(text.types)
                || JSON.stringify([...text.types].sort()) !== JSON.stringify([...types].sort())
                || !reference(text.membershipRef) || text.reportScope !== "complete-matched-conversations"
                || analysis && context.original.groupId && value.groupId !== context.original.groupId) throw invalid();
        }
        if (kind === "native-retained-detail") {
            const retained = value => exact(value, ["variant", "current", "captureCount"]) && reference(value.variant)
                && typeof value.current === "boolean" && integer(value.captureCount) && value.captureCount > 0;
            const fact = value => object(value) && ["recorded", "recorded-empty", "explicit-null", "absent-in-response",
                "excluded-by-policy", "credential-excluded", "unsupported", "unqualified", "conflicting"].includes(value.availability)
                && (!["recorded", "recorded-empty"].includes(value.availability) || Object.hasOwn(value, "value"));
            const message = value => fact(value) && (value.availability !== "recorded" || object(value.value)
                && ["user", "assistant", "tool", "unknown"].includes(value.value.author)
                && typeof value.value.representation === "string" && typeof value.value.text === "string");
            function sourceFact(value) {
                if (!object(value) || typeof value.kind !== "string" || !object(value.fields)) return false;
                for (const key of ["text", "name", "stepTitle", "statusLiteral", "questions"]) {
                    const field = value.fields[key];
                    if (field && (!fact(field) || key !== "questions" && field.availability === "recorded" && typeof field.value !== "string")) return false;
                }
                for (const key of ["steps", "reasoningItems"]) {
                    const children = value.fields[key];
                    if (children && (Array.isArray(children) ? children.some(child => !sourceFact(child)) : !fact(children))) return false;
                }
                return true;
            }
            function fields(value) {
                if (!object(value) || Object.keys(value).some(key => !["message", "toolName", "input", "failure", "approval", "model",
                    "callElapsed", "resultReferences", "resultEvidence", "messageCreatedAt", "messageUpdatedAt", "observationTime"].includes(key))
                    || Object.values(value).some(value => !fact(value))) return false;
                if (value.message && !message(value.message)) return false;
                if (value.callElapsed?.availability === "recorded"
                    && (typeof value.callElapsed.value !== "number" || !Number.isFinite(value.callElapsed.value)
                        || value.callElapsed.value < 0 || typeof value.callElapsed.unit !== "string")) return false;
                return true;
            }
            function result(value) {
                if (!object(value) || Object.keys(value).some(key => !["tool", "task", "nestedApi"].includes(key))) return false;
                if (value.tool && (!object(value.tool) || !["succeeded", "failed", "cancelled", "unknown"].includes(value.tool.state))) return false;
                if (value.task && (!object(value.task) || typeof value.task.state !== "string")) return false;
                if (value.nestedApi && (!object(value.nestedApi) || !Array.isArray(value.nestedApi.observed)
                    || value.nestedApi.declaredRequestCount !== null && !integer(value.nestedApi.declaredRequestCount)
                    || value.nestedApi.observed.some(entry => !object(entry) || entry.statusCode !== null
                        && (!Number.isInteger(entry.statusCode) || entry.statusCode < 100 || entry.statusCode > 599)
                        || entry.errorCode !== null && typeof entry.errorCode !== "string"))) return false;
                return true;
            }
            const section = input.section ?? "observations";
            if (!["observations", "messages", "context", "calls"].includes(section) || section !== "observations"
                && (value.section !== section || !integer(value.sectionCount) || input.at !== undefined)) throw invalid();
            if (value.conversationId !== input.conversationId || !reference(value.conversationId)
                || !input.sources.includes(value.sourceId)
                || !exact(value.aggregates, ["complete", "variants"]) || value.aggregates.complete !== true
                || !integer(value.aggregates.variants) || value.page.items.length > (value.sectionCount ?? value.aggregates.variants)
                || ["messages", "context"].includes(section) && value.sectionCount > value.aggregates.variants
                || value.page.nextCursor !== null && !value.page.items.length
                || value.focusOrdinal !== (input.at ?? null)
                || input.sourceRevision !== undefined && value.sourceRevision !== input.sourceRevision) throw invalid();
            let previous = -1;
            const ids = new Set();
            for (const item of value.page.items) {
                if (!exact(item, ["id", "ordinal", "fields", "outcomes", "messageParts", "callFacts", "sourceFacts", "retention",
                    ...(Object.hasOwn(item, "callSummaries") ? ["callSummaries"] : []), ...(section === "calls" ? ["inputFacts", "evidenceFacts"] : []),
                    ...(["messages", "context"].includes(section) ? ["messageIdentity"] : [])])
                    || !reference(item.id) || ids.has(item.id) || !integer(item.ordinal) || section !== "calls" && item.ordinal <= previous
                    || !fields(item.fields) || !result(item.outcomes) || !Array.isArray(item.messageParts)
                    || item.messageParts.some(part => !message(part))
                    || !Array.isArray(item.callFacts) || !Array.isArray(item.sourceFacts)
                    || item.sourceFacts.some(value => !sourceFact(value))
                    || !retained(item.retention)) throw invalid();
                if (["messages", "context"].includes(section) && !reference(item.messageIdentity)) throw invalid();
                if (Object.hasOwn(item, "callSummaries") && (!Array.isArray(item.callSummaries)
                    || new Set(item.callSummaries.map(call => call.id)).size !== item.callSummaries.length
                    || item.callSummaries.some(call => !exact(call, ["id", "tool", "outcome"]) || !reference(call.id)
                        || call.tool !== null && (typeof call.tool !== "string" || !call.tool)
                        || !["success", "failure", "unknown"].includes(call.outcome)))) throw invalid();
                if (section === "calls" && (item.callSummaries?.length !== 1 || item.callSummaries[0].id !== item.id
                    || !Array.isArray(item.inputFacts)
                    || new Set(item.inputFacts.map(fact => fact.ordinal)).size !== item.inputFacts.length
                    || item.inputFacts.some(entry => !exact(entry, ["ordinal", "input"]) || !integer(entry.ordinal) || !fact(entry.input))
                    || !Array.isArray(item.evidenceFacts) || !item.evidenceFacts.length
                    || new Set(item.evidenceFacts.map(fact => fact.ordinal)).size !== item.evidenceFacts.length
                    || item.evidenceFacts.some(fact => !exact(fact, ["ordinal", "fields", "outcomes", "retention"])
                        || !integer(fact.ordinal) || !fields(fact.fields) || !result(fact.outcomes) || !retained(fact.retention))
                    || !item.evidenceFacts.some(fact => fact.ordinal === item.ordinal)
                    || item.inputFacts.some(fact => !item.evidenceFacts.some(entry => entry.ordinal === fact.ordinal
                        && JSON.stringify(entry.fields.input) === JSON.stringify(fact.input))))) throw invalid();
                previous = item.ordinal; ids.add(item.id);
            }
            if (input.at !== undefined && value.page.items[0]?.ordinal !== input.at) throw invalid();
            return structuredClone(value);
        }
        if (kind === "native-retained-search") {
            if (!reference(value.matchPolicyId) || !exact(value.aggregates, ["complete", "matched", "scanned", "unavailableText"])
                || value.aggregates.complete !== true || !["matched", "scanned", "unavailableText"].every(key => integer(value.aggregates[key]))
                || value.aggregates.matched > value.aggregates.scanned || value.page.items.length > value.aggregates.matched
                || !exact(value.coverage, ["history", "actionUnit", "fields", "pageIsPopulation"])
                || value.coverage.history !== "selected-retained-root-not-complete-source-history"
                || value.coverage.actionUnit !== "native-call-observation"
                || value.coverage.fields !== "authorized-messages-source-facts-and-call-inputs" || value.coverage.pageIsPopulation !== false) throw invalid();
            const ids = new Set();
            for (const hit of value.page.items) {
                if (!exact(hit, ["id", "type", "title", "revision", "source", "target", "match", "textMatch", "excerpt"])
                    || !reference(hit.id) || ids.has(hit.id) || !["interaction", "reply", "context", "action", "tool"].includes(hit.type)
                    || input.types.length && !input.types.includes(hit.type)
                    || typeof hit.title !== "string" || typeof hit.excerpt !== "string" || hit.match !== "text"
                    || hit.revision !== value.sourceRevision || !exact(hit.source, ["label", "sourceId"])
                    || typeof hit.source.label !== "string" || !input.sources.includes(hit.source.sourceId)
                    || !exact(hit.target, ["conversationId", "ordinal"]) || !reference(hit.target.conversationId) || !integer(hit.target.ordinal)
                    || !exact(hit.textMatch, ["field", "start", "end", "excerptStart"])
                    || !["title", "content", "source"].includes(hit.textMatch.field)
                    || !["start", "end", "excerptStart"].every(key => integer(hit.textMatch[key]))
                    || hit.textMatch.start < hit.textMatch.excerptStart || hit.textMatch.end <= hit.textMatch.start
                    || hit.textMatch.end - hit.textMatch.excerptStart > hit.excerpt.length) throw invalid();
                ids.add(hit.id);
            }
            return structuredClone(value);
        }
        const a = value.aggregates;
        if (!exact(a, ["complete", "layer", ...countKeys, "selectedRows", "outcomes"]) || a.complete !== true
            || a.layer !== (analytics?.layer ?? "tool") || !countKeys.every(key => integer(a[key]))
            || !integer(a.selectedRows) || !outcomes(a.outcomes, a.selectedRows)
            || a.selectedRows !== (a.layer === "tool" ? a.calls : a.layer === "reported-api" ? a.returnedResults : 0)
            || !exact(value.coverage, ["history", "activityDates", "services", "responseLatency", "pageIsPopulation"])
            || value.coverage.history !== "selected-retained-root-not-complete-source-history"
            || !["unqualified", "source-observation-qualified"].includes(value.coverage.activityDates) || value.coverage.services !== "unqualified"
            || value.coverage.responseLatency !== "unsupported" || value.coverage.pageIsPopulation !== false
            || !exact(value.resultFacet, ["complete", "scope", "count", "outcomes"])
            || value.resultFacet.complete !== true || value.resultFacet.scope !== "before-outcome"
            || !integer(value.resultFacet.count) || !outcomes(value.resultFacet.outcomes, value.resultFacet.count)
            || value.resultFacet.count < a.selectedRows
            || resultKeys.some(key => value.resultFacet.outcomes[key] < a.outcomes[key])) throw invalid();
        const series = value.timeSeries, timed = Object.hasOwn(series ?? {}, "points");
        if (!exact(series, ["qualification", "datedRows", "undatedRows", ...(timed ? ["bucket", "timeZone", "points"] : [])])
            || !integer(series.datedRows) || !integer(series.undatedRows)
            || series.datedRows + series.undatedRows !== a.selectedRows
            || series.qualification !== (series.datedRows ? "source-observation-qualified" : "unqualified")
            || value.coverage.activityDates !== series.qualification || !timed && series.datedRows) throw invalid();
        if (timed) {
            if (series.bucket !== (analytics?.bucket ?? "day") || !["day", "week", "month"].includes(series.bucket)
                || series.timeZone !== (analytics?.timeContext?.timeZone ?? "UTC")
                || !Array.isArray(series.points) || series.points.length > 400) throw invalid();
            let previous = "", total = 0;
            const sums = Object.fromEntries(resultKeys.map(key => [key, 0]));
            for (const point of series.points) {
                if (!exact(point, ["date", "endDate", "from", "to", "count", "outcomes"])
                    || !["date", "endDate"].every(key => typeof point[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(point[key])
                        && Number.isFinite(Date.parse(point[key])) && new Date(point[key]).toISOString().slice(0, 10) === point[key])
                    || point.date <= previous || point.endDate < point.date
                    || !["from", "to"].every(key => typeof point[key] === "string" && Number.isFinite(Date.parse(point[key])))
                    || point.to.includes("T") === point.from.includes("T") && Date.parse(point.to) < Date.parse(point.from)
                    || !integer(point.count) || !outcomes(point.outcomes, point.count)) throw invalid();
                previous = point.endDate; total += point.count;
                for (const key of resultKeys) sums[key] += point.outcomes[key];
            }
            if (total !== series.datedRows || resultKeys.some(key => sums[key] > a.outcomes[key])) throw invalid();
        }
        function validateGrouping(g, by) {
        if (!exact(g, ["complete", "groupBy", "groupCount", "groups", "other"]) || g.complete !== true
            || g.groupBy !== by || !integer(g.groupCount) || !Array.isArray(g.groups)
            || g.groups.length > g.groupCount
            || g.groups.some(group => !exact(group, ["id", "label", "count", "outcomes"])
                || typeof group.id !== "string" || typeof group.label !== "string" || !integer(group.count)
                || !outcomes(group.outcomes, group.count))
            || g.other !== null && (!exact(g.other, ["groupCount", "count", "outcomes"])
                || !integer(g.other.groupCount) || !integer(g.other.count) || !outcomes(g.other.outcomes, g.other.count))
            || g.groups.length + (g.other?.groupCount ?? 0) !== g.groupCount
            || g.groups.reduce((sum, group) => sum + group.count, g.other?.count ?? 0) !== a.selectedRows) throw invalid();
            if (new Set(g.groups.map(group => group.id)).size !== g.groups.length
                || resultKeys.some(key => g.groups.reduce((sum, group) => sum + group.outcomes[key], g.other?.outcomes[key] ?? 0) !== a.outcomes[key])) throw invalid();
        }
        validateGrouping(value.grouping, analytics?.groupBy ?? "workload");
        if (hasPresentation) {
            validateGrouping(value.toolGroups, "tool");
            if (!Array.isArray(value.sourceGroups) || value.sourceGroups.length > sources.length
                || new Set(value.sourceGroups.map(group => group.sourceId)).size !== value.sourceGroups.length
                || value.sourceGroups.some(group => !exact(group, ["sourceId", "conversations", "count", "outcomes"])
                    || !sources.includes(group.sourceId)
                    || analytics?.filters?.sources?.length && !analytics.filters.sources.includes(group.sourceId)
                    || !integer(group.conversations) || !integer(group.count)
                    || !outcomes(group.outcomes, group.count))
                || value.sourceGroups.reduce((sum, group) => sum + group.count, 0) !== a.selectedRows
                || value.sourceGroups.reduce((sum, group) => sum + group.conversations, 0) !== a.conversations
                || resultKeys.some(key => value.sourceGroups.reduce((sum, group) => sum + group.outcomes[key], 0) !== a.outcomes[key])) throw invalid();
        }
        const ids = new Set();
        for (const item of value.page.items) {
            if (!exact(item, ["id", "sourceId", "title", "counts", "selectedRows", "outcomes",
                ...(Object.hasOwn(item, "presentation") ? ["presentation"] : [])])
                || !reference(item.id) || ids.has(item.id) || !sources.includes(item.sourceId)
                || analytics?.filters?.sources?.length && !analytics.filters.sources.includes(item.sourceId)
                || typeof item.title !== "string" || !counts(item.counts) || item.counts.conversations !== 1
                || countKeys.some(key => item.counts[key] > a[key])
                || !integer(item.selectedRows) || !outcomes(item.outcomes, item.selectedRows)
                || item.selectedRows !== (a.layer === "tool" ? item.counts.calls : a.layer === "reported-api" ? item.counts.returnedResults : 0)
                || item.selectedRows > a.selectedRows) throw invalid();
            if (Object.hasOwn(item, "presentation")) {
                const p = item.presentation;
                if (!exact(p, ["kind", "tools", "toolCount", ...(Object.hasOwn(p, "contextDateBasis") ? ["contextDateBasis"] : []),
                    ...(Object.hasOwn(p, "activityDateRange") ? ["activityDateRange"] : [])])
                    || !["prompt", "reply", "context", "unavailable"].includes(p.kind)
                    || !integer(p.toolCount) || p.toolCount > item.selectedRows || !Array.isArray(p.tools)
                    || p.tools.length !== Math.min(3, p.toolCount)
                    || p.tools.some(tool => typeof tool !== "string" || !tool) || new Set(p.tools).size !== p.tools.length
                    || p.contextDateBasis != null && (p.contextDateBasis !== "ordinary-message-created"
                        || item.selectedRows !== 0 || item.sourceId !== "microsoft-365-chat" || !(analytics?.filters?.from || analytics?.filters?.to))) throw invalid();
                if (Object.hasOwn(p, "activityDateRange")) {
                    const range = p.activityDateRange;
                    if (!exact(range, ["firstAt", "lastAt", "datedRows", "undatedRows"])
                        || !integer(range.datedRows) || !integer(range.undatedRows)
                        || range.datedRows + range.undatedRows !== item.selectedRows
                        || (range.datedRows === 0 ? range.firstAt !== null || range.lastAt !== null
                            : ![range.firstAt, range.lastAt].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
                                || Date.parse(range.firstAt) > Date.parse(range.lastAt))) throw invalid();
                }
            }
            ids.add(item.id);
        }
        if (ids.size > a.conversations || new TextEncoder().encode(JSON.stringify(value)).length > 8 * 1024 * 1024) throw invalid();
        return structuredClone(value);
    }
    let active = null, value = null, acceptedInput = null, acceptedContext = null, error = "", pages = [], offsets = [], pageIndex = 0, pageOffset = 0, pageCount = 0, hasNext = false;
    let acceptedOwner = null, suspended = null;
    const identity = result => JSON.stringify([result.revision, result.sourceRevision, result.selectionRef,
        result.readback, result.aggregates, result.grouping, result.toolGroups, result.sourceGroups, result.resultFacet, result.timeSeries, result.textSelection, result.groupId,
        result.section, result.sectionCount, result.conversationId, result.sourceId]);
    const selector = input => {
        const { at, sourceRevision, page, ...rest } = input;
        return { ...rest, page: { limit: page.limit, after: null } };
    };
    function withdraw() {
        active = value = acceptedInput = acceptedContext = acceptedOwner = suspended = null;
        error = ""; pages = []; offsets = []; pageIndex = pageOffset = pageCount = 0; hasNext = false;
    }
    return {
        decode, readback, decodeReadback, matchesReadback, sourceIds, withdraw,
        suspend(owner) {
            if (active || !value || value.kind !== "native-retained-detail" || !owner || owner !== acceptedOwner) return null;
            const receipt = Object.freeze({});
            suspended = { receipt, owner, input: structuredClone(acceptedInput), expected: identity(value), pageIndex, pageOffset };
            value = acceptedInput = acceptedContext = acceptedOwner = null;
            return receipt;
        },
        resume(receipt, owner) {
            if (!suspended || suspended.receipt !== receipt || suspended.owner !== owner || active || value) throw invalid();
            const { input, expected, pageIndex, pageOffset } = suspended;
            suspended = null;
            active = { input, owner, context: null, expected, pageIndex, pageOffset };
            error = "";
            return active;
        },
        begin(input, owner, context, previous = false) {
            const nextPage = input.page.after !== null;
            if (previous && (!value || pageIndex < 1 || JSON.stringify(input) !== JSON.stringify(pages[pageIndex - 1]))) throw invalid();
            if (nextPage && !previous && (!value || input.page.after !== value.page.nextCursor
                || JSON.stringify(selector(input)) !== JSON.stringify(selector({ ...acceptedInput, revision: value.revision })))) throw invalid();
            suspended = null;
            active = { input: structuredClone(input), owner, context: structuredClone(context ?? (nextPage || previous ? acceptedContext : null)),
                expected: nextPage || previous ? identity(value) : null, pageIndex: previous ? pageIndex - 1 : nextPage ? pageIndex + 1 : 0,
                pageOffset: previous ? offsets[pageIndex - 1] : nextPage ? pageOffset + value.page.items.length : 0 };
            value = null; error = "";
            return active;
        },
        receive(ticket, response, owner) {
            if (ticket !== active || ticket.owner !== owner) return false;
            try {
                const next = decode(response, ticket.input, ticket.context);
                if (ticket.expected !== null && ticket.expected !== identity(next)) throw invalid();
                value = next; acceptedInput = ticket.input; acceptedContext = ticket.context; acceptedOwner = owner;
                pageIndex = ticket.pageIndex; pageOffset = ticket.pageOffset;
                pageCount = value.page.items.length; hasNext = Boolean(value.page.nextCursor);
                if (!pageIndex) { pages = []; offsets = []; }
                pages[pageIndex] = { ...structuredClone(ticket.input), revision: next.revision };
                offsets[pageIndex] = pageOffset;
                active = null;
                return true;
            } catch (cause) {
                withdraw(); error = cause.message;
                throw cause;
            }
        },
        fail(ticket, cause) {
            if (ticket !== active) return false;
            withdraw(); error = cause.message;
            return true;
        },
        next() {
            if (!value?.page.nextCursor || !acceptedInput) throw invalid();
            const { at, ...rest } = structuredClone(acceptedInput);
            return { ...rest, revision: value.revision,
                page: { limit: value.page.limit, after: value.page.nextCursor } };
        },
        previous() { if (!value || pageIndex < 1) throw invalid(); return structuredClone(pages[pageIndex - 1]); },
        snapshot: () => ({ loading: Boolean(active), value: value ? structuredClone(value) : null, error, pageIndex, pageOffset, pageCount, hasNext }),
    };
}
