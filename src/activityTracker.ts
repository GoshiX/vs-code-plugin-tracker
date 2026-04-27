import * as path from 'path';
import * as vscode from 'vscode';
import { EventLogger } from './eventLogger';
import { normalizePathForComparison, toRelativePath } from './fsUtils';
import { SessionManifest } from './types';

type PositionPayload = {
    line: number;
    character: number;
};

type RangePayload = {
    start: PositionPayload;
    end: PositionPayload;
};

const HEURISTIC_PASTE_CHAR_THRESHOLD = 80;
const HEURISTIC_PASTE_LINE_THRESHOLD = 3;

export class ActivityTracker {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly workspaceRoot: string;
    private isRunning = false;
    private currentWatcher: vscode.FileSystemWatcher | undefined;
    private static readonly ignoredPrefixes = [
        '.git/',
        'node_modules/',
        'out/'
    ];

    constructor(
        private readonly manifest: SessionManifest,
        private readonly eventLogger: EventLogger,
        private readonly onEventRecorded: () => Promise<void>
    ) {
        this.workspaceRoot = normalizePathForComparison(manifest.workspacePath);
    }

    public start(): void {
        if (this.isRunning) {
            return;
        }

        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument((document) => {
                void this.onOpenDocument(document);
            })
        );

        this.disposables.push(
            vscode.workspace.onDidSaveTextDocument((document) => {
                void this.onSaveDocument(document);
            })
        );

        this.disposables.push(
            vscode.workspace.onDidRenameFiles((event) => {
                void this.onRenameFiles(event);
            })
        );

        this.disposables.push(
            vscode.workspace.onDidCreateFiles((event) => {
                void this.onCreateFiles(event);
            })
        );

        this.disposables.push(
            vscode.workspace.onDidDeleteFiles((event) => {
                void this.onDeleteFiles(event);
            })
        );

