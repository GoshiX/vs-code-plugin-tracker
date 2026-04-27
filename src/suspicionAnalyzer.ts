import {
    RiskLevel,
    SessionManifest,
    SuspicionMetrics,
    SuspicionReport,
    SuspicionSignal,
    TrackerEvent
} from './types';

type TextEditPayload = {
    text?: string;
    insertedLength?: number;
    deletedLength?: number;
    position?: {
        line?: number;
        character?: number;
    };
    range?: {
        start?: {
            line?: number;
            character?: number;
        };
        end?: {
            line?: number;
            character?: number;
        };
    };
    documentVersion?: number;
};

type SelectionPayloadEntry = {
    range?: {
        start?: {
            line?: number;
            character?: number;
        };
        end?: {
            line?: number;
            character?: number;
        };
    };
    preview?: string;
};

const LARGE_INSERTION_CHAR_THRESHOLD = 120;
const LARGE_INSERTION_LINE_THRESHOLD = 8;
const VERY_LARGE_INSERTION_CHAR_THRESHOLD = 250;
const HUGE_INSERTION_CHAR_THRESHOLD = 500;
const IDLE_MS_THRESHOLD = 20_000;
const LONG_IDLE_MS_THRESHOLD = 60_000;
const SELECT_ALL_LINE_THRESHOLD = 20;
const SELECT_ALL_PREVIEW_THRESHOLD = 150;
const SELECT_ALL_CHAIN_WINDOW_MS = 10_000;

