import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Modal } from '../ui/Modal';
import { useAppStore } from '../../store/useAppStore';
import { cn } from '../../lib/utils';
import { createInlineEditorContentProvider } from './content/provider.js';
import { useEditorContent } from './content/useEditorContent.js';
import { LIGHT_EDITOR_COMMANDS } from './commands.js';
import { getBracketHighlights } from './core/brackets.js';
import { createLineModel, getOffsetPosition } from './core/lineModel.js';
import { detectLightEditorLanguage } from './contextEngine';
import { LIGHT_EDITOR_LINE_HEIGHT, LIGHT_EDITOR_VERTICAL_PADDING, loadHighlightConfig } from './highlight';
import { useLightEditorDiagnosticsController } from './hooks/useLightEditorDiagnosticsController.js';
import { useLightEditorDisplayModel } from './hooks/useLightEditorDisplayModel.js';
import { useLightEditorFoldingController } from './hooks/useLightEditorFoldingController.js';
import { useLightEditorGutterModel } from './hooks/useLightEditorGutterModel.js';
import { useLightEditorNavigation } from './hooks/useLightEditorNavigation.js';
import { LightEditorHeader } from './LightEditorHeader';
import { findOccurrences } from './occurrences.js';
import { LightShortcutsModal } from './LightShortcutsModal.js';
import { LightMinimap, LIGHT_EDITOR_MINIMAP_WIDTH } from './minimap/LightMinimap.js';
import { EditorPanelHost } from './panels/EditorPanelHost.js';
import { LightSyntaxOverlay } from './LightSyntaxOverlay';
import { formatGlobalEditorStatus } from './status';
import { findWordRange } from './text';
import { useGlobalEditorStatus } from './useGlobalEditorStatus';
import { useLightEditorCompletion } from './useLightEditorCompletion';
import { useLightEditorSearch } from './useLightEditorSearch';
import { useLightEditorContextMenu } from './useLightEditorContextMenu';
import { useLightEditorTheme } from './theme/useLightEditorTheme.js';
import { useLightEditorUtilities } from './useLightEditorUtilities';
import { useLightEditorViewport } from './useLightEditorViewport';
import { useLightEditorCommands } from './useLightEditorCommands';
import { Button } from '../ui/Button';
import './light-editor.css';

interface LightFileEditorProps {
  filename: string;
  initialContent: string;
  onSave: (content: string) => Promise<void>;
  onClose: () => void;
}

