import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

export const resultCueColors = Object.freeze(Object.fromEntries(
    Object.entries(createDimensionalCharts().outcomeTones).map(([key, tone]) => [key, `var(--chart-${tone}-label)`]),
));

export const semanticCueStyles = `
${Object.entries(resultCueColors).map(([key, color]) => `.result-tone-${key} {--cue-color:${color}}`).join("\n")}
.service-cue {--cue-color:var(--column-label);--cue-icon-size:24px}
.semantic-cue {display:inline-flex;align-items:flex-start;gap:8px;max-width:100%;vertical-align:baseline;font-weight:600;line-height:1.6}
.semantic-cue,.recorded-result,.recorded-result:is(:hover,:active),.result-legend-icon {color:var(--cue-color)}
.semantic-cue>span {min-width:0;overflow-wrap:anywhere}
.semantic-cue .wire-icon {display:block;width:var(--cue-icon-size,20px);height:var(--cue-icon-size,20px);flex:0 0 var(--cue-icon-size,20px);margin-top:calc((1lh - var(--cue-icon-size,20px)) / 2)}
.semantic-cue .wire-icon[data-lucide-icon=info][data-icon-size="16"] {width:16px;height:16px;flex-basis:16px;margin-inline:2px;margin-top:calc((1lh - 16px) / 2)}
.service-cue[data-service-icon=Assistance] {--cue-color:var(--screen-activity-assistance)}
.percentage-legend-row[data-service-basis=Assistance] {--column-label:var(--screen-activity-assistance);--column-mid:var(--screen-activity-assistance)}
.result-legend-icon {display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex:0 0 20px}
.result-legend-icon .wire-icon {width:20px;height:20px}
.result-legend-icon .wire-icon[data-lucide-icon=info][data-icon-size="16"] {width:16px;height:16px}
@media(forced-colors:active) {
 .semantic-cue,.recorded-result,.recorded-result:is(:hover,:active),.result-legend-icon {color:CanvasText}
 .result-link,.result-link:is(:hover,:active) {color:LinkText}
}
@media print {
 .semantic-cue,.recorded-result,.recorded-result:is(:hover,:active),.result-legend-icon {color:#172333}
}
`;
