import * as vscode from 'vscode';
import { Logger, LogLevel } from './logger';

export interface KeystrokeEvent {
    timestamp: Date;
    fileName: string;
    filePath: string;
    changeType: 'insert' | 'delete' | 'replace';
    text: string;
    deletedText: string;
    position: {
        line: number;
        character: number;
    };
    range: {
        startLine: number;
        startChar: number;
        endLine: number;
        endChar: number;
    };
    documentLineCount: number;
    documentVersion: number;
}

export class KeystrokeTracker {
    private disposables: vscode.Disposable[] = [];
    private isTracking = false;
    private totalKeystrokes = 0;
    private totalDeletes = 0;
    private totalInserts = 0;
    private sessionStart: Date | null = null;
    private statusBarItem: vscode.StatusBarItem;

    // Буфер для группировки быстрого ввода
    private inputBuffer: Map<string, {
        text: string;
        timer: NodeJS.Timeout;
        startPos: vscode.Position;
        startTime: Date;
    }> = new Map();
    private bufferDelay = 500; // мс — группируем символы введённые за 500мс

    // Детальный лог каждого символа
    private detailedLog = false;

    constructor(
        private context: vscode.ExtensionContext,
        private logger: Logger
    ) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            200
        );
        this.statusBarItem.command = 'fileWatcherLogger.showLog';
        context.subscriptions.push(this.statusBarItem);
    }

    /**
     * Обновляет статус-бар
     */
    private updateStatusBar(): void {
        if (!this.isTracking) {
            this.statusBarItem.hide();
            return;
        }

        const elapsed = this.sessionStart
            ? Math.floor((Date.now() - this.sessionStart.getTime()) / 1000 / 60)
            : 0;

        this.statusBarItem.text =
            `$(keyboard) ${this.totalKeystrokes} нажатий` +
            ` | +${this.totalInserts} -${this.totalDeletes}` +
            ` | ${elapsed}мин`;

        this.statusBarItem.tooltip =
            `Keystroke Tracker\n` +
            `Всего нажатий: ${this.totalKeystrokes}\n` +
            `Вставлено символов: ${this.totalInserts}\n` +
            `Удалено символов: ${this.totalDeletes}\n` +
            `Время сессии: ${elapsed} мин`;

        this.statusBarItem.show();
    }

    /**
     * Преобразует спецсимволы в читаемый вид
     */
    private escapeText(text: string): string {
        return text
            .replace(/\n/g, '⏎')      // Enter
            .replace(/\r/g, '')         // CR
            .replace(/\t/g, '⇥')       // Tab
            .replace(/ /g, '␣');        // Пробел (опционально)
    }

    /**
     * Определяет тип ввода для красивого логирования
     */
    private classifyInput(text: string): string {
        if (text === '\n' || text === '\r\n') {
            return 'новая строка';
        }
        if (text === '\t') {
            return 'табуляция';
        }
        if (text === ' ') {
            return 'пробел';
        }
        if (text.length === 1) {
            // Одиночный символ
            if (/[a-zA-Zа-яА-ЯёЁ]/.test(text)) {
                return 'буква';
            }
            if (/[0-9]/.test(text)) {
                return 'цифра';
            }
            if (/[{}()\[\]<>]/.test(text)) {
                return 'скобка';
            }
            if (/[.,;:!?]/.test(text)) {
                return 'пунктуация';
            }
            if (/[+\-*/=<>&|^~%]/.test(text)) {
                return 'оператор';
            }
            if (/['"`]/.test(text)) {
                return 'кавычка';
            }
            return 'символ';
        }
        if (text.includes('\n')) {
            return `вставка (${text.split('\n').length} строк)`;
        }
        return `вставка (${text.length} символов)`;
    }

    /**
     * Обрабатывает событие изменения документа
     */
    private handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        // Пропускаем не-файловые документы
        if (event.document.uri.scheme !== 'file') {
            return;
        }

        // Пропускаем вывод и лог-файлы
        const filePath = event.document.uri.fsPath;
        if (filePath.endsWith('.file-watcher.log')) {
            return;
        }

        const fileName = filePath.split(/[/\\]/).pop() || filePath;

        for (const change of event.contentChanges) {
            const insertedText = change.text;
            const deletedLength = change.rangeLength;
            const position = change.range.start;

            // Определяем тип изменения
            let changeType: 'insert' | 'delete' | 'replace';
            if (insertedText.length > 0 && deletedLength === 0) {
                changeType = 'insert';
            } else if (insertedText.length === 0 && deletedLength > 0) {
                changeType = 'delete';
            } else {
                changeType = 'replace';
            }

            // Обновляем счётчики
            this.totalKeystrokes++;
            this.totalInserts += insertedText.length;
            this.totalDeletes += deletedLength;

            if (this.detailedLog) {
                // ===== РЕЖИМ ДЕТАЛЬНОГО ЛОГА (каждый символ отдельно) =====
                this.logDetailedChange(
                    fileName, filePath, changeType,
                    insertedText, deletedLength, position,
                    event.document.version
                );
            } else {
                // ===== РЕЖИМ ГРУППИРОВКИ (буферизация быстрого ввода) =====
                this.bufferChange(
                    fileName, filePath, changeType,
                    insertedText, deletedLength, position,
                    event.document.version
                );
            }

            this.updateStatusBar();
        }
    }

    /**
     * Детальный лог каждого символа
     */
    private logDetailedChange(
        fileName: string,
        filePath: string,
        changeType: 'insert' | 'delete' | 'replace',
        insertedText: string,
        deletedLength: number,
        position: vscode.Position,
        version: number
    ): void {
        const pos = `строка ${position.line + 1}:${position.character + 1}`;
        const escaped = this.escapeText(insertedText);
        const inputType = this.classifyInput(insertedText);

        let message: string;
        let level: LogLevel;

        switch (changeType) {
            case 'insert':
                level = LogLevel.CREATE;
                message = `⌨️ ВВОД [${inputType}]: "${escaped}"`;
                break;
            case 'delete':
                level = LogLevel.DELETE;
                message = `⌫ УДАЛЕНИЕ: ${deletedLength} символов`;
                break;
            case 'replace':
                level = LogLevel.CHANGE;
                message = `🔄 ЗАМЕНА: ${deletedLength} → "${escaped}" (${insertedText.length})`;
                break;
        }

        this.logger.log(
            level,
            message,
            filePath,
            `${pos} | v${version} | #${this.totalKeystrokes}`
        );
    }

    /**
     * Буферизованный лог — группирует быстрый ввод
     */
    private bufferChange(
        fileName: string,
        filePath: string,
        changeType: 'insert' | 'delete' | 'replace',
        insertedText: string,
        deletedLength: number,
        position: vscode.Position,
        version: number
    ): void {
        // Удаления логируем сразу
        if (changeType === 'delete') {
            this.logger.log(
                LogLevel.DELETE,
                `⌫ Удалено ${deletedLength} символов`,
                filePath,
                `строка ${position.line + 1}:${position.character + 1}`
            );
            return;
        }

        // Замены логируем сразу
        if (changeType === 'replace') {
            const escaped = this.escapeText(insertedText);
            this.logger.log(
                LogLevel.CHANGE,
                `🔄 Замена: ${deletedLength} символов → "${escaped}"`,
                filePath,
                `строка ${position.line + 1}:${position.character + 1}`
            );
            return;
        }

        // Для вставок группируем в буфер
        const bufferKey = `${filePath}:${position.line}`;
        const existing = this.inputBuffer.get(bufferKey);

        if (existing) {
            // Добавляем к буферу
            clearTimeout(existing.timer);
            existing.text += insertedText;
        }

        const entry = existing || {
            text: insertedText,
            startPos: position,
            startTime: new Date(),
            timer: null as any
        };

        // Устанавливаем таймер на сброс буфера
        entry.timer = setTimeout(() => {
            this.flushBuffer(bufferKey, fileName, filePath);
        }, this.bufferDelay);

        this.inputBuffer.set(bufferKey, entry);
    }

    /**
     * Сбрасывает буфер и записывает в лог
     */
    private flushBuffer(
        bufferKey: string,
        fileName: string,
        filePath: string
    ): void {
        const entry = this.inputBuffer.get(bufferKey);
        if (!entry) {
            return;
        }

        this.inputBuffer.delete(bufferKey);

        const escaped = this.escapeText(entry.text);
        const inputType = this.classifyInput(entry.text);
        const pos = `строка ${entry.startPos.line + 1}:${entry.startPos.character + 1}`;
        const charCount = entry.text.length;

        let message: string;

        if (charCount === 1) {
            message = `⌨️ [${inputType}]: "${escaped}"`;
        } else {
            message = `⌨️ Ввод (${charCount} символов): "${escaped}"`;
        }

        this.logger.log(
            LogLevel.CREATE,
            message,
            filePath,
            pos
        );
    }

    /**
     * Запускает отслеживание нажатий
     */
    public start(detailed: boolean = false): void {
        if (this.isTracking) {
            this.logger.logWarning('Keystroke tracker уже запущен');
            return;
        }

        this.detailedLog = detailed;
        this.sessionStart = new Date();
        this.totalKeystrokes = 0;
        this.totalDeletes = 0;
        this.totalInserts = 0;

        // Подписываемся на изменения в документах
        const changeDisposable = vscode.workspace.onDidChangeTextDocument(
            (event) => this.handleDocumentChange(event)
        );
        this.disposables.push(changeDisposable);

        // Отслеживаем переключение между файлами
        const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
            (editor) => {
                if (editor) {
                    const fileName = editor.document.uri.fsPath.split(/[/\\]/).pop();
                    this.logger.logInfo(`📂 Переключение на: ${fileName}`);
                }
            }
        );
        this.disposables.push(editorChangeDisposable);

        // Отслеживаем выделение текста
        const selectionDisposable = vscode.window.onDidChangeTextEditorSelection(
            (event) => {
                if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse ||
                    event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {

                    for (const selection of event.selections) {
                        if (!selection.isEmpty) {
                            const selectedText = event.textEditor.document.getText(selection);
                            if (selectedText.length > 0 && selectedText.length < 200) {
                                // Логируем только короткие выделения
                                // чтобы не спамить при выделении всего файла
                                this.logger.log(
                                    LogLevel.INFO,
                                    `🔵 Выделено (${selectedText.length} символов): "${
                                        this.escapeText(selectedText.substring(0, 50))
                                    }${selectedText.length > 50 ? '...' : ''}"`,
                                    event.textEditor.document.uri.fsPath,
                                    `строки ${selection.start.line + 1}-${selection.end.line + 1}`
                                );
                            }
                        }
                    }
                }
            }
        );
        this.disposables.push(selectionDisposable);

        this.isTracking = true;
        this.updateStatusBar();

        const mode = detailed ? 'детальном' : 'буферизованном';
        this.logger.logInfo(`⌨️ Keystroke Tracker запущен в ${mode} режиме`);
        vscode.window.showInformationMessage(
            `Keystroke Tracker запущен (${mode} режим)`
        );
    }

    /**
     * Останавливает отслеживание
     */
    public stop(): void {
        if (!this.isTracking) {
            return;
        }

        // Сбрасываем все буферы
        for (const [key, entry] of this.inputBuffer) {
            clearTimeout(entry.timer);
        }
        this.inputBuffer.clear();

        // Отписываемся от событий
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables = [];

        this.isTracking = false;
        this.statusBarItem.hide();

        // Итоговая статистика
        if (this.sessionStart) {
            const elapsed = Math.floor(
                (Date.now() - this.sessionStart.getTime()) / 1000
            );
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;

            this.logger.logInfo(
                `📊 Статистика сессии:\n` +
                `   Время: ${minutes}мин ${seconds}сек\n` +
                `   Всего нажатий: ${this.totalKeystrokes}\n` +
                `   Вставлено: ${this.totalInserts} символов\n` +
                `   Удалено: ${this.totalDeletes} символов\n` +
                `   Скорость: ${elapsed > 0
                    ? (this.totalKeystrokes / (elapsed / 60)).toFixed(1)
                    : 0
                } нажатий/мин`
            );
        }

        this.logger.logInfo('⌨️ Keystroke Tracker остановлен');
        vscode.window.showInformationMessage('Keystroke Tracker остановлен');
    }

    public getIsTracking(): boolean {
        return this.isTracking;
    }

    public dispose(): void {
        this.stop();
        this.statusBarItem.dispose();
    }
}
