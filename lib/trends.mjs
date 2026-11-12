import { buildAnalyticsRows } from "./analytics.mjs";
import { projectPromptOrigins } from "./activity-analytics.mjs";
import { projectInteractionModels } from "./interaction-model.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { serviceCategories } from "./service-categories.mjs";
import { classifyWorkload } from "./graph-history.mjs";
import { projectReportResultObservation, reportObservationHasError } from "./report-result-facts.mjs";
import { createCollectionStatus } from "./collection-status.mjs";
import { BoardError, mergeEvidenceWithState } from "./store.mjs";
import { time } from "./time.mjs";

const families = ["authors", "tools", "services", "problems", "timing", "models", "rhythm"];
const unique = values => [...new Set(values)];
const percent = (count, eligible) => eligible ? count * 100 / eligible : null;
const dayNumber = day => Date.parse(`${day}T00:00:00Z`) / 86400000;
const quantile = (values, fraction) => values.length ? values[Math.max(0, Math.ceil(values.length * fraction) - 1)] : null;

export function validateTrendsInput(input) {
    const object = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).every(key => keys.includes(key));
    if (!object(input, ["expectedRevision", "from", "to", "timeContext", "filters", "offset"])
        || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || !object(input.filters, ["author", "tool", "service"])
        || input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0)) {
        throw new BoardError("Trends requires a current stored revision, dates and supported filters.", 422);
    }
    try {
        time.calendar(input.from); time.calendar(input.to); time.normalize(input.timeContext);
        time.range({ from: input.from, to: input.to }, input.timeContext.timeZone);
    } catch (error) { throw new BoardError(error.message, 422); }
    if (input.from > input.to) throw new BoardError("Start date must not follow end date.", 422);
    if (input.filters.author !== undefined && !promptAuthorship.actors.includes(input.filters.author)
        || input.filters.tool !== undefined && (typeof input.filters.tool !== "string" || input.filters.tool.length > 100)
        || input.filters.service !== undefined && ![...serviceCategories.entries.map(entry => entry.id), "missing"].includes(input.filters.service)) {
        throw new BoardError("Choose supported prompt authors, tools and services.", 422);
    }
    return input;
}

function instant(value) {
    if (typeof value !== "string") return null;
    try { return new Date(time.instant(value)).toISOString(); }
    catch (error) { if (error instanceof RangeError) return null; throw error; }
}

function memberValue(id, label, rows, eligible, unit) {
    const origins = unique(rows.map(row => row.originId));
    const count = unit === "interaction" ? origins.length : rows.length;
    return {
        id, label, count, eligible, percent: percent(count, eligible),
        calls: rows.length, interactions: origins.length,
        rowIds: rows.map(row => row.id), scenarioIds: unique(rows.map(row => row.scenarioId)),
    };
}

function summarize(rows, definitions) {
    const origins = new Map(rows.map(row => [row.originId, row]));
    const samples = rows.map(row => row.durationMs).filter(value => value !== null).sort((a, b) => a - b);
    const parents = origins.size, missingModels = [...origins.values()].filter(row => !row.models.length).length;
    const values = {
        authors: definitions.authors.map(({ id, label }) => memberValue(id, label, rows.filter(row => row.author === id), parents, "interaction")),
        tools: definitions.tools.map(({ id, label }) => {
            const value = memberValue(id, label, rows.filter(row => row.tool === id), rows.length, "call");
            return { ...value, reach: percent(value.interactions, parents), reachEligible: parents };
        }),
        services: definitions.services.map(({ id, label }) => {
            const selected = rows.filter(row => row.services.includes(id));
            return { ...memberValue(id, label, selected, rows.length, "call"),
                also: selected.filter(row => row.services.length > 1).length };
        }),
        models: definitions.models.map(({ id, label }) => {
            const selected = rows.filter(row => row.models.includes(id));
            return { ...memberValue(id, label, selected, parents, "interaction"), missing: missingModels,
                also: unique(selected.filter(row => row.models.length > 1).map(row => row.originId)).length };
        }),
    };
    const errors = rows.filter(row => row.error);
    values.problems = [{ ...memberValue("problems", "Errors & failures", errors, parents, "interaction"),
        failedCalls: rows.filter(row => row.outcome === "failure").length,
        apiErrorCalls: rows.filter(row => row.apiError).length,
        unknownCalls: rows.filter(row => row.outcome === "unknown").length }];
    values.timing = [{
        ...memberValue("timing", "Tool latency", rows.filter(row => row.durationMs !== null), rows.length, "call"),
        medianMs: quantile(samples, .5), p95Ms: quantile(samples, .95),
    }];
    values.rhythm = [memberValue("rhythm", "Call activity", rows, rows.length, "call")];
    return {
        calls: rows.length, interactions: parents, timedCalls: samples.length, missingModels,
        timingCoverage: percent(samples.length, rows.length), modelMissingShare: percent(missingModels, parents),
        serviceMissingShare: percent(rows.filter(row => row.serviceGaps).length, rows.length),
        modelCoverage: Object.fromEntries(["recorded", "partial", "unavailable", "unverified", "conflicting"]
            .map(status => [status, [...origins.values()].filter(row => row.modelStatus === status).length])),
        missingServices: rows.filter(row => row.serviceGaps).length,
        preparationCalls: rows.filter(row => row.preparation).length,
        values,
    };
}

