import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';
import { createStore } from 'zustand/vanilla';

import * as tabService from '../../src/features/connections/application/tabService.js';
import type { Tab } from '../../src/features/connections/domain/types.js';
import * as serialProfiles from '../../src/features/serial/domain/profile.js';
import * as mainTabPresentation from '../../src/features/workspace/domain/mainTabPresentation.js';
import * as presentation from '../../src/features/workspace/domain/presentation.js';
import * as registrations from '../../src/features/workspace/domain/registrations.js';
import * as paneTypes from '../../src/lib/paneLayout/types.js';
import type { AppStore } from '../../src/store/useAppStore.js';
import * as profileTypes from '../../src/vault/profileTypes.js';

const { loadSource } = (await import(
    pathToFileURL(resolve('tests/helpers/loadSource.mjs')).href
)) as {
    loadSource<T>(
        file: string,
        dependencies: Record<string, unknown>,
        globals?: Record<string, unknown>,
    ): T;
};

/** Exercise real presentation and restore policy while isolating native and workspace runtime. */
export function presentationStore(tabs: Tab[] = []) {
    const file = 'store/connectionSlice.ts';
    const imports = ts.preProcessFile(readFileSync(resolve('src', file), 'utf8')).importedFiles;
    const dependencies = Object.fromEntries(imports.map(({ fileName }) => [fileName, {}]));
    const { createConnectionSlice } = loadSource<
        typeof import('../../src/store/connectionSlice.js')
    >(
        file,
        {
            ...dependencies,
            '../features/connections/application/tabService': tabService,
            '../features/serial/domain/profile': serialProfiles,
            '../features/workspace/domain/mainTabPresentation': mainTabPresentation,
            '../features/workspace/domain/presentation': presentation,
            '../features/workspace/domain/registrations': registrations,
            '../lib/paneLayout/types': paneTypes,
            '../vault/profileTypes': profileTypes,
            './sessionSlice': { scheduleSaveSession: (save: () => void) => save() },
        },
        { crypto },
    );
    let saves = 0;
    const store = createStore<AppStore>()(
        (...args) =>
            ({
                ...createConnectionSlice(...args),
                tabs,
                sessionLoaded: true,
                isRestoring: false,
                sessionPersistenceBlocked: false,
                terminals: {},
                paneLayouts: {},
                contentPresentation: {},
                saveSession: async () => {
                    saves++;
                },
            }) as AppStore,
    );
    return { get: store.getState, set: store.setState, saves: () => saves };
}
