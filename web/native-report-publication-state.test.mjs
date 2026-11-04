import test from "node:test";
import assert from "node:assert/strict";
import { createNativeReportPublicationState } from "./native-report-publication-state.mjs";

const ready = { schemaVersion: 1, available: true, reason: null };
const unavailable = { schemaVersion: 1, available: false, reason: "runtime-unqualified" };
const context = () => ({ kind: "report", mode: "enforced", collectionMode: "source-aware", runtimeId: "runtime",
    publication: {}, owner: {}, revision: 7, draftToken: 3, scope: "original-selection" });
const preview = (extra = {}) => ({ previewId: "preview", bundleId: "bundle", revision: 7, expiresInSeconds: 600,
    nativeReportPublication: ready, privacy: { allSelectedFieldsScanned: true, inputFingerprint: "fingerprint" }, ...extra });

test("publication readiness is a closed consistent pair and never disclosure approval", () => {
    const model = createNativeReportPublicationState({ now: () => 0 }), stamp = context();
    assert.deepEqual(model.decode(ready), ready);
    assert.deepEqual(model.decode(unavailable), unavailable);
    for (const value of [undefined, {}, { ...ready, reason: "runtime-unqualified" }, { ...unavailable, reason: null },
        { ...ready, available: "true" }, { ...ready, extra: true }]) assert.throws(() => model.decode(value), TypeError);
    model.snapshot(ready, stamp);
    model.preview(preview(), stamp, 0);
    assert.equal(model.canSave(stamp), false, "Code readiness cannot approve disclosure.");
});

test("Save requires the original ready snapshot, preview and real reviewed result without extending expiry", () => {
    let clock = 100;
    const model = createNativeReportPublicationState({ now: () => clock }), stamp = context(), value = preview();
    model.snapshot(ready, stamp);
    assert.equal(model.preview(value, stamp, clock), true);
    const reviewed = { ...value, privacy: { ...value.privacy, reviewerConfirmed: true } };
    delete reviewed.expiresInSeconds;
    clock = 500000;
    assert.equal(model.review(reviewed, stamp), true);
    assert.equal(model.canSave(stamp), true);
    assert.equal(model.expired(), false);
    clock = 600100;
    assert.equal(model.expired(), true);
    assert.equal(model.deadline(), 600100, "Inspecting expiry must not extend or discard the original deadline.");
    assert.equal(model.canSave(stamp), false, "Review must not renew the original preview budget.");
    assert.equal(model.expired(), true, "A Save check crossing the deadline must still let the journey retire the expired preview.");
    assert.match(model.reason(), /expired/);
    assert.equal(model.canSave(stamp), false);
    assert.match(model.reason(), /expired/, "Repeated UI paints must preserve the withdrawal reason.");
});

test("unbound, native-only and comparison contexts cannot acquire Save from injected readiness", () => {
    for (const change of [{ mode: "unbound" }, { collectionMode: undefined }, { kind: "comparison" }]) {
        const model = createNativeReportPublicationState({ now: () => 0 }), stamp = { ...context(), ...change }, value = preview();
        model.snapshot(ready, stamp);
        model.preview(value, stamp, 0);
        model.review({ ...value, privacy: { ...value.privacy, reviewerConfirmed: true } }, stamp);
        assert.equal(model.canSave(stamp), false);
    }
});

test("changed original context, withdrawal and missing readiness retire approval without rebasing", () => {
    const value = preview(), reviewed = { ...value, privacy: { ...value.privacy, reviewerConfirmed: true } };
    for (const change of [{ publication: {} }, { owner: {} }, { runtimeId: "replacement" }, { revision: 8 },
        { draftToken: 4 }, { scope: "different-selection" }]) {
        const model = createNativeReportPublicationState({ now: () => 0 }), stamp = context();
        model.snapshot(ready, stamp); model.preview(value, stamp, 0); model.review(reviewed, stamp);
        assert.equal(model.canSave({ ...stamp, ...change }), false);
        assert.equal(model.canSave(stamp), false);
    }
    for (const missing of [undefined, unavailable, { ...ready, unknown: true }]) {
        const model = createNativeReportPublicationState({ now: () => 0 }), stamp = context();
        model.snapshot(ready, stamp); model.preview(value, stamp, 0); model.review(reviewed, stamp);
        model.snapshot(missing, stamp);
        assert.equal(model.canSave(stamp), false);
        model.snapshot(ready, stamp);
        assert.equal(model.canSave(stamp), false);
    }
    const model = createNativeReportPublicationState({ now: () => 0 }), stamp = context();
    model.snapshot(ready, stamp); model.preview(value, stamp, 0); model.review(reviewed, stamp);
    model.withdraw(); model.snapshot(ready, stamp);
    assert.equal(model.canSave(stamp), false);
});

test("review cannot adopt another preview, scan or availability and serialization keeps the same contract", () => {
    const value = preview();
    for (const change of [{ previewId: "other" }, { bundleId: "other" }, { revision: 8 },
        { nativeReportPublication: unavailable }, { nativeReportPublication: undefined },
        { privacy: { ...value.privacy, reviewerConfirmed: true, inputFingerprint: "changed" } }]) {
        const factory = Function(`return (${createNativeReportPublicationState.toString()})`)();
        const model = factory({ now: () => 0 }), stamp = context();
        model.snapshot(ready, stamp); model.preview(value, stamp, 0);
        assert.equal(model.review({ ...value, privacy: { ...value.privacy, reviewerConfirmed: true }, ...change }, stamp), false);
        assert.equal(model.canSave(stamp), false);
    }
});
