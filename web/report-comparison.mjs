import { createAssessmentWording } from "./assessment-presentation.mjs";

export function createReportComparison(wording = createAssessmentWording(), duration = null) {
    const presentation = Object.freeze({ schemaVersion: 1, performanceBands: Object.freeze({
        id: "assessed-pass-share-v1", unit: "percent", thresholds: Object.freeze([50, 75, 90]), unavailable: "neutral",
    }) });
    const dimensions = { accuracy: "Answer correctness", speed: "Speed", cost: "Cost", "answer-trust": "Answer support", "action-trust": "Saved review (type not recorded)" };
    const readingNotes = Object.freeze([
        "Answer correctness and answer support are separate reviews. Tool use vs. request asks whether the recorded tool use fit what was asked. Personal permission feedback is a different judgment.",
        "AI results use the recorded evidence and can be wrong. Personal feedback is labeled separately. A successful tool call does not prove the answer was correct.",
        "Read each result with its coverage: how many requests have a result for that check. Pass percentages count passed checks out of passed plus failed checks. Missing results are left out, not counted as failures or zero.",
        "Speed measures tool calls from start to recorded completion. It also measures the time from the recorded request to its final response. Each has its own timed-call or timed-request count. The median is the middle recorded time (the lower middle for an even count). Calls that run at the same time are not added together. A final response does not prove the task succeeded.",
    ]);
    const comparisonNote = "The reports may cover different requests or time periods. A change between them does not tell you what caused it. Returned API entries, recorded Graph sites and HTTP recorder records are counted separately.";
    const sourceNames = { "github-copilot": "GitHub Copilot", "microsoft-365-chat": "Microsoft 365 Chat", "microsoft-365-cowork": "Microsoft 365 Cowork" };
    const resultBoundary = "Tool completion is separate from application results and returned API entries. None proves task completion; entry counts are not item or page totals.";
    function timingFailureText(value) {
        if (value === undefined) return null;
        if (value?.version !== 1 || value.kind !== "request-timeout" || value.basis !== "retained-failure-signal") {
            throw new TypeError("Unsupported recorded timing failure.");
        }
        return "Request timed out (MCP -32001)";
    }
    function resultComparisonContent(value) {
        if (!value) return null;
        if (value.version !== 1) throw new TypeError("Unsupported result-comparison presentation.");
        const unavailable = {
            "result-facts-not-saved": "Neither source report saved this result-fact definition.",
            "baseline-result-facts-not-saved": "The earlier report did not save this result-fact definition.",
            "later-result-facts-not-saved": "The later report did not save this result-fact definition.",
            "empty-population": "The selected result cohorts contain no tool calls.",
            "overlap-unverified": "Call identity overlap is unverified for this cohort choice.",
            "not-tool-call-cohort": "This comparison uses a different evidence unit. Tool application-result flags are not substituted for that population.",
            "source-cohort-unavailable": "The selected source cohorts cannot be established with these report definitions.",
        };
        const side = (group, state) => state === "cohort-unavailable" ? "Cohort unavailable; source interpretation or call identity is not compatible."
            : state === "source-not-present" ? "Source population not present in this report."
            : !group ? "No calls in this selected source cohort."
            : `${group.calls} ${group.calls === 1 ? "call" : "calls"}; ${group.completions} completed. `
                + (group.application.known ? `${group.application.errors} application ${group.application.errors === 1 ? "error" : "errors"} among ${group.application.known} explicit result ${group.application.known === 1 ? "flag" : "flags"}.`
                    : "Application results are unavailable, not zero errors.")
                + (group.application.known && group.application.unknown ? ` ${group.application.unknown} ${group.application.unknown === 1 ? "call has" : "calls have"} missing or conflicting result flags.` : "");
        const observation = value => [
            `Application result: ${value.applicationError === null ? "flag unavailable" : value.applicationError ? "error reported" : "marked non-error"}`,
            ...(value.statusCode !== null ? [`tool-reported status ${value.statusCode}`] : []),
            ...(value.statusConflict ? [`conflicting statuses ${value.statusConflict.structured} / ${value.statusConflict.text}`] : []),
            ...(value.errorCode !== null ? [`recorded error code ${value.errorCode}`] : []),
            ...(value.timingFailure ? [timingFailureText(value.timingFailure)] : []),
            ...(value.errorStatusCode !== null ? [`recorded error status ${value.errorStatusCode}`] : []),
            ...(value.resultCount !== null ? [`${value.resultCount} supplied response entries; ${value.retainedResultCount ?? "unknown"} retained`] : []),
            ...(value.paginationPresent === true ? ["next-page indication: recorded"] : []),
            ...(value.returnedEntries ?? []).map(entry => `returned API entry ${entry.index + 1}: status ${entry.statusCode ?? "unavailable"}${entry.errorCode !== null ? `, code ${entry.errorCode}` : ""}${entry.paginationPresent === true ? ", next-page indication: recorded" : ""}`),
            value.contentStatus === "partial" ? "partial returned results; total entry count unknown"
                : `result content: ${(value.contentStatus ?? "definition not saved").replaceAll("-", " ")}`,
            ...(value.diagnosticStatus ? [`error details: ${value.diagnosticStatus.replaceAll("-", " ")}`] : []),
            ...(value.descriptionStatus ? [`source description: ${value.descriptionStatus.replaceAll("-", " ")}`] : []),
        ].join("; ") + ".";
        return { boundary: resultBoundary,
            unavailable: value.status === "unavailable" ? (unavailable[value.reason] ?? "Result-level comparison is unavailable.") + " Missing result facts are not zero." : null,
            shared: value.shared?.count ? `${value.shared.count} ${value.shared.count === 1 ? "call appears" : "calls appear"} in both reports; recorded result details differ for ${value.shared.changedTypedFacts}. These differences do not establish new executions.` : null,
            changes: (value.changes ?? []).map((change, index) => ({ title: `Changed call ${index + 1}: ${change.tool ?? "Native tool"} (${sourceNames[change.source]})`,
                baseline: change.baseline.map(observation).join(" Retained observation: "),
                later: change.later.map(observation).join(" Retained observation: ") })),
            additional: value.additionalChangedCalls ? `The report manifest lists ${value.additionalChangedCalls} more changed ${value.additionalChangedCalls === 1 ? "call" : "calls"}.` : null,
            groups: (value.groups ?? []).map(group => ({
                title: sourceNames[group.source], baseline: side(group.baseline, group.baselineState), later: side(group.later, group.laterState),
                change: group.applicationErrorDelta === null ? "Application-error change is unavailable: "
                    + ({ "source-population-missing": "one selected source cohort has no calls.", "source-namespace-differs": "source namespaces differ.",
                        "source-cohort-unavailable": "the selected source cohort cannot be established.",
                        "source-interpretation-unverified": "source interpretation or call identity is not verified.",
                        "application-result-coverage-incomplete": "explicit application-result coverage is incomplete." }[group.reason] ?? "the facts are not compatible.")
                    : `Recorded application-error share changed by ${group.applicationErrorDelta > 0 ? "+" : ""}${group.applicationErrorDelta.toFixed(1)} percentage points. This compares the selected source populations, not task correctness or a causal improvement.`,
            })),
        };
    }
    function renderResultComparison(host, value) {
        const content = resultComparisonContent(value);
        if (!content) return null;
        const element = (tag, text) => { const node = host.ownerDocument.createElement(tag); node.textContent = text; return node; };
        const section = element("section", "");
        section.className = "comparison-result-evidence";
        section.append(element("h2", "Application-result comparison"), element("p", content.boundary));
        if (content.unavailable) section.append(element("p", content.unavailable));
        if (content.shared) section.append(element("p", content.shared));
        for (const group of content.groups) {
            const block = element("section", "");
            block.append(element("h3", group.title), element("p", "Earlier: " + group.baseline),
                element("p", "Later: " + group.later), element("p", group.change));
            section.append(block);
        }
        for (const change of content.changes) {
            section.append(element("h3", change.title), element("p", "Earlier: " + change.baseline), element("p", "Later: " + change.later));
        }
        if (content.additional) section.append(element("p", content.additional));
        host.append(section);
        return section;
    }
    function resultTextNotice(coverage, scope = "this report") {
        if (coverage.total === 0) return `Result text was selected, but no copies belong to ${scope}.`;
        return [
            coverage.included ? `${coverage.included} masked ${coverage.included === 1 ? "copy" : "copies"} included` : "No result text included",
            ...(coverage.omitted ? [`${coverage.omitted} omitted`] : []),
            ...(coverage.unavailable ? [`${coverage.unavailable} unavailable`] : []),
        ].join("; ") + ".";
    }
    function resultTextSourcesContent(value) {
        if (value === null) return [{ title: "Recorded result text", notice: "Result text was not selected for this comparison.", copies: [] }];
        if (!value) return null;
        if (value.version !== 1 || value.mode !== "masked" || !Array.isArray(value.sources)) throw new TypeError("Unsupported saved result-text comparison.");
        return value.sources.map((source, index) => ({
            title: index ? "Later report: recorded result text" : "Earlier report: recorded result text",
            notice: !source.resultText ? source.reason === "not-in-source-report"
                ? "Result text was not included in this saved report. Original activity is not fetched."
                : "Result-text membership is not qualified for these source versions and this cohort."
                : resultTextNotice(source.resultText.coverage, "this source cohort")
                    + (source.unavailableSources?.length ? ` Result text is unavailable for ${source.unavailableSources.map(id => sourceNames[id]).join(", ")} in this cohort.` : ""),
            copies: (source.resultText?.copies ?? []).filter(copy => copy.text !== null).map(copy => ({
                key: copy.key, label: copy.label + (copy.entryIndex !== null ? ` / returned API entry ${copy.entryIndex + 1}` : "")
                    + (copy.representation === "edited-copy" ? " (edited source-report copy, not original wording)" : " (masked source-report copy)"),
                text: copy.text,
            })),
        }));
    }
    function renderResultTextSources(host, value) {
        const groups = resultTextSourcesContent(value);
        if (!groups) return;
        const element = (tag, text) => { const node = host.ownerDocument.createElement(tag); node.textContent = text; return node; };
        for (const group of groups) {
            const section = element("section", ""); section.className = "comparison-result-text";
            section.append(element("h2", group.title), element("p", group.notice));
            for (const copy of group.copies.slice(0, 12)) section.append(element("h3", copy.label), element("pre", copy.text));
            if (group.copies.length > 12) section.append(element("p", "Additional result-text copies remain in the saved files."));
            host.append(section);
        }
    }
    const readingNotesFor = model => model?.metricProjectionVersion === 4 || model?.definitions?.metricProjectionVersion === 4
        ? ["Missing measurements stay unavailable, not zero. Different definitions or scopes do not establish improvement.", readingNotes[3]]
        : model?.metricProjectionVersion === 3 || model?.definitions?.metricProjectionVersion === 3
        ? ["Personal feedback records opinions, not measured correctness or permission. Each result keeps its own request membership.",
            "Missing measurements stay unavailable, not zero. Different definitions or scopes do not establish improvement.", readingNotes[3]]
        : readingNotes;
    const labels = { success: "Succeeded", failure: "Failed", partial: "Partial", unknown: "Unknown", other: "Other", transport: "No response" };
    const outcomeTone = outcome => ({ success: "teal", failure: "pink", transport: "pink", partial: "orange", unknown: "slate", other: "slate" })[outcome];
    const reasons = {
        "unsupported-check": "No supported check for this evidence",
        "missing-evidence": "Not enough saved evidence",
        "usage-unavailable": "No attributable usage recorded",
        "pricing-unavailable": "Recorded usage has no price",
        "no-assessed-units": "No requests have a result for this check",
        "evaluator-failure": "Review could not finish",
        "metric-not-saved": "This measure was not saved",
        "baseline-metric-not-saved": "Not saved in the earlier report",
        "later-metric-not-saved": "Not saved in the later report",
        "unverified-association": "The record does not confirm which request the action belongs to",
        "missing-completion": "No completion was recorded",
        "nonbinary-outcome": "The recorded result is neither a pass nor a fail",
        "capture-disabled": "Optional response capture is off",
        "category-not-consented": "This evidence category is not enabled",
        "no-eligible-units": "No items in this selection can be used for this measure",
        "partial-evidence": "Not enough saved evidence; only part was saved",
        "invalid-timing": "The recorded times cannot establish this duration",
        "unsupported-adapter": "This source does not provide the evidence needed",
        "stale-consent": "Evidence permission changed; this result is no longer current",
        "stale-source": "The approved source changed; this result is no longer current",
        "stale-membership": "The request's recorded actions changed",
        "stale-override": "Personal feedback changed",
        "deletion-pending": "Local cleanup must finish before this result is available",
        "deleted-dependency": "Supporting activity was deleted",
        "credential-excluded": "Text was left out because it may contain credentials",
        "capture-limit": "Some evidence exceeded the saving limit",
        "user-verdict": "Your optional personal feedback",
        "user-withdrawn": "Personal feedback was withdrawn",
        "not-applicable": "This check does not apply to this recorded interaction",
    };
    const formatNumber = (value, maximumFractionDigits = 1) => new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
    function nativeRows(model) {
        const count = (value, state) => value !== null ? formatNumber(value, 0)
            : state === "source-not-present" ? "Not present" : state === "cohort-unavailable" ? "Cohort unavailable" : "Unavailable";
        const labels = { "native-conversation": "Conversations", "native-tool-call": "Tool calls",
            "native-returned-result-observation": "Result observations", "message-representation-observation": "Message observations",
            "message-representation-part": "Message parts", "native-task-state-observation": "Task states",
            "chat-source-observation": "Source observations" };
        const rows = [...model.nativeComparison?.units ?? [],
            ...(model.nativeComparison?.outcomes ?? []).flatMap(item => ["succeeded", "failed", "unknown"].map(outcome => ({
                sourceId: item.sourceId, unit: `Tool calls: ${outcome}`, baselineCount: item.baseline?.[outcome] ?? null,
                laterCount: item.later?.[outcome] ?? null,
                baselineState: item.baselineState, laterState: item.laterState,
                delta: item.comparable && item.baseline && item.later ? item.later[outcome] - item.baseline[outcome] : null,
                failure: outcome === "failed",
            })))];
        return rows.map(row => ({
            source: row.sourceId === "microsoft-365-chat" ? "Microsoft 365 Chat" : "Microsoft 365 Cowork",
            label: labels[row.unit] ?? row.unit,
            earlier: count(row.baselineCount, row.baselineState),
            later: count(row.laterCount, row.laterState),
            change: row.delta === null ? "Not comparable" : `${row.delta > 0 ? "+" : ""}${formatNumber(row.delta, 0)}`,
            numeric: [false, row.baselineCount !== null, row.laterCount !== null, row.delta !== null],
            empty: row.baselineCount === 0 && row.laterCount === 0,
            failure: row.failure === true,
        }));
    }
    function formatValue(value, unit, { signed = false } = {}) {
        if (!Number.isFinite(value)) throw new TypeError("Comparison values must be finite.");
        if (unit === "percent" || unit === "percentage-points") {
            const suffix = unit === "percent" ? "%" : " pp";
            if (value !== 0 && Math.abs(value) < 0.01) return `${value < 0 ? "−" : ""}<0.01${suffix}`;
            const displayed = unit === "percent" ? Math.floor(value * 100) / 100 : value;
            return `${formatNumber(displayed, 2)}${suffix}`;
        }
        if (unit === "ms" && duration) {
            const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
            const [primary, equivalent] = duration(Math.abs(value)).split(" (");
            return `${sign}${primary}${equivalent ? ` (${sign}${equivalent}` : ""}`;
        }
        if (unit === "ms") return value > 0 && value < 0.01 ? "<0.01 ms"
            : Math.abs(value) >= 1000 ? `${formatNumber(value / 1000, 2)} s` : `${formatNumber(value, 2)} ms`;
        if (/^[A-Z]{3}$/.test(unit)) {
            const amount = new Intl.NumberFormat(undefined, { style: "currency", currency: unit, minimumFractionDigits: 2, maximumFractionDigits: 6 });
            return value > 0 && value < 0.000001 ? `<${amount.format(0.000001)}` : amount.format(value);
        }
        throw new TypeError("Unsupported comparison display unit.");
    }
    function formatChange(value, unit) {
        if (!Number.isFinite(value)) throw new TypeError("Comparison changes must be finite.");
        return unit === "ms" && duration ? formatValue(value, unit, { signed: true })
            : `${value > 0 ? "+" : value < 0 ? "−" : ""}${formatValue(Math.abs(value), unit)}`;
    }
    function scoreTone(fact) {
        if (fact?.state !== "available" || fact.kind !== "pass-rate" || fact.unit !== "percent") return "";
        return fact.value < 50 ? "performance-red" : fact.value < 75 ? "performance-orange" : fact.value < 90 ? "performance-gold" : "performance-teal";
    }
    function modelOrigin(fact) {
        const qualifiers = fact.qualifiers ?? {};
        let label = `Model assessment${qualifiers.evaluatorModel ? ` · ${qualifiers.evaluatorModel}` : ""}`;
        if (qualifiers.rubricId != null || qualifiers.rubricVersion != null) {
            label += ` · rubric ${qualifiers.rubricId ?? "ID not saved"}${qualifiers.rubricVersion != null
                ? ` v${qualifiers.rubricVersion}` : " (version not saved)"}`;
        }
        return label;
    }
    function warningLabel(code, context) {
        if (code === "total-cost-volume-differs") return "Different volume; not cost per task";
        if (!["partial-coverage", "coverage-decreased"].includes(code)) return `Saved warning: ${code}`;
        const sides = context && (Object.hasOwn(context, "baseline") || Object.hasOwn(context, "later"))
            ? [context.baseline, context.later].filter(Boolean) : context?.kind ? [context] : [];
        const first = sides[0], same = first && sides.every(side => side.kind === first.kind && side.boundary === first.boundary);
        let missing = "Some items lack results", smaller = "Smaller share with results";
        if (same && first.kind === "pass-rate") {
            missing = "Some requests lack review results"; smaller = "Smaller share with review results";
        } else if (same && first.kind === "cost") {
            missing = "Some units lack cost data"; smaller = "Smaller share with cost data";
        } else if (same && first.kind === "duration" && ["tool-start-to-completion", "recorded-request-to-final-answer",
            "verified-request-to-final-answer", "http-dispatch-to-response-headers", "http-dispatch-to-transport-error"].includes(first.boundary)) {
            missing = `Some ${coverageUnit(first)} lack timing`; smaller = "Smaller share with timing";
        }
        return code === "partial-coverage" ? missing : smaller;
    }
    function coverageUnit(fact) {
        if (fact.kind === "pass-rate") return "requests";
        if (fact.kind === "cost") return "units";
        return fact.boundary === "tool-start-to-completion" ? "calls"
            : ["recorded-request-to-final-answer", "verified-request-to-final-answer"].includes(fact.boundary) ? "requests" : "HTTP records";
    }
    function absentPeerLabel(fact) {
        return fact?.kind === "pass-rate" ? "No comparable saved review on this side" : "No comparable saved measure on this side";
    }
    function metricPresentation(fact, dimension, { includeOrigin = true } = {}) {
        let note = "Not saved in this report";
        const review = ["accuracy", "answer-trust", "action-trust"].includes(dimension);
        const term = review && fact ? wording.resolve(fact) : null;
        const timedUnit = fact ? coverageUnit(fact) : "HTTP records";
        if (fact?.state !== "available" && fact) {
            const unsupported = {
                accuracy: "Tool outcomes do not tell us whether the answer was correct. AI review needs separate approval",
                "answer-trust": "Tool outcomes do not tell us whether the answer was supported. AI review needs separate approval",
                "action-trust": term?.explanation,
            };
            note = fact.reason === "unsupported-check" ? unsupported[dimension] ?? reasons[fact.reason]
                : fact.reason === "unverified-association" && fact.boundary === "verified-request-to-final-answer"
                    ? "No verified request-to-final-answer timing"
                    : reasons[fact.reason] ?? `Unavailable: ${fact.reason}`;
            if (includeOrigin && fact.basis === "model-assessment") note = `${modelOrigin(fact)} · ${note}`;
            if (fact.coverage) note += ` · ${formatNumber(fact.coverage.count, 0)} of ${formatNumber(fact.coverage.eligible, 0)} ${fact.kind === "pass-rate" ? "assessed" : fact.kind === "cost" ? "units priced" : `${timedUnit} timed`}`;
        }
        if (fact?.state === "available") {
            const covered = fact.coverage.count, eligible = fact.coverage.eligible;
            note = fact.kind === "pass-rate"
                ? `${includeOrigin ? `${fact.basis === "user-assessment" ? "Your feedback" : fact.basis === "model-assessment" ? modelOrigin(fact) : "Recorded check"} · ` : ""}${formatNumber(fact.numerator, 0)} of ${formatNumber(fact.denominator, 0)} passed · ${formatNumber(covered, 0)} of ${formatNumber(eligible, 0)} assessed · ${formatNumber(eligible - covered, 0)} not assessed${term?.kind === "match" ? " · request matching, not permission" : ""}`
                : `${formatNumber(covered, 0)} of ${formatNumber(eligible, 0)} ${fact.kind === "cost" ? "units priced" : `${timedUnit} timed`}`;
        }
        if (fact?.counts?.evaluatorError) note += ` · ${formatNumber(fact.counts.evaluatorError, 0)} check errors (not failed results)`;
        if (term && !term.known && fact.reason !== "unsupported-check") note += " · " + term.explanation;
        return {
            value: !fact ? "Not saved" : fact.state === "available" ? formatValue(fact.value, fact.unit) : review ? wording.unavailable(fact) : fact.reason === "not-applicable" ? "Not applicable" : fact.reason === "evaluator-failure" ? "Check unavailable"
                : fact?.kind === "pass-rate" || ["accuracy", "answer-trust", "action-trust"].includes(dimension) ? "Not assessed" : "Not measured",
            note, tone: scoreTone(fact),
        };
    }
    function comparisonSidePresentation(metric, side) {
        const presentSide = metric.reason === "later-metric-not-saved" ? "baseline"
            : metric.reason === "baseline-metric-not-saved" ? "later" : null;
        if (side === presentSide && !Object.hasOwn(metric, side)) return {
            value: "Not preserved",
            note: "This older comparison did not retain the metric summary. No value has been reconstructed.",
            tone: "",
        };
        const detail = sideDefinitionLabel(metric, side);
        const presented = metricPresentation(metric[side], metric.metric, { includeOrigin: !detail && !sharedOrigin(metric) });
        if (detail) presented.note = detail + " · " + presented.note;
        return presented;
    }
    function metricLabel(fact) {
        return ["accuracy", "answer-trust", "action-trust"].includes(fact?.metric) ? wording.resolve(fact).label : dimensions[fact?.metric] ?? "Saved measure";
    }
    function comparisonLabel(metric) {
        const labels = [...new Set([metric.baseline, metric.later].filter(Boolean).map(metricLabel))];
        return labels.length > 1 ? "Different saved reviews" : labels[0] ?? dimensions[metric.metric] ?? "Saved measure";
    }
    function metricDefinitionLabel(metric) {
        const fact = metric.baseline ?? metric.later;
        if (!fact) {
            const side = metric.reason === "later-metric-not-saved" ? "baseline" : metric.reason === "baseline-metric-not-saved" ? "later" : null;
            return side && !Object.hasOwn(metric, side) ? "Older comparison summary" : "";
        }
        return separateDefinitions(metric) ? sharedOrigin(metric) : factDefinitionLabel(fact);
    }
    function separateDefinitions(metric) {
        if (!Object.hasOwn(metric, "baseline") || !Object.hasOwn(metric, "later")) return false;
        if (!metric.baseline || !metric.later) return Boolean(metric.baseline || metric.later);
        const identity = fact => JSON.stringify([fact.metric, fact.kind, fact.basis, factDefinitionLabel(fact, true),
            fact.definitionId, fact.definitionVersion, fact.unit, fact.aggregation, fact.boundary,
            Object.entries(fact.qualifiers ?? {}).sort(([a], [b]) => a.localeCompare(b))]);
        return identity(metric.baseline) !== identity(metric.later);
    }
    function sideDefinitionLabel(metric, side) {
        const fact = metric[side];
        if (!fact || !separateDefinitions(metric)) return "";
        const differentLabels = metric.baseline && metric.later && metricLabel(metric.baseline) !== metricLabel(metric.later);
        return [differentLabels ? metricLabel(fact) : "", factDefinitionLabel(fact,
            Boolean(metric.baseline && metric.later), !sharedOrigin(metric))].filter(Boolean).join(" · ");
    }
    function factOriginLabel(fact) {
        return fact.basis === "user-assessment" ? "Your feedback"
            : fact.basis === "model-assessment" ? modelOrigin(fact)
                : fact.basis === "automatic-assessment" ? fact.reason === "unsupported-check" ? "Local observation (not a model assessment)" : "Automatic local checks"
                    : fact.basis === "mixed-assessment" ? "Mixed assessments" : "Recorded checks";
    }
    function sharedOrigin(metric) {
        const identity = fact => JSON.stringify([fact.basis, ...["evaluatorProvider", "evaluatorModel", "rubricId", "rubricVersion"]
            .map(key => fact.qualifiers?.[key])]);
        return metric.baseline?.kind === "pass-rate" && metric.later?.kind === "pass-rate"
            && identity(metric.baseline) === identity(metric.later)
            && factOriginLabel(metric.baseline) === factOriginLabel(metric.later) ? factOriginLabel(metric.baseline) : "";
    }
    function factDefinitionLabel(fact, includeIdentity = false, includeOrigin = true) {
        if (fact.kind === "duration") return ({
            "tool-start-to-completion": "Median tool latency",
            "http-dispatch-to-response-headers": "Median HTTP response time",
            "http-dispatch-to-transport-error": "Median time to transport error",
            "verified-request-to-final-answer": "Whole-interaction time",
            "recorded-request-to-final-answer": "Time to recorded final response",
        })[fact.boundary] ?? fact.boundary;
        if (fact.kind === "cost") return fact.basis === "estimated" ? "Estimated attributed subtotal" : fact.basis === "observed" ? "Recorded attributed subtotal" : "Attributed cost";
        const origin = factOriginLabel(fact);
        if (fact.kind !== "pass-rate" || !includeIdentity && wording.resolve(fact).known) return origin;
        const id = fact.qualifiers?.checkId, version = fact.qualifiers?.checkVersion;
        return `${includeOrigin ? origin + " · " : ""}${id ? `Saved check ${id}` : "Check ID not recorded"} · ${version != null ? `check version ${version}` : "Check version not recorded"}`;
    }
    function metricGroups(metrics) {
        const available = metrics.filter(metric => metric.baseline?.state === "available" || metric.later?.state === "available");
        const unavailable = metrics.filter(metric => !available.includes(metric));
        return { available, unavailable, unavailableLabel: [...new Set(unavailable.map(metric =>
            metric.metric === "speed" ? metricDefinitionLabel(metric) || dimensions.speed : comparisonLabel(metric)))].join(" · ") };
    }
    function scopeNotes(model) {
        const notes = [];
        const scopeLabels = {
            "selectionKind-not-recorded": "report selection scope was not saved",
            "timeZone-not-recorded": "report time zone was not saved",
            "collectionDefinition-not-recorded": "collection definition was not saved",
            "selection-kind-differs": "report selection scopes differ",
            "selected-timezone-differs": "report time zones differ",
            "collection-definition-differs": "collection definitions differ",
            "per-call-time-windows-unverified": "per-call activity dates cannot be verified",
            "complete-history-not-established": "complete history is not established",
        };
        if (model.scopeDifferences?.length) notes.push(`Scope differences: ${model.scopeDifferences.map(code => scopeLabels[code] ?? code.replaceAll("-", " ")).join("; ")}.`);
        const primary = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
        const units = model.primaryEvidence?.unitLabel ?? "calls";
        if (primary?.overlap) notes.push(primary.overlap.verified
            ? `${formatNumber(primary.overlap.sharedCount, 0)} ${units} occur in both snapshots; ${formatNumber(primary.overlap.changedCount, 0)} have changed recorded outcomes or pattern assignments.`
            : `Repeated ${units} between these reports could not be verified.`);
        if (primary?.matched) {
            const coverage = side => {
                const value = primary.matched[`${side}Coverage`];
                return `${formatNumber(value.numerator, 0)} of ${formatNumber(value.denominator, 0)} ${units}${value.percent === null ? " (not applicable)" : ` (${formatValue(value.percent, "percent")})`}`;
            };
            notes.push(`Matched-pattern coverage: ${coverage("baseline")} earlier; ${coverage("later")} later. Unmatched patterns remain separate.`);
        }
        for (const [kind, layer] of Object.entries(model.layerComparisons ?? {})) {
            if (kind === "tool-call") continue;
            if (model.metricProjectionVersion === 4 && kind !== model.primaryLayer
                && (layer.baselineCount === 0 && layer.laterCount === 0
                    || layer.raw?.baseline?.count === 0 && layer.raw?.later?.count === 0)) continue;
            if (kind === "graph-code-reference") notes.push(`Code references: ${layer.baselineCount ?? "not recorded"} earlier; ${layer.laterCount ?? "not recorded"} later. ${layer.note}`);
            else if (layer.raw) notes.push(`${layer.unit}: ${layer.raw.baseline.count} earlier; ${layer.raw.later.count} later. ${layer.note}`);
            else notes.push(`${layer.unit}: not saved in both reports. ${layer.note}`);
        }
        return notes;
    }
    function render(root, model, { onInspectPattern } = {}) {
        if (!root?.ownerDocument || typeof root.replaceChildren !== "function") throw new TypeError("Comparison rendering requires a document element.");
        if (!model || model.schemaVersion !== 1 || !Array.isArray(model.metrics)) throw new TypeError("Comparison rendering requires a supported model.");
        const document = root.ownerDocument;
        const el = (tag, className, text) => {
            const node = document.createElement(tag);
            if (className) node.className = className;
            if (text !== undefined) node.textContent = String(text);
            return node;
        };
        const panel = el("section", "report-comparison");
        panel.setAttribute("aria-label", "Report comparison");
        if (model.displayCompatibility?.mode === "frozen-source-facts-only") {
            panel.append(el("p", "comparison-notice", model.displayCompatibility.message));
        }
        if (model.reason === "same-snapshot") {
            panel.append(el("p", "comparison-notice", "Choose two different saved reports."));
            root.replaceChildren(panel);
            return;
        }
        const scopeChanged = model.scopeDifferences?.some(code => ["selection-kind-differs", "collection-definition-differs"].includes(code));
        const unverifiedOverlap = model.toolComparison?.overlap?.verified === false && model.primaryLayer === "tool-call"
            && !["empty-baseline", "empty-later", "no-matched-patterns"].includes(model.toolComparison.reason)
            && !scopeChanged && model.reason !== "pattern-definition-changed";
        if (unverifiedOverlap) {
            panel.append(el("p", "comparison-notice", "Overlap is unverified; the difference may include previously counted calls."));
        } else if (model.narrative) {
            const narrative = el("div", "comparison-takeaway");
            narrative.append(el("h2", "", model.narrative.heading), el("p", "muted", model.narrative.detail));
            panel.append(narrative);
        } else if (model.status === "unavailable") {
            panel.append(el("p", "comparison-notice", "These report facts are not compatible. The original reports remain unchanged."));
        }
        renderResultComparison(panel, model.resultComparison);
        renderResultTextSources(panel, model.resultTextSources ?? (model.resultProjectionVersion === 1 ? null : undefined));
        if (model.nativeComparison) {
            const section = el("section", "comparison-native-results");
            section.append(el("h2", "", "Microsoft activity"));
            if (model.nativeComparison.reason) section.append(el("p", "comparison-notice",
                "Source coverage or definitions differ; some changes cannot be compared."));
            const makeTable = rows => {
                const table = el("table", "comparison-metrics"), head = el("thead"), header = el("tr"), body = el("tbody");
                for (const [index, title] of ["Source and measure", "Earlier", "Later", "Change"].entries()) {
                    const cell = el("th", index ? "report-numeric" : "", title); cell.scope = "col"; header.append(cell);
                }
                head.append(header); table.append(head);
                for (const row of rows) {
                    const tr = el("tr"), label = el("th", row.failure ? "report-negative" : "", row.label); label.scope = "row";
                    label.append(el("span", "comparison-meta", row.source)); tr.append(label);
                    for (const [index, value] of [row.earlier, row.later, row.change].entries()) {
                        const td = el("td", row.numeric[index + 1] ? "report-numeric" : "report-cell-text");
                        td.append(el("span", "comparison-mobile-label", ["Earlier", "Later", "Change"][index]), el("span", "", value)); tr.append(td);
                    }
                    body.append(tr);
                }
                table.append(body); return table;
            };
            const rows = nativeRows(model), populated = rows.filter(row => !row.empty), empty = rows.filter(row => row.empty);
            if (populated.length) section.append(makeTable(populated));
            if (empty.length) {
                const details = el("details");
                details.append(el("summary", "", `Zero counts (${empty.length})`), makeTable(empty)); section.append(details);
            }
            panel.append(section);
        }
        function metricCell(metric, side) {
            const cell = el("td");
            const sideLabel = el("span", "comparison-mobile-label", side === "baseline" ? "Earlier" : "Later");
            sideLabel.setAttribute("aria-hidden", "true");
            const presentation = comparisonSidePresentation(metric, side);
            const value = el("strong", `comparison-metric-value ${presentation.tone}`, presentation.value);
            cell.append(sideLabel, value, el("span", "comparison-meta", presentation.note));
            return cell;
        }
        function metricTable(metrics, label) {
            const table = el("table", "comparison-metrics");
            const caption = el("caption", "", label);
            table.append(caption);
            const head = el("thead"), header = el("tr");
            for (const title of ["Measure", "Earlier report", "Later report", "Change"]) {
                const cell = el("th", "", title);
                cell.scope = "col";
                header.append(cell);
            }
            head.append(header);
            table.append(head);
            const body = el("tbody");
            for (const metric of metrics) {
                if (!Object.hasOwn(dimensions, metric.metric)) throw new TypeError("Comparison contains an unknown dimension.");
                const row = el("tr");
                const title = el("th", "", comparisonLabel(metric));
                title.scope = "row";
                const detail = metricDefinitionLabel(metric);
                if (detail) title.append(el("span", "comparison-meta", detail));
                row.append(title, metricCell(metric, "baseline"), metricCell(metric, "later"));
                const change = el("td");
                const mobile = el("span", "comparison-mobile-label", "Change");
                mobile.setAttribute("aria-hidden", "true");
                change.append(mobile);
                if (metric.status === "comparable" && metric.delta) {
                    const delta = metric.delta;
                    change.append(el("strong", "comparison-delta", delta.value === 0 ? "Unchanged" : formatChange(delta.value, delta.unit)));
                    if (metric.warnings?.includes("coverage-decreased")) change.append(el("span", "comparison-meta", warningLabel("coverage-decreased", metric)));
                    else if (metric.warnings?.includes("total-cost-volume-differs")) change.append(el("span", "comparison-meta", warningLabel("total-cost-volume-differs", metric)));
                    else if (delta.unit === "percentage-points") change.append(el("span", "comparison-meta", "Percentage points"));
                } else {
                    change.append(el("span", "muted", metric.status === "incompatible" ? "Different definitions" : "Not comparable"));
                    if (metric.reason) change.append(el("span", "comparison-meta", reasons[metric.reason] ?? metric.reason));
                }
                row.append(change);
                body.append(row);
            }
            table.append(body);
            return table;
        }
        let patternTable;
        const tool = model.layerComparisons?.[model.primaryLayer] ?? model.toolComparison;
        const evidence = model.primaryEvidence ?? { heading: "Recorded tool results", scoreLabel: "Recorded tool success", unitLabel: "calls", successVerb: "succeeded", note: "Tool execution is separate from answer accuracy and trust." };
        if (tool) {
            const section = el("section", "comparison-tool-results");
            section.append(el("h2", "", evidence.heading));
            if (evidence.note && (model.primaryLayer && model.primaryLayer !== "tool-call" || model.resultProjectionVersion === 1)) section.append(el("p", "comparison-meta", evidence.note));
            const pair = el("div", "comparison-score-pair");
            for (const [side, totals] of [["Earlier", tool.raw.baseline], ["Later", tool.raw.later]]) {
                const card = el("article", "comparison-score");
                card.append(el("h3", "", side), el("p", "comparison-meta", evidence.scoreLabel));
                card.append(el("strong", "comparison-score-value", !totals.count ? `No ${evidence.unitLabel}`
                    : totals.success + totals.failure === 0 ? model.metricProjectionVersion === 4 ? "Success rate unavailable" : "Not scored"
                        : formatValue(totals.successRate.percent, "percent")));
                card.append(el("p", "comparison-meta", `${formatNumber(totals.success, 0)} of ${formatNumber(totals.count, 0)} ${evidence.unitLabel} ${evidence.successVerb}`));
                const strip = el("div", "comparison-outcome-strip");
                strip.setAttribute("aria-hidden", "true");
                for (const outcome of Object.keys(labels)) if (totals[outcome]) {
                    const segment = el("span", `comparison-outcome-${outcome} dimensional-tone-${outcomeTone(outcome)}`);
                    segment.style.flexGrow = String(totals[outcome]);
                    strip.append(segment);
                }
                card.append(strip);
                const counts = el("dl", "comparison-outcome-counts");
                for (const outcome of Object.keys(labels)) {
                    if (["other", "transport"].includes(outcome) && !totals[outcome]) continue;
                    const item = el("div");
                    const label = model.primaryLayer && model.primaryLayer !== "tool-call"
                        ? ({ success: "2xx recorded", failure: "Error result", partial: "Partial", unknown: "Status missing", other: "Other status", transport: "No response" })[outcome] : labels[outcome];
                    item.append(el("dt", "", label), el("dd", "", formatNumber(totals[outcome], 0)));
                    counts.append(item);
                }
                card.append(counts);
                pair.append(card);
            }
            section.append(pair);
            if (tool.patterns.length) {
                const table = el("table", "comparison-patterns");
                table.append(el("caption", "", "The same technical patterns, side by side"));
                const head = el("thead"), header = el("tr");
                for (const title of ["Pattern", "Earlier failures", "Later failures", "Change"]) {
                    const cell = el("th", "", title);
                    cell.scope = "col";
                    header.append(cell);
                }
                head.append(header);
                table.append(head);
                const body = el("tbody"), displays = new Map((model.patternDisplays ?? []).map(item => [item.patternId, item]));
                for (const pattern of tool.patterns) {
                    const row = el("tr"), name = el("th");
                    name.scope = "row";
                    const display = displays.get(pattern.patternId);
                    const label = display?.available ? `${display.workload} · ${display.tool}` : "Pattern details unavailable";
                    const title = el(typeof onInspectPattern === "function" ? "button" : "span", "comparison-pattern-title", label);
                    if (typeof onInspectPattern === "function") {
                        title.type = "button";
                        title.addEventListener("click", () => onInspectPattern(pattern.patternId));
                    }
                    name.append(title);
                    if (display?.endpoints?.length) name.append(el("span", "comparison-meta comparison-endpoint", display.endpoints.map(endpoint => endpoint.pathTemplate).join(" · ")));
                    if (display?.targetShape === "unavailable") name.append(el("span", "comparison-meta", "Tool-level match; endpoint not recorded"));
                    row.append(name);
                    for (const [side, totals] of [["Earlier", pattern.baseline], ["Later", pattern.later]]) {
                        const cell = el("td"), mobile = el("span", "comparison-mobile-label", side);
                        mobile.setAttribute("aria-hidden", "true");
                        cell.append(mobile, el("strong", "", totals.count ? formatValue(totals.failureRate.percent, "percent") : "Not present"));
                        if (totals.count) cell.append(el("span", "comparison-meta", `${formatNumber(totals.failure, 0)} of ${formatNumber(totals.count, 0)} ${evidence.unitLabel}`));
                        row.append(cell);
                    }
                    const delta = el("td"), mobile = el("span", "comparison-mobile-label", "Change");
                    mobile.setAttribute("aria-hidden", "true");
                    delta.append(mobile);
                    const change = pattern.change.failure;
                    delta.append(el("span", "", change === null ? pattern.presence === "baseline-only" ? "Not in later report" : "Only in later report"
                        : change === 0 ? "Unchanged" : `${change < 0 ? "↓" : "↑"} ${formatNumber(Math.abs(change))} pp`));
                    row.append(delta);
                    body.append(row);
                }
                table.append(body);
                patternTable = table;
            }
            panel.append(section);
        }
        const { available, unavailable, unavailableLabel } = metricGroups(model.metrics);
        if (available.length) panel.append(metricTable(available, "Recorded measures"));
        if (unavailable.length) {
            const disclosure = el("details", "comparison-unavailable");
            const summary = el("summary", "", `Measures without a result (${unavailable.length})`);
            summary.append(el("span", "comparison-meta", unavailableLabel));
            disclosure.append(summary, metricTable(unavailable, "Unavailable measures and coverage"));
            panel.append(disclosure);
        }
        if (patternTable) panel.append(patternTable);
        const details = el("details", "comparison-reading");
        details.append(el("summary", "", "Scope, coverage and reading notes"));
        const notes = el("div");
        for (const text of readingNotesFor(model)) notes.append(el("p", "", text));
        notes.append(el("p", "", comparisonNote));
        if (![3, 4].includes(model.metricProjectionVersion)) notes.append(el("p", "", "Pass-share colors describe assessed results only: below 50%, 50–74%, 75–89%, and 90%+. They are not a combined quality grade."));
        for (const text of scopeNotes(model)) notes.append(el("p", "", text));
        details.append(notes);
        panel.append(details);
        root.replaceChildren(panel);
    }
    return {
        presentation,
        readingNotes, readingNotesFor,
        comparisonNote,
        resultBoundary, timingFailureText, resultComparisonContent, renderResultComparison, resultTextNotice, resultTextSourcesContent, renderResultTextSources,
        scopeNotes,
        outcomeTone,
        formatValue,
        formatChange,
        metricPresentation,
        metricLabel,
        comparisonLabel,
        sideDefinitionLabel,
        warningLabel,
        coverageUnit,
        absentPeerLabel,
        comparisonSidePresentation,
        metricGroups,
        nativeRows,
        definitionLabel: metricDefinitionLabel,
        dimensionLabel(key) {
            if (!Object.hasOwn(dimensions, key)) throw new TypeError("Unknown report dimension.");
            return dimensions[key];
        },
        render,
        clear(root) {
            if (!root || typeof root.replaceChildren !== "function") throw new TypeError("Comparison clearing requires a document element.");
            root.replaceChildren();
        },
    };
}

export const reportComparisonStyles = `
.comparison-native-results .comparison-metrics thead{background:transparent}
.comparison-native-results .comparison-metrics :is(th,td).report-numeric{text-align:right;font-variant-numeric:tabular-nums}
.comparison-native-results .comparison-metrics :is(th,td).report-cell-text{text-align:left}
.comparison-native-results .report-negative{color:var(--danger)}
.comparison-native-results details{margin-top:.5rem}
.comparison-native-results summary{min-height:44px;padding:.65rem 0;cursor:pointer}
.report-comparison{color:var(--ink);font-family:var(--font);font-size:var(--type-body,.875rem);line-height:var(--leading-ui,1.43);font-variant-numeric:tabular-nums;min-width:0}
.comparison-takeaway{margin:0 0 24px}.comparison-takeaway h2{font-size:var(--type-section,1.125rem);line-height:var(--leading-section,1.333);margin:0 0 6px}.comparison-takeaway p{margin:0;line-height:var(--leading-reading,1.625)}
.comparison-notice{padding:16px;background:var(--canvas);border:1px solid var(--rule);border-radius:var(--radius)}
.comparison-metrics,.comparison-patterns{width:100%;border-collapse:collapse;table-layout:fixed;margin:0 0 28px;font-size:var(--type-body,.875rem)}
.comparison-metrics caption,.comparison-patterns caption{text-align:left;font-size:var(--type-section,1.125rem);font-weight:var(--weight-strong,600);margin:0 0 14px}
.comparison-metrics th,.comparison-metrics td,.comparison-patterns th,.comparison-patterns td{padding:14px 12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--rule);overflow-wrap:anywhere}
.comparison-metrics thead,.comparison-patterns thead{background:var(--canvas);color:var(--muted);font-size:var(--type-caption,.75rem)}
.comparison-metrics th:first-child,.comparison-patterns th:first-child{width:30%}.comparison-metrics tbody th,.comparison-patterns tbody th{font-weight:600}
.comparison-metric-value{display:block;font-size:var(--type-data-value,1.375rem);font-weight:var(--weight-strong,600);line-height:var(--leading-data-value,1.35)}.comparison-delta{display:block;font-size:var(--type-section,1.125rem)}
.comparison-meta{display:block;margin:4px 0 0;font-size:var(--type-caption,.75rem);font-weight:var(--weight-regular,400);line-height:var(--leading-caption,1.333);color:var(--muted);overflow-wrap:anywhere}
.comparison-metric-value.performance-red{color:var(--performance-red,var(--ink))}.comparison-metric-value.performance-orange{color:var(--performance-orange,var(--ink))}
.comparison-metric-value.performance-gold{color:var(--performance-gold,var(--ink))}.comparison-metric-value.performance-teal{color:var(--performance-teal,var(--ink))}
.comparison-tool-results{margin-top:26px}.comparison-tool-results h2{font-size:var(--type-section,1.125rem);margin:0}
.comparison-unavailable{margin:0 0 24px;border-block:1px solid var(--rule)}
.comparison-unavailable>summary,.comparison-report-identity>summary{min-height:44px;padding:10px 0;cursor:pointer;font-size:var(--type-small,.875rem)}
.comparison-unavailable>summary:focus-visible,.comparison-report-identity>summary:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.comparison-unavailable .comparison-metric-value{font-size:var(--type-body,.875rem)}
.comparison-report-choice{flex:1 1 16rem;min-width:0}.comparison-report-choice label{display:flex;flex-direction:column;gap:var(--space-sm)}
.comparison-report-identity{margin:0;font-size:var(--type-caption,.75rem)}.comparison-report-identity p{margin:0 0 8px}
.comparison-prepared-files{min-width:0;margin:16px 0}.comparison-prepared-files .report-frame{width:100%;min-height:420px;height:60vh;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--paper)}
.comparison-prepared-files summary{min-height:44px;padding:12px 0;cursor:pointer;overflow-wrap:anywhere}.comparison-prepared-files pre{max-height:24rem;max-width:100%;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.comparison-prepared-files :is(summary,pre):focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.comparison-score-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,10rem),1fr));border:1px solid var(--rule);border-radius:var(--radius);background:var(--paper);overflow:hidden;margin:18px 0 26px}
.comparison-score{padding:22px;min-width:0}.comparison-score+.comparison-score{border-left:1px solid var(--rule)}.comparison-score h3{font-size:1rem;margin:0 0 8px}
.comparison-score-value{display:block;font-size:var(--type-score,3rem);letter-spacing:-.04em;line-height:1.2;margin:7px 0;overflow-wrap:anywhere}
.comparison-outcome-strip{display:flex;gap:0;height:10px;border-radius:var(--radius-pill);overflow:hidden;margin:18px 0}.comparison-outcome-strip span{flex-basis:0;min-width:0;background:var(--column-label);background-image:linear-gradient(90deg,var(--chart-mark-low),var(--chart-mark-high))}
.comparison-outcome-counts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,5rem),1fr));gap:12px;margin:0}.comparison-outcome-counts dt{font-size:var(--type-caption,.75rem);color:var(--muted)}
.comparison-outcome-counts dd{font-size:1.25rem;font-weight:600;margin:3px 0 0}
.comparison-pattern-title{display:block;min-height:44px;max-width:100%;border:0;border-radius:var(--radius-small,8px);background:none;padding:5px 0;text-align:left;color:var(--accent);font:inherit;font-weight:var(--weight-strong,600);overflow-wrap:anywhere;cursor:pointer}
span.comparison-pattern-title{cursor:default;color:var(--ink)}
button.comparison-pattern-title:is(:hover,:active){background:transparent;color:var(--ink)}
.comparison-pattern-title:focus-visible,.comparison-reading summary:focus-visible{outline:2px solid var(--focus);outline-offset:4px}
.comparison-endpoint{font-family:var(--mono,monospace);font-size:.75rem}
.comparison-reading{border-top:1px solid var(--rule);margin-top:22px;color:var(--muted);font-size:.875rem}
.comparison-reading summary{min-height:44px;padding:12px 0;cursor:pointer;font-weight:500}.comparison-reading p{line-height:1.65}
.comparison-mobile-label{display:none}
@media(max-width:760px){.comparison-outcome-counts{grid-template-columns:1fr 1fr}.comparison-score{padding:18px}}
@media(max-width:600px){
 .comparison-metrics,.comparison-patterns,.comparison-metrics tbody,.comparison-patterns tbody{display:block}
 .comparison-metrics caption,.comparison-patterns caption{display:block;width:100%}
 .comparison-metrics thead,.comparison-patterns thead{position:absolute;width:1px;height:1px;clip-path:inset(50%);overflow:hidden}
 .comparison-metrics tbody tr,.comparison-patterns tbody tr{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,7rem),1fr));gap:12px;padding:14px 0;border-bottom:1px solid var(--rule)}
 .comparison-metrics tbody th,.comparison-patterns tbody th{display:block;grid-column:1/-1;width:auto!important;padding:0 0 12px;border:0}
 .comparison-metrics td,.comparison-patterns td{display:block;padding:0;border:0;min-width:0}
 .comparison-mobile-label{display:block;color:var(--muted);font-size:.75rem;margin-bottom:5px}
 .comparison-metric-value{font-size:1.125rem}.comparison-meta{font-size:.75rem}.comparison-delta{font-size:1rem}
 .comparison-score{padding:15px}.comparison-score-value{font-size:2.5rem}.comparison-score h3{font-size:.9375rem}
 .comparison-outcome-counts{gap:10px}.comparison-outcome-counts dt{font-size:.75rem}.comparison-outcome-counts dd{font-size:1.125rem}
}
@media(forced-colors:active){.comparison-outcome-strip span{background:CanvasText;border:1px solid CanvasText}.comparison-metric-value{color:CanvasText!important}}
`;
