// Self-contained for the nonce-authorized browser shell.
export function createRecordedResults({ scope = () => null, screen = false } = {}) {
    const keys = ["success", "failure", "unknown", "partial", "other", "transport"];
    const icons = { success: "check", failure: "result-failure", unknown: "unobserved", partial: "result-partial", other: "result-other", transport: "result-transport" };
    function icon(key) {
        if (!Object.hasOwn(icons, key)) throw new TypeError("Result icons require a recorded outcome.");
        return icons[key];
    }
    const units = {
        tool: ["Work IQ tool call", "Work IQ tool calls"],
        "reported-api": ["tool-returned API result", "tool-returned API results"],
        "direct-request": ["recorded Graph request site", "recorded Graph request sites"],
        "recorded-http": ["Graph request site with visible status", "Graph request sites with visible status"],
        http: ["owned HTTP record", "owned HTTP records"],
        "code-reference": ["Graph code reference", "Graph code references"],
    };
    function labels(layer) {
        if (layer === "tool") return { success: screen ? "Tool completed" : "Worked", failure: "Tool failed", unknown: "No result recorded", partial: screen ? "Partial completion" : "Partly worked", other: "Other HTTP status", transport: "Connection failed" };
        return { success: "HTTP 2xx", failure: layer === "reported-api" ? "Error result" : "HTTP 4xx/5xx", unknown: layer === "code-reference" ? "Execution not observed" : "No status recorded", partial: "Partial result", other: "Other HTTP status", transport: "Connection failed" };
    }
    function selection(value) {
        if (value == null || value === "" || value === "all") return [];
        const values = [...new Set(Array.isArray(value) ? value : value.split(","))];
        return [...keys.filter(key => values.includes(key)), ...values.filter(key => !keys.includes(key)).sort()];
    }
    function filterValue(value) {
        const values = selection(value);
        if (values.some(key => !keys.includes(key))) return Array.isArray(value) ? value.join(",") : value;
        return values.length && values.length !== keys.length ? values.join(",") : undefined;
    }
    function summarize(rows) {
        if (!Array.isArray(rows)) return null;
        const unique = new Map();
        for (const row of rows) {
            if (!row || typeof row.id !== "string" || !keys.includes(row.outcome)) return null;
            if (unique.has(row.id) && unique.get(row.id).outcome !== row.outcome) return null;
            unique.set(row.id, row);
        }
        const counts = { count: unique.size, ...Object.fromEntries(keys.map(key => [key, 0])) };
        for (const row of unique.values()) counts[row.outcome]++;
        return counts;
    }
    function valid(summary) {
        return summary && Number.isSafeInteger(summary.count) && summary.count >= 0
            && keys.every(key => Number.isSafeInteger(summary[key]) && summary[key] >= 0)
            && keys.reduce((sum, key) => sum + summary[key], 0) === summary.count;
    }
    function entries(layer, summary) {
        if (!valid(summary)) return null;
        if (layer === "code-reference") return summary.count ? [{ key: "unknown", label: "Execution not observed", count: summary.count, icon: "unobserved" }] : [];
        const names = labels(layer);
        return keys.filter(key => summary[key] > 0).map(key => ({ key, label: names[key], count: summary[key], icon: icon(key) }));
    }
    function primaryFailureCause(call, contextual = false) {
        const evidence = call?.failureEvidence;
        if (evidence?.version !== 1) return null;
        if (evidence.diagnostic?.version === 1 && (evidence.diagnostic.message && !genericMessage(evidence.diagnostic)
            || evidence.diagnostic.details?.some(detail => detail.message || detail.code != null || detail.statusCode != null))) {
            return (contextual ? "" : "Recorded error: ") + diagnosticSummary(evidence.diagnostic);
        }
        // These signals were qualified at retention. Never re-read error prose or infer from HTTP status.
        if (evidence.messageStatus === "text-excluded") {
            if (evidence.messageSignal === "mcp-server-path-not-found" && evidence.messageSource === "workiq-error-json") return "Work IQ could not find the requested MCP server";
            if (evidence.messageSignal === "response-processing-error" && evidence.messageSource === "workiq-error-json"
                && evidence.code === "InternalServerError") return "Work IQ could not process the response (InternalServerError)";
            if (evidence.messageSignal === "workiq-sign-in-required") return "Sign-in was required";
            if (evidence.messageSignal === "access-denial") return "Access was denied";
            if (evidence.messageSignal === "request-timeout") return "Request timed out (MCP -32001)";
        }
        if (evidence.reason === "error-code-recorded" && evidence.code && evidence.code !== "failure") {
            return (contextual ? "" : "Recorded error: ") + diagnosticSummary({
                ...(evidence.diagnostic?.version === 1 ? evidence.diagnostic : {}), code: evidence.code,
            });
        }
        if (evidence.diagnostic?.version === 1 && evidence.diagnostic.code != null && evidence.diagnostic.code !== "failure") {
            return (contextual ? "" : "Recorded error: ") + diagnosticSummary(evidence.diagnostic);
        }
        if (evidence.diagnostic?.version === 1 && evidence.diagnostic.statusCode != null) return "Tool-reported status: " + evidence.diagnostic.statusCode;
        if (evidence.diagnostic?.version === 1 && (evidence.diagnostic.message && !genericMessage(evidence.diagnostic)
            || evidence.diagnostic.details?.length)) return "Recorded error details";
        return null;
    }
    function failureCause(call, contextual = false, includeReturned = true) {
        const diagnostic = call?.resultEvidence?.version === 1 ? call.resultEvidence.diagnostic : null;
        const result = diagnostic?.version === 1 && !genericMessage(diagnostic) ? diagnosticSummary(diagnostic) : "";
        const duplicate = diagnostic && JSON.stringify(diagnostic) === JSON.stringify(call?.failureEvidence?.diagnostic);
        return [primaryFailureCause(call, contextual), result && !duplicate ? (contextual ? "Result error: " : "Recorded result error: ") + result : null,
            includeReturned ? returnedErrorSummary(call) : null].filter(Boolean).join("\n") || null;
    }
    function failureReason(call, { contextual = false, includeReturned = true } = {}) {
        const cause = failureCause(call, contextual, includeReturned);
        if (cause) return cause;
        if (!includeReturned && returnedErrorSummary(call)) return null;
        const evidence = call?.failureEvidence;
        if (evidence?.version !== 1) return "Failure reason was not saved";
        const diagnostic = evidence.diagnostic;
        if (diagnostic?.version === 1) {
            if (genericMessage(diagnostic)) return "The source supplied only a generic failure message";
            if (diagnostic.status === "not-supplied") return "The source did not supply error details";
            if (diagnostic.status === "recorded" && diagnostic.code === "failure") return "The source supplied only a generic failure marker";
            if (diagnostic.status === "sensitive-excluded") return "Error details excluded for privacy";
            if (diagnostic.status === "size-excluded") return "Error details exceeded the saving limit";
            if (diagnostic.status === "unsupported-format") return "Error details were in an unsupported format";
        }
        if (evidence.messageStatus === "sensitive-excluded") return "Error text excluded for privacy";
        if (evidence.messageStatus === "size-excluded") return "Error text exceeded the saving limit";
        if (evidence.reason === "unsupported-error-format" || evidence.messageStatus === "unsupported-format") return "Error format was not supported";
        if (["error-details-excluded", "result-content-excluded"].includes(evidence.reason)
            || evidence.messageStatus === "text-excluded") return "Error text was not saved";
        return evidence.messageStatus === "not-supplied" ? "The source did not supply a failure reason" : "Failure reason unavailable";
    }
    function sourceExcerpt(text) {
        const points = Array.from(text.replace(/\s+/g, " ").trim());
        if (points.length <= 240) return points.join("");
        const leading = points.slice(0, 72).join(""), trailing = points.slice(-160).join("");
        const head = points[71] !== " " && points[72] !== " " ? leading.replace(/\S+$/, "") : leading;
        const tail = points.at(-161) !== " " && points.at(-160) !== " " ? trailing.replace(/^\S+/, "") : trailing;
        return [head.trim() || leading, "...", tail.trim() || trailing].join(" ");
    }
    function diagnosticSummary(value, returnedStatus) {
        const parts = [{ ...value, statusCode: value.statusCode ?? returnedStatus }, ...(value.details ?? [])];
        const unique = new Map(parts.map(part => [JSON.stringify([part.message, part.code, part.statusCode]), part]));
        return [...unique.values()].map(part => diagnosticPart(part)).filter(Boolean).join("\n");
    }
    function diagnosticPart(value) {
        const message = value.message && !genericMessage(value) ? value.message : null;
        const qualifiers = [];
        if (value.code != null && value.code !== "failure" && !message?.includes(String(value.code))) qualifiers.push(String(value.code));
        const status = value.statusCode;
        if (Number.isInteger(status) && status >= 100 && status <= 599) qualifiers.push("status " + status);
        return message ? sourceExcerpt(message) + (qualifiers.length ? ` (${qualifiers.join("; ")})` : "")
            : qualifiers.join("; ");
    }
    function returnedErrorSummary(call) {
        const returned = (call?.apiResults ?? []).flatMap(result => {
            const diagnostic = result.errorDiagnostic?.version === 1 ? result.errorDiagnostic : {};
            const code = diagnostic.code ?? result.errorCode;
            const message = diagnosticSummary({ ...diagnostic, code }, result.statusCode);
            return message && (diagnostic.message || diagnostic.details?.length || code)
                ? [{ index: result.index, message }] : [];
        });
        return returned.length ? returned.map(result =>
            `${Number.isSafeInteger(result.index) && result.index >= 0 ? `Returned entry ${result.index + 1}` : "Returned error"}: ${result.message}`).join("\n")
            : null;
    }
    function returnedErrorGroups(call) {
        const members = call?.apiResults ?? [], groups = new Map();
        const indexCounts = new Map();
        for (const result of members) indexCounts.set(result?.index, (indexCounts.get(result?.index) ?? 0) + 1);
        const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
        members.forEach((result, offset) => {
            if (!result || typeof result !== "object") return;
            const diagnostic = result.errorDiagnostic?.version === 1 ? result.errorDiagnostic : {};
            const code = diagnostic.code ?? result.errorCode;
            let text = diagnosticSummary({ ...diagnostic, code }, result.statusCode);
            if (!text || !(diagnostic.message || diagnostic.details?.length || code || result.statusCode >= 400)) return;
            if (!diagnostic.message && !diagnostic.details?.length && !code) text += "; error details not recorded";
            if (diagnostic.statusCode != null && result.statusCode != null && diagnostic.statusCode !== result.statusCode) {
                text += `; returned status ${result.statusCode}`;
            }
            if (diagnostic.code != null && result.errorCode != null && diagnostic.code !== result.errorCode) {
                text += `; returned code ${result.errorCode}`;
            }
            const indexed = Number.isSafeInteger(result.index) && result.index >= 0;
            const complete = diagnostic.status === "recorded"
                && ["completion-error", "result-error", "workiq-error-json", "mcp-result-text", "native-tool-error"].includes(diagnostic.source);
            const { index, ...facts } = result;
            // Compare full retained facts, including target/provenance, never their display excerpts.
            const key = complete && indexed && indexCounts.get(index) === 1 ? JSON.stringify(stable(facts)) : "entry:" + offset;
            const group = groups.get(key) ?? { text, indexes: [], offsets: [] };
            if (indexed) group.indexes.push(index);
            group.offsets.push(offset);
            groups.set(key, group);
        });
        return [...groups.values()].map(group => {
            const numbers = group.indexes.map(index => index + 1).sort((a, b) => a - b), ranges = [];
            for (let i = 0; i < numbers.length; i++) {
                const first = numbers[i];
                let last = first;
                while (numbers[i + 1] === last + 1) last = numbers[++i];
                ranges.push(first === last ? String(first) : first + "\u2013" + last);
            }
            return { ...group, label: numbers.length ? (numbers.length === 1 ? "Returned entry " : "Returned entries ") + ranges.join(", ") : "Returned error" };
        });
    }
    function callReasonItems(call, outcome, { includeReturned = true } = {}) {
        const reason = outcome === "failure" ? failureReason(call, { contextual: true, includeReturned: false })
            : completionReason(call, outcome, true, false);
        const items = reason ? reason.split("\n").map(text => ({ label: null, text })) : [];
        if (includeReturned) items.push(...returnedErrorGroups(call));
        return items;
    }
    function returnedCoverage(call) {
        const result = call?.resultEvidence, retained = call?.apiResults?.length ?? 0;
        if (result?.version !== 1) return null;
        if (result.contentStatus === "partial") return { state: "partial", retained, supplied: null,
            text: `WIRE saved part of the response: ${retained} returned ${retained === 1 ? "entry" : "entries"}. The full total is unknown.` };
        if (Number.isSafeInteger(result.resultCount) && result.resultCount > retained) return {
            state: "bounded", retained, supplied: result.resultCount,
            text: `WIRE saved ${retained} of the ${result.resultCount} returned entries.`,
        };
        return null;
    }
    function callLabel(ordinal) {
        if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new TypeError("Call labels require a retained positive ordinal.");
        return "Call #" + ordinal;
    }
    function callGroupLabel(ordinals) {
        if (!Array.isArray(ordinals) || !ordinals.length) throw new TypeError("Call groups require retained ordinals.");
        for (const ordinal of ordinals) callLabel(ordinal);
        const numbers = [...new Set(ordinals)].sort((a, b) => a - b), ranges = [];
        for (let i = 0; i < numbers.length; i++) {
            const first = numbers[i];
            let last = first;
            while (numbers[i + 1] === last + 1) last = numbers[++i];
            ranges.push("#" + first + (last === first ? "" : "\u2013" + last));
        }
        return numbers.length === 1 ? callLabel(numbers[0]) : "Calls " + ranges.join(", ");
    }
    function genericMessage(value) {
        return typeof value?.message === "string" && value.message.trim().toLowerCase() === "failure" && !value.details?.length;
    }
    function diagnosticDetails(value, { codeShown = false, statusShown = false } = {}) {
        if (value?.version !== 1) return [];
        const rows = [];
        if (!codeShown && value.code != null && value.code !== "failure") rows.push(["Recorded error code", String(value.code)]);
        if (!statusShown && value.statusCode != null) rows.push(["Tool-reported status", String(value.statusCode)]);
        if (value.message) rows.push(["Recorded error", value.message]);
        for (const detail of value.details ?? []) {
            if (detail.code != null) rows.push(["Error detail code", String(detail.code)]);
            if (detail.statusCode != null) rows.push(["Tool-reported status", String(detail.statusCode)]);
            if (detail.message) rows.push(["Error detail", detail.message]);
        }
        const note = {
            redacted: "Identifying information was redacted.",
            "sensitive-excluded": "Error text was excluded for privacy.",
            "size-excluded": "Some error details exceeded the saving limit.",
            "unsupported-format": "Some error details were not in a supported format.",
            "not-supplied": "The source did not supply error details.",
        }[value.status];
        if (note) rows.push(["Error details", note]);
        if (genericMessage(value)) rows.push(["Error details", "The source supplied a generic failure message; no detailed cause was given."]);
        if (!rows.length && value.code === "failure") rows.push(["Error details", "The source supplied only a generic failure marker."]);
        return rows;
    }
    function resultDetails(value, { retainedResultCount, omitContent = false } = {}) {
        if (value?.version !== 1) return [];
        const rows = [];
        if (typeof value.applicationError === "boolean") rows.push(["Application result", value.applicationError
            ? "The tool returned an application error." : "The source marked the application result as non-error."]);
        if (Number.isInteger(value.statusCode)) rows.push(["Tool-reported status", String(value.statusCode)]);
        if (value.statusConflict) rows.push(["Conflicting reported statuses",
            `Structured result: ${value.statusConflict.structured}; text result: ${value.statusConflict.text}. Neither replaces the other.`]);
        if (Number.isSafeInteger(value.resultCount)) rows.push(["Returned result entries", Number.isSafeInteger(retainedResultCount) && retainedResultCount < value.resultCount
            ? `${value.resultCount} supplied; ${retainedResultCount} retained` : String(value.resultCount)]);
        const content = {
            "not-supplied": "The source did not supply result content.",
            "explicit-null": "The source returned no body.",
            "recorded-empty": "The source returned empty content.",
            "body-excluded": "Response bodies are excluded from activity retention.",
            "unsupported-format": "Result content was not in a supported format.",
            "size-excluded": "Result content exceeded the inspection limit.",
            partial: "Only complete returned entries before an unreadable part were retained. The total entry count is unknown.",
        }[value.contentStatus];
        const combinedAbsence = !omitContent && value.contentStatus === "not-supplied" && value.description?.status === "not-supplied";
        if (combinedAbsence) rows.push(["Result details", "The source did not supply result content or a description."]);
        else if (content && !omitContent) rows.push(["Result content", content]);
        const description = value.description;
        if (description?.version === 1) {
            if (description.text) rows.push(["Source description", description.text]);
            const note = {
                "not-supplied": "The source did not supply a description.", "explicit-null": "The source supplied a null description.",
                "recorded-empty": "The source description was empty.", redacted: "Identifying information was redacted from the description.",
                "sensitive-excluded": "Source description excluded for privacy.", "size-excluded": "Source description exceeded the saving limit.",
                "unsupported-format": "Source description was not in a supported format.",
            }[description.status];
            if (note && !combinedAbsence) rows.push(["Source description", note]);
        }
        return [...rows, ...diagnosticDetails(value.diagnostic)];
    }
    function completionReason(call, outcome, contextual = false, includeReturned = true) {
        const value = call?.resultEvidence;
        const completion = { success: "Tool completed", unknown: "Completion not recorded",
            partial: "Tool partly completed", other: "Tool reported another result", transport: "Tool connection failed" }[outcome];
        const describe = text => contextual ? text : completion + "; " + text;
        const problems = [];
        if (value?.version === 1) {
            const diagnostic = value.diagnostic?.version === 1 && diagnosticSummary(value.diagnostic)
                ? diagnosticSummary(value.diagnostic, value.statusCode) : "";
            if (value.applicationError === true) problems.push(contextual
                ? (diagnostic ? diagnostic + "\n" : "") + "The result reports an application error."
                : "the result reports an application error" + (diagnostic ? ": " + diagnostic : ""));
            else if (diagnostic) problems.push((contextual ? "" : "recorded error: ") + diagnostic);
            else if (genericMessage(value.diagnostic)) problems.push((contextual ? "The" : "the") + " source supplied only a generic failure message");
            if (value.statusConflict) problems.push(`${contextual ? "Reported" : "reported"} statuses disagree (${value.statusConflict.structured} and ${value.statusConflict.text})`);
        }
        const members = call?.apiResults ?? [], failed = members.filter(row => row.statusCode >= 400 || row.errorCode).length;
        const returned = includeReturned ? returnedErrorSummary(call) : null;
        if (includeReturned && failed && (!contextual || !returned)) problems.push(`${failed} of ${members.length} retained returned entries ${failed === 1 ? "reports" : "report"} an error`);
        if (returned) problems.push(returned);
        if (problems.length) return describe(problems.join("\n"));
        if (value?.version !== 1) return null;
        if (Number.isInteger(value.statusCode)) return describe((contextual ? "Reported" : "reported") + " status " + value.statusCode);
        if (!includeReturned && members.length) return null;
        if (Number.isSafeInteger(value.resultCount)) return describe(`${value.resultCount} returned result ${value.resultCount === 1 ? "entry" : "entries"}`
            + (value.resultCount > members.length ? ` (${members.length} retained)` : ""));
        if (contextual && value.contentStatus === "body-excluded") return null;
        const content = ({
            "not-supplied": "result content was not supplied", "explicit-null": "no response body",
            "recorded-empty": "empty result content", "body-excluded": "response body excluded from retention",
            "unsupported-format": "result content format unsupported", "size-excluded": "result content exceeded the inspection limit",
        }[value.contentStatus] ?? "result details unavailable");
        return describe(contextual ? content[0].toUpperCase() + content.slice(1) : content);
    }
    function explainedEntries(layer, rows, callFor, { concise = false, contextual = false, includeReturned = true } = {}) {
        const summary = summarize(rows), ordinary = entries(layer, summary);
        if (!ordinary || layer !== "tool") return ordinary;
        const failures = new Map();
        for (const row of new Map(rows.map(row => [row.id, row])).values()) {
            if (row.outcome !== "failure") continue;
            const call = callFor(row), reason = failureReason(call, { contextual, includeReturned });
            const previous = failures.get(reason);
            failures.set(reason, { count: (previous?.count ?? 0) + 1, reasonOnly: Boolean(failureCause(call)) });
        }
        return ordinary.flatMap(entry => screen && entry.key !== "failure" ? (() => {
            const groups = new Map();
            for (const row of new Map(rows.filter(row => row.outcome === entry.key).map(row => [row.id, row])).values()) {
                const call = callFor(row), reason = completionReason(call, row.outcome, contextual, includeReturned);
                const reportedProblem = call?.resultEvidence?.version === 1 && (call.resultEvidence.statusConflict
                    || call.resultEvidence.statusCode >= 400 || diagnosticSummary(call.resultEvidence.diagnostic ?? {}))
                    || call?.apiResults?.some(result => result.statusCode >= 400 || result.errorCode
                        || result.errorDiagnostic?.version === 1 && diagnosticSummary(result.errorDiagnostic));
                const tone = call?.resultEvidence?.applicationError === true ? "failure" : reportedProblem ? "partial" : entry.key;
                const key = JSON.stringify([reason, tone]), previous = groups.get(key);
                groups.set(key, { ...entry, count: (previous?.count ?? 0) + 1, reason, tone,
                    icon: icon(tone), ...(concise && reason ? { reasonOnly: true } : {}) });
            }
            return [...groups.values()];
        })() : entry.key === "failure"
            ? [...failures].map(([reason, detail]) => ({ ...entry, count: detail.count, reason,
                ...concise ? { reasonOnly: detail.reasonOnly } : {} })) : [entry]);
    }
    function activitySummary(layer, rows, callFor, { contextual = false } = {}) {
        const summary = summarize(rows), values = explainedEntries(layer, rows, callFor, { contextual });
        if (!values) return null;
        const scoped = layer === "tool" ? [...new Map(rows.map(row => [row.id, row])).values()].flatMap(row =>
            explainedEntries(layer, [row], callFor, { contextual }).filter(entry => entry.reason).map(entry => {
                const items = contextual ? callReasonItems(callFor(row), row.outcome) : null;
                return {
                    reason: items ? items.map(item => (item.label ? item.label + ": " : "") + item.text).join("\n") : entry.reason,
                    ...(items ? { items, coverage: returnedCoverage(callFor(row)) } : {}), count: 1, rowId: row.id, outcome: row.outcome, tone: entry.tone ?? entry.key,
                };
            })) : [];
        const problems = scoped.filter(entry => ["failure", "partial", "transport"].includes(entry.tone));
        const detailed = problems.length ? problems : contextual && scoped.some(entry => entry.coverage) ? scoped : null;
        const reasons = detailed ?? values.filter(entry => entry.reason)
            .map(({ reason, count, key, tone }) => ({ reason, count, outcome: key, tone: tone ?? key,
                ...(contextual ? { items: [{ label: null, text: reason }] } : {}) }));
        const outcome = ["failure", "transport", "partial", "unknown", "other", "success"]
            .find(key => values.some(entry => (entry.tone ?? entry.key) === key)) ?? null;
        return { summary, entries: values, outcome, reasons, moreReasons: 0 };
    }
    function unit(layer, count, accepted = scope()) {
        if (accepted?.layer === layer) {
            if (layer === "tool" && count === 0 && accepted.measurementEligibility?.nativeActivityDates === "unqualified") return "recorded tool calls";
            if (accepted.unit === "source-qualified tool calls") return count === 1 ? "recorded tool call" : "recorded tool calls";
            if (accepted.unit === "source-qualified returned-result observations") return count === 1 ? "recorded returned result" : "recorded returned results";
        }
        return units[layer]?.[count === 1 ? 0 : 1] || "records";
    }
    function populationLabel(unit) {
        const labels = {
            "native-tool-call": "Microsoft native tool calls", "workiq-tool-call": "Work IQ tool calls",
            "native-returned-result-observation": "Microsoft returned-result observations",
            "workiq-returned-result-entry": "Work IQ returned-result entries",
        };
        if (!Object.hasOwn(labels, unit)) throw new TypeError("Source-qualified outcome unit is unavailable.");
        return labels[unit];
    }
    function columnUnit(layer, count) {
        const name = unit(layer, count);
        return layer === "tool" ? name.replace(/^(Work IQ|recorded) tool /, "") : name;
    }
    function canInspect(layer, outcome) {
        return Object.hasOwn(units, layer) && layer !== "code-reference" && ["success", "failure", "transport"].includes(outcome);
    }
    function countLabel(layer, matching, total) {
        if (!Number.isSafeInteger(matching) || matching < 0) return "Result counts unavailable";
        if (total === undefined) return `${matching.toLocaleString()} ${unit(layer, matching)}`;
        if (!Number.isSafeInteger(total) || total < matching) return `${matching.toLocaleString()} matching ${unit(layer, matching)}; full-request count unavailable`;
        return `${matching.toLocaleString()} of ${total.toLocaleString()} ${unit(layer, total)} ${matching === 1 ? "matches" : "match"} this view`;
    }
    function heading(layer) {
        return { tool: "Tool completion", "reported-api": "API metadata from tool",
            "direct-request": "Recorded Graph requests", http: "Directly recorded HTTP",
            "code-reference": "Code references", "recorded-http": "Visible Graph status" }[layer];
    }
    function outcomeTitle(layer, model) {
        if (!Object.hasOwn(units, layer)) throw new TypeError("Result chart titles require a supported evidence layer.");
        const title = { tool: "Tool call results", "reported-api": "Returned result statuses",
            "direct-request": "Graph request-site status", "recorded-http": "Visible Graph statuses",
            http: "HTTP record results", "code-reference": "Code references" }[layer];
        return model?.separateUnits ? "Results by source" : title;
    }
    function pathText(value) {
        const text = typeof value === "string" ? value : value?.path;
        return typeof text === "string" && text.length ? text : null;
    }
    function callPaths(call) {
        const args = call?.requestArgs ?? {};
        const targets = Array.isArray(args.entityUrls) && args.entityUrls.length ? args.entityUrls
            : [call?.requestedApiPath ?? args.functionUrl ?? args.actionUrl ?? args.entityUrl ?? args.parentUrl ?? args.path];
        return targets.map(pathText);
    }
    function returnedResult(call, row) {
        // Canonical result identities use the offset after metadata-only filtering,
        // not the optional (and potentially repeated) source result index.
        const metadata = (call?.apiResults ?? []).filter(value => value && typeof value === "object"
            && (Number.isSafeInteger(value.index) || Object.hasOwn(value, "statusCode") || Object.hasOwn(value, "status") || Object.hasOwn(value, "errorCode")));
        return metadata.find((_, offset) => row.id === `result:${JSON.stringify([row.parentCallId, offset])}`);
    }
    function returnedPath(call, row, { discovery = false } = {}) {
        const result = returnedResult(call, row);
        const explicit = result?.requestedApiPath ?? result?.path;
        if (explicit != null) return { path: pathText(explicit), source: "returned" };
        if (discovery) return { path: null, source: "missing" };
        const paths = callPaths(call);
        return paths.length === 1 && paths[0] !== null
            ? { path: paths[0], source: "call" }
            : { path: null, source: paths.length > 1 ? "unattributed" : "missing" };
    }
    function inheritsCallService(call, row, parent) {
        const callService = parent?.serviceAssociation, resultService = row?.serviceAssociation;
        // Equal names do not make an independently returned target redundant.
        return typeof parent?.id === "string" && row?.parentCallId === parent.id
            && Boolean(returnedResult(call, row)) && returnedPath(call, row).source === "call"
            && callService?.layer === "tool" && resultService?.layer === "reported-api"
            && [callService, resultService].every(value => value.status === "identified"
                && value.basis === "recorded-target" && value.services.length === 1 && value.gaps.length === 0)
            && callService.services[0] === resultService.services[0]
            && typeof parent.endpoint?.path === "string" && row.endpoint?.id === parent.endpoint.id;
    }
    return { labels, icon, selection, filterValue, summarize, valid, entries, failureReason, diagnosticDetails, resultDetails, explainedEntries, activitySummary, callLabel, callGroupLabel, callReasonItems, returnedErrorGroups, returnedCoverage, unit, populationLabel, columnUnit, canInspect, countLabel, heading, outcomeTitle, pathText, callPaths, returnedResult, returnedPath, inheritsCallService, layers: Object.keys(units) };
}
