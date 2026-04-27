import * as vscode from 'vscode';
import { SessionService } from './sessionService';

export class SidebarViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewId = 'tracker.sidebar';
    private view: vscode.WebviewView | undefined;

    constructor(private readonly sessionService: SessionService) {
        this.sessionService.onDidChangeState(() => {
            void this.refresh();
        });
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView
    ): void | Thenable<void> {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);
        webviewView.webview.onDidReceiveMessage((message) => {
            void this.onMessage(message);
        });
        void this.refresh();
    }

    private async onMessage(message: { type: string; payload?: unknown }): Promise<void> {
        if (message.type === 'start') {
            await this.sessionService.startSession(message.payload as {
                assignmentId: string;
                studentId: string;
                repoUrlOrPath: string;
            });
            return;
        }

        if (message.type === 'finish') {
            await this.sessionService.finishSession();
            return;
        }

        if (message.type === 'openAdmin') {
            await this.sessionService.openAdminPanel();
        }
    }

    private async refresh(): Promise<void> {
        if (!this.view) {
            return;
        }

        const state = this.sessionService.getStateSnapshot();
        await this.view.webview.postMessage({
            type: 'state',
            payload: state
        });
    }

    private getHtml(webview: vscode.Webview): string {
        const nonce = `${Date.now()}`;
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: #111315;
      --ink: #f4f1ea;
      --muted: #a7a097;
      --accent: #75c98b;
      --accent-strong: #4fb66c;
      --danger-soft: #e2a3a3;
      --line: #2a2e33;
      --panel: #181b1f;
      --input: #0f1215;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 12px;
      color: var(--ink);
      background:
        radial-gradient(circle at top right, rgba(117, 201, 139, 0.12), transparent 28%),
        linear-gradient(180deg, #13161a 0%, var(--bg) 100%);
      font-family: Georgia, "Times New Roman", serif;
    }
    .stack { display: grid; gap: 10px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 12px;
    }
    h1 {
      margin: 0 0 4px;
      font-size: 22px;
    }
    p {
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    label {
      display: block;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 3px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 9px 11px;
      background: var(--input);
      color: var(--ink);
      font: inherit;
    }
    input::placeholder {
      color: #6f766e;
    }
    button {
      width: 100%;
      border: none;
      border-radius: 999px;
      padding: 10px 14px;
      font: inherit;
      cursor: pointer;
      transition: background 120ms ease, opacity 120ms ease;
    }
    .primary {
      background: var(--accent);
      color: #0f1b12;
    }
    .secondary {
      background: var(--danger-soft);
      color: #3b1111;
    }
    .muted {
      background: #20252a;
      border: 1px solid var(--line);
      color: var(--ink);
    }
    .status {
      font-size: 13px;
      color: var(--muted);
      white-space: pre-wrap;
      line-height: 1.5;
    }
    .status-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }
    .status-title strong {
      font-size: 13px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--ink);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #13181c;
    }
    .badge.running {
      color: #98e6ab;
      background: rgba(79, 182, 108, 0.12);
      border-color: rgba(79, 182, 108, 0.35);
    }
    .badge.idle {
      color: #b7b1a8;
    }
    .status-meta {
      display: grid;
      gap: 6px;
    }
    .status-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      align-items: baseline;
      font-size: 12px;
    }
    .status-row span:first-child {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .status-row span:last-child {
      color: var(--ink);
      text-align: right;
      word-break: break-word;
    }
    .button-stack {
      display: grid;
      gap: 8px;
    }
    button:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .primary:hover {
      background: var(--accent-strong);
    }
    .primary:disabled:hover {
      background: var(--accent);
    }
  </style>
</head>
<body>
  <div class="stack">
    <div class="panel">
      <h1>Трекер MVP</h1>
      <p>Локальная сессия выполнения с зашифрованным журналом действий и админ-панелью.</p>
    </div>
    <div class="panel stack">
      <div>
        <label for="assignmentId">ID задания</label>
        <input id="assignmentId" placeholder="task-001" />
      </div>
      <div>
        <label for="studentId">ID студента</label>
        <input id="studentId" placeholder="student-42" />
      </div>
      <div>
        <label for="repoUrlOrPath">URL репозитория или локальный путь</label>
        <input id="repoUrlOrPath" placeholder="/Users/me/templates/task-001 или https://..." />
      </div>
      <div class="button-stack">
        <button id="startButton" class="primary">Начать</button>
        <button id="finishButton" class="secondary">Завершить</button>
        <button id="adminButton" class="muted">Открыть админ-панель</button>
      </div>
    </div>
    <div class="panel">
      <div class="status-title">
        <strong>Состояние сессии</strong>
        <span id="statusBadge" class="badge idle">Нет активной сессии</span>
      </div>
      <div id="status" class="status">Нет активной сессии.</div>
      <div id="statusMeta" class="status-meta" hidden></div>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const assignmentId = document.getElementById('assignmentId');
    const studentId = document.getElementById('studentId');
    const repoUrlOrPath = document.getElementById('repoUrlOrPath');
    const status = document.getElementById('status');
    const statusMeta = document.getElementById('statusMeta');
    const statusBadge = document.getElementById('statusBadge');
    const startButton = document.getElementById('startButton');
    const finishButton = document.getElementById('finishButton');

    const setDisabledState = (isRunning) => {
      assignmentId.disabled = isRunning;
      studentId.disabled = isRunning;
      repoUrlOrPath.disabled = isRunning;
      startButton.disabled = isRunning;
      finishButton.disabled = !isRunning;
    };

    const renderMetaRow = (label, value) => {
      return '<div class="status-row"><span>' + label + '</span><span>' + value + '</span></div>';
    };

    startButton.addEventListener('click', () => {
      vscode.postMessage({
        type: 'start',
        payload: {
          assignmentId: assignmentId.value,
          studentId: studentId.value,
          repoUrlOrPath: repoUrlOrPath.value
        }
      });
    });

    finishButton.addEventListener('click', () => {
      vscode.postMessage({ type: 'finish' });
    });

    document.getElementById('adminButton').addEventListener('click', () => {
      vscode.postMessage({ type: 'openAdmin' });
    });

    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type !== 'state') {
        return;
      }

      const payload = message.payload;
      if (!payload.activeSession) {
        setDisabledState(false);
        statusBadge.textContent = 'Нет активной сессии';
        statusBadge.className = 'badge idle';
        status.textContent = 'Нет активной сессии.';
        statusMeta.hidden = true;
        statusMeta.innerHTML = '';
        return;
      }

      const session = payload.activeSession;
      const isRunning = payload.status === 'running';
      setDisabledState(isRunning);
      statusBadge.textContent = isRunning ? 'Выполняется' : 'Нет активной сессии';
      statusBadge.className = 'badge ' + (isRunning ? 'running' : 'idle');
      assignmentId.value = session.assignmentId || '';
      studentId.value = session.studentId || '';
      repoUrlOrPath.value = session.repoUrlOrPath || '';
      status.textContent = isRunning
        ? 'Для этой сессии ведётся отслеживание действий.'
        : 'Последняя сессия больше не активна.';
      statusMeta.hidden = false;
      statusMeta.innerHTML =
        renderMetaRow('Сессия', session.sessionId) +
        renderMetaRow('Задание', session.assignmentId) +
        renderMetaRow('Студент', session.studentId) +
        renderMetaRow('Рабочая папка', session.workspacePath) +
        renderMetaRow('События', String(session.eventCount)) +
        (payload.adminUrl ? renderMetaRow('Админ-панель', payload.adminUrl) : '');
    });

    setDisabledState(false);
  </script>
</body>
</html>`;
    }
}
