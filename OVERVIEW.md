# Gachi CLI Swarm — полный обзор продукта

> Что это, как устроено, что умеет. Единственный файл, с которого стоит
> начинать знакомство. Актуален на schema v24.

---

## 1. Одной фразой

**Gachi CLI Swarm** — локальный (local-first) оркестратор роя AI-кодинг-агентов.
Ты даёшь задачи канбан-доской; приложение поднимает для каждого воркера
отдельный PTY-процесс CLI-агента (Claude Code, Codex, AGY/Gemini, OpenCode,
Qwen…) в изолированном git-worktree, следит за жизненным циклом, собирает
результаты через review-пайплайн, мержит работу обратно в main и умеет
опубликовать её как GitHub PR. Управление — из веб-UI в браузере или из
Telegram, откуда угодно.

Ключевая ниша: **Windows-first с настоящим ConPTY** (конкуренты — Mac/Linux),
плюс глубочайшее восстановление сессий и Telegram-канал управления.

---

## 2. Состав системы

| Слой | Технологии | Где |
|---|---|---|
| Runtime (backend) | Node 22+, TypeScript, node-pty (ConPTY), better-sqlite3, ws | `src/server/` |
| Web UI | React 19 + Vite + Tailwind + Radix + xterm.js | `web/src/` |
| CLI | `gachi` (daemon) и `team` (команды агентов/оркестратора) | `src/cli/gachi.ts`, `src/cli/team.ts` |
| Данные | SQLite `runtime.sqlite` (schema v24) + `.gachi/` на диске воркспейса | см. §9 |
| Telegram | long-poll Bot API через опциональный прокси | `src/server/telegram-*.ts` |

Запуск: `pnpm dev` (runtime :4010 + vite) или продакшн `pnpm build && gachi --port 3000`.
Веб-сокеты: `/ws/tasks/<workspaceId>` (push-события доски) и терминальный WS
для xterm-панелей.

---

## 3. Модель домена

- **Workspace** = путь к git-репозиторию на диске. У каждого ровно один
  **Orchestrator** (раздаёт задачи, принимает отчёты).
- **Worker** — член команды (роли: coder/tester/reviewer/custom),
  запускается как PTY-процесс выбранного CLI-агента в личном worktree
  `.gachi/worktrees/<agent>` на ветке `gachi/<agent>`.
- **Task** живёт по строгому автомату:
  `backlog → ready → assigned → running → review → done/canceled`
  (плюс blocked/failed). Из running напрямую в done нельзя — только через review.
- **Sticky affinity**: привязка задачи к воркеру сохраняется при крашах;
  освобождённая карточка dispatch'ится только к «своему» воркеру.
- **Dispatch ledger**: каждая отправка задачи фиксируется в SQLite — это
  источник истины для восстановления после рестарта приложения.

---

## 4. Все функции

### 4.1 Канбан и задачи
- Доска с колонками статусов, drag-free перемещение кнопками, bulk-delete,
  undo-окно удаления, приоритеты low→critical, зависимости задач,
  `requiredSkills` как жёсткое ограничение назначения.
- Reactive dispatch: любое изменение доски мгновенно (debounce 200ms)
  триггерит подбор исполнителя — без ожидания таймеров.
- **Review diff** с inline-комментариями: клик по строке diff → комментарий
  привязывается к `path:line`, уходит воркеру в промпте с координатой;
  общий чат комментариев отдельно.
- **Planner draft lifecycle** (R2): разбиение цели на связанный граф задач
  двумя путями — детерминированный шаблон (/tasks/plan) или LLM через живого
  оркестратора (POST /plan/draft, контракт [PLAN_BEGIN]/[PLAN_TASK]/[PLAN_DONE])
  (Architecture→Backend→Frontend→Tests→Review) одной группой; баннер
  «План на утверждение» над доской — Approve поднимает группу в ready,
  Discard удаляет нетронутые карточки.
- Логи выполнения, артефакты, история отчётов; caps размеров
  (desc 32K / log 4K×200 / comment 8K×200 / result 64K) с self-heal
  компакцией легаси-переполнений.
- Push-обновления доски по WebSocket (`entityVersion` защита от гонок).

### 4.2 Жизненный цикл воркеров
- Старт/стоп/рестарт/resume-session/смена модели и reasoning-level прямо
  из UI (AgentControlPanel) — только то, что поддерживает движок
  (capability registry per engine).
- **Follow-up промпт живому воркеру**: текст пишется прямо в работающий PTY
  без остановки и пере-dispatch.
- Auto-unblock: сканер хвостов PTY распознаёт TUI-диалоги разрешений и сам
  жмёт Enter (бюджет 5/мин); для OpenCode на первый запуск создаётся
  allow-all `opencode.json`.
