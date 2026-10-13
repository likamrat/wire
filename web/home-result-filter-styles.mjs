export const homeResultFilterStyles = `
.home-result-filter {display:flex;flex-wrap:wrap;align-items:end;gap:4px 12px;margin-bottom:20px;min-width:0}
.result-filter-field {display:flex;flex-direction:column;gap:var(--select-field-gap);min-width:0;max-width:100%}
.result-filter-field>label {flex:none;padding-inline:var(--select-value-inset);font-size:var(--type-small);font-weight:600;line-height:1.5}
.local-filter-row {display:grid;grid-template-columns:minmax(0,1fr) 44px;align-items:center;gap:var(--pill-gap);width:fit-content;max-width:100%}
.local-filter-row>.select-control {width:auto;max-width:24rem;min-width:0}
.filter-clear-slot {display:flex;align-items:center;justify-content:center;width:44px;min-height:44px}
.filter-clear {display:inline-flex;align-items:center;justify-content:center;width:44px;min-width:44px;min-height:44px;padding:10px}
.filter-clear .fluent-icon {width:20px;height:20px}
.home-result-filter>p {font-size:var(--type-small);color:var(--muted);max-width:52ch;padding-block:10px;line-height:1.5}
.period-controls>.home-result-filter {margin:0;max-width:100%}
.period-controls .result-filter-field>label {display:flex;flex-direction:row;align-items:center;justify-content:flex-start;min-height:var(--select-help-target);font-weight:var(--weight-regular)}
.result-filter-heading {min-height:var(--select-help-target);padding-inline:var(--select-value-inset);align-items:center}
.result-filter-heading>label {display:block;flex:initial;padding:0;font-size:var(--type-small);font-weight:var(--weight-regular);line-height:1.5}
.result-filter-heading>.ux-help {width:var(--select-help-target);min-width:var(--select-help-target);height:var(--select-help-target);min-height:var(--select-help-target)}
.select-trigger .select-value.result-option-value,.result-option-value {display:flex;align-items:flex-start;gap:8px;white-space:normal;overflow:visible}
.result-option-label {min-width:0;overflow-wrap:anywhere}
.result-option-value .result-legend-icon {margin-block:calc((1lh - 20px)/2) 0}
#outcomeFilter-control {padding-block:8px;border-radius:var(--radius-field)}
.section-heading>.filter-field:has(#activitySearch) {width:min(100%,20rem)}
.section-heading .search-input-row #activitySearch {width:100%}
`;
