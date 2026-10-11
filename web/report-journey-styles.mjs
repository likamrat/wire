export const reportJourneyStyles = `
.report-task-nav{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 20px;max-width:1100px}
.report-task-nav>a{min-height:44px;align-content:center;white-space:normal}
.report-task-nav>a[aria-current=page]{--pill-fill:var(--accent-soft);--pill-border:var(--accent);color:var(--accent);font-weight:var(--weight-strong)}
#reportCreatePanel[hidden],#savedReportsPanel[hidden]{display:none!important}
#reportsView #savedReportsPanel #bundles{margin-top:0}
.assessment-dialog.saved-report-dialog{width:min(72rem,calc(100% - 24px))}
.assessment-dialog.saved-report-dialog>.dialog-head{flex-wrap:wrap}
.assessment-dialog.saved-report-dialog>.dialog-head h2{flex:1 1 auto;min-width:min-content;overflow-wrap:normal}
.saved-report-dialog .report-frame{height:65vh;min-height:320px}
#reportsView .report-start{display:block;padding:16px 0;margin:0;border-bottom:1px solid var(--rule)}
.report-heading-context{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
#reportsView .report-start #reportPreviewContext{display:grid;grid-template-columns:minmax(0,1fr) auto;width:100%;align-items:center;gap:4px 16px;margin:0;text-align:left}
#reportsView #reportPreviewContext>#pageHeadingActions{grid-column:2;grid-row:1 / 3}
#reportsView #reportPreviewContext>.report-choice-summary{grid-column:1;font-size:var(--type-body);margin:0}
.report-journey{max-width:1100px;margin:0 0 20px;padding:20px 24px;background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius-small);container:report-journey / inline-size}
.report-progress-label{font-weight:var(--weight-strong);font-size:var(--type-body);margin:0 0 8px;color:var(--accent)}
.report-progress ol{list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:0;padding:0}
.report-progress li{min-width:0}
.report-step{display:flex;gap:var(--pill-gap);align-items:center;justify-content:flex-start;width:100%;min-height:48px;border:0;background:transparent;padding:8px var(--pill-inset);text-align:left;white-space:normal}
.report-step:disabled{background:transparent}
.report-step>span:not(.report-step-number){min-width:0;overflow-wrap:anywhere}
.report-step-number{display:grid;place-items:center;flex:none;width:1.75rem;height:1.75rem;border-radius:50%;font-variant-numeric:tabular-nums;background:var(--canvas);color:var(--muted)}
.report-step[data-visited=true]{color:var(--accent)}
.report-step[data-visited=true] .report-step-number{background:var(--accent-soft);color:var(--accent)}
.report-step[aria-current=step]{background:var(--accent-soft);color:var(--accent);box-shadow:inset 0 0 0 2px var(--accent)}
.report-step[aria-current=step] .report-step-number{background:var(--accent-fill);color:var(--on-accent)}
.report-step-hint-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.report-step:not(:disabled):hover{background:var(--hover)}
.report-stage{margin-top:20px;min-width:0}
.report-stage>h3{font-size:var(--type-dialog);line-height:var(--leading-dialog);margin:0 0 20px;text-wrap:balance;scroll-margin-top:calc(var(--app-header-height,80px) + 16px)}
.report-entry-context,.report-scope-gap{max-width:72ch;line-height:var(--leading-reading)}
.report-choice-summary{margin:4px 0 0;color:var(--muted);font-size:1rem}
.report-entry-context{margin:12px 0 0;color:var(--muted);font-size:var(--type-body)}
.report-stage-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:20px 0 0;border-top:1px solid var(--rule);padding-top:12px}
.report-stage-actions button,.report-downloads button{min-height:44px;max-width:100%;height:auto;white-space:normal;overflow-wrap:anywhere}
.report-stage-actions>.report-scope-gap{flex-basis:100%;max-width:none;margin:0 0 4px;color:var(--muted)}
.report-stage-actions>:last-child{margin-inline-start:auto}
.report-next-actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;min-width:0;max-width:100%}
.report-stage .export-scope{margin:0;min-width:0}
.report-scope-layout{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:24px;align-items:start}
.report-journey .export-scope legend{font-size:var(--type-body);line-height:var(--leading-ui);margin-bottom:8px}
.report-journey .report-author-choice{margin:0;gap:8px}
.report-journey .report-author-choice>.scope-summary{margin:0;font-weight:var(--weight-medium)}
.report-journey .report-author-choice>.context-help-note{margin:0}
.report-stage .scope-choices{display:grid;gap:8px}
.report-stage .scope-choice{max-width:none;margin:0;padding:12px}
.report-stage .scope-choice-help{margin-top:6px;line-height:var(--leading-ui)}
.report-stage .report-options{margin:24px 0 16px;padding-top:20px;border-top:1px solid var(--rule);gap:24px}
.report-stage .report-options>fieldset{min-width:0}
.report-journey #reportTimeContext{font-size:var(--type-body);line-height:var(--leading-ui)}
#reportsView :is(.detail-disclosure,.supporting){margin-top:12px;margin-bottom:0}
#reportsView :is(.detail-disclosure,.supporting)>summary,#reportsView:not([hidden])~#coverage>summary{font:var(--weight-medium) var(--type-body)/var(--leading-ui) var(--font);min-height:44px;padding:12px 0;overflow-wrap:anywhere}
#reportsView .report-stage>.detail-disclosure,#reportsView .report-stage>.supporting{margin-top:8px}
#reportsView #bundles,#reportsView:not([hidden])~#coverage{max-width:1100px;margin-top:16px}
.report-journey .report-snapshot-details{margin:0 0 12px}
.report-snapshot-details>p{margin:8px 0;font-size:var(--type-body);line-height:var(--leading-reading);font-weight:var(--weight-regular)}
.report-privacy-note{line-height:var(--leading-reading);margin:12px 0 16px}
.report-journey .report-document{padding:0;border:0;border-radius:0;background:transparent}
.report-document>h3{font-size:var(--type-section);line-height:var(--leading-section)}
.report-document>.muted{margin:4px 0 12px;font-size:var(--type-body)}
.report-journey .report-review-body,.report-journey .report-save-body{min-width:0}
.report-journey .report-frame{width:100%;min-height:420px;height:60vh;max-height:800px;border:1px solid var(--rule);border-radius:var(--radius-small);background:#fff}
.report-copy-inspection>.prompt-comparisons{margin-top:20px}
.report-journey .prompt-comparison,.report-journey .prompt-pair>*{min-width:0}
.report-journey pre,.report-journey textarea{max-width:100%;overflow-wrap:anywhere}
.report-journey .ux-code-toolbar>.ux-copy{width:44px;height:44px;min-width:44px;min-height:44px}
.report-journey .report-confirmation,.report-journey .report-time-context{overflow-wrap:anywhere}
.report-review-body>.attestation{margin:16px 0 12px;line-height:var(--leading-reading)}
.report-review-body>p[role=status]:empty{display:none}
.report-save-summary{display:grid;gap:12px;margin:0 0 16px}
.report-save-summary>div{display:grid;grid-template-columns:8rem minmax(0,1fr);gap:8px 16px}
.report-save-summary dt{color:var(--muted)}
.report-save-summary dd{margin:0;overflow-wrap:anywhere;font-weight:var(--weight-medium)}
.report-save-boundary{margin:16px 0 8px}
.report-save-body>p[role=status]{font-size:var(--type-body);line-height:var(--leading-reading)}
.report-journey-error{scroll-margin-top:120px}
.report-save-success{font-weight:600;color:var(--success);margin-bottom:12px}
.report-saved-id,.report-saved-location{overflow-wrap:anywhere;color:var(--muted)}
#bundleList .saved-report>summary{min-height:44px}
.saved-library-context{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 20px}
.saved-library-context>p{margin:0;color:var(--muted)}
#savedLibraryHelp{position:relative;margin-inline-start:auto}
#savedLibraryHelp>summary{min-height:44px;padding:12px 0;color:var(--muted);cursor:pointer}
#savedLibraryHelp[open]{flex-basis:100%;margin-inline-start:0}
#savedLibraryHelpBody{max-width:72ch}
.saved-library-tools{display:flex;flex-wrap:wrap;align-items:end;gap:8px 24px;margin:8px 0}
.saved-library-tools>.scoped-search{flex:1 1 20rem;max-width:30rem;min-width:0;margin:0}
.saved-library-tools>.scoped-search label{display:block;margin:0 0 4px}
.saved-library-tools>button{margin-inline-start:auto;max-width:100%;white-space:normal}
#savedReportSearchCount:empty{display:none}
#bundleList .list-pager{margin:12px 0;gap:8px;align-items:center}
.library-page-jump{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 0 auto}
.library-page-jump label{display:flex;align-items:center;gap:8px;margin:0;font-weight:var(--weight-regular)}
.library-page-jump input{width:5.5rem;min-height:44px;min-width:0;padding:8px}
.saved-library-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:8px;border-top:1px solid var(--rule);padding:8px 0}
#bundleList .saved-library-row>.saved-report{min-width:0;border:0;margin:0;padding:0}
#bundleList .saved-report>summary{display:grid;grid-template-columns:minmax(0,1fr) minmax(10rem,.65fr) auto;align-items:center;gap:12px;list-style:none;padding:4px 0;font-weight:var(--weight-regular)}
.saved-report-summary::-webkit-details-marker{display:none}
.saved-report-identity,.saved-report-metadata{display:grid;gap:2px;min-width:0;overflow-wrap:anywhere}
.saved-report-name{font-weight:var(--weight-strong)}
.saved-report-metadata,.saved-report-disambiguation{color:var(--muted)}
.saved-report-manage{display:flex;align-items:center;gap:8px;padding-inline-end:3px;color:var(--accent);min-height:44px}
.saved-report-manage:after{content:"";width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg)}
[open]>.saved-report-summary .saved-report-manage:after{transform:rotate(225deg)}
.saved-library-row>button{min-height:44px;align-self:center}
.saved-library-row:has(>details[open])>button{align-self:start}
.saved-report-management{padding:12px 0;overflow-wrap:anywhere}
.saved-report-management>p{margin:8px 0}
.saved-report-downloads{display:flex;flex-wrap:wrap;gap:8px}
.saved-report-no-html{align-self:center;color:var(--muted)}
@media(max-width:850px){
 #bundleList .saved-report>summary{grid-template-columns:minmax(0,1fr) auto;gap:4px 12px}
 .saved-report-identity{grid-column:1}
 .saved-report-metadata{grid-column:1}
 .saved-report-manage{grid-column:2;grid-row:1 / 3}
}
@media(max-width:500px){
 .saved-library-tools>.scoped-search{max-width:none;flex-basis:100%}
 .saved-library-tools>button{margin-inline-start:0}
 #bundleList .saved-report>summary{grid-template-columns:minmax(0,1fr)}
 .saved-report-manage{grid-column:1;grid-row:auto}
 .library-page-jump{margin-inline-start:0}
}
.report-downloads{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0 28px}
.report-journey [hidden]{display:none!important}
#reportsView:is([data-report-phase=saved],[data-report-phase=unavailable]) #reportStage3>.report-stage-actions{display:none}
@container report-journey (max-width:46rem){
 .report-scope-layout{grid-template-columns:minmax(0,1fr);gap:16px}
 #reportsView .report-start #reportPreviewContext{grid-template-columns:minmax(0,1fr)}
 #reportsView #reportPreviewContext>#pageHeadingActions{grid-column:1;grid-row:auto}
 .report-options{grid-template-columns:minmax(0,1fr)}
}
@container report-journey (max-width:18rem){
 .report-progress ol{grid-template-columns:minmax(0,1fr)}
 .report-save-summary>div{grid-template-columns:minmax(0,1fr);gap:4px}
}
@media(max-width:700px){
 .report-journey{padding:16px}
 .report-stage>h3{font-size:var(--type-dialog)}
 .report-journey .report-frame{min-height:420px}
 .report-journey .prompt-pair{grid-template-columns:minmax(0,1fr)}
 .report-stage-actions{align-items:stretch}
 .report-stage-actions>.ux-disabled-help,.report-stage-actions>button,.report-next-actions{flex:1 1 160px}
 .report-stage-actions>.ux-disabled-help>button,.report-next-actions>.ux-disabled-help,.report-next-actions button{flex:1}
}
@media(prefers-reduced-motion:reduce){.report-step{transition:none}}
`;
