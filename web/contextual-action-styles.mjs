export const contextualActionStyles = `
.page-heading {flex-direction:row;flex-wrap:wrap}
.page-heading>div:first-child {flex:1 1 28rem;min-width:0}
#pagePrimaryActions {flex-shrink:1;justify-content:flex-start;min-width:0;max-width:100%}
#pagePrimaryActions:not(:has(> :not([hidden]))) {display:none}
#pagePrimaryActions :is(button,a) {min-height:44px;white-space:normal;overflow-wrap:anywhere}
#reportSelectionBar,#reportsView #reportPreviewContext {
 display:flex;flex-direction:column;align-items:flex-start;gap:8px;
 min-width:0;max-width:100%;margin:0 0 20px;text-align:left;
}
.page-heading>#reportSelectionBar {flex:0 1 auto;margin:0}
.page-heading>#reportSelectionBar:has(#activitySelectionContext:not([hidden])) {flex-basis:100%}
.page-heading .contextual-summary p {margin:0;color:var(--ink)}
.contextual-summary {display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}
.contextual-summary p {font-weight:var(--weight-medium)}
.selection-number {display:inline-block;text-align:end;font-variant-numeric:tabular-nums}
#reportsView #reportPreviewContext>.report-choice-summary {margin:0}
#reportSelectionActions:empty {display:none}
.contextual-actions {
 display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-start;
 gap:var(--pill-gap);min-width:0;max-width:100%;font-size:var(--type-body);
}
.contextual-actions #contextReturn {display:flex;min-width:0;max-width:100%}
#pagePrimaryActions #contextReturn {display:flex;min-width:0;max-width:100%}
.contextual-actions :is(button,a) {
 min-height:44px;max-width:100%;white-space:normal;overflow-wrap:anywhere;
}
.contextual-actions .reset-view {color:var(--accent)}
@media(max-width:600px) {
 .page-heading:has(#contextReturn:not([hidden])) #pagePrimaryActions {order:-1;flex-basis:100%}
}
`;
