import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ensureDir, pathExists, readJson, sha256Buffer, writeJson } from './fsUtils';
import {
    EventMetaFile,
    SessionManifest,
    TrackerEvent,
    TrackerEventType
} from './types';

type EventAppendInput = {
    type: TrackerEventType;
    filePath?: string;
    payload?: unknown;
    ts?: string;
};

export class EventLogger {
    private readonly events: TrackerEvent[] = [];
    private readonly encryptedLogPath: string;
    private readonly metaFilePath: string;
    private readonly secretStorageKey: string;

    private constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly manifest: SessionManifest
    ) {
        this.encryptedLogPath = path.join(
            manifest.sessionDir,
            manifest.encryption.fileName
        );
        this.metaFilePath = path.join(
            manifest.sessionDir,
            manifest.encryption.metaFileName
        );
        this.secretStorageKey = manifest.encryption.secretStorageKey;
    }

    public static async create(
        context: vscode.ExtensionContext,
        manifest: SessionManifest
    ): Promise<EventLogger> {
        const logger = new EventLogger(context, manifest);
        const key = crypto.randomBytes(32).toString('base64');
        await ensureDir(manifest.sessionDir);
        await context.secrets.store(manifest.encryption.secretStorageKey, key);
        await logger.persist();
        return logger;
    }

    public static async load(
        context: vscode.ExtensionContext,
        manifest: SessionManifest
    ): Promise<EventLogger> {
        const logger = new EventLogger(context, manifest);
        await logger.loadEvents();
        return logger;
    }

    public async append(input: EventAppendInput): Promise<TrackerEvent> {
        const event: TrackerEvent = {
            sessionId: this.manifest.sessionId,
            seq: this.events.length + 1,
            ts: input.ts ?? new Date().toISOString(),
            type: input.type,
            workspacePath: this.manifest.workspacePath,
            filePath: input.filePath,
            payload: input.payload ?? {}
        };

        this.events.push(event);
        await this.persist();
        return event;
    }

    public getEventCount(): number {
        return this.events.length;
    }

    public getEvents(): TrackerEvent[] {
        return [...this.events];
    }

    public async exportFiles(targetDir: string): Promise<void> {
        await ensureDir(targetDir);
        await fs.promises.copyFile(
            this.encryptedLogPath,
            path.join(targetDir, this.manifest.encryption.fileName)
        );
        await fs.promises.copyFile(
            this.metaFilePath,
            path.join(targetDir, this.manifest.encryption.metaFileName)
        );
    }

    public async dispose(): Promise<void> {
        await this.persist();
    }

    private async loadEvents(): Promise<void> {
        if (!(await pathExists(this.encryptedLogPath)) || !(await pathExists(this.metaFilePath))) {
            return;
        }

        const key = await this.getKey();
        const meta = await readJson<EventMetaFile>(this.metaFilePath);
        const encrypted = await fs.promises.readFile(this.encryptedLogPath);
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            key,
            Buffer.from(meta.iv, 'base64')
        );
        decipher.setAuthTag(Buffer.from(meta.authTag, 'base64'));

        const decrypted = Buffer.concat([
            decipher.update(encrypted),
            decipher.final()
        ]).toString('utf8');

        const parsed = decrypted
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => JSON.parse(line) as TrackerEvent);

        this.events.splice(0, this.events.length, ...parsed);
    }

    private async persist(): Promise<void> {
        await ensureDir(this.manifest.sessionDir);
        const key = await this.getKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const raw = this.events.map((event) => JSON.stringify(event)).join('\n');
        const encrypted = Buffer.concat([
            cipher.update(raw, 'utf8'),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();

        await fs.promises.writeFile(this.encryptedLogPath, encrypted);

        const meta: EventMetaFile = {
            algorithm: 'AES-256-GCM',
            iv: iv.toString('base64'),
            authTag: authTag.toString('base64'),
            keyLength: 32,
            updatedAt: new Date().toISOString(),
            eventCount: this.events.length,
            sha256: sha256Buffer(encrypted)
        };

        await writeJson(this.metaFilePath, meta);
    }

    private async getKey(): Promise<Buffer> {
        const stored = await this.context.secrets.get(this.secretStorageKey);
        if (!stored) {
            throw new Error(`Missing encryption key for session ${this.manifest.sessionId}`);
        }

        return Buffer.from(stored, 'base64');
    }
}
