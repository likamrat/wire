import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { BoardError, exclusiveBoard, resolveDataDir, writeExclusive } from "./store.mjs";
import { deletionHash, filterDeletedRecords, recordUnits, activityDeletionVersion, LOCAL_DELETION_IDENTITY_VERSION } from "./deletion-identities.mjs";
import { collectorFor } from "./collector.mjs";
import { time } from "./time.mjs";
import { deletionInventory, inventoryRecords, deletionMaterializations, captureRevocationMaterializations, artifactDeletionPlan, safeDeletionFile, stageDeletion, finishDeletionFiles } from "./deletion-storage.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function validScope(input) {
    if (!input || Object.keys(input).some(key => !["scope", "from", "to", "timeContext"].includes(key))
        || !["all", "range"].includes(input.scope)) throw new BoardError("Choose all collected activity or a custom date range.", 422);
    try {
        const context = time.normalize(input.timeContext);
        if (input.scope === "all") {
            if (input.from !== undefined || input.to !== undefined) throw new Error("All activity cannot have date boundaries.");
            return { scope: "all", timeContext: context };
        }
        time.calendar(input.from); time.calendar(input.to);
        const bounds = time.range({ from: input.from, to: input.to }, context.timeZone);
        return { scope: "range", from: input.from, to: input.to, timeContext: context, bounds };
    } catch (error) { throw new BoardError(error.message, 422); }
}

