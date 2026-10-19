export const deletionStyles = `
:is(#deleteDialog,.deletion-dialog) {width:min(42rem,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:clamp(16px,3vw,28px);border-radius:var(--radius-dialog);overflow:auto;color:var(--ink);background:var(--paper);border:1px solid var(--rule)}
:is(#deleteDialog,.deletion-dialog)::backdrop {background:var(--scrim)}
:is(#deleteDialog,.deletion-dialog) h2 {font-size:var(--type-dialog,1.375rem);line-height:var(--leading-dialog,1.35)}
:is(#deleteDialog,.deletion-dialog) .delete-heading {display:flex;align-items:flex-start;gap:12px}
:is(#deleteWarningIcon,.delete-warning-icon) {color:var(--danger);flex:none;margin-top:4px}
:is(#deleteDialog,.deletion-dialog) p,:is(#deleteDialog,.deletion-dialog) form,#deleteConfirmation {margin-top:16px}
:is(#deleteDialog,.deletion-dialog) fieldset {border:0;padding:0;margin:20px 0;min-width:0}
:is(#deleteDialog,.deletion-dialog) legend {font-weight:600;margin-bottom:8px}
:is(#deleteDialog,.deletion-dialog) .delete-choice {display:flex;gap:12px;align-items:center;min-height:44px;padding:8px 0}
:is(#deleteDialog,.deletion-dialog) input[type=radio] {appearance:auto;min-height:0;width:20px;height:20px;flex:none;accent-color:var(--accent)}
#deleteDateFields {display:flex;flex-wrap:wrap;gap:12px;margin:12px 0}
#deleteDateFields label {display:grid;gap:6px;flex:1 1 12rem;min-width:0}
:is(#deleteDialog,.deletion-dialog) input[type=date] {width:100%;min-height:44px}
:is(#deleteDialog,.deletion-dialog) button {display:inline-flex;align-items:center;justify-content:center;text-align:center;min-height:44px;white-space:normal}
#deletePreview {margin-top:16px}
#deleteConfirmation {border-left:4px solid var(--danger);padding:4px 0 4px 16px}
#deleteSummary {font-weight:600}
:is(#deleteDialog,.deletion-dialog) .delete-actions {display:flex;flex-wrap:wrap;gap:12px;margin-top:24px;justify-content:flex-end}
:is(#deleteDialog,.deletion-dialog) .delete-irreversible {color:var(--danger);font-weight:600}
#deleteStatus:empty {display:none}
#deleteDialog {border-radius:12px;border-color:var(--rule);padding:24px}
#deleteDialog .delete-heading {align-items:baseline}
#deleteDialog #deleteWarningIcon {align-self:center;margin:0}
#deleteDialog #deleteBoundary {color:var(--muted);margin-bottom:24px;max-width:62ch}
#deleteDialog #deleteScopeForm {padding-top:20px;border-top:1px solid var(--rule)}
#deleteDialog fieldset {margin:0 0 16px}
#deleteDialog input[type=date] {border-radius:10px;min-width:0}
#deleteDialog #deleteConfirmation {border-left:0;padding:20px 0 0;border-top:1px solid var(--danger)}
#deleteDialog .delete-actions {justify-content:flex-start;padding-top:16px;border-top:1px solid var(--rule);gap:8px}
#deleteDialog .reading-section {padding:0}
@media(max-width:480px) {#deleteDialog {padding:20px 16px}}
:is(#deleteDialog,.deletion-dialog).decision-frame {padding:0;overflow:hidden}
:is(#deleteDialog,.deletion-dialog).decision-frame[open] {display:grid;grid-template-rows:auto minmax(0,1fr) auto}
:is(#deleteDialog,.deletion-dialog).decision-frame>.delete-heading {margin:0;padding:20px 24px;align-items:flex-start;border-bottom:1px solid var(--rule)}
.decision-frame .delete-heading h2 {margin:0;min-width:0;overflow-wrap:anywhere}
:is(#deleteDialog,.deletion-dialog).decision-frame :is(#deleteWarningIcon,.delete-warning-icon) {display:flex;align-items:center;align-self:start;height:1.35em;margin:0;color:var(--muted);font-size:var(--type-dialog,1.375rem)}
.decision-frame :is(#deleteWarningIcon,.delete-warning-icon) svg {width:1.25rem;height:1.25rem}
:is(#deleteDialog,.deletion-dialog).decision-frame>.decision-body {min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 24px;overflow-wrap:anywhere}
:is(#deleteDialog,.deletion-dialog).decision-frame .decision-body>p:first-child {margin-top:0}
.decision-frame .decision-scope {display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:8px 12px}
:is(#deleteDialog,.deletion-dialog).decision-frame .decision-scope>p {margin:0}
.decision-frame .decision-scope>button {margin:0}
#deleteDialog.decision-frame #deleteBoundary {margin:0 0 16px}
#deleteDialog.decision-frame #deleteScopeForm {margin:0;padding:0;border:0}
#deleteDialog.decision-frame #deleteConfirmation {margin:0;padding:0;border:0}
#deleteDialog.decision-frame #deleteSummary {font-size:var(--type-reading);line-height:var(--leading-reading)}
:is(#deleteDialog,.deletion-dialog).decision-frame>.delete-actions {margin:0;padding:12px 24px;gap:8px;border-top:1px solid var(--rule);background:var(--paper);justify-content:flex-end}
:is(#deleteDialog,.deletion-dialog).decision-frame button {--pill-inset:10px;--action-radius:8px;--pill-border:var(--control)}
:is(#deleteDialog,.deletion-dialog).decision-frame button.quiet {--pill-border:transparent}
:is(#deleteDialog,.deletion-dialog).decision-frame button::before {inset-block:6px}
:is(#deleteDialog,.deletion-dialog).decision-frame button:focus-visible {outline:none}
:is(#deleteDialog,.deletion-dialog).decision-frame button:focus-visible::before {outline:2px solid var(--focus);outline-offset:2px}
.decision-frame .decision-status:not(:empty) {margin-top:16px;padding:12px;border:1px solid var(--control);border-radius:8px;background:var(--canvas);color:var(--ink)}
.decision-frame .decision-status:empty {display:none}
:is(#deleteDialog,.deletion-dialog).decision-frame[data-decision-kind=destructive]:is([data-decision-phase=confirm],[data-decision-phase=unknown])>.delete-heading {background:color-mix(in srgb,var(--danger) 8%,var(--paper));border-bottom-color:var(--danger)}
:is(#deleteDialog,.deletion-dialog).decision-frame[data-decision-kind=destructive] :is(#deleteWarningIcon,.delete-warning-icon) {color:var(--danger)}
.decision-frame[data-decision-kind=destructive] .decision-status.error {border-color:var(--danger);color:var(--ink)}
:is(#deleteDialog,.deletion-dialog).decision-frame[data-decision-phase=complete] :is(#deleteWarningIcon,.delete-warning-icon) {color:var(--success)}
:is(#deleteDialog,.deletion-dialog).decision-frame:is([data-decision-phase=pending],[data-decision-phase=checking]) :is(#deleteWarningIcon,.delete-warning-icon) {color:var(--muted)}
:is(#deleteDialog,.deletion-dialog).decision-frame [data-decision-action]:enabled {--pill-fill:var(--accent-fill);--pill-ink:var(--on-accent);--pill-border:var(--accent-fill);--pill-hover-border:var(--accent-fill);--pill-hover:var(--primary-hover);--pill-pressed:var(--primary-pressed);color:var(--on-accent)}
:is(#deleteDialog,.deletion-dialog).decision-frame[data-decision-kind=destructive] [data-decision-action=commit]:enabled {--pill-fill:var(--delete-fill);--pill-ink:var(--delete-ink);--pill-border:var(--delete-fill);--pill-hover-border:var(--delete-fill);--pill-hover:color-mix(in srgb,var(--delete-fill) 88%,var(--ink));--pill-pressed:color-mix(in srgb,var(--delete-fill) 80%,var(--ink));color:var(--delete-ink)}
@media(max-width:480px) {
 :is(#deleteDialog,.deletion-dialog).decision-frame>.delete-heading,:is(#deleteDialog,.deletion-dialog).decision-frame>.decision-body {padding:16px}
 :is(#deleteDialog,.deletion-dialog).decision-frame>.delete-actions {padding:8px 16px}
 .decision-frame>.delete-actions>button {flex:1 1 auto}
 .decision-frame .decision-scope {grid-template-columns:minmax(0,1fr)}
 .decision-frame .decision-scope>button {justify-self:start}
}
@media(forced-colors:active) {
 .decision-frame>.delete-heading,.decision-frame .decision-status {background:Canvas!important;color:CanvasText}
 :is(#deleteDialog,.deletion-dialog).decision-frame button:focus-visible::before {outline-color:Highlight}
}
`;
