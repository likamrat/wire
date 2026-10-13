export const toolbarStyles = `
.chart-panel {container:chart-toolbar / inline-size}
.chart-heading {
 display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;
 column-gap:12px;row-gap:0;min-height:44px;margin-bottom:16px;
}
.chart-heading h2 {margin:0;overflow-wrap:normal}
.chart-heading #bucketControl {
 display:inline-flex;align-items:baseline;flex-wrap:wrap;gap:0 var(--space-sm);min-width:0;max-width:100%;
 font-size:var(--type-caption);line-height:var(--leading-control);white-space:normal;
}
.chart-heading #bucketFilter {
 width:auto;min-height:44px;padding:12px 6px;border:0;border-radius:6px;
 background:transparent;color:var(--ink);font-size:inherit;font-weight:var(--weight-medium);
 line-height:20px;box-shadow:none;touch-action:manipulation;
}
.chart-heading #bucketFilter:hover {background:var(--hover)}
.chart-heading #bucketFilter:active {background:var(--accent-soft)}
.chart-heading #bucketFilter:focus-visible {outline:2px solid var(--focus);outline-offset:-2px}
.chart-heading:has(#bucketControl[hidden]) {grid-template-columns:minmax(0,1fr)}
@container chart-toolbar (max-width:36rem) {
 .chart-heading {grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:4px}
 .chart-heading h2 {grid-column:1/-1}
 .chart-heading #bucketControl {grid-column:1}
 .chart-heading:has(#bucketControl[hidden]) {grid-template-columns:minmax(0,1fr)}
}
`;
