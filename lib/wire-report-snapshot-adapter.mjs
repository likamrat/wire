import { createWireMetricAdapter } from "./wire-report-metric-adapter.mjs";

const DIMENSIONS = new Set(["accuracy", "speed", "cost", "answer-trust", "action-trust"]);
const LAYERS = Object.freeze(["tool-call", "returned-api-entry", "owned-http", "graph-request-site"]);
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function createWireReportAdapter(contract, { validateEndpoint } = {}) {
    if (!contract || typeof contract.freezeReportFacts !== "function") {
        throw new TypeError("The backend privacy-projected report-facts validator is required.");
    }
    const adaptMetric = createWireMetricAdapter(contract);
    return function adaptReport(snapshot, { bundleId, snapshotHash, disclosureReviewed } = {}) {
        if (disclosureReviewed !== true) throw new TypeError("A report must be disclosure-reviewed before comparison.");
        if (typeof bundleId !== "string" || !/^export-[A-Za-z0-9-]+$/.test(bundleId)
            || typeof snapshotHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshotHash)) {
            throw new TypeError("The selected saved report identity and hash are required.");
        }
        const facts = contract.freezeReportFacts(snapshot, { validateEndpoint });
        const patterns = new Map(), patternForMember = new Map();
        for (const entry of facts.patterns) {
            const patternId = JSON.stringify([entry.pattern.version, entry.pattern.unitKind, entry.pattern.key]);
            const known = patterns.get(patternId);
            if (known && JSON.stringify(known.definition) !== JSON.stringify(entry.pattern)) {
                throw new TypeError("One frozen pattern key has conflicting technical display metadata.");
            }
            if (!known) patterns.set(patternId, {
                patternId,
                definition: structuredClone(entry.pattern),
                unitKind: entry.pattern.unitKind,
                tool: entry.pattern.display.tool,
                workload: entry.pattern.display.workload,
                attribution: entry.pattern.display.attribution,
                targetShape: entry.pattern.targetShape,
                endpoints: structuredClone(entry.pattern.display.endpoints),
                available: true,
            });
            for (const ref of entry.memberRefs) patternForMember.set(ref, patternId);
        }
        const outcomeLayers = Object.fromEntries(LAYERS.map(layer => [layer, []]));
        let missingPatterns = 0;
        for (const outcome of facts.recordedOutcomes) {
            let patternId = patternForMember.get(outcome.memberRef);
            if (!patternId) {
                missingPatterns++;
                patternId = JSON.stringify(["unavailable-pattern", outcome.kind, outcome.memberRef]);
                patterns.set(patternId, {
                    patternId, definition: null, unitKind: outcome.kind, tool: null, workload: "Unknown",
                    attribution: "unavailable", targetShape: "unavailable", endpoints: [], available: false,
                });
            }
            outcomeLayers[outcome.kind].push({ id: outcome.memberRef, patternId, outcome: outcome.outcome });
        }
        for (const rows of Object.values(outcomeLayers)) rows.sort((a, b) => compareText(a.id, b.id));
        const metrics = facts.metrics.filter(metric => DIMENSIONS.has(metric.dimension)).map(adaptMetric);
        if (new Set(metrics.map(metric => metric.comparisonKey)).size !== metrics.length) {
            throw new TypeError("Report metrics must be pooled into unique active comparison identities.");
        }
        const layerCounts = Object.fromEntries([...LAYERS, "graph-code-reference"].map(layer => [
            layer, facts.memberships.reduce((total, membership) => total + membership.members.filter(member => member.kind === layer).length, 0),
        ]));
        return {
            schemaVersion: 1,
            bundleId,
            snapshotHash,
            disclosureReviewed: true,
            preparedAt: facts.preparedAt,
            namespace: { ...facts.namespace },
            // Version 2 is reserved by the legacy outcome-only adapter.
            patternVersion: facts.patterns.some(entry => entry.pattern.version === 3) ? 4 : facts.patterns.some(entry => entry.pattern.version === 2) ? 3 : 1,
            metrics,
            toolRows: outcomeLayers["tool-call"],
            outcomeLayers,
            layerCounts,
            patterns: [...patterns.values()].sort((a, b) => compareText(a.patternId, b.patternId)),
            missingPatterns,
            scope: {
                selectionKind: facts.scope.kind,
                timeZone: facts.scope.timeZone,
                collectionDefinition: null,
                membership: facts.scope.membership,
                selectedFrom: facts.scope.from,
                selectedUntilExclusive: facts.scope.untilExclusive,
                callTimesAvailable: false,
                historyComplete: false,
            },
        };
    };
}

export function verifiedReportIdentityRelation(baseline, later, { namespaceProvenanceVerified = false } = {}) {
    if (!namespaceProvenanceVerified) return "unknown";
    const a = baseline.namespace, b = later.namespace;
    if (!a || !b || typeof a.ref !== "string" || typeof b.ref !== "string"
        || a.version !== b.version || a.identityScheme !== b.identityScheme || a.ref !== b.ref) return "unknown";
    return "same-namespace";
}
