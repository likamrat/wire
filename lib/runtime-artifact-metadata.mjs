// Visible metadata owns every label/count. Private dependency state may only
// remove a deletion hint; it cannot grant authority or reveal hidden artifacts.
export function restrictSavedArtifactMetadata(value, actualState) {
    const protectedTargets = new Set(actualState.exports
        .filter(entry => entry.kind === "comparison"
            && (Object.hasOwn(entry, "nativeSourceBinding") || Object.hasOwn(entry, "nativeEvidenceHash") || Object.hasOwn(entry, "nativeComparisonHash")))
        .flatMap(entry => (entry.sourceReports ?? []).map(source => source.bundleId)));
    const restrict = item => item?.canDelete === true && protectedTargets.has(item.bundleId)
        ? { ...item, canDelete: false } : item;
    const result = { ...value };
    if (result.artifact) result.artifact = restrict(result.artifact);
    for (const field of ["artifacts", "sources", "exports"]) {
        if (Array.isArray(result[field])) result[field] = result[field].map(restrict);
    }
    return result;
}
