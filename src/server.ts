import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type Resource
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager } from './memory/manager.js';
import { buildAutoContext } from './recall.js';
import logger from './logger.js';
import type {
  Category,
  Priority,
  Status,
  ReadParams,
  WriteParams,
  UpdateParams,
  DeleteParams,
  SyncParams,
  ConflictError,
  MemoryEntry,
  CompactMemoryEntry
} from './memory/types.js';
import {
  ReadParamsSchema,
  WriteParamsSchema,
  UpdateParamsSchema,
  DeleteParamsSchema,
  SyncParamsSchema,
  PinParamsSchema,
  ProjectActionSchema,
  AuditParamsSchema,
  HistoryParamsSchema,
  ExportParamsSchema,
  CrossSearchParamsSchema,
  formatZodError,
} from './memory/validation.js';
import { exportEntries, type ExportFormat } from './export/exporter.js';
import type { AgentTokenStore } from './auth/agent-tokens.js';
import type { NotesManager } from './notes/manager.js';
import type { SessionManager } from './sessions/manager.js';
import { NoteWriteSchema, NoteReadSchema, NoteUpdateSchema, NoteDeleteSchema, NoteSearchSchema } from './notes/validation.js';
import { SessionImportSchema, SessionListSchema, SessionSearchSchema, SessionReadSchema, SessionMessageSearchSchema, SessionDeleteSchema } from './sessions/validation.js';

