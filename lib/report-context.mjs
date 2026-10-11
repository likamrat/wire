import { createHmac } from "node:crypto";
import { createRequestContext } from "../web/request-context.mjs";
import { promptAuthorship } from "./prompt-authorship.mjs";
import { BoardError } from "./store.mjs";
import { REPORT_CONTEXT_BOUNDARY, REPORT_CONTEXT_LIMITATION, REPORT_CONTEXT_LIMITS } from "./report-context-shape.mjs";
import { buildAssessmentModel, assessmentSource, assessmentHash } from "./assessment-read-model.mjs";
import { readRetainedResponse } from "./assessment.mjs";
import { collectorFor } from "./collector.mjs";
import { projectReportCopy } from "./prompt-projection.mjs";
import { retainedPromptStatus, scanTree } from "./privacy.mjs";
import { activityDeletionVersion } from "./deletion-identities.mjs";

const selector = createRequestContext();
const eligibleSource = scenario => ["copilot-app", "copilot-app-chat"].includes(scenario.sourceHost)
    && typeof scenario.sourceSessionId === "string" && scenario.sourceSessionId.length > 0
    && scenario.sample !== true && scenario.synthetic !== true && scenario.evidenceLayer !== "synthetic-http-fixture"
    && scenario.workloadKind !== "public-metadata-demonstration";

export function reportPromptAllowed(records, scenario, prompt, authors) {
    const origins = scenario.sourceSessionId && typeof prompt?.sourceEventId === "string" && prompt.sourceEventId
        ? records.filter(record => record.sourceSessionId === scenario.sourceSessionId
            && record.userPrompt?.sourceEventId === prompt.sourceEventId) : [];
    if (!origins.length) return authors.includes("unknown") && authors.includes(promptAuthorship.read(prompt).actor);
    if (origins.some(record => !eligibleSource(record))) return false;
    const actors = new Set(origins.map(record => promptAuthorship.read(record.userPrompt).actor));
    return authors.includes(actors.size === 1 ? [...actors][0] : "unknown");
}

export function proposeReportContext(records, selected, authors) {
    if (!promptAuthorship.validSelection(authors)) throw new BoardError("Choose supported report context authors.", 422);
    authors = promptAuthorship.selection(authors);
    const allowed = scenario => authors.includes(promptAuthorship.read(scenario.userPrompt).actor);
    const anchors = selected.map(record => {
        const context = selector.select(records, record.scenarioId);
        const eligible = context.groups.filter(group => eligibleSource(group.scenario));
        const groups = eligible.filter(group => allowed(group.scenario));
        const ids = new Set(groups.map(group => group.scenario.scenarioId));
        const messages = context.messages.filter(message => ids.has(message.scenarioId)
            && (message.kind !== "follow-up" || reportPromptAllowed(records, record, message.source, authors)));
        return { ...context, groups, messages, authorExcludedGroups: eligible.length - groups.length,
            sourceExcludedGroups: context.groups.length - eligible.length,
            authorExcludedMessages: context.messages.filter(message => ids.has(message.scenarioId)).length - messages.length };
    });
    return { anchors };
}

export function reportDisclosureRecords(records, selected, authors) {
    if (!authors) return selected;
    return selected.map(scenario => ({ ...scenario, followUpPrompts: (scenario.followUpPrompts ?? []).map(prompt =>
        reportPromptAllowed(records, scenario, prompt, authors) ? prompt : {
            status: "unavailable", text: null, reportAuthorExcluded: true,
            authorship: { actor: "unknown", basis: "missing-source" },
        }) }));
}

export const reportContextRef = (key, kind, value) => value == null ? null
    : `${kind}-${createHmac("sha256", key).update(`${kind}:${value}`).digest("hex").slice(0, 16)}`;
export const reportContextSource = (session, state) =>
    collectorFor(session)?.assessmentSource(state) ?? state.personalEvaluation?.source ?? assessmentSource(state);
const messageIdentity = (scenario, prompt) => typeof scenario.sourceSessionId === "string" && scenario.sourceSessionId
    && typeof prompt?.sourceEventId === "string" && prompt.sourceEventId
    ? JSON.stringify([scenario.sourceSessionId, prompt.sourceEventId]) : null;

