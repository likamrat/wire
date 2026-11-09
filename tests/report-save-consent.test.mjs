import test from "node:test";
import assert from "node:assert/strict";
import {
    reportLocalSaveRequest, confirmReportLocalSave, hasReportSaveAuthorization,
    assertReportSaveAuthorization, reportSaveAuthorizationSummary,
} from "../lib/report-save-consent.mjs";

const manifest = (promptMode = "masked") => ({
    kind: "report", bundleId: "export-123", snapshotHash: "a".repeat(64), promptMode, formats: ["html"], savePolicy: "local-save-v1",
    files: { "product-report.html": { sha256: "b".repeat(64), bytes: 42 } },
    privacyReview: { reviewerConfirmed: false, reviewerIdentityVerified: false },
});
const confirm = value => ({
    ...value, privacyReview: confirmReportLocalSave(value, {
        ...reportLocalSaveRequest(value), keepChatDetailsConfirmed: value.promptMode === "original",
    }),
});

test("local saving binds prepared bytes without recording a human disclosure attestation", () => {
    const saved = confirm(manifest());
    assert.equal(saved.privacyReview.reviewerConfirmed, false);
    assert.equal(saved.privacyReview.localSave.method, "explicit-local-save");
    const registration = { privacyReview: reportSaveAuthorizationSummary(saved.privacyReview) };
    assert.equal(assertReportSaveAuthorization(saved, registration), true);
    const changed = structuredClone(saved);
    changed.files["product-report.html"].bytes++;
    assert.throws(() => assertReportSaveAuthorization(changed, registration), /contents/);
    const wrongRegistration = structuredClone(registration);
    wrongRegistration.privacyReview.localSave.contentHash = "c".repeat(64);
    assert.throws(() => assertReportSaveAuthorization(saved, wrongRegistration), /differs/);
});

test("keeping chat details needs its specific confirmation, and does not authorize a masked replacement", () => {
    const source = manifest("original"), request = { ...reportLocalSaveRequest(source), keepChatDetailsConfirmed: false };
    assert.throws(() => confirmReportLocalSave(source, request), /chat details/);
    const saved = confirm(source);
    assert.equal(assertReportSaveAuthorization(saved), true);
    assert.throws(() => confirmReportLocalSave(manifest(), {
        ...reportLocalSaveRequest(source), keepChatDetailsConfirmed: true,
    }), /changed/);
});

test("historical disclosure approval remains distinct and incomplete local intent is never approval", () => {
    assert.equal(hasReportSaveAuthorization({ reviewerConfirmed: true }), true);
    assert.equal(hasReportSaveAuthorization({ reviewerConfirmed: false }), false);
    assert.equal(hasReportSaveAuthorization({ reviewerConfirmed: false, localSave: { version: 1 } }), false);
    assert.equal(hasReportSaveAuthorization({ ...confirm(manifest()).privacyReview, reviewerConfirmed: true }), false);
    assert.equal(hasReportSaveAuthorization({ ...confirm(manifest()).privacyReview, confirmedAt: "invalid" }), false);
});
