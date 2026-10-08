import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BoardError, exclusiveBoard, loadBoardState, resolveDataDir } from "./store.mjs";
import { defaultPersonalEvaluation, validatePersonalEvaluation } from "./personal-evaluation.mjs";
import { defaultModelEvaluationState, evaluationRecordFingerprint, validateEvaluatorCost } from "./model-evaluation-state.mjs";
import { assessmentBasis, assessmentSource, assessmentRef, assessmentHash, assessmentDependencies, buildAssessmentModel, invalidateAssessmentCache } from "./assessment-read-model.mjs";
import { discoverSources } from "./source-discovery.mjs";
import { readEventWindow } from "./history.mjs";
import { eventIdentity } from "./deletion-identities.mjs";
import { buildEvaluationPacket } from "./evaluation-evidence.mjs";
import { createEvaluationRequest, validateModelEvaluation, interactionVerdicts, MODEL_EVALUATION_RUBRIC } from "./model-evaluation.mjs";
import { createCopilotEvaluator, evaluatorFailureCost } from "./copilot-evaluator.mjs";
import { safeDeletionFile } from "./deletion-storage.mjs";
import { AUTOMATIC_SCORE_METHOD, automaticScoreAttemptKey, automaticInteractionKey } from "./automatic-score-policy.mjs";
import { automaticUsage, defaultAutomaticScoreState } from "./automatic-score-store.mjs";
import { recordedResponseTiming } from "./response-timing.mjs";
import { createEvaluationDiagnostic, readEvaluationDiagnostic, withEvaluationDiagnostic } from "./evaluation-diagnostics.mjs";
import { resolveCopilotInstallation } from "./copilot-installation.mjs";
import { MINIMUM_SESSION_AI_CREDITS, SESSION_CREDIT_MINIMUM_MESSAGE } from "./evaluation-budget.mjs";
import { observeSessionSendRpc } from "./evaluation-transport-diagnostics.mjs";

const modelId = "gpt-6-astra";
const phases = new Set(["queued", "running"]);
const publicReasons = new Set(["final-answer-boundary-unavailable", "incomplete-tool-evidence", "credential-excluded",
    "evidence-limit", "unverified-action-association", "original-prompt-mismatch", "outside-approved-window", "source-not-eligible",
    "source-window-unavailable", "source-prompt-unavailable", "provider-unavailable", "evaluation-failed", "source-changed", "permission-revoked"]);
function validateObject(value, keys) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key))) throw new BoardError("Invalid evaluation request.", 422);
}
function personal(state) {
    state.personalEvaluation ??= defaultPersonalEvaluation();
    state.personalEvaluation.modelEvaluation ??= defaultModelEvaluationState();
    return state.personalEvaluation;
}
function evaluationDependencies(view) {
    // Model evidence is read under its own grant, not borrowed from optional reply retention.
    return assessmentDependencies({ ...view, observations: view.observations.filter(observation => observation.origin !== "optional-capture") });
}
function statusOf(run) {
    return run ? { runRef: run.runRef, phase: run.phase, callsReserved: run.callsReserved, spentAiCredits: run.spentAiCredits,
        costUnknown: run.costUnknown, results: structuredClone(run.results), error: run.error } : null;
}
function ownedRun(state, owner, input) {
    const run = state.personalEvaluation?.modelEvaluation?.runs.find(run => run.runRef === input.runRef);
    if (!run || run.ownerHash !== assessmentHash(owner) && run.receiptTokenHash !== assessmentHash(input.receiptToken ?? "")) {
        throw new BoardError("This evaluation receipt is not available to this panel.", 404);
    }
    return run;
}
async function installedEvaluator(baseDirectory) {
    const { sdkPath, cliPath } = await resolveCopilotInstallation();
    const sdk = await import(pathToFileURL(sdkPath).href);
    return createCopilotEvaluator({ baseDirectory, observeTransport: client => observeSessionSendRpc(client.connection), createClient: options => new sdk.CopilotClient({
        ...options, connection: sdk.RuntimeConnection.forStdio({ path: cliPath }),
        telemetry: { captureContent: false },
    }) });
}