export async function collectReportContext(session, state, records, selected, authors) {
    const proposal = proposeReportContext(records, selected, authors);
    const source = reportContextSource(session, state);
    const groups = new Map(proposal.anchors.flatMap(anchor => anchor.groups.map(group => [group.scenario.scenarioId, group.scenario])));
    const model = buildAssessmentModel(state, { source });
    const id = (kind, value) => reportContextRef(state.pseudonymKey, kind, value);
    const selectedIds = new Set(selected.map(record => record.scenarioId));
    const sources = new Map(), identities = new Map(), observations = new Map(), groupGaps = new Map(), groupKeys = new Map();
    let sourceBytes = 0;
    function addSource(entry) {
        if (sources.has(entry.key)) throw new BoardError("Recorded context has conflicting copy identities. Narrow the report.", 422);
        sourceBytes += Buffer.byteLength(entry.original ?? "");
        if (sources.size >= REPORT_CONTEXT_LIMITS.entries || sourceBytes > REPORT_CONTEXT_LIMITS.bytes) {
            throw new BoardError("Report context exceeds the 3000-copy or 4 MiB UTF-8 text budget. Narrow the selection.", 422);
        }
        sources.set(entry.key, entry);
    }
    const selectedMessages = new Map();
    for (const scenario of [...selected].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))) {
        const scenarioRef = id("scenario", scenario.scenarioId);
        const original = messageIdentity(scenario, scenario.userPrompt);
        if (original && !selectedMessages.has(original)) selectedMessages.set(original, `${scenarioRef}:origin`);
    }
    for (const scenario of [...selected].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))) {
        for (const [index, prompt] of (scenario.followUpPrompts ?? []).entries()) {
            const identity = messageIdentity(scenario, prompt);
            if (identity && !selectedMessages.has(identity)) selectedMessages.set(identity, `${id("scenario", scenario.scenarioId)}:followup:${index}`);
        }
    }
    function addMessage(scenario, prompt, kind, fallbackKey) {
        const identity = messageIdentity(scenario, prompt);
        const key = selectedMessages.get(identity) ?? fallbackKey;
        const status = retainedPromptStatus({ status: prompt?.status ?? "unavailable", text: prompt?.text });
        const original = status === "unavailable" || typeof prompt?.text !== "string" ? null : prompt.text;
        if (identity && identities.has(identity)) {
            const existing = sources.get(identities.get(identity));
            if (existing.original !== original || existing.status !== status || existing.at !== (prompt?.sourceTimestamp ?? null)) {
                throw new BoardError("Linked copies of a recorded message conflict. Narrow the report rather than substituting text.", 422);
            }
            return existing.key;
        }
        const entry = { key, scenarioRef: id("scenario", scenario.scenarioId), eventRef: id("event", identity),
            observationRef: null, kind, at: prompt?.sourceTimestamp ?? null, status,
            original,
            label: kind === "prompt" ? "Recorded prompt" : "Recorded follow-up",
            authorship: promptAuthorship.read(prompt), originKind: promptAuthorship.originKind(scenario, prompt), finality: null };
        addSource(entry);
        if (identity) identities.set(identity, key);
        return key;
    }
    // Originating records own their retained message; linked follow-up copies reuse it.
    for (const scenario of groups.values()) groupKeys.set(scenario.scenarioId, [addMessage(scenario, scenario.userPrompt, "prompt",
        `${id("scenario", scenario.scenarioId)}:${selectedIds.has(scenario.scenarioId) ? "origin" : "context-origin"}`)]);
    for (const anchor of proposal.anchors) for (const message of anchor.messages.filter(message => message.kind === "follow-up")) {
        const scenario = groups.get(message.scenarioId);
        const index = scenario.followUpPrompts.indexOf(message.source);
        addMessage(scenario, message.source, "follow-up", `${id("scenario", scenario.scenarioId)}:followup:${index}`);
    }
    for (const scenario of groups.values()) {
        const scenarioRef = id("scenario", scenario.scenarioId), gaps = [];
        groupGaps.set(scenario.scenarioId, gaps);
        const catalog = model.catalog.find(item => item.scenarioId === scenario.scenarioId);
        const view = catalog?.interactionRefs?.length === 1 ? model.details.get(catalog.interactionRefs[0]) : null;
        const answers = view?.observations.filter(observation => observation.kind === "answer" && observation.availability === "available") ?? [];
        if (!answers.length) {
            gaps.push("A recorded reply is missing or no longer authorized for this group; no text was reconstructed.");
            const key = `${scenarioRef}:context-response-unavailable`;
            addSource({ key, scenarioRef, eventRef: null, observationRef: null, kind: "response", at: null,
                status: "unavailable", original: null, label: "Recorded reply", finality: "unverified" });
            groupKeys.get(scenario.scenarioId).push(key);
        }
        for (const answer of answers) {
            if (observations.has(answer.observationRef)) {
                groupKeys.get(scenario.scenarioId).push(observations.get(answer.observationRef));
                continue;
            }
            const key = `${scenarioRef}:context-response:${answer.observationRef}`;
            let response;
            try { response = await readRetainedResponse(session, state, view, answer.observationRef); }
            catch (error) {
                if (!(error instanceof BoardError) || ![403, 404].includes(error.status)) throw error;
                gaps.push(error.status === 403 ? "A recorded reply is no longer authorized; its text is excluded."
                    : "A retained reply file is missing; its text is unavailable.");
            }
            addSource({ key, scenarioRef, eventRef: null, observationRef: answer.observationRef, kind: "response",
                at: answer.occurredAt, original: response?.text ?? null,
                status: !response ? "unavailable" : response.completeness === "full-record" ? "full" : "partial",
                label: "Recorded reply", finality: "unverified" });
            observations.set(answer.observationRef, key);
            groupKeys.get(scenario.scenarioId).push(key);
        }
    }
    const anchors = proposal.anchors.map(anchor => {
        const contextGroups = anchor.groups.map(group => {
            const scenario = group.scenario;
            const keys = [...groupKeys.get(scenario.scenarioId)];
            if (group.relation === "selected") for (const message of anchor.messages.filter(message => message.kind === "follow-up")) {
                const identity = messageIdentity(scenario, message.source);
                const key = identity ? identities.get(identity) : `${id("scenario", scenario.scenarioId)}:followup:${scenario.followUpPrompts.indexOf(message.source)}`;
                if (key) keys.push(key);
            }
            return { scenarioRef: id("scenario", scenario.scenarioId), relation: group.relation, entryKeys: [...new Set(keys)] };
        });
        const entryKeys = [...new Set(contextGroups.flatMap(group => group.entryKeys))]
            .sort((left, right) => selector.compare(sources.get(left), sources.get(right)));
        return { scenarioRef: id("scenario", anchor.anchorId), groups: contextGroups, entryKeys,
            authorExcludedGroups: anchor.authorExcludedGroups,
            gaps: [...anchor.gaps, ...(anchor.authorExcludedGroups ? ["Linked context groups excluded by originating prompt author choice; their text is not disclosed."] : []),
                ...(anchor.sourceExcludedGroups ? ["Linked context excluded by existing report source-eligibility rules; its content is not disclosed."] : []),
                ...(anchor.authorExcludedMessages ? ["Recorded follow-up text excluded by originating prompt author choice; no copy is disclosed."] : []),
                ...new Set(anchor.groups.flatMap(group => groupGaps.get(group.scenario.scenarioId)))] };
    });
    const entries = [...sources.values()];
    const dependencies = createHmac("sha256", state.pseudonymKey).update(JSON.stringify([
        [...groups.values()], anchors, entries.map(({ original, ...entry }) => ({ ...entry, textHash: assessmentHash(original ?? "") })),
        source, state.personalEvaluation?.consent, activityDeletionVersion(state), state.deletion?.identities,
    ])).digest("hex");
    return { anchors, entries, dependencies };
}