function suggest(days, definitions) {
    const candidates = [];
    for (const family of families.filter(value => !["timing", "rhythm"].includes(value))) {
        for (const definition of definitions[family]) {
            const observed = days.flatMap(day => {
                const value = day.values[family].find(value => value.id === definition.id);
                const eligible = family === "tools" ? value.reachEligible : value.eligible;
                const fraction = family === "tools" ? value.reach : value.percent;
                return day.complete && eligible >= 5 && fraction !== null ? [{ date: day.date, value, fraction }] : [];
            });
            if (observed.length < 3) continue;
            const first = observed[0], last = observed.at(-1), difference = last.fraction - first.fraction;
            if (Math.abs(difference) < 5) continue;
            candidates.push({ family, id: definition.id, first, last, difference, unit: "percentage-points" });
        }
    }
    candidates.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference) || families.indexOf(a.family) - families.indexOf(b.family) || a.id.localeCompare(b.id));
    const chosen = [];
    for (const candidate of candidates) if (!chosen.some(value => value.family === candidate.family)) {
        chosen.push(candidate);
        if (chosen.length === 3) break;
    }
    return chosen;
}

// Reads only the accepted retained revision. No source scanning or provider work.
export function buildTrends(state, input, { records = mergeEvidenceWithState(state), now = new Date().toISOString() } = {}) {
    validateTrendsInput(input);
    if (state.revision !== input.expectedRevision) throw new BoardError("Stored activity changed. Read the current view before opening Trends.", 409);
    if (state.deletion?.pending) throw new BoardError("Local cleanup must finish before reading Trends.", 409);
    const context = time.normalize(input.timeContext), today = time.day(now, context.timeZone);
    const source = projectPromptOrigins(records.filter(record => record.recordKind !== "native-conversation"
        && ["copilot-app", "copilot-app-chat"].includes(record.sourceHost)));
    const projected = projectInteractionModels(source), byId = new Map(projected.map(record => [record.scenarioId, record]));
    const rawCalls = new Map(source.map(record => [record.scenarioId, record.toolCalls ?? []]));
    const canonical = buildAnalyticsRows(source, { layer: "tool", filters: { scope: "all" } })
        .filter(row => classifyWorkload(row.endpoint, row.tool, row.targets ?? []) !== "Platform metadata");
    const owners = new Set(canonical.map(row => row.scenarioId)), origins = new Map();
    for (const record of projected.filter(record => owners.has(record.scenarioId))) {
        const key = promptAuthorship.interactionIdentity(record), author = promptAuthorship.read(record.userPrompt).actor;
        const prior = origins.get(key);
        origins.set(key, prior && prior !== author ? "unknown" : author);
    }
    const prepared = canonical.map(row => {
        const record = byId.get(row.scenarioId), raw = rawCalls.get(row.scenarioId).find(call => row.toolCallId
            ? call.toolCallId === row.toolCallId : call.startEventId && row.id === `event:${JSON.stringify([row.sourceSessionId, call.startEventId])}`);
        if (!raw) throw new BoardError("Canonical Trends evidence is unavailable.", 409);
        const startedAt = instant(raw.startedAt), completedAt = instant(raw.completedAt);
        const services = serviceCategories.associate(row, "tool", classifyWorkload);
        const observation = projectReportResultObservation("trends", {
            resultEvidence: raw.resultEvidence, diagnostic: raw.failureEvidence?.diagnostic,
            legacyFailure: raw.failureEvidence, returnedEntries: raw.apiResults ?? null,
        });
        const apiError = reportObservationHasError(projectReportResultObservation("trends-result", {
            resultEvidence: raw.resultEvidence, returnedEntries: raw.apiResults ?? null,
        })), originId = promptAuthorship.interactionIdentity(record);
        return {
            id: row.id, scenarioId: row.scenarioId, originId, startedAt, operation: row.endpoint.label,
            date: startedAt ? time.day(startedAt, context.timeZone) : null,
            tool: row.tool, author: origins.get(originId), services: services.services,
            serviceGaps: services.gaps.length > 0, preparation: services.status === "not-applicable",
            models: record.originalModel.models, modelStatus: record.originalModel.status,
            outcome: row.outcome, apiError, error: row.outcome === "failure" || reportObservationHasError(observation),
            durationMs: startedAt && completedAt && Number.isFinite(raw.durationMs) && raw.durationMs >= 0
                && Date.parse(completedAt) - Date.parse(startedAt) === raw.durationMs ? raw.durationMs : null,
        };
    });
    const tools = unique(prepared.map(row => row.tool)).sort();
    if (input.filters.tool !== undefined && !tools.includes(input.filters.tool)) throw new BoardError("The chosen tool is not in this retained view.", 422);
    const eligible = prepared.filter(row => (!input.filters.author || row.author === input.filters.author)
        && (!input.filters.tool || row.tool === input.filters.tool)
        && (!input.filters.service || (input.filters.service === "missing" ? row.serviceGaps
            : input.filters.service === "Discovery" ? row.preparation : row.services.includes(input.filters.service))));
    const rows = eligible.filter(row => row.date && row.date >= input.from && row.date <= input.to);
    const definitions = {
        authors: promptAuthorship.actors.map(id => ({ id, label: promptAuthorship.selectionLabel([id]) })),
        tools: tools.map(id => ({ id, label: id.replace(/^workiq-/, "") })),
        services: serviceCategories.entries.filter(entry => prepared.some(row => row.services.includes(entry.id))).map(({ id, label }) => ({ id, label })),
        models: unique(prepared.flatMap(row => row.models)).sort().map(id => ({ id, label: id })),
        problems: [{ id: "problems", label: "Errors & failures" }], timing: [{ id: "timing", label: "Tool latency" }],
        rhythm: [{ id: "rhythm", label: "Call activity" }],
    };
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.date)) grouped.set(row.date, []);
        grouped.get(row.date).push(row);
    }
    const observed = [...grouped].sort(([a], [b]) => a.localeCompare(b))
        .map(([date, members]) => ({ date, complete: date < today, ...summarize(members, definitions) }));
    const totalDays = dayNumber(input.to) - dayNumber(input.from) + 1, offset = input.offset ?? 0;
    if (offset >= totalDays) throw new BoardError("This date page is outside the chosen period.", 422);
    const byDate = new Map(observed.map(day => [day.date, day]));
    const days = Array.from({ length: Math.min(90, totalDays - offset) }, (_, index) => {
        const date = time.addDays(input.from, offset + index);
        return byDate.get(date) ?? { date, complete: date < today, ...summarize([], definitions) };
    });
    const totals = summarize(rows, definitions), weekCounts = new Map();
    for (const [date, members] of grouped) {
        const start = time.bucketDate(time.midnight(date, context.timeZone), "week", context.timeZone);
        weekCounts.set(start, (weekCounts.get(start) ?? 0) + members.length);
    }
    for (const day of days) {
        const start = time.bucketDate(time.midnight(day.date, context.timeZone), "week", context.timeZone);
        const weekCount = weekCounts.get(start) ?? 0;
        day.values.rhythm[0].eligible = weekCount;
        day.values.rhythm[0].percent = percent(day.calls, weekCount);
    }
    const roster = state.importCoverage?.roster;
    const history = roster ? createCollectionStatus().coverage(roster, roster, source.map(record => record.sourceSessionId)) : null;
    const partial = Boolean(history?.summary.affected || history?.summary.pending);
    return {
        kind: "retained-trends", schemaVersion: 1, revision: state.revision,
        from: input.from, to: input.to, timeContext: context, filters: { ...input.filters },
        window: { offset, totalDays, count: days.length }, definitions, totals, days,
        members: rows.map(({ id, scenarioId, tool, operation, date }) => ({ id, scenarioId, tool, operation, date })),
        suggestions: partial ? [] : suggest(observed, definitions), suggestionPolicy: "observed-share-change-v1",
        coverage: { undatedCalls: eligible.filter(row => !row.date).length,
            history: partial ? "partial" : "not-established" },
    };
}
