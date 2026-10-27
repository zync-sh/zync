import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface SourceLoader {
    loadSource(
        file: string,
        dependencies?: Record<string, unknown>,
        globals?: Record<string, unknown>,
    ): unknown;
}

// Load the shared VM harness by file URL so its compiler and source paths resolve
// from the original helper. Unmigrated suites continue to use that same harness.
const loader = (await import(
    pathToFileURL(path.resolve('tests/helpers/loadSource.mjs')).href
)) as SourceLoader;

/** Evaluate real production source with explicitly typed service and platform boundaries. */
export function loadSource<T>(
    file: string,
    dependencies: Record<string, unknown> = {},
    globals: Record<string, unknown> = {},
): T {
    return loader.loadSource(file, dependencies, globals) as T;
}
