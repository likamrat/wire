export const textAccessStyles = `
.facts dt {min-width:0;overflow-wrap:anywhere}
.full-text {min-width:0;max-width:100%}
.full-text>.full-text-preview {max-width:68ch;margin:4px 0 0;color:var(--ink);font-size:var(--type-body);line-height:1.6;overflow-wrap:anywhere;white-space:normal;overflow:visible;text-overflow:clip}
.full-text-preview-label {display:block;color:var(--muted);font-size:var(--type-caption)}
.full-text-provenance {min-width:0}
.full-text-provenance .full-text-preview-label {min-width:0;overflow-wrap:anywhere}
.full-text-preview-state {margin:4px 0 0;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-caption);overflow-wrap:anywhere}
.full-text-actions {display:flex;flex-wrap:wrap;align-items:center;gap:0 var(--space-sm);margin-top:4px;min-width:0}
.full-text-actions .request-link {display:inline-flex;align-items:center;min-height:44px;max-width:100%;padding:8px var(--pill-inset);font-size:var(--type-control);line-height:var(--leading-control);color:var(--accent)}
.full-text-actions .full-text-toggle {margin-top:0}
.full-text-toggle {min-height:44px;color:var(--accent);white-space:normal;overflow-wrap:anywhere;margin-top:4px}
.full-text-availability {font-size:var(--type-small);color:var(--muted);margin:8px 0;line-height:1.6}
.full-text-body {min-width:0;max-width:100%}
.request-row .request-link,.report-entry .request-link,.context-return .request-link {white-space:normal;overflow:visible;text-overflow:clip}
.full-text-body .ux-code-block>pre {max-height:none;overflow:visible;scrollbar-gutter:auto}
.full-text-body .ux-code-block {overflow:visible}
.request-original {margin:0 0 16px;min-width:0}
.full-text-header {display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.full-text-header :is(h2,h3) {margin:0;min-width:0;overflow-wrap:anywhere}
.full-text-header h3 {font-size:var(--type-body);color:var(--muted)}
.full-text-reader-actions {display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px 8px;margin-inline-start:auto;min-width:0;max-width:100%}
.full-text-reader-actions:has(.ux-copy-status.error) {flex-basis:100%}
.full-text-header .full-text-toggle {margin:0;font-size:var(--type-body)}
.full-text-header .ux-copy {width:44px;height:44px;min-width:44px;min-height:44px}
.full-text-privacy {margin:4px 0 12px;color:var(--muted);font-size:var(--type-caption);line-height:var(--leading-ui);overflow-wrap:anywhere}
.full-text-content {margin:0;padding:0;max-width:72ch;font-family:var(--font);font-size:var(--type-reading);line-height:var(--leading-reading);white-space:pre-wrap;overflow-wrap:anywhere;word-break:normal;max-height:none;overflow:visible;background:none;border:0;border-radius:0}
.full-text-content:focus-visible {outline:2px solid var(--focus);outline-offset:3px}
.full-text-complete>.full-text-body {margin-top:16px}
.reader-state {font-size:var(--type-caption);line-height:var(--leading-caption);color:var(--muted)}
.reader-state-partial {color:var(--warning);font-weight:var(--weight-medium)}
.reader-copy-scope {flex-basis:100%;font-size:var(--type-caption);line-height:var(--leading-caption);color:var(--muted);text-align:end;overflow-wrap:anywhere}
.reader-details {margin-top:12px;border-top:1px solid var(--rule)}
.reader-details>summary {min-height:44px;font-size:var(--type-caption);line-height:var(--leading-ui);color:var(--muted)}
.reader-details>p {font-size:var(--type-small);line-height:var(--leading-reading);margin:4px 0 12px}
.reader-empty,.full-text-unavailable {margin:12px 0;color:var(--muted);font-size:var(--type-body);line-height:var(--leading-reading)}
.full-text-reader-actions .ux-copy-labeled,.full-text-reader-actions .ux-copy-labeled:is(:hover,:active) {
 position:relative;isolation:isolate;width:auto;height:auto;min-height:max(44px,calc(1lh + 24px));
 padding:12px var(--pill-inset);gap:8px;border:0;background:transparent;border-radius:var(--radius-control);
 font-size:var(--type-control);line-height:var(--leading-control);white-space:normal;
}
.full-text-reader-actions .ux-copy-labeled::before {content:"";position:absolute;inset:4px 0;z-index:-1;pointer-events:none;border:1px solid var(--pill-border);border-radius:inherit;background:var(--pill-fill)}
.full-text-reader-actions .ux-copy-labeled:hover::before {background:var(--pill-hover)}
.full-text-reader-actions .ux-copy-labeled:active::before {background:var(--pill-pressed)}
.full-text-reader-actions .ux-copy-labeled[data-copy-state=error]::before {border-color:var(--danger)}
.full-text-reader-actions .ux-copy-status.pending {color:var(--muted)!important}
.full-text-reader-actions .ux-copy-status:not(.error) {text-align:end}
.request-original,.interaction-response {padding:20px;border:1px solid var(--rule);border-radius:var(--radius-small);background:var(--paper)}
.interaction-response {margin-bottom:24px}
.interaction-response .error {color:var(--danger)}
.interaction-response>.reader-details {margin-top:8px}
.interaction-response .full-text-complete {margin-top:16px}
.interaction-insights {margin-block:24px}
.request-recorded {margin-top:24px;padding-top:24px;border-top:1px solid var(--rule)}
.request-recorded>.request-actions-heading {margin-bottom:12px}
.request-outcome {padding:12px 16px;background:var(--paper);border-inline-start:3px solid var(--control);border-radius:var(--radius-small);overflow-wrap:anywhere}
.request-outcome .full-request-results {border:0;margin:0;padding:0}
.request-outcome h2 {margin:0}
.request-outcome p {margin:8px 0 0}
.request-outcome .action-error,.journey-item .action-error {color:var(--danger);white-space:pre-wrap;overflow-wrap:anywhere}
.request-outcome-action {font-weight:var(--weight-medium)}
.request-matching {margin-top:12px;border-top:1px solid var(--rule);padding-top:4px}
.request-intro {padding:0;margin-bottom:20px;background:none;border:0;border-radius:0}
.request-intro p,.request-intro>.project-context {margin:0 0 4px;overflow-wrap:anywhere}
.request-source {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin-bottom:6px}
.request-source-label {font-size:var(--type-caption);color:var(--muted)}
.request-source strong {font-size:var(--type-reading);font-weight:var(--weight-strong);overflow-wrap:anywhere}
.request-context-meta {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px}
.request-context-meta .project-context,.request-context-meta .request-time {font-size:var(--type-caption);line-height:var(--leading-caption);color:var(--muted);margin:0}
.request-actions {margin:20px 0;padding:16px 0;border-block-start:1px solid var(--rule);min-width:0}
.request-actions h2 {margin:0;font-size:var(--type-section)}
.request-actions p {margin:4px 0 0;overflow-wrap:anywhere}
.request-actions>div {flex:1 1 12rem;min-width:0}
#activitySelectionContext>#pageAction {display:inline-flex;margin-top:4px}
.request-actions-heading {margin:0}
.request-support {margin-top:20px}
.request-view-context>summary {min-height:44px;cursor:pointer}
.viewing-context:has(.request-view-context) {padding:0;margin:0 0 12px;border:0}
.request-view-context[open]>div {padding:8px 0 12px}
.action-heading {display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-xs) var(--space-lg);min-width:0;font-size:var(--type-body);line-height:var(--leading-ui)}
.action-heading h3 {margin:0;font:inherit;font-weight:var(--weight-strong)}
.action-heading h3,.action-heading span {overflow-wrap:anywhere;min-width:0;max-width:100%}
.action-service-heading {display:inline-flex;align-items:center;gap:var(--space-xs)}
.action-heading .service-cue {align-items:center;line-height:inherit}
.action-heading .service-cue>.fluent-icon {margin:0}
.journey-item {overflow-wrap:anywhere}
.journey-item .ux-inline-code {margin-block:4px}
.journey-pages>.list-pager:not(:has(button)) {min-height:0;margin:8px 0 12px}
.request-context-heading {margin-bottom:20px}
.request-context-heading>h2 {margin-bottom:8px}
.request-context-timeline {margin-block:16px}
.request-context-timeline>.journey-item {min-width:0;padding-block:8px 20px}
.request-context-timeline>.journey-item[aria-current=true] {border-inline-start-color:var(--accent)}
.request-context-timeline .context-entry-label {font-size:var(--type-caption);line-height:var(--leading-caption);margin:0 0 12px}
.request-context-timeline .context-selected-label {color:var(--accent);font-weight:var(--weight-strong)}
.request-context-timeline>.journey-item[data-selected-action=true] {border-inline-start-color:var(--accent)}
#selectedCall,#unavailableCall {scroll-margin-block-start:160px;outline-offset:4px}
.selected-api-result {min-width:0;margin-block:16px}
.selected-api-result>.api-result-entry {border-inline-start:2px solid var(--accent);padding-inline-start:12px}
.request-context-timeline :is(.request-original,.request-context-prompt,.interaction-response) {padding:0;margin:0;border:0;border-radius:0;background:none;min-width:0}
.request-context-timeline .reader-state-partial {color:var(--warning)}
.request-context-summaries>.request-recorded {margin-top:16px;padding-top:16px}
.request-context-summaries .interaction-insights {margin-block:16px}
@media(max-width:600px) {
 .request-original,.interaction-response {padding:16px}
 .full-text-reader-actions {flex-basis:100%;margin-inline-start:0;justify-content:flex-start}
 .reader-copy-scope,.full-text-reader-actions .ux-copy-status:not(.error) {text-align:start}
 .request-support .facts,.journey-item>details .facts {grid-template-columns:minmax(0,1fr);gap:4px}
 .request-support .facts dd,.journey-item>details .facts dd {margin-bottom:12px}
}
`;
