export async function reportContents(page) {
    const reports = page.locator("#reportsView");
    if (await reports.getAttribute("data-report-step") !== "2") {
        if (await reports.getAttribute("data-report-step") === "1") await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
        else await page.getByRole("button", { name: "2. Contents", exact: true }).click();
    }
}

export async function chooseReportScope(page, value) {
    if (await page.locator("#reportsView").getAttribute("data-report-step") !== "1") await page.getByRole("button", { name: "1. Requests", exact: true }).click();
    if (value !== "selected" && !await page.locator(".report-other-scope").evaluate(node => node.open)) await page.locator(".report-other-scope > summary").click();
    await page.locator(`[name=reportScope][value=${value}]`).check();
}

export async function inspectReportCopies(page) {
    const disclosure = page.locator(".report-copy-inspection");
    if (await disclosure.count() && !await disclosure.evaluate(node => node.open)) await disclosure.locator(":scope > summary").click();
}

export async function cancelReportPreview(page) {
    await page.getByRole("button", { name: "Back to contents", exact: true }).click();
}

export async function scanReport(page) {
    await reportContents(page);
    const response = page.waitForResponse(value => value.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const preview = await (await response).json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    return preview;
}
