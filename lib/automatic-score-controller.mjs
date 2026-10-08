import { randomBytes } from "node:crypto";
import { BoardError, exclusiveBoard, loadBoardState } from "./store.mjs";
import { defaultPersonalEvaluation, validatePersonalEvaluation } from "./personal-evaluation.mjs";
import { defaultModelEvaluationState } from "./model-evaluation-state.mjs";
import { defaultAutomaticScoreState, automaticRuns, automaticUsage } from "./automatic-score-store.mjs";
import { AUTOMATIC_SCORE_METHOD, validateAutomaticScoreApproval, planAutomaticScore, automaticInteractionKey } from "./automatic-score-policy.mjs";
import { assessmentSource, assessmentRef, assessmentHash, cachedAssessmentModel, invalidateAssessmentCache } from "./assessment-read-model.mjs";
import { eventIdentity } from "./deletion-identities.mjs";
import { MINIMUM_SESSION_AI_CREDITS, SESSION_CREDIT_MINIMUM_MESSAGE } from "./evaluation-budget.mjs";

function object(value, keys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) {
        throw new BoardError("Invalid automatic-score request.", 422);
    }
}
function automatic(state) {
    state.personalEvaluation ??= defaultPersonalEvaluation();
    state.personalEvaluation.modelEvaluation ??= defaultModelEvaluationState();
    state.personalEvaluation.modelEvaluation.automatic ??= defaultAutomaticScoreState();
    return state.personalEvaluation.modelEvaluation.automatic;
}
function packet(input, keys) {
    object(input, keys);
    if (input.schemaVersion !== 1 || input.confirmed !== true
        || !/^mutation-[a-f0-9]{32}$/.test(input.mutationRef ?? "")
        || !/^[a-f0-9]{64}$/.test(input.receiptToken ?? "")) throw new BoardError("Explicit score-processing approval and receipt identity are required.", 422);
}
const publicReceipt = receipt => ({
    schemaVersion: 1, mutationRef: receipt.mutationRef, kind: receipt.kind, phase: receipt.phase,
    data: { approvalRevision: receipt.approvalRevision, approvalRef: receipt.approvalRef },
});