- Recovery watchdog: stale heartbeat при живой задаче → lifecycle `stuck`,
  снапшот контекста в handoff, рестарт с resume сессии (cooldown 5 мин).
- Heartbeats `{status, phase, currentAction, lastSeen}` в SQLite — не stdout.

### 4.3 Review-пайплайн
- Воркер сдаёт работу → карточка в `review`; свободный reviewer-role воркер
  получает её автоматически.
- Вердикт через `team report`: `APPROVE` → done, `REQUEST_CHANGES` → ready
  с фидбеком; approval-запросы с TTL и истечением (в Telegram уходят
  клавиатуры Approve/Deny).

### 4.4 Worktree-first и GitHub PR
- Каждый воркер изолирован в своём worktree; после чистого выхода ветка
  мержится в main (FF → rebase-in-worktree → FF retry), конфликт уходит
  человеку. Очередь мержей сериализована.
- **Auto-PR (opt-in)**: тумблер `POST /auto-pr`; после успешного merge ветка
  публикуется через `gh pr create`, ссылка пишется в журнал задачи.
- **Ручные PR**: `team pr status|create` и UI-роуты; существующий PR
  распознаётся и возвращается ссылкой вместо ошибки.
- Branch naming: воркеры живут на ветках `gachi/<agent>`; при удалении
  воркера ветка чистится.

### 4.5 Agent Discovery & контроль окружения
- Сканер находит установленные CLI (claude/codex/agy/opencode/qwen…),
  версию, метод аутентификации, доступные модели; TTL-кэш + ручной rescan.
- `GET /api/agents/discovery` питает выбор CLI при создании воркера;
  недоступные пресеты помечаются прямо в диалоге.

### 4.6 Телеметрия и лимиты
- Скрейпинг контекста/токенов из PTY-вывода («context left», total tokens):
  консервативный парсер, unknown → null.
- Авто-compact (контекст-гард): per-workspace порог app-state
  `context_guard_threshold_percent` (дефолт 85%, `0` = выкл процентный
  триггер); quiet-окно 2 мин после старта рана; кулдаун 30 мин; срабатывание
  журналируется `[CONTEXT] compact requested (N%)` в карточку воркера,
  в PTY пишется `/compact` движка (если есть).
- **Usage limit warning**: edge-detection + гистерезис (реарм ниже 80%
  порога), opt-in Telegram-событие `usage_limit_warning`.
- Swarm Dashboard: сводка всех агентов (статус/движок/модель/context%/tokens)
  + счётчики задач; поллинг 10s.

**Token-budget compact**: глобальный app-state uto_compact_tokens — все
  воркеры пишут свой /compact при достижении N токенов (по умолчанию выключен;
  процентный порог работает параллельно, общий кулдаун 30 мин).

### 4.7 Telegram-интерфейс (двусторонний)
- Pairing-кодами (TTL 10 мин), роли owner > operator > viewer.
- Команды: статус роя, создание задач естественным языком, отмена.
- Approval-запросы с inline-клавиатурой и TTL-истечением (verdict доставляется
  и в PTY, и в журнал).
- Релей сообщений оркестратора `[Telegram @name]:` в PTY; ответы агентов
  через `[TG_REPLY]` приходят тебе в чат (ANSI-толерантный матчер).
- События: task_completed (только терминальный done), task_failed,
  approval_required/decided, agent_stuck/recovered, usage_limit_warning.
- Proxy: авто-детект системного (WinINET) + ручной URL; таймауты и retry.

### 4.8 Self-healing политики (R3)
- Классифицированные отказы получают backoff: rate-limit 5м, quota 30м,
  auth 15м, network 1м, oom/disk 10м, cli-missing 30м. На карточке
  `nextRetryAt` блокирует redispatch до истечения; журнал фиксирует
  `[RETRY …]`. Обычные крэши — мгновенный retry как раньше.
- Health score: rolling success-rate (окно 10 терминальных runs) даёт
  бонус ±25 в выборе воркера; null = нейтрально.
- Авто-restart после краша (opt-in): app-state `worker_autorestart_<id>` —
  supervisor перезапускает упавшего воркера по лестнице 1→5→15 мин (макс 3
  попытки); чистый выход сбрасывает серию, ручной stop отменяет отложенный
  рестарт.
- Автодизейбл воркера при cli-missing/auth: launch-config очищается,
  диспетчер его не выбирает; журнал `[WORKER DISABLED]` + RUN_PROGRESS.
- Auto-issue (R4): повторное падение одного сценария/теста (attempts ≥ 3,
  класс не transient) создаёт карточку с логом и классификацией.
