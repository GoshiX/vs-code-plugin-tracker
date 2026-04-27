import * as http from 'http';
import * as vscode from 'vscode';
import { SessionDetails, SessionListItem } from './types';

type SessionListProvider = () => Promise<SessionListItem[]>;
type SessionDetailsProvider = (sessionId: string) => Promise<SessionDetails | undefined>;

export class AdminServer {
    private server: http.Server | undefined;
    private port: number | undefined;

    constructor(
        private readonly listSessions: SessionListProvider,
        private readonly getSessionDetails: SessionDetailsProvider
    ) {}

    public async ensureStarted(): Promise<string> {
        if (this.server && this.port) {
            return this.getBaseUrl();
        }

        this.server = http.createServer((request, response) => {
            void this.handleRequest(request, response);
        });

        await new Promise<void>((resolve, reject) => {
            this.server?.once('error', reject);
            this.server?.listen(0, '127.0.0.1', () => resolve());
        });

        const address = this.server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Failed to start admin server');
        }

        this.port = address.port;
        return this.getBaseUrl();
    }

    public async openInBrowser(): Promise<string> {
        const url = await this.ensureStarted();
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return url;
    }

    public getUrl(): string | undefined {
        if (!this.port) {
            return undefined;
        }

        return this.getBaseUrl();
    }

    public async dispose(): Promise<void> {
        if (!this.server) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.server?.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });

        this.server = undefined;
        this.port = undefined;
    }

    private getBaseUrl(): string {
        return `http://127.0.0.1:${this.port ?? 0}`;
    }

    private async handleRequest(
        request: http.IncomingMessage,
        response: http.ServerResponse
    ): Promise<void> {
        try {
            const requestUrl = new URL(request.url ?? '/', this.getBaseUrl());
            const pathname = requestUrl.pathname;

            if (pathname === '/api/sessions') {
                const sessions = await this.listSessions();
                return this.json(response, sessions);
            }

            if (pathname.startsWith('/api/sessions/')) {
                const sessionId = decodeURIComponent(pathname.replace('/api/sessions/', ''));
                const details = await this.getSessionDetails(sessionId);
                if (!details) {
                    return this.notFound(response);
                }

                return this.json(response, details);
            }

            if (pathname === '/' || pathname.startsWith('/sessions/')) {
                return this.html(response, this.renderAppShell());
            }

            return this.notFound(response);
        } catch (error) {
            response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({
                error: error instanceof Error ? error.message : String(error)
            }));
        }
    }

    private json(response: http.ServerResponse, value: unknown): void {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(value));
    }

    private html(response: http.ServerResponse, body: string): void {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(body);
    }

    private notFound(response: http.ServerResponse): void {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not found');
    }

    private renderAppShell(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Админ-панель трекера</title>
  <style>
    :root {
      --bg: #0f1215;
      --panel: #181c20;
      --panel-soft: #111418;
      --ink: #f3f1eb;
      --muted: #a7a097;
      --line: #2a3036;
      --accent: #75c98b;
      --accent-soft: rgba(117, 201, 139, 0.14);
      --warning: #f3c980;
      --warning-soft: rgba(243, 201, 128, 0.16);
      --danger: #f1a2a2;
      --danger-soft: rgba(241, 162, 162, 0.16);
      --shadow: 0 16px 40px rgba(0, 0, 0, 0.26);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Georgia, "Times New Roman", serif;
      background:
        radial-gradient(circle at top right, rgba(117, 201, 139, 0.12), transparent 22%),
        linear-gradient(180deg, #13161a 0%, var(--bg) 100%);
      color: var(--ink);
    }
    .layout {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      display: flex;
      justify-content: space-between;
      gap: 24px;
      align-items: end;
      margin-bottom: 24px;
    }
    h1 { margin: 0; font-size: 40px; }
    .sub { color: var(--muted); max-width: 560px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
    }
    th, td {
      text-align: left;
      padding: 12px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 14px;
    }
    th { color: var(--muted); font-weight: normal; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .pill {
      display: inline-block;
      padding: 4px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
    }
    .pill.failed {
      background: var(--warning-soft);
      color: var(--warning);
    }
    .pill.medium {
      background: var(--warning-soft);
      color: var(--warning);
    }
    .pill.high {
      background: var(--danger-soft);
      color: var(--danger);
    }
    .details {
      display: grid;
      grid-template-columns: 320px 1fr;
      gap: 18px;
      margin-top: 18px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
      font-size: 14px;
    }
    .meta-grid strong {
      display: block;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .filters {
      display: flex;
      gap: 10px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    input, select {
      border: 1px solid var(--line);
      background: var(--panel-soft);
      border-radius: 10px;
      padding: 10px 12px;
      min-width: 180px;
      font: inherit;
      color: var(--ink);
    }
    .timeline {
      max-height: 70vh;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel-soft);
    }
    .event {
      padding: 14px;
      border-bottom: 1px solid var(--line);
    }
    .event:last-child { border-bottom: none; }
    .event-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .event-type {
      font-weight: bold;
      color: var(--ink);
    }
    .event-title {
      font-size: 15px;
      font-weight: bold;
      color: var(--ink);
      margin-bottom: 6px;
    }
    .event-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 12px;
      margin-bottom: 10px;
    }
    .kv {
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
    }
    .kv strong {
      display: block;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .kv span {
      font-size: 13px;
      color: var(--ink);
      word-break: break-word;
    }
    .snippet {
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #0b0e11;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
      color: #d6f5dd;
      white-space: pre-wrap;
      word-break: break-word;
    }
    pre {
      margin: 8px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      background: var(--panel-soft);
      padding: 12px;
      border-radius: 10px;
      border: 1px solid var(--line);
      color: var(--ink);
    }
    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .summary-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: var(--panel);
    }
    .summary-card strong {
      display: block;
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    .summary-card .value {
      font-size: 24px;
    }
    .signals {
      display: grid;
      gap: 12px;
      margin-bottom: 18px;
    }
    .signal {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      background: var(--panel);
    }
    .signal h3 {
      margin: 0 0 6px;
      font-size: 16px;
    }
    .signal-meta {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .signal-evidence {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px 10px;
      margin-top: 10px;
    }
    .table-wrap {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel-soft);
    }
    .section-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }
    .section-title h2 {
      margin: 0;
    }
    .section-title p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
    }
    @media (max-width: 900px) {
      .hero, .details { display: block; }
      .details > * + * { margin-top: 18px; }
      .summary-grid { grid-template-columns: 1fr 1fr; }
      .event-meta, .signal-evidence { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="layout">
    <div class="hero">
      <div>
        <h1>Админ-панель трекера</h1>
        <div class="sub">Локальная read-only панель для просмотра сессий и зашифрованного таймлайна действий.</div>
      </div>
      <div id="location" class="panel"></div>
    </div>
    <div id="app" class="panel">Loading...</div>
  </div>
  <script>
    const app = document.getElementById('app');
    const locationBox = document.getElementById('location');

    const formatDate = (value) => value ? new Date(value).toLocaleString() : '-';
    const escapeHtml = (value) => String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const duration = (startedAt, finishedAt) => {
      if (!startedAt) return '-';
      const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
      const start = new Date(startedAt).getTime();
      const seconds = Math.max(0, Math.floor((end - start) / 1000));
      const minutes = Math.floor(seconds / 60);
      return minutes + 'm ' + (seconds % 60) + 's';
    };

    const statusPill = (status) => '<span class="pill ' + (status === 'failed' ? 'failed' : '') + '">' + escapeHtml(status) + '</span>';
    const riskPill = (level) => '<span class="pill ' + level + '">' + escapeHtml(({ low: 'низкий', medium: 'средний', high: 'высокий' }[level] || level)) + '</span>';
    const encodeValue = (value) => encodeURIComponent(String(value));
    const decodeValue = (value) => value === 'all' ? value : decodeURIComponent(value);
    const humanizeType = (type) => {
      const map = {
        session_started: 'Сессия начата',
        session_finished: 'Сессия завершена',
        file_opened: 'Файл открыт',
        editor_switched: 'Переключение редактора',
        text_inserted: 'Текст вставлен',
        text_deleted: 'Текст удалён',
        text_replaced: 'Текст заменён',
        text_selected: 'Текст выделен',
        file_saved: 'Файл сохранён',
        file_created: 'Файл создан',
        file_deleted: 'Файл удалён',
        file_renamed: 'Файл переименован',
        terminal_opened: 'Терминал открыт',
        terminal_closed: 'Терминал закрыт',
        command_executed: 'Команда выполнена',
        paste_detected: 'Обнаружена вставка',
        undo_executed: 'Выполнен undo',
        redo_executed: 'Выполнен redo'
      };
      return map[type] || type;
    };
    const humanizeSignalTitle = (title) => {
      const map = {
        'Large code insertion': 'Крупная вставка кода',
        'Large insertion after idle period': 'Крупная вставка после паузы',
        'Completed code block insertion': 'Вставка готового блока кода',
        'Select-all copy/paste pattern': 'Паттерн select-all и copy/paste',
        'Select-all-like selection': 'Выделение, похожее на select-all',
        'Very low revision ratio': 'Очень низкая доля правок',
        'Low revision ratio': 'Низкая доля правок',
        'Unnaturally sequential writing pattern': 'Неестественно последовательный паттерн написания'
      };
      return map[title] || title;
    };
    const renderKv = (label, value) => {
      if (value === undefined || value === null || value === '') return '';
      return '<div class="kv"><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(String(value)) + '</span></div>';
    };
    const formatRange = (range) => {
      if (!range || !range.start || !range.end) return '';
      return 'L' + (range.start.line + 1) + ':' + (range.start.character + 1) +
        ' -> L' + (range.end.line + 1) + ':' + (range.end.character + 1);
    };
    const renderEvidenceGrid = (evidence) => {
      const entries = Object.entries(evidence || {}).filter(([, value]) => {
        return value !== undefined && value !== null && value !== '';
      });
      if (entries.length === 0) return '';
      return '<div class="signal-evidence">' + entries.map(([key, value]) => {
        return renderKv(key, typeof value === 'object' ? JSON.stringify(value) : value);
      }).join('') + '</div>';
    };
    const renderEvent = (event) => {
      const payload = event.payload || {};
      const meta = [];
      let snippet = '';

      if (event.filePath) meta.push(renderKv('File', event.filePath));

      if (event.type === 'text_inserted' || event.type === 'text_deleted' || event.type === 'text_replaced') {
        meta.push(renderKv('Inserted chars', payload.insertedLength));
        meta.push(renderKv('Deleted chars', payload.deletedLength));
        meta.push(renderKv('Position', payload.position ? 'L' + (payload.position.line + 1) + ':' + (payload.position.character + 1) : ''));
        meta.push(renderKv('Range', formatRange(payload.range)));
        if (payload.text) {
          snippet = '<div class="snippet">' + escapeHtml(String(payload.text).slice(0, 500)) + '</div>';
        }
      } else if (event.type === 'text_selected') {
        const first = Array.isArray(payload) ? payload[0] : undefined;
        meta.push(renderKv('Selections', Array.isArray(payload) ? payload.length : ''));
        meta.push(renderKv('Range', formatRange(first && first.range)));
        if (first && first.preview) {
          snippet = '<div class="snippet">' + escapeHtml(first.preview) + '</div>';
        }
      } else if (event.type === 'file_opened' || event.type === 'file_saved' || event.type === 'editor_switched') {
        meta.push(renderKv('Language', payload.languageId));
        meta.push(renderKv('Lines', payload.lineCount));
        meta.push(renderKv('Version', payload.version));
      } else if (event.type === 'file_renamed') {
        meta.push(renderKv('Old path', payload.oldPath));
        meta.push(renderKv('New path', payload.newPath));
      } else if (event.type === 'terminal_opened' || event.type === 'terminal_closed') {
        meta.push(renderKv('Terminal', payload.terminalName));
      } else if (event.type === 'command_executed' || event.type === 'paste_detected' || event.type === 'undo_executed' || event.type === 'redo_executed') {
        meta.push(renderKv('Command', payload.commandId));
        meta.push(renderKv('Source', payload.source));
        meta.push(renderKv('Inserted chars', payload.insertedLength));
        meta.push(renderKv('Inserted lines', payload.insertedLines));
      } else if (event.type === 'session_started') {
        meta.push(renderKv('Assignment', payload.assignmentId));
        meta.push(renderKv('Student', payload.studentId));
        meta.push(renderKv('Repository', payload.repoUrlOrPath));
      }

      const fallbackPayload = (!snippet && meta.filter(Boolean).length === 0)
        ? '<pre>' + escapeHtml(JSON.stringify(payload, null, 2)) + '</pre>'
        : '';

      return '<div class="event">' +
        '<div class="event-head">' +
          '<div><span class="event-type">' + escapeHtml(event.type) + '</span></div>' +
          '<div>#' + event.seq + ' / ' + formatDate(event.ts) + '</div>' +
        '</div>' +
        '<div class="event-title">' + escapeHtml(humanizeType(event.type)) + '</div>' +
        '<div class="event-meta">' + meta.filter(Boolean).join('') + '</div>' +
        snippet +
        fallbackPayload +
      '</div>';
    };

    async function renderList() {
      locationBox.textContent = 'Все локальные сессии';
      const response = await fetch('/api/sessions');
      const sessions = await response.json();

      const rows = sessions.map((session) => {
        return '<tr>' +
          '<td><a href="/sessions/' + encodeURIComponent(session.manifest.sessionId) + '">' + escapeHtml(session.manifest.sessionId) + '</a></td>' +
          '<td>' + escapeHtml(session.manifest.assignmentId) + '</td>' +
          '<td>' + escapeHtml(session.manifest.studentId) + '</td>' +
          '<td>' + statusPill(session.manifest.status) + '</td>' +
          '<td>' + riskPill(session.report.riskLevel) + ' / ' + session.report.totalScore + '</td>' +
          '<td>' + formatDate(session.manifest.startedAt) + '</td>' +
          '<td>' + duration(session.manifest.startedAt, session.manifest.finishedAt) + '</td>' +
          '<td>' + session.manifest.eventCount + '</td>' +
        '</tr>';
      }).join('');

      app.innerHTML = '<div class="section-title"><div><h2>Сессии</h2><p>Локальные попытки с эвристической оценкой риска.</p></div></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Session</th><th>Assignment</th><th>Student</th><th>Status</th><th>Риск</th><th>Started</th><th>Duration</th><th>Events</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
    }

    async function renderDetails(sessionId) {
      locationBox.innerHTML = '<a href="/">Назад к списку сессий</a>';
      const response = await fetch('/api/sessions/' + encodeURIComponent(sessionId));
      if (response.status === 404) {
        app.innerHTML = '<h2>Сессия не найдена</h2>';
        return;
      }

      const data = await response.json();
      const typeOptions = ['all'].concat([...new Set(data.events.map((event) => event.type))]);
      const fileOptions = ['all'].concat([...new Set(data.events.map((event) => event.filePath).filter(Boolean))]);
      const metrics = data.report.metrics;
      const signalsHtml = data.report.signals.length
        ? data.report.signals.map((signal) => {
            return '<div class="signal">' +
              '<h3>' + escapeHtml(humanizeSignalTitle(signal.title)) + '</h3>' +
              '<div class="signal-meta">' +
                '<span>' + riskPill(signal.severity) + '</span>' +
                '<span>Score: ' + signal.score + '</span>' +
                '<span>ID: ' + escapeHtml(signal.id) + '</span>' +
              '</div>' +
              '<div>' + escapeHtml(signal.description) + '</div>' +
              renderEvidenceGrid(signal.evidence) +
            '</div>';
          }).join('')
        : '<div class="signal"><h3>Сигналы риска не обнаружены</h3><div>Ни одна эвристика не превысила текущие пороги.</div></div>';

      app.innerHTML = '<h2>Сессия ' + escapeHtml(data.manifest.sessionId) + '</h2>' +
        '<div class="summary-grid">' +
          '<div class="summary-card"><strong>Уровень риска</strong><div class="value">' + riskPill(data.report.riskLevel) + '</div></div>' +
          '<div class="summary-card"><strong>Суммарный score</strong><div class="value">' + data.report.totalScore + '</div></div>' +
          '<div class="summary-card"><strong>Сигналы</strong><div class="value">' + data.report.signals.length + '</div></div>' +
          '<div class="summary-card"><strong>Самая крупная вставка</strong><div class="value">' + metrics.maxSingleInsertionChars + ' chars</div></div>' +
        '</div>' +
        '<div class="details">' +
          '<div class="panel">' +
            '<div class="meta-grid">' +
              '<div><strong>Задание</strong>' + escapeHtml(data.manifest.assignmentId) + '</div>' +
              '<div><strong>Студент</strong>' + escapeHtml(data.manifest.studentId) + '</div>' +
              '<div><strong>Статус</strong>' + statusPill(data.manifest.status) + '</div>' +
              '<div><strong>Рабочая папка</strong>' + escapeHtml(data.manifest.workspacePath) + '</div>' +
              '<div><strong>Пакет сдачи</strong>' + escapeHtml(data.manifest.submissionPath || '-') + '</div>' +
              '<div><strong>Начало</strong>' + formatDate(data.manifest.startedAt) + '</div>' +
              '<div><strong>Завершение</strong>' + formatDate(data.manifest.finishedAt) + '</div>' +
              '<div><strong>События</strong>' + data.manifest.eventCount + '</div>' +
              '<div><strong>Revision ratio</strong>' + metrics.revisionRatio + '</div>' +
              '<div><strong>Insert share</strong>' + metrics.insertShare + '</div>' +
              '<div><strong>Large insertions</strong>' + metrics.largeInsertionCount + '</div>' +
              '<div><strong>Idle + insertions</strong>' + metrics.idleLargeInsertionCount + '</div>' +
              '<div><strong>Select-all chains</strong>' + metrics.selectAllChainCount + '</div>' +
              '<div><strong>Longest insert run</strong>' + metrics.longestInsertRun + '</div>' +
            '</div>' +
          '</div>' +
          '<div>' +
            '<div class="signals">' + signalsHtml + '</div>' +
            '<div class="filters">' +
              '<select id="typeFilter">' + typeOptions.map((value) => '<option value="' + encodeValue(value) + '">' + escapeHtml(value) + '</option>').join('') + '</select>' +
              '<select id="fileFilter">' + fileOptions.map((value) => '<option value="' + encodeValue(value) + '">' + escapeHtml(value) + '</option>').join('') + '</select>' +
            '</div>' +
            '<div id="timeline" class="timeline"></div>' +
          '</div>' +
        '</div>';

      const timeline = document.getElementById('timeline');
      const typeFilter = document.getElementById('typeFilter');
      const fileFilter = document.getElementById('fileFilter');

      const draw = () => {
        const typeValue = decodeValue(typeFilter.value);
        const fileValue = decodeValue(fileFilter.value);
        const filtered = data.events.filter((event) => {
          const typeMatch = typeValue === 'all' || event.type === typeValue;
          const fileMatch = fileValue === 'all' || event.filePath === fileValue;
          return typeMatch && fileMatch;
        });

        timeline.innerHTML = filtered.length
          ? filtered.map((event) => renderEvent(event)).join('')
          : '<div class="event"><div class="event-title">Нет событий, подходящих под выбранные фильтры.</div></div>';
      };

      typeFilter.addEventListener('change', draw);
      fileFilter.addEventListener('change', draw);
      draw();
    }

    if (location.pathname === '/') {
      renderList();
    } else {
      renderDetails(location.pathname.replace('/sessions/', ''));
    }
  </script>
</body>
</html>`;
    }
}
