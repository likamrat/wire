import { createHash } from "node:crypto";
import { projectReportCopy } from "./prompt-projection.mjs";
import { scanTree, textFindings } from "./privacy.mjs";
import { BoardError } from "./store.mjs";

const plain = value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function projectReportNotes(options, records) {
    if (!options.reportNotes?.length) return null;
    const ids = new Set(records.map(record => record.scenarioId));
    const mode = options.promptMode === "original" ? "original" : "masked";
    const entries = options.reportNotes.map(note => {
        if (!ids.has(note.scenarioId)) throw new BoardError("A note belongs to an interaction no longer included in this report.", 409);
        const copy = projectReportCopy({
            key: `note:${note.scenarioId}`, original: note.text, status: "full",
        }, { ...options, promptMode: mode, overrides: [] });
        return { scenarioId: note.scenarioId, text: copy.text, representation: copy.representation, changes: copy.changes };
    });
    const frozen = validateReportNotes({ version: 1, author: "report-author", mode, entries }, records);
    return { frozen, scan: { ...scanTree(options.reportNotes.map(note => note.text)), allNoteFieldsScanned: true } };
}

export function validateReportNotes(value, records) {
    const fail = () => { throw new TypeError("Invalid report-author notes."); };
    if (!plain(value) || Object.keys(value).length !== 4
        || !["version", "author", "mode", "entries"].every(key => Object.hasOwn(value, key))
        || value.version !== 1 || value.author !== "report-author" || !["masked", "original"].includes(value.mode)
        || !Array.isArray(value.entries) || value.entries.length > 3000) fail();
    const seen = new Set(), ids = records && new Set(records.map(record => record.scenarioId));
    for (const note of value.entries) {
        if (!plain(note) || Object.keys(note).length !== 4
            || !["scenarioId", "text", "representation", "changes"].every(key => Object.hasOwn(note, key))
            || typeof note.scenarioId !== "string" || !/^scenario-[a-f0-9]{16}$/.test(note.scenarioId)
            || seen.has(note.scenarioId) || ids && !ids.has(note.scenarioId)
            || typeof note.text !== "string" || !note.text.trim() || !Array.isArray(note.changes)
            || !["masked-copy", "retained-original", "original-with-mandatory-or-manual-removals"].includes(note.representation)
            || value.mode === "masked" && note.representation !== "masked-copy"
            || note.changes.some(change => !plain(change) || Object.keys(change).length !== 2
                || typeof change.category !== "string" || !/^[a-z_]{1,60}$/.test(change.category)
                || typeof change.mandatory !== "boolean")) fail();
        if (textFindings(note.text).some(finding => finding.mandatory || value.mode === "masked" && finding.category !== "sensitivity_markings")) fail();
        seen.add(note.scenarioId);
    }
    if (Buffer.byteLength(JSON.stringify(value.entries)) > 4 * 1024 * 1024) fail();
    return structuredClone(value);
}

export function inspectReportNotes(manifest, snapshot) {
    if (!Object.hasOwn(manifest, "reportNotes") && !Object.hasOwn(manifest, "reportNotesHash")
        && !Object.hasOwn(snapshot ?? {}, "reportNotes")) return null;
    const notes = validateReportNotes(manifest.reportNotes, snapshot?.records);
    if (manifest.reportNotesHash !== hash(notes)
        || notes.mode !== (manifest.promptMode === "original" ? "original" : "masked")
        || snapshot && JSON.stringify(snapshot.reportNotes) !== JSON.stringify(notes)) {
        throw new TypeError("Report-author notes differ from their saved binding.");
    }
    return notes;
}