- Deploy hooks (R4): опциональная команда воркспейса после успешного
  merge-back — `PUT /deploy-hook` задаёт, результат пишется в журнал задачи
  (`[DEPLOY] ok` / `[DEPLOY FAILED]`), таймаут 5 мин; медленный деплой
  не блокирует диспетчеризацию.
- Режим разрешений (R10): per-workspace `allow-all` | `ask`
  (`PUT /permissions`, app-state `worker_permissions_<id>`); в ask
  автоответчик TUI-диалогов пропускает воркеров, blanket-`opencode.json`
  не пишется.
- Бюджет ошибок (R10): 5 подряд неудачных запусков → app-state
  `dispatch_paused_<id>`, диспетчер пропускает paused-воркспейс; баннер +
  Resume в Automation Card; снятие — `PUT /dispatch-pause`.
- Метрики роя (R1): история usage в SQLite v25, `GET /metrics` —
  токены/success-rate/средняя длительность за окно; полоса «24h» на дашборде.
- Changelog (R4): `GET /changelog?days=N` — git log мерджа + PR-ссылки из
  журналов done-карточек; отдаёт структуру и готовый markdown.

### 4.9 Прочее
- **Docker sandbox** (R5→R10): opt-in изоляция воркеров воркспейса —
  `worker_sandbox_<id>=docker`, образ настраивается; workspace → /workspace,
  env-whitelist; doctor проверяет Docker.
- **Preview**: discovery живых dev-серверов (пробитие 3000/5173/4173/8080/
  8000/4200/1420 + preferred), открытие победителя в браузере одной кнопкой.
- **Engine adapters (R11)**: реестр `engine-adapters.ts` — официальный
  набор движков (claude, codex, opencode, gemini) с login-подсказками для
  doctor и задокументированными ограничениями скрейпа; всё остальное —
  best-effort через Custom-пресет.
- Marketplace агентов (vendor-снапшоты, установка skills).
- Терминалы: xterm-панели воркера и workspace shell, pause/backpressure
  просмотрщика, сериализация буферов.
- Attachments, fs-browse/pick-folder с sandbox-root, PWA (offline page,
  service worker с версионированным кэшем), i18n ×13 (en/zh/ru/es/pt/fr/it/
  de/ja/ko/ar/hi/tr).

---

## 5. CLI

### `gachi [--port <p>]`
Daemon: раздаёт API + web UI, держит PTY, восстанавливает состояние после
рестарта (reconcile runs, requeue задач). `gachi doctor` — отчёт об окружении
(Node/Git/CLI/DB/Telegram).

### `team …` (окружение агента → runtime по HTTP+token)
```
team list                     состав роя и статусы
team send <worker> "<task>"   поставить задачу конкретному воркеру
team engine <name> <engine>   сменить CLI-движок воркеру
team model <name> "<id>"      сменить модель агента (orchestrator-only)
team accept / rework / cancel / task-delete    вердикты и отмена
team report "<result>" [--dispatch] [--artifact]     сдать работу
team status "<text>"          текущий статус (стримится в UI)
team request "<command>"      спросить человека (approval в Telegram)
team events [--limit|--since] лента событий
team ps [--active-only]       компактный статус роя (живые/занятые)
team note <worker> "<text>"   system-note в PTY воркера (не задача)
team tasks-cleanup --stale-hours <h> [--dry-run|--apply] [--delete]
                              отвязка/удаление протухших ready/assigned карточек
team worker add|start|stop|pause|resume|compact|restart-all-crashed|rm <name>
                                                      (orchestrator-only)
                               add + --preset <id> = одна команда: воркер создан
                               с launch-config и запущен (autostart по умолч.);
                               без пресета — задать движок: team engine <name>
                               <codex|agy|claude|opencode>, затем start
                               (start без конфига → 400 с подсказкой)
                               stop + --cancel-task = отменить in-flight карточку
                               вместо возврата в ready — разблокирует молча
                               зависшего воркера: stop --cancel-task → send
                               новой задачи (иначе dispatcher успеет ре-assign
                               освобождённую карточку, и send получит 409)
team pr status | team pr create (--branch X|--task ID) [--title] [--base]
```
Authz по ролям: часть команд только orchestrator (`send/cancel/engine/
accept/approve/reject/workers/note/tasks-cleanup/pr`), worker-набор —
report/status/list/events/send/request/ps.

---

## 6. HTTP API (полный список)

**Workspaces/team**: GET·POST `/api/workspaces`, PATCH·DELETE `/api/workspaces/:id`,
GET team (2 варианта, фильтр `active_only`), POST·DELETE·PATCH workers,
POST user-input, attachments (2), skills (GET/install), agents start,
pty/input, open.