export function createDeletionController(session, {
    now = Date.now, afterSeal, coordinateRecorder = work => work(),
    selectPersonalEvaluationCleanup, finalizePersonalEvaluationCleanup, describeSavedArtifact, onSeal,
} = {}) {
    const root = resolveDataDir(session), previews = new Map(), active = new Map();
    const coordinate = work => coordinateRecorder(() => collectorFor(session)?.exclusiveActivity(work) ?? work());
    async function buildPlan(state, scope) {
        if (state.deletion?.pending) throw new BoardError("An earlier deletion has incomplete cleanup. Restart the runtime to finish its sealed operation first.", 409);
        const files = await deletionInventory(root);
        const activeUnits = (state.evidence ?? []).flatMap(recordUnits);
        const units = [...activeUnits.toSorted((a, b) => Number(a.record.isLegacy === true) - Number(b.record.isLegacy === true)),
            ...inventoryRecords(files).flatMap(recordUnits)];
        const clusters = [], aliases = new Map();
        for (const unit of units) {
            const existing = [...new Set(unit.aliases.map(id => aliases.get(id)).filter(Boolean))];
            const cluster = existing.sort((a, b) => a.index - b.index)[0] ?? { index: clusters.length, first: unit, aliases: new Set(), units: [] };
            if (!existing.length) clusters.push(cluster);
            for (const other of existing) if (other !== cluster) {
                other.units.forEach(value => cluster.units.push(value));
                other.aliases.forEach(id => { cluster.aliases.add(id); aliases.set(id, cluster); });
                other.merged = true;
            }
            cluster.units.push(unit);
            unit.aliases.forEach(id => { aliases.set(id, cluster); cluster.aliases.add(id); });
        }
        const target = clusters.filter(cluster => !cluster.merged).filter(({ first: unit }) => {
            if (scope.scope === "all") return true;
            try { time.instant(unit.at); } catch { return false; }
            const value = Date.parse(unit.at);
            return value >= Date.parse(scope.bounds.from) && value < Date.parse(scope.bounds.to);
        });
        const identitySet = new Set(target.flatMap(cluster => [...cluster.aliases]));
        const identities = [...identitySet].sort();
        const affected = activeUnits.filter(unit => unit.aliases.some(id => identitySet.has(id)));
        const groups = new Set(affected.map(unit => unit.record.scenarioId));
        let remaining = filterDeletedRecords(state.evidence ?? [], { identities });
        const survivingGroups = new Set(remaining.map(record => record.scenarioId));
        const materializations = await deletionMaterializations(root, files, {
            schemaVersion: 1,
            epoch: activityDeletionVersion(state) + 1,
            events: state.deletion?.events, contextCalls: state.deletion?.contextCalls,
            ...(state.deletion?.promptAuthorizations ? { promptAuthorizations: Object.fromEntries(
                Object.entries(state.deletion.promptAuthorizations).map(([event, aliases]) => [event, aliases.filter(id => !identitySet.has(id))])
                    .filter(([, aliases]) => aliases.length),
            ) } : {}),
            identities: [...new Set([...(state.deletion?.identities ?? []), ...identities])],
        }, scope, remaining, { personalEvaluation: state.personalEvaluation, selectPersonalEvaluationCleanup });
        remaining = filterDeletedRecords(remaining, materializations.deletion);
        const activeAliases = new Set(activeUnits.flatMap(unit => unit.aliases));
        const removeCards = Object.keys(state.cards).filter(id => !survivingGroups.has(id) && (scope.scope === "all" || groups.has(id)));
        const personalChanged = JSON.stringify(state.personalEvaluation) !== JSON.stringify(materializations.personalEvaluation);
        return { identities, remaining, removeCards, actions: materializations.actions, markers: materializations.deletion,
            personalEvaluation: materializations.personalEvaluation, linkedInsights: materializations.linkedInsights,
            counts: { records: target.length, requestGroups: groups.size, partialGroups: [...groups].filter(id => survivingGroups.has(id)).length,
                anonymousRecords: target.filter(cluster => cluster.first.local).length,
                anonymousToolCalls: target.filter(cluster => cluster.first.local && cluster.first.family === "toolCalls").length,
                anonymousGraphRecords: target.filter(cluster => cluster.first.local && cluster.first.family === "graphActivities").length,
                anonymousDiagnostics: target.filter(cluster => cluster.first.local && cluster.first.family === "httpRecords").length,
                toolCalls: target.filter(cluster => cluster.first.family === "toolCalls").length,
                graphRecords: target.filter(cluster => cluster.first.family === "graphActivities").length,
                diagnostics: target.filter(cluster => cluster.first.family === "httpRecords").length,
                other: target.filter(cluster => cluster.first.family === "empty").length,
                retainedOnly: target.filter(cluster => ![...cluster.aliases].some(id => activeAliases.has(id))).length,
                savedReports: state.exports.filter(entry => entry.kind !== "comparison").length,
                savedComparisons: state.exports.filter(entry => entry.kind === "comparison").length,
                localCopies: materializations.actions.length + Number(removeCards.length > 0 || personalChanged), reviewStates: removeCards.length,
                undatedPreserved: scope.scope === "all" ? 0 : clusters.filter(cluster => {
                    if (cluster.merged) return false;
                    try { time.instant(cluster.first.at); return false; } catch { return true; }
                }).length },
        };
    }
    async function plan(state, scope) {
        try { return await buildPlan(state, scope); }
        catch (error) {
            if (["LEGACY_LOCAL_DELETION_IDENTITY", "AMBIGUOUS_LOCAL_DELETION_IDENTITY"].includes(error.code)) throw new BoardError(error.message, 409);
            throw error;
        }
    }
    const publicResult = operation => {
        const { ownerHash, cleanup, receiptHash, ...result } = operation;
        return result;
    };
    function artifactReceiptAllowed(operation, owner, receiptToken) {
        return typeof owner === "string" && operation.ownerHash === deletionHash(owner)
            || typeof receiptToken === "string" && /^[a-f0-9]{64}$/.test(receiptToken)
                && operation.receiptHash === deletionHash(receiptToken);
    }
    function confirmation(input) {
        if (!input || Object.keys(input).some(key => !["operationId", "confirmed"].includes(key)) || !uuid.test(input.operationId) || input.confirmed !== true) {
            throw new BoardError("Explicit deletion confirmation is required.", 422);
        }
    }
    return {
        async preview(owner, input) {
            const scope = validScope(input);
            return exclusiveBoard(session, async state => {
                const target = await plan(state, scope);
                for (const [id, preview] of previews) if (preview.owner === owner || preview.expires < now()) previews.delete(id);
                if (previews.size >= 128) throw new BoardError("Too many deletion previews. Close unused panels.", 429);
                const operationId = randomUUID(), expires = now() + 120000;
                const preview = { owner, kind: "activity-deletion", operationId, revision: state.revision, scope, expires, targetHash: deletionHash(JSON.stringify(target)) };
                previews.set(operationId, preview);
                return { operationId, revision: state.revision, scope, expiresAt: new Date(expires).toISOString(), counts: target.counts, linkedInsights: target.linkedInsights };
            });
        },
        async confirm(owner, input) {
            confirmation(input);
            if (active.has(input.operationId)) {
                if (active.get(input.operationId).ownerHash !== deletionHash(owner)) throw new BoardError("Deletion belongs to another panel.", 403);
                if (active.get(input.operationId).kind !== "activity-deletion") throw new BoardError("Cleanup operation belongs to another action.", 409);
                return { operationId: input.operationId, phase: "in-progress" };
            }
            active.set(input.operationId, { ownerHash: deletionHash(owner), kind: "activity-deletion" });
            try { return await coordinate(() => exclusiveBoard(session, async (state, save) => {
                const prior = state.deletion?.operations?.[input.operationId];
                if (prior) {
                    if (prior.ownerHash !== deletionHash(owner)) throw new BoardError("Deletion belongs to another panel.", 403);
                    if (prior.kind && prior.kind !== "activity-deletion") throw new BoardError("Cleanup operation belongs to another action.", 409);
                    return publicResult(prior);
                }
                const preview = previews.get(input.operationId);
                if (!preview || preview.owner !== owner || preview.kind !== "activity-deletion") throw new BoardError("Deletion preview not found for this panel. Preview again.", 409);
                previews.delete(input.operationId);
                const target = await plan(state, preview.scope);
                if (preview.expires < now() || state.revision !== preview.revision || deletionHash(JSON.stringify(target)) !== preview.targetHash) throw new BoardError("Collected activity changed or the preview expired. Nothing deleted. Preview and confirm again.", 409);
                if (!target.counts.records && !target.counts.localCopies) throw new BoardError("No collected records match. Nothing deleted.", 422);
                const content = JSON.stringify({ records: target.remaining, importCoverage: state.importCoverage });
                const name = `${deletionHash(content)}.json`;
                const cleanup = await stageDeletion(root, input.operationId, target.actions);
                await mkdir(await safeDeletionFile(root, "private-evidence"), { recursive: true });
                try { await writeExclusive(await safeDeletionFile(root, path.join("private-evidence", name)), content); }
                catch (error) { if (error.code !== "EEXIST") throw error; }
                const operation = { operationId: input.operationId, kind: "activity-deletion", ownerHash: deletionHash(owner), phase: "pending", counts: target.counts,
                    localIdentityVersion: LOCAL_DELETION_IDENTITY_VERSION,
                    linkedInsights: target.linkedInsights, startedAt: new Date(now()).toISOString(),
                    cleanup };
                state.deletion = { ...target.markers,
                    operations: { ...state.deletion?.operations, [operation.operationId]: operation }, pending: operation.operationId };
                if (JSON.stringify(state.evidence ?? []) !== JSON.stringify(target.remaining)) state.evidenceRevision = (state.evidenceRevision ?? state.revision) + 1;
                state.evidenceFile = name;
                Object.defineProperty(state, "evidence", { value: target.remaining, configurable: true });
                if (target.personalEvaluation !== undefined) state.personalEvaluation = target.personalEvaluation;
                const removeCards = new Set(target.removeCards);
                state.cards = Object.fromEntries(Object.entries(state.cards).filter(([id]) => !removeCards.has(id)));
                state.revision++;
                await save(state);
                await onSeal?.(state, operation);
                await afterSeal?.();
                await finishDeletionFiles(root, operation);
                operation.phase = "complete";
                operation.completedAt = new Date(now()).toISOString();
                delete operation.cleanup;
                delete state.deletion.pending;
                await save(state);
                return publicResult(operation);
            })); } finally { active.delete(input.operationId); }
        },
        async previewArtifact(owner, scope) {
            if (!scope || Object.keys(scope).some(key => !["artifactKind", "artifactId"].includes(key))
                || !["report", "comparison"].includes(scope.artifactKind) || !/^export-[a-f0-9-]{36}$/.test(scope.artifactId ?? "")) {
                throw new BoardError("Choose one saved report or comparison by its ID.", 422);
            }
            if (typeof describeSavedArtifact !== "function") throw new BoardError("Saved-artifact deletion is not connected.", 503);
            return exclusiveBoard(session, async state => {
                if (state.deletion?.pending) throw new BoardError("An earlier cleanup is still pending.", 409);
                const target = await artifactDeletionPlan(root, state, await describeSavedArtifact(state, scope));
                for (const [id, preview] of previews) if (preview.owner === owner || preview.expires < now()) previews.delete(id);
                if (previews.size >= 128) throw new BoardError("Too many deletion previews. Close unused panels.", 429);
                const operationId = randomUUID(), receiptToken = randomBytes(32).toString("hex"), expires = now() + 120000;
                const artifactRevision = state.artifactDeletion?.revision ?? 0;
                previews.set(operationId, { owner, kind: "artifact-deletion", scope: structuredClone(scope), expires,
                    artifactRevision, receiptHash: deletionHash(receiptToken), targetHash: deletionHash(JSON.stringify(target)) });
                return { operationId, receiptToken, revision: state.revision, artifactRevision,
                    expiresAt: new Date(expires).toISOString(), artifact: target.artifact, counts: target.counts };
            });
        },
        async confirmArtifact(owner, input) {
            confirmation(input);
            if (typeof describeSavedArtifact !== "function") throw new BoardError("Saved-artifact deletion is not connected.", 503);
            const existing = active.get(input.operationId);
            if (existing) {
                if (existing.ownerHash !== deletionHash(owner)) throw new BoardError("Deletion belongs to another panel.", 403);
                if (existing.kind !== "artifact-deletion") throw new BoardError("Cleanup operation belongs to another action.", 409);
                return { operationId: input.operationId, phase: "in-progress" };
            }
            const candidate = previews.get(input.operationId);
            if (candidate && (candidate.owner !== owner || candidate.kind !== "artifact-deletion")) throw new BoardError("Saved-artifact preview not found for this panel.", 409);
            active.set(input.operationId, { ownerHash: deletionHash(owner), kind: "artifact-deletion", receiptHash: candidate?.receiptHash });
            try { return await coordinate(() => exclusiveBoard(session, async (state, save) => {
                const prior = state.deletion?.operations?.[input.operationId];
                if (prior) {
                    if (prior.ownerHash !== deletionHash(owner)) throw new BoardError("Deletion belongs to another panel.", 403);
                    if (prior.kind !== "artifact-deletion") throw new BoardError("Cleanup operation belongs to another action.", 409);
                    return publicResult(prior);
                }
                if (state.deletion?.pending) throw new BoardError("An earlier cleanup is still pending.", 409);
                const preview = previews.get(input.operationId);
                if (!preview || preview.owner !== owner || preview.kind !== "artifact-deletion") throw new BoardError("Saved-artifact preview expired or was cancelled. Preview again.", 409);
                previews.delete(input.operationId);
                const target = await artifactDeletionPlan(root, state, await describeSavedArtifact(state, preview.scope));
                if (preview.expires < now() || preview.artifactRevision !== (state.artifactDeletion?.revision ?? 0)
                    || preview.targetHash !== deletionHash(JSON.stringify(target))) throw new BoardError("Saved artifact or its managed copies changed. Nothing deleted; preview again.", 409);
                const cleanup = await stageDeletion(root, input.operationId, target.actions);
                const operation = {
                    operationId: input.operationId, kind: "artifact-deletion", ownerHash: deletionHash(owner), receiptHash: preview.receiptHash,
                    artifact: target.artifact, artifactRevision: target.artifactDeletion.revision, counts: target.counts,
                    phase: "pending", startedAt: new Date(now()).toISOString(), cleanup,
                };
                state.exports = state.exports.filter(entry => entry.bundleId !== target.artifact.artifactId);
                state.artifactDeletion = target.artifactDeletion;
                state.deletion = { schemaVersion: 1, identities: [], events: [], contextCalls: [], ...state.deletion,
                    operations: { ...state.deletion?.operations, [operation.operationId]: operation }, pending: operation.operationId };
                state.revision++;
                await save(state);
                await onSeal?.(state, operation);
                await afterSeal?.();
                await finishDeletionFiles(root, operation);
                operation.phase = "complete";
                operation.completedAt = new Date(now()).toISOString();
                delete operation.cleanup;
                delete state.deletion.pending;
                await save(state);
                return publicResult(operation);
            })); } finally { active.delete(input.operationId); }
        },
        async status(operationId, owner, receiptToken) {
            if (!uuid.test(operationId)) throw new BoardError("Invalid deletion operation identity.", 422);
            const running = active.get(operationId);
            if (running) {
                if (running.kind === "artifact-deletion" && !artifactReceiptAllowed(running, owner, receiptToken)) throw new BoardError("Saved-artifact receipt belongs to another panel.", 403);
                return { operationId, phase: "in-progress" };
            }
            return exclusiveBoard(session, state => {
                const operation = state.deletion?.operations?.[operationId];
                if (operation?.kind === "artifact-deletion" && !artifactReceiptAllowed(operation, owner, receiptToken)) throw new BoardError("Saved-artifact receipt belongs to another panel.", 403);
                return operation ? publicResult(operation) : { operationId, phase: "not-started" };
            });
        },
        cancel(owner, operationId) {
            if (!uuid.test(operationId)) throw new BoardError("Invalid deletion operation identity.", 422);
            if (previews.get(operationId)?.owner === owner) previews.delete(operationId);
            return { cancelled: true };
        },
        async commitCaptureRevocation(state, save, { owner, operationId, revokedConsentRevision }) {
            if (typeof owner !== "string" || !uuid.test(operationId) || !Number.isSafeInteger(revokedConsentRevision) || revokedConsentRevision < 0
                || typeof save !== "function" || typeof selectPersonalEvaluationCleanup !== "function" || typeof finalizePersonalEvaluationCleanup !== "function"
                || !["enabled", "revoked"].includes(state.personalEvaluation?.consent.state) || state.personalEvaluation.consent.revision <= revokedConsentRevision) {
                throw new BoardError("Capture revocation cleanup is not connected to a validated consent change.", 503);
            }
            const prior = state.deletion?.operations?.[operationId];
            if (prior) {
                if (prior.kind !== "capture-revocation" || prior.ownerHash !== deletionHash(owner)) throw new BoardError("Cleanup operation identity was already used.", 409);
                return publicResult(prior);
            }
            if (state.deletion?.pending) throw new BoardError("An earlier cleanup is still pending.", 409);
            const files = await deletionInventory(root, { includeActivity: false });
            const target = captureRevocationMaterializations(files, state, revokedConsentRevision, selectPersonalEvaluationCleanup);
            const cleanup = await stageDeletion(root, operationId, target.actions);
            const operation = {
                operationId, kind: "capture-revocation", ownerHash: deletionHash(owner), phase: "pending",
                counts: { records: 0, localCopies: target.actions.length }, linkedInsights: target.linkedInsights,
                startedAt: new Date(now()).toISOString(), cleanup,
            };
            state.personalEvaluation = target.personalEvaluation;
            state.deletion = { schemaVersion: 1, identities: [], events: [], contextCalls: [], ...state.deletion,
                epoch: activityDeletionVersion(state) + 1, operations: { ...state.deletion?.operations, [operationId]: operation }, pending: operationId };
            state.revision++;
            await save(state);
            await onSeal?.(state, operation);
            await afterSeal?.();
            await finishDeletionFiles(root, operation);
            operation.phase = "complete";
            operation.completedAt = new Date(now()).toISOString();
            delete operation.cleanup;
            delete state.deletion.pending;
            finalizePersonalEvaluationCleanup(state, operationId);
            await save(state);
            return publicResult(operation);
        },
        async recover() {
            return exclusiveBoard(session, async (state, save) => {
                if (!state.deletion?.pending) return;
                const operation = state.deletion.operations[state.deletion.pending];
                if (!operation || !uuid.test(operation.operationId) || operation.phase !== "pending" || !Array.isArray(operation.cleanup)) throw new BoardError("Invalid deletion recovery journal.", 503);
                await onSeal?.(state, operation);
                await finishDeletionFiles(root, operation);
                operation.phase = "complete";
                operation.completedAt = new Date(now()).toISOString();
                delete operation.cleanup;
                delete state.deletion.pending;
                if (operation.kind === "capture-revocation") {
                    if (typeof finalizePersonalEvaluationCleanup !== "function") throw new BoardError("Capture cleanup recovery is not connected.", 503);
                    finalizePersonalEvaluationCleanup(state, operation.operationId);
                }
                await save(state);
            });
        },
    };
}
