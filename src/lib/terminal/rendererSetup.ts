import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { reactivateTerminalWebgl, syncTerminalRenderer } from './rendererController.js';
import { setTerminalLigatures } from './ligatures.js';
import { getTerminalRendererState } from './rendererSession.js';
import { isTerminalFitReady, safeFitTerminal } from './terminalFit.js';

function buildWebglLigaturesStamp(fontLigatures: boolean, fontFamily: string | undefined): string {
  return `${fontLigatures}:${fontFamily ?? ''}`;
}

export interface TerminalRendererSetupSettings {
  gpuAcceleration?: boolean;
  fontLigatures?: boolean;
}

export type TerminalResizeSync = (sessionId: string, term: Terminal) => void;

export function getTerminalRendererPreferences(
  terminalSettings: TerminalRendererSetupSettings,
) {
  return {
    gpuAcceleration: terminalSettings.gpuAcceleration ?? true,
    fontLigatures: Boolean(terminalSettings.fontLigatures),
  };
}

/** Only the visible active shell tab should hold a WebGL context. */
export function buildEffectiveRendererSettings(
  terminalSettings: TerminalRendererSetupSettings,
  gpuAllowed: boolean,
): TerminalRendererSetupSettings {
  const prefs = getTerminalRendererPreferences(terminalSettings);
  return {
    ...terminalSettings,
    gpuAcceleration: prefs.gpuAcceleration && gpuAllowed,
  };
}

export function buildRendererRefitCallback(
  sessionId: string,
  fitAddon: FitAddon | null,
  term: Terminal | null,
  syncResize: TerminalResizeSync,
) {
  return () => {
    try {
      if (!term || !isTerminalFitReady(term, fitAddon)) {
        return;
      }
      if (!safeFitTerminal(fitAddon, term)) {
        return;
      }
      const lastRow = Math.max(0, term.rows - 1);
      term.refresh(0, lastRow);
      syncResize(sessionId, term);
    } catch (error) {
      console.warn('[terminal] Renderer refit failed', error);
    }
  };
}

export async function applyTerminalRendererAndLigatures(
  sessionId: string,
  term: Terminal,
  terminalSettings: TerminalRendererSetupSettings,
  fitAddon: FitAddon | null,
  syncResize: TerminalResizeSync,
): Promise<void> {
  try {
    const prefs = getTerminalRendererPreferences(terminalSettings);
    const onRefit = buildRendererRefitCallback(sessionId, fitAddon, term, syncResize);
    const rendererState = getTerminalRendererState(sessionId);
    const ligaturesStamp = buildWebglLigaturesStamp(prefs.fontLigatures, term.options.fontFamily);

    await syncTerminalRenderer(sessionId, term, {
      gpuAcceleration: prefs.gpuAcceleration,
      onRefit,
    });
    await setTerminalLigatures(sessionId, term, prefs.fontLigatures);

    if (prefs.gpuAcceleration && prefs.fontLigatures) {
      const webglReady = rendererState.kind === 'webgl' && Boolean(rendererState.webglAddon);
      const stampMatches = rendererState.webglLigaturesStamp === ligaturesStamp;
      if (webglReady && stampMatches) {
        // Visibility restore (Files→Terminal): keep WebGL alive; dispose here blanks the screen.
        onRefit();
      } else {
        const kind = await reactivateTerminalWebgl(sessionId, term, { onRefit });
        if (kind === 'webgl') {
          rendererState.webglLigaturesStamp = ligaturesStamp;
        }
      }
    } else {
      rendererState.webglLigaturesStamp = undefined;
    }

    try {
      const lastRow = Math.max(0, term.rows - 1);
      term.refresh(0, lastRow);
    } catch {
      // Ignore refresh failures; geometry already handled by syncTerminalRenderer / refit callback.
    }
  } catch (error) {
    console.warn('[terminal] Renderer setup failed', error);
  }
}