import type { Page } from 'playwright-core';

import type { MotionFrame } from './filesGridStability';
import { interruptSidebarWithReducedMotion } from './filesGridStability';
import { focusedFileIsFullyVisible, runFilesGridViewportChecks } from './filesGridViewportChecks';

export interface DrawerMotionFrame extends MotionFrame {
    time: number;
    width: number;
    innerWidth: number;
    opacity: string;
    gap: number;
    contentWidth: number;
    listLayout: string | undefined;
    activeOptionValid: boolean;
    optionMinWidth: number | null;
    tileTrackWidth: number | null;
    viewportWidth: number | null;
    anchorOffset: number | null;
    drawerTiming: { easing: string | undefined; keyframeEasings: string[] } | null;
}

export type SampleToggle = (
    side: string,
    button: string,
    interruptWith?: string,
    anchorName?: string | null,
    waitForColumnChange?: boolean,
) => Promise<DrawerMotionFrame[]>;

/** Exercise real drawer motion and independent scrolling, not just its settled geometry. */
export async function runFilesDrawerChecks({
    page,
    check,
    screenshot,
}: {
    page: Page;
    check: (label: string, value: unknown) => void;
    screenshot: (name: string) => Promise<void>;
}) {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(page.url(), { waitUntil: 'domcontentloaded' });
    const drawer = (side: string) => page.locator(`[data-file-drawer="${side}"]`);
    const listing = page.getByRole('listbox');
    const scroller = listing.locator(':scope > div > [role="presentation"]');
    await page.locator('[data-file-name="README.md"]').waitFor();
    check(
        'Files drawers respect reduced motion',
        await drawer('left').evaluate(
            (el: HTMLElement) => getComputedStyle(el).transitionProperty === 'none',
        ),
    );
    await page.getByRole('button', { name: 'Hide places', exact: true }).click();
    check(
        'a closed drawer consumes no space and is inert without removing its contents',
        await drawer('left').evaluate(
            (el: HTMLElement) =>
                el.getBoundingClientRect().width === 0 &&
                el.inert &&
                el.getAttribute('aria-hidden') === 'true' &&
                el.querySelector<HTMLElement>('[data-file-drawer-content]')!.getBoundingClientRect()
                    .width === 184,
        ),
    );
    await page.getByRole('button', { name: 'Show places', exact: true }).click();
    await page.waitForFunction(() => {
        const drawer = document.querySelector<HTMLElement>('[data-file-drawer="left"]')!;
        return (
            drawer?.clientWidth === 184 &&
            !drawer.inert &&
            getComputedStyle(drawer).transitionProperty === 'none'
        );
    });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    check(
        'Places uses the shared sidebar timing and width-only inline transition',
        await drawer('left').evaluate((el: HTMLElement) => {
            const style = getComputedStyle(el);
            return (
                style.transitionDuration === '0.3s' &&
                style.transitionTimingFunction === 'cubic-bezier(0.2, 0, 0, 1)' &&
                style.transitionProperty === 'width'
            );
        }),
    );

    let recordingSequence = 0;
    const sampleToggle: SampleToggle = async (
        side,
        button,
        interruptWith,
        anchorName,
        waitForColumnChange = false,
    ) => {
        const initialColumns = waitForColumnChange
            ? await listing.evaluate(
                  (el) =>
                      getComputedStyle(
                          el.querySelector<HTMLElement>('[data-file-name]')!.parentElement!
                              .parentElement!,
                      ).gridTemplateColumns,
              )
            : null;
        const recordingId = `${side}-${++recordingSequence}`;
        const samples = drawer(side).evaluate(
            async (el: HTMLElement, { name, recordingId }) => {
                const frames: DrawerMotionFrame[] = [];
                let actionsComplete = false;
                let settledFrames = 0;
                el.addEventListener(
                    'files-test-motion-actions-complete',
                    () => {
                        actionsComplete = true;
                    },
                    { once: true },
                );
                // Observe the actual lifecycle. Starting a fixed recording window before
                // Playwright dispatches both reversal clicks can truncate the transition.
                const until = performance.now() + 10000;
                while (performance.now() < until) {
                    await new Promise<number>((resolve) => requestAnimationFrame(resolve));
                    const box = el.getBoundingClientRect();
                    const inner = el
                        .querySelector<HTMLElement>('[data-file-drawer-content]')!
                        .getBoundingClientRect();
                    const content = el
                        .parentElement!.querySelector<HTMLElement>('.files-content')!
                        .getBoundingClientRect();
                    const scroll = el.parentElement!.querySelector<HTMLElement>(
                        '.files-selection > div > [role="presentation"]',
                    )!;
                    const listbox =
                        el.parentElement!.querySelector<HTMLElement>('[role="listbox"]')!;
                    const activeId = listbox?.getAttribute('aria-activedescendant');
                    const activeOption = activeId ? document.getElementById(activeId)! : null;
                    const firstOption = scroll?.querySelector<HTMLElement>('[data-file-name]')!;
                    const grid = firstOption?.parentElement!.parentElement!;
                    const scrollBounds = scroll?.getBoundingClientRect();
                    const visibleOptions = scroll
                        ? [...scroll.querySelectorAll<HTMLElement>('.files-option')].filter(
                              (option) => {
                                  const bounds = option.getBoundingClientRect();
                                  return (
                                      bounds.bottom > scrollBounds.top &&
                                      bounds.top < scrollBounds.bottom
                                  );
                              },
                          )
                        : [];
                    const activeContentAnimations =
                        scroll
                            ?.getAnimations({ subtree: true })
                            .filter(
                                (animation) =>
                                    animation.playState === 'running' || animation.pending,
                            ) ?? [];
                    const tiles = visibleOptions.map((option) => {
                        const bounds = option.getBoundingClientRect();
                        const transform = new DOMMatrixReadOnly(getComputedStyle(option).transform);
                        return {
                            name: option.dataset.fileName,
                            x: bounds.left - scrollBounds.left,
                            y: bounds.top - scrollBounds.top,
                            width: bounds.width,
                            height: bounds.height,
                            matrix: [
                                transform.a,
                                transform.b,
                                transform.c,
                                transform.d,
                                transform.e,
                                transform.f,
                            ],
                        };
                    });
                    const anchor =
                        name &&
                        el.parentElement!.querySelector<HTMLElement>(
                            `[data-file-name="${CSS.escape(name)}"]`,
                        )!;
                    const drawerAnimations = el
                        .getAnimations()
                        .filter(
                            (animation) => animation.playState === 'running' || animation.pending,
                        );
                    const widthTransition = drawerAnimations.find(
                        (animation) =>
                            'transitionProperty' in animation &&
                            animation.transitionProperty === 'width',
                    )!;
                    frames.push({
                        time: performance.now(),
                        width: box.width,
                        innerWidth: inner.width,
                        opacity: getComputedStyle(el).opacity,
                        gap:
                            el.dataset.fileDrawer === 'left'
                                ? content.left - box.right
                                : box.left - content.right,
                        contentWidth: content.width,
                        scrollTop: scroll?.scrollTop,
                        listLayout:
                            el.parentElement!.querySelector<HTMLElement>('[data-file-list-layout]')
                                ?.dataset.fileListLayout,
                        activeOptionValid:
                            !activeId || Boolean(activeOption && listbox.contains(activeOption)),
                        moving: el.parentElement!.hasAttribute('data-file-layout-moving'),
                        columns: grid
                            ? getComputedStyle(grid).gridTemplateColumns.split(' ').length
                            : null,
                        optionMinWidth: visibleOptions.length
                            ? Math.min(
                                  ...visibleOptions.map(
                                      (option) => option.getBoundingClientRect().width,
                                  ),
                              )
                            : null,
                        tileTrackWidth:
                            firstOption?.parentElement!.getBoundingClientRect().width ?? null,
                        viewportWidth: scroll?.clientWidth ?? null,
                        tiles,
                        contentAnimations: activeContentAnimations.length,
                        drawerTiming: widthTransition
                            ? {
                                  easing: widthTransition.effect!.getTiming().easing,
                                  keyframeEasings: (widthTransition.effect as KeyframeEffect)
                                      .getKeyframes()
                                      .map((frame) => frame.easing),
                              }
                            : null,
                        anchorOffset:
                            anchor && scroll
                                ? anchor.getBoundingClientRect().top -
                                  scroll.getBoundingClientRect().top
                                : null,
                    });
                    if (frames.length === 1) {
                        el.dataset.filesTestMotionReady = recordingId;
                    }
                    const animating = drawerAnimations.length > 0;
                    if (
                        actionsComplete &&
                        !animating &&
                        activeContentAnimations.length === 0 &&
                        !frames.at(-1)!.moving
                    ) {
                        settledFrames++;
                    } else {
                        settledFrames = 0;
                    }
                    if (settledFrames >= 2) {
                        break;
                    }
                }
                if (el.dataset.filesTestMotionReady === recordingId) {
                    delete el.dataset.filesTestMotionReady;
                }
                return frames;
            },
            { name: anchorName, recordingId },
        );
        await page.waitForFunction(
            ({ side, recordingId }) =>
                document.querySelector<HTMLElement>(`[data-file-drawer="${side}"]`)?.dataset
                    .filesTestMotionReady === recordingId,
            { side, recordingId },
        );
        await page.getByRole('button', { name: button, exact: true }).click();
        if (interruptWith) {
            await page.waitForFunction((side) => {
                const el = document.querySelector<HTMLElement>(`[data-file-drawer="${side}"]`)!;
                const width = el.getBoundingClientRect().width;
                return (
                    width > 2 &&
                    width <
                        parseFloat(
                            el.querySelector<HTMLElement>('[data-file-drawer-content]')!.style
                                .width,
                        ) -
                            2
                );
            }, side);
            if (waitForColumnChange) {
                await page.waitForFunction(
                    ({ side, initialColumns }) => {
                        const option = document
                            .querySelector<HTMLElement>(`[data-file-drawer="${side}"]`)
                            ?.parentElement!.querySelector<HTMLElement>('[data-file-name]')!;
                        return (
                            option &&
                            getComputedStyle(option.parentElement!.parentElement!)
                                .gridTemplateColumns !== initialColumns
                        );
                    },
                    { side, initialColumns },
                );
            }
            // Keyboard activation reverses the width motion before it settles.
            await page.getByRole('button', { name: interruptWith, exact: true }).press('Enter');
        }
        await drawer(side).evaluate((el) =>
            el.dispatchEvent(new Event('files-test-motion-actions-complete')),
        );
        return samples;
    };
    const checkMotion = (frames: DrawerMotionFrame[], width: number, label: string) => {
        const compactFrames = frames
            .filter(
                (_, index) =>
                    index === 0 ||
                    index === frames.length - 1 ||
                    index % Math.max(1, Math.ceil(frames.length / 12)) === 0,
            )
            .map((frame) => ({
                ms: Math.round(frame.time - frames[0].time),
                width: Number(frame.width.toFixed(2)),
                innerWidth: Number(frame.innerWidth.toFixed(2)),
                opacity: frame.opacity,
                moving: frame.moving,
            }));
        const diagnostics = (passes: boolean) =>
            passes ? '' : ` (${JSON.stringify(compactFrames)})`;
        const smoothShell =
            frames.some((frame) => frame.width > 2 && frame.width < width - 2) &&
            frames.every(
                (frame) => Math.abs(frame.innerWidth - width) < 1 && frame.opacity === '1',
            );
        check(
            `${label}: the shell animates without squeezing or instantly hiding its contents${diagnostics(smoothShell)}`,
            smoothShell,
        );
        const followsEdge = frames.every(
            (frame) => Math.abs(frame.gap) < 1 && frame.contentWidth > 0,
        );
        check(
            `${label}: the file area follows the actual drawer edge throughout the transition${diagnostics(followsEdge)}`,
            followsEdge,
        );
        const coordinated = frames.some((frame) => frame.moving) && frames.at(-1)!.moving === false;
        check(
            `${label}: layout coordination starts during motion and releases afterward${diagnostics(coordinated)}`,
            coordinated,
        );
    };
    const closing = await sampleToggle('left', 'Hide places');
    if (process.env.ZYNC_FILES_MOTION_DIAGNOSTICS === '1') {
        console.log(
            `  drawer timing ${JSON.stringify(closing.find((frame) => frame.drawerTiming)?.drawerTiming ?? null)}`,
        );
    }
    checkMotion(closing, 184, 'Places closing');
    check(
        'closing Places fully releases its width',
        await drawer('left').evaluate((el: HTMLElement) => el.clientWidth === 0),
    );
    const opening = await sampleToggle('left', 'Show places');
    checkMotion(opening, 184, 'Places opening');
    const reversed = await sampleToggle('left', 'Hide places', 'Show places');
    checkMotion(reversed, 184, 'Reversed Places motion');
    check(
        'rapid reversal leaves Places open and interactive',
        await drawer('left').evaluate(
            (el: HTMLElement) =>
                el.clientWidth === 184 && !el.inert && el.getAttribute('aria-hidden') === 'false',
        ),
    );

    await interruptSidebarWithReducedMotion(
        page,
        drawer('left'),
        page.getByRole('button', { name: 'Hide places', exact: true }),
    );
    await page.locator('[data-file-layout-moving]').waitFor({ state: 'detached' });
    check(
        'enabling reduced motion during a transition releases layout coordination and settles the drawer',
        await drawer('left').evaluate(
            (el: HTMLElement) =>
                el.clientWidth === 0 &&
                el.inert &&
                getComputedStyle(el).transitionProperty === 'none',
        ),
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    checkMotion(
        await sampleToggle('left', 'Show places'),
        184,
        'Places after reduced-motion cancellation',
    );

    await page.getByRole('button', { name: 'Hide places', exact: true }).click();
    await page.locator('[data-file-layout-moving]').waitFor();
    await page.setViewportSize({ width: 640, height: 600 });
    await drawer('left').waitFor({ state: 'detached' });
    await page.locator('[data-file-layout-moving]').waitFor({ state: 'detached' });
    check(
        'unmounting an animated Places drawer releases its layout owner',
        (await page.getByRole('button', { name: 'Show places', exact: true }).isVisible()) &&
            (await listing.evaluate((el) => el.clientWidth > 0)),
    );
    await page.setViewportSize({ width: 1200, height: 800 });
    await drawer('left').waitFor({ state: 'attached' });
    checkMotion(await sampleToggle('left', 'Show places'), 184, 'Places after responsive unmount');

    await page.locator('[data-file-name="README.md"]').click();
    const inspectorOpening = await sampleToggle('right', 'Inspect selection');
    checkMotion(inspectorOpening, 320, 'Properties opening');
    const inspectorClosing = await sampleToggle('right', 'Hide properties');
    checkMotion(inspectorClosing, 320, 'Properties closing');
    check(
        'closing the inspector preserves its existing focus return',
        await page
            .getByRole('button', { name: 'Inspect selection', exact: true })
            .evaluate((el) => el === document.activeElement),
    );

    await page.evaluate(() => window.filesUiTest.manyFiles());
    await listing.focus();
    await page.keyboard.press('Home');
    await scroller.hover();
    await page.mouse.wheel(0, 1800);
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLElement>('.files-selection > div > [role="presentation"]')!
                .scrollTop > 1000,
    );
    const listTop = await scroller.evaluate((el) => el.scrollTop);
    const listClosing = await sampleToggle('left', 'Hide places');
    const listOpening = await sampleToggle('left', 'Show places');
    check(
        'Places reflow never scrolls a long list back to its old focused row',
        [...listClosing, ...listOpening].every((frame) => Math.abs(frame.scrollTop! - listTop) < 1),
    );
    await listing.focus();
    await page.keyboard.press('Home');
    check(
        'Home reveals an already-focused first list row after manual scrolling',
        (await focusedFileIsFullyVisible(listing)) &&
            (await listing.evaluate(
                (el) =>
                    document.getElementById(el.getAttribute('aria-activedescendant')!)?.dataset
                        .fileName === 'file-0000.ts',
            )),
    );
    await page.keyboard.press('ArrowDown');
    check(
        'keyboard navigation fully reveals the newly focused list row',
        await focusedFileIsFullyVisible(listing),
    );

    await page.setViewportSize({ width: 684, height: 600 });
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLElement>('[data-file-list-layout]')?.dataset
                .fileListLayout === 'size',
    );
    for (const [button, tier] of [
        ['Hide places', 'modified'],
        ['Show places', 'size'],
    ]) {
        const frames = await sampleToggle('left', button);
        const changes = frames.filter(
            (frame, index) => index > 0 && frame.listLayout !== frames[index - 1].listLayout,
        );
        check(
            `684px list ${button.toLowerCase()} commits metadata layout at most once`,
            changes.length <= 1,
        );
        check(
            `684px list ${button.toLowerCase()} finishes in the correct responsive tier`,
            (await page
                .locator('[data-file-list-layout]')
                .getAttribute('data-file-list-layout')) === tier &&
                (await page
                    .locator('.files-list-column-modified')
                    .first()
                    .evaluate(
                        (el, visible) => (getComputedStyle(el).display !== 'none') === visible,
                        tier === 'modified',
                    )),
        );
    }
    await runFilesGridViewportChecks({ page, check, sampleToggle });

    await page.setViewportSize({ width: 800, height: 600 });
    await listing.focus();
    await page.keyboard.press('Home');
    await page.locator('[data-file-name="file-0000.ts"]').click();
    const propertiesDialog = page.getByRole('dialog', { name: 'Properties', exact: true });
    for (const placesOpen of [true, false]) {
        if (!placesOpen) {
            await sampleToggle('left', 'Hide places');
        }
        await page.getByRole('button', { name: 'Inspect selection', exact: true }).click();
        await propertiesDialog.waitFor();
        check(
            `800px pane uses modal Properties with Places ${placesOpen ? 'open' : 'closed'}`,
            (await propertiesDialog.isVisible()) && (await drawer('right').count()) === 0,
        );
        await page.keyboard.press('Escape');
        await propertiesDialog.waitFor({ state: 'detached' });
    }
    await sampleToggle('left', 'Show places');
    await page.setViewportSize({ width: 904, height: 600 });
    await page.getByRole('button', { name: 'Inspect selection', exact: true }).click();
    await page.getByRole('complementary', { name: 'File properties', exact: true }).waitFor();
    await page.waitForFunction(
        () =>
            document.querySelector<HTMLElement>('[data-file-drawer="right"]')!.clientWidth === 320,
    );
    for (const button of ['Hide places', 'Show places']) {
        await sampleToggle('left', button);
        check(
            `904px pane retains inline Properties after ${button.toLowerCase()}`,
            (await propertiesDialog.count()) === 0 &&
                (await drawer('right').evaluate((el: HTMLElement) => el.clientWidth === 320)) &&
                (await page.locator('.files-content').evaluate((el) => el.clientWidth >= 400)),
        );
    }
    await page.getByRole('button', { name: 'Hide properties', exact: true }).click();
    await page.waitForFunction(
        () => document.querySelector<HTMLElement>('[data-file-drawer="right"]')!.clientWidth === 0,
    );

    await page.evaluate(() =>
        window.filesUiTest.preference({
            bookmarksByConnection: {
                'files-ui-fixture': Array.from(
                    { length: 40 },
                    (_, i) => `/home/deploy/pinned-${i}`,
                ),
            },
        }),
    );
    await page.setViewportSize({ width: 1200, height: 420 });
    const locations = page.getByRole('navigation', { name: 'File locations', exact: true });
    check(
        'Places owns a bounded scroll surface with stable scrollbar space',
        await locations.evaluate(
            (el) =>
                el.scrollHeight > el.clientHeight &&
                getComputedStyle(el).overscrollBehaviorY === 'contain' &&
                getComputedStyle(el).scrollbarGutter === 'stable',
        ),
    );
    const before = await scroller.evaluate((el) => ({ top: el.scrollTop, width: el.clientWidth }));
    const headerTop = await page
        .getByRole('complementary', { name: 'File places', exact: true })
        .getByRole('heading', { name: 'Places', exact: true })
        .evaluate((el) => el.getBoundingClientRect().top);
    await locations.hover();
    await page.mouse.wheel(0, 600);
    await page.waitForFunction(
        () => document.querySelector<HTMLElement>('[aria-label="File locations"]')!.scrollTop > 0,
    );
    check(
        'scrolling Places leaves the file viewport and fixed Places header unchanged',
        (await scroller.evaluate(
            (el, before) => el.scrollTop === before.top && el.clientWidth === before.width,
            before,
        )) &&
            (await page
                .getByRole('heading', { name: 'Places', exact: true })
                .evaluate((el, top) => el.getBoundingClientRect().top === top, headerTop)),
    );
    await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => {
        const el = document.querySelector<HTMLElement>('[aria-label="File locations"]')!;
        return el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    });
    await page.mouse.wheel(0, 1000);
    check(
        'wheel input at a Places boundary cannot scroll the Files shell or page',
        await page
            .locator('.files-manager')
            .evaluate(
                (el) =>
                    el.scrollTop === 0 &&
                    el.scrollHeight <= el.clientHeight &&
                    document.scrollingElement!.scrollTop === 0,
            ),
    );
    await screenshot('files-production-places-scroll');
    check(
        'motion and scrolling create no native file mutations or unrelated preference writes',
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
}
