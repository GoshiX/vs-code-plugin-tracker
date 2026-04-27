import * as vscode from 'vscode';
import { SessionService } from './sessionService';
import { SidebarViewProvider } from './sidebarViewProvider';
import { SessionStartInput } from './types';

let sessionService: SessionService | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    sessionService = new SessionService(context);
    await sessionService.initialize();

    const sidebarProvider = new SidebarViewProvider(sessionService);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SidebarViewProvider.viewId,
            sidebarProvider
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tracker.startSession',
            async (input?: SessionStartInput) => {
                if (!input) {
                    void vscode.window.showInformationMessage(
                        'Для запуска сессии используйте боковую панель Трекера.'
                    );
                    return;
                }

                await sessionService?.startSession(input);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tracker.finishSession', async () => {
            await sessionService?.finishSession();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tracker.openAdmin', async () => {
            await sessionService?.openAdminPanel();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('tracker.revealSessionFolder', async () => {
            await sessionService?.revealSessionFolder();
        })
    );

    context.subscriptions.push(sessionService);
}

export function deactivate(): void {
    sessionService?.dispose();
}
