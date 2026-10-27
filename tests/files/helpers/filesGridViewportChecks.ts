import type { Locator, Page } from 'playwright-core';

import type { DrawerMotionFrame, SampleToggle } from './filesDrawerChecks';
import {
    interruptSidebarWithReducedMotion,
    tilesHaveNoAnimation,
    tracksStayStill,
} from './filesGridStability';

type GridCheckOptions = {
    page: Page;
    check: (label: string, value: unknown) => void;
    sampleToggle: SampleToggle;
};

/** Read what the user is viewing, including the identity that must survive reflow. */
function readViewport(listing: Element, anchorName?: string | null) {
    const scroller = listing.querySelector<HTMLElement>(':scope > div > [role="presentation"]')!;
    const viewport = scroller.getBoundingClientRect();
    const options = [...listing.querySelectorAll<HTMLElement>('[data-file-name]')];
    const visible = options.filter((option) => {
        const bounds = option.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
    });
    const anchor = anchorName
        ? options.find((option) => option.dataset.fileName === anchorName)!
        : visible[0];
    const bounds = anchor?.getBoundingClientRect();
    const firstTop = options[0]?.getBoundingClientRect().top;
    return {
        name: anchor?.dataset.fileName ?? null,
        offset: bounds ? bounds.top - viewport.top : null,
        visible: Boolean(bounds && bounds.bottom > viewport.top && bounds.top < viewport.bottom),
        columns: options.filter(
            (option) => Math.abs(option.getBoundingClientRect().top - firstTop) < 1,
        ).length,
        scrollTop: scroller.scrollTop,
        maxScroll: scroller.scrollHeight - scroller.clientHeight,
    };
}

/** A focus target below the viewport must not pass merely because its top is positive. */
export async function focusedFileIsFullyVisible(listing: Locator) {
    return listing.evaluate((el) => {
        const option = document.getElementById(el.getAttribute('aria-activedescendant')!)!;
        const scroller = el.querySelector<HTMLElement>(':scope > div > [role="presentation"]')!;
        if (!option || !el.contains(option) || !scroller) {
            return false;
        }
        const bounds = option.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        return (
            bounds.top >= viewport.top - 1 &&
            bounds.bottom <= viewport.bottom + 1 &&
            bounds.left >= viewport.left - 1 &&
            bounds.right <= viewport.right + 1
        );
    });
}

