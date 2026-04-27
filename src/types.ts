export type SessionStatus = 'idle' | 'running' | 'finished' | 'failed';

export type TrackerEventType =
    | 'session_started'
    | 'session_finished'
    | 'file_opened'
    | 'editor_switched'
    | 'text_inserted'
    | 'text_deleted'
    | 'text_replaced'
    | 'text_selected'
    | 'file_saved'
    | 'file_created'
    | 'file_deleted'
    | 'file_renamed'
    | 'terminal_opened'
    | 'terminal_closed'
    | 'command_executed'
    | 'paste_detected'
    | 'undo_executed'
    | 'redo_executed';

export interface SessionStartInput {
    assignmentId: string;
    studentId: string;
    repoUrlOrPath: string;
}

export interface SessionEncryptionMetadata {
    algorithm: 'AES-256-GCM';
    secretStorageKey: string;
    fileName: 'events.jsonl.enc';
    metaFileName: 'events.meta.json';
}

export interface SessionManifest {
    sessionId: string;
    assignmentId: string;
    studentId: string;
    repoUrlOrPath: string;
    workspacePath: string;
    status: SessionStatus;
    startedAt: string;
    finishedAt?: string;
    eventCount: number;
    submissionPath?: string;
    lastEventAt?: string;
    sessionDir: string;
    encryption: SessionEncryptionMetadata;
}

export interface EventMetaFile {
    algorithm: 'AES-256-GCM';
    iv: string;
    authTag: string;
    keyLength: number;
    updatedAt: string;
    eventCount: number;
    sha256: string;
}

export interface TrackerEvent<TPayload = unknown> {
    sessionId: string;
    seq: number;
    ts: string;
    type: TrackerEventType;
    workspacePath: string;
    filePath?: string;
    payload: TPayload;
}

export interface SessionStateSnapshot {
    status: SessionStatus | 'idle';
    activeSession?: SessionManifest;
    adminUrl?: string;
}

export interface SessionDetails {
    manifest: SessionManifest;
    events: TrackerEvent[];
    report: SuspicionReport;
}

export type RiskLevel = 'low' | 'medium' | 'high';

export type SignalSeverity = 'low' | 'medium' | 'high';

export interface SuspicionSignal {
    id: string;
    severity: SignalSeverity;
    score: number;
    title: string;
    description: string;
    evidence: Record<string, unknown>;
}

export interface SuspicionMetrics {
    totalEvents: number;
    totalEditEvents: number;
    totalInsertEvents: number;
    totalDeleteEvents: number;
    totalReplaceEvents: number;
    totalInsertedChars: number;
    totalDeletedChars: number;
    revisionRatio: number;
    insertShare: number;
    largeInsertionCount: number;
    idleLargeInsertionCount: number;
    selectAllLikeCount: number;
    selectAllChainCount: number;
    completedBlockInsertionCount: number;
    longestInsertRun: number;
    backJumpCount: number;
    pasteDetectedCount: number;
    commandPasteCount: number;
    maxSingleInsertionChars: number;
    maxSingleInsertionLines: number;
}

export interface SuspicionReport {
    totalScore: number;
    riskLevel: RiskLevel;
    generatedAt: string;
    metrics: SuspicionMetrics;
    signals: SuspicionSignal[];
}

export interface SessionListItem {
    manifest: SessionManifest;
    report: SuspicionReport;
}
