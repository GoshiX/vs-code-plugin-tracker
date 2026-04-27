import * as vscode from 'vscode';
import { Logger } from './logger';
import { FileWatcher } from './fileWatcher';

let logger: Logger;
let fileWatcher: FileWatcher;

export function activate(context: vscode.ExtensionContext) {
    console.log('File Watcher Logger активирован');

    // Создаём логгер
    logger = new Logger(context);

    // Создаём наблюдатель за файлами
    fileWatcher = new FileWatcher(context, logger);

    // === Регистрация команд ===

    // Команда: Начать отслеживание
    const startCommand = vscode.commands.registerCommand(
        'fileWatcherLogger.start',
        () => {
            fileWatcher.start();
        }
    );

    // Команда: Остановить отслеживание
    const stopCommand = vscode.commands.registerCommand(
        'fileWatcherLogger.stop',
        () => {
            fileWatcher.stop();
        }
    );

    // Команда: Показать лог
    const showLogCommand = vscode.commands.registerCommand(
        'fileWatcherLogger.showLog',
        () => {
            logger.show();
        }
    );

    // Команда: Очистить лог
    const clearLogCommand = vscode.commands.registerCommand(
        'fileWatcherLogger.clearLog',
        async () => {
            const answer = await vscode.window.showWarningMessage(
                'Очистить все логи?',
                'Да',
                'Нет'
            );

            if (answer === 'Да') {
                logger.clear();
                vscode.window.showInformationMessage('Логи очищены');
            }
        }
    );

    // Добавляем команды в подписки
    context.subscriptions.push(startCommand);
    context.subscriptions.push(stopCommand);
    context.subscriptions.push(showLogCommand);
    context.subscriptions.push(clearLogCommand);

    // Отслеживаем изменения конфигурации
    const configChangeDisposable = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('fileWatcherLogger')) {
            logger.logInfo('Конфигурация File Watcher изменена');

            // Перезапускаем watcher при изменении настроек
            if (fileWatcher.getIsWatching()) {
                logger.logInfo('Перезапуск watcher с новыми настройками...');
                fileWatcher.stop();
                fileWatcher.start();
            }
        }
    });
    context.subscriptions.push(configChangeDisposable);

    // Автозапуск если настроено
    const config = vscode.workspace.getConfiguration('fileWatcherLogger');
    if (config.get<boolean>('autoStart', true)) {
        fileWatcher.start();
        logger.show();
    }

    logger.logInfo('🚀 Расширение File Watcher Logger загружено');
}

export function deactivate() {
    if (fileWatcher) {
        fileWatcher.dispose();
    }
    if (logger) {
        logger.logInfo('Расширение деактивировано');
        logger.dispose();
    }
}
