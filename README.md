# Team Memory MCP Server

[![CI](https://github.com/Antony-A-tech/MCP-Team-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Antony-A-tech/MCP-Team-memory/actions/workflows/ci.yml)

Shared team memory for AI coding agents. A [Model Context Protocol](https://modelcontextprotocol.io/) server that gives Claude Code (and other MCP clients) persistent, searchable, real-time team knowledge.

## Why

When multiple developers use AI agents on the same codebase, each agent starts with zero context. Team Memory fixes this: every architectural decision, task, bug report, and convention is stored centrally and surfaced automatically based on the agent's role.

## Features

- **14 MCP tools** — read, write, search, sync, pin, export, conventions, onboarding, cross-project search
- **PostgreSQL + pgvector** — full-text search with Russian/English stemming, hybrid vector + FTS search
- **Agent identity** — per-agent tokens, unforgeable author attribution, project roles (developer/qa/lead/devops)
- **Role-aware auto-recall** — agents receive context prioritized for their role (developers see architecture first, QA sees bugs first)
- **Web UI dashboard** — real-time monitoring, knowledge graph, entry management, agent admin panel
- **Real-time sync** — WebSocket-based live updates across all connected agents
- **6 categories** — architecture, tasks, decisions, issues, progress, conventions
- **Smart features** — conflict resolution (optimistic locking), memory decay, auto-archival, version history

## Quick Start

### 1. Start PostgreSQL

```bash
docker compose up -d postgres
```

### 2. Start the server (HTTP mode)

```bash
DATABASE_URL="postgresql://memory:memory@localhost:5432/team_memory" \
MEMORY_TRANSPORT=http \
MEMORY_API_TOKEN="your-master-token" \
node dist/index.js
```

Open `http://localhost:3846` for the dashboard. Create agent tokens in the admin panel.

### 3. Configure Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "http",
      "url": "http://localhost:3846/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>",
        "X-Project-Id": "<PROJECT_UUID>"
      }
    }
  }
}
```

Replace `<YOUR_TOKEN>` with your agent token (`tm_...`) and `<PROJECT_UUID>` with the project UUID from the dashboard.

### 4. Docker Compose (full stack)

```bash
docker compose up -d
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `memory_read` | Read entries with filters (category, domain, search, tags) |
| `memory_write` | Create a new entry |
| `memory_update` | Update an existing entry (with optimistic locking) |
| `memory_delete` | Archive or permanently delete |
| `memory_unarchive` | Restore archived entries |
| `memory_sync` | Get changes since a timestamp |
| `memory_pin` | Pin/unpin entries (pinned entries skip auto-archive) |
| `memory_export` | Export entries as markdown or JSON |
| `memory_search` | Semantic vector search |
| `memory_conventions` | Manage project conventions (add/list/remove) |
| `memory_onboard` | Generate project summary for new team members |
| `memory_cross_search` | Search across all projects |

## Agent Identity & Roles

Each team member gets a personal token (`tm_...`). The author field is set automatically from the token — no spoofing possible.

**System access:**
- Master token (`MEMORY_API_TOKEN` in `.env`) = admin, manages tokens via Web UI
- Agent tokens = user-level access

**Project roles** (soft bias for auto-recall ordering):

| Role | Prioritized Categories | Domains |
|------|----------------------|---------|
| `developer` | architecture, decisions, conventions | backend, frontend, database |
| `qa` | issues, tasks, conventions | testing |
| `lead` | progress, tasks, decisions | all |
| `devops` | architecture, tasks | infrastructure, devops |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `MEMORY_TRANSPORT` | `stdio` | `stdio` (Claude Code CLI) or `http` (Web UI + remote) |
| `MEMORY_PORT` | `3846` | HTTP server port |
| `MEMORY_API_TOKEN` | — | Master token (enables auth when set) |
| `MEMORY_FTS_LANGUAGE` | `simple` | PostgreSQL FTS config (`russian`, `english`, etc.) |
| `MEMORY_EMBEDDING_PROVIDER` | — | `gemini` or `local` (ONNX) |
| `GEMINI_API_KEY` | — | Google Gemini API key for embeddings |
| `MEMORY_AUTO_ARCHIVE` | `true` | Enable auto-archival |
| `MEMORY_AUTO_ARCHIVE_DAYS` | `14` | Days before auto-archive |
| `MEMORY_CORS_ORIGIN` | `*` | CORS origin for production |

## Development

```bash
npm install
npm run build
npm test          # 140 tests
```

## Security

