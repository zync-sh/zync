import type { Locator, Page } from 'playwright-core';
/** Exercise native focus-visible inheritance through the real path editor and portaled dialogs. */
export async function runFilesFocusChecks({
    page,
    check,
}: {
    page: Page;
    check: (label: string, value: unknown) => void;
}) {
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(page.url().split('?')[0], { waitUntil: 'domcontentloaded' });
    const listing = page.getByRole('listbox');
    const file = page.locator('[data-file-name="README.md"]');
    const edit = page.getByRole('button', { name: 'Edit location', exact: true });
    const current = page.locator('[data-file-path-current]');
    const quietListing = () =>
        listing.evaluate(
            (el) =>
                getComputedStyle(el).boxShadow === 'none' &&
                [...el.querySelectorAll<HTMLElement>('[data-focused]')].every(
                    (option) => !getComputedStyle(option).boxShadow.includes('0px 0px 0px 2px'),
                ),
        );
    const hasControlRing = (control: Locator) =>
        control.evaluate(
            (el) => el.matches(':focus-visible') && getComputedStyle(el).boxShadow.includes('1px'),
        );
    await file.waitFor();

    await page.keyboard.press('Escape');
    await page.waitForFunction(
        () =>
            !document
                .querySelector<HTMLElement>('.files-selection')
                ?.hasAttribute('aria-activedescendant'),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('zync:files-panel-show')));
    await page.keyboard.press('Control+v');
    check(
        'Paste without a focused file does not manufacture a full-listing keyboard ring',
        await listing.evaluate(
            (el) =>
                el === document.activeElement &&
                !el.hasAttribute('aria-activedescendant') &&
                getComputedStyle(el).boxShadow === 'none',
        ),
    );
    await page.keyboard.press('Control+c');
    check('Copy without a focused file keeps the listing quiet', await quietListing());

    await edit.click();
    await page.getByRole('button', { name: 'Cancel path edit', exact: true }).click();
    check(
        'pointer path cancellation restores a reachable breadcrumb without inheriting the text-input ring',
        (await current.evaluate((el) => el === document.activeElement)) &&
            !(await hasControlRing(current)),
    );

    await edit.click();
    await page.keyboard.press('Escape');
    check(
        'keyboard path cancellation retains its compact focus indicator',
        await hasControlRing(current),
    );
    await edit.click();
    await page.keyboard.press('Enter');
    check(
        'keyboard path submission keeps the editor action visibly focused',
        await hasControlRing(edit),
    );

    for (let attempt = 0; attempt < 2; attempt++) {
        await file.click();
        await file.click({ button: 'right' });
        await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
        const input = page.getByRole('textbox', { name: 'New Name', exact: true });
        await input.waitFor();
        await input.press('End');
        await input.pressSequentially('-draft');
        await page.keyboard.press('Escape');
        await page
            .getByRole('dialog', { name: 'Rename', exact: true })
            .waitFor({ state: 'detached' });
        const diagnostic = await listing.evaluate((el) => ({
            focused: el === document.activeElement,
            owner: document.activeElement?.outerHTML.slice(0, 180),
            quiet: Boolean(el.closest<HTMLElement>('[data-files-quiet-focus]')!),
            visible: el.matches(':focus-visible'),
            shadow: getComputedStyle(el).boxShadow,
            rowShadows: [...el.querySelectorAll<HTMLElement>('[data-focused]')].map(
                (option) => getComputedStyle(option).boxShadow,
            ),
        }));
        const restoredQuietly =
            (await listing.evaluate((el) => el === document.activeElement)) &&
            (await quietListing());
        check(
            `pointer-opened Rename dismissal ${attempt + 1} restores listing focus without an automatic ring${restoredQuietly ? '' : ` (${JSON.stringify(diagnostic)})`}`,
            restoredQuietly,
        );
    }

    await file.click();
    await file.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'New Name', exact: true }).press('End');
    await page.evaluate(() => window.filesUiTest.breadcrumbPath('/home/deploy/loading'));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Rename', exact: true }).waitFor({ state: 'detached' });
    const empty = page.getByRole('region', { name: 'Files in loading', exact: true });
    check(
        'dismissal while the listing is empty does not draw a full-area focus ring',
        await empty.evaluate(
            (el) => el === document.activeElement && getComputedStyle(el).boxShadow === 'none',
        ),
    );
    await page.evaluate(() => window.filesUiTest.restore());
    await file.waitFor();

    await listing.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'New Name', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: 'Rename', exact: true }).waitFor({ state: 'detached' });
    check(
        'keyboard-opened Rename dismissal preserves visible row focus',
        await listing.evaluate((el) => {
            const option = document.getElementById(el.getAttribute('aria-activedescendant')!)!;
            return (
                document.activeElement === el &&
                option &&
                getComputedStyle(option).boxShadow.includes('0px 0px 0px 2px')
            );
        }),
    );
    await page.keyboard.press('F2');
    const rename = page.getByRole('dialog', { name: 'Rename', exact: true });
    await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
    await rename.waitFor({ state: 'detached' });
    check(
        'pointer dismissal ends a keyboard row ring without losing listing focus',
        (await listing.evaluate((el) => el === document.activeElement)) && (await quietListing()),
    );

    await page.locator('.files-list-columns button:visible').last().focus();
    await page.keyboard.press('Tab');
    check(
        'Tab entry after pointer modal dismissal restores keyboard focus visibility',
        await listing.evaluate((el) => {
            const option = document.getElementById(el.getAttribute('aria-activedescendant')!)!;
            return (
                document.activeElement === el &&
                option &&
                getComputedStyle(option).boxShadow.includes('0px 0px 0px 2px')
            );
        }),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('zync:files-panel-show')));
    check(
        'automatic reopening still keeps keyboard shortcuts ready without an automatic ring',
        (await listing.evaluate((el) => el === document.activeElement)) && (await quietListing()),
    );
}
