import { createDimensionalCharts } from "./dimensional-charts.mjs";
import { dimensionalColumnStyles } from "../web/dimensional-charts-styles.mjs";
import { semanticCueStyles } from "../web/semantic-cue-styles.mjs";

const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export { resultCueColors as dimensionalOutcomeColors } from "../web/semantic-cue-styles.mjs";

export function createDimensionalReportChart() {
    const charts = createDimensionalCharts();
    return analytics => {
        if (analytics.layer === "code-reference") return "";
        const groups = [...analytics.visibleGroups, ...(analytics.otherGroup ? [analytics.otherGroup] : [])];
        const maximum = Math.max(...groups.map(group => group.total), 1);
        const scenes = [];
        for (let offset = 0; offset < groups.length; offset += 3) {
            const page = groups.slice(offset, offset + 3);
            const scene = charts.scene({ length: page.length, maximum, totals: page.map(group => group.total) });
            scenes.push(`<div class="dimensional-report-scroll"><div class="dimensional-report-grid" style="width:${scene.width}px;--scene-base:${scene.base}px;grid-template-columns:repeat(${page.length},${scene.pitch}px);padding-inline:${(scene.width - page.length * scene.pitch) / 2}px">${charts.plane(scene, page)}${page.map((group, index) => {
                const options = { total: group.total, maximum, values: group, width: scene.columnWidth };
                const geometry = charts.layout(options);
                return `<div class="dimensional-report-category" data-ground-y="${scene.columns[index].base}"><div class="dimensional-report-stage"><strong style="bottom:${geometry.height + 8}px">${group.total}</strong><div class="dimensional-report-column" style="left:calc(50% - ${geometry.paintedCenter}px)">${charts.svg(options)}</div></div><span class="dimensional-report-label">${escapeHtml(group.label)}</span></div>`;
            }).join("")}</div></div>`);
        }
        return `<div class="dimensional-report" role="img" aria-label="${escapeHtml(`Exact ${analytics.unit} counts. Visual sizes are adjusted for readability. Exact counts and outcomes follow in the table.`)}"><p class="dimensional-report-reading">${escapeHtml(analytics.unit)}. Visual sizes are adjusted for readability using a square-root height scale and minimum visible sections; counts in labels and the table are exact. Neutral tops mark the end, not another result. Colors identify recorded results, not task correctness.${groups.length > 3 ? " Each group of three keeps the same visual scale." : ""}</p>${scenes.join("")}</div>`;
    };
}

export const dimensionalReportStyles = `
${dimensionalColumnStyles}
${semanticCueStyles}
:root {--paper:#fcfdff}
.dimensional-report {margin:24px 0}
.dimensional-report-reading {font-size:.8125rem;color:#50647b}
.dimensional-report-scroll {overflow-x:auto;overflow-y:hidden;margin:max(16px,1rem) 0;padding-bottom:max(16px,1rem);break-inside:avoid}
.dimensional-report-grid {display:grid;position:relative;margin-inline:auto}
.dimensional-report-category {min-width:0;position:relative;break-inside:avoid}
.dimensional-report-stage {height:var(--scene-base);position:relative}
.dimensional-report-stage strong {position:absolute;left:50%;transform:translateX(-50%);font-size:22px;line-height:1.2;font-variant-numeric:tabular-nums}
.dimensional-report-column {position:absolute;bottom:0}
.dimensional-report-label {display:block;margin:28px 8px 0;overflow-wrap:anywhere;text-align:center;font-size:.8125rem;line-height:1.45;position:relative}
@media print {.dimensional-report-scroll {overflow:visible}.dimensional-report-reading {break-after:avoid;break-inside:avoid}}
`;