export function LightFileEditor({
  filename,
  initialContent,
  onSave,
  onClose,
}: LightFileEditorProps) {
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [cursorLine, setCursorLine] = useState(1);
  const [cursorColumn, setCursorColumn] = useState(1);
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [currentWord, setCurrentWord] = useState('');
  const [scrollLeft, setScrollLeft] = useState(0);
  const [charWidth, setCharWidth] = useState(8);
  const [prismLanguage, setPrismLanguage] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const goToLineInputRef = useRef<HTMLInputElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingExpandApplyRef = useRef<number | null>(null);

  const showToast = useAppStore((state) => state.showToast);
  const editorDiagnosticsVisible = useAppStore((state) => state.editorDiagnosticsVisible);
  const {
    themeId,
    themeStyle,
  } = useLightEditorTheme();
  const contentProvider = useMemo(
    () => createInlineEditorContentProvider(initialContent, onSave),
    [initialContent, onSave],
  );
  const {
    content,
    setContent,
    hasChanges,
    saveContent,
  } = useEditorContent({
    provider: contentProvider,
    resetKey: filename,
  });
  const languageId = useMemo(() => detectLightEditorLanguage(filename), [filename]);
  const {
    lineModel,
    foldRanges,
    foldByLine,
    collapsedLines,
    toggleFold,
    expandAllFolds,
    collapseAllFolds,
    collapseFoldKind,
    expandFoldsForLine,
  } = useLightEditorFoldingController(content, languageId);
  const deferredContent = useDeferredValue(content);
  const analysisLineModel = useMemo(() => createLineModel(deferredContent), [deferredContent]);
  const syncCursorState = useCallback((value: string, model: Parameters<typeof getOffsetPosition>[0], offset: number) => {
    const textarea = textareaRef.current;
    const position = getOffsetPosition(model, offset);
    setCursorLine(position.line);
    setCursorColumn(position.column);
    setSelectionStart(offset);
    setSelectionEnd(textarea?.selectionEnd ?? offset);
    setCurrentWord(findWordRange(value, offset).word);
  }, []);

  const {
    lineCount,
    projection,
    hasCollapsedFolds,
    displayContent,
    displayLineModel,
    displayLineCount,
    currentRealLine,
  } = useLightEditorDisplayModel({
    content,
    lineModel,
    foldRanges,
    collapsedLines,
    cursorLine,
  });
  const {
    diagnostics,
    displayDiagnostics,
    diagnosticsByLine,
  } = useLightEditorDiagnosticsController({
    content,
    languageId,
    projection,
    hasCollapsedFolds,
  });
  const globalStatusText = useMemo(
    () => formatGlobalEditorStatus(filename, cursorLine, cursorColumn, languageId),
    [cursorColumn, cursorLine, filename, languageId],
  );

  const updateCursorPosition = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const offset = textarea.selectionStart;
    syncCursorState(textarea.value, displayLineModel, offset);
  }, [displayLineModel, syncCursorState]);

  const focusMatch = useCallback((matchIndex: number, matches: Array<{ start: number; end: number }>) => {
    const textarea = textareaRef.current;
    const match = matches[matchIndex];
    if (!textarea || !match) return;
    textarea.focus();
    textarea.setSelectionRange(match.start, match.end);
    updateCursorPosition();
  }, [updateCursorPosition]);

  const utilities = useLightEditorUtilities({
    lineModel: hasCollapsedFolds ? displayLineModel : lineModel,
    lineCount: hasCollapsedFolds ? displayLineCount : lineCount,
    rootRef,
    textareaRef,
    findInputRef,
    replaceInputRef,
    goToLineInputRef,
    updateCursorPosition,
  });

  const viewport = useLightEditorViewport(textareaRef, displayLineCount);

  const search = useLightEditorSearch({
    content: displayContent,
    utilityMode: utilities.utilityMode,
    charWidth,
    scrollTop: viewport.scrollTop,
    scrollLeft,
    focusMatch,
    setContent,
  });
  const completion = useLightEditorCompletion({
    content,
    currentWord,
    languageId,
    textareaRef,
    setContent,
    updateCursorPosition,
  });
  const bracketHighlights = useMemo(
    () => getBracketHighlights(lineModel, selectionStart),
    [lineModel, selectionStart],
  );
  const occurrenceHighlights = useMemo(
    () => findOccurrences(displayLineModel, displayContent, selectionStart, selectionEnd),
    [displayContent, displayLineModel, selectionEnd, selectionStart],
  );
  const gutterWindow = useMemo(() => ({
    startVisibleRow: viewport.visibleStartLine,
    endVisibleRow: viewport.visibleEndLine,
  }), [viewport.visibleEndLine, viewport.visibleStartLine]);
  const {
    gutterNumberColumnWidth,
    gutterRows,
  } = useLightEditorGutterModel({
    lineCount,
    projection,
    foldByLine,
    diagnosticsByLine,
    visibleStartLine: gutterWindow.startVisibleRow,
    visibleEndLine: gutterWindow.endVisibleRow,
  });
  useEffect(() => {
    return () => {
      if (pendingExpandApplyRef.current !== null) {
        cancelAnimationFrame(pendingExpandApplyRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setCursorLine(1);
    setCursorColumn(1);
    setCurrentWord('');
    setPrismLanguage(null);
    completion.clearCompletion();
    search.resetSearch();
    utilities.setShowReplace(false);
    utilities.closeUtility();
    utilities.resetGoToLine();
  }, [
    completion.clearCompletion,
    filename,
    initialContent,
    search.resetSearch,
    utilities.closeUtility,
    utilities.resetGoToLine,
    utilities.setShowReplace,
  ]);

  useGlobalEditorStatus(globalStatusText);

  useEffect(() => {
    const element = measureRef.current;
    if (!element) return;
    const width = element.getBoundingClientRect().width;
    if (width > 0) setCharWidth(width / 10);
  }, []);

  const handleScroll = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    setScrollLeft(textarea.scrollLeft);
    if (highlightRef.current) {
      highlightRef.current.scrollTop = textarea.scrollTop;
      highlightRef.current.scrollLeft = textarea.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = textarea.scrollTop;
    }
  }, []);

  const handleMinimapJump = useCallback((ratio: number) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const nextScrollTop = ratio * textarea.scrollHeight;
    textarea.scrollTop = nextScrollTop;
    handleScroll();
  }, [handleScroll]);

  useEffect(() => {
    let cancelled = false;
    const loadHighlighting = async () => {
      const config = await loadHighlightConfig(languageId);
      if (cancelled) return;
      setPrismLanguage(config);
    };

    void loadHighlighting();
    return () => {
      cancelled = true;
    };
  }, [languageId]);

  const handleSave = useCallback(async () => {
    try {
      const didSave = await saveContent();
      if (!didSave) return;
      showToast('success', `Saved ${filename}`);
    } catch (error) {
      console.error('[LightFileEditor] Save failed:', error);
      showToast('error', `Failed to save ${filename}`);
    }
  }, [filename, saveContent, showToast]);

  const openFind = useCallback(() => {
    utilities.setUtilityMode('find');
    utilities.setShowReplace(false);
  }, [utilities]);

  const openReplace = useCallback(() => {
    utilities.setUtilityMode('find');
    utilities.setShowReplace(true);
  }, [utilities]);

  const openGoto = useCallback(() => {
    utilities.setUtilityMode('goto');
  }, [utilities]);

  const handleFoldAll = useCallback(() => {
    collapseAllFolds(foldRanges);
  }, [collapseAllFolds, foldRanges]);

  const handleUnfoldAll = useCallback(() => {
    expandAllFolds();
  }, [expandAllFolds]);

  const handleFoldImports = useCallback(() => {
    collapseFoldKind(foldRanges, 'imports');
  }, [collapseFoldKind, foldRanges]);

  const handleFoldCurrent = useCallback(() => {
    const range = foldRanges
      .filter((item) => currentRealLine >= item.startLine && currentRealLine <= item.endLine)
      .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine))[0];
    if (range) {
      toggleFold(range.startLine);
    }
  }, [currentRealLine, foldRanges, toggleFold]);

  const {
    handleGoToLine,
    handleJumpToDiagnostic,
  } = useLightEditorNavigation({
    textareaRef,
    lineModel,
    displayLineModel,
    lineCount,
    projection,
    hasCollapsedFolds,
    foldRanges,
    collapsedLines,
    expandFoldsForLine,
    syncCursorState,
    targetLine: utilities.targetLine,
    closeUtility: utilities.closeUtility,
    resetGoToLine: utilities.resetGoToLine,
    content,
    searchFindText: search.findText,
    searchOptions: search.searchOptions,
    utilityMode: utilities.utilityMode,
  });

  const contextMenu = useLightEditorContextMenu({
    textareaRef,
    setContent,
    setCurrentWord,
    updateCursorPosition,
    showToast,
    onSave: () => void handleSave(),
    onFind: openFind,
    onReplace: openReplace,
    onGoto: openGoto,
    onFoldAll: handleFoldAll,
    onUnfoldAll: handleUnfoldAll,
    onFoldImports: handleFoldImports,
    onFoldCurrent: handleFoldCurrent,
  });

  const handleEditorKeyDown = useLightEditorCommands({
    content,
    textareaRef,
    setContent,
    updateCursorPosition,
    handleSave,
    setCurrentWord,
    completionItems: completion.completionItems,
    selectedCompletionIndex: completion.selectedCompletionIndex,
    setSelectedCompletionIndex: completion.setSelectedCompletionIndex,
    applyCompletion: completion.applyCompletion,
    clearCompletion: completion.clearCompletion,
  });

  const handleDisplayKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (hasCollapsedFolds) {
      const isMutatingKey =
        event.key === 'Backspace' ||
        event.key === 'Delete' ||
        event.key === 'Enter' ||
        event.key === 'Tab' ||
        (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1);
      const isNavigationKey =
        event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight' ||
        event.key === 'Home' ||
        event.key === 'End' ||
        event.key === 'PageUp' ||
        event.key === 'PageDown';

      if (isMutatingKey || isNavigationKey) {
        event.preventDefault();
        expandAllFolds();
        return;
      }
    }

    handleEditorKeyDown(event);
  }, [expandAllFolds, handleEditorKeyDown, hasCollapsedFolds]);

  const requestClose = useCallback(() => {
    if (hasChanges) {
      setShowConfirmClose(true);
      return;
    }
    onClose();
  }, [hasChanges, onClose]);

  return (
    <div
      ref={rootRef}
      data-editor-theme={themeId}
      className="absolute inset-0 z-50 flex flex-col bg-app-bg animate-in fade-in duration-200"
      style={themeStyle}
    >
      <span
        ref={measureRef}
        aria-hidden
        className="pointer-events-none absolute opacity-0 font-mono text-[13px]"
      >
        0000000000
      </span>
      <LightEditorHeader
        filename={filename}
        commands={LIGHT_EDITOR_COMMANDS}
        onOpenShortcuts={() => setShowShortcuts(true)}
        onClose={requestClose}
      />

      <div className="flex min-h-0 flex-1 bg-app-bg">
        <div
          ref={gutterRef}
          className="hidden shrink-0 overflow-hidden border-r border-app-border/30 bg-app-panel/50 font-mono text-app-muted/80 md:block"
          style={{ width: 8 + gutterNumberColumnWidth + 16 + 8 }}
        >
          <div
            className="relative"
            style={{
              height: LIGHT_EDITOR_VERTICAL_PADDING * 2 + projection.visibleLineCount * LIGHT_EDITOR_LINE_HEIGHT,
            }}
          >
            <div style={{ height: LIGHT_EDITOR_VERTICAL_PADDING + gutterWindow.startVisibleRow * LIGHT_EDITOR_LINE_HEIGHT, pointerEvents: 'none' }} />
            {gutterRows.map(({ row, lineNumber, diagnostic, isFoldable }) => (
                <div
                  key={`${row.kind}-${row.visibleRow}-${row.realLine}`}
                  className="relative grid select-none"
                  style={{
                    height: LIGHT_EDITOR_LINE_HEIGHT,
                    lineHeight: `${LIGHT_EDITOR_LINE_HEIGHT}px`,
                    fontSize: 12,
                    gridTemplateColumns: `10px ${gutterNumberColumnWidth}px 16px`,
                    alignItems: 'center',
                    paddingLeft: 2,
                    paddingRight: 4,
                  }}
                >
                  {diagnostic && (
                    <span
                      className="inline-block h-1.5 w-1.5 rounded-full self-center justify-self-center"
                      style={{
                        background: diagnostic.some((item) => item.severity === 'error')
                          ? 'var(--color-app-danger)'
                          : 'var(--color-app-warning)',
                      }}
                    />
                  )}
                  {isFoldable && (
                    <div style={{ gridColumn: 2 }} className="flex items-center justify-end gap-1 pr-1">
                      <span className="tabular-nums text-right">{lineNumber}</span>
                    </div>
                  )}
                  {!isFoldable && (
                    <span style={{ gridColumn: 2 }} className="pr-1 text-right tabular-nums">{lineNumber}</span>
                  )}
                  {isFoldable && (
                    <button
                      type="button"
                      onClick={() => toggleFold(lineNumber)}
                      className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-app-text/90 hover:bg-app-surface/60 hover:text-app-accent self-center justify-self-center"
                      title={collapsedLines.has(lineNumber) ? 'Expand fold' : 'Collapse fold'}
                      style={{ gridColumn: 3 }}
                    >
                      {collapsedLines.has(lineNumber) ? <ChevronRight size={12} strokeWidth={2.2} /> : <ChevronDown size={12} strokeWidth={2.2} />}
                    </button>
                  )}
                </div>
            ))}
            <div
              style={{
                height: LIGHT_EDITOR_VERTICAL_PADDING + Math.max(0, (projection.visibleLineCount - gutterWindow.endVisibleRow) * LIGHT_EDITOR_LINE_HEIGHT),
                pointerEvents: 'none',
              }}
            />
          </div>
        </div>
        <div className="relative flex min-h-0 flex-1">
          <EditorPanelHost
            utilityMode={utilities.utilityMode}
            showReplace={utilities.showReplace}
            targetLine={utilities.targetLine}
            lineCount={lineCount}
            findText={search.findText}
            replaceText={search.replaceText}
            matchLabel={search.matchLabel}
            findCaseSensitive={search.findCaseSensitive}
            findWholeWord={search.findWholeWord}
            findUseRegex={search.findUseRegex}
            currentWord={currentWord}
            completionItems={completion.completionItems}
            selectedCompletionIndex={completion.selectedCompletionIndex}
            hoverInfo={completion.hoverInfo}
            definitionInfo={completion.definitionInfo}
            diagnostics={diagnostics}
            diagnosticsVisible={editorDiagnosticsVisible}
            contextMenuPosition={contextMenu.menuPosition}
            contextMenuItems={contextMenu.items}
            findInputRef={findInputRef}
            replaceInputRef={replaceInputRef}
            goToLineInputRef={goToLineInputRef}
            onFindTextChange={search.setFindText}
            onReplaceTextChange={search.setReplaceText}
            onToggleFindCaseSensitive={() => search.setFindCaseSensitive((value) => !value)}
            onToggleFindWholeWord={() => search.setFindWholeWord((value) => !value)}
            onToggleFindRegex={() => search.setFindUseRegex((value) => !value)}
            onTargetLineChange={(value) => utilities.setTargetLine(value.replace(/\D/g, ''))}
            onPreviousFind={search.handleFindPrevious}
            onNextFind={search.handleFindNext}
            onToggleReplace={() => utilities.setShowReplace((value) => !value)}
            onReplaceOne={search.handleReplaceOne}
            onReplaceAll={search.handleReplaceAll}
            onCloseFind={() => {
              contextMenu.closeContextMenu();
              utilities.setShowReplace(false);
              utilities.closeUtility();
              search.resetSearch();
            }}
            onCloseGoto={utilities.closeUtility}
            onCloseContextMenu={contextMenu.closeContextMenu}
            onJumpToDiagnostic={handleJumpToDiagnostic}
            onFindKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (event.shiftKey) search.handleFindPrevious();
                else search.handleFindNext();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                utilities.setShowReplace(false);
                utilities.closeUtility();
                search.resetSearch();
              }
            }}
            onReplaceKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                utilities.setShowReplace(false);
                utilities.closeUtility();
                search.resetSearch();
              }
            }}
            onGoToLine={handleGoToLine}
            onGotoKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleGoToLine();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                utilities.closeUtility();
              }
            }}
            onCompletionSelectIndex={completion.setSelectedCompletionIndex}
            onApplyCompletion={completion.applyCompletion}
          />

          <LightSyntaxOverlay
            highlightRef={highlightRef}
            lineModel={lineModel}
            projection={hasCollapsedFolds ? projection : null}
            prismLanguage={prismLanguage}
            searchHighlights={search.searchHighlights}
            diagnostics={displayDiagnostics}
            bracketHighlights={hasCollapsedFolds ? [] : bracketHighlights}
            occurrenceHighlights={occurrenceHighlights}
            charWidth={charWidth}
            contentPaddingRight={LIGHT_EDITOR_MINIMAP_WIDTH + 24}
            scrollTop={viewport.scrollTop}
            startLine={viewport.startLine}
            endLine={viewport.endLine}
            lineCount={displayLineCount}
            cursorLine={cursorLine}
          />

          <textarea
            id={`light-editor-${filename.replace(/[^a-z0-9_-]+/gi, '-')}`}
            ref={textareaRef}
            value={displayContent}
            onChange={(event) => {
              if (hasCollapsedFolds) {
                expandAllFolds();
                return;
              }
              setContent(event.target.value);
            }}
            onClick={updateCursorPosition}
            onKeyUp={updateCursorPosition}
            onSelect={updateCursorPosition}
            onKeyDown={handleDisplayKeyDown}
            onScroll={handleScroll}
            onContextMenu={contextMenu.handleContextMenu}
            spellCheck={false}
            aria-label={`Code editor for ${filename}`}
            autoFocus
            className={cn(
              'relative z-10 min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-6 text-transparent outline-none',
              'placeholder:text-app-muted/40',
            )}
            style={{ tabSize: 2, caretColor: 'var(--color-app-text)', paddingRight: LIGHT_EDITOR_MINIMAP_WIDTH + 24 }}
          />

          <LightMinimap
            lineModel={hasCollapsedFolds ? displayLineModel : analysisLineModel}
            prismLanguage={prismLanguage}
            lineCount={hasCollapsedFolds ? displayLineCount : analysisLineModel.lineCount}
            viewportHeight={viewport.viewportHeight}
            scrollTop={viewport.scrollTop}
            diagnostics={displayDiagnostics}
            searchHighlights={search.searchHighlights}
            onJump={handleMinimapJump}
          />
        </div>
      </div>

      <Modal
        isOpen={showConfirmClose}
        onClose={() => setShowConfirmClose(false)}
        title="Unsaved Changes"
      >
        <div className="space-y-4">
          <p className="text-sm text-app-text">
            You have unsaved changes in <span className="font-medium">{filename}</span>. Close without saving?
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowConfirmClose(false)}>
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setShowConfirmClose(false);
                onClose();
              }}
            >
              Discard changes
            </Button>
          </div>
        </div>
      </Modal>

      <LightShortcutsModal
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        commands={LIGHT_EDITOR_COMMANDS}
      />
    </div>
  );
}
