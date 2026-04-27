import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { ActivityTracker } from './activityTracker';
import { AdminServer } from './adminServer';
import { EventLogger } from './eventLogger';
import {
    copyDirectorySnapshot,
    ensureDir,
    expandUserPath,
    isGitUrl,
    listDirectories,
    normalizePathForComparison,
    pathExists,
    readJson,
    removeDir,
    writeJson
} from './fsUtils';
import { SuspicionAnalyzer } from './suspicionAnalyzer';
import {
    SessionDetails,
    SessionListItem,
    SessionManifest,
    SessionStartInput,
    SessionStateSnapshot
} from './types';

type SessionStateListener = (snapshot: SessionStateSnapshot) => void;

const ACTIVE_SESSION_KEY = 'tracker.activeSessionId';

export class SessionService implements vscode.Disposable {
    private readonly listeners = new Set<SessionStateListener>();
    private readonly output = vscode.window.createOutputChannel('Tracker MVP');
    private readonly sessionsRoot: string;
    private readonly workspacesRoot: string;
    private readonly submissionsRoot: string;
    private activeManifest: SessionManifest | undefined;
    private eventLogger: EventLogger | undefined;
    private tracker: ActivityTracker | undefined;
    private adminServer: AdminServer | undefined;
    private readonly suspicionAnalyzer = new SuspicionAnalyzer();

    constructor(private readonly context: vscode.ExtensionContext) {
        const basePath = context.globalStorageUri.fsPath;
        this.sessionsRoot = path.join(basePath, 'sessions');
        this.workspacesRoot = path.join(basePath, 'workspaces');
        this.submissionsRoot = path.join(basePath, 'submissions');
    }

    public async initialize(): Promise<void> {
        await ensureDir(this.context.globalStorageUri.fsPath);
        await ensureDir(this.sessionsRoot);
        await ensureDir(this.workspacesRoot);
        await ensureDir(this.submissionsRoot);
        await this.resumeRunningSessionIfNeeded();
    }

    public onDidChangeState(listener: SessionStateListener): vscode.Disposable {
        this.listeners.add(listener);
        return new vscode.Disposable(() => {
            this.listeners.delete(listener);
        });
    }

    public getStateSnapshot(): SessionStateSnapshot {
        return {
            status: this.activeManifest?.status ?? 'idle',
            activeSession: this.activeManifest,
            adminUrl: this.adminServer?.getUrl()
        };
    }