**Tasks (12)**: CRUD + `PUT /tasks` (bulk markdown sync), `plan`,
`plan/draft` (LLM-декомпозиция через живого оркестратора),
`plans/:groupId/approve`·DELETE, `items`, `diff`, logs, comments
(обычные и якорные), dispatch.

**Agent control (13)**: capabilities, discovery(+rescan), control state,
model/reasoning/context, start/stop/restart/resume-session, follow-up input,
swarm `control/summary`.

**Packages/Templates (2)**: team-template package export/import.
**PR/Automation (6)**: status (+auto_pr_enabled, deploy_hook_command,
worker_permission_mode, dispatch_paused), create, auto-pr toggle,
deploy-hook set/clear, permissions mode, dispatch-pause.
**Preview (1)**: discover.
**Metrics/Changelog (2)**: `GET /metrics`, `GET /changelog?days=N`.

**Team CLI bridge (22)**: worker add/start/stop/pause/resume/compact/
restart-all-crashed/rm, events, send, cancel, task-delete, tasks-cleanup,
report, status, request, engine, accept, rework, note, pr/status, pr/create.

**Telegram (9)**: settings get/set, verify, test, pairing, links role,
link delete, approvals list/decide.

**Runtime (10)**: runs list/get, stop/pause/resume run, shell start/close,
agent config, worker reset, subscription-limits.

**Settings (13)**: command-presets CRUD, role-templates CRUD, team-templates
CRUD-lite, app-state get/put.

**FS/UI/Marketplace**: browse/probe/pick-folder/resolve-folder; ui session +
regenerate; marketplace manifest/agent. Health: `GET /api/health`.

Все мутирующие эндпоинты требуют UI-token/cookie либо агент-токен с проверкой
роли; привязка к 127.0.0.1 (local-request guard).

---

## 7. Конфигурация (env)

Все переменные окружения используют префикс `GACH_*` (см. `src/server/env.ts`);
бутстрап воркера инжектит их при запуске:

| Переменная | Смысл |
|---|---|
| `GACH_PORT` | порт runtime для фонаря воркера |
| `GACH_PROJECT_ID` / `_AGENT_ID` / `_AGENT_TOKEN` | identity воркера |
| `GACH_DATA_DIR` | каталог runtime.sqlite (default `~/.config/gachi`) |
| `GACH_STATIC_DIR`, `GACH_FS_BROWSE_ROOT` | web-ассеты, песочница fs-browse |
| `GACH_CLAUDE_PROJECTS_DIR`, `GACH_GEMINI_HOME`, `GACH_OPENCODE_DB_PATH` | источники сессий для capture/resume |
| `GACH_ORCHESTRATOR_COMMAND/_ARGS_JSON` | переопределение запуска орка |
| `GACH_MARKETPLACE_VENDOR_ROOT` | корень vendor-маркетплейса |

Секреты (Telegram token): Windows — DPAPI (`dpapi:v1:`), macOS — Keychain,
Linux — secret-tool (`keychain:v1:<ref>`), fallback — явный `plain:v1:`.

---

## 8. Верификация

```bash
pnpm check   # biome — 0 ошибок
pnpm build   # tsc -p tsconfig.build.json + vite build
pnpm test    # vitest: ~165 файлов / ~1020 тестов, 0 failed
             # 44 skipped — POSIX-only и ConPTY-гейты (нужен реальный консольный раннер)
pnpm preview # vite preview собранного web
```

Интеграционные тесты поднимают настоящий HTTP-сервер + SQLite; git-фикстуры —
настоящие репозитории; внешние границы (gh, telegram, папки) инжектятся
сервисами (PrService/PrService-like pattern), не подменяя продакшн-код.

---

## 9. Данные на диске

```
<workspace>/.gachi/
  tasks.md            человеко-читаемая доска (sync в обе стороны)
  PROTOCOL.md         правила team-протокола для агентов
  memory/…            project-memory воркеров
  agents/<id>/sessions/  журналы сессий (JSONL) + handoff-снапшоты
  worktrees/<agent>/  изолированные копии репо воркеров
~/.config/gachi/runtime.sqlite   workspaces/workers/messages/dispatches/
                                 agent_runs/sessions/launch_configs/schema v24
web/public/sounds/gachi-sound-*.mp3  звуковые сигналы UI
```

---

## 10. Ограничения и осознанные компромиссы

- Воркеры выполняются с правами пользователя на хосте (без контейнерной
  изоляции); безопасность строится на approval-флоу и локальном guard'е.
- Preview открывается во внешней вкладке (iframe против CSP/XFO не воюем).
- ConPTY-тесты требуют интерактивную консоль; CI-lane с настоящим PTY — в планах.
