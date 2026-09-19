import { resolve } from 'node:path';
import { expect, test, type Browser } from 'playwright/test';

async function openApp(browser: Browser, options: {
  width: number;
  height: number;
  hasTouch: boolean;
  isMobile?: boolean;
}) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    hasTouch: options.hasTouch,
    isMobile: options.isMobile ?? false,
    deviceScaleFactor: options.isMobile ? 2 : 1,
  });
  // A fresh profile opens on the alpha notice, which covers the whole shell.
  // Acknowledge it up front so the layout assertions see the real chrome.
  await context.addInitScript(() => {
    try { localStorage.setItem('photolib.alphaNoticeAcknowledged', '1'); } catch { /* private mode */ }
  });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByTestId('adaptive-app-shell')).toBeVisible();
  return { context, page };
}

async function expectTouchTarget(locator: import('playwright/test').Locator) {
  const box = await locator.boundingBox();
  expect(box, 'touch target should have a layout box').not.toBeNull();
  expect(box!.width, 'touch target width').toBeGreaterThanOrEqual(44);
  expect(box!.height, 'touch target height').toBeGreaterThanOrEqual(44);
}

async function openPhoneEditor(browser: Browser) {
  const result = await openApp(browser, {
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });

  // A volatile FileList source is enough to exercise the real library →
  // editor transition. The checked-in assets directory contains one PNG;
  // non-image SVG files are ignored by FileListSource.
  await result.page.locator('input[type="file"][webkitdirectory]')
    .setInputFiles(resolve('src/assets'));
  const photoTile = result.page.locator('.grid-item.tile').first();
  await expect(photoTile).toBeVisible();
  await photoTile.dblclick();
  await expect(result.page.getByTestId('phone-editor-toolbar')).toBeVisible();
  return result;
}

test('desktop retains the original sidebar shell', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 1_440,
    height: 900,
    hasTouch: false,
  });
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'desktop');
  await expect(page.locator('html')).toHaveAttribute('data-input', 'pointer');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.adaptive-topbar')).toHaveCount(0);
  await expect(page.locator('.mobile-bottom-nav')).toHaveCount(0);
  await context.close();
});