export function createAutomaticScoreController(session, { evaluation, getSourceConfig, onChanged = () => {} }) {
    let reconcileWork = null, closed = false, lastError = "";
    function sourceFor(state) {
        let config;
        try { config = getSourceConfig(); }
        catch (error) {
            if (!(error instanceof BoardError) || ![428, 503].includes(error.status)) throw error;
            return { config: null, source: { available: false, collectionEnabled: false, sourceConfigRef: null, sourceConfigRevision: 0, windowDays: null } };
        }
        return { config, source: { ...assessmentSource(state, config), windowDays: config.windowDays, collectionEnabled: config.enabled === true } };
    }
    function candidatesFor(state, source) {
        if (!source.available) return [];
        const model = cachedAssessmentModel(state, { available: source.available, sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision });
        const deletedEvents = new Set(state.deletion?.events ?? []);
        const uncertain = new Set((state.personalEvaluation?.modelEvaluation?.runs ?? [])
            .filter(run => run.automatic && (run.costUnknown || run.phase === "uncertain")).map(run => run.automatic.interactionKey));
        return [...model.internals].map(([interactionRef, item]) => ({
            interactionRef, chatRef: assessmentRef(state, "chat", item.record.sourceSessionId), record: item.record,
            priorUncertain: uncertain.has(automaticInteractionKey(interactionRef)),
            deletedEvidence: item.record.assessmentMembershipPruned === true || typeof item.record.userPrompt?.sourceEventId === "string"
                && deletedEvents.has(eventIdentity(item.record.sourceSessionId, item.record.userPrompt.sourceEventId)),
        })).filter(item => !item.record.isLegacy).sort((a, b) =>
            String(a.record.userPrompt?.sourceTimestamp).localeCompare(String(b.record.userPrompt?.sourceTimestamp))
            || a.interactionRef.localeCompare(b.interactionRef));
    }
    function contextFor(state) {
        const { source } = sourceFor(state), data = state.personalEvaluation?.modelEvaluation;
        const store = data?.automatic, approval = store?.approval ?? null;
        const runs = approval ? automaticRuns(data, approval) : [];
        const attempts = runs.filter(run => !(run.callsReserved === 0 && run.error === "budget-exhausted"
            && run.automatic.approvalRevision < approval.revision))
            .map(run => ({ attemptKey: run.automatic.attemptKey, phase: run.phase }));
        const candidates = approval ? candidatesFor(state, source) : [];
        const usage = approval ? automaticUsage(data, approval)
            : { callsReserved: 0, spentAiCredits: 0, costUnknown: false, active: false, cleanupPending: false };
        const lifecycle = evaluation.lifecycleStatus();
        usage.cleanupPending = lifecycle.cleanupPending || (store?.receipts.some(receipt => receipt.kind === "revoke" && receipt.phase === "pending") ?? false);
        const plan = state.deletion?.pending ? { state: "paused", reason: "cleanup-pending", next: null, exclusions: [] }
            : lastError ? { state: "paused", reason: "evaluation-error", next: null, exclusions: [] }
                : approval?.state === "enabled" && lifecycle.active && !usage.active ? { state: "waiting", reason: "another-assessment-in-progress", next: null, exclusions: [] }
                : planAutomaticScore({ approval, source, candidates, attempts, usage, now: new Date().toISOString() });
        return { store, approval, source, candidates, usage, plan };
    }
    async function save(state, persist) {
        validatePersonalEvaluation(state.personalEvaluation);
        state.revision++;
        await persist(state);
    }
    function prior(store, owner, input) {
        const receipt = store.receipts.find(value => value.mutationRef === input.mutationRef);
        if (receipt && (receipt.ownerHash !== assessmentHash(owner) || receipt.inputHash !== assessmentHash(input))) {
            throw new BoardError("This score approval identity was already used for different inputs.", 409);
        }
        return receipt;
    }
    function receiptFor(owner, input, kind, store) {
        return {
            mutationRef: input.mutationRef, kind, ownerHash: assessmentHash(owner), inputHash: assessmentHash(input),
            receiptTokenHash: assessmentHash(input.receiptToken), phase: kind === "revoke" ? "pending" : "complete",
            createdAt: new Date().toISOString(), approvalRevision: store.revision, approvalRef: store.approval?.approvalRef ?? null,
        };
    }
    const api = {
        async summary() {
            const state = await loadBoardState(session), current = contextFor(state);
            return {
                schemaVersion: 1, approvalRevision: current.store?.revision ?? 0,
                source: current.source.available ? {
                    sourceConfigRef: current.source.sourceConfigRef, sourceConfigRevision: current.source.sourceConfigRevision, windowDays: current.source.windowDays,
                } : null,
                method: AUTOMATIC_SCORE_METHOD,
                snapshot: { ...current.plan, usage: current.usage, approval: current.approval },
            };
        },
        async setup(input = {}) {
            object(input, ["scenarioIds"]);
            const state = await loadBoardState(session), { source } = sourceFor(state);
            const store = state.personalEvaluation?.modelEvaluation?.automatic;
            let candidates = candidatesFor(state, source);
            let interactionRefs = store?.approval?.state === "enabled" ? store.approval.interactionRefs ?? null : null;
            if (input.scenarioIds !== undefined) {
                if (!Array.isArray(input.scenarioIds) || !input.scenarioIds.length || input.scenarioIds.length > 6
                    || input.scenarioIds.some(id => typeof id !== "string") || new Set(input.scenarioIds).size !== input.scenarioIds.length) {
                    throw new BoardError("Choose at most six distinct retained requests for a fixed approval.", 422);
                }
                const model = cachedAssessmentModel(state, { available: source.available, sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision });
                interactionRefs = [...new Set(input.scenarioIds.flatMap(id => model.catalog.find(row => row.scenarioId === id)?.interactionRefs ?? []))];
                if (interactionRefs.length !== input.scenarioIds.length || interactionRefs.some(ref => !candidates.some(candidate => candidate.interactionRef === ref))) {
                    throw new BoardError("The fixed approval must match exact retained interactions.", 422);
                }
            }
            if (interactionRefs) candidates = candidates.filter(candidate => interactionRefs.includes(candidate.interactionRef));
            const chats = new Map(), now = Date.now();
            for (const candidate of candidates) {
                const sourceId = candidate.record.sourceSessionId;
                if (!chats.has(candidate.chatRef)) chats.set(candidate.chatRef, {
                    chatRef: candidate.chatRef,
                    name: state.importCoverage?.roster?.find(row => row.sessionId === sourceId)?.name ?? "Recorded Copilot chat",
                    outsideWindow: 0, deletedEvidence: 0, priorUncertain: 0, requestGroups: 0, latestAt: null, shortId: sourceId.slice(0, 8),
                });
                const chat = chats.get(candidate.chatRef);
                chat.requestGroups++;
                chat.deletedEvidence += Number(candidate.deletedEvidence);
                chat.priorUncertain += Number(candidate.priorUncertain);
                const at = Date.parse(candidate.record.userPrompt?.sourceTimestamp);
                if (Number.isFinite(at) && (!chat.latestAt || at > Date.parse(chat.latestAt))) chat.latestAt = candidate.record.userPrompt.sourceTimestamp;
                if (Number.isFinite(at) && (at < now - source.windowDays * 86400000 || at > now)) chats.get(candidate.chatRef).outsideWindow++;
            }
            const current = contextFor(state);
            return {
                schemaVersion: 1, sourceRevision: state.evidenceRevision ?? state.revision, approvalRevision: store?.revision ?? 0,
                minimumSessionAiCredits: MINIMUM_SESSION_AI_CREDITS,
                source: source.available ? { sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision, windowDays: source.windowDays } : null,
                method: AUTOMATIC_SCORE_METHOD, chats: [...chats.values()],
                interactionRefs,
                snapshot: { ...current.plan, usage: current.usage, approval: current.approval },
            };
        },
        async approve(owner, input) {
            packet(input, ["schemaVersion", "mutationRef", "receiptToken", "confirmed", "expectedSourceRevision", "expectedApprovalRevision",
                "source", "method", "chatRefs", "maxCalls", "maxAiCredits", "evidenceCategories", "interactionRefs"]);
            object(input.source, ["sourceConfigRef", "sourceConfigRevision", "windowDays"]);
            object(input.method, Object.keys(AUTOMATIC_SCORE_METHOD));
            if (!Array.isArray(input.evidenceCategories)) throw new BoardError("Approve the specific evidence categories.", 422);
            const receipt = await exclusiveBoard(session, async (state, persist) => {
                if (closed || state.deletion?.pending) throw new BoardError("Finish local cleanup before approving scores.", 503);
                const store = automatic(state), existing = prior(store, owner, input);
                if (existing) return publicReceipt(existing);
                const lifecycle = evaluation.lifecycleStatus();
                if (lifecycle.active || lifecycle.cleanupPending || store.receipts.some(receipt => receipt.kind === "revoke" && receipt.phase === "pending")) {
                    throw new BoardError("Current evaluation work or cleanup must finish before another approval.", 422);
                }
                if (!Number.isSafeInteger(input.expectedSourceRevision) || input.expectedSourceRevision !== (state.evidenceRevision ?? state.revision)
                    || input.expectedApprovalRevision !== store.revision) throw new BoardError("The reviewed scope changed. Review the current approval.", 409);
                const { source } = sourceFor(state);
                if (!source.available || input.source?.sourceConfigRef !== source.sourceConfigRef
                    || input.source.sourceConfigRevision !== source.sourceConfigRevision || input.source.windowDays !== source.windowDays
                    || Object.keys(AUTOMATIC_SCORE_METHOD).some(key => input.method?.[key] !== AUTOMATIC_SCORE_METHOD[key])) {
                    throw new BoardError("Approve the current source, window and scoring method.", 422);
                }
                const candidates = candidatesFor(state, source), chats = new Set(candidates.map(candidate => candidate.chatRef));
                if (!Array.isArray(input.chatRefs) || input.chatRefs.some(ref => !chats.has(ref))) throw new BoardError("Choose currently retained chats from this approved source.", 422);
                if (input.interactionRefs != null && (!Array.isArray(input.interactionRefs)
                    || input.interactionRefs.some(ref => !candidates.some(candidate => candidate.interactionRef === ref && input.chatRefs.includes(candidate.chatRef))))) {
                    throw new BoardError("The fixed cohort must belong to the approved chats.", 422);
                }
                const previous = store.approval;
                let spentAiCredits = 0;
                if (previous?.state === "enabled") {
                    const sameScope = previous.sourceConfigRef === source.sourceConfigRef && previous.sourceConfigRevision === source.sourceConfigRevision
                        && JSON.stringify([...previous.chatRefs].sort()) === JSON.stringify([...input.chatRefs].sort())
                        && JSON.stringify(previous.interactionRefs ? [...previous.interactionRefs].sort() : null) === JSON.stringify(input.interactionRefs ? [...input.interactionRefs].sort() : null)
                        && Object.keys(AUTOMATIC_SCORE_METHOD).every(key => previous.method[key] === input.method[key]);
                    if (!sameScope) throw new BoardError("Stop the existing automatic scope before approving different chats or a different method.", 422);
                    const usage = automaticUsage(state.personalEvaluation.modelEvaluation, previous);
                    spentAiCredits = usage.spentAiCredits;
                    if (usage.active || usage.cleanupPending || usage.costUnknown
                        || input.maxCalls < usage.callsReserved || input.maxAiCredits < usage.spentAiCredits) {
                        throw new BoardError("Finish or stop the current work before replacing its allowance. Observed spending cannot be reset.", 422);
                    }
                }
                if (Number.isFinite(input.maxAiCredits) && input.maxAiCredits > 0
                    && input.maxAiCredits - spentAiCredits < MINIMUM_SESSION_AI_CREDITS) {
                    throw new BoardError(SESSION_CREDIT_MINIMUM_MESSAGE, 422);
                }
                store.revision++;
                const approval = {
                    schemaVersion: 1, approvalRef: previous?.state === "enabled" ? previous.approvalRef : assessmentRef(state, "approval", input.mutationRef),
                    revision: store.revision, state: "enabled", sourceConfigRef: source.sourceConfigRef,
                    sourceConfigRevision: source.sourceConfigRevision, windowDays: source.windowDays,
                    chatRefs: [...input.chatRefs].sort(), method: { ...AUTOMATIC_SCORE_METHOD }, evidenceCategories: [...input.evidenceCategories],
                    interactionRefs: input.interactionRefs ? [...input.interactionRefs].sort() : null,
                    maxCalls: input.maxCalls, maxAiCredits: input.maxAiCredits,
                    approvedAt: new Date().toISOString(), origin: "explicit-automatic-score-approval",
                };
                try { validateAutomaticScoreApproval(approval); }
                catch (error) { if (!(error instanceof TypeError)) throw error; throw new BoardError(error.message, 422); }
                store.approval = approval;
                const receipt = receiptFor(owner, input, "approve", store);
                store.receipts.push(receipt);
                await save(state, persist);
                lastError = ""; invalidateAssessmentCache(); onChanged();
                return publicReceipt(receipt);
            });
            await api.reconcile();
            return receipt;
        },
        async revoke(owner, input) {
            packet(input, ["schemaVersion", "mutationRef", "receiptToken", "confirmed"]);
            const pending = await exclusiveBoard(session, async (state, persist) => {
                if (state.deletion?.pending) throw new BoardError("Local source cleanup must finish before another permission change.", 503);
                const store = automatic(state), existing = prior(store, owner, input);
                if (existing) return publicReceipt(existing);
                // Advancing even an empty approval prevents a delayed older positive request from enabling scores after Stop.
                store.revision++;
                if (store.approval) { store.approval.state = "revoked"; store.approval.revision = store.revision; }
                const receipt = receiptFor(owner, input, "revoke", store);
                store.receipts.push(receipt);
                await save(state, persist);
                invalidateAssessmentCache(); onChanged();
                return publicReceipt(receipt);
            });
            if (pending.phase !== "pending") return pending;
            await evaluation.revoke({ automaticOnly: true });
            return exclusiveBoard(session, async (state, persist) => {
                const receipt = automatic(state).receipts.find(value => value.mutationRef === input.mutationRef);
                receipt.phase = "complete";
                await save(state, persist);
                lastError = "";
                return publicReceipt(receipt);
            });
        },
        async status(owner, input) {
            object(input, ["schemaVersion", "mutationRef", "receiptToken"]);
            if (input.schemaVersion !== 1 || !/^mutation-[a-f0-9]{32}$/.test(input.mutationRef ?? "")
                || !/^[a-f0-9]{64}$/.test(input.receiptToken ?? "")) throw new BoardError("Invalid score approval receipt.", 422);
            return exclusiveBoard(session, state => {
                const receipt = state.personalEvaluation?.modelEvaluation?.automatic?.receipts.find(value => value.mutationRef === input.mutationRef);
                if (!receipt) return { schemaVersion: 1, mutationRef: input.mutationRef, phase: "not-started" };
                if (receipt.ownerHash !== assessmentHash(owner) && receipt.receiptTokenHash !== assessmentHash(input.receiptToken)) {
                    throw new BoardError("This score approval receipt belongs to another panel.", 404);
                }
                return publicReceipt(receipt);
            });
        },
        async reconcile() {
            if (closed) return;
            if (reconcileWork) return reconcileWork;
            reconcileWork = (async () => {
                const state = await loadBoardState(session);
                if (!state.personalEvaluation?.modelEvaluation?.automatic?.approval) return;
                const { approval, plan, candidates, usage } = contextFor(state);
                if (!plan.next) return;
                const candidate = candidates.find(value => value.interactionRef === plan.next.interactionRef);
                const runRef = "mutation-" + assessmentHash([plan.next.attemptKey, approval.revision]).slice(0, 32);
                if (state.personalEvaluation.modelEvaluation.runs.some(run => run.runRef === runRef)) return;
                await evaluation.start("automatic-score:" + approval.approvalRef, {
                    schemaVersion: 1, mutationRef: runRef, receiptToken: randomBytes(32).toString("hex"),
                    scenarioIds: [candidate.record.scenarioId], expectedSourceRevision: state.evidenceRevision ?? state.revision,
                    maxAiCredits: approval.maxAiCredits - usage.spentAiCredits, confirmed: true,
                }, { approvalRef: approval.approvalRef, approvalRevision: approval.revision, attemptKey: plan.next.attemptKey,
                    interactionKey: automaticInteractionKey(candidate.interactionRef, approval.method) });
            })().catch(error => {
                if (error instanceof BoardError && [409, 428, 503].includes(error.status)) {
                    console.warn("[wire-automatic-scores] context changed before admission", { code: "AUTOMATIC_CONTEXT_CHANGED" });
                    return;
                }
                lastError = "Automatic scoring paused after a local evaluation error.";
                console.error("[wire-automatic-scores] reconciliation failed", { code: error.code ?? "AUTOMATIC_EVALUATION_FAILED" });
            }).finally(() => { reconcileWork = null; });
            return reconcileWork;
        },
        async recover() {
            const state = await loadBoardState(session);
            if (!state.personalEvaluation?.modelEvaluation?.automatic?.receipts.some(receipt => receipt.kind === "revoke" && receipt.phase === "pending")) return;
            await evaluation.revoke({ automaticOnly: true });
            await exclusiveBoard(session, async (current, persist) => {
                for (const receipt of automatic(current).receipts) if (receipt.kind === "revoke" && receipt.phase === "pending") receipt.phase = "complete";
                await save(current, persist);
            });
        },
        async close() { closed = true; if (reconcileWork) await reconcileWork; },
    };
    return api;
}