export class SuspicionAnalyzer {
    public analyze(
        manifest: SessionManifest,
        events: TrackerEvent[]
    ): SuspicionReport {
        const sortedEvents = [...events].sort((left, right) => left.seq - right.seq);
        const signals: SuspicionSignal[] = [];
        const metrics = this.initializeMetrics(sortedEvents.length);

        let previousEditLine: number | undefined;
        let insertRun = 0;

        for (let index = 0; index < sortedEvents.length; index += 1) {
            const event = sortedEvents[index];
            const previousEvent = index > 0 ? sortedEvents[index - 1] : undefined;

            switch (event.type) {
                case 'text_inserted': {
                    const payload = this.getTextEditPayload(event.payload);
                    const insertedLength = payload.insertedLength ?? 0;
                    const insertedLines = this.countLines(payload.text);
                    const positionLine = payload.position?.line;

                    metrics.totalEditEvents += 1;
                    metrics.totalInsertEvents += 1;
                    metrics.totalInsertedChars += insertedLength;
                    metrics.maxSingleInsertionChars = Math.max(
                        metrics.maxSingleInsertionChars,
                        insertedLength
                    );
                    metrics.maxSingleInsertionLines = Math.max(
                        metrics.maxSingleInsertionLines,
                        insertedLines
                    );
                    metrics.insertShare = 0;

                    insertRun += 1;
                    metrics.longestInsertRun = Math.max(metrics.longestInsertRun, insertRun);

                    if (
                        typeof positionLine === 'number' &&
                        typeof previousEditLine === 'number' &&
                        positionLine < previousEditLine - 2
                    ) {
                        metrics.backJumpCount += 1;
                    }

                    if (typeof positionLine === 'number') {
                        previousEditLine = positionLine;
                    }

                    const structuralHits = this.countStructuralHits(payload.text ?? '');
                    const isLargeInsertion = this.isLargeInsertion(insertedLength, insertedLines);

                    if (isLargeInsertion) {
                        metrics.largeInsertionCount += 1;
                        const score = this.scoreLargeInsertion(insertedLength, insertedLines, structuralHits);
                        signals.push({
                            id: `large-insertion-${event.seq}`,
                            severity: this.severityFromScore(score),
                            score,
                            title: 'Large code insertion',
                            description: `Inserted ${insertedLength} chars across ${insertedLines} lines in one edit event.`,
                            evidence: {
                                seq: event.seq,
                                filePath: event.filePath ?? null,
                                insertedLength,
                                insertedLines,
                                structuralHits
                            }
                        });
                    }

                    if (
                        previousEvent &&
                        isLargeInsertion &&
                        this.getDeltaMs(previousEvent.ts, event.ts) >= IDLE_MS_THRESHOLD
                    ) {
                        const idleMs = this.getDeltaMs(previousEvent.ts, event.ts);
                        metrics.idleLargeInsertionCount += 1;
                        const score = idleMs >= LONG_IDLE_MS_THRESHOLD && insertedLength >= VERY_LARGE_INSERTION_CHAR_THRESHOLD
                            ? 35
                            : 20;

                        signals.push({
                            id: `idle-large-insertion-${event.seq}`,
                            severity: this.severityFromScore(score),
                            score,
                            title: 'Large insertion after idle period',
                            description: `A large insertion happened after ${Math.round(idleMs / 1000)}s without activity.`,
                            evidence: {
                                seq: event.seq,
                                filePath: event.filePath ?? null,
                                idleMs,
                                insertedLength,
                                insertedLines
                            }
                        });
                    }

                    if (insertedLines >= LARGE_INSERTION_LINE_THRESHOLD && structuralHits >= 3) {
                        metrics.completedBlockInsertionCount += 1;
                        const score = insertedLength >= VERY_LARGE_INSERTION_CHAR_THRESHOLD ? 25 : 15;
                        signals.push({
                            id: `completed-block-${event.seq}`,
                            severity: this.severityFromScore(score),
                            score,
                            title: 'Completed code block insertion',
                            description: 'Inserted text already contains multiple structural code markers.',
                            evidence: {
                                seq: event.seq,
                                filePath: event.filePath ?? null,
                                insertedLength,
                                insertedLines,
                                structuralHits,
                                preview: (payload.text ?? '').slice(0, 200)
                            }
                        });
                    }
                    break;
                }
                case 'text_deleted':
                case 'text_replaced': {
                    const payload = this.getTextEditPayload(event.payload);
                    metrics.totalEditEvents += 1;
                    previousEditLine = payload.position?.line;
                    insertRun = 0;

                    if (event.type === 'text_deleted') {
                        metrics.totalDeleteEvents += 1;
                        metrics.totalDeletedChars += payload.deletedLength ?? 0;
                    } else {
                        metrics.totalReplaceEvents += 1;
                        metrics.totalInsertedChars += payload.insertedLength ?? 0;
                        metrics.totalDeletedChars += payload.deletedLength ?? 0;
                    }
                    break;
                }
                case 'text_selected': {
                    insertRun = 0;
                    const selections = this.getSelectionPayload(event.payload);
                    const selectAllLike = selections.some((selection) => this.isSelectAllLike(selection));
                    if (!selectAllLike) {
                        break;
                    }

                    metrics.selectAllLikeCount += 1;

                    const chained = this.findSelectAllChain(sortedEvents, index);
                    if (chained) {
                        metrics.selectAllChainCount += 1;
                        signals.push({
                            id: `select-all-chain-${event.seq}`,
                            severity: 'medium',
                            score: 20,
                            title: 'Select-all copy/paste pattern',
                            description: 'Large selection was followed by a copy/paste-like action or another large insertion.',
                            evidence: {
                                seq: event.seq,
                                filePath: event.filePath ?? null,
                                nextEventType: chained.type,
                                nextEventSeq: chained.seq,
                                nextFilePath: chained.filePath ?? null
                            }
                        });
                    } else {
                        signals.push({
                            id: `select-all-like-${event.seq}`,
                            severity: 'low',
                            score: 5,
                            title: 'Select-all-like selection',
                            description: 'A selection resembling the whole file was detected.',
                            evidence: {
                                seq: event.seq,
                                filePath: event.filePath ?? null
                            }
                        });
                    }
                    break;
                }
                case 'paste_detected':
                    metrics.pasteDetectedCount += 1;
                    insertRun = 0;
                    break;
                case 'command_executed': {
                    insertRun = 0;
                    const commandId = this.getCommandId(event.payload);
                    if (commandId && /paste|copy|cut/i.test(commandId)) {
                        metrics.commandPasteCount += 1;
                    }
                    break;
                }
                default:
                    insertRun = 0;
                    break;
            }
        }

        metrics.revisionRatio = metrics.totalInsertedChars > 0
            ? metrics.totalDeletedChars / metrics.totalInsertedChars
            : 0;
        metrics.insertShare = metrics.totalEditEvents > 0
            ? metrics.totalInsertEvents / metrics.totalEditEvents
            : 0;
        metrics.revisionRatio = this.round(metrics.revisionRatio);
        metrics.insertShare = this.round(metrics.insertShare);

        const revisionSignal = this.buildLowRevisionSignal(manifest, metrics);
        if (revisionSignal) {
            signals.push(revisionSignal);
        }

        const sequentialSignal = this.buildSequentialSignal(manifest, metrics);
        if (sequentialSignal) {
            signals.push(sequentialSignal);
        }

        const uncappedTotalScore = signals.reduce((sum, signal) => sum + signal.score, 0);
        const totalScore = Math.min(100, uncappedTotalScore);

        return {
            totalScore,
            riskLevel: this.resolveRiskLevel(totalScore),
            generatedAt: new Date().toISOString(),
            metrics,
            signals: signals.sort((left, right) => right.score - left.score)
        };
    }

