// Browser assertions for the sidebar and pointer feedback; invoked by server-only QA.
import assert from 'node:assert/strict';

export async function verifyNavigationAndPointer(page, context, output) {
  const sidebar = page.locator('#primary-navigation');
  const width = () => sidebar.evaluate(element => element.getBoundingClientRect().width);
  const waitWidth = expected => page.waitForFunction(value => Math.abs(document.querySelector('#primary-navigation').getBoundingClientRect().width - value) < 2, expected);
  const dragTo = async x => {
    const box = await page.getByRole('separator').boundingBox();
    assert.ok(box, 'The desktop resize handle is accessible');
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, box.y + box.height / 2, { steps: 12 });
    await page.mouse.up();
  };
  const state = expected => page.waitForFunction(value => document.querySelector('.pointer-effect-layer')?.dataset.state === value, expected);

  assert.equal(await page.locator('.kibot-header').count(), 0, 'Primary banner is removed');
  assert.equal(await sidebar.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  assert.ok(Math.abs(await width() - 240) < 2);
  const oldThreadCount = await page.locator('.nav-task-row').count();

  await dragTo(340);
  await waitWidth(340);
  await page.reload();
  await page.locator('.kibot-summary-card').first().waitFor();
  await waitWidth(340);
  assert.equal(await page.locator('.nav-task-row').count(), oldThreadCount, 'Resizing does not change conversations');
  await page.getByRole('separator').focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(await width() > 340, 'Keyboard can resize the sidebar');
  await dragTo(340);
  await waitWidth(340);

  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#primary-navigation').inert);
  await page.waitForFunction(() => document.querySelector('.main-shell').getBoundingClientRect().left < 1);
  const profile = page.getByRole('button', { name: '个人设置', exact: true });
  const avatar = await profile.boundingBox();
  assert.ok(avatar && avatar.width >= 40 && avatar.width <= 44 && avatar.height >= 40);
  await profile.hover();
  await page.getByRole('tooltip').filter({ hasText: '界面验收' }).waitFor();
  await page.screenshot({ path: `${output}/kibot-collapsed.png`, fullPage: true, animations: 'disabled' });
  await profile.click();
  await page.getByRole('dialog', { name: '个人设置', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await profile.evaluate(el => el === document.activeElement), true, 'Settings returns focus to the collapsed avatar');
  await page.reload();
  await page.locator('.kibot-summary-card').first().waitFor();
  assert.equal(await sidebar.evaluate(el => el.inert), true, 'Manual collapse persists across reload');
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await waitWidth(340);

  await dragTo(175);
  await page.waitForFunction(() => document.querySelector('#primary-navigation').inert);
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await waitWidth(340);

  await page.setViewportSize({ width: 820, height: 1000 });
  await page.waitForFunction(() => document.querySelector('#primary-navigation').inert);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await waitWidth(340);
  assert.equal(await sidebar.evaluate(el => el.inert), false, 'Automatically hidden navigation restores when space returns');

  // A wide sidebar should cause history to overlay instead of squeezing the chat.
  await dragTo(400);
  await waitWidth(400);
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.locator('.kibot-summary-card').filter({ hasText: '查看全天记录' }).click();
  await page.waitForFunction(() => document.querySelector('.kibot-history-panel')?.getAttribute('aria-modal') === 'true');
  assert.equal(await page.locator('.chat-panel').evaluate(el => el.inert), true);
  assert.equal(await page.locator('.kibot-history-panel').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)');
  await page.screenshot({ path: `${output}/kibot-adaptive-history.png`, fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await dragTo(240);
  await waitWidth(240);

  const search = page.getByRole('button', { name: '搜索历史', exact: true });
  const box = await search.boundingBox();
  await page.mouse.move(1560, 20);
  await state('free');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height + 10);
  await state('near');
  assert.equal(await page.locator('.pointer-effect-frame').evaluate(el => {
    const css = getComputedStyle(el);
    return css.display === 'none' || Number(css.opacity) === 0 || css.borderTopColor === 'rgba(0, 0, 0, 0)' || css.borderTopWidth === '0px';
  }), true, 'Near feedback must not expose the complete frame');
  await search.hover();
  await state('hover');
  const frame = await page.locator('.pointer-effect-frame').boundingBox();
  assert.ok(frame && Math.abs(frame.x - box.x) <= 5 && Math.abs(frame.width - box.width) <= 8, 'Hover frame fits the actual control');
  assert.notEqual(await search.evaluate(el => getComputedStyle(el).cursor), 'none');
  await page.screenshot({ path: `${output}/kibot-pointer-hover.png`, fullPage: true });
  await search.click();
  assert.ok(await page.locator('.pointer-effect-particle').count() > 0, 'Click feedback creates particles');
  await page.getByRole('dialog', { name: '搜索历史', exact: true }).waitFor();
  assert.ok(await page.locator('.pointer-effect-particle').count() <= 24, 'Particle count is bounded');
  await page.mouse.move(10, 500);
  await page.waitForFunction(() => document.querySelector('.pointer-effect-layer')?.dataset.state !== 'hover');
  await page.keyboard.press('Escape');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await search.hover();
  await state('hidden');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.mouse.move(1560, 20);
  await state('free');

  const touchContext = await context.browser().newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const touchPage = await touchContext.newPage();
    await touchPage.goto(page.url());
    await touchPage.locator('input[name="username"]').waitFor();
    await touchPage.locator('input[name="username"]').tap();
    assert.equal(await touchPage.locator('.pointer-effect-layer').getAttribute('data-state'), 'hidden');
  } finally { await touchContext.close(); }
  console.log(JSON.stringify({ interactionChecks: ['white surfaces', 'removed primary banner', 'drag resize', 'keyboard resize', 'width persistence', 'manual collapse persistence', 'avatar tooltip and settings', 'focus restoration', 'drag collapse threshold', 'automatic collapse and recovery', 'adaptive history drawer', 'free pointer', 'near without frame', 'fitted hover frame', 'bounded particles', 'backdrop exclusion', 'reduced motion', 'touch pointer disabled'], screenshots: 3 }));
}
