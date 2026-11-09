import test from "node:test";
import assert from "node:assert/strict";
import { createReportDraft, createReportSaveIdentity } from "../web/report-draft.mjs";
import { createReportJourney } from "../web/report-journey.mjs";

function authority() {
    let token = {}, allowed = true;
    return {
        api: { publicationToken: () => allowed ? token : null, isCurrent: value => allowed && value !== null && value === token },
        withdraw() { allowed = false; },
        resume() { token = {}; allowed = true; },
    };
}
const preview = title => ({ previewId: "preview-original", bundleId: "bundle-original", ...(title === undefined ? {} : { title }),
    privacy: { allSelectedFieldsScanned: true }, files: { "product-report.html": "PRIVATE FILE" } });
const saved = title => ({ bundleId: "bundle-original", kind: "report", ...(title === undefined ? {} : { title }),
    files: { "product-report.html": true } });

test("opaque report save verification preserves undefined, empty and explicit title predicates", async () => {
    const { api } = authority();
    for (const title of [undefined, "", "PRIVATE TITLE"]) {
        const owner = createReportSaveIdentity({ kind: "report", api });
        const identity = await owner.prepareSaveIdentity({ ...preview(title), kind: "comparison" });
        assert.equal(identity.kind, "report", "Ordinary kind is not preview-controlled");
        assert.deepEqual(Object.keys(identity).sort(), ["bundleId", "dispatched", "expectedTitleRequired", "fingerprint", "kind", "previewId", "unknown"]);
        assert.equal(identity.expectedTitleRequired, title !== undefined);
        assert.match(identity.fingerprint, /^[a-f0-9]{64}$/);
        assert.doesNotMatch(JSON.stringify(identity), /PRIVATE/);
        assert.equal(await owner.matchesSaveIdentity(saved(title)), true);
        assert.equal(await owner.matchesSaveIdentity({ ...saved(title), kind: undefined }), true);
        assert.equal(await owner.matchesSaveIdentity({ ...saved(title), title: "different" }), title === undefined);
        assert.equal(await owner.matchesSaveIdentity({ ...saved(title), bundleId: "wrong" }), false);
        assert.equal(await owner.matchesSaveIdentity({ ...saved(title), kind: "comparison" }), false);
        if (title !== undefined) assert.equal(await owner.matchesSaveIdentity(saved(undefined)), false);
    }
    const comparison = createReportSaveIdentity({ kind: "comparison", api });
    await comparison.prepareSaveIdentity(preview(undefined));
    assert.equal(await comparison.matchesSaveIdentity({ bundleId: "bundle-original", kind: "comparison" }), true);
    assert.equal(await comparison.matchesSaveIdentity({ bundleId: "bundle-original", kind: "comparison", title: "unexpected" }), false);
    assert.equal(await comparison.matchesSaveIdentity({ bundleId: "bundle-original" }), false);
});

test("revocation mid-hash or late match cannot install escrow, dispatch or republish a title", async () => {
    const access = authority(), gate = Promise.withResolvers();
    const owner = createReportSaveIdentity({ kind: "report", api: access.api,
        digest: bytes => { const result = crypto.subtle.digest("SHA-256", bytes); return gate.promise.then(() => result); } });
    const pending = owner.prepareSaveIdentity(preview("PRIVATE TITLE"));
    access.withdraw(); owner.withdrawAccess(); access.resume(); owner.resumeAccess(); gate.resolve();
    assert.equal(await pending, null);
    assert.equal(owner.saveIdentity(), null);
    assert.equal(owner.dispatched(), false);
    const failed = createReportSaveIdentity({ kind: "report", api: access.api, digest: () => Promise.reject(new Error("Synthetic digest failure")) });
    await assert.rejects(failed.prepareSaveIdentity(preview("")), /digest failure/);
    assert.equal(failed.saveIdentity(), null);
    assert.equal(failed.dispatched(), false);

    let hold = false;
    const matchGate = Promise.withResolvers();
    const matched = createReportSaveIdentity({ kind: "report", api: access.api, digest: bytes => {
        const result = crypto.subtle.digest("SHA-256", bytes);
        return hold ? matchGate.promise.then(() => result) : result;
    } });
    await matched.prepareSaveIdentity(preview("PRIVATE TITLE"));
    assert.equal(matched.dispatched(), true);
    hold = true;
    const match = matched.matchesSaveIdentity(saved("PRIVATE TITLE"));
    access.withdraw(); matched.withdrawAccess(); access.resume(); matched.resumeAccess(); matchGate.resolve();
    assert.equal(await match, false);
    assert.equal(matched.saveIdentity().unknown, true);
    assert.equal(matched.saveIdentity().bundleId, "bundle-original");
});

