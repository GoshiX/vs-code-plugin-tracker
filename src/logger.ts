import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export enum LogLevel {
    INFO = 'INFO',
    CHANGE = 'CHANGE',
    CREATE = 'CREATE',
    DELETE = 'DELETE',
    RENAME = 'RENAME',
    WARNING = 'WARNING',
    ERROR = 'ERROR'
}

export interface LogEntry {
    timestamp: Date;
    level: LogLevel;
    message: string;
    filePath?: string;
    details?: string;
}

export class Logger {
    private outputChannel: vscode.OutputChannel;
    private logFilePath: string | null = null;
    private logEntries: LogEntry[] = [];
    private writeStream: fs.WriteStream | null = null;
    private maxBufferSize = 100;

    constructor(private context: vscode.ExtensionContext) {
        this.outputChannel = vscode.window.createOutputChannel('File Watcher Logger', 'log');
        this.setupLogFile();
    }

    /**
     * Настраивает файл для логирования
     */
    private setupLogFile(): void {
        const config = vscode.workspace.getConfiguration('fileWatcherLogger');
        const logToFile = config.get<boolean>('logToFile', true);

        if (!logToFile) {
            return;
        }

        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            return;
        }

        const relativePath = config.get<string>('logFilePath', '.file-watcher.log');
        this.logFilePath = path.join(workspaceFolders[0].uri.fsPath, relativePath);

        try {
            this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
            this.writeStream.on('error', (err) => {
                console.error('File Watcher Logger: Ошибка записи в лог-файл:', err);
                this.writeStream = null;
            });
        } catch (error) {
            console.error('File Watcher Logger: Не удалось создать лог-файл:', error);
        }
    }

    /**
     * Форматирует временную метку
     */
    private formatTimestamp(date: Date): string {
        const config = vscode.workspace.getConfiguration('fileWatcherLogger');
        const format = config.get<string>('timestampFormat', 'full');

        switch (format) {
            case 'time':
                return date.toLocaleTimeString('ru-RU', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    fractionalSecondDigits: 3
                });
            case 'iso':
                return date.toISOString();
            case 'full':
            default:
                return date.toLocaleString('ru-RU', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit'
                });
        }
    }

    /**
     * Возвращает иконку для типа события
     */
    private getIcon(level: LogLevel): string {
        switch (level) {
            case LogLevel.CREATE: return '✅';
            case LogLevel.CHANGE: return '📝';
            case LogLevel.DELETE: return '❌';
            case LogLevel.RENAME: return '📋';
            case LogLevel.WARNING: return '⚠️';
            case LogLevel.ERROR: return '🔴';
            case LogLevel.INFO: return 'ℹ️';
            default: return '📌';
        }
    }

    /**
     * Форматирует сообщение для вывода
     */
    private formatMessage(entry: LogEntry): string {
        const timestamp = this.formatTimestamp(entry.timestamp);
        const icon = this.getIcon(entry.level);
        const relativePath = entry.filePath
            ? this.getRelativePath(entry.filePath)
            : '';

        let message = `[${timestamp}] ${icon} [${entry.level}]`;

        if (relativePath) {
            message += ` ${relativePath}`;
        }

        message += ` — ${entry.message}`;

        if (entry.details) {
            message += ` (${entry.details})`;
        }

        return message;
    }

    /**
     * Возвращает относительный путь к файлу
     */
    private getRelativePath(filePath: string): string {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return filePath;
        }

        for (const folder of workspaceFolders) {
            const folderPath = folder.uri.fsPath;
            if (filePath.startsWith(folderPath)) {
                return path.relative(folderPath, filePath);
            }
        }

        return filePath;
    }

    /**
     * Записывает лог
     */
    public log(level: LogLevel, message: string, filePath?: string, details?: string): void {
        const entry: LogEntry = {
            timestamp: new Date(),
            level,
            message,
            filePath,
            details
        };

        // Сохраняем в буфер
        this.logEntries.push(entry);
        if (this.logEntries.length > this.maxBufferSize * 10) {
            this.logEntries = this.logEntries.slice(-this.maxBufferSize * 5);
        }

        const formattedMessage = this.formatMessage(entry);

        // Вывод в Output Channel
        this.outputChannel.appendLine(formattedMessage);

        // Запись в файл
        if (this.writeStream) {
            this.writeStream.write(formattedMessage + '\n');
        }
    }

    /**
     * Логирует создание файла
     */
    public logCreate(filePath: string, details?: string): void {
        this.log(LogLevel.CREATE, 'Файл создан', filePath, details);
    }

    /**
     * Логирует изменение файла
     */
    public logChange(filePath: string, details?: string): void {
        this.log(LogLevel.CHANGE, 'Файл изменён', filePath, details);
    }

    /**
     * Логирует удаление файла
     */
    public logDelete(filePath: string, details?: string): void {
        this.log(LogLevel.DELETE, 'Файл удалён', filePath, details);
    }

    /**
     * Логирует информацию
     */
    public logInfo(message: string): void {
        this.log(LogLevel.INFO, message);
    }

    /**
     * Логирует предупреждение
     */
    public logWarning(message: string): void {
        this.log(LogLevel.WARNING, message);
    }

    /**
     * Логирует ошибку
     */
    public logError(message: string): void {
        this.log(LogLevel.ERROR, message);
    }

    /**
     * Показывает панель с логами
     */
    public show(): void {
        this.outputChannel.show(true);
    }

    /**
     * Очищает логи
     */
    public clear(): void {
        this.outputChannel.clear();
        this.logEntries = [];

        // Очищаем файл логов
        if (this.logFilePath && fs.existsSync(this.logFilePath)) {
            try {
                // Закрываем текущий стрим
                if (this.writeStream) {
                    this.writeStream.end();
                }
                // Очищаем файл
                fs.writeFileSync(this.logFilePath, '');
                // Открываем новый стрим
                this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
            } catch (error) {
                console.error('Ошибка очистки лог-файла:', error);
            }
        }

        this.logInfo('Логи очищены');
    }

    /**
     * Возвращает все записи логов
     */
    public getEntries(): LogEntry[] {
        return [...this.logEntries];
    }

    /**
     * Возвращает статистику
     */
    public getStats(): { creates: number; changes: number; deletes: number; total: number } {
        const stats = {
            creates: 0,
            changes: 0,
            deletes: 0,
            total: this.logEntries.length
        };

        for (const entry of this.logEntries) {
            switch (entry.level) {
                case LogLevel.CREATE: stats.creates++; break;
                case LogLevel.CHANGE: stats.changes++; break;
                case LogLevel.DELETE: stats.deletes++; break;
            }
        }

        return stats;
    }

    /**
     * Освобождает ресурсы
     */
    public dispose(): void {
        if (this.writeStream) {
            this.writeStream.end();
            this.writeStream = null;
        }
        this.outputChannel.dispose();
    }
}
