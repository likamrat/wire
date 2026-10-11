import { promptAuthorship } from "./prompt-authorship.mjs";
import { REPORT_CONTEXT_SEPARATION, validateReportContext } from "./report-context-shape.mjs";

const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const relation = value => ({ preceding: "Earlier linked context", selected: "Selected interaction", following: "Following linked context" })[value];
const caption = entry => entry.kind === "response" ? "Recorded reply (finality unverified)"
    : `${entry.kind === "follow-up" ? "Recorded follow-up / " : ""}${promptAuthorship.label(entry, { ownerVoice: false })}`;
const coverage = value => `${value.entries} context entries: ${value.included} included, ${value.omitted} omitted, ${value.unavailable} unavailable, ${value.partial} partial. ${value.authorExcludedGroups} linked-group exclusions by author choice (per selected anchor). Source text ${value.sourceBytes} bytes; projected text ${value.projectedBytes} bytes.`;
const gap = entry => entry.omitted ? "Omitted from this report." : "Retained text unavailable; not reconstructed.";

export function reportContextHtml(snapshot) {
    const context = snapshot?.recordedContext;
    if (!context) return "";
    validateReportContext(context, snapshot.records, snapshot.promptMode);
    const entries = new Map(context.entries.map(entry => [entry.key, entry]));
    return `<section id="recorded-context"><h2>Recorded context</h2><p>${escape(REPORT_CONTEXT_SEPARATION)}</p><p>${escape(context.boundary)}</p><p>${escape(context.limitation)}</p><p>${escape(coverage(context.coverage))}</p>${context.anchors.map((anchor, index) =>
        `<section><h3>Context for selected interaction ${index + 1}</h3><p class="ref">Selected request: <a href="#${anchor.scenarioRef}">${anchor.scenarioRef}</a></p>${anchor.gaps.map(note => `<p>${escape(note)}</p>`).join("")}<ol>${anchor.entryKeys.map(key => {
            const entry = entries.get(key), group = anchor.groups.find(group => group.entryKeys.includes(key));
            return `<li class="prompt"><h4>${escape(caption(entry))}</h4><p>${relation(group.relation)} / ${entry.timeStatus === "recorded" ? "Recorded chronology; source time withheld." : "Time not recorded; chronological position unknown."}</p><p class="ref">Original group: ${entry.scenarioRef}</p><p>${entry.status} source / ${entry.representation}</p>${entry.text === null ? `<p>${gap(entry)}</p>` : `<pre>${escape(entry.text)}</pre>`}${entry.status === "partial" ? "<p>Only part of the recorded text is available; missing content is not reconstructed.</p>" : ""}${entry.changes.some(change => change.mandatory) ? "<p>Mandatory credential removal; this is not a byte-identical original.</p>" : ""}</li>`;
        }).join("")}</ol></section>`).join("")}</section>`;
}

export function reportContextMarkdown(snapshot) {
    const context = snapshot?.recordedContext;
    if (!context) return [];
    validateReportContext(context, snapshot.records, snapshot.promptMode);
    const entries = new Map(context.entries.map(entry => [entry.key, entry]));
    const lines = ['<a id="recorded-context"></a>', "## Recorded context", "", REPORT_CONTEXT_SEPARATION, "", context.boundary, "", context.limitation, "", coverage(context.coverage), ""];
    for (const [index, anchor] of context.anchors.entries()) {
        lines.push(`### Context for selected interaction ${index + 1}`, "", `Selected request: [${anchor.scenarioRef}](#${anchor.scenarioRef})`, "",
            ...anchor.gaps.flatMap(note => [note, ""]));
        for (const key of anchor.entryKeys) {
            const entry = entries.get(key), group = anchor.groups.find(group => group.entryKeys.includes(key));
            lines.push(`**${caption(entry)}**`, "", `${relation(group.relation)} / ${entry.timeStatus === "recorded" ? "Recorded chronology; source time withheld." : "Time not recorded; chronological position unknown."}`,
                `Original group: ${entry.scenarioRef}. ${entry.status} source / ${entry.representation}.`, "",
                ...(entry.text === null ? [gap(entry)] : entry.text.split("\n").map(line => "    " + line)), "");
            if (entry.status === "partial") lines.push("Only part of the recorded text is available; missing content is not reconstructed.", "");
            if (entry.changes.some(change => change.mandatory)) lines.push("Mandatory credential removal; this is not a byte-identical original.", "");
        }
    }
    return lines;
}