test('phone library uses one compact, contextual top bar and no persistent bottom chrome', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'phone');
  await expect(page.locator('html')).toHaveAttribute('data-input', 'touch');
  await expect(page.locator('html')).toHaveAttribute('data-orientation', 'portrait');
  await expect(page.locator('.mobile-bottom-nav')).toHaveCount(0);
  await expect(page.locator('.ps-phone-panel-bar')).toHaveCount(0);
  await expect(page.locator('.ps-phone-tool-trigger')).toHaveCount(0);
  await expect(page.getByTestId('phone-view-mode-trigger')).toHaveCount(0);
  await expect(page.locator('.vmb-phone-trigger')).toHaveCount(0);
  await expect(page.locator('.grid-toolbar-wrapper')).toHaveCount(0);
  await expect(page.locator('.grid-toolbar')).toHaveCount(0);
  await expect(page.locator('.adaptive-topbar')).toBeVisible();
  await expect(page.locator('.adaptive-navigation-drawer')).toHaveCount(0);
  await expect(page.locator('.main-content')).toHaveCSS('padding-bottom', '0px');

  const topbarBox = await page.locator('.adaptive-topbar').boundingBox();
  expect(topbarBox, 'phone top bar should have a layout box').not.toBeNull();
  expect(topbarBox!.height).toBeGreaterThanOrEqual(44);
  expect(topbarBox!.height).toBeLessThanOrEqual(60);

  const menuButton = page.locator('.adaptive-menu-btn');
  await expectTouchTarget(menuButton);
  const topbarActions = page.locator('.adaptive-topbar .adaptive-action-btn');
  await expect(topbarActions).toHaveCount(3);
  for (let index = 0; index < await topbarActions.count(); index += 1) {
    await expectTouchTarget(topbarActions.nth(index));
  }

  const searchButton = topbarActions.nth(0);
  await searchButton.click();
  const searchInput = page.locator('.adaptive-search-mode input[type="search"]');
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toBeFocused();
  await searchInput.fill('responsive-search');
  await page.keyboard.press('Escape');
  await expect(page.locator('.adaptive-search-mode')).toHaveCount(0);
  await expect(searchButton).toBeFocused();

  const adjustButton = page.locator('.adaptive-adjust-btn');
  await adjustButton.click();
  const librarySheet = page.locator('.phone-library-sheet[role="dialog"]');
  await expect(librarySheet).toBeVisible();
  await expect(librarySheet.locator('.phone-choice-grid')).toHaveCount(2);
  await expect(librarySheet.locator('input[type="range"]')).toBeVisible();
  await expect(librarySheet.locator('.phone-filter-row').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(librarySheet).toHaveCount(0);
  await expect(adjustButton).toBeFocused();

  const overflowButton = page.locator('.adaptive-topbar .adaptive-action-btn').last();
  await overflowButton.click();
  const actionSheet = page.locator('.phone-library-sheet[role="dialog"]');
  await expect(actionSheet).toBeVisible();
  await actionSheet.locator('.phone-library-action-list button').first().click();
  await expect(actionSheet).toHaveCount(0);
  await expect(page.locator('.adaptive-selection-count')).toBeVisible();
  await expect(page.locator('.adaptive-context-button')).toHaveCount(0);
  const closeSelectionButton = page.locator('.adaptive-topbar .adaptive-action-btn').first();
  await expect(closeSelectionButton).toBeFocused();
  await closeSelectionButton.click();
  await expect(page.locator('.adaptive-selection-count')).toHaveCount(0);

  // The only persistent bar yields the space while browsing down and returns
  // promptly as soon as the user reverses direction. A synthetic scroller is
  // sufficient here because the app listens through React's capture phase.
  await page.evaluate(() => {
    const main = document.querySelector('.main-content');
    if (!main) throw new Error('main content missing');
    const scroller = document.createElement('div');
    scroller.className = 'photo-grid responsive-scroll-probe';
    scroller.style.cssText = 'position:absolute;width:1px;height:1px;overflow:auto';
    const content = document.createElement('div');
    content.style.height = '300px';
    scroller.appendChild(content);
    main.appendChild(scroller);
    scroller.scrollTop = 100;
    scroller.dispatchEvent(new Event('scroll'));
  });
  await expect(page.locator('.adaptive-topbar')).toHaveClass(/adaptive-topbar-hidden/);
  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.responsive-scroll-probe');
    if (!scroller) throw new Error('scroll probe missing');
    scroller.scrollTop = 80;
    scroller.dispatchEvent(new Event('scroll'));
    scroller.remove();
  });
  await expect(page.locator('.adaptive-topbar')).not.toHaveClass(/adaptive-topbar-hidden/);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('html')).toHaveAttribute('data-orientation', 'landscape');
  await adjustButton.click();
  const landscapeSheetBox = await page.locator('.phone-library-sheet').boundingBox();
  expect(landscapeSheetBox, 'landscape controls sheet should have a layout box').not.toBeNull();
  expect(landscapeSheetBox!.width).toBeLessThanOrEqual(430);
  expect(landscapeSheetBox!.height).toBe(390);
  await page.keyboard.press('Escape');

  await context.close();
});