export function createEvaluationController(session, { getSourceConfig, discover = discoverSources, readSource = readEventWindow,
    evaluatorFactory = installedEvaluator, onChanged = () => {} } = {}) {
    if (typeof getSourceConfig !== "function") throw new TypeError("An approved-source provider is required.");
    const active = new Map(), cancellations = new Map(), ownedWork = new Map();
    let closed = false;
    const now = () => new Date().toISOString();
    async function update(work) {
        return exclusiveBoard(session, async (state, save) => {
            if (state.deletion?.pending) throw new BoardError("Finish local cleanup before evaluating evidence.", 503);
            const result = await work(state);
            validatePersonalEvaluation(state.personalEvaluation);
            state.revision++;
            await save(state);
            return result;
        });
    }
    function selected(state, scenarioIds, config) {
        const model = buildAssessmentModel(state, { source: assessmentSource(state, config) });
        const refs = [...new Set(scenarioIds.flatMap(id => model.catalog.find(row => row.scenarioId === id)?.interactionRefs ?? []))];
        if (refs.length !== scenarioIds.length || refs.some(ref => !model.details.has(ref))) throw new BoardError("Choose distinct retained interactions with verified membership.", 422);
        return { model, refs };
    }
    function automaticAuthority(state, automatic, record, { admission = false, runRef = null } = {}) {
        const data = state.personalEvaluation?.modelEvaluation, approval = data?.automatic?.approval;
        const config = getSourceConfig(), source = assessmentSource(state, config);
        if (!approval || approval.state !== "enabled" || approval.approvalRef !== automatic.approvalRef
            || admission && (approval.revision !== automatic.approvalRevision || !config.enabled)
            || !source.available || approval.sourceConfigRef !== source.sourceConfigRef
            || approval.sourceConfigRevision !== source.sourceConfigRevision || approval.windowDays !== config.windowDays
            || Object.keys(AUTOMATIC_SCORE_METHOD).some(key => approval.method[key] !== AUTOMATIC_SCORE_METHOD[key])
            || record && (!approval.chatRefs.includes(assessmentRef(state, "chat", record.sourceSessionId))
                || approval.interactionRefs && !approval.interactionRefs.includes(assessmentRef(state, "interaction", [
                    record.sourceSessionId, record.userPrompt?.sourceEventId ?? record.scenarioId,
                ]))
                || record.assessmentMembershipPruned === true
                || (state.deletion?.events ?? []).includes(eventIdentity(record.sourceSessionId, record.userPrompt?.sourceEventId)))) {
            throw new BoardError("Automatic-score approval changed. No new assessment was authorized.", 409);
        }
        if (data.runs.some(run => run.runRef !== runRef && run.automatic?.interactionKey === automatic.interactionKey
            && (run.costUnknown || run.phase === "uncertain"))) throw new BoardError("An earlier assessment for this interaction is uncertain and cannot be repeated automatically.", 409);
        return { approval, usage: automaticUsage(data, approval) };
    }
    async function assertCurrentAuthority(runRef, item, signal) {
        if (signal.aborted) throw new Error("permission-revoked");
        let cancel;
        const cancelled = new Promise((_, reject) => {
            cancel = () => reject(new Error("permission-revoked"));
            signal.addEventListener("abort", cancel, { once: true });
        });
        const checked = exclusiveBoard(session, state => {
            const data = state.personalEvaluation?.modelEvaluation, run = data?.runs.find(value => value.runRef === runRef);
            const grant = data?.grants.find(value => value.grantRef === run?.grantRef);
            if (closed || signal.aborted || state.deletion?.pending || !run || !phases.has(run.phase)
                || grant?.state !== "enabled" || !grant.interactionRefs.includes(item.interactionRef)
                || !run.scope.some(scope => scope.interactionRef === item.interactionRef)) throw new Error("permission-revoked");
            const source = assessmentSource(state, getSourceConfig());
            if (source.sourceConfigRef !== grant.sourceConfigRef || source.sourceConfigRevision !== grant.sourceConfigRevision) throw new Error("source-not-eligible");
            const record = buildAssessmentModel(state, { source }).internals.get(item.interactionRef)?.record;
            if (!record || evaluationRecordFingerprint(record) !== item.recordFingerprint) throw new Error("source-changed");
            if (run.automatic) automaticAuthority(state, run.automatic, record, { runRef });
        });
        // Deletion holds the board writer while waiting for owned SDK cleanup.
        // Cancellation must release a pre-send authority check queued behind it.
        try { return await Promise.race([checked, cancelled]); }
        finally { signal.removeEventListener("abort", cancel); }
    }
    async function accountOverhead(runRef, overhead) {
        validateEvaluatorCost(overhead);
        await update(current => {
            const run = personal(current).modelEvaluation.runs.find(value => value.runRef === runRef);
            if (run.phase === "purged") return;
            run.costUnknown ||= overhead.status !== "recorded";
            if (overhead.aiCredits !== null) run.spentAiCredits += overhead.aiCredits;
        });
    }
    function remainingBudget(state, run, grant, record = null) {
        let remaining = grant.maxAiCredits - run.spentAiCredits;
        let exhausted = run.callsReserved >= grant.maxCalls || run.spentAiCredits >= grant.maxAiCredits || run.costUnknown;
        if (run.automatic) {
            const { approval, usage } = automaticAuthority(state, run.automatic, record, { runRef: run.runRef });
            remaining = Math.min(remaining, approval.maxAiCredits - usage.spentAiCredits);
            exhausted ||= usage.callsReserved >= approval.maxCalls || usage.spentAiCredits >= approval.maxAiCredits || usage.costUnknown;
        }
        return { remaining, reason: exhausted ? "budget-exhausted" : remaining < MINIMUM_SESSION_AI_CREDITS ? "session-credit-minimum" : null };
    }
    function pauseForBudget(run, reason) {
        run.phase = "partial"; run.error = reason; run.completedAt = now();
    }
    async function runBatch(runRef, planned, signal) {
        for (const item of planned) {
            let packet, currentView, config, overhead, invocationStarted = false, overheadRecorded = false, accountingAttempted = false;
            let stage = "source-check", responseObserved = false;
            try {
                const state = await loadBoardState(session), data = state.personalEvaluation?.modelEvaluation;
                const run = data?.runs.find(value => value.runRef === runRef), grant = data?.grants.find(value => value.grantRef === run?.grantRef);
                if (closed || signal.aborted || !run || !phases.has(run.phase) || grant?.state !== "enabled") break;
                config = getSourceConfig();
                const source = assessmentSource(state, config);
                if (source.sourceConfigRef !== grant.sourceConfigRef || source.sourceConfigRevision !== grant.sourceConfigRevision) throw new Error("source-not-eligible");
                if (remainingBudget(state, run, grant).reason) {
                    const paused = await update(current => {
                        const data = personal(current).modelEvaluation, currentRun = data.runs.find(value => value.runRef === runRef);
                        const currentGrant = data.grants.find(value => value.grantRef === currentRun?.grantRef);
                        if (!currentRun || !phases.has(currentRun.phase) || currentGrant?.state !== "enabled") return true;
                        const budget = remainingBudget(current, currentRun, currentGrant);
                        if (!budget.reason) return false;
                        pauseForBudget(currentRun, budget.reason);
                        return true;
                    });
                    if (paused) break;
                }
                const model = buildAssessmentModel(state, { source });
                currentView = model.details.get(item.interactionRef);
                const record = model.internals.get(item.interactionRef)?.record;
                if (!currentView || !record || evaluationRecordFingerprint(record) !== item.recordFingerprint) throw new Error("source-prompt-unavailable");
                if (run.automatic) automaticAuthority(state, run.automatic, record, { runRef });
                const since = new Date(Date.now() - config.windowDays * 86400000).toISOString();
                if (!record.userPrompt?.sourceTimestamp || record.userPrompt.sourceTimestamp < since) throw new Error("outside-approved-window");
                if (record.userPrompt.status !== "full" || typeof record.userPrompt.text !== "string") throw new Error("source-prompt-unavailable");
                const discovery = discover(config);
                if (!discovery.roster.some(source => source.eligible && source.sessionId === record.sourceSessionId)) throw new Error("source-not-eligible");
                stage = "source-read";
                const window = await readSource(path.join(config.sessionRoot, record.sourceSessionId, "events.jsonl"));
                if (window.failure || window.malformedLines || window.startup?.data?.sessionId !== record.sourceSessionId || window.startup.data.version !== 1) throw new Error("source-window-unavailable");
                if (run.automatic) {
                    const currentTiming = recordedResponseTiming(window.events, record.userPrompt);
                    if (currentTiming.status !== "measured" || ["promptEventId", "finalEventId", "completionEventId"]
                        .some(key => currentTiming[key] !== record.responseTiming?.[key])) throw new Error("source-changed");
                }
                stage = "authority-check";
                await assertCurrentAuthority(runRef, item, signal);
                const callIds = [...new Set([...(record.toolCalls ?? []).map(call => call.toolCallId),
                    ...(record.graphActivities ?? []).map(action => action.toolCallId)].filter(Boolean))];
                stage = "packet-build";
                packet = buildEvaluationPacket(window.events, {
                    interactionRef: item.interactionRef, sourceSessionId: record.sourceSessionId,
                    promptEventId: record.userPrompt.sourceEventId, promptTimestamp: record.userPrompt.sourceTimestamp,
                    promptText: record.userPrompt.text, toolCallIds: callIds,
                }, { confirmed: true, interactionRefs: grant.interactionRefs, categories: ["answer", "references", "intent"],
                    sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision });
                stage = "reservation";
                const reservation = await update(current => {
                    const data = personal(current).modelEvaluation, run = data.runs.find(value => value.runRef === runRef);
                    const grant = data.grants.find(value => value.grantRef === run.grantRef);
                    if (closed || grant.state !== "enabled" || !phases.has(run.phase)) throw new BoardError("Evaluation permission changed.", 409);
                    const source = assessmentSource(current, getSourceConfig());
                    if (source.sourceConfigRef !== grant.sourceConfigRef || source.sourceConfigRevision !== grant.sourceConfigRevision) throw new Error("source-not-eligible");
                    const view = buildAssessmentModel(current, { source });
                    if (!view.internals.has(item.interactionRef)
                        || evaluationRecordFingerprint(view.internals.get(item.interactionRef).record) !== item.recordFingerprint
                        || !run.scope.some(scope => scope.interactionRef === item.interactionRef)) throw new BoardError("Selected evidence changed.", 409);
                    const budget = remainingBudget(current, run, grant, view.internals.get(item.interactionRef).record);
                    if (budget.reason) { pauseForBudget(run, budget.reason); return null; }
                    run.callsReserved++; run.phase = "running";
                    return { confirmed: true, reservationId: `${runRef}-${run.callsReserved}`,
                        callsRemaining: grant.maxCalls - run.callsReserved + 1, remainingAiCredits: budget.remaining,
                        grant: structuredClone(grant) };
                });
                if (!reservation) break;
                stage = "request-build";
                const request = createEvaluationRequest(packet, { ...reservation.grant, confirmed: true, provider: "github-copilot" });
                const relativeWorkDir = path.join("evaluation-work", runRef, String(reservation.reservationId.split("-").at(-1)));
                stage = "work-directory";
                const workDir = await safeDeletionFile(resolveDataDir(session), relativeWorkDir);
                let response, cleanupError, finishWork;
                ownedWork.set(runRef, new Promise(resolve => { finishWork = resolve; }));
                try {
                    await mkdir(workDir, { recursive: true });
                    stage = "executor-load";
                    const evaluator = await evaluatorFactory(workDir);
                    stage = "authority-check";
                    await assertCurrentAuthority(runRef, item, signal);
                    invocationStarted = true;
                    stage = "executor-call";
                    response = await evaluator.evaluate(request, reservation, { signal,
                        authorize: () => assertCurrentAuthority(runRef, item, signal) });
                    responseObserved = true;
                    stage = "usage-accounting";
                    overhead = validateEvaluatorCost(response.evaluatorCost);
                } catch (error) {
                    overhead ??= evaluatorFailureCost(error);
                    if (error.code === "EVALUATOR_CLEANUP_FAILED") cleanupError = error;
                    throw error;
                } finally {
                    try { await rm(await safeDeletionFile(resolveDataDir(session), relativeWorkDir), { recursive: true, force: true }); }
                    catch (error) {
                        cleanupError = error;
                        throw withEvaluationDiagnostic(error, createEvaluationDiagnostic(error, {
                            stage: "work-cleanup", sendInvoked: invocationStarted ? responseObserved ? true : null : false,
                            responseObserved, cleanupStages: ["work-cleanup"],
                        }));
                    }
                    finally {
                        finishWork(cleanupError);
                        if (!cleanupError) ownedWork.delete(runRef);
                    }
                }
                accountingAttempted = true;
                stage = "usage-accounting";
                await accountOverhead(runRef, overhead);
                overheadRecorded = true;
                stage = "result-validation";
                const validated = validateModelEvaluation(response.rawResult, packet, request.packetHash);
                const verdicts = interactionVerdicts(validated);
                stage = "result-publish";
                await update(current => {
                    const p = personal(current), data = p.modelEvaluation, run = data.runs.find(value => value.runRef === runRef);
                    const grant = data.grants.find(value => value.grantRef === run.grantRef);
                    if (closed || grant.state !== "enabled" || !phases.has(run.phase)) return;
                    const currentSource = assessmentSource(current, getSourceConfig());
                    const model = buildAssessmentModel(current, { source: currentSource });
                    const record = model.internals.get(item.interactionRef)?.record;
                    if (!record || evaluationRecordFingerprint(record) !== item.recordFingerprint
                        || currentSource.sourceConfigRef !== grant.sourceConfigRef || currentSource.sourceConfigRevision !== grant.sourceConfigRevision) {
                        run.results.push({ interactionRef: item.interactionRef, status: "unavailable", reason: "source-prompt-unavailable" });
                        return;
                    }
                    if (run.automatic) automaticAuthority(current, run.automatic, record, { runRef });
                    p.overrideRevision++; data.revision++;
                    const basis = assessmentBasis(current), createdAt = now();
                    const evidenceRefs = [assessmentRef(current, "evidence", request.packetHash)];
                    const profile = { provider: "github-copilot", model: grant.model, rubricId: MODEL_EVALUATION_RUBRIC.id, rubricVersion: MODEL_EVALUATION_RUBRIC.version };
                    const assessments = verdicts.map(verdict => ({
                        schemaVersion: 1, interactionRef: item.interactionRef, basis, createdAt, evidenceRefs,
                        assessmentRef: assessmentRef(current, "assessment", [runRef, item.interactionRef, verdict.checkId]),
                        checkId: verdict.checkId, checkVersion: 1, dimension: verdict.dimension, unitRef: item.interactionRef,
                        origin: "model-assessed", evaluator: profile, rubricVersion: 1, verdict: verdict.verdict, reason: verdict.reason,
                        revision: 1, supersedes: null, withdrawn: false,
                    }));
                    const dependencies = evaluationDependencies(model.details.get(item.interactionRef));
                    dependencies.deletionKeys.push(eventIdentity(record.sourceSessionId, record.userPrompt.sourceEventId));
                    dependencies.deletionKeys = [...new Set(dependencies.deletionKeys)];
                    data.records.push({
                        recordRef: assessmentRef(current, "evaluation", [runRef, item.interactionRef]), runRef, grantRef: grant.grantRef,
                        interactionRef: item.interactionRef, recordFingerprint: item.recordFingerprint, packetHash: request.packetHash, createdAt,
                        dependencies, assessments, criteria: verdicts.map(verdict => ({ dimension: verdict.dimension, counts: verdict.criteria })),
                        evaluatorCost: response.evaluatorCost,
                    });
                    run.results.push({ interactionRef: item.interactionRef, status: "assessed", reason: null });
                    invalidateAssessmentCache(); onChanged();
                });
            } catch (error) {
                const diagnostic = readEvaluationDiagnostic(error) ?? createEvaluationDiagnostic(error, {
                    stage, sendInvoked: invocationStarted ? responseObserved ? true : null : false, responseObserved,
                });
                if (overhead && !overheadRecorded) {
                    if (accountingAttempted) throw error;
                    accountingAttempted = true;
                    await accountOverhead(runRef, overhead);
                    overheadRecorded = true;
                }
                await update(current => {
                    const run = personal(current).modelEvaluation.runs.find(value => value.runRef === runRef);
                    if (!run || !phases.has(run.phase)) return;
                    const reason = publicReasons.has(error.message) ? error.message : "evaluation-failed";
                    run.results.push({ interactionRef: item.interactionRef, status: reason === "evaluation-failed" ? "failed" : "unavailable", reason, diagnostic });
                    if (packet) {
                        run.phase = "failed";
                        run.error = ["source-changed", "source-not-eligible"].includes(reason) ? "source-changed" : "evaluation-failed";
                        run.costUnknown ||= invocationStarted && !overheadRecorded; run.completedAt = now();
                    }
                });
                if (packet) break;
            }
        }
        await update(current => {
            const run = personal(current).modelEvaluation.runs.find(value => value.runRef === runRef);
            if (run && phases.has(run.phase)) {
                run.phase = run.results.length === run.scope.length && run.results.every(result => result.status === "assessed") ? "complete" : "partial";
                run.completedAt = now();
            }
        });
    }
    return {
        lifecycleStatus() {
            return { active: active.size > 0, cleanupPending: [...ownedWork.keys()].some(runRef => !active.has(runRef)) };
        },
        async sealSourceDeletion(state) {
            const runs = state.personalEvaluation?.modelEvaluation?.runs.filter(run => run.phase === "purged") ?? [];
            for (const run of runs) cancellations.get(run.runRef)?.abort();
            const failures = (await Promise.all(runs.map(run => ownedWork.get(run.runRef)))).filter(Boolean);
            if (failures.length) throw new AggregateError(failures, "Evaluation cleanup is incomplete; deletion remains pending.");
            for (const run of runs) {
                await rm(await safeDeletionFile(resolveDataDir(session), path.join("evaluation-work", run.runRef)), { recursive: true, force: true });
            }
        },
        async recover() {
            const state = await loadBoardState(session);
            const runs = state.personalEvaluation?.modelEvaluation?.runs ?? [];
            for (const run of runs) {
                const workDir = await safeDeletionFile(resolveDataDir(session), path.join("evaluation-work", run.runRef));
                await rm(workDir, { recursive: true, force: true });
            }
            if (runs.some(run => phases.has(run.phase))) await update(current => {
                for (const run of personal(current).modelEvaluation.runs) if (phases.has(run.phase)) {
                    run.phase = "uncertain"; run.error = "runtime-restarted"; run.completedAt = now();
                    run.costUnknown ||= run.callsReserved > 0;
                }
            });
        },
        async setup(input = {}) {
            validateObject(input, ["scenarioIds"]);
            const state = await loadBoardState(session);
            const ids = input.scenarioIds ?? [];
            if (!Array.isArray(ids) || ids.length > 6 || ids.some(id => typeof id !== "string")) throw new BoardError("Choose at most six retained interactions.", 422);
            let source, refs = [], outsideWindow = 0;
            try {
                const config = getSourceConfig();
                source = assessmentSource(state, config);
                if (ids.length) {
                    const selection = selected(state, ids, config);
                    refs = selection.refs;
                    const since = new Date(Date.now() - config.windowDays * 86400000).toISOString();
                    outsideWindow = refs.filter(ref => selection.model.internals.get(ref).record.userPrompt?.sourceTimestamp < since).length;
                }
            } catch (error) {
                if (!(error instanceof BoardError) || ![428, 503].includes(error.status)) throw error;
                source = { available: false, sourceConfigRef: null, sourceConfigRevision: 0 };
            }
            const evaluation = state.personalEvaluation?.modelEvaluation;
            return { schemaVersion: 1, basis: assessmentBasis(state), source, selectedCount: refs.length, outsideWindow,
                model: modelId, provider: "github-copilot", maxCalls: refs.length, rawCaptureDefault: "off",
                minimumSessionAiCredits: MINIMUM_SESSION_AI_CREDITS,
                active: evaluation?.grants.some(grant => grant.state === "enabled") ?? false,
                latestRun: statusOf(evaluation?.runs.at(-1)) };
        },
        async start(owner, input, automatic = null) {
            validateObject(input, ["schemaVersion", "mutationRef", "receiptToken", "scenarioIds", "expectedSourceRevision", "maxAiCredits", "confirmed"]);
            if (input.schemaVersion !== 1 || input.confirmed !== true || !/^mutation-[a-f0-9]{32}$/.test(input.mutationRef ?? "")
                || !/^[a-f0-9]{64}$/.test(input.receiptToken ?? "") || !Array.isArray(input.scenarioIds)
                || !input.scenarioIds.length || input.scenarioIds.length > 6 || input.scenarioIds.some(id => typeof id !== "string")
                || new Set(input.scenarioIds).size !== input.scenarioIds.length || !Number.isSafeInteger(input.expectedSourceRevision)
                || !Number.isFinite(input.maxAiCredits) || input.maxAiCredits <= 0) throw new BoardError("Explicit scope, disclosure approval and a positive credit budget are required.", 422);
            const config = getSourceConfig(), inputHash = assessmentHash(input);
            let planned;
            const result = await update(state => {
                if (closed) throw new BoardError("The evaluation controller is closed.", 503);
                const p = personal(state), data = p.modelEvaluation;
                const existing = data.runs.find(run => run.runRef === input.mutationRef);
                if (existing) {
                    if (existing.ownerHash !== assessmentHash(owner) || existing.inputHash !== inputHash) throw new BoardError("Evaluation identity was reused for different inputs.", 409);
                    return statusOf(existing);
                }
                if (active.size || ownedWork.size || data.runs.some(run => phases.has(run.phase))) {
                    throw new BoardError("An evaluation or its cleanup is already pending. Read its original receipt.", 409);
                }
                if ((state.evidenceRevision ?? state.revision) !== input.expectedSourceRevision) throw new BoardError("Source evidence changed. Review the current selection.", 409);
                const { model, refs } = selected(state, input.scenarioIds, config);
                const source = assessmentSource(state, config);
                if (!source.available) throw new BoardError("An approved local source is required.", 428);
                let creditLimit = input.maxAiCredits;
                if (automatic) {
                    validateObject(automatic, ["approvalRef", "approvalRevision", "attemptKey", "interactionKey"]);
                    if (refs.length !== 1) throw new BoardError("Automatic work reserves one interaction at a time.", 422);
                    const record = model.internals.get(refs[0]).record;
                    const { approval, usage } = automaticAuthority(state, automatic, record, { admission: true });
                    if (automatic.attemptKey !== automaticScoreAttemptKey(approval, refs[0], record)
                        || automatic.interactionKey !== automaticInteractionKey(refs[0], approval.method)) throw new BoardError("Automatic evidence changed.", 409);
                    if (usage.costUnknown || usage.callsReserved >= approval.maxCalls || usage.spentAiCredits >= approval.maxAiCredits) {
                        throw new BoardError("The cumulative automatic-score allowance is paused.", 409);
                    }
                    creditLimit = Math.min(creditLimit, approval.maxAiCredits - usage.spentAiCredits);
                }
                if (creditLimit < MINIMUM_SESSION_AI_CREDITS) throw new BoardError(SESSION_CREDIT_MINIMUM_MESSAGE, 422);
                p.source = structuredClone(source);
                const grantRef = assessmentRef(state, "grant", input.mutationRef), startedAt = now();
                data.grants.push({ grantRef, state: "enabled", sourceConfigRef: source.sourceConfigRef, sourceConfigRevision: source.sourceConfigRevision,
                    interactionRefs: refs, model: modelId, maxCalls: refs.length, maxAiCredits: creditLimit,
                    grantedAt: startedAt, revokedAt: null,
                    origin: automatic ? "approved-chat-automatic" : "explicit-in-app-evaluation",
                    ...(automatic ? { automaticApprovalRef: automatic.approvalRef } : {}) });
                planned = refs.map(interactionRef => ({
                    interactionRef, recordFingerprint: evaluationRecordFingerprint(model.internals.get(interactionRef).record),
                    dependencies: evaluationDependencies(model.details.get(interactionRef)),
                }));
                const run = { runRef: input.mutationRef, grantRef, ownerHash: assessmentHash(owner), inputHash,
                    receiptTokenHash: assessmentHash(input.receiptToken), phase: "queued", startedAt, completedAt: null,
                    callsReserved: 0, spentAiCredits: 0, costUnknown: false, results: [], scope: planned, basis: assessmentBasis(state), error: null,
                    ...(automatic ? { automatic: structuredClone(automatic) } : {}) };
                data.runs.push(run); data.revision++;
                return statusOf(run);
            });
            if (planned) {
                const cancellation = new AbortController();
                cancellations.set(input.mutationRef, cancellation);
                const work = runBatch(input.mutationRef, planned, cancellation.signal).catch(error => {
                    console.error("[wire-evaluation] operation failed", { code: "EVALUATION_FAILED" });
                    return error;
                }).finally(() => { active.delete(input.mutationRef); cancellations.delete(input.mutationRef); });
                active.set(input.mutationRef, work);
            }
            return result;
        },
        async status(owner, input) {
            validateObject(input, ["runRef", "receiptToken"]);
            const state = await loadBoardState(session), run = ownedRun(state, owner, input);
            if (phases.has(run.phase) && !active.has(run.runRef)) {
                return update(current => {
                    const value = ownedRun(current, owner, input);
                    value.phase = "uncertain"; value.error = "runtime-restarted"; value.completedAt = now();
                    value.costUnknown ||= value.callsReserved > 0;
                    return statusOf(value);
                });
            }
            return statusOf(run);
        },
        async revoke({ automaticOnly = false } = {}) {
            let affected;
            const result = await update(state => {
                const p = personal(state), data = p.modelEvaluation;
                if (!automaticOnly) {
                    data.automatic ??= defaultAutomaticScoreState();
                    data.automatic.revision++;
                    if (data.automatic.approval) {
                        data.automatic.approval.state = "revoked";
                        data.automatic.approval.revision = data.automatic.revision;
                    }
                }
                const grants = new Set(data.grants.filter(grant => !automaticOnly || grant.origin === "approved-chat-automatic").map(grant => grant.grantRef));
                affected = data.runs.filter(run => grants.has(run.grantRef)).map(run => run.runRef);
                for (const grant of data.grants) if (grants.has(grant.grantRef) && grant.state === "enabled") { grant.state = "revoked"; grant.revokedAt = now(); }
                for (const run of data.runs) if (grants.has(run.grantRef) && phases.has(run.phase)) {
                    run.costUnknown ||= run.phase === "running";
                    run.phase = "revoked"; run.error = "permission-revoked"; run.completedAt = now();
                }
                data.records = data.records.filter(record => !grants.has(record.grantRef)); data.revision++; p.overrideRevision++;
                invalidateAssessmentCache(); onChanged();
                return { revoked: true, inFlightMayBeCharged: affected.some(runRef => active.has(runRef)) };
            });
            const work = affected.map(runRef => active.get(runRef));
            for (const runRef of affected) cancellations.get(runRef)?.abort();
            const failures = [...await Promise.all(work),
                ...await Promise.all(affected.map(runRef => ownedWork.get(runRef)))].filter(Boolean);
            if (failures.length) throw new AggregateError(failures, "Evaluation permission was revoked, but owned work cleanup did not finish.");
            return result;
        },
        async settle() {
            const failures = (await Promise.all([...active.values()])).filter(Boolean);
            if (failures.length) throw new AggregateError(failures, "Evaluation operation did not finish.");
        },
        async close() {
            closed = true;
            for (const cancellation of cancellations.values()) cancellation.abort();
            const failures = [...await Promise.all([...active.values()]),
                ...await Promise.all([...ownedWork.values()])].filter(Boolean);
            if (failures.length) throw new AggregateError(failures, "Evaluation worker cleanup did not finish.");
        },
    };
}
