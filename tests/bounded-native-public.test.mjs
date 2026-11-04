import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBoundedNativeState } from "../web/bounded-native-state.mjs";

// The source lane is intentionally not copied over the UI branch. Use its pinned test archive.
const root = process.env.WIRE_BOUNDED_BACKEND_ROOT;
const backend = async file => import(pathToFileURL(path.join(root, file)).href);
for (const segmented of [false, true]) test(`public v${segmented ? 2 : 1} DTOs decode and page without reconstructing native history`,
    { skip: !root }, async t => {
        const { committedNativeReportFixture } = await backend("tests\\native-report-controller-fixture.mjs");
        const { createNativeRetainedViews } = await backend("lib\\native-retained-views.mjs");
        const { chatFixture, coworkFixture } = await backend("tests\\native-read-model-fixtures.mjs");
        const app = await committedNativeReportFixture(t, { segmented, envelopes: [...chatFixture(), ...coworkFixture()] });
        const views = createNativeRetainedViews(app.context, app.persistence, app.lifecycle);
        t.after(() => views.close());
        const owner = app.services.nativeReportAdmission, model = createBoundedNativeState();
        const input = { schemaVersion: 1, revision: null, sources: model.sourceIds,
            analytics: { layer: "tool", groupBy: "workload", filters: { scope: "all" } }, page: { limit: 1, after: null } };
        const first = await views.query(input, owner);
        const inventoryInput = { schemaVersion: 1, revision: first.revision, viewId: first.viewId,
            dimension: "tools", page: { limit: 1, after: null } };
        const inventoryContext = { ...input, original: first };
        const inventoryModel = createBoundedNativeState();
        const inventory = await views.inventory(inventoryInput, owner);
        inventoryModel.receive(inventoryModel.begin(inventoryInput, owner, inventoryContext), inventory, owner);
        assert.equal(inventory.aggregates.options, 3);
        assert.equal(inventory.page.items.length, 1);
        const nextInventoryInput = inventoryModel.next();
        inventoryModel.receive(inventoryModel.begin(nextInventoryInput, owner),
            await views.inventory(nextInventoryInput, owner), owner);
        assert.equal(inventoryModel.snapshot().value.page.items.length, 1);
        assert.notEqual(inventoryModel.snapshot().value.page.items[0].value, inventory.page.items[0].value);
        const unknownInput = { ...inventoryInput, dimension: "services" };
        const unknown = inventoryModel.decode(await views.inventory(unknownInput, owner), unknownInput, inventoryContext);
        assert.equal(unknown.qualification, "unqualified");
        assert.equal(unknown.aggregates, null);
        const groupInput = { schemaVersion: 1, revision: first.revision, viewId: first.viewId,
            groupId: first.grouping.groups[0].id, page: { limit: 1, after: null } };
        const group = model.decode(await views.drilldown(groupInput, owner), groupInput, inventoryContext);
        assert.equal(group.aggregates.selectedRows, first.grouping.groups[0].count);
        assert.notEqual(group.viewId, first.viewId);
        assert.equal(group.groupId, groupInput.groupId);
        const analyzeInput = { schemaVersion: 1, revision: first.revision, viewId: first.viewId,
            query: "CallGraph", types: ["action"], page: { limit: 1, after: null } };
        const analyzed = model.decode(await views.analyze(analyzeInput, owner), analyzeInput, inventoryContext);
        assert.equal(analyzed.aggregates.calls, 1);
        assert.equal(analyzed.aggregates.conversations, 1);
        assert.equal(analyzed.textSelection.reportScope, "complete-matched-conversations");
        const refinedInventoryInput = { ...inventoryInput, viewId: analyzed.viewId };
        const refined = model.decode(await views.inventory(refinedInventoryInput, owner), refinedInventoryInput,
            { ...input, original: analyzed });
        assert.equal(refined.aggregates.options, 1);
        const refinedGroupInput = { ...groupInput, viewId: analyzed.viewId, groupId: analyzed.grouping.groups[0].id };
        const refinedGroup = model.decode(await views.drilldown(refinedGroupInput, owner), refinedGroupInput,
            { ...input, original: analyzed });
        assert.equal(refinedGroup.aggregates.calls, 1);
        assert.ok(refinedGroup.textSelection);
        await assert.rejects(views.analyze({ ...analyzeInput, viewId: analyzed.viewId }, owner),
            { code: "NATIVE_VIEW_ANALYSIS_BASE_REQUIRED" });
        model.receive(model.begin(input, owner), first, owner);
        const secondInput = model.next(), second = await views.query(secondInput, owner);
        model.receive(model.begin(secondInput, owner), second, owner);
        assert.equal(model.snapshot().value.page.items.length, 1);
        assert.deepEqual(second.aggregates, first.aggregates);
        const qualification = await views.readback({ schemaVersion: 1, operationId: first.readback.committed.operationId }, owner);
        const receipt = (await app.persistence.status({ operationId: first.readback.committed.operationId }, { owner: app.owner })).receipt;
        assert.equal(model.matchesReadback(qualification, first, receipt), true);
        assert.notEqual(second.page.items[0].id, first.page.items[0].id);
        const searchInput = { schemaVersion: 1, revision: first.revision, sources: model.sourceIds,
            query: "Read", types: [], page: { limit: 1, after: null } };
        const result = model.decode(await views.search(searchInput, owner), searchInput), hit = result.page.items[0];
        assert.ok(hit);
        const detailInput = { schemaVersion: 1, revision: result.revision, sources: [hit.source.sourceId],
            conversationId: hit.target.conversationId, at: hit.target.ordinal, sourceRevision: result.sourceRevision,
            page: { limit: 1, after: null } };
        const detail = model.decode(await views.detail(detailInput, owner), detailInput);
        assert.equal(detail.page.items[0].ordinal, hit.target.ordinal);
        assert.equal(detail.focusOrdinal, hit.target.ordinal);
        assert.doesNotMatch(JSON.stringify([first, second, detail, result]), /rootHash|tenantId|subjectId|nativeConversation/);
        const other = structuredClone(input); other.analytics.filters.sources = ["microsoft-365-chat"];
        const subset = model.decode(await views.query(other, owner), other);
        assert.ok(subset.page.items.every(item => item.sourceId === "microsoft-365-chat"));
        const dates = structuredClone(input);
        dates.analytics.filters.from = "2026-01-01"; dates.analytics.filters.to = "2026-12-31";
        const dated = model.decode(await views.query(dates, owner), dates);
        assert.equal(dated.aggregates.selectedRows, 0, "Capture time must not become an activity date.");
    });
