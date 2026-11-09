/** Send an app-owned POSIX script through login shells such as Fish without exposing its syntax. */
export function runDashboardPosixScript(script: string): string {
    const escaped = script.replace(
        /['\\\r\n!]/g,
        (character) => `\\0${character.charCodeAt(0).toString(8).padStart(3, '0')}`,
    );
    return `printf '%b' '${escaped}' | /bin/sh`;
}
