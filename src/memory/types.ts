// Категории памяти
export type Category =
  | 'architecture'  // Архитектурные решения
  | 'tasks'         // Текущие задачи
  | 'decisions'     // Принятые решения
  | 'issues'        // Известные проблемы
  | 'progress'      // Прогресс разработки
  | 'conventions';  // Конвенции проекта (стиль кода, паттерны, правила)

// Приоритеты
export type Priority = 'low' | 'medium' | 'high' | 'critical';

// Статусы записей
export type Status = 'active' | 'completed' | 'archived';

// Режимы синхронизации
export type SyncMode = 'auto' | 'manual' | 'both';

/** Default project UUID — used when no project_id is specified */
export const DEFAULT_PROJECT_ID = '00000000-0000-0000-0000-000000000000';

// Домены по умолчанию
export const DEFAULT_DOMAINS: string[] = [
  'backend',
  'frontend',
  'infrastructure',
  'devops',
  'database',
  'testing',
];

// Project roles — soft bias for auto-recall ordering
export type ProjectRole = 'developer' | 'qa' | 'lead' | 'devops';
export const PROJECT_ROLES: ProjectRole[] = ['developer', 'qa', 'lead', 'devops'];

export const ROLE_PRIORITIES: Record<ProjectRole, { categories: Category[]; domains: string[]; boost: number }> = {
  developer: { categories: ['architecture', 'decisions', 'conventions'], domains: ['backend', 'frontend', 'database'], boost: 1.5 },
  qa:        { categories: ['issues', 'tasks', 'conventions'], domains: ['testing'], boost: 1.5 },
  lead:      { categories: ['progress', 'tasks', 'decisions'], domains: [], boost: 1.3 },
  devops:    { categories: ['architecture', 'tasks'], domains: ['infrastructure', 'devops'], boost: 1.5 },
};

export const ROLE_INFO: Record<ProjectRole, { name: string; nameEn: string; icon: string }> = {
  developer: { name: 'Разработчик', nameEn: 'Developer', icon: '💻' },
  qa:        { name: 'Тестировщик', nameEn: 'QA',        icon: '🧪' },
  lead:      { name: 'Руководитель', nameEn: 'Lead',      icon: '👔' },
  devops:    { name: 'DevOps',      nameEn: 'DevOps',    icon: '⚙️' },
};

// Проект
export interface Project {
  id: string;
  name: string;
  description: string;
  domains: string[];
  createdAt: string;
  updatedAt: string;
}

// Запись в памяти
export interface MemoryEntry {
  id: string;
  projectId: string;       // ID проекта
  category: Category;
  domain: string | null;   // Домен: backend, frontend, infrastructure, etc.
  title: string;
  content: string;
  author: string;
  tags: string[];
  priority: Priority;
  status: Status;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  relatedIds: string[];
  currentVersion?: number; // Текущая версия записи (optimistic locking)
  readCount?: number;      // Количество чтений (для decay scoring)
  lastReadAt?: string;     // Последнее чтение (ISO string)
}

// Хранилище памяти (legacy, для миграции)
export interface MemoryStore {
  version: string;
  lastUpdated: string;
  entries: LegacyMemoryEntry[];
  metadata: {
    projectName: string;
    team: string[];
    createdAt: string;
  };
}

// Legacy entry format (v1, без projectId и domain)
export interface LegacyMemoryEntry {
  id: string;
  category: Category;
  title: string;
  content: string;
  author: string;
  tags: string[];
  priority: Priority;
  status: Status;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  relatedIds: string[];
}

// Конфигурация сервера
export interface ServerConfig {
  dataPath: string;
  webPort: number;
  wsPort: number;
  syncMode: SyncMode;
  backupEnabled: boolean;
  backupInterval: number;
  autoArchiveEnabled: boolean;
  autoArchiveDays: number;
}

// Параметры для чтения памяти
export interface ReadParams {
  projectId?: string;
  category?: Category | 'all';
  domain?: string;
  search?: string;
  limit?: number;
  status?: Status;
  tags?: string[];
}

// Параметры для записи в память
export interface WriteParams {
  projectId?: string;
  category: Category;
  domain?: string;
  title: string;
  content: string;
  author?: string;
  tags?: string[];
  priority?: Priority;
  pinned?: boolean;
  relatedIds?: string[];
}

// Параметры для обновления записи
export interface UpdateParams {
  id: string;
  expectedVersion?: number; // Optimistic locking: обновление только если версия совпадает
  title?: string;
  content?: string;
  domain?: string | null;
  status?: Status;
  tags?: string[];
  priority?: Priority;
  pinned?: boolean;
  relatedIds?: string[];
}

// Ошибка конфликта версий (optimistic locking)
export interface ConflictError {
  conflict: true;
  currentVersion: number;
  currentEntry: MemoryEntry;
  message: string;
}

// Параметры для удаления/архивации
export interface DeleteParams {
  id: string;
  archive?: boolean;
}

// Параметры синхронизации
export interface SyncParams {
  projectId?: string;
  since?: string; // ISO date string
}

// Результат синхронизации
export interface SyncResult {
  entries: MemoryEntry[];
  lastUpdated: string;
  totalChanges: number;
}

// События WebSocket
export type WSEventType =
  | 'memory:created'
  | 'memory:updated'
  | 'memory:deleted'
  | 'memory:sync'
  | 'agent:connected'
  | 'agent:disconnected';

export interface WSEvent {
  type: WSEventType;
  payload: unknown;
  timestamp: string;
}

// Статистика для UI
export interface MemoryStats {
  totalEntries: number;
  byCategory: Record<Category, number>;
  byDomain: Record<string, number>;
  byStatus: Record<Status, number>;
  byPriority: Record<Priority, number>;
  recentActivity: {
    last24h: number;
    last7d: number;
  };
  connectedAgents: number;
}

// Описания категорий для UI
export const CATEGORY_INFO: Record<Category, { name: string; description: string; icon: string }> = {
  architecture: {
    name: 'Архитектура',
    description: 'Архитектурные решения, выбор стека, структура проекта',
    icon: '🏗️'
  },
  tasks: {
    name: 'Задачи',
    description: 'Текущие задачи, в работе, запланированные',
    icon: '📋'
  },
  decisions: {
    name: 'Решения',
    description: 'Принятые решения и их обоснование',
    icon: '✅'
  },
  issues: {
    name: 'Проблемы',
    description: 'Известные проблемы, баги, технический долг',
    icon: '🐛'
  },
  progress: {
    name: 'Прогресс',
    description: 'Прогресс разработки, завершённые этапы',
    icon: '📈'
  },
  conventions: {
    name: 'Конвенции',
    description: 'Стиль кода, архитектурные паттерны, правила проекта',
    icon: '📏'
  }
};

// Цвета приоритетов для UI
export const PRIORITY_COLORS: Record<Priority, string> = {
  low: '#6b7280',
  medium: '#3b82f6',
  high: '#f59e0b',
  critical: '#ef4444'
};

// Цвета статусов для UI
export const STATUS_COLORS: Record<Status, string> = {
  active: '#22c55e',
  completed: '#6b7280',
  archived: '#9ca3af'
};

// Информация о доменах
export const DOMAIN_INFO: Record<string, { name: string; icon: string }> = {
  backend: { name: 'Бэкенд', icon: '🖥️' },
  frontend: { name: 'Фронтенд', icon: '🎨' },
  infrastructure: { name: 'Инфраструктура', icon: '🏗️' },
  devops: { name: 'DevOps', icon: '⚙️' },
  database: { name: 'База данных', icon: '🗄️' },
  testing: { name: 'Тестирование', icon: '🧪' },
};
