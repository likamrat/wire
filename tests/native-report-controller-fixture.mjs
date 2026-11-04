import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadBoardState, mergeEvidenceWithState } from "../lib/store.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { createMicrosoftNativeReadTransport } from "../lib/microsoft-native-transport.mjs";
import { createMicrosoftSession } from "../lib/microsoft-session.mjs";
import { createNativePersistence } from "../lib/native-persistence.mjs";
import { projectRetainedNativeRecords } from "../lib/retained-population.mjs";
import { coworkFixture } from "./native-read-model-fixtures.mjs";
import { buildSanitizedBundle, writeBundle } from "../lib/export.mjs";
import { nativeConversationIdentity } from "../lib/native-read-model.mjs";
import { assembleNativeReportSelection } from "../lib/native-report-stream.mjs";

export async function preserveReportProof(name, bundle) {
    if (!process.env.WIRE_REPORT_PROOFS) return;
    await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
    for (const [file, value] of Object.entries(bundle.files)) {
        const suffix = file === "coverage-and-redaction-manifest.json" ? "manifest.json" : file.split(".").at(-1);
        const bytes = value?.encoding === "base64" ? Buffer.from(value.data, "base64") : value;
        await writeFile(path.join(process.env.WIRE_REPORT_PROOFS, `${name}.${suffix}`), bytes);
    }
}

export async function committedNativeReportFixture(t, { envelopes = coworkFixture(), segmented = false } = {}) {
    const dataDir = await mkdtemp(path.join(tmpdir(), "wire-native-report-controller-")), context = { dataDir };
    await loadBoardState(context);
    const release = await acquireCollectorLock(dataDir);
    const transport = createMicrosoftNativeReadTransport({
        open: async () => {},
        verifyAccount: async () => ({ tenantId: "invented-tenant", subjectId: "invented-subject", knownAccountMatched: true,
            chat: true, cowork: true, evidence: { kind: "native-account-metadata", issuer: "https://invented.invalid", observedAt: new Date().toISOString() } }),
        stop: async () => ({ processExited: true, profileReleased: true }),
    });
    let persistence;
    const lifecycle = await createMicrosoftSession(context, { transport, collection: { paused: false, windowDays: 30 },
        persistCollectionSettings: (settings, token) => persistence.persistCollectionSettings(settings, token) });
    t.after(async () => { persistence?.close(); await lifecycle.close(); await release(); await rm(dataDir, { recursive: true, force: true }); });
    const owner = "invented-report-owner", admission = { owner, check() {}, dispatched() {} };
    for (const action of ["wire-sign-in", "microsoft-connect"]) {
        await lifecycle.command(owner, { action, operationId: randomUUID(), generation: (await lifecycle.status()).generation,
            ...(action === "microsoft-connect" ? { replace: false } : {}) }, () => true);
    }
    persistence = await createNativePersistence(context, { lifecycle, transport });
    await persistence.configure({ expectedRevision: null, surfaces: ["chat", "cowork"], windowDays: 30 }, admission);
    const begun = await (segmented ? persistence.beginSegmented : persistence.begin)({ operationId: randomUUID() }, admission);
    await (segmented ? persistence.commitSegmented : persistence.commit)(begun.ticket, envelopes);
    persistence.retire(begun.ticket);
    let source;
    if (segmented) {
        const frame = await persistence.reportSource.captureSelection({
            revision: (await loadBoardState(context)).revision,
            sources: [...new Set(envelopes.map(row => `microsoft-365-${row.scope.surface}`))],
            scenarioIds: [...new Set(envelopes.map(row => nativeConversationIdentity(row.scope)))],
        }, admission);
        source = await persistence.reportSource.iterateSelection(frame, admission, async (events, assertCurrent, state) => {
            const assembled = await assembleNativeReportSelection(events, { selection: frame.selection,
                expectations: frame.originalViewExpectations, definitions: frame.source.definitions, key: state.pseudonymKey });
            assertCurrent();
            return { records: assembled.records, definitions: frame.source.definitions };
        });
    } else source = projectRetainedNativeRecords(await persistence.readAuthorized(await lifecycle.lease("microsoft-retained")));
    const services = { nativeReportSource: persistence.reportSource, nativeReportAdmission: admission,
        nativeRecords: source.records, nativeDefinitions: source.definitions };
    return { context, owner, services, persistence, lifecycle };
}

// Existing-format artifacts for frozen-reader regressions, not the admitted
// selection-frame controller or permission to create native reports in the app.
export async function savedNativeReportFixture(app, options = {}, { github = false, writer = writeBundle } = {}) {
    const before = await loadBoardState(app.context);
    const source = app.persistence.reportSource, admission = app.services.nativeReportAdmission;
    const frame = await source.capture({ revision: before.revision,
        scenarioIds: app.services.nativeRecords.map(record => record.scenarioId) }, admission);
    const bundle = await buildSanitizedBundle(github ? mergeEvidenceWithState(before) : [], before.pseudonymKey,
        options, undefined, undefined, undefined, undefined, undefined, frame);
    bundle.privacy = { ...bundle.privacy, reviewerConfirmed: true, confirmedAt: new Date().toISOString() };
    const manifest = JSON.parse(bundle.files["coverage-and-redaction-manifest.json"]);
    manifest.privacyReview = bundle.privacy;
    bundle.files["coverage-and-redaction-manifest.json"] = JSON.stringify(manifest, null, 2);
    let written;
    await source.commit(frame, admission, async (state, assertCurrent) => {
        written = await writer(app.context, bundle, state, { assertCurrent });
        assertCurrent();
        state.exports.push(written);
        state.artifactDeletion ??= { schemaVersion: 1, revision: 0, identities: [] };
        state.artifactDeletion.revision++;
    });
    return { bundle: written, snapshot: bundle.snapshot };
}
