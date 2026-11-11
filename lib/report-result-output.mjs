import { validateReportResultFacts, summarizeReportResultFacts, reportObservationHasError } from "./report-result-facts.mjs";
import { validateReportResultText } from "./report-result-text-shape.mjs";
import { createReportComparison } from "../web/report-comparison.mjs";
import { freezeEvaluationFacts } from "./report-facts.mjs";
import { createRecordedResults } from "../web/recorded-results.mjs";
import { createTimingPresentation } from "../web/assessment-presentation.mjs";

const sourceNames = { "github-copilot": "GitHub Copilot", "microsoft-365-chat": "Microsoft 365 Chat", "microsoft-365-cowork": "Microsoft 365 Cowork" };
const comparisonFormatter = createReportComparison();
const resultPresentation = createRecordedResults();
const timingPresentation = createTimingPresentation(undefined, { compact: true });
const boundary = comparisonFormatter.resultBoundary;
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const markdown = value => escape(value).replace(/[\\`*_#[\]{}|]/g, "\\$&");

export function reportResultContent(facts, evaluationFacts, resultText) {
    if (!facts) return null;
    validateReportResultFacts(facts);
    if (resultText) validateReportResultText(resultText, facts);
    const inlineCopyKeys = new Set();
    const operations = new Map(), durations = new Map();
    if (evaluationFacts) {
        const technical = freezeEvaluationFacts(evaluationFacts);
        if (technical.namespace.ref !== facts.namespace) throw new TypeError("Result operations belong to a different report namespace.");
        for (const { pattern, memberRefs } of technical.patterns) {
            if (pattern.unitKind !== "tool-call") continue;
            const paths = pattern.display.endpoints.map(endpoint =>
                [endpoint.method, endpoint.apiVersion, endpoint.pathTemplate].filter(Boolean).join(" "));
            const text = paths.length ? (pattern.display.attribution === "schema-reference" ? "Referenced schema: " : "Requested: ") + paths.join("; ")
                : "No API path was recorded for this call.";
            for (const ref of memberRefs) operations.set(ref, text);
        }
        for (const metric of technical.metrics.filter(metric => metric.definitionId === "tool-duration"
            && metric.boundary === "tool-start-to-completion" && metric.unit === "ms")) {
            for (const sample of metric.samples ?? []) {
                if (durations.has(sample.unitRef) && durations.get(sample.unitRef) !== sample.value) throw new TypeError("Conflicting report call timing.");
                durations.set(sample.unitRef, sample.value);
            }
        }
    }
    const groups = summarizeReportResultFacts(facts).map(group => ({
        title: sourceNames[group.source],
        summary: `${group.calls} recorded ${group.calls === 1 ? "call" : "calls"}; ${group.completions} completed. `
            + (group.application.known ? `${group.application.errors} application ${group.application.errors === 1 ? "error" : "errors"} among ${group.application.known} ${group.application.known === 1 ? "call" : "calls"} with an explicit application-result flag.`
                : "Application results are unavailable, not zero errors.")
            + (group.application.known && group.application.unknown ? ` ${group.application.unknown} ${group.application.unknown === 1 ? "call has" : "calls have"} missing or conflicting result flags.` : "")
            + (group.cappedCalls ? ` ${group.cappedCalls} ${group.cappedCalls === 1 ? "call has" : "calls have"} more supplied result entries than retained entries.` : "")
            + (group.paginationObservedCalls ? ` ${group.paginationObservedCalls} ${group.paginationObservedCalls === 1 ? "call has" : "calls have"} a next-page indication; item and page totals are unknown.` : ""),
    }));
    const priority = call => call.observations.some(value => reportObservationHasError(value) || value.statusConflict) ? 0 : 1;
    const selected = facts.calls.map((call, index) => ({ call, index }))
        .sort((a, b) => priority(a.call) - priority(b.call) || a.index - b.index);
    const calls = selected.map(({ call, index }) => ({
        ref: call.ref, title: `Report call ${index + 1}: ${call.tool ?? "Native tool"} (${sourceNames[call.source]})`,
        interpreted: call.observations.some(value => value.interpretation),
        lines: [...(operations.has(call.ref) ? [operations.get(call.ref)] : []), `Recorded completion: ${call.completion}.`,
            ...(call.observations.some(value => value.interpretation) ? [
                durations.has(call.ref) ? `Recorded tool interval: ${timingPresentation.duration(durations.get(call.ref))}, from call start to recorded completion. This is not downstream API latency or the configured timeout.`
                    : "No qualified tool interval is available in this report.",
            ] : []),
            ...(call.completion === "succeeded" ? ["The source recorded a successful tool completion; this does not establish answer correctness or overall task success."] : []),
            ...call.observations.flatMap((observation, ordinal) => {
            const lines = [];
            if (call.observations.length > 1) lines.push(`Retained observation ${ordinal + 1}; observations are not additional calls.`);
            if (observation.resultVersion === null) lines.push("Explicit application-result flags and result-body details were not saved for this call.");
            if (observation.applicationError !== null) lines.push(observation.applicationError ? "The source explicitly reported an application error."
                : "The source explicitly marked the application result as non-error.");
            if (observation.statusCode !== null) lines.push(`Tool-reported status: ${observation.statusCode}.`);
            if (observation.statusConflict) lines.push(`Reported statuses conflict: structured ${observation.statusConflict.structured}, text ${observation.statusConflict.text}.`);
            if (observation.resultCount !== null) lines.push(`Returned response entries: ${observation.resultCount} supplied; ${observation.retainedResultCount ?? "unknown"} retained.`);
            for (const entry of observation.returnedEntries ?? []) {
                lines.push(`Returned API entry ${entry.index + 1}: status ${entry.statusCode ?? "unavailable"}`
                    + (entry.errorCode !== null ? `; recorded error code ${entry.errorCode}` : entry.errorCodeStatus === "withheld" ? "; error code withheld" : "") + ".");
                if (entry.statusConflict) lines.push(`Returned API entry ${entry.index + 1}: diagnostic status ${entry.statusConflict.diagnostic} conflicts with returned status ${entry.statusConflict.reported}. Neither replaces the other.`);
            }
            if (observation.paginationPresent) lines.push("Returned metadata indicates another page. Item and total-page counts are not qualified.");
            if (observation.errorStatusCode !== null) lines.push(`Recorded error status: ${observation.errorStatusCode}.`);
            if (observation.timingFailure) lines.push(comparisonFormatter.timingFailureText(observation.timingFailure)
                + (observation.interpretation ? "." : ". This does not show whether the requested work finished."));
            if (observation.errorCode !== null) lines.push(`${observation.errorCodeBasis === "retained-failure-projection" ? "Saved error classification" : "Recorded error code"}: ${observation.errorCode}.`);
            if (observation.errorCodeStatus === "withheld") lines.push("The error code was withheld by report policy.");
            if (observation.diagnosticStatus && !observation.errorTextAvailable) lines.push(({
                "not-supplied": "The source did not supply error details.",
                "not-retained": "Error details were not saved.",
                "sensitive-excluded": "Error details were excluded for privacy.",
                "size-excluded": "Error details exceeded the saving limit.",
                "unsupported-format": "WIRE could not read this error format.",
            })[observation.diagnosticStatus] ?? `Error details: ${observation.diagnosticStatus.replaceAll("-", " ")}.`);
            if (call.completion === "failed" && !observation.diagnosticStatus && !observation.errorTextAvailable
                && !observation.returnedEntries?.length) lines.push("Failure reason was not saved.");
            if (observation.contentStatus === "partial") lines.push("Returned results are partial: only complete entries before an unreadable part were retained; the total entry count is unknown.");
            else if (observation.contentStatus) lines.push(`Result content: ${observation.contentStatus.replaceAll("-", " ")}.`);
            if (observation.interpretation && resultText) {
                for (const copy of resultText.copies.filter(copy => copy.memberRefs.includes(call.ref)
                    && copy.observationRef === observation.ref && copy.text !== null && copy.kind.startsWith("error-"))) {
                    inlineCopyKeys.add(copy.key);
                    if (copy.kind === "error-code" && String(observation.errorCode) === copy.text && copy.entryIndex === null) continue;
                    lines.push(copy.label + (copy.entryIndex === null ? "" : ` (returned entry ${copy.entryIndex + 1})`)
                        + (copy.representation === "edited-copy" ? " (edited report copy): " : " (masked report copy): ") + copy.text);
                }
            }
            if (observation.interpretation) lines.push(...resultPresentation.interpretationItems(observation.interpretation)
                .map(item => item.label + ": " + item.text));
            return lines;
        })],
    }));
    return { boundary, groups, calls, inlineCopyKeys: [...inlineCopyKeys], empty: facts.calls.length === 0, omittedCalls: facts.calls.length - calls.length };
}

export function reportResultHtml(facts, resultText, { id = "recorded-result-facts", title = "Recorded tool results", textSection = true, showBoundary = true, evaluationFacts } = {}) {
    const content = reportResultContent(facts, evaluationFacts, resultText);
    if (!content) return "";
    return `<section id="${escape(id)}"><h2>${escape(title)}</h2>${showBoundary ? `<p>${escape(content.boundary)}</p>` : ""}${content.empty ? "<p>No tool calls belong to this selection.</p>" : ""}
${content.groups.map(group => `<h3>${escape(group.title)}</h3><p>${escape(group.summary)}</p>`).join("")}
${content.calls.map(call => `<section id="${escape(call.ref)}"${call.interpreted ? ' style="break-inside:avoid"' : ""}><h3>${escape(call.title)}</h3>${call.lines.map(line => `<p>${escape(line)}</p>`).join("")}</section>`).join("")}
${content.omittedCalls ? `<p>The report manifest lists ${content.omittedCalls} more ${content.omittedCalls === 1 ? "call" : "calls"}.</p>` : ""}
${textSection ? resultTextHtml(resultText, facts, content.inlineCopyKeys) : ""}</section>`;
}

export function reportResultMarkdown(facts, resultText, { title = "Recorded tool results", textSection = true, showBoundary = true, evaluationFacts } = {}) {
    const content = reportResultContent(facts, evaluationFacts, resultText);
    if (!content) return [];
    return [`## ${markdown(title)}`, "", ...(showBoundary ? [markdown(content.boundary), ""] : []), ...(content.empty ? ["No tool calls belong to this selection.", ""] : []),
        ...content.groups.flatMap(group => [`### ${markdown(group.title)}`, "", markdown(group.summary), ""]),
        ...content.calls.flatMap(call => [`### ${markdown(call.title)}`, "", ...call.lines.flatMap(line => [markdown(line), ""])]),
        ...(content.omittedCalls ? [`The report manifest lists ${content.omittedCalls} more ${content.omittedCalls === 1 ? "call" : "calls"}.`, ""] : []),
        ...(textSection ? resultTextMarkdown(resultText, facts, content.inlineCopyKeys) : [])];
}