    public async startSession(input: SessionStartInput): Promise<void> {
        if (this.activeManifest?.status === 'running') {
            void vscode.window.showWarningMessage('Другая сессия уже запущена.');
            return;
        }

        const assignmentId = input.assignmentId.trim();
        const studentId = input.studentId.trim();
        const repoUrlOrPath = input.repoUrlOrPath.trim();

        if (!assignmentId || !studentId || !repoUrlOrPath) {
            void vscode.window.showErrorMessage(
                'Нужно заполнить ID задания, ID студента и путь к репозиторию.'
            );
            return;
        }

        const sessionId = this.buildSessionId(assignmentId, studentId);
        const sessionDir = path.join(this.sessionsRoot, sessionId);
        const workspacePath = path.join(this.workspacesRoot, sessionId, 'repo');
        const normalizedRepo = this.normalizeRepositoryReference(repoUrlOrPath);

        await removeDir(sessionDir);
        await removeDir(path.dirname(workspacePath));
        await ensureDir(sessionDir);
        await ensureDir(path.dirname(workspacePath));

        const manifest: SessionManifest = {
            sessionId,
            assignmentId,
            studentId,
            repoUrlOrPath: normalizedRepo,
            workspacePath,
            status: 'running',
            startedAt: new Date().toISOString(),
            eventCount: 0,
            sessionDir,
            encryption: {
                algorithm: 'AES-256-GCM',
                secretStorageKey: `tracker.sessionKey.${sessionId}`,
                fileName: 'events.jsonl.enc',
                metaFileName: 'events.meta.json'
            }
        };

        this.activeManifest = manifest;
        await this.persistManifest(manifest);
        await this.context.globalState.update(ACTIVE_SESSION_KEY, sessionId);
        this.notifyState();

        try {
            await this.cloneRepository(normalizedRepo, workspacePath);
            this.eventLogger = await EventLogger.create(this.context, manifest);
            await this.eventLogger.append({
                type: 'session_started',
                payload: {
                    assignmentId,
                    studentId,
                    repoUrlOrPath: normalizedRepo
                }
            });
            await this.refreshManifestCounters();

            const answer = await vscode.window.showInformationMessage(
                'Репозиторий клонирован. Открыть клонированную папку сейчас?',
                'Открыть папку',
                'Позже'
            );

            if (answer === 'Открыть папку') {
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.file(workspacePath),
                    false
                );
                return;
            }

            void vscode.window.showWarningMessage(
                'Сессия создана. Откройте клонированную папку, чтобы начать выполнение с отслеживанием.'
            );
            this.notifyState();
        } catch (error) {
            await this.markActiveSessionFailed(this.asErrorMessage(error));
        }
    }

    public async finishSession(): Promise<void> {
        const manifest = await this.ensureActiveManifest();
        if (!manifest) {
            void vscode.window.showInformationMessage('Нет активной сессии для завершения.');
            return;
        }

        if (manifest.status !== 'running') {
            void vscode.window.showWarningMessage(
                'Эта сессия уже завершена или завершилась с ошибкой.'
            );
            return;
        }

        if (this.hasDirtyDocuments(manifest.workspacePath)) {
            const answer = await vscode.window.showWarningMessage(
                'В рабочей папке сессии есть несохранённые файлы. Всё равно завершить?',
                'Всё равно завершить',
                'Отмена'
            );

            if (answer !== 'Всё равно завершить') {
                return;
            }
        }

        this.tracker?.stop();
        this.tracker = undefined;

        this.eventLogger = this.eventLogger ?? await EventLogger.load(this.context, manifest);
        await this.eventLogger.append({
            type: 'session_finished',
            payload: {}
        });

        const submissionPath = path.join(this.submissionsRoot, manifest.sessionId);
        await removeDir(submissionPath);
        await ensureDir(submissionPath);
        await ensureDir(path.join(submissionPath, 'solution'));
        await copyDirectorySnapshot(manifest.workspacePath, path.join(submissionPath, 'solution'));
        await this.eventLogger.exportFiles(submissionPath);

        manifest.status = 'finished';
        manifest.finishedAt = new Date().toISOString();
        manifest.submissionPath = submissionPath;
        await this.refreshManifestCounters();
        await writeJson(path.join(submissionPath, 'manifest.json'), manifest);
        await this.persistManifest(manifest);
        await this.context.globalState.update(ACTIVE_SESSION_KEY, undefined);
        await this.eventLogger.dispose();

        this.activeManifest = undefined;
        this.eventLogger = undefined;
        this.notifyState();
        void vscode.window.showInformationMessage(
            `Сессия завершена. Пакет сдачи сохранён в ${submissionPath}`
        );
    }

    public async openAdminPanel(): Promise<void> {
        if (!this.adminServer) {
            this.adminServer = new AdminServer(
                async () => this.listSessions(),
                async (sessionId) => this.getSessionDetails(sessionId)
            );
        }

        const url = await this.adminServer.openInBrowser();
        this.output.appendLine(`Admin server running at ${url}`);
        this.notifyState();
    }

    public async revealSessionFolder(): Promise<void> {
        const manifest = await this.ensureActiveManifest();
        if (!manifest) {
            void vscode.window.showInformationMessage(
                'Нет активной папки сессии для показа.'
            );
            return;
        }

        await vscode.commands.executeCommand(
            'revealFileInOS',
            vscode.Uri.file(manifest.sessionDir)
        );
    }

    public async listSessions(): Promise<SessionListItem[]> {
        const directories = await listDirectories(this.sessionsRoot);
        const sessions: SessionListItem[] = [];

        for (const directory of directories) {
            const manifestPath = path.join(directory, 'manifest.json');
            if (!(await pathExists(manifestPath))) {
                continue;
            }

            const manifest = await readJson<SessionManifest>(manifestPath);
            const logger = await EventLogger.load(this.context, manifest);
            const events = logger.getEvents();
            const report = this.suspicionAnalyzer.analyze(manifest, events);
            sessions.push({
                manifest,
                report
            });
        }

        sessions.sort((left, right) => right.manifest.startedAt.localeCompare(left.manifest.startedAt));
        return sessions;
    }

    public async getSessionDetails(sessionId: string): Promise<SessionDetails | undefined> {
        const manifest = await this.loadManifest(sessionId);
        if (!manifest) {
            return undefined;
        }

        const logger = await EventLogger.load(this.context, manifest);
        const events = logger.getEvents();
        return {
            manifest,
            events,
            report: this.suspicionAnalyzer.analyze(manifest, events)
        };
    }

    public dispose(): void {
        this.tracker?.stop();
        this.output.dispose();
        void this.eventLogger?.dispose();
        void this.adminServer?.dispose();
    }

    private async resumeRunningSessionIfNeeded(): Promise<void> {
        const activeSessionId = this.context.globalState.get<string>(ACTIVE_SESSION_KEY);
        if (!activeSessionId) {
            return;
        }

        const manifest = await this.loadManifest(activeSessionId);
        if (!manifest || manifest.status !== 'running') {
            await this.context.globalState.update(ACTIVE_SESSION_KEY, undefined);
            return;
        }

        this.activeManifest = manifest;
        this.eventLogger = await EventLogger.load(this.context, manifest);

        if (this.isCurrentWorkspace(manifest.workspacePath)) {
            this.attachTracker(manifest);
            this.notifyState();
            void vscode.window.showInformationMessage(
                `Незавершённая сессия ${manifest.sessionId} восстановлена.`
            );
            return;
        }

        const answer = await vscode.window.showWarningMessage(
            `Найдена незавершённая сессия ${manifest.sessionId}.`,
            'Продолжить',
            'Завершить',
            'Сбросить'
        );

        if (answer === 'Продолжить') {
            const openAnswer = await vscode.window.showInformationMessage(
                'Открыть клонированную рабочую папку этой сессии сейчас?',
                'Открыть папку',
                'Позже'
            );

            if (openAnswer === 'Открыть папку') {
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.file(manifest.workspacePath),
                    false
                );
            }

            this.notifyState();
            return;
        }

        if (answer === 'Завершить') {
            await this.finishSession();
            return;
        }

        if (answer === 'Сбросить') {
            manifest.status = 'failed';
            manifest.finishedAt = new Date().toISOString();
            await this.persistManifest(manifest);
            await this.context.globalState.update(ACTIVE_SESSION_KEY, undefined);
            this.activeManifest = undefined;
            this.eventLogger = undefined;
            this.notifyState();
        }
    }

    private attachTracker(manifest: SessionManifest): void {
        this.tracker?.stop();
        this.tracker = undefined;
        if (!this.eventLogger) {
            return;
        }

        this.tracker = new ActivityTracker(
            manifest,
            this.eventLogger,
            async () => this.refreshManifestCounters()
        );
        this.tracker.start();
    }

    private async ensureActiveManifest(): Promise<SessionManifest | undefined> {
        if (this.activeManifest) {
            if (!this.tracker && this.activeManifest.status === 'running' && this.isCurrentWorkspace(this.activeManifest.workspacePath)) {
                this.eventLogger = this.eventLogger ?? await EventLogger.load(this.context, this.activeManifest);
                this.attachTracker(this.activeManifest);
            }
            return this.activeManifest;
        }

        const activeSessionId = this.context.globalState.get<string>(ACTIVE_SESSION_KEY);
        if (!activeSessionId) {
            return undefined;
        }

        const manifest = await this.loadManifest(activeSessionId);
        if (!manifest) {
            return undefined;
        }

        this.activeManifest = manifest;
        return manifest;
    }

    private async refreshManifestCounters(): Promise<void> {
        if (!this.activeManifest || !this.eventLogger) {
            return;
        }

        this.activeManifest.eventCount = this.eventLogger.getEventCount();
        this.activeManifest.lastEventAt = new Date().toISOString();
        await this.persistManifest(this.activeManifest);
        this.notifyState();
    }

    private async persistManifest(manifest: SessionManifest): Promise<void> {
        await writeJson(path.join(manifest.sessionDir, 'manifest.json'), manifest);
    }

    private async loadManifest(sessionId: string): Promise<SessionManifest | undefined> {
        const manifestPath = path.join(this.sessionsRoot, sessionId, 'manifest.json');
        if (!(await pathExists(manifestPath))) {
            return undefined;
        }

        return readJson<SessionManifest>(manifestPath);
    }

    private normalizeRepositoryReference(repoUrlOrPath: string): string {
        if (isGitUrl(repoUrlOrPath)) {
            return repoUrlOrPath;
        }

        const expanded = expandUserPath(repoUrlOrPath);
        if (path.isAbsolute(expanded)) {
            return normalizePathForComparison(expanded);
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const basePath = workspaceRoot ?? process.cwd();
        return normalizePathForComparison(path.resolve(basePath, expanded));
    }

    private async cloneRepository(repository: string, destination: string): Promise<void> {
        this.output.appendLine(`Cloning ${repository} -> ${destination}`);
        await new Promise<void>((resolve, reject) => {
            cp.execFile(
                'git',
                ['clone', repository, destination],
                { cwd: path.dirname(destination) },
                (error, stdout, stderr) => {
                    if (stdout) {
                        this.output.appendLine(stdout);
                    }

                    if (stderr) {
                        this.output.appendLine(stderr);
                    }

                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }

                    resolve();
                }
            );
        });
    }

    private async markActiveSessionFailed(reason: string): Promise<void> {
        if (!this.activeManifest) {
            return;
        }

        this.output.appendLine(`Session failed: ${reason}`);
        this.activeManifest.status = 'failed';
        this.activeManifest.finishedAt = new Date().toISOString();
        await this.persistManifest(this.activeManifest);
        await this.context.globalState.update(ACTIVE_SESSION_KEY, undefined);
        this.activeManifest = undefined;
        this.eventLogger = undefined;
        this.tracker?.stop();
        this.tracker = undefined;
        this.notifyState();
        void vscode.window.showErrorMessage(reason);
    }

    private hasDirtyDocuments(workspacePath: string): boolean {
        const rootPath = normalizePathForComparison(workspacePath);
        return vscode.workspace.textDocuments.some((document) => {
            if (!document.isDirty || document.uri.scheme !== 'file') {
                return false;
            }

            const filePath = normalizePathForComparison(document.uri.fsPath);
            return filePath === rootPath || filePath.startsWith(`${rootPath}${path.sep}`);
        });
    }

    private isCurrentWorkspace(workspacePath: string): boolean {
        const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!current) {
            return false;
        }

        return normalizePathForComparison(current) === normalizePathForComparison(workspacePath);
    }

    private notifyState(): void {
        const snapshot = this.getStateSnapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }

    private buildSessionId(assignmentId: string, studentId: string): string {
        const slug = [assignmentId, studentId]
            .join('-')
            .toLowerCase()
            .replace(/[^a-z0-9-_]+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');

        return `${slug || 'session'}-${Date.now()}`;
    }

    private asErrorMessage(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }
}
