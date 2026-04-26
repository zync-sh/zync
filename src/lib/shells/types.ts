/** Icon data returned by the backend for a detected shell. */
export type ShellIconData =
    | { type: 'bundled'; name: string }      // filename in /shell-icons/ (e.g. "powershell.svg")
    | { type: 'base64Png'; data: string }    // PNG frame extracted from distro ICO
    | { type: 'base64Icon'; data: string };  // raw ICO bytes (BMP-only distro icons)

export interface ShellEntry {
    /** Stable identifier passed as the `shell` override to the backend PTY spawner.
     *  Windows examples: 'powershell', 'cmd', 'gitbash', 'wsl', 'wsl:Ubuntu'
     *  Linux/Mac examples: '/bin/zsh', '/usr/bin/fish' */
    readonly id: string;
    /** Human-readable label shown in the shell picker dropdown. */
    readonly label: string;
    /** Icon resolved by the backend. Absent = component uses CSS badge fallback. */
    readonly icon?: ShellIconData;
    /** Reserved for future "Open as Administrator" support on Windows. */
    readonly elevated?: boolean;
}
