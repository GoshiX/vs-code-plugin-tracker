import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const EXCLUDED_NAMES = new Set([
    '.git',
    'node_modules',
    'out',
    '.DS_Store'
]);

export async function ensureDir(dirPath: string): Promise<void> {
    await fs.promises.mkdir(dirPath, { recursive: true });
}

export async function pathExists(targetPath: string): Promise<boolean> {
    try {
        await fs.promises.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
    await ensureDir(path.dirname(filePath));
    await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson<T>(filePath: string): Promise<T> {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
}

export function expandUserPath(inputPath: string): string {
    if (!inputPath.startsWith('~/')) {
        return inputPath;
    }

    return path.join(os.homedir(), inputPath.slice(2));
}

export async function removeDir(targetPath: string): Promise<void> {
    await fs.promises.rm(targetPath, { force: true, recursive: true });
}

export async function listDirectories(dirPath: string): Promise<string[]> {
    if (!(await pathExists(dirPath))) {
        return [];
    }

    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dirPath, entry.name));
}

export async function copyDirectorySnapshot(sourceDir: string, targetDir: string): Promise<void> {
    await ensureDir(targetDir);
    const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
        if (EXCLUDED_NAMES.has(entry.name)) {
            continue;
        }

        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);

        if (entry.isDirectory()) {
            await copyDirectorySnapshot(sourcePath, targetPath);
            continue;
        }

        if (entry.isFile()) {
            await ensureDir(path.dirname(targetPath));
            await fs.promises.copyFile(sourcePath, targetPath);
        }
    }
}

export function sha256Buffer(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function isGitUrl(value: string): boolean {
    return /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(value);
}

export function normalizePathForComparison(value: string): string {
    return path.resolve(value);
}

export function toRelativePath(rootPath: string, filePath: string): string {
    return path.relative(rootPath, filePath).split(path.sep).join('/');
}