function resultTextContent(value, facts) {
    if (!value) return { notice: "Retained result text was not selected for this report.", copies: [] };
    validateReportResultText(value, facts);
    return { notice: comparisonFormatter.resultTextNotice(value.coverage),
        copies: value.copies.filter(copy => copy.text !== null).map(copy => ({ key: copy.key, text: copy.text,
            label: `${copy.label} / report call ${copy.memberRefs.map(ref => facts.calls.findIndex(call => call.ref === ref) + 1).join(", ")}${copy.entryIndex !== null ? ` / returned API entry ${copy.entryIndex + 1}` : ""} / ${sourceNames[copy.source]} / ${copy.representation === "edited-copy" ? "edited report copy, not original wording" : "masked retained copy"}` })) };
}
export function resultTextHtml(value, facts, inlineCopyKeys = []) {
    const content = resultTextContent(value, facts);
    content.copies = content.copies.filter(copy => !inlineCopyKeys.includes(copy.key));
    if (inlineCopyKeys.length && !content.copies.length && !value.coverage.omitted && !value.coverage.unavailable) return "";
    return `<section id="recorded-result-text"><h3>Recorded result text</h3><p>${escape(content.notice)}</p>
${content.copies.map(copy => `<div id="${escape(copy.key)}" class="prompt"><p>${escape(copy.label)}</p><pre>${escape(copy.text)}</pre></div>`).join("")}</section>`;
}
export function resultTextMarkdown(value, facts, inlineCopyKeys = []) {
    const content = resultTextContent(value, facts);
    content.copies = content.copies.filter(copy => !inlineCopyKeys.includes(copy.key));
    if (inlineCopyKeys.length && !content.copies.length && !value.coverage.omitted && !value.coverage.unavailable) return [];
    return ["### Recorded result text", "", markdown(content.notice), "",
        ...content.copies.flatMap(copy => [markdown(copy.label), "", markdown(copy.text), ""])];
}