export function projectReportContext(collected, options, selectedReview) {
    if (!collected) return null;
    const selected = new Map(selectedReview.map(entry => [entry.key, entry]));
    if (selected.size !== selectedReview.length || new Set(collected.entries.map(entry => entry.key)).size !== collected.entries.length) {
        throw new BoardError("Report copies have duplicate identities. Prepare a fresh selection.", 422);
    }
    const review = collected.entries.map(entry => {
        const { at, ...copySource } = entry;
        const source = selected.get(entry.key);
        if (source && (source.original !== entry.original || source.status !== entry.status)) {
            throw new BoardError("Linked copies of a recorded message conflict. Narrow the report rather than substituting text.", 422);
        }
        const copy = source ?? projectReportCopy(copySource, options);
        const { original, ...metadata } = copySource;
        return { ...copy, ...metadata, original: copy.original,
            timeStatus: typeof at === "string" && Number.isFinite(Date.parse(at)) ? "recorded" : "unknown" };
    });
    const entries = review.map(({ original, segments, edited, at, ...entry }) => entry);
    const coverage = { groups: new Set(collected.anchors.flatMap(anchor => anchor.groups.map(group => group.scenarioRef))).size,
        entries: entries.length, included: entries.filter(entry => entry.text !== null).length,
        omitted: entries.filter(entry => entry.omitted).length, unavailable: entries.filter(entry => entry.status === "unavailable").length,
        partial: entries.filter(entry => entry.status === "partial").length,
        authorExcludedGroups: collected.anchors.reduce((sum, anchor) => sum + anchor.authorExcludedGroups, 0),
        sourceBytes: review.reduce((sum, entry) => sum + Buffer.byteLength(entry.original ?? ""), 0),
        projectedBytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(entry.text ?? ""), 0) };
    const copies = new Map([...selectedReview, ...review].map(entry => [entry.key, entry]));
    if (copies.size > REPORT_CONTEXT_LIMITS.entries || [...copies.values()].some(entry => typeof entry.original !== "string" && entry.original !== null)
        || [...copies.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.original ?? ""), 0) > REPORT_CONTEXT_LIMITS.bytes
        || [...copies.values()].reduce((sum, entry) => sum + Buffer.byteLength(entry.text ?? ""), 0) > REPORT_CONTEXT_LIMITS.bytes) {
        throw new BoardError("Selected and contextual copies exceed the 3000-copy or 4 MiB UTF-8 text budget. Narrow the report.", 422);
    }
    return { frozen: { schemaVersion: 1, boundary: REPORT_CONTEXT_BOUNDARY, limitation: REPORT_CONTEXT_LIMITATION,
        anchors: collected.anchors, entries, coverage },
        review: review.filter(entry => !selected.has(entry.key)),
        scan: scanTree(review.filter(entry => !selected.has(entry.key)).map(entry => entry.original)) };
}
