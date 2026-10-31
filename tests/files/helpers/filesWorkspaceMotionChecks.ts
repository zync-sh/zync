import type { Locator, Page } from 'playwright-core';

import {
    interruptSidebarWithReducedMotion,
    tilesHaveNoAnimation,
    tracksStayStill,
} from './filesGridStability';

/** Record real file positions while production app-sidebar shells change their space. */
async function sampleMotion(page: Page, listing: Locator, action: () => Promise<unknown>) {
    const recording = listing.evaluate(async (el) => {
        const frames = [];
        let done = false,
            settled = 0;
        el.addEventListener(
            'files-workspace-actions-complete',
            () => {
                done = true;
            },
            { once: true },
        );
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
            await new Promise<number>((resolve) => requestAnimationFrame(resolve));
            const viewport = el.querySelector<HTMLElement>(':scope > div > [role="presentation"]')!;
            const bounds = viewport.getBoundingClientRect();
            const animations = el
                .getAnimations({ subtree: true })
                .filter((animation) => animation.playState === 'running' || animation.pending);
            const options = [...el.querySelectorAll<HTMLElement>('[data-file-name]')];
            const grid = options[0]?.parentElement!.parentElement!;
            frames.push({
                moving: Boolean(
                    el
                        .closest<HTMLElement>('.files-manager')!
                        .querySelector<HTMLElement>('[data-file-layout-moving]')!,
                ),
                listTracks: el
                    .closest<HTMLElement>('.files-manager')!
                    .querySelector<HTMLElement>('.files-list-columns')
                    ? getComputedStyle(
                          el
                              .closest<HTMLElement>('.files-manager')!
                              .querySelector<HTMLElement>('.files-list-columns')!,
                      ).gridTemplateColumns
                    : undefined,
                columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
                width: bounds.width,
                scrollTop: viewport.scrollTop,
                contentAnimations: animations.length,
                inlineOffset: options[0]
                    ? options[0].parentElement!.getBoundingClientRect().left - bounds.left
                    : 0,
                tiles: options
                    .filter((node) => {
                        const box = node.getBoundingClientRect();
                        return box.bottom > bounds.top && box.top < bounds.bottom;
                    })
                    .map((node) => {
                        const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
                        const box = node.getBoundingClientRect();
                        return {
                            name: node.dataset.fileName,
                            x: box.left - bounds.left,
                            y: box.top - bounds.top,
                            width: box.width,
                            height: box.height,
                            matrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
                        };
                    }),
            });
            if (frames.length === 1) {
                el.dataset.workspaceRecordingReady = 'true';
            }
            if (done && !frames.at(-1)!.moving && animations.length === 0) {
                settled++;
            } else {
                settled = 0;
            }
            if (settled >= 2) {
                break;
            }
        }
        delete el.dataset.workspaceRecordingReady;
        return frames;
    });
    await listing.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
        Boolean(document.querySelector<HTMLElement>('[data-workspace-recording-ready]')!),
    );
    await action();
    await listing.evaluate((el) => el.dispatchEvent(new Event('files-workspace-actions-complete')));
    return recording;
}

async function settle(page: Page) {
    await page.waitForFunction(
        () =>
            !document.querySelector<HTMLElement>('[data-file-layout-moving]')! &&
            !document
                .getAnimations()
                .some(
                    (animation) =>
                        'transitionProperty' in animation &&
                        animation.transitionProperty === 'width' &&
                        (animation.playState === 'running' || animation.pending),
                ),
    );
}

function verifyMotion(
    check: (label: string, value: unknown) => void,
    frames: Awaited<ReturnType<typeof sampleMotion>>,
    label: string,
    { columnChange = true } = {},
) {
    const diagnostics = ` (${JSON.stringify(frames.map(({ moving, columns, width, contentAnimations }) => ({ moving, columns, width, contentAnimations })))})`;
    check(
        `${label}: Files inherits sidebar motion and releases it at completion`,
        frames.some((frame) => frame.moving) && !frames.at(-1)!.moving,
    );
    if (columnChange) {
        check(
            `${label}: grid columns reflow during the sidebar transition${frames.some((frame) => frame.moving && frame.columns !== frames[0].columns) ? '' : diagnostics}`,
            frames.some((frame) => frame.moving && frame.columns !== frames[0].columns),
        );
    }
    check(
        `${label}: files have no independent animation or transform`,
        tilesHaveNoAnimation(frames),
    );
    check(
        `${label}: tile positions and widths stay fixed between genuine wraps`,
        tracksStayStill(frames),
    );
}