test('phone drawer restores focus, closes with Escape, and survives rotation', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });
  const menuButton = page.locator('.adaptive-menu-btn');

  await menuButton.click();
  await expect(page.locator('.adaptive-navigation-drawer-phone')).toBeVisible();
  await expect(page.locator('.adaptive-navigation-drawer .sidebar')).toBeVisible();
  await expect(page.locator('.adaptive-drawer-close')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.adaptive-navigation-drawer')).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  await menuButton.click();
  await page.locator('.adaptive-navigation-drawer .settings-footer-btn').click();
  await expect(page.locator('.adaptive-navigation-drawer')).toHaveCount(0);
  await expect(page.locator('.settings-dialog')).toBeVisible();
  const settingsBox = await page.locator('.settings-dialog').boundingBox();
  expect(settingsBox?.width).toBe(390);
  expect(settingsBox?.height).toBe(844);

  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'phone');
  await expect(page.locator('html')).toHaveAttribute('data-orientation', 'landscape');
  const landscapeTopbar = await page.locator('.adaptive-topbar').boundingBox();
  expect(landscapeTopbar, 'landscape phone top bar should have a layout box').not.toBeNull();
  expect(landscapeTopbar!.height).toBeLessThanOrEqual(60);
  await context.close();
});

test('phone search keeps rating and flag shortcuts out of text input', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });

  await page.locator('input[type="file"][webkitdirectory]')
    .setInputFiles(resolve('src/assets'));
  const photoTile = page.locator('.grid-item.tile').first();
  await expect(photoTile).toBeVisible();
  await photoTile.click();

  await page.locator('.adaptive-topbar .adaptive-action-btn').first().click();
  const searchInput = page.locator('.adaptive-search-mode input[type="search"]');
  await expect(searchInput).toBeFocused();
  await searchInput.pressSequentially('pxu123');
  await expect(searchInput).toHaveValue('pxu123');

  await page.keyboard.press('Control+A');
  await expect.poll(() => searchInput.evaluate((input) => ({
    start: (input as HTMLInputElement).selectionStart,
    end: (input as HTMLInputElement).selectionEnd,
  }))).toEqual({ start: 0, end: 6 });

  await context.close();
});

