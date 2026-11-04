import test from "node:test";
import assert from "node:assert/strict";
import { createCollectionStatus } from "../lib/collection-status.mjs";

const presentation = createCollectionStatus();
const status = () => ({
    nativePersistence: {
        schemaVersion: 1, kind: "native-account-unavailable", reason: "microsoft-account-not-configured",
        generation: 2, authorizationRevision: 4, revision: 7, rawWriterAdmission: "withheld",
        configured: false, configuration: null, actions: [], blockers: ["NATIVE_RETENTION_ACCOUNT_UNAVAILABLE"],
    },
});
const snapshot = () => ({
    scenarios: [],
    nativeRead: { status: "unavailable", reason: "microsoft-account-not-configured",
        revision: "a".repeat(64), generation: 2, authorizationRevision: 4 },
});

test("account-unavailable metadata is distinct from screened readback or a collection capability", () => {
    const value = status(), data = snapshot();
    assert.equal(presentation.persistence(value), null);
    assert.equal(presentation.nativeUnavailable(value), value.nativePersistence);
    assert.equal(presentation.nativeUnavailableMatches(data, value), true);
    assert.equal(presentation.nativeReadbackCurrent(data, value), false);
    for (const forbidden of ["accountRef", "receipt", "receiptQuery", "readback"]) {
        assert.throws(() => presentation.nativeUnavailable({
            nativePersistence: { ...value.nativePersistence, [forbidden]: null },
        }), TypeError);
    }
    assert.throws(() => presentation.nativeUnavailable({
        nativePersistence: { ...value.nativePersistence, actions: ["collect-now"] },
    }), TypeError);
});

test("global committed configuration is readable without becoming an account grant", () => {
    const value = status();
    value.nativePersistence.configuration = {
        configurationRevision: 1, privacyRevision: 1, policy: "native-screened-source-observations-v1",
        settings: { paused: true, windowDays: 7 }, surfaces: ["cowork"],
    };
    assert.equal(presentation.persistence(value), null);
    assert.equal(presentation.nativeUnavailable(value).configured, false);
    assert.equal(presentation.nativeUnavailableMatches(snapshot(), value), true);
    value.nativePersistence.configuration.settings.extra = true;
    assert.throws(() => presentation.nativeUnavailable(value), TypeError);
});

test("setup metadata must match generation and never regress observed authority or status", () => {
    const value = status();
    const observed = { generation: 2, authorizationRevision: 3 };
    assert.equal(presentation.nativeUnavailableCurrent(value, observed), true, "A newer response need not wait for a lagging watch.");
    assert.equal(presentation.nativeUnavailableCurrent(value, { ...observed, generation: 3 }), false);
    assert.equal(presentation.nativeUnavailableCurrent(value, { ...observed, authorizationRevision: 5 }), false);
    assert.equal(presentation.nativeUnavailableCurrent(value, null), false);
    const previous = status();
    previous.nativePersistence.authorizationRevision = 5;
    assert.equal(presentation.nativeUnavailableCurrent(value, observed, previous), false);
    previous.nativePersistence.authorizationRevision = 4;
    previous.nativePersistence.revision++;
    assert.equal(presentation.nativeUnavailableCurrent(value, observed, previous), false);
});

test("unavailable metadata rejects native content, readback and changed same-generation authority", () => {
    const value = status(), data = snapshot();
    assert.equal(presentation.nativeUnavailableMatches({ ...data, scenarios: [{ recordKind: "native-conversation" }] }, value), false);
    assert.equal(presentation.nativeUnavailableMatches({ ...data, nativeRead: { ...data.nativeRead, readback: null } }, value), false);
    assert.equal(presentation.nativeUnavailableMatches({ ...data, nativeRead: { ...data.nativeRead, authorizationRevision: 5 } }, value), false);
    assert.equal(presentation.nativeUnavailableMatches({ ...data, analytics: { rows: [{ countUnit: "native-tool-call" }] } }, value), false);
    assert.equal(presentation.nativeUnavailableMatches({ ...data, analytics: { population: { nativeConversationKeys: ["not-available"] } } }, value), false);
    const nativeControl = { kind: "native-read-only", scope: "registered-native-read", writerAdmission: "withheld",
        revision: 4, retained: true, enabled: false, connected: false, canPause: false, canResume: false };
    assert.equal(presentation.page({ ...value, nativeControl }).label, "Microsoft account not connected");
});

test("known-account SCREENED readback and legacy controls retain their separate contracts", () => {
    const value = { nativePersistence: {
        schemaVersion: 1, kind: "native-screened-retention", contractVersion: "m365-native-screened-observations-v1",
        rawWriterAdmission: "withheld", configured: true, accountRef: "synthetic-account-reference",
        generation: 2, revision: 7, configuration: {
            configurationRevision: 1, privacyRevision: 1, policy: "native-screened-source-observations-v1",
            settings: { paused: false, windowDays: 7 }, surfaces: ["chat"],
        }, actions: ["collect-now"], blockers: [], receipt: null, receiptQuery: null,
    } };
    const read = { nativeRead: { generation: 2, readback: { schemaVersion: 1, accountRef: "synthetic-account-reference",
        current: { generation: 2, configurationRevision: 1, privacyRevision: 1 } } } };
    assert.equal(presentation.nativeUnavailable(value), null);
    assert.equal(presentation.persistence(value), value.nativePersistence);
    assert.equal(presentation.nativeReadbackCurrent(read, value), true);
    assert.equal(presentation.nativeUnavailableCurrent(value, { generation: 2, authorizationRevision: 4 }), false);
    assert.equal(presentation.nativeUnavailable({ state: "paused" }), null);
    assert.equal(presentation.persistence({ state: "paused" }), null);
});
