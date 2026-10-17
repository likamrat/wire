export function createReportIdentity() {
    function kind(value) {
        if (value?.kind === "comparison") return "Report comparison";
        if (value?.reportType === "period-comparison" || value?.periodComparison) return "Period comparison";
        return "Report";
    }
    function defaultTitle(value) {
        const scope = value?.kind === "comparison" || value?.reportType === "period-comparison" || value?.periodComparison ? null
            : ({ all: "All retained activity", current: "Analyze view", selected: "Selected interactions" })[value?.selectionScope?.kind];
        return scope || (kind(value) === "Report" ? "Activity report" : kind(value));
    }
    function title(value, preparedLabel = value?.preparedAtDisplay) {
        if (typeof value?.title === "string" && value.title.trim()) return value.title.trim();
        const label = defaultTitle(value);
        if (typeof preparedLabel === "string" && preparedLabel.trim() && preparedLabel !== "Time not recorded") return `${label} · ${preparedLabel.trim()}`;
        const count = value?.selectionScope?.requestGroups;
        return Number.isSafeInteger(count) && count >= 0 ? `${label} · ${count} ${count === 1 ? "interaction" : "interactions"}` : label;
    }
    function legacyCandidate(value) {
        const formats = { html: "html", pdf: "pdf", json: "json", markdown: "md" };
        const verification = ["manifestHash", "snapshotHash", "evaluationFactsHash", "periodComparisonHash", "comparisonHash", "sourceReports", "reportType"];
        if (!value || (value.kind ?? "report") !== "report" || verification.some(key => Object.hasOwn(value, key))
            || !value.privacyReview || Object.getPrototypeOf(value.privacyReview) !== Object.prototype || value.privacyReview.reviewerConfirmed !== true
            || Object.hasOwn(value.privacyReview, "reviewedAt")
            || !Array.isArray(value.formats) || !value.formats.length || new Set(value.formats).size !== value.formats.length
            || value.formats.some(format => typeof format !== "string" || !Object.hasOwn(formats, format))
            || !value.files || Object.getPrototypeOf(value.files) !== Object.prototype) return false;
        const names = [...value.formats.map(format => `product-report.${formats[format]}`), "coverage-and-redaction-manifest.json"].sort();
        return JSON.stringify(Object.keys(value.files).sort()) === JSON.stringify(names);
    }
    return { kind, title, defaultTitle, legacyCandidate };
}

export const reportIdentity = createReportIdentity();