- `crypto.timingSafeEqual` for all token comparisons
- Parameterized SQL queries (no SQL injection)
- CSP headers, XSS escaping, ILIKE sanitization
- FTS language validated against allowlist
- WebSocket rename blocked for token-authenticated agents
- See [Security section](#безопасность) below for HTTPS setup

## License

MIT

---

# Документация на русском

## Возможности

- **14 MCP-инструментов** — чтение, запись, поиск, синхронизация, закрепление, экспорт, конвенции, онбординг, кросс-проектный поиск
- **PostgreSQL + pgvector** — полнотекстовый поиск со стеммингом (русский/английский), гибридный vector + FTS поиск
- **Идентификация агентов** — персональные токены, неподделываемый author, проектные роли (разработчик/тестировщик/руководитель/devops)
- **Ролевой auto-recall** — агенты получают контекст, приоритизированный под их роль
- **Web UI дашборд** — мониторинг в реальном времени, граф знаний, управление записями, панель администратора
- **Real-time синхронизация** — WebSocket для live-обновлений между агентами
- **6 категорий** — архитектура, задачи, решения, проблемы, прогресс, конвенции
- **Smart-фичи** — разрешение конфликтов (optimistic locking), decay памяти, автоархивация, история версий

## Быстрый старт

### 1. Запуск PostgreSQL

```bash
docker compose up -d postgres
```

### 2. Запуск сервера (HTTP-режим)

```bash
DATABASE_URL="postgresql://memory:memory@localhost:5432/team_memory" \
MEMORY_TRANSPORT=http \
MEMORY_API_TOKEN="ваш-master-токен" \
node dist/index.js
```

Дашборд: `http://localhost:3846`. Создайте токены для агентов в панели администратора.

### 3. Настройка Claude Code

Добавьте в `.mcp.json` в корне вашего проекта:

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "http",
      "url": "http://localhost:3846/mcp",
      "headers": {
        "Authorization": "Bearer <ВАШ_ТОКЕН>",
        "X-Project-Id": "<UUID_ПРОЕКТА>"
      }
    }
  }
}
```

Замените `<ВАШ_ТОКЕН>` на ваш токен агента (`tm_...`), а `<UUID_ПРОЕКТА>` — на UUID проекта из дашборда.

## Идентификация агентов

Каждый член команды получает персональный токен (`tm_...`). Автор записи устанавливается автоматически из токена.

**Системный доступ:**
- Master token (`MEMORY_API_TOKEN` в `.env`) = администратор, управляет токенами через Web UI
- Agent tokens = пользователь

**Проектные роли** (мягкая приоритизация auto-recall):

| Роль | Приоритетные категории | Домены |
|------|----------------------|--------|
| Разработчик | архитектура, решения, конвенции | backend, frontend, database |
| Тестировщик | проблемы, задачи, конвенции | testing |
| Руководитель | прогресс, задачи, решения | все |
| DevOps | архитектура, задачи | infrastructure, devops |

## Переменные окружения

| Переменная | По умолчанию | Описание |
|------------|--------------|----------|
| `DATABASE_URL` | — | Строка подключения PostgreSQL (обязательно) |
| `MEMORY_TRANSPORT` | `stdio` | `stdio` (Claude Code CLI) или `http` (Web UI + удалённый) |
| `MEMORY_PORT` | `3846` | Порт HTTP-сервера |
| `MEMORY_API_TOKEN` | — | Master токен (включает auth при установке) |
| `MEMORY_FTS_LANGUAGE` | `simple` | Конфигурация FTS (`russian`, `english` и др.) |
| `MEMORY_EMBEDDING_PROVIDER` | — | `gemini` или `local` (ONNX) |
| `GEMINI_API_KEY` | — | API-ключ Google Gemini для эмбеддингов |
| `MEMORY_AUTO_ARCHIVE` | `true` | Автоархивация |
| `MEMORY_AUTO_ARCHIVE_DAYS` | `14` | Дней до автоархивации |
| `MEMORY_CORS_ORIGIN` | `*` | CORS origin для production |

## Безопасность

### Credentials

**Не используйте дефолтные пароли в production!** Скопируйте `.env.example` в `.env` и измените пароли:

```bash
cp .env.example .env
```

### HTTPS (reverse proxy)

Для production рекомендуется nginx reverse proxy с TLS:

```nginx
server {
    listen 443 ssl;
    server_name memory.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/memory.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/memory.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3846;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /ws {
        proxy_pass http://127.0.0.1:3846;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

## Разработка

```bash
npm install
npm run build
npm test          # 140 тестов
npm run clean     # очистка dist/
```

## Лицензия

MIT