export function buildMcpServer(
  memoryManager: MemoryManager,
  agentTokenStore?: AgentTokenStore,
  notesManager?: NotesManager,
  sessionManager?: SessionManager,
): Server {
  const server = new Server(
    { name: 'team-memory', version: '3.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  setupHandlers(server, memoryManager, agentTokenStore, notesManager, sessionManager);
  return server;
}

function setupHandlers(server: Server, memoryManager: MemoryManager, agentTokenStore?: AgentTokenStore, notesManager?: NotesManager, sessionManager?: SessionManager): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      {
        name: 'memory_read',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В НАЧАЛЕ сессии — проверь память проекта (memory_read() или memory_onboard).\n• ПЕРЕД началом новой задачи — поищи существующие решения (memory_read(search="...")).\n• Когда нужны детали записи — получи полное содержимое по ID.\n\nЧитает командную память. По умолчанию возвращает компактный список (без content). Два сценария получения полного содержимого:\n1. Обзор → детали: memory_read() → получить ID → memory_read(ids=[...])\n2. Поиск: memory_read(search="ключевые слова") → memory_read(ids=[...])\nДля малых выборок: memory_read(search="...", mode="full", limit=5)',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта. Если не указан — берётся из заголовка X-Project-Id.' },
            category: {
              type: 'string',
              enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions', 'all'],
              description: 'Категория памяти для чтения'
            },
            domain: { type: 'string', description: 'Фильтр по домену (backend, frontend, infrastructure, и т.д.)' },
            search: { type: 'string', description: 'Поиск по ключевым словам' },
            limit: { type: 'number', default: 50, description: 'Максимальное количество записей' },
            offset: { type: 'number', default: 0, description: 'Смещение для пагинации' },
            status: {
              type: 'string',
              enum: ['active', 'completed', 'archived'],
              description: 'Фильтр по статусу'
            },
            ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Список UUID записей для получения полного содержимого (batch). Игнорирует другие фильтры кроме project_id. Макс 100.'
            },
            mode: {
              type: 'string',
              enum: ['compact', 'full'],
              description: 'Режим вывода: compact (по умолчанию) — только метаданные без content; full — полные записи с content'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Фильтр по тегам (пересечение — запись должна содержать хотя бы один из указанных тегов)'
            }
          }
        }
      },
      {
        name: 'memory_write',
        description: '► КОГДА ВЫЗЫВАТЬ — ОБЯЗАТЕЛЬНО записывай после каждого значимого действия:\n• Принял архитектурное или техническое решение → category="decisions"\n• Обнаружил баг или проблему → category="issues"\n• Завершил задачу или этап работы → category="progress"\n• Создал/изменил архитектуру (новый модуль, API, схема БД) → category="architecture"\n• Начал работу над новой задачей → category="tasks"\nНЕ ЗАВЕРШАЙ сессию, не записав итоги своей работы!\n\nДобавляет новую запись в командную память. Обязательные поля: category, title, content. Пример: memory_write(category="progress", title="Реализован API авторизации", content="Добавлены эндпоинты /login, /logout. JWT с refresh-токенами.", tags=["auth", "api"])',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта. Если не указан — берётся из заголовка X-Project-Id.' },
            category: {
              type: 'string',
              enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions'],
              description: 'Категория записи'
            },
            domain: { type: 'string', description: 'Домен проекта. Получите актуальный список через memory_onboard. Стандартные: backend, frontend, infrastructure, devops, database, testing. Проект может содержать дополнительные кастомные домены.' },
            title: { type: 'string', description: 'Заголовок записи' },
            content: { type: 'string', description: 'Содержимое записи' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги для категоризации' },
            priority: {
              type: 'string',
              enum: ['low', 'medium', 'high', 'critical'],
              description: 'Приоритет записи'
            },
            author: { type: 'string', description: 'Автор записи' },
            pinned: { type: 'boolean', default: false, description: 'Закрепить запись' },
            relatedIds: { type: 'array', items: { type: 'string' }, description: 'UUID связанных записей для построения графа знаний' }
          },
          required: ['category', 'title', 'content']
        }
      },
      {
        name: 'memory_update',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Задача завершена → memory_update(id="...", status="completed")\n• Проблема решена → обнови content с описанием решения и status="completed"\n• Решение пересмотрено или уточнено → обнови content\n• Изменился приоритет или статус работы\nОБЯЗАТЕЛЬНО обновляй статус задач и проблем, когда их состояние меняется.\n\nОбновляет существующую запись в памяти. Обязательное поле: id. Остальные поля — только те, которые нужно изменить. Пример: memory_update(id="...", status="completed", content="Новый текст")',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи для обновления' },
            expected_version: { type: 'number', description: 'Ожидаемая версия для optimistic locking. Если текущая версия не совпадает, вернётся ошибка конфликта.' },
            title: { type: 'string', description: 'Новый заголовок' },
            content: { type: 'string', description: 'Новое содержимое' },
            domain: { type: 'string', description: 'Домен проекта. Получите актуальный список через memory_onboard. Стандартные: backend, frontend, infrastructure, devops, database, testing. Проект может содержать дополнительные кастомные домены.' },
            status: { type: 'string', enum: ['active', 'completed', 'archived'], description: 'Новый статус' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Новые теги' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'], description: 'Новый приоритет' },
            pinned: { type: 'boolean', description: 'Закрепить/открепить' },
            relatedIds: { type: 'array', items: { type: 'string' }, description: 'UUID связанных записей для построения графа знаний' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_delete',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Когда запись устарела и больше не актуальна.\n• Предпочитай архивацию (по умолчанию) полному удалению.\n\nУдаляет или архивирует запись из памяти. По умолчанию архивирует (archive=true). Для полного удаления: memory_delete(id="...", archive=false)',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи' },
            archive: { type: 'boolean', default: true, description: 'Архивировать вместо удаления' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_sync',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В длительной сессии — проверяй изменения других агентов каждые 30+ минут.\n• После паузы — узнай, что изменилось, пока ты не работал.\n\nПолучает последние изменения в памяти. Без параметров — изменения за 24 часа. Пример: memory_sync(since="2026-03-24T00:00:00Z")',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            since: { type: 'string', format: 'date-time', description: 'Получить изменения начиная с даты' }
          }
        }
      },
      {
        name: 'memory_unarchive',
        description: 'Разархивирует запись, возвращая в активный статус. Используй, когда архивированная запись снова стала актуальной.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'ID записи' } },
          required: ['id']
        }
      },
      {
        name: 'memory_pin',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Когда запись критически важна и ДОЛЖНА быть видна всем агентам при каждом входе.\n• Закреплённые записи автоматически попадают в auto-context при старте сессии.\n\nЗакрепляет или открепляет запись. Закреплённые записи НЕ архивируются автоматически.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи' },
            pinned: { type: 'boolean', default: true, description: 'true - закрепить, false - открепить' }
          },
          required: ['id']
        }
      },
      {
        name: 'memory_projects',
        description: 'Управление проектами. ОБЯЗАТЕЛЬНЫЙ параметр: action.\n- action="list" — список всех проектов (без доп. параметров)\n- action="create" — создать проект (name обязателен, description и domains опционально)\n- action="update" — обновить проект (id обязателен, name/description/domains опционально)\n- action="delete" — удалить проект (id обязателен)',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Действие (ОБЯЗАТЕЛЬНО)' },
            id: { type: 'string', description: 'ID проекта (обязателен для update и delete)' },
            name: { type: 'string', description: 'Название проекта (обязательно для create)' },
            description: { type: 'string', description: 'Описание проекта' },
            domains: { type: 'array', items: { type: 'string' }, description: 'Домены проекта (backend, frontend, и т.д.)' }
          },
          required: ['action']
        }
      },
      {
        name: 'memory_audit',
        description: 'Просмотр истории изменений записи или проекта (аудит-лог). Используй для диагностики: кто и когда менял запись.',
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: 'ID записи для просмотра истории' },
            project_id: { type: 'string', description: 'ID проекта для просмотра истории' },
            limit: { type: 'number', default: 20, description: 'Макс. записей' },
          },
        },
      },
      {
        name: 'memory_history',
        description: 'Показывает историю версий записи. Используй для сравнения изменений или отката к предыдущей версии.',
        inputSchema: {
          type: 'object',
          properties: {
            entry_id: { type: 'string', description: 'ID записи' },
            version: { type: 'number', description: 'Конкретная версия (опционально)' },
          },
          required: ['entry_id'],
        },
      },
      {
        name: 'memory_export',
        description: 'Экспортирует записи в формат Markdown или JSON. Используй, когда пользователь просит отчёт или выгрузку данных.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта' },
            format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown', description: 'Формат экспорта' },
            category: { type: 'string', enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions', 'all'], description: 'Категория' },
          },
        },
      },
      {
        name: 'memory_conventions',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Обнаружил повторяющийся паттерн, который должна соблюдать команда → action="add"\n• Пользователь просит зафиксировать правило или стандарт → action="add"\n• Перед code review — проверь конвенции → action="list"\n\nУправление конвенциями проекта (стиль кода, паттерны, правила). ОБЯЗАТЕЛЬНЫЙ параметр: action.\n- action="list" — показать все конвенции\n- action="add" — добавить (title и content обязательны)\n- action="remove" — удалить (id обязателен)',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'remove'],
              description: 'Действие (ОБЯЗАТЕЛЬНО): list, add или remove'
            },
            project_id: { type: 'string', description: 'ID проекта' },
            title: { type: 'string', description: 'Название конвенции (обязательно для add)' },
            content: { type: 'string', description: 'Описание конвенции (обязательно для add)' },
            domain: { type: 'string', description: 'Домен конвенции (для add)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги (для add)' },
            id: { type: 'string', description: 'ID конвенции (обязателен для remove)' },
          },
          required: ['action']
        }
      },
      {
        name: 'memory_cross_search',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• Перед реализацией нового паттерна — проверь, решалась ли задача в других проектах.\n• Когда ищешь best practices или примеры решений.\n\nПоиск паттернов и решений МЕЖДУ проектами. ОБЯЗАТЕЛЬНЫЙ параметр: query. Пример: memory_cross_search(query="аутентификация JWT", category="decisions")',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            category: {
              type: 'string',
              enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions', 'all'],
              description: 'Фильтр по категории'
            },
            domain: { type: 'string', description: 'Фильтр по домену' },
            exclude_project_id: { type: 'string', description: 'Исключить этот проект из поиска (обычно текущий)' },
            limit: { type: 'number', default: 20, description: 'Макс. результатов' },
          },
          required: ['query']
        }
      },
      {
        name: 'memory_onboard',
        description: '► КОГДА ВЫЗЫВАТЬ:\n• В НАЧАЛЕ КАЖДОЙ новой сессии — вызови ПЕРВЫМ ДЕЛОМ для загрузки контекста проекта.\n• При переключении на другой проект.\nОдин вызов вместо десяти memory_read — получишь конвенции, архитектуру, решения, задачи, проблемы, стек.\n\nГенерирует полную сводку проекта для нового агента/члена команды.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта. Если не указан — берётся из заголовка X-Project-Id.' },
          },
        }
      },
      // === Personal Notes tools ===
      {
        name: 'note_write',
        description: 'Создать личную заметку. Привязана к вашему токену — другие агенты не видят. Можно привязать к проекту или сессии.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Заголовок заметки' },
            content: { type: 'string', description: 'Содержимое заметки' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги' },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            project_id: { type: 'string', description: 'ID проекта (опционально)' },
            session_id: { type: 'string', description: 'ID импортированной сессии (опционально)' },
          },
          required: ['title', 'content'],
        },
      },
      {
        name: 'note_read',
        description: 'Читать свои личные заметки. Фильтрация по тегам, проекту, сессии, статусу.',
        inputSchema: {
          type: 'object',
          properties: {
            search: { type: 'string', description: 'Поиск по ключевым словам' },
            tags: { type: 'array', items: { type: 'string' } },
            project_id: { type: 'string' },
            session_id: { type: 'string' },
            status: { type: 'string', enum: ['active', 'archived'] },
            mode: { type: 'string', enum: ['compact', 'full'], default: 'compact' },
            limit: { type: 'number', default: 50 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'note_update',
        description: 'Обновить свою личную заметку.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'UUID заметки' },
            title: { type: 'string' },
            content: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            priority: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            status: { type: 'string', enum: ['active', 'archived'] },
            project_id: { type: ['string', 'null'] },
            session_id: { type: ['string', 'null'] },
          },
          required: ['id'],
        },
      },
      {
        name: 'note_delete',
        description: 'Удалить или архивировать свою личную заметку.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'UUID заметки' },
            archive: { type: 'boolean', default: true, description: 'Архивировать вместо удаления' },
          },
          required: ['id'],
        },
      },
      {
        name: 'note_search',
        description: 'Семантический поиск по личным заметкам через Qdrant.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            project_id: { type: 'string' },
            session_id: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      // === Session Import tools ===
      {
        name: 'session_import',
        description: 'Импортировать сессию Claude Code с сообщениями. Summary генерируется автоматически через LLM если не указан.',
        inputSchema: {
          type: 'object',
          properties: {
            external_id: { type: 'string', description: 'ID сессии из Claude Code' },
            name: { type: 'string', description: 'Название сессии' },
            summary: { type: 'string', description: 'Summary сессии (опционально — сервер сгенерирует через LLM)' },
            project_id: { type: 'string', description: 'ID проекта (опционально)' },
            working_directory: { type: 'string' },
            git_branch: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            started_at: { type: 'string', description: 'ISO timestamp' },
            ended_at: { type: 'string', description: 'ISO timestamp' },
            messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['user', 'assistant', 'system'] }, content: { type: 'string' }, timestamp: { type: 'string' }, tool_names: { type: 'array', items: { type: 'string' } } }, required: ['role', 'content'] } },
          },
          required: ['messages'],
        },
      },
      {
        name: 'session_list',
        description: 'Список импортированных сессий. Фильтрация по проекту, тегам, датам.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            date_from: { type: 'string' },
            date_to: { type: 'string' },
            search: { type: 'string' },
            limit: { type: 'number', default: 20 },
            offset: { type: 'number', default: 0 },
          },
        },
      },
      {
        name: 'session_search',
        description: 'Семантический поиск по summary сессий через Qdrant. Найдёт сессию по смыслу.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            project_id: { type: 'string' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'session_read',
        description: 'Прочитать сессию с сообщениями. Пагинация по индексам сообщений.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'UUID сессии' },
            message_from: { type: 'number', default: 0 },
            message_to: { type: 'number' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'session_message_search',
        description: 'Семантический поиск внутри сессии или по всем сообщениям. Находит конкретные сообщения.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Поисковый запрос' },
            session_id: { type: 'string', description: 'UUID сессии (опционально — если не указан, ищет по всем)' },
            limit: { type: 'number', default: 10 },
          },
          required: ['query'],
        },
      },
      {
        name: 'session_delete',
        description: 'Удалить импортированную сессию со всеми сообщениями.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'UUID сессии' },
          },
          required: ['session_id'],
        },
      },
    ];
    return { tools };
  });

  // Some MCP clients serialize arrays as JSON strings — parse them back
  function coerceArrayFields(obj: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
    if (!obj) return obj;
    const result = { ...obj };
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string' && value.startsWith('[')) {
        try { result[key] = JSON.parse(value); } catch { /* keep as string */ }
      }
    }
    return result;
  }

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: rawArgs } = request.params;
    const args = coerceArrayFields(rawArgs);

    // Extract agent identity and default project from auth context (HTTP transport)
    const callerAgent = (extra as any)?.authInfo?.clientId as string | undefined;
    const callerScopes = (extra as any)?.authInfo?.scopes as string[] | undefined;
    const isAgentToken = callerAgent && callerAgent !== 'master';
    const headerProjectId = (extra as any)?.authInfo?.projectId as string | undefined;

    // Resolve project_id: explicit param > X-Project-Id header. No fallback to default.
    const resolveProjectId = (paramProjectId: string | undefined): string | undefined => {
      return paramProjectId || headerProjectId;
    };
    // Tools that require project context must have a project_id from any source
    const requireProjectId = (paramProjectId: string | undefined, _toolName: string): string | { error: true; response: any } => {
      const resolved = resolveProjectId(paramProjectId);
      if (!resolved) {
        return {
          error: true,
          response: {
            content: [{ type: 'text', text: `❌ project_id обязателен. Укажите project_id в параметрах или настройте заголовок X-Project-Id в конфигурации MCP клиента.\n\nПример конфигурации:\n"headers": { "X-Project-Id": "<uuid проекта>" }` }],
            isError: true,
          },
        };
      }
      return resolved;
    };

    try {
      switch (name) {
        case 'memory_read': {
          const parsed = ReadParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const readProjectId = requireProjectId(parsed.data.project_id, 'memory_read');
          if (typeof readProjectId !== 'string') return readProjectId.response;
          const params: ReadParams = {
            projectId: readProjectId,
            category: parsed.data.category,
            domain: parsed.data.domain,
            search: parsed.data.search,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
            status: parsed.data.status,
            ids: parsed.data.ids,
            mode: parsed.data.mode,
            tags: parsed.data.tags,
          };
          const entries = await memoryManager.read(params);
          if (entries.length === 0) {
            return { content: [{ type: 'text', text: 'Записи не найдены по заданным критериям.' }] };
          }

          const isCompact = !params.ids && params.mode !== 'full';

          if (isCompact) {
            const formatted = (entries as CompactMemoryEntry[]).map(e => {
              const pi = e.priority === 'critical' ? '🔴' : e.priority === 'high' ? '🟠' : e.priority === 'medium' ? '🟡' : '🟢';
              const pin = e.pinned ? '📌 ' : '';
              const dom = e.domain ? ` | ${e.domain}` : '';
              const tags = e.tags.length > 0 ? ` | 🏷️ ${e.tags.join(', ')}` : '';
              return `${pin}${pi} **${e.title}**\n  ID: ${e.id} | ${e.category}${dom} | ${e.status}${tags} | 🕐 ${new Date(e.updatedAt).toLocaleDateString()}`;
            }).join('\n\n');
            return { content: [{ type: 'text', text: `# Командная память (${entries.length} записей, compact)\n\n${formatted}` }] };
          }

          const formatted = (entries as MemoryEntry[]).map(e => {
            const pi = e.priority === 'critical' ? '🔴' : e.priority === 'high' ? '🟠' : e.priority === 'medium' ? '🟡' : '🟢';
            const pin = e.pinned ? '📌 ' : '';
            const dom = e.domain ? ` | **Домен**: ${e.domain}` : '';
            const rel = e.relatedIds && e.relatedIds.length > 0 ? `\n**Связи**: ${e.relatedIds.join(', ')}` : '';
            return `## ${pin}${pi} ${e.title}\n**ID**: ${e.id}\n**Категория**: ${e.category}${dom} | **Статус**: ${e.status} | **Автор**: ${e.author}${e.pinned ? ' | 📌' : ''}\n**Теги**: ${e.tags.join(', ') || 'нет'}${rel}\n**Обновлено**: ${new Date(e.updatedAt).toLocaleString()}\n\n${e.content}\n\n---`;
          }).join('\n\n');
          return { content: [{ type: 'text', text: `# Командная память (${entries.length} записей)\n\n${formatted}` }] };
        }

        case 'memory_write': {
          const parsed = WriteParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { project_id, ...writeData } = parsed.data;
          const writeProjectId = requireProjectId(project_id, 'memory_write');
          if (typeof writeProjectId !== 'string') return writeProjectId.response;
          // Override author if agent token was used (HTTP transport — identity from token, not params)
          if (isAgentToken) writeData.author = callerAgent;
          const params: WriteParams = { ...writeData, projectId: writeProjectId };
          const entry = await memoryManager.write(params);
          const domTxt = entry.domain ? `\n**Домен**: ${entry.domain}` : '';
          const pinTxt = entry.pinned ? '\n📌 Закреплена' : '';
          const relTxt = entry.relatedIds && entry.relatedIds.length > 0 ? `\n**Связи**: ${entry.relatedIds.length} записей` : '';
          return {
            content: [{ type: 'text', text: `✅ Запись добавлена!\n\n**ID**: ${entry.id}\n**Заголовок**: ${entry.title}\n**Категория**: ${entry.category}${domTxt}\n**Приоритет**: ${entry.priority}${pinTxt}${relTxt}` }]
          };
        }

        case 'memory_update': {
          const parsed = UpdateParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { expected_version, ...rest } = parsed.data;
          const params: UpdateParams = { ...rest, expectedVersion: expected_version };
          const result = await memoryManager.update(params);

          // Check for conflict
          if (result && 'conflict' in result) {
            const conflict = result as ConflictError;
            return {
              content: [{
                type: 'text',
                text: `⚠️ Конфликт версий!\n\n${conflict.message}\n\n**Текущая версия**: ${conflict.currentVersion}\n**Текущий заголовок**: ${conflict.currentEntry.title}\n\nПрочитайте запись заново и повторите обновление с актуальной версией.`
              }],
              isError: true,
            };
          }

          if (!result) return { content: [{ type: 'text', text: `❌ Запись с ID "${parsed.data.id}" не найдена.` }] };
          const entry = result as MemoryEntry;
          const versionInfo = entry.currentVersion !== undefined ? `\n**Версия**: ${entry.currentVersion}` : '';
          return { content: [{ type: 'text', text: `✅ Запись обновлена!\n\n**ID**: ${entry.id}\n**Заголовок**: ${entry.title}\n**Статус**: ${entry.status}${versionInfo}` }] };
        }

        case 'memory_delete': {
          const parsed = DeleteParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const params = parsed.data;
          const success = await memoryManager.delete(params);
          if (!success) return { content: [{ type: 'text', text: `❌ Запись с ID "${params.id}" не найдена.` }] };
          return { content: [{ type: 'text', text: params.archive ? `📦 Запись архивирована (ID: ${params.id})` : `🗑️ Запись удалена (ID: ${params.id})` }] };
        }

        case 'memory_sync': {
          const parsed = SyncParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const syncProjectId = requireProjectId(parsed.data.project_id, 'memory_sync');
          if (typeof syncProjectId !== 'string') return syncProjectId.response;
          const params: SyncParams = { projectId: syncProjectId, since: parsed.data.since };
          const result = await memoryManager.sync(params);
          if (result.entries.length === 0) {
            return { content: [{ type: 'text', text: `✅ Синхронизировано. Новых изменений нет.\nПоследнее обновление: ${result.lastUpdated}` }] };
          }
          const changes = result.entries.map(e => `- [${e.category}]${e.domain ? `[${e.domain}]` : ''} **${e.title}** (${e.status})`).join('\n');
          return { content: [{ type: 'text', text: `🔄 Синхронизация\n\n**Изменений**: ${result.totalChanges}\n\n${changes}` }] };
        }

        case 'memory_unarchive': {
          const id = args?.id as string;
          if (!id) return { content: [{ type: 'text', text: '❌ Укажите ID записи.' }], isError: true };
          const unarchiveResult = await memoryManager.update({ id, status: 'active' });
          if (!unarchiveResult || ('conflict' in unarchiveResult)) return { content: [{ type: 'text', text: `❌ Запись "${id}" не найдена.` }] };
          return { content: [{ type: 'text', text: `📤 Разархивировано!\n\n**ID**: ${unarchiveResult.id}\n**Заголовок**: ${unarchiveResult.title}` }] };
        }

        case 'memory_pin': {
          const parsed = PinParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { id, pinned } = parsed.data;
          const updated = await memoryManager.pin(id, pinned);
          if (!updated) return { content: [{ type: 'text', text: `❌ Запись "${id}" не найдена.` }] };
          return { content: [{ type: 'text', text: `${pinned ? '📌' : '📍'} Запись ${pinned ? 'закреплена' : 'откреплена'}!\n\n**ID**: ${updated.id}\n**Заголовок**: ${updated.title}` }] };
        }

        case 'memory_projects': {
          const parsed = ProjectActionSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const projectAction = parsed.data;
          switch (projectAction.action) {
            case 'list': {
              const projects = await memoryManager.listProjects();
              if (projects.length === 0) return { content: [{ type: 'text', text: 'Проектов не найдено.' }] };
              const list = projects.map(p => `- **${p.name}** (ID: ${p.id})\n  ${p.description}\n  Домены: ${p.domains.join(', ')}`).join('\n\n');
              return { content: [{ type: 'text', text: `# Проекты (${projects.length})\n\n${list}` }] };
            }
            case 'create': {
              const p = await memoryManager.createProject({ name: projectAction.name, description: projectAction.description, domains: projectAction.domains });
              return { content: [{ type: 'text', text: `✅ Проект создан!\n\n**ID**: ${p.id}\n**Название**: ${p.name}\n**Домены**: ${p.domains.join(', ')}` }] };
            }
            case 'update': {
              const u = await memoryManager.updateProject(projectAction.id, { name: projectAction.name, description: projectAction.description, domains: projectAction.domains });
              if (!u) return { content: [{ type: 'text', text: `❌ Проект "${projectAction.id}" не найден.` }] };
              return { content: [{ type: 'text', text: `✅ Проект обновлён!\n\n**ID**: ${u.id}\n**Название**: ${u.name}` }] };
            }
            case 'delete': {
              const d = await memoryManager.deleteProject(projectAction.id);
              return { content: [{ type: 'text', text: d ? `🗑️ Проект удалён (${projectAction.id})` : `❌ Не найден или default.` }] };
            }
          }
          // All cases return above; this is a safety break
          break;
        }

        case 'memory_audit': {
          const auditLogger = memoryManager.getAuditLogger();
          if (!auditLogger) {
            return { content: [{ type: 'text', text: '❌ Аудит-лог не подключён.' }], isError: true };
          }
          const parsed = AuditParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { entry_id: auditEntryId, project_id: auditProjectId, limit: auditLimit } = parsed.data;
          const resolvedAuditProjectId = resolveProjectId(auditProjectId);

          let auditEntries;
          if (auditEntryId) {
            auditEntries = await auditLogger.getByEntry(auditEntryId, auditLimit);
          } else if (resolvedAuditProjectId) {
            auditEntries = await auditLogger.getByProject(resolvedAuditProjectId, auditLimit);
          } else {
            auditEntries = await auditLogger.getRecent(auditLimit);
          }

          if (auditEntries.length === 0) {
            return { content: [{ type: 'text', text: 'История изменений пуста.' }] };
          }

          const auditFormatted = auditEntries.map(a =>
            `- **${a.action}** [${new Date(a.createdAt).toLocaleString()}] by ${a.actor}` +
            (a.entryId ? ` (entry: ${a.entryId})` : '') +
            (Object.keys(a.changes).length > 0 ? `\n  Изменения: ${JSON.stringify(a.changes)}` : '')
          ).join('\n');

          return { content: [{ type: 'text', text: `# Аудит-лог (${auditEntries.length} записей)\n\n${auditFormatted}` }] };
        }

        case 'memory_history': {
          const vm = memoryManager.getVersionManager();
          if (!vm) {
            return { content: [{ type: 'text', text: '❌ Версионирование не подключено.' }], isError: true };
          }
          const parsed = HistoryParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { entry_id: histEntryId, version: histVersion } = parsed.data;

          if (histVersion !== undefined) {
            const v = await vm.getVersion(histEntryId, histVersion);
            if (!v) return { content: [{ type: 'text', text: `❌ Версия ${histVersion} не найдена.` }] };
            return { content: [{ type: 'text', text: `# Версия ${v.version}\n\n**Заголовок**: ${v.title}\n**Категория**: ${v.category}\n**Статус**: ${v.status}\n**Автор**: ${v.author}\n**Дата**: ${new Date(v.createdAt).toLocaleString()}\n\n${v.content}` }] };
          }

          const versions = await vm.getVersions(histEntryId);
          if (versions.length === 0) {
            return { content: [{ type: 'text', text: 'История версий пуста (запись ещё не обновлялась).' }] };
          }

          const vFormatted = versions.map(v =>
            `- **v${v.version}** [${new Date(v.createdAt).toLocaleString()}] — ${v.title} (${v.status})`
          ).join('\n');

          return { content: [{ type: 'text', text: `# История версий (${versions.length})\n\n${vFormatted}` }] };
        }

        case 'memory_export': {
          const parsed = ExportParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { project_id: expProjectId, format: expFormat, category: expCategory } = parsed.data;
          const resolvedExpProjectId = requireProjectId(expProjectId, 'memory_export');
          if (typeof resolvedExpProjectId !== 'string') return resolvedExpProjectId.response;

          const expEntries = await memoryManager.read({
            projectId: resolvedExpProjectId,
            category: expCategory as any,
            limit: 500,
            status: 'active',
            mode: 'full',
          });

          const exported = exportEntries(expEntries as MemoryEntry[], expFormat);
          return { content: [{ type: 'text', text: exported }] };
        }

        case 'memory_cross_search': {
          const parsed = CrossSearchParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const { query: csQuery, category: csCat, domain: csDom, exclude_project_id: csExclude, limit: csLimit } = parsed.data;

          const results = await memoryManager.crossSearch(csQuery, {
            category: csCat === 'all' ? undefined : csCat,
            domain: csDom,
            excludeProjectId: csExclude,
            limit: csLimit,
          });

          if (results.length === 0) {
            return { content: [{ type: 'text', text: `Ничего не найдено по запросу "${csQuery}" во всех проектах.` }] };
          }

          const formatted = results.map(e => {
            const pi = e.priority === 'critical' ? '🔴' : e.priority === 'high' ? '🟠' : e.priority === 'medium' ? '🟡' : '🟢';
            return `## ${pi} ${e.title}\n**Проект**: ${e.projectName} | **Категория**: ${e.category}${e.domain ? ` | **Домен**: ${e.domain}` : ''}\n**Обновлено**: ${new Date(e.updatedAt).toLocaleString()}\n\n${e.content.length > 300 ? e.content.substring(0, 300) + '...' : e.content}\n\n---`;
          }).join('\n\n');

          return { content: [{ type: 'text', text: `# Cross-Project Search: "${csQuery}" (${results.length} результатов)\n\n${formatted}` }] };
        }

        case 'memory_conventions': {
          const action = args?.action as string;
          const convProjectId = requireProjectId(args?.project_id as string | undefined, 'memory_conventions');
          if (typeof convProjectId !== 'string') return convProjectId.response;
          const projectId: string | undefined = convProjectId;

          if (action === 'list') {
            const entries = await memoryManager.read({
              projectId,
              category: 'conventions',
              status: 'active',
              limit: 100,
              mode: 'full',
            });
            if (entries.length === 0) {
              return { content: [{ type: 'text', text: 'Конвенции не заданы. Используйте action: "add" для добавления.' }] };
            }
            const formatted = (entries as MemoryEntry[]).map(e => {
              const dom = e.domain ? ` [${e.domain}]` : '';
              const tags = e.tags.length > 0 ? ` (${e.tags.join(', ')})` : '';
              return `### 📏 ${e.title}${dom}${tags}\n${e.content}\n`;
            }).join('\n---\n\n');
            return { content: [{ type: 'text', text: `# Конвенции проекта (${entries.length})\n\n${formatted}` }] };
          }

          if (action === 'add') {
            if (!args?.title || !args?.content) {
              return { content: [{ type: 'text', text: '❌ Для добавления конвенции укажите title и content.' }], isError: true };
            }
            const entry = await memoryManager.write({
              projectId,
              category: 'conventions',
              title: args?.title as string,
              content: args?.content as string,
              domain: args?.domain as string,
              tags: (args?.tags as string[]) || [],
              priority: 'high',
              pinned: true,
              author: isAgentToken ? callerAgent : undefined,
            });
            return { content: [{ type: 'text', text: `✅ Конвенция добавлена!\n\n**ID**: ${entry.id}\n**Заголовок**: ${entry.title}\n📌 Автоматически закреплена` }] };
          }

          if (action === 'remove') {
            if (!args?.id) {
              return { content: [{ type: 'text', text: '❌ Для удаления конвенции укажите id.' }], isError: true };
            }
            const success = await memoryManager.delete({ id: args.id as string, archive: true });
            return { content: [{ type: 'text', text: success ? `📦 Конвенция архивирована` : `❌ Не найдена` }] };
          }

          return { content: [{ type: 'text', text: '❌ Неизвестное действие. Используйте: list, add, remove' }], isError: true };
        }

        case 'memory_onboard': {
          const onboardProjectId = requireProjectId(args?.project_id as string | undefined, 'memory_onboard');
          if (typeof onboardProjectId !== 'string') return onboardProjectId.response;
          const summary = await memoryManager.generateOnboarding(onboardProjectId);
          return { content: [{ type: 'text', text: summary }] };
        }

        // === Personal Notes handlers ===

        case 'note_write': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteWriteSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          // note_write requires agent token — master cannot create personal notes (no owner)
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required to create personal notes' }], isError: true };
          const note = await notesManager.write(agentTokenId, {
            title: parsed.data.title,
            content: parsed.data.content,
            tags: parsed.data.tags,
            priority: parsed.data.priority,
            projectId: parsed.data.project_id ?? null,
            sessionId: parsed.data.session_id ?? null,
          });
          return { content: [{ type: 'text', text: `📝 Заметка создана: ${note.id}\n**${note.title}**` }] };
        }

        case 'note_read': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteReadSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const isMaster = callerAgent === 'master';
          const agentTokenId: string | null = isMaster ? null : ((extra as any)?.authInfo?.agentTokenId as string | undefined) ?? null;
          if (!isMaster && !agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const notes = await notesManager.read(agentTokenId, {
            search: parsed.data.search,
            tags: parsed.data.tags,
            projectId: parsed.data.project_id,
            sessionId: parsed.data.session_id,
            status: parsed.data.status,
            mode: parsed.data.mode,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
          });
          if (notes.length === 0) return { content: [{ type: 'text', text: '📝 Заметок не найдено.' }] };
          const lines = notes.map((n: any) => `- **${n.title}** (id: ${n.id}, ${n.status}${n.tags?.length ? ', tags: ' + n.tags.join(', ') : ''})`);
          return { content: [{ type: 'text', text: `📝 Найдено ${notes.length} заметок:\n${lines.join('\n')}` }] };
        }

        case 'note_update': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteUpdateSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const isMaster = callerAgent === 'master';
          const agentTokenId: string | null = isMaster ? null : ((extra as any)?.authInfo?.agentTokenId as string | undefined) ?? null;
          if (!isMaster && !agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const updated = await notesManager.update(parsed.data.id, agentTokenId, {
            title: parsed.data.title,
            content: parsed.data.content,
            tags: parsed.data.tags,
            priority: parsed.data.priority,
            status: parsed.data.status,
            projectId: parsed.data.project_id,
            sessionId: parsed.data.session_id,
          });
          return { content: [{ type: 'text', text: `✅ Заметка обновлена: **${updated.title}**` }] };
        }

        case 'note_delete': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteDeleteSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const isMaster = callerAgent === 'master';
          const agentTokenId: string | null = isMaster ? null : ((extra as any)?.authInfo?.agentTokenId as string | undefined) ?? null;
          if (!isMaster && !agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const deleted = await notesManager.delete(parsed.data.id, agentTokenId, parsed.data.archive);
          return { content: [{ type: 'text', text: deleted ? `✅ Заметка ${parsed.data.archive ? 'архивирована' : 'удалена'}` : '❌ Заметка не найдена' }] };
        }

        case 'note_search': {
          if (!notesManager) return { content: [{ type: 'text', text: '❌ Notes not configured' }], isError: true };
          const parsed = NoteSearchSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required for semantic search' }], isError: true };
          const results = await notesManager.semanticSearch(agentTokenId, parsed.data.query, {
            projectId: parsed.data.project_id,
            sessionId: parsed.data.session_id,
            limit: parsed.data.limit,
          });
          if (results.length === 0) return { content: [{ type: 'text', text: '🔍 Ничего не найдено.' }] };
          const lines = results.map(n => `- [${n.score.toFixed(2)}] **${n.title}** (id: ${n.id})`);
          return { content: [{ type: 'text', text: `🔍 Найдено ${results.length} заметок:\n${lines.join('\n')}` }] };
        }

        // === Session Import handlers ===

        case 'session_import': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionImportSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required for session import' }], isError: true };
          const session = await sessionManager.importSession(agentTokenId, {
            externalId: parsed.data.external_id,
            name: parsed.data.name,
            summary: parsed.data.summary,
            projectId: parsed.data.project_id,
            workingDirectory: parsed.data.working_directory,
            gitBranch: parsed.data.git_branch,
            tags: parsed.data.tags,
            startedAt: parsed.data.started_at,
            endedAt: parsed.data.ended_at,
            messages: parsed.data.messages.map(m => ({
              role: m.role,
              content: m.content,
              timestamp: m.timestamp,
              toolNames: m.tool_names,
            })),
          });
          return { content: [{ type: 'text', text: `📥 Сессия импортирована: ${session.id}\nСообщений: ${session.messageCount}\nСтатус: в очереди на обработку (LLM summary + embedding)` }] };
        }

        case 'session_list': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionListSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const sessions = await sessionManager.listSessions(agentTokenId, {
            projectId: parsed.data.project_id,
            tags: parsed.data.tags,
            dateFrom: parsed.data.date_from,
            dateTo: parsed.data.date_to,
            search: parsed.data.search,
            limit: parsed.data.limit,
            offset: parsed.data.offset,
          });
          if (sessions.length === 0) return { content: [{ type: 'text', text: '📋 Сессий не найдено.' }] };
          const lines = sessions.map(s => `- **${s.name || 'Без названия'}** (${s.messageCount} сообщ., ${s.startedAt?.slice(0, 10) ?? '?'}) id: ${s.id}`);
          return { content: [{ type: 'text', text: `📋 Найдено ${sessions.length} сессий:\n${lines.join('\n')}` }] };
        }

        case 'session_search': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionSearchSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const results = await sessionManager.searchSessions(agentTokenId, parsed.data.query, {
            projectId: parsed.data.project_id,
            limit: parsed.data.limit,
          });
          if (results.length === 0) return { content: [{ type: 'text', text: '🔍 Сессий не найдено.' }] };
          const lines = results.map(s => `- [${s.score.toFixed(2)}] **${s.name || s.summary.slice(0, 60)}** (${s.messageCount} сообщ.) id: ${s.id}`);
          return { content: [{ type: 'text', text: `🔍 Найдено ${results.length} сессий:\n${lines.join('\n')}` }] };
        }

        case 'session_read': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionReadSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const result = await sessionManager.readSession(parsed.data.session_id, agentTokenId, parsed.data.message_from, parsed.data.message_to);
          if (!result) return { content: [{ type: 'text', text: '❌ Сессия не найдена' }], isError: true };
          const header = `📖 **${result.session.name || 'Сессия'}** (${result.session.messageCount} сообщений)\n\n`;
          const msgs = result.messages.map(m => `**[${m.role}]** ${m.content.slice(0, 500)}${m.content.length > 500 ? '...' : ''}`);
          return { content: [{ type: 'text', text: header + msgs.join('\n\n---\n\n') }] };
        }

        case 'session_message_search': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionMessageSearchSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const results = await sessionManager.searchMessages(agentTokenId, parsed.data.query, {
            sessionId: parsed.data.session_id,
            limit: parsed.data.limit,
          });
          if (results.length === 0) return { content: [{ type: 'text', text: '🔍 Сообщений не найдено.' }] };
          const lines = results.map(r => `- [${r.score.toFixed(2)}] **${r.role}** (сессия: ${r.sessionId}, msg #${r.messageIndex})`);
          return { content: [{ type: 'text', text: `🔍 Найдено ${results.length} сообщений:\n${lines.join('\n')}` }] };
        }

        case 'session_delete': {
          if (!sessionManager) return { content: [{ type: 'text', text: '❌ Sessions not configured' }], isError: true };
          const parsed = SessionDeleteSchema.safeParse(args);
          if (!parsed.success) return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          const agentTokenId = (extra as any)?.authInfo?.agentTokenId as string | undefined;
          if (!agentTokenId) return { content: [{ type: 'text', text: '❌ Agent token required' }], isError: true };
          const deleted = await sessionManager.deleteSession(parsed.data.session_id, agentTokenId);
          return { content: [{ type: 'text', text: deleted ? '✅ Сессия удалена' : '❌ Сессия не найдена' }] };
        }

        default:
          return { content: [{ type: 'text', text: `❌ Неизвестный инструмент: ${name}` }], isError: true };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { content: [{ type: 'text', text: `❌ Ошибка: ${message}` }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources: Resource[] = [
      { uri: 'memory://overview', name: 'Обзор проекта', description: 'Общий обзор', mimeType: 'text/markdown' },
      { uri: 'memory://recent', name: 'Последние изменения', description: 'За 24 часа', mimeType: 'text/markdown' },
      { uri: 'memory://architecture', name: 'Архитектура', description: 'Архитектурные решения', mimeType: 'text/markdown' },
      { uri: 'memory://tasks', name: 'Задачи', description: 'Текущие задачи', mimeType: 'text/markdown' },
      { uri: 'memory://issues', name: 'Проблемы', description: 'Известные проблемы', mimeType: 'text/markdown' },
      { uri: 'memory://conventions', name: 'Конвенции', description: 'Конвенции и правила проекта', mimeType: 'text/markdown' }
    ];
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === 'memory://overview') {
      return { contents: [{ uri, mimeType: 'text/markdown', text: await memoryManager.getOverview() }] };
    }
    if (uri === 'memory://recent') {
      const recent = await memoryManager.getRecent();
      const text = recent.length > 0
        ? recent.map(e => `- [${e.category}]${e.domain ? `[${e.domain}]` : ''} **${e.title}** - ${e.author}`).join('\n')
        : 'Нет изменений за 24 часа.';
      return { contents: [{ uri, mimeType: 'text/markdown', text: `# Последние изменения\n\n${text}` }] };
    }
    const VALID_CATEGORIES = ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions'];
    const m = uri.match(/^memory:\/\/(\w+)$/);
    if (m && VALID_CATEGORIES.includes(m[1])) {
      const category = m[1] as Category;
      const entries = await memoryManager.read({ category, status: 'active', mode: 'full' });
      const text = entries.length > 0 ? (entries as MemoryEntry[]).map(e => `## ${e.title}\n${e.content}\n\n---`).join('\n\n') : `Нет записей.`;
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });

  // === Prompts ===

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [{
        name: 'auto-context',
        description: 'Returns relevant team memory entries for the current session. Use at session start for automatic context.',
        arguments: [
          { name: 'project_id', description: 'Project ID', required: false },
          { name: 'context', description: 'Current task description for semantic matching', required: false },
          { name: 'limit', description: 'Max entries to return (default 10)', required: false },
        ],
      }],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    const { name, arguments: promptArgs } = request.params;

    if (name !== 'auto-context') {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      const promptHeaderProjectId = (extra as any)?.authInfo?.projectId as string | undefined;
      const projectId = promptArgs?.project_id || promptHeaderProjectId;
      const context = promptArgs?.context;
      const parsed = promptArgs?.limit ? parseInt(promptArgs.limit, 10) : 10;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
      const callerRole = (extra as any)?.authInfo?.scopes?.[0] as string | undefined;

      const result = await buildAutoContext(memoryManager, {
        projectId,
        context,
        limit,
        agentRole: callerRole,
      });

      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: result.formatted },
        }],
      };
    } catch (err) {
      logger.error({ err }, 'Auto-context prompt failed');
      return {
        messages: [{
          role: 'user',
          content: { type: 'text', text: 'Failed to load team memory context.' },
        }],
      };
    }
  });
}

export class TeamMemoryMCPServer {
  private server: Server;
  private memoryManager: MemoryManager;

  constructor(memoryManager: MemoryManager, agentTokenStore?: AgentTokenStore, notesManager?: NotesManager, sessionManager?: SessionManager) {
    this.memoryManager = memoryManager;
    this.server = buildMcpServer(memoryManager, agentTokenStore, notesManager, sessionManager);
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    logger.info('Team Memory MCP Server started (stdio)');
  }

  getMemoryManager(): MemoryManager {
    return this.memoryManager;
  }
}
