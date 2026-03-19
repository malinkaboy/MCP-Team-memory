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
  MemoryEntry
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

export function buildMcpServer(memoryManager: MemoryManager): Server {
  const server = new Server(
    { name: 'team-memory', version: '2.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  setupHandlers(server, memoryManager);
  return server;
}

function setupHandlers(server: Server, memoryManager: MemoryManager): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: Tool[] = [
      {
        name: 'memory_read',
        description: 'Читает командную память. Используйте для получения информации о текущем состоянии проекта, архитектурных решениях, задачах и проблемах.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта (по умолчанию "default")' },
            category: {
              type: 'string',
              enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions', 'all'],
              description: 'Категория памяти для чтения'
            },
            domain: { type: 'string', description: 'Фильтр по домену (backend, frontend, infrastructure, и т.д.)' },
            search: { type: 'string', description: 'Поиск по ключевым словам' },
            limit: { type: 'number', default: 50, description: 'Максимальное количество записей' },
            status: {
              type: 'string',
              enum: ['active', 'completed', 'archived'],
              description: 'Фильтр по статусу'
            }
          }
        }
      },
      {
        name: 'memory_write',
        description: 'Добавляет новую запись в командную память. Используйте для документирования решений, задач, проблем и прогресса.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта (по умолчанию "default")' },
            category: {
              type: 'string',
              enum: ['architecture', 'tasks', 'decisions', 'issues', 'progress', 'conventions'],
              description: 'Категория записи'
            },
            domain: { type: 'string', description: 'Домен: backend, frontend, infrastructure, devops, database, testing' },
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
        description: 'Обновляет существующую запись в памяти.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'ID записи для обновления' },
            expected_version: { type: 'number', description: 'Ожидаемая версия для optimistic locking. Если текущая версия не совпадает, вернётся ошибка конфликта.' },
            title: { type: 'string', description: 'Новый заголовок' },
            content: { type: 'string', description: 'Новое содержимое' },
            domain: { type: 'string', description: 'Новый домен' },
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
        description: 'Удаляет или архивирует запись из памяти.',
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
        description: 'Получает последние изменения в памяти.',
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
        description: 'Разархивирует запись, возвращая в активный статус.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'ID записи' } },
          required: ['id']
        }
      },
      {
        name: 'memory_pin',
        description: 'Закрепляет или открепляет запись. Закреплённые записи НЕ архивируются автоматически.',
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
        description: 'Управление проектами: список, создание, обновление, удаление.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'update', 'delete'], description: 'Действие' },
            id: { type: 'string', description: 'ID проекта (для update/delete)' },
            name: { type: 'string', description: 'Название проекта' },
            description: { type: 'string', description: 'Описание проекта' },
            domains: { type: 'array', items: { type: 'string' }, description: 'Домены проекта' }
          },
          required: ['action']
        }
      },
      {
        name: 'memory_audit',
        description: 'Просмотр истории изменений записи или проекта (аудит-лог).',
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
        description: 'Показывает историю версий записи. Используйте для отслеживания изменений.',
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
        description: 'Экспортирует записи в формат Markdown или JSON.',
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
        description: 'Управление конвенциями проекта (стиль кода, паттерны, правила). Используйте для хранения .editorconfig-подобных правил для AI-агентов.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'add', 'remove'],
              description: 'Действие: list — показать конвенции, add — добавить, remove — удалить'
            },
            project_id: { type: 'string', description: 'ID проекта' },
            title: { type: 'string', description: 'Название конвенции (для add)' },
            content: { type: 'string', description: 'Описание конвенции (для add)' },
            domain: { type: 'string', description: 'Домен конвенции (для add)' },
            tags: { type: 'array', items: { type: 'string' }, description: 'Теги (для add)' },
            id: { type: 'string', description: 'ID конвенции (для remove)' },
          },
          required: ['action']
        }
      },
      {
        name: 'memory_cross_search',
        description: 'Поиск паттернов и решений МЕЖДУ проектами. Находит релевантные записи из всех проектов.',
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
        description: 'Генерирует полную сводку проекта для нового агента/члена команды: конвенции, архитектура, решения, задачи, проблемы, стек. Один вызов вместо десяти memory_read.',
        inputSchema: {
          type: 'object',
          properties: {
            project_id: { type: 'string', description: 'ID проекта (по умолчанию "default")' },
          },
        }
      }
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

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const args = coerceArrayFields(rawArgs);

    try {
      switch (name) {
        case 'memory_read': {
          const parsed = ReadParamsSchema.safeParse(args);
          if (!parsed.success) {
            return { content: [{ type: 'text', text: `❌ Ошибка валидации: ${formatZodError(parsed.error)}` }], isError: true };
          }
          const params: ReadParams = {
            projectId: parsed.data.project_id || undefined,
            category: parsed.data.category,
            domain: parsed.data.domain,
            search: parsed.data.search,
            limit: parsed.data.limit,
            status: parsed.data.status
          };
          const entries = await memoryManager.read(params);
          if (entries.length === 0) {
            return { content: [{ type: 'text', text: 'Записи не найдены по заданным критериям.' }] };
          }
          const formatted = entries.map(e => {
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
          const params: WriteParams = { ...writeData, projectId: project_id };
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
          const params: SyncParams = { projectId: parsed.data.project_id || undefined, since: parsed.data.since };
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

          let auditEntries;
          if (auditEntryId) {
            auditEntries = await auditLogger.getByEntry(auditEntryId, auditLimit);
          } else if (auditProjectId) {
            auditEntries = await auditLogger.getByProject(auditProjectId, auditLimit);
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

          const expEntries = await memoryManager.read({
            projectId: expProjectId,
            category: expCategory as any,
            limit: 500,
            status: 'active',
          });

          const exported = exportEntries(expEntries, expFormat);
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
          const projectId = (args?.project_id as string) || undefined;

          if (action === 'list') {
            const entries = await memoryManager.read({
              projectId,
              category: 'conventions',
              status: 'active',
              limit: 100,
            });
            if (entries.length === 0) {
              return { content: [{ type: 'text', text: 'Конвенции не заданы. Используйте action: "add" для добавления.' }] };
            }
            const formatted = entries.map(e => {
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
          const projectId = args?.project_id as string | undefined;
          const summary = await memoryManager.generateOnboarding(projectId);
          return { content: [{ type: 'text', text: summary }] };
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
      const entries = await memoryManager.read({ category, status: 'active' });
      const text = entries.length > 0 ? entries.map(e => `## ${e.title}\n${e.content}\n\n---`).join('\n\n') : `Нет записей.`;
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

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: promptArgs } = request.params;

    if (name !== 'auto-context') {
      throw new Error(`Unknown prompt: ${name}`);
    }

    try {
      const projectId = promptArgs?.project_id;
      const context = promptArgs?.context;
      const parsed = promptArgs?.limit ? parseInt(promptArgs.limit, 10) : 10;
      const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;

      const result = await buildAutoContext(memoryManager, {
        projectId,
        context,
        limit,
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

  constructor(memoryManager: MemoryManager) {
    this.memoryManager = memoryManager;
    this.server = buildMcpServer(memoryManager);
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
