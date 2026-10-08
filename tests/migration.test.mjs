import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migratePrivateData } from "../lib/migration.mjs";
import { loadBoardState, moveCard, writeExclusive } from "../lib/store.mjs";
import { createExportController } from "../lib/export.mjs";
import { privateFixture } from "./helpers.mjs";
import { BOARD_ID } from "../lib/evidence.mjs";

test("migration preserves evidence, review key, export bytes and immutable backup; refuses overwrite", async (t) => {
    const { root, context } = await privateFixture(t);
    await moveCard(context, "test-scenario", "ready_to_export");
    const controller = createExportController(context);
    const draft = await controller.preview("synthetic-migration");
    await controller.review("synthetic-migration", draft.previewId, true);
    await controller.confirm("synthetic-migration", draft.previewId, true);
    const original = await loadBoardState(context);
    const originalBytes = await readFile(path.join(context.dataDir, `${BOARD_ID}.state.json`));
    const imports = path.join(root, "import-inputs");
    await mkdir(imports);
    await writeExclusive(path.join(imports, "app-inventory.json"), "[]");
    await writeExclusive(path.join(imports, "history-window.json"), JSON.stringify({ windowDays: 30 }));
    const options = {
        source: context.dataDir, destination: path.join(root, "maintained"), importFiles: imports,
        sessionRoot: root, appDbPath: path.join(root, "app.db"),
    };
    const sourceRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    await assert.rejects(migratePrivateData({ ...options, destination: path.join(sourceRoot, "forbidden-private-data") }), /outside/);
    const result = await migratePrivateData(options);
    const migrated = await loadBoardState({ dataDir: result.destination });
    assert.deepEqual(migrated.cards, original.cards);
    assert.equal(migrated.pseudonymKey, original.pseudonymKey);
    assert.equal(migrated.evidenceFile, original.evidenceFile);
    assert.equal(result.counts.workIqCalls, 1);
    assert.equal(result.counts.exports, 1);
    assert.deepEqual(await readFile(path.join(result.backup, `${BOARD_ID}.state.json`)), originalBytes);
    assert.deepEqual(await readFile(path.join(context.dataDir, `${BOARD_ID}.state.json`)), originalBytes);
    for (const [name, source] of Object.entries(original.exports[0].files)) {
        assert.deepEqual(await readFile(migrated.exports[0].files[name]), await readFile(source));
        assert.ok(migrated.exports[0].files[name].startsWith(result.destination + path.sep));
    }
    await assert.rejects(migratePrivateData(options), /already exists/);
});