export function resultComparisonContent(value) {
    return comparisonFormatter.resultComparisonContent(value);
}

export function resultComparisonHtml(value) {
    const content = resultComparisonContent(value);
    if (!content) return "";
    return `<section id="result-comparison"><h2>Application-result comparison</h2><p>${escape(content.boundary)}</p>
${content.unavailable ? `<p>${escape(content.unavailable)}</p>` : ""}${content.shared ? `<p>${escape(content.shared)}</p>` : ""}
${content.groups.map(group => `<section><h3>${escape(group.title)}</h3><p>Earlier: ${escape(group.baseline)}</p><p>Later: ${escape(group.later)}</p><p>${escape(group.change)}</p></section>`).join("")}
${content.changes.map(change => `<section><h3>${escape(change.title)}</h3><p>Earlier: ${escape(change.baseline)}</p><p>Later: ${escape(change.later)}</p></section>`).join("")}
${content.additional ? `<p>${escape(content.additional)}</p>` : ""}</section>`;
}

export function resultComparisonMarkdown(value) {
    const content = resultComparisonContent(value);
    if (!content) return [];
    return ["## Application-result comparison", "", markdown(content.boundary), "",
        ...(content.unavailable ? [markdown(content.unavailable), ""] : []),
        ...(content.shared ? [markdown(content.shared), ""] : []),
        ...content.groups.flatMap(group => [`### ${markdown(group.title)}`, "", `Earlier: ${markdown(group.baseline)}`, "",
            `Later: ${markdown(group.later)}`, "", markdown(group.change), ""]),
        ...content.changes.flatMap(change => [`### ${markdown(change.title)}`, "", `Earlier: ${markdown(change.baseline)}`, "", `Later: ${markdown(change.later)}`, ""]),
        ...(content.additional ? [markdown(content.additional), ""] : [])];
}

export function comparisonResultTextHtml(value) {
    const groups = comparisonFormatter.resultTextSourcesContent(value);
    return groups ? groups.map(group => `<section><h2>${escape(group.title)}</h2><p>${escape(group.notice)}</p>
${group.copies.map(copy => `<div class="prompt"><h3>${escape(copy.label)}</h3><pre>${escape(copy.text)}</pre></div>`).join("")}</section>`).join("") : "";
}
export function comparisonResultTextMarkdown(value) {
    const groups = comparisonFormatter.resultTextSourcesContent(value);
    return groups ? groups.flatMap(group => [`## ${markdown(group.title)}`, "", markdown(group.notice), "",
        ...group.copies.flatMap(copy => [`### ${markdown(copy.label)}`, "", markdown(copy.text), ""])]) : [];
}
