export type LightEditorDiagnosticSeverity = 'error' | 'warning';

export interface LightEditorDiagnostic {
  id: string;
  severity: LightEditorDiagnosticSeverity;
  line: number;
  column: number;
  message: string;
}
