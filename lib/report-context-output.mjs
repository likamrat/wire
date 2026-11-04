import { promptAuthorship } from "./prompt-authorship.mjs";
import { REPORT_CONTEXT_SEPARATION, validateReportContext } from "./report-context-shape.mjs";

const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const relation = value => ({ preceding: "Earlier linked context", selected: "Selected interaction", following: "Following linked context" })[value];
const caption = (entry, snapshot) => entry.activityState === "automatic"
    ? snapshot?.presentation?.schemaVersion === 3 ? promptAuthorship.display(entry, { ownerVoice: false }).label : "Automatic continuation"
    : entry.kind === "response" ? "Recorded reply (finality unverified)"
    : `${entry.kind === "follow-up" ? "Recorded follow-up / " : ""}${snapshot?.presentation?.schemaVersion === 3
        ? promptAuthorship.display(entry, { ownerVoice: false }).label : promptAuthorship.label(entry, { ownerVoice: false })}`;
const coverage = value => `${value.entries} context entries: ${value.included} included, ${value.omitted} omitted, ${value.unavailable} unavailable, ${value.partial} partial.${value.noNewMessage ? ` ${value.noNewMessage} automatic continuations without a new message.` : ""} ${value.authorExcludedGroups} linked-group exclusions by author choice (per selected anchor). Source text ${value.sourceBytes} bytes; projected text ${value.projectedBytes} bytes.`;
const gap = (entry, snapshot) => entry.omitted ? "Omitted from this report."
    : entry.activityState === "automatic" && snapshot?.presentation?.schemaVersion === 3 ? promptAuthorship.display(entry).notice
        : entry.activityState && entry.availabilityNote ? entry.availabilityNote : "Retained text unavailable; not reconstructed.";
const sourceState = entry => entry.activityState === "automatic" ? "Automatic activity; no original message"
    : `${entry.status} source / ${entry.representation}`;

export function reportContextHtml(snapshot) {
    const context = snapshot?.recordedContext;
    if (!context) return "";
    validateReportContext(context, snapshot.records, snapshot.promptMode);
    const entries = new Map(context.entries.map(entry => [entry.key, entry]));
    return `<section id="recorded-context"><h2>Recorded context</h2><p>${escape(REPORT_CONTEXT_SEPARATION)}</p><p>${escape(context.boundary)}</p><p>${escape(context.limitation)}</p><p>${escape(coverage(context.coverage))}</p>${context.anchors.map((anchor, index) =>
        `<section><h3>Context for selected interaction ${index + 1}</h3><p><a href="#${anchor.scenarioRef}">Reviewed prompt copies for this interaction</a></p>${anchor.gaps.map(note => `<p>${escape(note)}</p>`).join("")}<ol>${anchor.entryKeys.map(key => {
            const entry = entries.get(key), group = anchor.groups.find(group => group.entryKeys.includes(key));
            return `<li class="prompt"><h4>${escape(caption(entry, snapshot))}</h4><p>${relation(group.relation)} / ${entry.timeStatus === "recorded" ? "Recorded chronology; source time withheld." : "Time not recorded; chronological position unknown."}</p><p>${sourceState(entry)}</p>${entry.text === null ? `<p>${escape(gap(entry, snapshot))}</p>` : `<pre>${escape(entry.text)}</pre>`}${entry.text !== null && entry.activityState && entry.availabilityNote ? `<p>${escape(entry.availabilityNote)}</p>` : ""}${entry.status === "partial" ? "<p>Only part of the recorded text is available; missing content is not reconstructed.</p>" : ""}${entry.changes.some(change => change.mandatory) ? "<p>Mandatory credential removal; this is not a byte-identical original.</p>" : ""}<details class="context-reference"><summary>Recorded source references</summary><p class="ref">Selected request: ${anchor.scenarioRef}. Original group: ${entry.scenarioRef}.</p></details></li>`;
        }).join("")}</ol></section>`).join("")}</section>`;
}

export function reportContextMarkdown(snapshot) {
    const context = snapshot?.recordedContext;
    if (!context) return [];
    validateReportContext(context, snapshot.records, snapshot.promptMode);
    const entries = new Map(context.entries.map(entry => [entry.key, entry]));
    const lines = ['<a id="recorded-context"></a>', "## Recorded context", "", REPORT_CONTEXT_SEPARATION, "", context.boundary, "", context.limitation, "", coverage(context.coverage), ""];
    for (const [index, anchor] of context.anchors.entries()) {
        lines.push(`### Context for selected interaction ${index + 1}`, "", `[Reviewed prompt copies for this interaction](#${anchor.scenarioRef})`, "",
            ...anchor.gaps.flatMap(note => [note, ""]));
        for (const key of anchor.entryKeys) {
            const entry = entries.get(key), group = anchor.groups.find(group => group.entryKeys.includes(key));
            lines.push(`**${caption(entry, snapshot)}**`, "", `${relation(group.relation)} / ${entry.timeStatus === "recorded" ? "Recorded chronology; source time withheld." : "Time not recorded; chronological position unknown."}`,
                `${sourceState(entry)}.`, "",
                ...(entry.text === null ? [gap(entry, snapshot)] : entry.text.split("\n").map(line => "    " + line)), "");
            if (entry.status === "partial") lines.push("Only part of the recorded text is available; missing content is not reconstructed.", "");
            if (entry.text !== null && entry.activityState && entry.availabilityNote) lines.push(entry.availabilityNote, "");
            if (entry.changes.some(change => change.mandatory)) lines.push("Mandatory credential removal; this is not a byte-identical original.", "");
            lines.push(`Supporting references: selected request ${anchor.scenarioRef}. Original group: ${entry.scenarioRef}.`, "");
        }
    }
    return lines;
}
