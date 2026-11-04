import test from "node:test";
import assert from "node:assert/strict";
import { mountDeletion } from "../web/deletion-flow.mjs";
import { mountRecollection } from "../web/recollection-flow.mjs";
import { createSavedArtifactDeletion } from "../web/saved-artifact-deletion.mjs";
import { mountRecorderDiagnostics } from "../web/recorder-diagnostics.mjs";

for (const mount of [mountDeletion, mountRecollection, createSavedArtifactDeletion, mountRecorderDiagnostics]) {
    test(`${mount.name} rejects missing or malformed access methods before touching the DOM or storage`, () => {
        const token = Object.freeze({});
        for (const api of [
            undefined, {},
            () => {},
            Object.assign(() => {}, { publicationToken: () => token }),
            Object.assign(() => {}, { isCurrent: () => true }),
            Object.assign(() => {}, { publicationToken: true, isCurrent: () => true }),
            Object.assign(() => {}, { publicationToken: () => token, isCurrent: true }),
        ]) {
            assert.throws(() => mount({ api }), {
                name: "TypeError",
                message: "An access-aware API with publicationToken() and isCurrent() is required.",
            });
        }
    });
}
