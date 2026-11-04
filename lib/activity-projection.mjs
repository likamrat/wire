// Row-only projection and predicates shared by the server and serialized browser shell.
// Canonical extraction, attribution, and filter validation stay server-owned.
export function createActivityProjection(time, serviceCategories, outcomes) {
    const unique = items => [...new Set(items)];
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    const identity = (kind, values) => `${kind}:${JSON.stringify(values)}`;
    const validStatus = value => Number.isInteger(value) && value >= 100 && value <= 599;
    function summarize(rows) {
        const t = { count: rows.length, total: rows.length, ...Object.fromEntries(outcomes.map(o => [o, 0])) };
        for (const row of rows) {
            if (!outcomes.includes(row.outcome)) throw new TypeError("Unknown activity outcome.");
            t[row.outcome]++;
        }
        const durations = rows.map(r => r.durationMs).filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
        const quantile = p => durations.length ? durations[Math.max(0, Math.ceil(p * durations.length) - 1)] : null;
        const units = unique(rows.map(row => row.countUnit).filter(Boolean));
        const unlikeNativeUnits = units.some(unit => unit.startsWith("native-")) && units.length > 1;
        return {
            ...t, successRate: unlikeNativeUnits
                ? { numerator: null, denominator: null, percent: null, unavailable: "different-source-unit-definitions" }
                : { numerator: t.success, denominator: t.count, percent: t.count ? t.success * 100 / t.count : null },
            duration: { sampleCount: durations.length, p50Ms: quantile(0.5), p95Ms: quantile(0.95), method: "nearest-rank; available samples only" },
            statusBreakdown: unique(rows.map(r => r.status).filter(validStatus)).sort((a, b) => a - b).map(s => ({ status: s, count: rows.filter(r => r.status === s).length })),
        };
    }
    function coverage(rows) {
        const dates = rows.map(r => r.startedAt).filter(Boolean).sort();
        const size = key => unique(rows.map(r => r[key]).filter(Boolean)).length;
        return {
            sessionCount: size("sourceSessionId"), projectCount: size("projectId"), scenarioCount: size("scenarioId"),
            unscopedSessionCount: unique(rows.filter(r => !r.projectId).map(r => r.sourceSessionId).filter(Boolean)).length,
            archiveVerifiedSessionCount: unique(rows.filter(r => r.archiveVerified).map(r => r.sourceSessionId).filter(Boolean)).length,
            unknownSessionRows: rows.filter(r => !r.sourceSessionId).length,
            datedRows: dates.length, undatedRows: rows.length - dates.length, firstAt: dates[0] ?? null, lastAt: dates.at(-1) ?? null,
        };
    }
    function groupRows(rows, by) {
        if (!["service", "workload", "tool", "endpoint"].includes(by)) throw new TypeError("Choose a supported activity grouping.");
        const groups = new Map();
        for (const r of rows) {
            const label = ["service", "workload"].includes(by) ? r.workload : by === "tool" ? r.tool ?? "Tool name not qualified" : r.endpoint.label;
            const id = by === "endpoint" ? r.endpoint.id : identity(by === "service" ? "workload" : by, [label]);
            if (!groups.has(id)) groups.set(id, { id, label, rows: [] });
            groups.get(id).rows.push(r);
        }
        return [...groups.values()].map(g => ({
            id: g.id, key: g.id, label: g.label, ...summarize(g.rows),
            sessionCount: unique(g.rows.map(r => r.sourceSessionId).filter(Boolean)).length,
            sharePercent: rows.length ? g.rows.length * 100 / rows.length : 0,
            drilldownIds: g.rows.map(r => r.id),
            queryShapes: unique(g.rows.map(r => r.endpoint.queryShape.join(", "))).filter(Boolean).sort(),
        })).sort((a, b) => b.total - a.total || compare(a.label, b.label));
    }
    function knownServiceMatch(row, services) {
        return services.some(service => ["Discovery", "Multiple workloads", "Unknown"].includes(service)
            ? service === row.workload : row.serviceAssociation.services.includes(service));
    }
    function serviceSelected(row, filters) {
        return !filters.services?.length || knownServiceMatch(row, filters.services)
            || filters.includeMissingService === true && row.serviceAssociation.gaps.length > 0;
    }
    function selected(row, filters) {
        const includes = (key, v) => !filters[key]?.length || filters[key].includes(v);
        if (!includes("sources", row.sourceId)) return false;
        if (!includes("sourceSessionIds", row.sourceSessionId) || !includes("projectIds", row.projectId) || !includes("tools", row.tool) || !includes("outcomes", row.outcome)) return false;
        if (!includes("promptAuthors", row.promptAuthor)) return false;
        if (!includes("workloads", row.workload) || !serviceSelected(row, filters) || !includes("activityTypes", row.activityType)) return false;
        if (filters.includeMetadata !== true && row.workload === "Platform metadata") return false;
        const scope = filters.scope ?? "history";
        if (scope === "history" && row.scope === "legacy" || scope === "legacy" && row.scope !== "legacy") return false;
        if (filters.endpoints?.length && !filters.endpoints.includes(row.endpoint.id) && !filters.endpoints.includes(row.endpoint.label)
            && !(row.endpoint.id.startsWith("schema:") && filters.endpoints.includes(row.endpoint.id.slice(7)))) return false;
        if ((filters.from || filters.to) && !row.startedAt) return false;
        if (filters.from && Date.parse(row.startedAt) < Date.parse(filters.from)) return false;
        if (filters.to && (filters.toExclusive ? Date.parse(row.startedAt) >= Date.parse(filters.to) : Date.parse(row.startedAt) > Date.parse(filters.to))) return false;
        return true;
    }
    function serviceInvolvement(rows, filters) {
        const services = unique(filters.services ?? []);
        return {
            definition: serviceCategories.involvementDefinition, denominator: rows.length,
            groups: serviceCategories.entries.flatMap(({ id }) => {
                const members = rows.filter(row => row.serviceAssociation.services.includes(id));
                return members.length ? [{
                    id: identity("service", [id]), key: identity("service", [id]), label: id,
                    ...summarize(members), sharePercent: members.length * 100 / rows.length,
                    drilldownIds: members.map(row => row.id),
                }] : [];
            }).sort((a, b) => b.total - a.total || compare(a.label, b.label)),
            missingDetailCount: rows.filter(row => row.serviceAssociation.gaps.length).length,
            notApplicableCount: rows.filter(row => row.serviceAssociation.status === "not-applicable").length,
            evidenceGroups: serviceCategories.evidenceGroups(rows, rows[0]?.serviceAssociation.layer),
            selection: {
                services, includeMissingService: filters.includeMissingService === true,
                knownMatchIds: services.length ? rows.filter(row => knownServiceMatch(row, services)).map(row => row.id) : [],
                contextOnlyIds: services.length && filters.includeMissingService === true
                    ? rows.filter(row => !knownServiceMatch(row, services) && row.serviceAssociation.gaps.length).map(row => row.id) : [],
            },
        };
    }
    function calendarBuckets(dates, bucket, context, filters, bounds) {
        const keys = [...dates].sort(), points = [];
        if (keys.length) {
            let key = keys[0];
            while (key <= keys.at(-1)) {
                if (points.length >= 400) throw new RangeError("Timeline exceeds 400 buckets; narrow dates or choose a coarser bucket.");
                const next = time.nextBucket(key, bucket), endDate = time.addDays(next, -1);
                const start = time.midnight(key, context.timeZone), end = time.midnight(next, context.timeZone);
                // Keep a partial bucket inside the current slice, including legacy instant routes.
                const from = bounds.from && Date.parse(bounds.from) > Date.parse(start) ? filters.from : key;
                const to = bounds.to && (Date.parse(bounds.to) < Date.parse(end) || bounds.toExclusive && Date.parse(bounds.to) === Date.parse(end)) ? filters.to : endDate;
                points.push({ date: key, endDate, from, to });
                key = next;
            }
        }
        return points;
    }
    function timeline(rows, bucket, context, filters, bounds) {
        const map = new Map();
        for (const row of rows) if (row.startedAt) {
            const key = time.bucketDate(row.startedAt, bucket, context.timeZone);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(row);
        }
        const points = calendarBuckets(map.keys(), bucket, context, filters, bounds).map(point => {
            const events = map.get(point.date) ?? [];
            return { ...point, ...summarize(events), drilldownIds: events.map(r => r.id) };
        });
        return { bucket, timezone: context.timeZone, points, undatedCount: rows.filter(r => !r.startedAt).length, gapMeaning: "Zero means no qualifying records in the supplied slice, not proof no activity occurred." };
    }
    function journeys(rows, scenarios) {
        const grouped = new Map();
        for (const row of rows) {
            if (!row.scenarioId) continue;
            if (!grouped.has(row.scenarioId)) grouped.set(row.scenarioId, []);
            grouped.get(row.scenarioId).push(row);
        }
        const byId = new Map(scenarios.map(s => [s.scenarioId, s]));
        return [...grouped].map(([scenarioId, selectedRows]) => {
            const s = byId.get(scenarioId);
            const graph = selectedRows.filter(r => r.activityId);
            const graphData = s?.graphActivities?.filter(a => !a.synthetic && a.evidenceLevel !== "code-reference") ?? [];
            const strongest = [...graphData].sort((a, b) => (a.fallback?.association === "explicit-transition" ? 0 : a.fallback?.association === "same-prompt-after-failure" ? 1 : 2) - (b.fallback?.association === "explicit-transition" ? 0 : b.fallback?.association === "same-prompt-after-failure" ? 1 : 2))[0];
            const association = strongest?.fallback?.association ?? "none";
            return {
                id: identity("journey", [selectedRows[0].sourceSessionId, scenarioId]),
                scenarioId, sourceSessionId: selectedRows[0].sourceSessionId,
                workIqCallIds: unique(selectedRows.filter(r => r.activityType === "workiq").map(r => r.toolCallId).filter(Boolean)),
                graphActivityIds: graph.map(r => r.activityId),
                relatedGraphActivityIds: graphData.map(a => a.activityId),
                precedingWorkIqCallIds: unique(graphData.flatMap(a => a.fallback?.precedingWorkIqCallIds ?? [])),
                association, confidence: association === "explicit-transition" ? "medium" : "low",
                causeProven: false, selectedCount: selectedRows.length, drilldownIds: selectedRows.map(r => r.id),
                explanation: association === "same-prompt-after-failure" ? "A recorded Graph request followed a Work IQ failure in this prompt group; the cause is not proven."
                    : association === "explicit-transition" ? "Recorded text explicitly describes switching from Work IQ to Graph; this is not independent proof of cause."
                        : association === "same-prompt-sequence" ? "Work IQ and a Graph request occur in the same prompt group; fallback intent is unverified."
                            : "No evidence-grounded Work IQ-to-Graph transition was identified.",
            };
        });
    }
    function project(rows, { groupBy, limit, bucket, filters, timeContext, dateRange }, scenarios) {
        const groups = groupRows(rows, groupBy), omitted = groups.slice(limit);
        const units = unique(rows.map(row => row.countUnit));
        const nativePopulation = scenarios.some(record => record.recordKind === "native-conversation")
            || units.some(unit => unit?.startsWith("native-"));
        const omittedIds = new Set(omitted.flatMap(g => g.drilldownIds));
        const otherRows = rows.filter(r => omittedIds.has(r.id));
        const otherGroup = omitted.length ? {
            id: "group:other", key: "group:other", label: `Other (${omitted.length} groups)`,
            ...summarize(otherRows), groupCount: omitted.length,
            sharePercent: rows.length ? otherRows.length * 100 / rows.length : 0,
            drilldownIds: otherRows.map(r => r.id), queryShapes: [],
            sessionCount: unique(otherRows.map(r => r.sourceSessionId)).length,
        } : null;
        return {
            rows, calls: rows, totals: summarize(rows), coverage: coverage(rows),
            groups, visibleGroups: groups.slice(0, limit), otherGroup,
            workloadGroups: groupRows(rows, "workload"), serviceInvolvement: serviceInvolvement(rows, filters),
            timeSeries: timeline(rows, bucket, timeContext, filters, dateRange),
            journeys: journeys(rows, scenarios),
            unitPopulations: nativePopulation ? units.map(unit => {
                const members = rows.filter(row => row.countUnit === unit);
                return { unit, rowIds: members.map(row => row.id), totals: summarize(members) };
            }) : null,
            measurementEligibility: nativePopulation ? {
                outcomeRate: units.length > 1 ? "separate-unit-populations-only" : "selected-unit-population",
                nativeActivityDates: rows.some(row => row.countUnit?.startsWith("native-") && row.startedAt)
                    ? "source-observation-qualified" : "unqualified",
                nativeServiceTargets: "unqualified", nativeResponseLatency: "unsupported",
                nativeToolTiming: "observation-specific-boundaries-only",
            } : null,
        };
    }
    function apiCoverage(calls, rows) {
        const withResults = calls.filter(call => call.resultIds.length).length;
        const withStatus = calls.filter(call => call.numericStatusIds.length).length;
        return {
            scope: "source/project/tool/date/service scope before API-result endpoint/outcome filters; supported call or returned-target associations qualify the parent once; discovery uses only returned service evidence, never schema arguments",
            calls, eligibleToolCalls: calls.length, callsWithReportedResults: withResults, callsWithoutReportedResults: calls.length - withResults,
            callsWithNumericStatus: withStatus, callsWithoutNumericStatus: calls.length - withStatus,
            returnedResultUnits: calls.reduce((sum, call) => sum + call.resultIds.length, 0), selectedResultUnits: rows.length,
            selectedResultUnitsWithNumericStatus: rows.filter(row => validStatus(row.status)).length,
        };
    }
    function narrowPopulation(base, scenarioIds, rows, records) {
        const fail = () => { throw new TypeError("Population refinement requires accepted identities, rows and native count data; it cannot expand membership."); };
        const ids = values => {
            if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value)
                || new Set(values).size !== values.length) fail();
            return new Set(values);
        };
        if (!base || !base.coverage || !Array.isArray(rows) || !Array.isArray(records)) fail();
        const accepted = ids(base.scenarioIds), acceptedRows = ids(base.rowIds), nativeIds = ids(base.nativeConversationKeys);
        const chosen = ids(scenarioIds), unknown = ids(base.coverage.unknownSourceScenarioIds), units = ids(base.units);
        if (!Array.isArray(base.rowScenarioIds) || base.rowScenarioIds.length !== base.rowIds.length
            || base.rowScenarioIds.some(id => id !== null && (typeof id !== "string" || !id))
            || !Array.isArray(base.rowUnits) || base.rowUnits.length !== base.rowIds.length
            || base.rowUnits.some(unit => !units.has(unit))) fail();
        const rowBindings = new Map(base.rowIds.map((id, index) => [id, {
            scenarioId: base.rowScenarioIds[index], unit: base.rowUnits[index],
        }]));
        const context = ids(base.contextOnlyScenarioIds === undefined ? [] : base.contextOnlyScenarioIds);
        const dates = ids(base.coverage.messageCreationDateScenarioIds === undefined ? [] : base.coverage.messageCreationDateScenarioIds);
        const recordMap = new Map(records.map(record => [record.scenarioId, record]));
        const measuredParents = new Set(rows.map(row => row.scenarioId));
        ids(rows.map(row => row.id));
        if ([...chosen].some(id => !accepted.has(id) || !recordMap.has(id))
            || [...nativeIds, ...unknown].some(id => !accepted.has(id))
            || [...context, ...dates].some(id => !nativeIds.has(id))
            || [...context].some(id => !dates.has(id) || measuredParents.has(id))
            || context.size && base.contextDateBasis !== "ordinary-message-created"
            || base.coverage.messageCreationDatesAvailable !== undefined
                && base.coverage.messageCreationDatesAvailable !== Boolean(dates.size)
            || rows.some(row => !acceptedRows.has(row.id)
                || rowBindings.get(row.id).scenarioId !== (row.scenarioId ?? null)
                || accepted.has(row.scenarioId) && !chosen.has(row.scenarioId))) fail();
        const unitFor = row => row.countUnit ?? (units.size === 1 ? [...units][0] : undefined);
        if (rows.some(row => !units.has(unitFor(row)) || rowBindings.get(row.id).unit !== unitFor(row))) fail();
        const selectedIds = base.scenarioIds.filter(id => chosen.has(id));
        const selectedNativeIds = base.nativeConversationKeys.filter(id => chosen.has(id));
        if (selectedIds.some(id => (recordMap.get(id).recordKind === "native-conversation") !== nativeIds.has(id))) fail();
        const native = selectedNativeIds.map(id => recordMap.get(id).nativeConversation);
        if (native.some(record => !record || ["messages", "calls", "taskOutcomes", "resultReferences"]
            .some(name => !Array.isArray(record[name])))) fail();
        if (selectedIds.some(id => !measuredParents.has(id) && !context.has(id)
            && !(nativeIds.has(id) && !recordMap.get(id).nativeConversation.calls.length))) fail();
        const messageCreationDateScenarioIds = [...dates].filter(id => chosen.has(id));
        return {
            ...base, scenarioIds: selectedIds, rowIds: rows.map(row => row.id),
            rowScenarioIds: rows.map(row => row.scenarioId ?? null), rowUnits: rows.map(unitFor),
            contextOnlyScenarioIds: [...context].filter(id => chosen.has(id)),
            nativeConversationKeys: selectedNativeIds, units: unique(rows.map(unitFor)),
            native: {
                conversations: native.length,
                messageRepresentationObservations: native.reduce((n, record) => n + record.messages.filter(message => !message.parentObservationKey).length, 0),
                messagePartViews: native.reduce((n, record) => n + record.messages.filter(message => message.parentObservationKey).length, 0),
                noToolConversations: native.filter(record => !record.calls.length).length,
                taskOutcomeObservations: native.reduce((n, record) => n + record.taskOutcomes.length, 0),
                resultReferenceObservations: native.reduce((n, record) => n + record.resultReferences.length, 0),
            },
            coverage: {
                ...base.coverage, unknownSourceScenarioIds: [...unknown].filter(id => chosen.has(id)),
                messageCreationDateScenarioIds, messageCreationDatesAvailable: messageCreationDateScenarioIds.length > 0,
            },
        };
    }
    return { summarize, groupRows, knownServiceMatch, serviceSelected, selected, project, apiCoverage, narrowPopulation, calendarBuckets };
}