    private initializeMetrics(totalEvents: number): SuspicionMetrics {
        return {
            totalEvents,
            totalEditEvents: 0,
            totalInsertEvents: 0,
            totalDeleteEvents: 0,
            totalReplaceEvents: 0,
            totalInsertedChars: 0,
            totalDeletedChars: 0,
            revisionRatio: 0,
            insertShare: 0,
            largeInsertionCount: 0,
            idleLargeInsertionCount: 0,
            selectAllLikeCount: 0,
            selectAllChainCount: 0,
            completedBlockInsertionCount: 0,
            longestInsertRun: 0,
            backJumpCount: 0,
            pasteDetectedCount: 0,
            commandPasteCount: 0,
            maxSingleInsertionChars: 0,
            maxSingleInsertionLines: 0
        };
    }

    private buildLowRevisionSignal(
        manifest: SessionManifest,
        metrics: SuspicionMetrics
    ): SuspicionSignal | undefined {
        if (metrics.totalInsertedChars < 400) {
            return undefined;
        }

        if (metrics.revisionRatio < 0.04) {
            return {
                id: `low-revision-${manifest.sessionId}`,
                severity: 'high',
                score: 35,
                title: 'Very low revision ratio',
                description: 'A large amount of code was added with almost no deletions or rewrites.',
                evidence: {
                    totalInsertedChars: metrics.totalInsertedChars,
                    totalDeletedChars: metrics.totalDeletedChars,
                    revisionRatio: this.round(metrics.revisionRatio)
                }
            };
        }

        if (metrics.revisionRatio < 0.08) {
            return {
                id: `low-revision-${manifest.sessionId}`,
                severity: 'medium',
                score: 20,
                title: 'Low revision ratio',
                description: 'The session shows unusually few deletions compared with inserted code.',
                evidence: {
                    totalInsertedChars: metrics.totalInsertedChars,
                    totalDeletedChars: metrics.totalDeletedChars,
                    revisionRatio: this.round(metrics.revisionRatio)
                }
            };
        }

        return undefined;
    }

    private buildSequentialSignal(
        manifest: SessionManifest,
        metrics: SuspicionMetrics
    ): SuspicionSignal | undefined {
        if (metrics.totalEditEvents < 40) {
            return undefined;
        }

        if (
            metrics.insertShare >= 0.85 &&
            metrics.backJumpCount <= 2 &&
            metrics.revisionRatio < 0.08 &&
            metrics.longestInsertRun >= 8
        ) {
            const score = metrics.longestInsertRun >= 12 ? 25 : 15;
            return {
                id: `sequential-writing-${manifest.sessionId}`,
                severity: this.severityFromScore(score),
                score,
                title: 'Unnaturally sequential writing pattern',
                description: 'Most edits were forward-moving insertions with very few jumps back for local iteration.',
                evidence: {
                    insertShare: this.round(metrics.insertShare),
                    backJumpCount: metrics.backJumpCount,
                    longestInsertRun: metrics.longestInsertRun,
                    revisionRatio: this.round(metrics.revisionRatio)
                }
            };
        }

        return undefined;
    }

    private isLargeInsertion(insertedLength: number, insertedLines: number): boolean {
        return insertedLength >= LARGE_INSERTION_CHAR_THRESHOLD ||
            insertedLines >= LARGE_INSERTION_LINE_THRESHOLD;
    }

