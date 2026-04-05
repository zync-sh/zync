import {
  type LightEditorCompletionItem,
  type LightEditorDefinitionEntry,
  type LightEditorHoverEntry,
} from '../contextEngine.js';
import { DiagnosticsPanel } from '../DiagnosticsPanel.js';
import type { LightEditorDiagnostic } from '../diagnostics/types.js';
import { ContextMenu, type ContextMenuItem } from '../../ui/ContextMenu.js';
import { LightCompletionPanel } from '../LightCompletionPanel.js';
import { LightFindReplaceBar } from '../LightFindReplaceBar.js';
import { LightGoToLineBar } from '../LightGoToLineBar.js';

interface EditorPanelHostProps {
  utilityMode: 'find' | 'goto' | null;
  showReplace: boolean;
  targetLine: string;
  lineCount: number;
  findText: string;
  replaceText: string;
  matchLabel: string;
  findCaseSensitive: boolean;
  findWholeWord: boolean;
  findUseRegex: boolean;
  currentWord: string;
  completionItems: LightEditorCompletionItem[];
  selectedCompletionIndex: number;
  hoverInfo: LightEditorHoverEntry | null;
  definitionInfo: LightEditorDefinitionEntry | null;
  diagnostics: LightEditorDiagnostic[];
  diagnosticsVisible: boolean;
  contextMenuPosition: { x: number; y: number } | null;
  contextMenuItems: ContextMenuItem[];
  findInputRef: React.RefObject<HTMLInputElement | null>;
  replaceInputRef: React.RefObject<HTMLInputElement | null>;
  goToLineInputRef: React.RefObject<HTMLInputElement | null>;
  onFindTextChange: (value: string) => void;
  onReplaceTextChange: (value: string) => void;
  onToggleFindCaseSensitive: () => void;
  onToggleFindWholeWord: () => void;
  onToggleFindRegex: () => void;
  onTargetLineChange: (value: string) => void;
  onPreviousFind: () => void;
  onNextFind: () => void;
  onToggleReplace: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onCloseFind: () => void;
  onCloseGoto: () => void;
  onCloseContextMenu: () => void;
  onJumpToDiagnostic: (diagnostic: LightEditorDiagnostic) => void;
  onFindKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onReplaceKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onGoToLine: () => void;
  onGotoKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onCompletionSelectIndex: (index: number) => void;
  onApplyCompletion: (item: LightEditorCompletionItem) => void;
}

export function EditorPanelHost({
  utilityMode,
  showReplace,
  targetLine,
  lineCount,
  findText,
  replaceText,
  matchLabel,
  findCaseSensitive,
  findWholeWord,
  findUseRegex,
  currentWord,
  completionItems,
  selectedCompletionIndex,
  hoverInfo,
  definitionInfo,
  diagnostics,
  diagnosticsVisible,
  contextMenuPosition,
  contextMenuItems,
  findInputRef,
  replaceInputRef,
  goToLineInputRef,
  onFindTextChange,
  onReplaceTextChange,
  onToggleFindCaseSensitive,
  onToggleFindWholeWord,
  onToggleFindRegex,
  onTargetLineChange,
  onPreviousFind,
  onNextFind,
  onToggleReplace,
  onReplaceOne,
  onReplaceAll,
  onCloseFind,
  onCloseGoto,
  onCloseContextMenu,
  onJumpToDiagnostic,
  onFindKeyDown,
  onReplaceKeyDown,
  onGoToLine,
  onGotoKeyDown,
  onCompletionSelectIndex,
  onApplyCompletion,
}: EditorPanelHostProps) {
  return (
    <>
      {utilityMode === 'find' && (
        <LightFindReplaceBar
          findText={findText}
          replaceText={replaceText}
          showReplace={showReplace}
          matchLabel={matchLabel}
          caseSensitive={findCaseSensitive}
          wholeWord={findWholeWord}
          useRegex={findUseRegex}
          onFindTextChange={onFindTextChange}
          onReplaceTextChange={onReplaceTextChange}
          onToggleCaseSensitive={onToggleFindCaseSensitive}
          onToggleWholeWord={onToggleFindWholeWord}
          onToggleRegex={onToggleFindRegex}
          onPrevious={onPreviousFind}
          onNext={onNextFind}
          onToggleReplace={onToggleReplace}
          onReplaceOne={onReplaceOne}
          onReplaceAll={onReplaceAll}
          onClose={onCloseFind}
          onFindKeyDown={onFindKeyDown}
          onReplaceKeyDown={onReplaceKeyDown}
          findInputRef={findInputRef}
          replaceInputRef={replaceInputRef}
        />
      )}
      {utilityMode === 'goto' && (
        <LightGoToLineBar
          targetLine={targetLine}
          lineCount={lineCount}
          onTargetLineChange={onTargetLineChange}
          onGo={onGoToLine}
          onClose={onCloseGoto}
          onKeyDown={onGotoKeyDown}
          inputRef={goToLineInputRef}
        />
      )}
      <LightCompletionPanel
        currentWord={currentWord}
        completionItems={completionItems}
        selectedCompletionIndex={selectedCompletionIndex}
        hoverInfo={hoverInfo}
        definitionInfo={definitionInfo}
        utilityMode={utilityMode}
        showReplace={showReplace}
        onSelectIndex={onCompletionSelectIndex}
        onApplyCompletion={onApplyCompletion}
      />
      {contextMenuPosition && (
        <ContextMenu
          x={contextMenuPosition.x}
          y={contextMenuPosition.y}
          items={contextMenuItems}
          onClose={onCloseContextMenu}
        />
      )}
      <DiagnosticsPanel diagnostics={diagnostics} visible={diagnosticsVisible} onJumpToDiagnostic={onJumpToDiagnostic} />
    </>
  );
}
