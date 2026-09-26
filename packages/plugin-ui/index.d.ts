export interface PluginTheme { mode?: 'light' | 'dark'; colors: Partial<Record<'background' | 'surface' | 'border' | 'text' | 'muted' | 'primary', string>>; }
export function normalizeTheme(payload: unknown, supportsColor?: (value: string) => boolean): PluginTheme;
export function applyTheme(payload: unknown, root?: HTMLElement): PluginTheme;
export function installThemeBridge(options?: { targetWindow?: Window; source?: Window; root?: HTMLElement; onChange?: (theme: PluginTheme) => void }): () => void;
export function enhanceSelects(root?: Document | HTMLElement, options?: { closeEvent?: string }): () => void;
export function installTooltips(root?: Document | HTMLElement): () => void;
export function createButton(options?: { text?: string; variant?: 'default' | 'primary' | 'danger' | 'ghost'; ariaLabel?: string; onClick?: (event: MouseEvent) => void; document?: Document }): HTMLButtonElement;
export function createField(options?: { label?: string; value?: string; placeholder?: string; type?: 'text' | 'search' | 'number' | 'password' | 'email' | 'url'; document?: Document }): { field: HTMLLabelElement; input: HTMLInputElement };
export function createBadge(text: string, tone?: 'muted' | 'positive' | 'negative' | 'warning' | 'info', document?: Document): HTMLSpanElement;
export function createEmptyState(options?: { title?: string; description?: string; actions?: HTMLButtonElement[]; document?: Document }): HTMLElement;
