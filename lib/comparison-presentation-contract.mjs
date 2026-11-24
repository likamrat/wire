import { time } from "./time.mjs";

export function validateComparisonPresentation(presentation) {
    if (presentation?.comparisonVersion === undefined) return false;
    if (presentation.comparisonVersion !== 1 || presentation.schemaVersion !== 3 || presentation.brandVersion !== 2
        || presentation.originExplanationVersion !== 1
        || Object.keys(presentation).sort().join(",") !== "brandVersion,comparisonVersion,originExplanationVersion,schemaVersion")
        throw new TypeError("Unsupported comparison source presentation.");
    return true;
}

export function validateComparisonIdentity(model, references) {
    if (!validateComparisonPresentation(model?.presentation)) {
        if (model?.sourceIdentity !== undefined) throw new TypeError("Comparison source identity requires a presentation version.");
        return null;
    }
    if (!Array.isArray(model.sourceIdentity) || model.sourceIdentity.length !== 2)
        throw new TypeError("Unsupported comparison source presentation.");
    for (const [index, side] of model.sourceIdentity.entries()) {
        const reference = index ? model.later : model.baseline;
        if (!side || Object.keys(side).sort().join(",") !== "dateSelection,report,sourceCount,timeContext,title"
            || !side.report || Object.keys(side.report).sort().join(",") !== "bundleId,snapshotHash"
            || typeof side.report.bundleId !== "string" || !side.report.bundleId
            || !/^[a-f0-9]{64}$/.test(side.report.snapshotHash)
            || JSON.stringify(side.report) !== JSON.stringify(reference)
            || references !== undefined && JSON.stringify(side.report) !== JSON.stringify(references[index])
            || side.title !== null && (typeof side.title !== "string" || !side.title.trim() || /[\u0000-\u001f\u007f]/.test(side.title))
            || side.sourceCount !== null && (!Number.isSafeInteger(side.sourceCount) || side.sourceCount < 0))
            throw new TypeError("Comparison source identity does not match its frozen report.");
        if (side.timeContext !== null) time.normalize(side.timeContext);
        if (side.dateSelection !== null) {
            const { from, to } = time.selection(side.dateSelection);
            if (from !== undefined && to !== undefined) {
                const civilFrom = from.length === 10, civilTo = to.length === 10;
                if (civilFrom && civilTo && time.calendar(from) > time.calendar(to)
                    || !civilFrom && !civilTo && Date.parse(time.instant(from)) > Date.parse(time.instant(to)))
                    throw new RangeError("Start date must not follow end date.");
            }
            if (side.timeContext !== null) time.range(side.dateSelection, side.timeContext.timeZone);
        }
    }
    return model.sourceIdentity;
}

export function comparisonSourceWindow(side) {
    if (side.dateSelection === null) return "Selected window not recorded";
    if (side.dateSelection.range === "capture") return "Selected window: all retained dates";
    return `Selected window: ${side.dateSelection.from ?? "unbounded start"} to ${side.dateSelection.to ?? "unbounded end"}`;
}