/** Test the integration missing from a standalone FileManager fixture, including nested scopes. */
export async function runFilesWorkspaceMotionChecks({
    page,
    check,
    screenshot,
}: {
    page: Page;
    check: (label: string, value: unknown) => void;
    screenshot: (name: string) => Promise<void>;
}) {
    await page.setViewportSize({ width: 1450, height: 600 });
    const url = new URL(page.url());
    url.searchParams.set('layout', 'sidebars');
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    const listing = page.getByRole('listbox');
    await listing.waitFor();
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    for (const count of [31, 1000]) {
        await page.evaluate((count) => window.filesUiTest.manyFiles(count), count);
        await page.waitForFunction(
            (count) =>
                document
                    .querySelector<HTMLElement>('[aria-setsize]')
                    ?.getAttribute('aria-setsize') === String(count),
            count,
        );
        for (const side of ['main', 'tools']) {
            for (const state of ['Expand', 'Collapse']) {
                const frames = await sampleMotion(page, listing, () =>
                    button(`${state} ${side} sidebar`).click(),
                );
                verifyMotion(check, frames, `${count}-file ${side} sidebar ${state.toLowerCase()}`);
            }
        }
    }

    const columnsBeforeReversal = await listing.evaluate(
        (el) =>
            getComputedStyle(
                el.querySelector<HTMLElement>('[data-file-name]')!.parentElement!.parentElement!,
            ).gridTemplateColumns,
    );
    const reversed = await sampleMotion(page, listing, async () => {
        await button('Expand main sidebar').click();
        await page.waitForFunction(
            (columns) =>
                getComputedStyle(
                    document.querySelector<HTMLElement>('[role="listbox"] [data-file-name]')!
                        .parentElement!.parentElement!,
                ).gridTemplateColumns !== columns,
            columnsBeforeReversal,
        );
        await button('Collapse main sidebar').press('Enter');
    });
    verifyMotion(check, reversed, 'Main sidebar reversal', { columnChange: false });

    await listing.locator('[data-file-name="file-0000.ts"]').click();
    const nested = await sampleMotion(page, listing, async () => {
        await button('Expand main sidebar').click();
        await button('Hide places').press('Enter');
        await button('Expand tools sidebar').press('Enter');
    });
    verifyMotion(check, nested, 'Overlapping app sidebars and Places');
    check(
        'overlapping motion preserves existing file selection',
        (await page.getByRole('option', { selected: true }).getAttribute('data-file-name')) ===
            'file-0000.ts',
    );

    await interruptSidebarWithReducedMotion(
        page,
        page.locator('[data-shared-sidebar][data-sidebar-position="left"]'),
        button('Collapse main sidebar'),
    );
    await settle(page);
    check(
        'enabling reduced motion settles the sidebar while files remain unanimated',
        (await page
            .locator('[data-shared-sidebar][data-sidebar-position="left"]')
            .evaluate((el) => el.clientWidth === 0)) &&
            (await listing.evaluate((el) =>
                el
                    .getAnimations({ subtree: true })
                    .every((animation) => animation.playState !== 'running' && !animation.pending),
            )),
    );
    await button('Collapse tools sidebar').click();
    await button('Show places').click();
    await settle(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await button('Expand main sidebar').click();
    await settle(page);
    const separator = page.getByRole('separator', { name: 'Resize main sidebar', exact: true });
    const handle = await separator.boundingBox();
    const resized = await sampleMotion(page, listing, async () => {
        await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle!.x + handle!.width / 2 + 150, handle!.y + handle!.height / 2, {
            steps: 12,
        });
        await page.mouse.up();
    });
    check(
        'pointer resizing follows live width without adding finite grid animations',
        resized.at(-1)!.width < resized[0].width - 100 && tilesHaveNoAnimation(resized),
    );
    await separator.press('Home');
    await settle(page);

    await button('Collapse main sidebar').click();
    await settle(page);
    await listing.evaluate(async (el) => {
        const viewport = el.querySelector<HTMLElement>(':scope > div > [role="presentation"]')!;
        viewport.scrollTop = viewport.scrollHeight / 2;
        await new Promise<number>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
    });
    const anchored = await sampleMotion(page, listing, () => button('Expand main sidebar').click());
    const before = anchored[0].tiles[0];
    const after = anchored.at(-1)!.tiles.find((tile) => tile.name === before.name)!;
    check(
        'main-sidebar reflow preserves a manually scrolled visible file and its offset',
        before && after && Math.abs(before.y - after.y) <= 2,
    );

    await button('Collapse main sidebar').click();
    await settle(page);
    await button('Expand main sidebar').click();
    await page.waitForFunction(() =>
        Boolean(document.querySelector<HTMLElement>('[data-file-layout-moving]')!),
    );
    await button('Remove main sidebar').press('Enter');
    await settle(page);
    check(
        'unmounting an animated app sidebar releases the inherited motion owner',
        (await page.getByRole('complementary', { name: 'Main sidebar', exact: true }).count()) ===
            0 && (await page.locator('[data-file-layout-moving]').count()) === 0,
    );
    await button('Add main sidebar').click();
    await settle(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await button('Collapse main sidebar').click();
    await page.setViewportSize({ width: 1100, height: 600 });
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    const fixedTracks = await page
        .locator('.files-list-columns')
        .first()
        .evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const listFrames = await sampleMotion(page, listing, () =>
        button('Expand main sidebar').click(),
    );
    check(
        'List columns retain fixed positions throughout inherited sidebar motion',
        listFrames.some((frame) => frame.moving) &&
            listFrames.every((frame) => frame.listTracks === fixedTracks),
    );
    await button('Collapse main sidebar').click();
    await settle(page);
    await page.getByRole('button', { name: 'Grid view', exact: true }).click();
    const responsive = await sampleMotion(page, listing, async () => {
        await button('Expand main sidebar').click();
        await button('Expand tools sidebar').press('Enter');
    });
    verifyMotion(check, responsive, 'App sidebars crossing the narrow Places boundary');
    check(
        'responsive drawer removal retains the outer motion boundary and usable Files content',
        (await page.locator('.files-manager [data-file-drawer="left"]').count()) === 0 &&
            responsive.at(-1)!.width > 300,
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await button('Collapse main sidebar').click();
    await button('Collapse tools sidebar').click();
    await settle(page);
    await page.setViewportSize({ width: 2200, height: 600 });
    await page.evaluate(() => window.filesUiTest.twoPanes());
    await page.waitForFunction(
        () => document.querySelectorAll<HTMLElement>('[role="listbox"]').length === 2,
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const managers = page.locator('.files-manager');
    // Properties visibility is local to a pane; Places deliberately follows a shared preference.
    await managers.nth(1).locator('[data-file-name="README.md"]').click();
    await managers.nth(1).getByRole('button', { name: 'Inspect selection', exact: true }).click();
    const localObservation = await page.waitForFunction(() => {
        const managers = document.querySelectorAll<HTMLElement>('.files-manager');
        return managers[1].querySelector<HTMLElement>('[data-file-layout-moving]')!
            ? {
                  peerMoving: Boolean(
                      managers[0].querySelector<HTMLElement>('[data-file-layout-moving]')!,
                  ),
              }
            : false;
    });
    check(
        'a local Files drawer does not mark its peer pane as moving',
        ((await localObservation.jsonValue()) as { peerMoving: boolean }).peerMoving === false,
    );
    await settle(page);
    await managers.nth(1).getByRole('button', { name: 'Hide properties', exact: true }).click();
    await settle(page);
    await button('Expand main sidebar').click();
    const outerObservation = await page.waitForFunction(
        () =>
            document.querySelectorAll<HTMLElement>('.files-manager [data-file-layout-moving]')
                .length === 2,
    );
    check(
        'outer sidebar motion reaches both retained Files panes',
        await outerObservation.jsonValue(),
    );
    await settle(page);
    await screenshot('files-production-workspace-sidebars');
    check(
        'workspace motion performs no native mutations or Files preference migration',
        await page.evaluate(
            () =>
                window.filesUiTest.calls.every((command) =>
                    ['fs_list', 'fs_cwd', 'fs_permissions_read'].includes(command),
                ) &&
                window.filesUiTest.settingsWrites.every((write) =>
                    Object.keys(write).every((key) =>
                        ['placesCollapsed', 'defaultView'].includes(key),
                    ),
                ),
        ),
    );
}
