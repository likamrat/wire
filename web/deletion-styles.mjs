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
`;
