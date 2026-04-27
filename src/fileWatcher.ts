import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from './logger';

interface FileSnapshot {
    path: string;
    size: number;
    modifiedTime: number;
}

export class FileWatcher {
    private watchers: vscode.FileSystemWatcher[] = [];
    private logger: Logger;
    private isWatching = false;
    private statusBarItem: vscode.StatusBarItem;
    private fileSnapshots: Map<string, FileSnapshot> = new Map();
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private debounceDelay = 300; // мс

    constructor(
        private context: vscode.ExtensionContext,
        logger: Logger
    ) {
        this.logger = logger;

        // Создаём элемент в статус-баре
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'fileWatcherLogger.showLog';
        this.updateStatusBar();
        this.statusBarItem.show();
        context.subscriptions.push(this.statusBarItem);
    }

    /**
     * Обновляет статус-бар
     */
    private updateStatusBar(): void {
        if (this.isWatching) {
            const stats = this.logger.getStats();
            this.statusBarItem.text = `$(eye) Watching (${stats.total} events)`;
            this.statusBarItem.tooltip = `File Watcher Active\n` +
                `Создано: ${stats.creates}\n` +
                `Изменено: ${stats.changes}\n` +
                `Удалено: ${stats.deletes}\n` +
                `Нажмите чтобы открыть лог`;
            this.statusBarItem.backgroundColor = undefined;
        } else {
            this.statusBarItem.text = '$(eye-closed) Watcher Off';
            this.statusBarItem.tooltip = 'File Watcher не активен';
            this.statusBarItem.backgroundColor = new vscode.ThemeColor(
                'statusBarItem.warningBackground'
            );
        }
    }

    /**
     * Получает информацию о файле
     */
    private getFileInfo(filePath: string): string | undefined {
        try {
            const stats = fs.statSync(filePath);
            const sizeKB = (stats.size / 1024).toFixed(2);
            return `размер: ${sizeKB} KB`;
        } catch {
            return undefined;
        }
    }

    /**
     * Создаёт снимок файла
     */
    private takeSnapshot(filePath: string): void {
        try {
            const stats = fs.statSync(filePath);
            this.fileSnapshots.set(filePath, {
                path: filePath,
                size: stats.size,
                modifiedTime: stats.mtimeMs
            });
        } catch {
            // Файл может быть удалён
        }
    }

    /**
     * Вычисляет разницу в размере файла
     */
    private getSizeDiff(filePath: string): string | undefined {
        try {
            const newStats = fs.statSync(filePath);
            const oldSnapshot = this.fileSnapshots.get(filePath);

            if (oldSnapshot) {
                const diff = newStats.size - oldSnapshot.size;
                const sign = diff >= 0 ? '+' : '';
                const diffKB = (diff / 1024).toFixed(2);
                return `${sign}${diffKB} KB (${(newStats.size / 1024).toFixed(2)} KB)`;
            }

            return `размер: ${(newStats.size / 1024).toFixed(2)} KB`;
        } catch {
            return undefined;
        }
    }

