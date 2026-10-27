import type { Locator, Page } from 'playwright-core';

export interface MotionTile {
    name: string | undefined;
    x: number;
    y: number;
    width: number;
    height: number;
    matrix: number[];
}

export interface MotionFrame {
    columns: number | null;
    scrollTop: number | undefined;
    contentAnimations: number;
    tiles: MotionTile[];
    moving: boolean;
}
/** Sidebar motion may resize the viewport, but file entries must never animate independently. */
export function tilesHaveNoAnimation(frames: MotionFrame[]) {
    return frames.every(
        (frame) =>
            frame.contentAnimations === 0 &&
            frame.tiles.every((tile) => {
                const [a, b, c, d, x, y] = tile.matrix;
                return (
                    Math.abs(a - 1) < 0.001 &&
                    Math.abs(b) < 0.001 &&
                    Math.abs(c) < 0.001 &&
                    Math.abs(d - 1) < 0.001 &&
                    Math.abs(x) < 0.5 &&
                    Math.abs(y) < 0.5
                );
            }),
    );
}

/** Compare identities in viewport coordinates, excluding genuine wraps and user scrolling. */
export function tracksStayStill(frames: MotionFrame[]) {
    let comparisons = 0;
    for (let index = 1; index < frames.length; index++) {
        const previous = frames[index - 1],
            current = frames[index];
        if (
            previous.columns !== current.columns ||
            Math.abs(previous.scrollTop! - current.scrollTop!) > 0.5
        ) {
            continue;
        }
        const before = new Map(previous.tiles.map((tile) => [tile.name, tile]));
        for (const tile of current.tiles) {
            const prior = before.get(tile.name);
            if (!prior) {
                continue;
            }
            comparisons++;
            if (
                (['x', 'y', 'width', 'height'] as const).some(
                    (key) => Math.abs(prior[key] - tile[key]) > 0.75,
                )
            ) {
                return false;
            }
        }
    }
    return comparisons > 0;
}

/** Slow only the native test clock so a media-change interruption cannot miss a short transition. */
export async function interruptSidebarWithReducedMotion(
    page: Page,
    drawer: Locator,
    trigger: Locator,
) {
    await drawer.evaluate((el: HTMLElement) => {
        const hold = (event: TransitionEvent) => {
            if (event.target !== el || event.propertyName !== 'width') {
                return;
            }
            el.removeEventListener('transitionrun', hold);
            const animation = el
                .getAnimations()
                .find(
                    (animation) =>
                        'transitionProperty' in animation &&
                        animation.transitionProperty === 'width',
                )!;
            if (!animation) {
                return;
            }
            animation.updatePlaybackRate(0.01);
            animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
            el.dataset.filesTestMotionHeld = 'true';
        };
        el.addEventListener('transitionrun', hold);
    });
    await trigger.press('Enter');
    await page.waitForFunction(() =>
        Boolean(document.querySelector<HTMLElement>('[data-files-test-motion-held]')!),
    );
    const observed = await drawer.evaluate((el) => ({
        running: el
            .getAnimations()
            .some(
                (animation) =>
                    'transitionProperty' in animation &&
                    animation.transitionProperty === 'width' &&
                    animation.playState === 'running',
            ),
        owned: Boolean(document.querySelector<HTMLElement>('[data-file-layout-moving]')!),
    }));
    if (!observed.running || !observed.owned) {
        throw new Error(
            `Expected an owned native transition before reduced motion: ${JSON.stringify(observed)}`,
        );
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await drawer.evaluate((el) => {
        delete el.dataset.filesTestMotionHeld;
    });
}
