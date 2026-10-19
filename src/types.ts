import type { EditorView } from '@codemirror/view';

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'text' | 'line' | 'arrow' | 'rectangle' | 'ellipse';
export type StrokeTool = Exclude<Tool, 'eraser' | 'lasso' | 'text'>;
export interface Point { x: number; y: number; pressure: number; t?: number }
export interface Anchor { from: number; to: number; quote: string; prefix: string; suffix: string; x: number; y: number; orphaned?: boolean }
export interface Stroke { id: string; tool: StrokeTool; points: Point[]; color: string; width: number; opacity: number; smoothing?: number; usePressure?: boolean; anchor?: Anchor; page?: number; updatedAt: number }
export interface InkDocument { version: 1; notePath: string; sourceText: string; revision: number; updatedAt: number; strokes: Stroke[] }
export interface TextChange { from: number; to: number; insert: string }
export interface InkPreset { name: string; tool: 'pen' | 'highlighter'; color: string; width: number; opacity?: number }
export const DEFAULT_FAVORITE_STYLES: readonly Readonly<InkPreset>[] = Object.freeze([
  Object.freeze({ name: 'Blue pen', tool: 'pen' as const, color: '#2563eb', width: 2.5 }),
  Object.freeze({ name: 'Red pen', tool: 'pen' as const, color: '#dc2626', width: 2.5 }),
  Object.freeze({ name: 'Yellow highlighter', tool: 'highlighter' as const, color: '#eab308', width: 22, opacity: .27 }),
]);
export interface InkSettings { tool: Tool; color: string; penWidth: number; highlighterWidth: number; highlighterOpacity: number; eraserSize: number; smoothing: number; usePressure: boolean; mouseDrawing: boolean; enabled: boolean; stableLayout: boolean; writingWidth: number; zoom: number; paper: 'plain' | 'ruled' | 'grid' | 'dots'; dataFolder: string; autosaveMs: number; favoriteStyles: InkPreset[] }
export const DEFAULT_SETTINGS: InkSettings = { tool:'pen', color:'#2563eb', penWidth:2.5, highlighterWidth:22, highlighterOpacity:0.27, eraserSize:18, smoothing:0.55, usePressure:false, mouseDrawing:false, enabled:true, stableLayout:true, writingWidth:760, zoom:1, paper:'plain', dataFolder:'Inkspace Data', autosaveMs:550, favoriteStyles: DEFAULT_FAVORITE_STYLES.map(style => ({ ...style })) };
export const COLORS = ['#2563eb','#151b2e','#dc2626','#16a34a','#9333ea','#ea580c','#eab308','#ffffff'];
export interface InkSession {
  readonly path: string; readonly document: InkDocument; readonly canUndo: boolean; readonly canRedo: boolean;
  add(strokes: Stroke[]): void; replace(strokes: Stroke[], label?: string): void; undo(): void; redo(): void;
  updateText(changes: TextChange[], newText: string): void; reconcileText(text: string): void;
  subscribe(listener: () => void): () => void; flush(): Promise<void>;
}
export interface InkHost {
  getSettings(): InkSettings;
  updateSettings(patch: Partial<InkSettings>): void;
  subscribeSettings(listener: () => void): () => void;
  getSession(path: string): Promise<InkSession>;
  resolveEditor(view: EditorView): { path: string; title: string } | null;
  status(message: string, error?: boolean): void;
  toolbar?(container: HTMLElement, session: () => InkSession | null, extra?: ToolbarActions): () => void;
}
export interface ToolbarActions { exportSvg?: () => void; exportPdf?: () => void; insertSpace?: () => void }
export interface OverlayHandle { destroy(): void; exportSvg(): string; focus(): void }