test('phone editor keeps one compact top bar and restores overflow focus', async ({ browser }) => {
  const { context, page } = await openPhoneEditor(browser);

  await expect(page.locator('.adaptive-topbar')).toHaveCount(0);
  await expect(page.locator('.mobile-bottom-nav')).toHaveCount(0);
  await expect(page.locator('.ps-phone-panel-bar')).toHaveCount(0);
  await expect(page.locator('.ps-phone-tool-trigger')).toHaveCount(0);
  await expect(page.locator('.ps-phone-sheet')).toHaveCount(0);

  const toolbar = page.getByTestId('phone-editor-toolbar');
  const toolbarBox = await toolbar.boundingBox();
  expect(toolbarBox, 'phone editor toolbar should have a layout box').not.toBeNull();
  expect(toolbarBox!.height).toBeGreaterThanOrEqual(44);
  expect(toolbarBox!.height).toBeLessThanOrEqual(60);
  for (const button of await toolbar.locator('button').all()) {
    await expectTouchTarget(button);
  }

  const overflowTrigger = toolbar.locator('button[aria-haspopup="menu"]');
  await overflowTrigger.click();
  const overflowMenu = page.locator('.phone-editor-overflow-menu[role="menu"]');
  await expect(overflowMenu).toBeVisible();
  await expect(overflowTrigger).toHaveAttribute('aria-expanded', 'true');
  await expect(overflowMenu.locator('button:not([disabled])').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(overflowMenu).toHaveCount(0);
  await expect(overflowTrigger).toBeFocused();

  await context.close();
});

test('phone editor opens tools on demand and returns focus after closing a tool', async ({ browser }) => {
  const { context, page } = await openPhoneEditor(browser);
  const toolsTrigger = page.getByTestId('phone-editor-tools-trigger');
  await expect(toolsTrigger).toBeEnabled();
  await expectTouchTarget(toolsTrigger);

  await toolsTrigger.click();
  const picker = page.locator('.ps-phone-tool-picker-sheet[role="dialog"]');
  await expect(picker).toBeVisible();
  await expect(picker.locator('[data-phone-sheet-autofocus]')).toBeFocused();

  const firstTool = picker.locator('.ps-phone-tool-grid button').first();
  await expect(firstTool).toBeVisible();
  await expectTouchTarget(firstTool);
  await firstTool.click();

  const toolSheet = page.locator('.ps-phone-sheet[role="dialog"]');
  await expect(toolSheet).toBeVisible();
  await expect(page.locator('.ps-phone-tool-picker-sheet')).toHaveCount(0);
  await expect(toolSheet.locator('.ps-phone-sheet-content')).toBeVisible();
  await expect(toolSheet.locator('[data-phone-sheet-autofocus]')).toBeFocused();

  await toolSheet.locator('.ps-phone-sheet-title button').last().click();
  await expect(toolSheet).toHaveCount(0);
  await expect(toolsTrigger).toBeFocused();

  await context.close();
});

test('tablet uses drawers in portrait and landscape without phone navigation', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 768,
    height: 1_024,
    hasTouch: true,
  });
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'tablet');
  await expect(page.locator('html')).toHaveAttribute('data-orientation', 'portrait');
  await expect(page.locator('.adaptive-topbar')).toBeVisible();
  await expect(page.locator('.mobile-bottom-nav')).toHaveCount(0);
  await expect(page.locator('.grid-toolbar-wrapper')).toBeVisible();
  await expect(page.locator('.view-mode-bar')).toBeVisible();
  await expect(page.locator('.phone-library-sheet')).toHaveCount(0);
  const tabletToolbarBox = await page.locator('.toolbar-btn').first().boundingBox();
  expect(tabletToolbarBox?.height).toBeGreaterThanOrEqual(44);
  const tabletViewModeBox = await page.locator('.vmb-btn').first().boundingBox();
  expect(tabletViewModeBox?.height).toBeGreaterThanOrEqual(44);

  // Adaptive overlays are scoped to their screen class. A drawer opened on
  // tablet must not reappear after visiting the phone shell and returning.
  const panelDrawerTrigger = page.locator('.ps-tablet-drawer-trigger-right');
  await expect(panelDrawerTrigger).toBeVisible();
  await panelDrawerTrigger.click();
  await expect(page.locator('.ps-tablet-drawer-right')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'phone');
  await expect(page.locator('.ps-tablet-drawer')).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 1_024 });
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'tablet');
  await expect(page.locator('.ps-tablet-drawer')).toHaveCount(0);

  await page.locator('.adaptive-menu-btn').click();
  await expect(page.locator('.adaptive-navigation-drawer-tablet')).toBeVisible();
  const drawerNavBox = await page.locator('.adaptive-navigation-drawer .nav-item').first().boundingBox();
  expect(drawerNavBox?.height).toBeGreaterThanOrEqual(44);

  await page.setViewportSize({ width: 1_024, height: 768 });
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'tablet');
  await expect(page.locator('html')).toHaveAttribute('data-orientation', 'landscape');
  await context.close();
});

test('settings can persistently switch between automatic and preview shells', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 1_440,
    height: 900,
    hasTouch: false,
  });

  await page.locator('.settings-footer-btn').click();
  await page.getByTestId('settings-tab-appearance').click();
  await page.getByTestId('ui-mode-phone').click();

  await expect(page.locator('html')).toHaveAttribute('data-screen', 'phone');
  await expect(page.locator('html')).toHaveAttribute('data-input', 'touch');
  await expect(page.locator('html')).toHaveAttribute('data-ui-mode', 'phone');
  await expect(page.locator('.mobile-bottom-nav')).toHaveCount(0);
  await expect(page.locator('.adaptive-topbar')).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('photolib.uiModeOverride'))).toBe('phone');

  await page.reload();
  await expect(page.getByTestId('adaptive-app-shell')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-screen', 'phone');

  await page.locator('.adaptive-menu-btn').click();
  await page.locator('.adaptive-navigation-drawer .settings-footer-btn').click();
  await page.getByTestId('settings-tab-appearance').click();
  await page.getByTestId('ui-mode-auto').click();

  await expect(page.locator('html')).toHaveAttribute('data-screen', 'desktop');
  await expect(page.locator('html')).toHaveAttribute('data-ui-mode', 'auto');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('photolib.uiModeOverride'))).toBe('auto');
  await context.close();
});

