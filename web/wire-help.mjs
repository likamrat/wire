const topics = [
    ["reports", "Prepare a report", `<p>A preview lets you check the included activity and text before you save any files.</p>
        <ol><li>In <strong>Reports</strong>, choose the activity and dates under <strong>New report</strong>. <strong>All retained dates</strong> includes every date WIRE has saved for that activity.</li>
        <li>Choose your file formats and whether to keep, mask or leave out chat details.</li>
        <li>Select <strong>Prepare preview</strong>. Review the result, then select <strong>Save report</strong> to keep it.</li></ol>
        <h3>Where does it go?</h3><p>Save writes the files on this device. Open <strong>Reports → Saved library</strong> to find them again.</p>`],
    ["history", "Find missing activity", `<ol><li>In <strong>Analyze → Filters</strong>, choose <strong>All dates</strong> and clear other restrictions. This shows more saved activity without reading more history.</li>
        <li>If you hid a card, open <strong>Hidden cards</strong> above the interaction list and choose <strong>Restore</strong> beside it.</li>
        <li>If the activity is still missing, check the approved source in <strong>Settings → Source access</strong> and the history window in <strong>Collection</strong>.</li></ol>
        <h3>Missing text in Search</h3><p>Search looks in saved activity and reports. It can’t find reply text that wasn’t retained.</p>`],
    ["counts", "Understand activity counts", `<p>One interaction can include several calls. Not every saved call identifies the prompt that started it.</p>
        <h3>Example</h3><p>If the records link three matching calls to the same originating prompt, Analyze counts <strong>1 interaction</strong> and <strong>3 matching tool calls</strong>. The totals include matches across all pages.</p>
        <h3>Reading a particular chart</h3><p>Use <strong>Guide</strong> in Analyze or Trends for the measure, its scope and a worked example.</p>`],
    ["results", "Read tool results", `<p>A completed call means the tool reported success. It does not establish that the whole task finished or that the answer was correct.</p>
        <h3>If a call failed</h3><p>Open the interaction and expand the affected call to read the recorded reason, if available. A call with no recorded result is not a failed call.</p>
        <h3>Which app did Copilot use?</h3><p>Look for <strong>Target</strong> on the call. A prompt can mention Calendar without Copilot using it. <strong>Asked Copilot</strong> tells you there was a request. It doesn’t tell you which apps Copilot used.</p>
        <h3>Who sent the prompt?</h3><p>A <strong>Human prompt</strong> came from a person. An <strong>Agent prompt</strong> came from an agent. <strong>Sender unclear</strong> means the saved record doesn't tell WIRE which one sent it. The card shows why.</p>`],
];

export const wireHelpMarkup = `<section id="wireHelpView" class="wire-help" aria-labelledby="pageTitle" hidden>
  <div class="wire-help-layout"><nav class="wire-help-topics" aria-label="Help topics"><h2>Help topics</h2>
    ${topics.map(([id, title]) => `<a href="/help?topic=${id}" data-help-topic="${id}">${title}</a>`).join("")}</nav>
    <div class="wire-help-reading">${topics.map(([id, title, content]) => `<article data-help-article="${id}" aria-labelledby="help-${id}" hidden><h2 id="help-${id}" tabindex="-1">${title}</h2>${content}</article>`).join("")}</div></div></section>`;

export const wireHelpStyles = `
.wire-help{max-width:64rem;padding:var(--space-xl);background:var(--paper);border-radius:var(--radius)}
.wire-help-layout{display:grid;grid-template-columns:minmax(11rem,15rem) minmax(0,1fr);gap:var(--space-2xl)}
.wire-help-topics{display:flex;flex-direction:column;align-self:start;gap:var(--space-xs);padding-inline-end:var(--space-lg);border-inline-end:1px solid var(--surface-divider)}
.wire-help-topics h2{margin:0;padding:0 10px var(--space-sm);font-size:var(--type-reading)}
.wire-help-topics a{display:flex;align-items:center;min-height:44px;padding:8px 10px;border-radius:8px;color:var(--muted);font-size:var(--type-control);line-height:var(--leading-control);text-decoration:none;transition:var(--control-paint-transition)}
.wire-help-topics a[aria-current=page]{background:var(--control-sheen),var(--accent-soft);box-shadow:var(--control-sheen-edge);color:var(--ink);font-weight:var(--weight-medium)}
.wire-help-topics a:hover{background:var(--hover);color:var(--ink);text-decoration:none}.wire-help-topics a:active{background:var(--pill-pressed)}
.wire-help-topics a:focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.wire-help-reading{min-width:0;max-width:64ch;font-size:var(--type-reading);line-height:var(--leading-reading)}
.wire-help-reading h2{font-size:var(--type-section);margin:0}.wire-help-reading h3{font-size:var(--type-reading);margin:var(--space-lg) 0 0}
.wire-help-reading p{margin:var(--space-sm) 0 0}.wire-help-reading ol{padding-inline-start:1.5em;margin:var(--space-lg) 0 0}.wire-help-reading li+li{margin-top:var(--space-sm)}
.wire-help[hidden]{display:none}
@media(max-width:52rem){.wire-help{padding:var(--space-lg)}.wire-help-layout{grid-template-columns:minmax(0,1fr);gap:var(--space-lg)}.wire-help-topics{border-inline-end:0;border-block-end:1px solid var(--surface-divider);padding:0 0 var(--space-md)}}
@media(forced-colors:active){.wire-help-topics a[aria-current=page]{outline:1px solid CanvasText}}`;
