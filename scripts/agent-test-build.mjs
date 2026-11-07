import path from 'node:path';

import ts from 'typescript';

/** Resolve registered TypeScript sources using the compiler's configured output paths. */
export function readTestBuild(configFile = path.resolve('tsconfig.agent-tests.json')) {
    const config = ts.getParsedCommandLineOfConfigFile(
        configFile,
        {},
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic(diagnostic) {
                throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
            },
        },
    );
    if (!config || config.errors.length > 0 || !config.options.outDir) {
        throw new Error('The test compiler configuration must be valid and declare outDir.');
    }
    const canonical = (file) => {
        const absolute = path.normalize(path.resolve(file));
        return ts.sys.useCaseSensitiveFileNames ? absolute : absolute.toLowerCase();
    };
    const inputs = new Map(config.fileNames.map((file) => [canonical(file), file]));
    return {
        configFile,
        outputDirectory: config.options.outDir,
        /** Reject uncompiled registrations instead of accidentally executing stale build output. */
        resolveTestFile(source) {
            if (!/\.(?:[cm]?ts|tsx)$/.test(source)) {
                return path.resolve(source);
            }
            const input = inputs.get(canonical(source));
            if (!input) {
                throw new Error(`Test source is not included by the compiler: ${source}`);
            }
            const output = ts
                .getOutputFileNames(config, input, false)
                .find((file) => /\.(?:[cm]?js|jsx)$/.test(file));
            if (!output) {
                throw new Error(`Test source does not emit executable JavaScript: ${source}`);
            }
            return output;
        },
    };
}