test('phone: rate, flag and label a selection', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });

  await page.locator('input[type="file"][webkitdirectory]')
    .setInputFiles(resolve('src/assets'));
  const photoTile = page.locator('.grid-item.tile').first();
  await expect(photoTile).toBeVisible();

  // Rating, flag and label hang off the content hash, and opening the photo
  // once is what computes it. Same precondition the desktop shortcuts have.
  await photoTile.dblclick();
  const editorToolbar = page.getByTestId('phone-editor-toolbar');
  await expect(editorToolbar).toBeVisible();
  await editorToolbar.locator('button').first().click();
  await expect(page.locator('.adaptive-topbar')).toBeVisible();

  // Multi-select lives behind the overflow sheet; its first action opens it.
  await page.locator('.adaptive-topbar .adaptive-action-btn').last().click();
  await page.locator('.phone-library-sheet .phone-library-action-list button').first().click();
  await expect(page.locator('.adaptive-selection-count')).toBeVisible();
  // Opening the photo already selected it; a tap here would toggle it back off.
  if (!(await photoTile.getAttribute('class'))?.includes('selected')) await photoTile.click();
  await expect(photoTile).toHaveClass(/selected/);

  const rateButton = page.locator('.adaptive-selection-rate-btn');
  await expectTouchTarget(rateButton);
  await rateButton.click();
  const sheet = page.locator('.phone-library-sheet[role="dialog"]');
  await expect(sheet.locator('.photo-meta-controls')).toBeVisible();
  await expectTouchTarget(sheet.locator('.pmc-stars button[data-rating="3"]'));

  await sheet.locator('.pmc-stars button[data-rating="3"]').click();
  await sheet.locator('.pmc-flags button[data-flag="pick"]').click();
  await sheet.locator('.pmc-labels button[data-label="red"]').click();
  // Escape would also drop the selection (grid shortcut), so close the sheet
  // the way the thumb does.
  await sheet.locator('.phone-library-sheet-header button').click();
  await expect(sheet).toHaveCount(0);

  await expect(photoTile.locator('.star-filled')).toHaveCount(3);
  await expect(photoTile.locator('.tile-flag.pick')).toHaveCount(1);
  await expect(photoTile).toHaveAttribute('style', /--label-red/);

  // The same block takes every value back again.
  await rateButton.click();
  await sheet.locator('.pmc-stars button[data-rating="0"]').click();
  await sheet.locator('.pmc-flags button[data-flag="none"]').click();
  await sheet.locator('.pmc-labels button[data-label="none"]').click();
  await sheet.locator('.phone-library-sheet-header button').click();

  await expect(photoTile.locator('.star-filled')).toHaveCount(0);
  await expect(photoTile.locator('.tile-flag')).toHaveCount(0);
  await expect(photoTile).not.toHaveAttribute('style', /--label-red/);

  await context.close();
});

test('phone: the adjust sheet switches RAW+JPEG pairing back off', async ({ browser }) => {
  const { context, page } = await openApp(browser, {
    width: 390,
    height: 844,
    hasTouch: true,
    isMobile: true,
  });

  const adjustButton = page.locator('.adaptive-adjust-btn');
  await adjustButton.click();
  const pairToggle = page.locator('.phone-library-sheet .phone-pair-raw-toggle');
  await expect(pairToggle).not.toBeChecked();
  await pairToggle.click();
  await expect(pairToggle).toBeChecked();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('photolib-pairRawJpeg'))).toBe('true');

  await pairToggle.click();
  await expect(pairToggle).not.toBeChecked();

  await context.close();
});