/** Require direct wrapping and stable file positions between real column boundaries. */
async function runGridMotionChecks({
    page,
    check,
    sampleToggle,
    listing,
}: GridCheckOptions & { listing: Locator }) {
    await page.setViewportSize({ width: 1200, height: 600 });
    const verifyMotion = (
        frames: DrawerMotionFrame[],
        label: string,
        beforeColumns: number,
        afterColumns: number,
        reversal = false,
    ) => {
        const earlyReflow = frames.some((frame) => frame.moving && frame.columns !== beforeColumns);
        const columns = frames.map((frame) => frame.columns!);
        const changes = columns.filter(
            (column, index) => index > 0 && column !== columns[index - 1],
        ).length;
        const expectedChanges = reversal
            ? 2 * (Math.max(...columns) - Math.min(...columns))
            : Math.abs(afterColumns - beforeColumns);
        check(
            `${label}: columns change during drawer motion without oscillating`,
            earlyReflow && changes <= expectedChanges,
        );
        check(
            `${label}: file entries have no independent animation or transform`,
            tilesHaveNoAnimation(frames),
        );
        check(
            `${label}: tile widths and positions stay fixed between column changes`,
            tracksStayStill(frames),
        );
        check(
            `${label}: layout coordination releases after the sidebar settles`,
            frames.at(-1)!.moving === false,
        );
    };

    for (const count of [31, 1000]) {
        await page.evaluate((count) => window.filesUiTest.manyFiles(count), count);
        await page.waitForFunction(
            (count) =>
                document
                    .querySelector<HTMLElement>('[role="listbox"] [aria-setsize]')
                    ?.getAttribute('aria-setsize') === String(count),
            count,
        );
        await listing.focus();
        await page.keyboard.press('Home');
        for (const button of ['Hide places', 'Show places']) {
            const before = await listing.evaluate(readViewport);
            const frames = await sampleToggle('left', button);
            const after = await listing.evaluate(readViewport);
            verifyMotion(
                frames,
                `${count}-file grid ${button.toLowerCase()}`,
                before.columns,
                after.columns,
            );
        }
        const before = await listing.evaluate(readViewport);
        const reversed = await sampleToggle('left', 'Hide places', 'Show places', undefined, true);
        const after = await listing.evaluate(readViewport);
        verifyMotion(reversed, `${count}-file grid reversal`, before.columns, after.columns, true);
        check(
            `${count}-file grid reversal returns to its original column layout`,
            before.columns === after.columns,
        );

        await interruptSidebarWithReducedMotion(
            page,
            page.locator('[data-file-drawer="left"]'),
            page.getByRole('button', { name: 'Hide places', exact: true }),
        );
        const canceledMotion = await listing.evaluate(async (el) => {
            // Media preference changes must settle on the next paint, not after the old duration.
            await new Promise<number>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
            const running = el
                .getAnimations({ subtree: true })
                .filter((animation) => animation.playState === 'running' || animation.pending);
            const cleanTransforms = [...el.querySelectorAll<HTMLElement>('[data-file-name]')].every(
                (option) => {
                    const matrix = new DOMMatrixReadOnly(getComputedStyle(option).transform);
                    return matrix.isIdentity;
                },
            );
            const manager = el.closest<HTMLElement>('.files-manager')!;
            const drawer = manager.querySelector<HTMLElement>('[data-file-drawer="left"]')!;
            return {
                activeAnimations: running.length,
                cleanTransforms,
                layoutMoving: Boolean(
                    manager.querySelector<HTMLElement>('[data-file-layout-moving]')!,
                ),
                drawerWidth: drawer.clientWidth,
            };
        });
        const promptlyCanceled =
            canceledMotion.activeAnimations === 0 &&
            canceledMotion.cleanTransforms &&
            !canceledMotion.layoutMoving &&
            canceledMotion.drawerWidth === 0;
        check(
            `${count}-file grid stays unanimated when reduced motion interrupts the sidebar${promptlyCanceled ? '' : ` (${JSON.stringify(canceledMotion)})`}`,
            promptlyCanceled,
        );
        await sampleToggle('left', 'Show places');

        for (const button of ['Hide places', 'Show places']) {
            const before = await listing.evaluate(readViewport);
            const frames = await sampleToggle('left', button);
            const after = await listing.evaluate(readViewport);
            check(
                `${count}-file reduced-motion grid ${button.toLowerCase()} updates without file animations`,
                before.columns !== after.columns && tilesHaveNoAnimation(frames),
            );
        }
        await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
}

/** Exercise both grid renderers, their boundary, and folders requiring real scrolling. */
export async function runFilesGridViewportChecks({ page, check, sampleToggle }: GridCheckOptions) {
    const listing = page.getByRole('listbox');
    const scroller = listing.locator(':scope > div > [role="presentation"]');
    await page.setViewportSize({ width: 1200, height: 320 });
    await page.getByRole('button', { name: 'View', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Grid view', exact: true }).click();
    await runGridMotionChecks({ page, check, sampleToggle, listing });
    await page.setViewportSize({ width: 1200, height: 320 });

    const setScroll = async (position: string) => {
        await scroller.evaluate(async (el, where) => {
            const maximum = el.scrollHeight - el.clientHeight;
            el.scrollTop = where === 'end' ? maximum : Math.floor(maximum / 2);
            // Let scroll-driven virtualization commit before choosing a visible anchor.
            await new Promise<number>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(resolve)),
            );
        }, position);
    };
    const assertAnchor = async (count: number, label: string, allowClamp = false) => {
        const before = await listing.evaluate(readViewport);
        check(
            `${count}-file ${label}: a scrolled visible file is available to anchor`,
            before.visible && before.scrollTop > 0,
        );
        const frames = await sampleToggle(
            'left',
            label.includes('closing') ? 'Hide places' : 'Show places',
            undefined,
            before.name,
        );
        const after = await listing.evaluate(readViewport, before.name);
        const requestedTop = after.scrollTop + (after.offset! - before.offset!);
        const clampedTop = Math.min(after.maxScroll, Math.max(0, requestedTop));
        const offsetPreserved = Math.abs(after.offset! - before.offset!) <= 2;
        const constrainedByViewport =
            allowClamp &&
            Math.abs(after.scrollTop - clampedTop) <= 2 &&
            Math.abs(requestedTop - clampedTop) > 2;
        const anchored =
            before.columns !== after.columns &&
            after.name === before.name &&
            after.visible &&
            (offsetPreserved || constrainedByViewport);
        const diagnostics = anchored
            ? ''
            : ` (${JSON.stringify({ before, after, frames: frames.slice(0, 20).map(({ width, moving, anchorOffset, columns, optionMinWidth }) => ({ width, moving, anchorOffset, columns, optionMinWidth })) })})`;
        check(
            `${count}-file ${label}: column reflow keeps the viewed file and vertical offset${diagnostics}`,
            anchored,
        );
        check(
            `${count}-file ${label}: an active descendant always references a mounted file`,
            frames.every((frame) => frame.activeOptionValid),
        );
    };

    for (const count of [31, 96, 97, 1000]) {
        await page.evaluate((count) => window.filesUiTest.manyFiles(count), count);
        await page.waitForFunction(
            (count) =>
                document
                    .querySelector<HTMLElement>('[role="listbox"] [aria-setsize]')
                    ?.getAttribute('aria-setsize') === String(count),
            count,
        );
        await listing.focus();
        await page.keyboard.press('Home');
        await setScroll('middle');
        await assertAnchor(count, 'middle closing');
        await assertAnchor(count, 'middle opening');
        await listing.focus();
        await page.keyboard.press('Home');
        check(
            `${count}-file grid: Home reveals the same focused file after manual scrolling`,
            (await focusedFileIsFullyVisible(listing)) &&
                (await listing.evaluate(
                    (el) =>
                        document.getElementById(el.getAttribute('aria-activedescendant')!)?.dataset
                            .fileName === 'file-0000.ts',
                )),
        );
        await page.keyboard.press('ArrowDown');
        check(
            `${count}-file grid: keyboard navigation fully reveals its focused option after reflow`,
            await focusedFileIsFullyVisible(listing),
        );

        await setScroll('end');
        await assertAnchor(count, 'end closing', true);
        await assertAnchor(count, 'end opening', true);
    }

    await listing.focus();
    await page.keyboard.press('End');
    check(
        'virtual grid End reveals the final file before changing view',
        (await focusedFileIsFullyVisible(listing)) &&
            (await listing.evaluate(
                (el) =>
                    document.getElementById(el.getAttribute('aria-activedescendant')!)?.dataset
                        .fileName === 'file-0999.ts',
            )),
    );
    for (let revisit = 1; revisit <= 2; revisit++) {
        for (const mode of ['List', 'Grid']) {
            await page.getByRole('button', { name: 'View', exact: true }).click();
            await page.getByRole('menuitemradio', { name: `${mode} view`, exact: true }).click();
            await listing.evaluate(
                () =>
                    new Promise<number>((resolve) =>
                        requestAnimationFrame(() => requestAnimationFrame(resolve)),
                    ),
            );
            check(
                `${mode} view revisit ${revisit} reveals the focused final file without another keypress`,
                (await focusedFileIsFullyVisible(listing)) &&
                    (await listing.evaluate(
                        (el) =>
                            document.getElementById(el.getAttribute('aria-activedescendant')!)
                                ?.dataset.fileName === 'file-0999.ts',
                    )),
            );
        }
    }

    await page.evaluate(() => window.filesUiTest.manyFiles(97));
    await page.waitForFunction(
        () =>
            document
                .querySelector<HTMLElement>('[role="listbox"] [aria-setsize]')
                ?.getAttribute('aria-setsize') === '97',
    );
    await listing.focus();
    await page.keyboard.press('Home');
    await setScroll('middle');
    for (const count of [96, 97]) {
        const before = await listing.evaluate(readViewport);
        await page.evaluate((count) => window.filesUiTest.manyFiles(count), count);
        await page.waitForFunction(
            (count) =>
                document
                    .querySelector<HTMLElement>('[role="listbox"] [aria-setsize]')
                    ?.getAttribute('aria-setsize') === String(count),
            count,
        );
        await scroller.evaluate(
            () =>
                new Promise<number>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(resolve)),
                ),
        );
        const after = await listing.evaluate(readViewport, before.name);
        const rendered = await listing.locator('[data-file-name]').count();
        const anchorPreserved =
            after.name === before.name &&
            after.visible &&
            Math.abs(after.offset! - before.offset!) <= 2 &&
            (count === 96 ? rendered === count : rendered < count);
        const diagnostics = anchorPreserved
            ? ''
            : ` (${JSON.stringify({ before, after, rendered })})`;
        check(
            `changing to ${count} files preserves the visible anchor across the grid renderer boundary${diagnostics}`,
            anchorPreserved,
        );
        check(
            `changing to ${count} files leaves no stale active descendant`,
            await listing.evaluate((el) => {
                const id = el.getAttribute('aria-activedescendant');
                return !id || el.contains(document.getElementById(id)!);
            }),
        );
    }

    await listing.focus();
    await page.keyboard.press('Home');
    await setScroll('middle');
    for (const [count, button] of [
        [96, 'Hide places'],
        [97, 'Show places'],
    ] as const) {
        const before = await listing.evaluate(readViewport);
        const motion = sampleToggle('left', button, undefined, before.name);
        await page.locator('[data-file-layout-moving]').waitFor();
        await page.evaluate((count) => window.filesUiTest.manyFiles(count), count);
        const frames = await motion;
        const after = await listing.evaluate(readViewport, before.name);
        const anchorPreserved =
            after.name === before.name &&
            after.visible &&
            Math.abs(after.offset! - before.offset!) <= 2;
        const diagnostics = anchorPreserved
            ? ''
            : ` (${JSON.stringify({ before, after, frames: frames.slice(0, 20).map(({ width, moving, anchorOffset }) => ({ width, moving, anchorOffset })) })})`;
        check(
            `changing to ${count} files during Places motion retains its existing visible anchor${diagnostics}`,
            anchorPreserved,
        );
        check(
            `changing to ${count} files during Places motion releases layout coordination`,
            frames.some((frame) => frame.moving) && frames.at(-1)!.moving === false,
        );
    }

    await page.setViewportSize({ width: 1200, height: 600 });
    await page.evaluate(() => window.filesUiTest.preference({ gridZoom: 4 }));
    for (const count of [31, 1000]) {
        await page.evaluate((count) => window.filesUiTest.manyFiles(count), count);
        await page.waitForFunction(
            (count) =>
                document
                    .querySelector<HTMLElement>('[role="listbox"] [aria-setsize]')
                    ?.getAttribute('aria-setsize') === String(count),
            count,
        );
        await listing.focus();
        await page.keyboard.press('Home');
        for (const button of ['Hide places', 'Show places']) {
            const frames = await sampleToggle('left', button);
            check(
                `${count}-file large-icon grid ${button.toLowerCase()} keeps tile tracks wide enough for its artwork`,
                frames.some((frame) => frame.width > 2 && frame.width < 182) &&
                    frames.every(
                        (frame) => frame.tileTrackWidth! >= Math.min(256, frame.viewportWidth!) - 1,
                    ),
            );
            check(
                `${count}-file large-icon grid ${button.toLowerCase()} keeps active descendants mounted`,
                frames.every((frame) => frame.activeOptionValid),
            );
        }
    }
    await page.evaluate(() => window.filesUiTest.preference({ gridZoom: 1 }));
}
