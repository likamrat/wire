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
