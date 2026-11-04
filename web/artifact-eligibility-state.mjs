// A read-only target hint, never an artifact mutation token or bulk permission.
export function createArtifactEligibilityState() {
    let pending = null, granted = null;
    const same = (a, b) => a && b && a.publication === b.publication && a.owner === b.owner
        && a.authorizationRevision === b.authorizationRevision && a.revision === b.revision
        && a.target.artifactId === b.target.artifactId && a.target.artifactKind === b.target.artifactKind;
    function invalidate() { pending = granted = null; }
    return {
        invalidate,
        current: value => Boolean(same(pending ?? granted, value)),
        begin(value) {
            invalidate();
            if (!value?.publication || !value.owner || !Number.isSafeInteger(value.revision) || value.revision < 0
                || !Number.isSafeInteger(value.authorizationRevision) || value.authorizationRevision < 0
                || !["report", "comparison"].includes(value.target?.artifactKind)
                || !/^export-[a-f0-9-]{36}$/.test(value.target?.artifactId ?? "")) {
                throw new TypeError("Current artifact eligibility requires its exact displayed identity and access.");
            }
            pending = { ...value, target: { ...value.target } };
            return pending;
        },
        receive(ticket, value, current) {
            if (ticket !== pending) return false;
            if (!same(ticket, current)) { invalidate(); return false; }
            pending = null;
            const artifact = value?.artifact;
            const keys = ["bundleId", "kind", "preparedAt", "preparedAtDisplay", "title", "formats", "promptMode",
                "canDelete", "reportType", "population", "requestGroupCount", "nativeConversationCount", "comparisonEligibility",
                "retainedComparisonCount", "sourceReports"];
            if (!value || Object.keys(value).length !== 1 || !artifact || Object.getPrototypeOf(artifact) !== Object.prototype
                || Object.keys(artifact).some(key => !keys.includes(key)) || artifact.bundleId !== current.target.artifactId
                || artifact.kind !== current.target.artifactKind || typeof artifact.canDelete !== "boolean"
                || Object.hasOwn(artifact, "nativeConversationCount")
                    && (!Number.isSafeInteger(artifact.nativeConversationCount) || artifact.nativeConversationCount < 0)) {
                granted = null;
                throw new TypeError("Artifact deletion eligibility did not match the displayed target.");
            }
            granted = artifact.canDelete === true ? ticket : null;
            return Boolean(granted);
        },
        allowed(current) {
            if (!same(granted, current)) { granted = null; return false; }
            return true;
        },
    };
}