    /**
     * Проверяет, нужно ли исключить файл
     */
    private shouldExclude(uri: vscode.Uri): boolean {
        const config = vscode.workspace.getConfiguration('fileWatcherLogger');
        const excludePatterns = config.get<string[]>('excludePatterns', []);
        const filePath = uri.fsPath;

        // Проверяем, не является ли это нашим лог-файлом
        const logFileName = config.get<string>('logFilePath', '.file-watcher.log');
        if (filePath.endsWith(logFileName)) {
            return true;
        }

        for (const pattern of excludePatterns) {
            // Простая проверка паттернов
            const regexPattern = pattern
                .replace(/\*\*/g, '.*')
                .replace(/\*/g, '[^/\\\\]*')
                .replace(/\?/g, '.');

            if (new RegExp(regexPattern).test(filePath)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Debounce для событий файлов (одно изменение может генерировать несколько событий)
     */
    private debounce(filePath: string, callback: () => void): void {
        const existing = this.debounceTimers.get(filePath);
        if (existing) {
            clearTimeout(existing);
        }

        const timer = setTimeout(() => {
            this.debounceTimers.delete(filePath);
            callback();
        }, this.debounceDelay);

        this.debounceTimers.set(filePath, timer);
    }

    /**
     * Запускает отслеживание файлов
     */
    public start(): void {
        if (this.isWatching) {
            this.logger.logWarning('Watcher уже запущен');
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            this.logger.logError('Нет открытого workspace');
            vscode.window.showWarningMessage('File Watcher: Откройте папку для начала отслеживания');
            return;
        }

        const config = vscode.workspace.getConfiguration('fileWatcherLogger');
        const includePattern = config.get<string>('includePatterns', '**/*');

        for (const folder of workspaceFolders) {
            this.logger.logInfo(`Начинаю отслеживание: ${folder.uri.fsPath}`);

            // Создаём RelativePattern для каждой workspace-папки
            const pattern = new vscode.RelativePattern(folder, includePattern);
            const watcher = vscode.workspace.createFileSystemWatcher(pattern);

            // === СОЗДАНИЕ ФАЙЛА ===
            watcher.onDidCreate((uri) => {
                if (this.shouldExclude(uri)) {
                    return;
                }

                this.debounce(`create:${uri.fsPath}`, () => {
                    const fileInfo = this.getFileInfo(uri.fsPath);
                    this.logger.logCreate(uri.fsPath, fileInfo);
                    this.takeSnapshot(uri.fsPath);
                    this.updateStatusBar();
                });
            });

            // === ИЗМЕНЕНИЕ ФАЙЛА ===
            watcher.onDidChange((uri) => {
                if (this.shouldExclude(uri)) {
                    return;
                }

                this.debounce(`change:${uri.fsPath}`, () => {
                    const sizeDiff = this.getSizeDiff(uri.fsPath);
                    this.logger.logChange(uri.fsPath, sizeDiff);
                    this.takeSnapshot(uri.fsPath);
                    this.updateStatusBar();
                });
            });

            // === УДАЛЕНИЕ ФАЙЛА ===
            watcher.onDidDelete((uri) => {
                if (this.shouldExclude(uri)) {
                    return;
                }

                this.debounce(`delete:${uri.fsPath}`, () => {
                    const oldSnapshot = this.fileSnapshots.get(uri.fsPath);
                    const details = oldSnapshot
                        ? `был размер: ${(oldSnapshot.size / 1024).toFixed(2)} KB`
                        : undefined;

                    this.logger.logDelete(uri.fsPath, details);
                    this.fileSnapshots.delete(uri.fsPath);
                    this.updateStatusBar();
                });
            });

            this.watchers.push(watcher);
            this.context.subscriptions.push(watcher);
        }

        // Отслеживаем изменения в документах (дополнительно для открытых файлов)
        const docChangeDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
            if (this.shouldExclude(doc.uri)) {
                return;
            }

            this.debounce(`save:${doc.uri.fsPath}`, () => {
                const lineCount = doc.lineCount;
                const language = doc.languageId;
                const sizeDiff = this.getSizeDiff(doc.uri.fsPath);
                const details = `язык: ${language}, строк: ${lineCount}${sizeDiff ? ', ' + sizeDiff : ''}`;

                this.logger.log(
                    // Используем CHANGE т.к. это сохранение
                    require('./logger').LogLevel.CHANGE,
                    'Файл сохранён',
                    doc.uri.fsPath,
                    details
                );
                this.takeSnapshot(doc.uri.fsPath);
                this.updateStatusBar();
            });
        });

        this.context.subscriptions.push(docChangeDisposable);

        this.isWatching = true;
        this.updateStatusBar();

        this.logger.logInfo(
            `✅ File Watcher запущен. Отслеживается ${workspaceFolders.length} директорий.`
        );

        vscode.window.showInformationMessage('File Watcher: Отслеживание запущено');
    }

    /**
     * Останавливает отслеживание
     */
    public stop(): void {
        if (!this.isWatching) {
            this.logger.logWarning('Watcher уже остановлен');
            return;
        }

        // Очищаем debounce таймеры
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        // Уничтожаем watchers
        for (const watcher of this.watchers) {
            watcher.dispose();
        }
        this.watchers = [];

        this.isWatching = false;
        this.updateStatusBar();

        this.logger.logInfo('⏹ File Watcher остановлен');
        vscode.window.showInformationMessage('File Watcher: Отслеживание остановлено');
    }

    /**
     * Проверяет, активен ли watcher
     */
    public getIsWatching(): boolean {
        return this.isWatching;
    }

    /**
     * Освобождает ресурсы
     */
    public dispose(): void {
        this.stop();
        this.statusBarItem.dispose();
    }
}