        this.disposables.push(
            vscode.workspace.onDidChangeTextDocument((event) => {
                void this.onChangeDocument(event);
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                void this.onDidChangeEditor(editor);
            })
        );

        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection((event) => {
                void this.onSelection(event);
            })
        );

        this.disposables.push(
            vscode.window.onDidOpenTerminal((terminal) => {
                void this.recordEvent({
                    type: 'terminal_opened',
                    payload: {
                        terminalName: terminal.name
                    }
                });
            })
        );

        this.disposables.push(
            vscode.window.onDidCloseTerminal((terminal) => {
                void this.recordEvent({
                    type: 'terminal_closed',
                    payload: {
                        terminalName: terminal.name
                    }
                });
            })
        );

        const pattern = new vscode.RelativePattern(this.manifest.workspacePath, '**/*');
        this.currentWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        this.currentWatcher.onDidCreate((uri) => {
            void this.onWatcherCreate(uri);
        });
        this.currentWatcher.onDidDelete((uri) => {
            void this.onWatcherDelete(uri);
        });
        this.disposables.push(this.currentWatcher);

        this.isRunning = true;
    }

    public stop(): void {
        if (!this.isRunning) {
            return;
        }

        this.currentWatcher?.dispose();
        this.currentWatcher = undefined;

        while (this.disposables.length > 0) {
            this.disposables.pop()?.dispose();
        }

        this.isRunning = false;
    }

    public getIsRunning(): boolean {
        return this.isRunning;
    }

    private async onOpenDocument(document: vscode.TextDocument): Promise<void> {
        const filePath = this.asTrackedFilePath(document.uri);
        if (!filePath) {
            return;
        }

        await this.recordEvent({
            type: 'file_opened',
            filePath,
            payload: {
                languageId: document.languageId,
                lineCount: document.lineCount
            }
        });
    }

    private async onSaveDocument(document: vscode.TextDocument): Promise<void> {
        const filePath = this.asTrackedFilePath(document.uri);
        if (!filePath) {
            return;
        }

        await this.recordEvent({
            type: 'file_saved',
            filePath,
            payload: {
                languageId: document.languageId,
                lineCount: document.lineCount,
                version: document.version
            }
        });
    }

    private async onRenameFiles(event: vscode.FileRenameEvent): Promise<void> {
        for (const file of event.files) {
            const oldPath = this.asTrackedFilePath(file.oldUri);
            const newPath = this.asTrackedFilePath(file.newUri);
            if (!oldPath && !newPath) {
                continue;
            }

            await this.recordEvent({
                type: 'file_renamed',
                filePath: newPath ?? oldPath ?? undefined,
                payload: {
                    oldPath,
                    newPath
                }
            });
        }
    }

    private async onCreateFiles(event: vscode.FileCreateEvent): Promise<void> {
        for (const file of event.files) {
            const filePath = this.asTrackedFilePath(file);
            if (!filePath) {
                continue;
            }

            await this.recordEvent({
                type: 'file_created',
                filePath,
                payload: {}
            });
        }
    }

    private async onDeleteFiles(event: vscode.FileDeleteEvent): Promise<void> {
        for (const file of event.files) {
            const filePath = this.asTrackedFilePath(file);
            if (!filePath) {
                continue;
            }

            await this.recordEvent({
                type: 'file_deleted',
                filePath,
                payload: {}
            });
        }
    }

    private async onChangeDocument(event: vscode.TextDocumentChangeEvent): Promise<void> {
        const filePath = this.asTrackedFilePath(event.document.uri);
        if (!filePath) {
            return;
        }

        await this.recordReasonEvent(event, filePath);

        for (const change of event.contentChanges) {
            const basePayload = {
                text: change.text,
                insertedLength: change.text.length,
                deletedLength: change.rangeLength,
                position: this.toPosition(change.range.start),
                range: this.toRange(change.range),
                documentVersion: event.document.version
            };

            if (change.text.length > 0 && change.rangeLength === 0) {
                await this.recordEvent({
                    type: 'text_inserted',
                    filePath,
                    payload: basePayload
                });

                const insertedLines = this.countLines(change.text);
                if (
                    change.text.length >= HEURISTIC_PASTE_CHAR_THRESHOLD ||
                    insertedLines >= HEURISTIC_PASTE_LINE_THRESHOLD
                ) {
                    await this.recordEvent({
                        type: 'paste_detected',
                        filePath,
                        payload: {
                            source: 'heuristic.bulkInsertion',
                            insertedLength: change.text.length,
                            insertedLines
                        }
                    });
                }
                continue;
            }

            if (change.text.length === 0 && change.rangeLength > 0) {
                await this.recordEvent({
                    type: 'text_deleted',
                    filePath,
                    payload: basePayload
                });
                continue;
            }

            await this.recordEvent({
                type: 'text_replaced',
                filePath,
                payload: basePayload
            });
        }
    }

    private async onDidChangeEditor(
        editor: vscode.TextEditor | undefined
    ): Promise<void> {
        if (!editor) {
            return;
        }

        const filePath = this.asTrackedFilePath(editor.document.uri);
        if (!filePath) {
            return;
        }

        await this.recordEvent({
            type: 'editor_switched',
            filePath,
            payload: {
                languageId: editor.document.languageId
            }
        });
    }

    private async onSelection(
        event: vscode.TextEditorSelectionChangeEvent
    ): Promise<void> {
        const filePath = this.asTrackedFilePath(event.textEditor.document.uri);
        if (!filePath) {
            return;
        }

        const nonEmptySelections = event.selections.filter((selection) => !selection.isEmpty);
        if (nonEmptySelections.length === 0) {
            return;
        }

        const payload = nonEmptySelections.map((selection) => {
            const preview = event.textEditor.document.getText(selection).slice(0, 200);
            return {
                range: this.toRange(selection),
                preview
            };
        });

        await this.recordEvent({
            type: 'text_selected',
            filePath,
            payload
        });
    }

    private async onWatcherCreate(uri: vscode.Uri): Promise<void> {
        const filePath = this.asTrackedFilePath(uri);
        if (!filePath) {
            return;
        }

        await this.recordEvent({
            type: 'file_created',
            filePath,
            payload: {
                source: 'watcher'
            }
        });
    }

    private async onWatcherDelete(uri: vscode.Uri): Promise<void> {
        const filePath = this.asTrackedFilePath(uri);
        if (!filePath) {
            return;
        }

        await this.recordEvent({
            type: 'file_deleted',
            filePath,
            payload: {
                source: 'watcher'
            }
        });
    }

    private asTrackedFilePath(uri: vscode.Uri): string | undefined {
        if (uri.scheme !== 'file') {
            return undefined;
        }

        const fsPath = normalizePathForComparison(uri.fsPath);
        if (!this.isInWorkspace(fsPath)) {
            return undefined;
        }

        const relativePath = toRelativePath(this.workspaceRoot, fsPath);
        if (ActivityTracker.ignoredPrefixes.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix))) {
            return undefined;
        }

        return relativePath;
    }

    private isInWorkspace(filePath: string): boolean {
        const relative = path.relative(this.workspaceRoot, filePath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }

    private toPosition(position: vscode.Position): PositionPayload {
        return {
            line: position.line,
            character: position.character
        };
    }

    private toRange(range: vscode.Range): RangePayload {
        return {
            start: this.toPosition(range.start),
            end: this.toPosition(range.end)
        };
    }

    private countLines(text: string): number {
        return text.split('\n').length;
    }

    private async recordReasonEvent(
        event: vscode.TextDocumentChangeEvent,
        filePath: string
    ): Promise<void> {
        if (event.reason === vscode.TextDocumentChangeReason.Undo) {
            await this.recordEvent({
                type: 'undo_executed',
                filePath,
                payload: {
                    source: 'textDocumentChangeReason'
                }
            });
            await this.recordEvent({
                type: 'command_executed',
                filePath,
                payload: {
                    commandId: 'history.undo',
                    source: 'textDocumentChangeReason'
                }
            });
        }

        if (event.reason === vscode.TextDocumentChangeReason.Redo) {
            await this.recordEvent({
                type: 'redo_executed',
                filePath,
                payload: {
                    source: 'textDocumentChangeReason'
                }
            });
            await this.recordEvent({
                type: 'command_executed',
                filePath,
                payload: {
                    commandId: 'history.redo',
                    source: 'textDocumentChangeReason'
                }
            });
        }
    }

    private async recordEvent(input: Parameters<EventLogger['append']>[0]): Promise<void> {
        await this.eventLogger.append(input);
        await this.onEventRecorded();
    }
}
