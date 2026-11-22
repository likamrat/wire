import { reportPatternError } from "./report-patterns.mjs";

const numberOf = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const outcome = value => ({ succeeded: "Completed", failed: "Failed", unknown: "Completion unknown", partial: "Partially completed" })[value] ?? "Completion unknown";
const statusText = v => v.statusConflict
    ? (Object.hasOwn(v.statusConflict, "structured")
        ? `Structured ${v.statusConflict.structured}; text ${v.statusConflict.text} (conflict)`
        : `Reported ${v.statusConflict.reported}; diagnostic ${v.statusConflict.diagnostic} (conflict)`)
    : v.statusCode == null ? "Status not saved" : `HTTP ${v.statusCode}`;

// Reading of frozen facts, not a new measure. Keep observation and entry identity through quote selection.
export function reportFinding(snapshot) {
    const population = snapshot.reportPopulation, denominator = population.included.length;
    const results = new Map(snapshot.resultFacts.calls.map((c, i) => [c.ref, { call: c, number: i + 1 }]));
    const owners = new Map(snapshot.reportPatterns.calls.map(c => [c.ref, c.scenarioRef]));
    const patterns = new Map(snapshot.evaluationFacts.patterns.map(p => [p.pattern.key, p.pattern.display]));
    const errors = snapshot.reportPatterns.groups.filter(g => g.kind === "errors");
    const groups = errors.length || population.focus.outcome === "errors" ? errors : snapshot.reportPatterns.groups.filter(g => g.kind === "operation");
    const populationLine = population.focus.outcome === "errors" ? `${denominator} of ${population.reference.length} interactions had recorded errors.`
        : `${numberOf(denominator, "interaction")} included from ${numberOf(population.reference.length, "eligible interaction")}.`;
    const rows = groups.slice(0, 5).map(group => {
        const matches = group.callRefs.map(ref => results.get(ref));
        const display = patterns.get(group.patternKey), tool = display.tool || "Tool", completions = new Set(matches.map(x => x.call.completion));
        const completion = completions.size === 1 ? outcome(matches[0].call.completion) : "Mixed completion";
        const statuses = group.signals.filter(s => s.kind === "returned-api-error" && s.status != null);
        const singleton = group.signals.find(s => s.kind === "result-status");
        const conflicts = group.signals.some(s => s.kind.startsWith("conflicting-"));
        const noHttp = matches.every(({call}) => call.observations.length && call.observations.every(o => o.statusCode == null
            && o.statusConflict == null && !o.returnedEntries?.length && o.errorStatusCode == null));
        const errorLabel = reportPatternError(group);
        const label = group.kind === "operation" ? [tool, ...display.endpoints.map(e => e.pathTemplate)].join(" / ")
            : conflicts ? `${tool} · ${reportPatternError(group)}`
            : statuses.length ? `${tool} · ${completion.toLowerCase()} · returned HTTP ${[...new Set(statuses.map(s => s.status))].join(", ")}`
            : singleton ? `${tool} · result status ${singleton.status}` : /^(?:failure|call failed)$/i.test(errorLabel)
                ? `${tool} · ${completion.toLowerCase()}${noHttp ? "; no HTTP status saved" : ""}`
                : `${tool} · ${errorLabel}`;
        return { id: group.id, label, count: group.interactionRefs.length, completion, tool };
    });
    const lead = rows[0], group = groups[0];
    if (!lead) return { title: denominator ? "No qualified tool pattern was recorded" : "No interactions matched this report",
        populationLine, description: "", rows, denominator, groupCount: 0, example: null };
    const refs = new Set(group.callRefs), members = Array.from(refs, ref => results.get(ref)).sort((a,b) => a.number-b.number);
    const signal = group.signals.find(s => s.kind === "returned-api-error" && s.status != null);
    const conflicting = group.signals.some(s => s.kind.startsWith("conflicting-"));
    const resultSignal = group.signals.find(s => s.kind === "result-status");
    const {call, number} = members[0];
    const cause = group.signals.find(s => s.kind.startsWith("cause:"))?.kind.split(":");
    const specificObservation = call.observations.find(x => group.signals.some(s =>
        s.kind === "recorded-request-timeout" && x.timingFailure?.kind === "request-timeout"
        || s.kind === "application-error" && x.applicationError === true
        || s.kind === "recorded-error" && x.errorCodeStatus === "recorded" && x.errorCode === s.code
        || cause && x.interpretation?.items.some(i => i.channel === cause[1] && i.kind === cause[2])));
    const o = signal && !conflicting ? call.observations.find(x => x.returnedEntries?.some(e => !e.statusConflict && e.statusCode === signal.status && (!signal.code || e.errorCode === signal.code)))
        : conflicting ? call.observations.find(x => x.statusConflict || x.returnedEntries?.some(e => e.statusConflict))
        : resultSignal ? call.observations.find(x => x.statusCode === resultSignal.status)
        : specificObservation ?? (call.observations.length === 1 ? call.observations[0] : null);
    const entry = signal && !conflicting ? o?.returnedEntries?.find(e => !e.statusConflict && e.statusCode === signal.status && (!signal.code || e.errorCode === signal.code)) : null;
    const entryIndex = entry?.index ?? null;
    const ambiguousChannel = group.signals.some(s => s.kind.includes("returned") || s.kind.startsWith("cause:returned-entry")) && !entry;
    const copy = group.kind === "errors" && !conflicting && !ambiguousChannel && o && snapshot.resultText?.copies.find(c => c.kind === "error-message" && c.memberRefs.includes(call.ref)
        && c.observationRef === o.ref && c.entryIndex === entryIndex && !c.omitted && c.text !== null);
    const fields = [["Tool call", outcome(call.completion)]];
    if (o) {
        fields.push(["Tool-reported status",statusText(o)]);
        const shown = (o.returnedEntries ?? []).slice(0, 2);
        if (entry && !shown.includes(entry)) shown.push(entry);
        for (const e of shown) fields.push([`Returned entry ${e.index + 1}`, statusText(e)]);
        if (!shown.length) fields.push(["Returned entries",o.resultCount == null ? "None saved; supplied total unknown" : `${o.retainedResultCount ?? "Unknown count"} saved of ${o.resultCount} supplied`]);
        if ((o.returnedEntries?.length ?? 0) > shown.length) fields.push(["Additional saved entries",String(o.returnedEntries.length - shown.length)]);
    }
    const observationNumber = o ? call.observations.indexOf(o) + 1 : null;
    const interpretation = !conflicting && !ambiguousChannel && o?.interpretation?.items.find(i => i.entryIndex === entryIndex
        && i.channel === (entryIndex !== null ? "returned-entry" : resultSignal ? "result" : "call"));
    const headline = signal && !conflicting && lead.completion === "Completed"
        ? signal.status === 403 ? `${lead.tool} completed, but a returned entry was denied`
            : `${lead.tool} completed with a returned HTTP ${signal.status}`
        : lead.label;
    return { title: headline, populationLine, description:`This pattern appears in ${lead.count} of ${numberOf(denominator, "included interaction")} (${numberOf(refs.size, "call")}).`,
        rows, groupCount: groups.length, denominator, example: { callRef:call.ref, owner:owners.get(call.ref), observationRef:o?.ref ?? null,
            title:`Report call ${number}: ${call.tool}`, observationNumber, entryIndex, fields,
            quote:copy ? {text:copy.text, label:`Recorded at the time · ${entryIndex === null ? "call or result" : `returned entry ${entryIndex+1}`} · ${copy.representation === "edited-copy" ? "edited" : "masked"} report copy${copy.status === "partial" ? " · partial" : ""}`} : null,
            interpretation:interpretation?.text ?? null } };
}