test("draft withdrawal scrubs private options and basis, fencing old tokens through fresh resumption", () => {
    const draft = createReportDraft();
    draft.change({ title: "PRIVATE TITLE", manualTerms: ["PRIVATE MASK"], overrides: [{ key: "PRIVATE KEY", text: "PRIVATE COPY" }], formats: ["json"], promptMode: "original" });
    draft.select(["PRIVATE SELECTION"]);
    const token = draft.token();
    draft.withdrawAccess(); draft.withdrawAccess();
    assert.equal(draft.current(token), false);
    assert.deepEqual(draft.options(), { promptMode: "original", formats: ["json"], manualTerms: [], overrides: [] });
    draft.change({ title: "LATE PRIVATE TITLE" }); draft.select(["LATE PRIVATE SELECTION"]);
    assert.doesNotMatch(JSON.stringify(draft.options()), /PRIVATE/);
    draft.resumeAccess();
    assert.equal(draft.current(token), false);
    draft.change({ title: "Fresh title" });
    assert.equal(draft.options().title, "Fresh title");
});

test("ordinary report invalidation during hashing cannot install a successor save identity", async () => {
    const access = authority(), gate = Promise.withResolvers();
    const journey = createReportJourney({ api: access.api, createSaveIdentity: options => createReportSaveIdentity({
        ...options, digest: bytes => { const result = crypto.subtle.digest("SHA-256", bytes); return gate.promise.then(() => result); },
    }) });
    journey.update({ scopeReady: true, requestCount: 1 });
    journey.beginScan(); journey.previewReady(preview("PRIVATE TITLE"));
    await assert.rejects(journey.prepareSaveIdentity(preview("PRIVATE TITLE")), /current prepared report/);
    journey.reviewed();
    const pending = journey.prepareSaveIdentity(preview("PRIVATE TITLE"));
    journey.invalidate("Contents changed"); gate.resolve();
    assert.equal(await pending, null);
    assert.equal(journey.saveIdentity(), null);
    assert.equal(journey.writing(true), false);
});

test("same-grant resume is idempotent and cannot retire a current identity hash", async () => {
    const { api } = authority(), gate = Promise.withResolvers();
    const identity = createReportSaveIdentity({ kind: "report", api, digest: bytes => {
        const result = crypto.subtle.digest("SHA-256", bytes);
        return gate.promise.then(() => result);
    } });
    const preparing = identity.prepareSaveIdentity(preview("PRIVATE TITLE"));
    identity.resumeAccess(); identity.resumeAccess(); gate.resolve();
    assert.equal((await preparing).bundleId, "bundle-original");
    assert.equal(identity.dispatched(), true);
});

test("direct local-save recovery requires the original content binding, not just its title and bundle", async () => {
    const { api } = authority(), owner = createReportSaveIdentity({ kind: "report", api });
    const prepared = { ...preview("Private title"), localSaveRequest: { version: 1, bundleId: "bundle-original", contentHash: "a".repeat(64) } };
    const identity = await owner.prepareSaveIdentity(prepared);
    assert.equal(identity.expectedLocalSave, true);
    assert.doesNotMatch(JSON.stringify(identity), /Private title|a{64}/);
    const receipt = { ...saved("Private title"), privacyReview: { reviewerConfirmed: false,
        localSave: { method: "explicit-local-save", contentHash: "a".repeat(64) } } };
    assert.equal(await owner.matchesSaveIdentity(receipt), true);
    receipt.privacyReview.localSave.contentHash = "b".repeat(64);
    assert.equal(await owner.matchesSaveIdentity(receipt), false);
    assert.equal(await owner.matchesSaveIdentity(saved("Private title")), false);
});

test("ordinary journey preserves UNKNOWN escrow through scrub and fresh authorized recovery without another save", async () => {
    const access = authority();
    let entries = [], reads = 0;
    const journey = createReportJourney({ api: access.api, createSaveIdentity: createReportSaveIdentity,
        readSavedReports: async () => { reads++; return entries; } });
    journey.update({ scopeReady: true, requestCount: 2, title: "PRIVATE TITLE", entry: { sessionName: "PRIVATE CHAT" } });
    journey.beginScan(); journey.previewReady(preview("PRIVATE TITLE")); journey.reviewed();
    await journey.prepareSaveIdentity(preview("PRIVATE TITLE"));
    assert.equal(journey.writing(true), true);
    access.withdraw(); journey.withdrawAccess(); journey.withdrawAccess();
    assert.doesNotMatch(JSON.stringify(journey.snapshot()), /PRIVATE/);
    assert.equal(journey.snapshot().saveUnconfirmed, true);
    assert.equal(journey.saveIdentity().unknown, true);
    journey.saved(saved("PRIVATE TITLE"));
    journey.failed("LATE PRIVATE ERROR", { saveRejected: true });
    assert.equal(journey.snapshot().saveUnconfirmed, true);
    assert.equal(journey.clear(), false);
    assert.equal(await journey.recoverSave(), false);
    assert.equal(reads, 0);
    access.resume(); assert.equal(journey.resumeAccess(), true);
    entries = [saved("wrong title")];
    assert.equal(await journey.recoverSave(), false);
    assert.equal(journey.saveIdentity().unknown, true);
    entries = [saved("PRIVATE TITLE")];
    assert.equal(await journey.recoverSave(), true);
    assert.equal(journey.saveIdentity(), null);
    assert.equal(journey.snapshot().phase, "saved");
    assert.equal(reads, 2);
});
