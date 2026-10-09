/* Shared navigation for the primary destinations and secondary dashboard flows. */
async function navigateDashboard(page, name) {
  const primary = async label => {
    const menu = page.getByRole('button', { name: 'Open menu', exact: true });
    if (await menu.isVisible().catch(() => false)) await menu.click();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: label, exact: true }).click();
  };
  if (name === 'Connect') {
    await page.getByRole('button', { name: /^Companion connection:/ }).click();
  } else if (name === 'Settings') {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  } else if (name === 'Visit summary') {
    await primary('Timeline');
    await page.getByRole('button', { name: 'Prepare summary', exact: true }).click();
  } else if (name === 'Ask Parse') {
    await primary('Today');
    await page.getByRole('button', { name: 'Check records', exact: true }).click();
  } else if (name === 'Care plan' || name === 'Support') {
    await primary('Care');
    await page.getByRole('button', { name: name === 'Care plan' ? 'Tasks' : /Requests & follow-ups/, exact: name === 'Care plan' }).click();
  } else {
    await primary(name);
  }
}
module.exports = { navigateDashboard };