    private scoreLargeInsertion(
        insertedLength: number,
        insertedLines: number,
        structuralHits: number
    ): number {
        let score = 20;

        if (
            insertedLength >= HUGE_INSERTION_CHAR_THRESHOLD ||
            insertedLines >= 20
        ) {
            score = 55;
        } else if (
            insertedLength >= VERY_LARGE_INSERTION_CHAR_THRESHOLD ||
            insertedLines >= 15
        ) {
            score = 35;
        }

        if (structuralHits >= 3 && score < 55) {
            score += 10;
        }

        return Math.min(score, 65);
    }

    private countStructuralHits(text: string): number {
        if (!text) {
            return 0;
        }

        const patterns = [
            /\bimport\b/g,
            /\bfunction\b/g,
            /\bclass\b/g,
            /\breturn\b/g,
            /\bif\s*\(/g,
            /\bfor\s*\(/g,
            /\bwhile\s*\(/g,
            /\{/g,
            /\}/g
        ];

        return patterns.reduce((sum, pattern) => {
            const matches = text.match(pattern);
            return sum + (matches ? matches.length > 0 ? 1 : 0 : 0);
        }, 0);
    }

    private getDeltaMs(leftTs: string, rightTs: string): number {
        return new Date(rightTs).getTime() - new Date(leftTs).getTime();
    }

    private getTextEditPayload(payload: unknown): TextEditPayload {
        if (!payload || typeof payload !== 'object') {
            return {};
        }

        return payload as TextEditPayload;
    }

    private getSelectionPayload(payload: unknown): SelectionPayloadEntry[] {
        if (!Array.isArray(payload)) {
            return [];
        }

        return payload as SelectionPayloadEntry[];
    }

    private isSelectAllLike(selection: SelectionPayloadEntry): boolean {
        const startLine = selection.range?.start?.line ?? 0;
        const endLine = selection.range?.end?.line ?? 0;
        const previewLength = selection.preview?.length ?? 0;
        return startLine <= 1 &&
            (endLine - startLine >= SELECT_ALL_LINE_THRESHOLD ||
                previewLength >= SELECT_ALL_PREVIEW_THRESHOLD);
    }

    private findSelectAllChain(events: TrackerEvent[], selectionIndex: number): TrackerEvent | undefined {
        const selectionEvent = events[selectionIndex];
        const selectionTime = new Date(selectionEvent.ts).getTime();

        for (let index = selectionIndex + 1; index < events.length; index += 1) {
            const candidate = events[index];
            const deltaMs = new Date(candidate.ts).getTime() - selectionTime;
            if (deltaMs > SELECT_ALL_CHAIN_WINDOW_MS) {
                return undefined;
            }

            if (candidate.type === 'paste_detected') {
                return candidate;
            }

            if (candidate.type === 'command_executed') {
                const commandId = this.getCommandId(candidate.payload);
                if (commandId && /copy|cut|paste/i.test(commandId)) {
                    return candidate;
                }
            }

            if (candidate.type === 'text_inserted') {
                const payload = this.getTextEditPayload(candidate.payload);
                const insertedLength = payload.insertedLength ?? 0;
                const insertedLines = this.countLines(payload.text);
                if (this.isLargeInsertion(insertedLength, insertedLines)) {
                    return candidate;
                }
            }
        }

        return undefined;
    }

    private getCommandId(payload: unknown): string | undefined {
        if (!payload || typeof payload !== 'object') {
            return undefined;
        }

        const commandId = (payload as { commandId?: unknown }).commandId;
        return typeof commandId === 'string' ? commandId : undefined;
    }

    private countLines(text: string | undefined): number {
        if (!text) {
            return 0;
        }

        return text.split('\n').length;
    }

    private severityFromScore(score: number): 'low' | 'medium' | 'high' {
        if (score >= 35) {
            return 'high';
        }

        if (score >= 15) {
            return 'medium';
        }

        return 'low';
    }

    private resolveRiskLevel(totalScore: number): RiskLevel {
        if (totalScore >= 55) {
            return 'high';
        }

        if (totalScore >= 25) {
            return 'medium';
        }

        return 'low';
    }

    private round(value: number): number {
        return Number(value.toFixed(3));
    }
}
