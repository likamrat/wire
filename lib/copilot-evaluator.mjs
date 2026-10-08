import path from "node:path";
import { assertPreparedEvaluationRequest } from "./model-evaluation.mjs";
import { createEvaluationDiagnostic, withEvaluationDiagnostic, readEvaluationDiagnostic, projectSessionError } from "./evaluation-diagnostics.mjs";
import { sessionCreditLimit } from "./evaluation-budget.mjs";

function requireThat(condition, code) { if (!condition) throw new TypeError(code); }
const failureCosts = new WeakMap();
export function evaluatorFailureCost(error) {
    const cost = failureCosts.get(error);
    return cost ? { ...cost } : null;
}

// The caller supplies the installed SDK factory only after validating and durably reserving a user grant.
// There is deliberately no default client, module-load connection, credential lookup, or retry.
export function createCopilotEvaluator({ createClient, baseDirectory, observeTransport }) {
    requireThat(typeof createClient === "function" && typeof baseDirectory === "string" && path.isAbsolute(baseDirectory),
        "invalid-evaluator-host");
    requireThat(observeTransport === undefined || typeof observeTransport === "function", "invalid-evaluator-transport-observer");
    return {
        async evaluate(request, reservation, { signal, authorize } = {}) {
            requireThat(reservation?.confirmed === true && typeof reservation.reservationId === "string" && reservation.reservationId
                && Number.isFinite(reservation.remainingAiCredits) && reservation.remainingAiCredits > 0
                && Number.isSafeInteger(reservation.callsRemaining) && reservation.callsRemaining > 0, "evaluator-execution-not-approved");
            assertPreparedEvaluationRequest(request);
            const maxAiCredits = sessionCreditLimit(request.maxAiCredits, reservation.remainingAiCredits);
            let client, session, unsubscribe, failure, result, observedFailure, abortWork, abortFailure, unidentifiedUsage = false;
            let responseReceived = false, cleanupFailed = false;
            let stage = "client-create", sendInvoked = false;
            let sessionError = null, transport;
            const usage = new Map(), conflictingUsage = new Set();
            function overhead() {
                const amounts = [...usage.values()], known = amounts.filter(amount => amount !== null);
                const complete = responseReceived && !cleanupFailed && !observedFailure && !signal?.aborted
                    && usage.size > 0 && !unidentifiedUsage && known.length === amounts.length;
                return {
                    aiCredits: known.length ? known.reduce((sum, amount) => sum + amount, 0) / 1e9 : null,
                    modelCalls: unidentifiedUsage || !usage.size ? null : usage.size,
                    attribution: "evaluation-overhead-only",
                    status: complete ? "recorded" : known.length ? "partial" : "unavailable",
                };
            }
            const abort = () => {
                if (session && !abortWork) abortWork = Promise.resolve().then(() => session.abort()).catch(error => { abortFailure = error; });
            };
            function onEvent(event) {
                sessionError ??= projectSessionError(event);
                if (["tool.execution_start", "external_tool.requested", "permission.requested", "subagent.started"].includes(event.type)) {
                    observedFailure ??= new Error("evaluator-tool-execution");
                }
                if (event.type !== "assistant.usage") return;
                const data = event.data;
                if (data?.model !== request.model) {
                    unidentifiedUsage = true;
                    observedFailure ??= new Error("evaluator-model-unverified");
                    return;
                }
                if (typeof data.apiCallId !== "string" || !data.apiCallId) { unidentifiedUsage = true; return; }
                const amount = data.copilotUsage?.totalNanoAiu;
                if (amount !== undefined && (!Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER)) {
                    conflictingUsage.add(data.apiCallId);
                    usage.set(data.apiCallId, null);
                    observedFailure ??= new Error("evaluator-usage-invalid");
                    return;
                }
                const prior = usage.get(data.apiCallId);
                if (prior !== undefined && prior !== null && amount !== undefined && prior !== amount) {
                    conflictingUsage.add(data.apiCallId);
                    observedFailure ??= new Error("evaluator-usage-conflict");
                }
                usage.set(data.apiCallId, conflictingUsage.has(data.apiCallId) ? null : amount ?? prior ?? null);
                if (usage.size > request.maxModelCalls) observedFailure ??= new Error("evaluator-call-limit-exceeded");
            }
            try {
                requireThat(!signal?.aborted, "evaluator-cancelled");
                client = await createClient({ mode: "empty", autoStart: true, baseDirectory, useLoggedInUser: true });
                stage = "session-create";
                session = await client.createSession({
                    model: request.model, availableTools: [], excludedTools: ["builtin:*", "mcp:*", "custom:*"],
                    tools: [], customAgents: [], mcpServers: {}, enableConfigDiscovery: false,
                    skipCustomInstructions: true, enableSkills: false, enableFileHooks: false,
                    enableOnDemandInstructionDiscovery: false, enableHostGitOperations: false,
                    enableSessionStore: false, infiniteSessions: { enabled: false }, memory: { enabled: false }, remoteSession: "off",
                    sessionLimits: { maxAiCredits }, systemMessage: { mode: "replace", content: request.system },
                    onPermissionRequest: () => ({ kind: "denied-no-approval-rule-and-could-not-request-from-user" }),
                    onUserInputRequest: () => { throw new Error("evaluator-user-input-forbidden"); },
                    onEvent,
                });
                stage = "event-subscribe";
                unsubscribe = session.on(onEvent);
                transport = observeTransport?.(client);
                signal?.addEventListener("abort", abort, { once: true });
                requireThat(!signal?.aborted, "evaluator-cancelled");
                if (observedFailure) throw observedFailure;
                stage = "authority-check";
                if (authorize) await authorize();
                requireThat(!signal?.aborted, "evaluator-cancelled");
                stage = "send"; sendInvoked = true;
                const response = await session.sendAndWait({ prompt: JSON.stringify(request.input), responseSchema: request.responseSchema }, 120000);
                stage = "response-check";
                signal?.removeEventListener("abort", abort);
                requireThat(!signal?.aborted, "evaluator-cancelled");
                if (observedFailure) throw observedFailure;
                requireThat(response?.type === "assistant.message" && typeof response.data?.content === "string"
                    && response.data.content.length <= 131072, "evaluator-response-unavailable");
                responseReceived = true;
                stage = "response-parse";
                let data;
                try { data = JSON.parse(response.data.content); }
                catch (error) {
                    if (!(error instanceof SyntaxError)) throw error;
                    throw new Error("evaluator-response-not-json");
                }
                stage = "response-shape";
                requireThat(data && Object.getPrototypeOf(data) === Object.prototype, "evaluator-response-not-object");
                result = {
                    reservationId: reservation.reservationId, packetHash: request.packetHash, model: request.model,
                    rawResult: data,
                };
            } catch (error) {
                failure = withEvaluationDiagnostic(error, createEvaluationDiagnostic(error, {
                    stage, sendInvoked, responseObserved: responseReceived, sessionError, sendRpc: transport?.snapshot() ?? null,
                }));
            }
            finally {
                signal?.removeEventListener("abort", abort);
                const errors = [], cleanupStages = [];
                try { unsubscribe?.(); } catch (error) { errors.push(error); cleanupStages.push("event-unsubscribe"); }
                try { transport?.restore(); } catch (error) { errors.push(error); cleanupStages.push("transport-observer-restore"); }
                if (failure && session) abort();
                if (abortWork) await abortWork;
                if (abortFailure) { errors.push(abortFailure); cleanupStages.push("session-abort"); }
                if (session) {
                    try { await session.disconnect(); } catch (error) { errors.push(error); cleanupStages.push("session-disconnect"); }
                }
                if (client) try {
                    const stopped = await client.stop();
                    if (Array.isArray(stopped) && stopped.length) { errors.push(...stopped); cleanupStages.push("sdk-stop"); }
                } catch (error) { errors.push(error); cleanupStages.push("sdk-stop"); }
                if (errors.length) {
                    cleanupFailed = true;
                    const primary = readEvaluationDiagnostic(failure);
                    failure = new AggregateError([...(failure ? [failure] : []), ...errors], "Evaluator or owned-session cleanup failed; do not repeat the reserved call.");
                    failure.code = "EVALUATOR_CLEANUP_FAILED";
                    withEvaluationDiagnostic(failure, createEvaluationDiagnostic(failure, {
                        stage: primary?.stage ?? cleanupStages[0], sendInvoked, responseObserved: responseReceived, cleanupStages,
                        sessionError: primary?.sessionError ?? sessionError, sendRpc: primary?.sendRpc ?? transport?.snapshot() ?? null,
                        numericErrorCode: primary?.numericErrorCode,
                    }));
                }
            }
            if (failure) {
                if (!(failure instanceof Error)) failure = new Error("The evaluator failed without an error record.");
                failureCosts.set(failure, Object.freeze(overhead()));
                throw failure;
            }
            return { ...result, evaluatorCost: overhead() };
        },
    };
}
