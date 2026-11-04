import { BoardError } from "./store.mjs";
import { OFFICE_WORKLOADS } from "./graph-history.mjs";
import { time } from "./time.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { retainedSourceIds } from "./retained-population.mjs";

export const TIME_CONTEXT_SCHEMA = {
    type: "object", additionalProperties: false, required: ["timeZone", "locale"],
    properties: {
        timeZone: { type: "string", maxLength: 100 }, locale: { type: "string", maxLength: 80 },
        timeZoneFallback: { type: "boolean" }, localeFallback: { type: "boolean" },
    },
};

const LAYERS = ["tool", "reported-api", "http", "direct-request", "recorded-http", "code-reference"];
const GROUPS = ["endpoint", "tool", "workload", "service"];
const ACTIVITY_TYPES = ["workiq", "direct-request", "recorded-http", "captured-http", "code-reference"];

const stringList = { type: "array", maxItems: 500, items: { type: "string", maxLength: 1000 } };
export const ANALYTICS_SCHEMA = {
    type: "object", additionalProperties: false,
    properties: {
        timeContext: TIME_CONTEXT_SCHEMA,
        layer: { enum: LAYERS },
        groupBy: { enum: GROUPS },
        bucket: { enum: ["day", "week", "month"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        filters: {
            type: "object", additionalProperties: false,
            properties: {
                scope: { enum: ["history", "legacy", "all"] },
                sources: { type: "array", maxItems: 3, uniqueItems: true, items: { enum: retainedSourceIds() } },
                sourceSessionIds: stringList, endpoints: stringList, tools: stringList,
                workloads: { type: "array", maxItems: 20, items: { enum: OFFICE_WORKLOADS } },
                services: { type: "array", maxItems: 20, items: { enum: OFFICE_WORKLOADS } },
                activityTypes: { type: "array", maxItems: 5, items: { enum: ACTIVITY_TYPES } },
                includeMetadata: { type: "boolean" },
                includeMissingService: { type: "boolean" },
                projectIds: { type: "array", maxItems: 500, items: { type: ["string", "null"], maxLength: 1000 } },
                outcomes: { type: "array", items: { enum: ["success", "failure", "unknown", "partial", "other", "transport"] } },
                promptAuthors: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { enum: promptAuthorship.actors } },
                from: { type: "string", maxLength: 64 }, to: { type: "string", maxLength: 64 },
            },
        },
    },
};

export function validateAnalyticsInput(input) {
    const invalid = () => { throw new BoardError("Invalid analytics filters. Choose a supported layer/grouping and bounded filter values."); };
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid();
    if (Object.keys(input).some((key) => !Object.hasOwn(ANALYTICS_SCHEMA.properties, key))) invalid();
    try { time.normalize(input.timeContext); } catch { invalid(); }
    if (input.layer !== undefined && !LAYERS.includes(input.layer)) invalid();
    if (input.groupBy !== undefined && !GROUPS.includes(input.groupBy)) invalid();
    if (input.bucket !== undefined && !["day", "week", "month"].includes(input.bucket)) invalid();
    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) invalid();
    if (input.filters !== undefined) {
        const filters = input.filters;
        if (!filters || typeof filters !== "object" || Array.isArray(filters) || Object.keys(filters).some((key) => !Object.hasOwn(ANALYTICS_SCHEMA.properties.filters.properties, key))) invalid();
        if (filters.scope !== undefined && !["history", "legacy", "all"].includes(filters.scope)) invalid();
        if (filters.sources !== undefined && (!Array.isArray(filters.sources) || filters.sources.length > 3
            || new Set(filters.sources).size !== filters.sources.length || filters.sources.some(value => !retainedSourceIds().includes(value)))) invalid();
        for (const key of ["sourceSessionIds", "endpoints", "tools", "projectIds", "outcomes", "workloads", "services", "activityTypes"]) {
            if (filters[key] === undefined) continue;
            if (!Array.isArray(filters[key]) || filters[key].length > 500 || filters[key].some((value) => !(key === "projectIds" && value === null) && (typeof value !== "string" || value.length > 1000))) invalid();
        }
        if (filters.outcomes?.some((value) => !["success", "failure", "unknown", "partial", "other", "transport"].includes(value))) invalid();
        if (!promptAuthorship.validSelection(filters.promptAuthors)) invalid();
        if (filters.workloads?.length > 20 || filters.services?.length > 20 || filters.activityTypes?.length > 5) invalid();
        if (filters.workloads?.some((value) => !OFFICE_WORKLOADS.includes(value)) || filters.services?.some((value) => !OFFICE_WORKLOADS.includes(value))) invalid();
        if (filters.activityTypes?.some((value) => !ACTIVITY_TYPES.includes(value))) invalid();
        if (filters.includeMetadata !== undefined && typeof filters.includeMetadata !== "boolean") invalid();
        if (filters.includeMissingService !== undefined && typeof filters.includeMissingService !== "boolean") invalid();
        try { time.range(filters, time.normalize(input.timeContext).timeZone); } catch { invalid(); }
    }
    return input;
}
