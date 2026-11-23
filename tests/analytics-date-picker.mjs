const pickers = {
    trends: ["#trendsPeriod", "#trendsDates"],
    compare: ["#comparisonDates", "#comparisonCustomDates"],
};

export async function openDatePicker(page, surface, choice) {
    const [trigger, panelId] = pickers[surface];
    await page.locator(trigger).click();
    const panel = page.locator(panelId);
    if (choice) await panel.getByRole("button", { name: choice, exact: true }).click();
    return panel;
}

export async function compareAnalyzePeriods(page, baseline, selected) {
    const ready = () => page.locator("#periodComparisonStatus").filter({ hasText: "Comparison ready." }).waitFor({ state: "attached" });
    await page.getByRole("link", { name: "Compare", exact: true }).click();
    await ready();
    const calendar = await openDatePicker(page, "compare", "Custom dates");
    for (const [role, values] of [["A", baseline], ["B", selected]]) {
        await calendar.getByLabel(`Period ${role} from`, { exact: true }).fill(values[0]);
        await calendar.getByLabel(`Period ${role} to`, { exact: true }).fill(values[1]);
    }
    const read = () => page.waitForResponse(r => r.url().endsWith("/api/period-comparison") && r.ok());
    await Promise.all([read(), calendar.getByRole("button", { name: "Apply dates", exact: true }).click()]);
    await ready();
    await page.locator("#openAnalyzeFilters").click();
    const [response] = await Promise.all([read(), page.getByRole("button", { name: "Use Analyze view", exact: true }).click()]);
    await ready();
    await page.locator("#closeAnalyzeFilters").click();
    return response.json();
}
