// Team Memory Dashboard v2 - JavaScript

const API_BASE = '/api';

// State
let currentCategory = 'all';
let currentSearch = '';
let currentStatus = '';
let currentDomain = '';
let currentProjectId = localStorage.getItem('selected-project') || '';
let entries = [];
let projects = [];
let ws = null;
let isGraphView = false;

// Domain display info
const domainInfo = {
  backend:        { name: 'Backend',        icon: 'server' },
  frontend:       { name: 'Frontend',       icon: 'monitor' },
  infrastructure: { name: 'Infrastructure', icon: 'network' },
  devops:         { name: 'DevOps',         icon: 'container' },
  database:       { name: 'Database',       icon: 'database' },
  testing:        { name: 'Testing',        icon: 'test-tubes' }
};

// DOM Elements
const entriesContainer = document.getElementById('entries-container');
const searchInput = document.getElementById('search-input');
const statusSelect = document.getElementById('status-select');
const statusSelectTrigger = statusSelect.querySelector('.custom-select-trigger');
const statusSelectValue = statusSelect.querySelector('.custom-select-value');
const statusOptionsContainer = document.getElementById('status-options');
const pageTitle = document.getElementById('page-title');
const modal = document.getElementById('entry-modal');
const entryForm = document.getElementById('entry-form');
const toastContainer = document.getElementById('toast-container');
const projectSelect = document.getElementById('project-select');
const projectSelectTrigger = projectSelect.querySelector('.custom-select-trigger');
const projectSelectValue = projectSelect.querySelector('.custom-select-value');
const projectOptionsContainer = document.getElementById('project-options');
const domainFiltersContainer = document.getElementById('domain-filters');
const projectsModal = document.getElementById('projects-modal');

// Category config
const categoryConfig = {
  all: { title: 'Все записи', icon: 'layout-grid' },
  pinned: { title: 'Закреплённые', icon: 'pin' },
  architecture: { title: 'Архитектура', icon: 'building-2' },
  tasks: { title: 'Задачи', icon: 'clipboard-list' },
  decisions: { title: 'Решения', icon: 'check-circle-2' },
  issues: { title: 'Проблемы', icon: 'bug' },
  progress: { title: 'Прогресс', icon: 'trending-up' }
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  initSidebarToggle();
  initNavigation();
  initSearch();
  initModal();
  initProjectsModal();
  initWebSocket();
  await loadProjects();
  loadEntries();
  loadStats();
});

// === Projects ===

async function loadProjects() {
  try {
    const response = await fetch(`${API_BASE}/projects`);
    const result = await response.json();

    if (result.success) {
      projects = result.projects;
      renderProjectSelect();
      renderDomainFilters();
    }
  } catch (error) {
    console.error('Failed to load projects:', error);
  }
}

function renderProjectSelect() {
  const current = currentProjectId;
  projectOptionsContainer.innerHTML = '';

  for (const p of projects) {
    const opt = document.createElement('div');
    opt.className = 'custom-select-option' + (p.id === current ? ' selected' : '');
    opt.dataset.value = p.id;
    opt.innerHTML = `
      <span class="custom-select-option-name">${escapeHtml(p.name)}</span>
      ${p.description ? `<span class="custom-select-option-desc">${escapeHtml(p.description)}</span>` : ''}
    `;
    opt.addEventListener('click', () => {
      selectProjectOption(p.id);
    });
    projectOptionsContainer.appendChild(opt);
  }

  // Restore selection or select default
  if (current && projects.some(p => p.id === current)) {
    updateProjectSelectDisplay(current);
  } else if (projects.length > 0) {
    const defaultProject = projects.find(p => p.name === 'default') || projects[0];
    updateProjectSelectDisplay(defaultProject.id);
    currentProjectId = defaultProject.id;
  }
}

function updateProjectSelectDisplay(projectId) {
  const project = projects.find(p => p.id === projectId);
  if (project) {
    projectSelectValue.textContent = project.name;
  }
  // Update selected state
  projectOptionsContainer.querySelectorAll('.custom-select-option').forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === projectId);
  });
}

function selectProjectOption(projectId) {
  projectSelect.classList.remove('open');
  updateProjectSelectDisplay(projectId);
  switchProject(projectId);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderDomainFilters() {
  const project = projects.find(p => p.id === currentProjectId);
  const domains = project ? project.domains : [];

  domainFiltersContainer.innerHTML = '';

  // "All domains" pill
  const allBtn = document.createElement('button');
  allBtn.className = 'domain-pill' + (currentDomain === '' ? ' active' : '');
  allBtn.dataset.domain = '';
  allBtn.textContent = 'Все домены';
  allBtn.addEventListener('click', () => selectDomain(''));
  domainFiltersContainer.appendChild(allBtn);

  // Domain pills
  for (const d of domains) {
    const btn = document.createElement('button');
    btn.className = 'domain-pill' + (currentDomain === d ? ' active' : '');
    btn.dataset.domain = d;
    const info = domainInfo[d];
    btn.innerHTML = info
      ? `<i data-lucide="${info.icon}"></i> ${info.name}`
      : escapeHtml(d);
    btn.addEventListener('click', () => selectDomain(d));
    domainFiltersContainer.appendChild(btn);
  }

  lucide.createIcons();
}

function selectDomain(domain) {
  currentDomain = domain;
  domainFiltersContainer.querySelectorAll('.domain-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.domain === domain);
  });
  loadEntries();
}

function switchProject(projectId) {
  currentProjectId = projectId;
  localStorage.setItem('selected-project', projectId);
  currentDomain = '';
  renderDomainFilters();
  populateEntryDomainSelect();
  loadEntries();
  loadStats();
}

function populateEntryDomainSelect() {
  const domainSelect = document.getElementById('entry-domain');
  const project = projects.find(p => p.id === currentProjectId);
  const domains = project ? project.domains : [];

  domainSelect.innerHTML = '<option value="">Без домена</option>';
  for (const d of domains) {
    const opt = document.createElement('option');
    opt.value = d;
    const info = domainInfo[d];
    opt.textContent = info ? info.name : d;
    domainSelect.appendChild(opt);
  }
}

// Navigation
function initNavigation() {
  document.querySelectorAll('.nav-item[data-category]').forEach(item => {
    item.addEventListener('click', () => {
      if (isGraphView) toggleGraphView(false);

      document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      currentCategory = item.dataset.category;
      pageTitle.textContent = categoryConfig[currentCategory].title;
      loadEntries();
    });
  });

  document.getElementById('btn-add').addEventListener('click', () => openModal());

  document.getElementById('btn-export').addEventListener('click', () => {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    params.append('format', 'markdown');
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      params.append('category', currentCategory);
    }
    window.open(`${API_BASE}/export?${params}`, '_blank');
  });

  // Graph view toggle
  document.getElementById('btn-graph-view').addEventListener('click', () => {
    toggleGraphView(true);
  });

  // Custom project dropdown toggle
  projectSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    projectSelect.classList.toggle('open');
    statusSelect.classList.remove('open');
  });

  // Custom status dropdown toggle
  statusSelectTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    statusSelect.classList.toggle('open');
    projectSelect.classList.remove('open');
  });

  // Status option click handlers
  statusOptionsContainer.querySelectorAll('.custom-select-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const value = opt.dataset.value;
      currentStatus = value;
      statusSelectValue.textContent = opt.querySelector('.custom-select-option-name').textContent;
      statusOptionsContainer.querySelectorAll('.custom-select-option').forEach(o =>
        o.classList.toggle('selected', o === opt)
      );
      statusSelect.classList.remove('open');
      loadEntries();
    });
  });

  // Close dropdowns on outside click
  document.addEventListener('click', (e) => {
    if (!projectSelect.contains(e.target)) {
      projectSelect.classList.remove('open');
    }
    if (!statusSelect.contains(e.target)) {
      statusSelect.classList.remove('open');
    }
  });
}

// Sidebar collapse toggle
function initSidebarToggle() {
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const stored = localStorage.getItem('sidebar-collapsed');
  if (stored === 'true') sidebar.classList.add('collapsed');

  toggleBtn.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed'));
  });
}

// Search & Filter
function initSearch() {
  let searchTimeout;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentSearch = e.target.value;
      loadEntries();
    }, 300);
  });

}

// === Entry Modal ===

function initModal() {
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  entryForm.addEventListener('submit', handleFormSubmit);
}

function openModal(entry = null) {
  populateEntryDomainSelect();
  const modalTitle = document.getElementById('modal-title');

  if (entry) {
    modalTitle.textContent = 'Редактировать запись';
    document.getElementById('entry-id').value = entry.id;
    document.getElementById('entry-category').value = entry.category;
    document.getElementById('entry-domain').value = entry.domain || '';
    document.getElementById('entry-title').value = entry.title;
    document.getElementById('entry-content').value = entry.content;
    document.getElementById('entry-priority').value = entry.priority;
    document.getElementById('entry-status').value = entry.status;
    document.getElementById('entry-tags').value = entry.tags.join(', ');
    document.getElementById('entry-author').value = entry.author;
  } else {
    modalTitle.textContent = 'Добавить запись';
    entryForm.reset();
    document.getElementById('entry-id').value = '';
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      document.getElementById('entry-category').value = currentCategory;
    }
    if (currentDomain) {
      document.getElementById('entry-domain').value = currentDomain;
    }
  }

  modal.classList.add('active');
}

function closeModal() {
  modal.classList.remove('active');
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const id = document.getElementById('entry-id').value;
  const data = {
    category: document.getElementById('entry-category').value,
    domain: document.getElementById('entry-domain').value || null,
    title: document.getElementById('entry-title').value,
    content: document.getElementById('entry-content').value,
    priority: document.getElementById('entry-priority').value,
    status: document.getElementById('entry-status').value,
    tags: document.getElementById('entry-tags').value.split(',').map(t => t.trim()).filter(Boolean),
    author: document.getElementById('entry-author').value || 'web-ui'
  };

  if (!id) {
    data.project_id = currentProjectId;
  }

  try {
    let response;
    if (id) {
      response = await fetch(`${API_BASE}/memory/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } else {
      response = await fetch(`${API_BASE}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    }

    const result = await response.json();

    if (result.success) {
      showToast(id ? 'Запись обновлена' : 'Запись добавлена', 'success');
      closeModal();
      loadEntries();
      loadStats();
    } else {
      showToast(result.error || 'Ошибка сохранения', 'error');
    }
  } catch (error) {
    showToast('Ошибка сети', 'error');
    console.error(error);
  }
}

// === Projects Modal ===

function initProjectsModal() {
  document.getElementById('btn-manage-projects').addEventListener('click', openProjectsModal);
  document.getElementById('projects-modal-close').addEventListener('click', closeProjectsModal);
  projectsModal.addEventListener('click', (e) => {
    if (e.target === projectsModal) closeProjectsModal();
  });
  document.getElementById('btn-create-project').addEventListener('click', createProject);
}

function openProjectsModal() {
  projectsModal.classList.add('active');
  renderProjectsList();
  lucide.createIcons();
}

function closeProjectsModal() {
  projectsModal.classList.remove('active');
}

function renderProjectsList() {
  const container = document.getElementById('projects-list');

  if (projects.length === 0) {
    container.innerHTML = '<div class="empty-state-text">Нет проектов</div>';
    return;
  }

  container.innerHTML = projects.map(p => `
    <div class="project-item" data-id="${p.id}">
      <div class="project-item-info">
        <div class="project-item-name">
          <i data-lucide="folder"></i>
          <strong>${escapeHtml(p.name)}</strong>
          ${p.name === 'default' ? '<span class="badge">по умолчанию</span>' : ''}
        </div>
        <div class="project-item-desc">${p.description ? escapeHtml(p.description) : '<em>Нет описания</em>'}</div>
        <div class="project-item-domains">
          ${p.domains.map(d => {
            const info = domainInfo[d];
            return `<span class="domain-tag">${info ? info.name : escapeHtml(d)}</span>`;
          }).join('')}
        </div>
      </div>
      <div class="project-item-actions">
        ${p.name !== 'default' ? `
          <button class="btn-icon" onclick="deleteProject('${p.id}')" title="Удалить проект">
            <i data-lucide="trash-2"></i>
          </button>
        ` : ''}
      </div>
    </div>
  `).join('');

  lucide.createIcons();
}

async function createProject() {
  const nameInput = document.getElementById('new-project-name');
  const descInput = document.getElementById('new-project-description');
  const name = nameInput.value.trim();
  const description = descInput.value.trim();

  if (!name) {
    showToast('Введите название проекта', 'error');
    return;
  }

  try {
    const response = await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description })
    });

    const result = await response.json();

    if (result.success) {
      showToast('Проект создан', 'success');
      nameInput.value = '';
      descInput.value = '';
      await loadProjects();
      renderProjectsList();
    } else {
      showToast(result.error || 'Ошибка создания', 'error');
    }
  } catch (error) {
    showToast('Ошибка сети', 'error');
    console.error(error);
  }
}

window.deleteProject = async function(id) {
  const project = projects.find(p => p.id === id);
  if (!project) return;

  if (!confirm(`Удалить проект "${project.name}" и все его записи?`)) return;

  try {
    const response = await fetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
    const result = await response.json();

    if (result.success) {
      showToast('Проект удалён', 'success');

      // Switch to default if deleted current
      if (currentProjectId === id) {
        const defaultProject = projects.find(p => p.name === 'default');
        if (defaultProject) switchProject(defaultProject.id);
      }

      await loadProjects();
      renderProjectsList();
    } else {
      showToast(result.error || 'Ошибка удаления', 'error');
    }
  } catch (error) {
    showToast('Ошибка сети', 'error');
    console.error(error);
  }
};

// === Load Data ===

async function loadEntries() {
  entriesContainer.innerHTML = `
    <div class="loading">
      <i data-lucide="loader-2" class="spin"></i>
      <span>Загрузка...</span>
    </div>
  `;
  lucide.createIcons();

  try {
    const params = new URLSearchParams();

    if (currentProjectId) params.append('project_id', currentProjectId);
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      params.append('category', currentCategory);
    }
    if (currentDomain) params.append('domain', currentDomain);
    if (currentSearch) params.append('search', currentSearch);
    if (currentStatus) params.append('status', currentStatus);

    const response = await fetch(`${API_BASE}/memory?${params}`);
    const result = await response.json();

    if (result.success) {
      entries = result.entries;

      if (currentCategory === 'pinned') {
        entries = entries.filter(e => e.pinned === true);
      }

      renderEntries();
    }
  } catch (error) {
    entriesContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="alert-triangle"></i>
        <div class="empty-state-text">Ошибка загрузки данных</div>
      </div>
    `;
    lucide.createIcons();
    console.error(error);
  }
}

async function loadStats() {
  try {
    const params = currentProjectId ? `?project_id=${currentProjectId}` : '';
    const response = await fetch(`${API_BASE}/stats${params}`);
    const result = await response.json();

    if (result.success) {
      const stats = result.stats;

      document.getElementById('count-all').textContent = stats.totalEntries;
      document.getElementById('count-architecture').textContent = stats.byCategory.architecture || 0;
      document.getElementById('count-tasks').textContent = stats.byCategory.tasks || 0;
      document.getElementById('count-decisions').textContent = stats.byCategory.decisions || 0;
      document.getElementById('count-issues').textContent = stats.byCategory.issues || 0;
      document.getElementById('count-progress').textContent = stats.byCategory.progress || 0;

      document.getElementById('stat-total').textContent = stats.totalEntries;
      document.getElementById('stat-24h').textContent = stats.recentActivity?.last24h || 0;

      document.getElementById('agents-count').textContent =
        `${stats.connectedAgents || 0} агентов онлайн`;

      // Embedding stats
      if (result.embedding) {
        renderEmbeddingIndicator(result.embedding);
      }
    }

    // Load pinned count
    const pinnedParams = new URLSearchParams();
    if (currentProjectId) pinnedParams.append('project_id', currentProjectId);
    const allResponse = await fetch(`${API_BASE}/memory?${pinnedParams}`);
    const allResult = await allResponse.json();
    if (allResult.success) {
      const pinnedCount = allResult.entries.filter(e => e.pinned === true).length;
      document.getElementById('count-pinned').textContent = pinnedCount;
    }
  } catch (error) {
    console.error('Failed to load stats:', error);
  }
}

// === Render ===

function renderEntries() {
  if (entries.length === 0) {
    entriesContainer.innerHTML = `
      <div class="empty-state">
        <i data-lucide="file-text"></i>
        <div class="empty-state-text">Нет записей${currentSearch ? ' по запросу "' + escapeHtml(currentSearch) + '"' : ''}</div>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  entriesContainer.innerHTML = entries.map(entry => {
    const dInfo = entry.domain ? domainInfo[entry.domain] : null;
    const domainBadge = entry.domain
      ? `<span class="entry-domain-badge">${dInfo ? dInfo.name : escapeHtml(entry.domain)}</span>`
      : '';

    return `
    <div class="entry-card ${entry.status}${entry.pinned ? ' pinned' : ''}" data-id="${entry.id}">
      <div class="entry-header">
        <div class="entry-title">
          ${entry.pinned ? '<i data-lucide="pin" class="pin-indicator"></i>' : ''}
          <span class="priority-dot priority-${entry.priority}"></span>
          ${escapeHtml(entry.title)}
        </div>
        <div class="entry-badges">
          ${domainBadge}
          <span class="entry-category">
            <i data-lucide="${categoryConfig[entry.category]?.icon || 'file'}"></i>
            ${entry.category}
          </span>
        </div>
      </div>
      <div class="entry-content">${escapeHtml(entry.content)}</div>
      ${entry.tags.length > 0 ? `
        <div class="entry-tags">
          ${entry.tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="entry-footer">
        <div class="entry-meta">
          <span><i data-lucide="user"></i> ${escapeHtml(entry.author)}</span>
          <span><i data-lucide="calendar"></i> ${formatDate(entry.updatedAt)}</span>
        </div>
        <div class="entry-actions">
          <button onclick="togglePin('${entry.id}')" title="${entry.pinned ? 'Открепить' : 'Закрепить'}" class="${entry.pinned ? 'active' : ''}">
            <i data-lucide="pin"></i>
          </button>
          <button onclick="editEntry('${entry.id}')" title="Редактировать">
            <i data-lucide="pencil"></i>
          </button>
          <button onclick="showHistory('${entry.id}')" title="История">
            <i data-lucide="history"></i>
          </button>
          <button onclick="archiveEntry('${entry.id}')" title="Архивировать">
            <i data-lucide="archive"></i>
          </button>
          <button onclick="deleteEntry('${entry.id}')" title="Удалить">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
    </div>
  `}).join('');

  lucide.createIcons();
}

// === Entry Actions ===

window.editEntry = function(id) {
  const entry = entries.find(e => e.id === id);
  if (entry) openModal(entry);
};

window.archiveEntry = async function(id) {
  if (!confirm('Архивировать эту запись?')) return;

  try {
    const response = await fetch(`${API_BASE}/memory/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });

    const result = await response.json();

    if (result.success) {
      showToast('Запись архивирована', 'success');
      loadEntries();
      loadStats();
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Ошибка архивации', 'error');
  }
};

window.deleteEntry = async function(id) {
  if (!confirm('Удалить эту запись навсегда?')) return;

  try {
    const response = await fetch(`${API_BASE}/memory/${id}?archive=false`, {
      method: 'DELETE'
    });

    const result = await response.json();

    if (result.success) {
      showToast('Запись удалена', 'success');
      loadEntries();
      loadStats();
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Ошибка удаления', 'error');
  }
};

window.togglePin = async function(id) {
  const entry = entries.find(e => e.id === id);
  if (!entry) return;

  const newPinned = !entry.pinned;

  try {
    const response = await fetch(`${API_BASE}/memory/${id}/pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: newPinned })
    });

    const result = await response.json();

    if (result.success) {
      showToast(newPinned ? 'Запись закреплена' : 'Запись откреплена', 'success');
      loadEntries();
      loadStats();
    } else {
      showToast(result.error, 'error');
    }
  } catch (error) {
    showToast('Ошибка при изменении закрепления', 'error');
  }
};

window.showHistory = async function(id) {
  try {
    const response = await fetch(`${API_BASE}/memory/${id}/history`);
    const result = await response.json();

    if (!result.success) {
      showToast(result.error || 'Ошибка загрузки истории', 'error');
      return;
    }

    if (result.versions.length === 0) {
      showToast('Запись ещё не обновлялась — история пуста', 'info');
      return;
    }

    const text = result.versions.map(v =>
      `v${v.version} [${new Date(v.createdAt).toLocaleString()}]\n  ${v.title} (${v.status})`
    ).join('\n\n');

    alert(`История версий:\n\n${text}`);
  } catch (error) {
    showToast('Ошибка загрузки истории', 'error');
    console.error(error);
  }
};

// === WebSocket ===

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('WebSocket connected');
      showToast('Подключено к серверу', 'info');
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWSMessage(data);
      } catch (e) {
        console.error('Invalid WS message:', e);
      }
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      setTimeout(initWebSocket, 5000);
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  } catch (error) {
    console.error('Failed to connect WebSocket:', error);
  }
}

function handleWSMessage(data) {
  switch (data.type) {
    case 'memory:created':
    case 'memory:updated':
    case 'memory:deleted':
      loadEntries();
      loadStats();
      if (data.type === 'memory:created') {
        showToast('Новая запись добавлена', 'info');
      }
      break;

    case 'agent:connected':
      if (!data.payload.renamed) {
        loadStats();
      }
      break;

    case 'agent:disconnected':
      loadStats();
      break;
  }
}

// === Helpers ===

function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  if (diff < 60000) return 'только что';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} мин назад`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} ч назад`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)} дн назад`;

  return date.toLocaleDateString('ru-RU');
}

// === Graph View Toggle ===

function toggleGraphView(show) {
  isGraphView = show;

  const entriesEl = document.getElementById('entries-container');
  const domainEl = document.getElementById('domain-filters');
  const graphEl = document.getElementById('graph-view');
  const headerRight = document.querySelector('.header-right');

  if (show) {
    entriesEl.style.display = 'none';
    domainEl.style.display = 'none';
    graphEl.style.display = 'flex';
    headerRight.style.visibility = 'hidden';

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById('btn-graph-view').classList.add('active');
    pageTitle.textContent = 'Граф знаний';

    // Load all entries for graph (no filters, higher limit)
    loadGraphEntries();
  } else {
    entriesEl.style.display = '';
    domainEl.style.display = '';
    graphEl.style.display = 'none';
    headerRight.style.visibility = '';
    if (typeof destroyGraph === 'function') destroyGraph();
  }
}

async function loadGraphEntries() {
  try {
    const params = new URLSearchParams();
    if (currentProjectId) params.append('project_id', currentProjectId);
    params.append('limit', '500');

    const response = await fetch(`${API_BASE}/memory?${params}`);
    const result = await response.json();

    if (result.success && typeof renderGraph === 'function') {
      renderGraph(result.entries);
    }
  } catch (error) {
    console.error('Failed to load graph entries:', error);
  }
}

// === Embedding Indicator ===

function renderEmbeddingIndicator(emb) {
  const dot = document.getElementById('embedding-dot');
  const countEl = document.getElementById('embedding-count');
  const indicator = document.getElementById('embedding-indicator');
  const panel = document.getElementById('embedding-panel');

  if (!emb.provider) {
    dot.className = 'embedding-dot inactive';
    countEl.textContent = '—';
    indicator.title = 'Векторный поиск отключён';
  } else if (emb.isReady && emb.entriesEmbedded >= emb.entriesTotal) {
    dot.className = 'embedding-dot active';
    countEl.textContent = `${emb.entriesEmbedded}/${emb.entriesTotal}`;
    indicator.title = `${emb.model} · ${emb.dimensions}d · Все записи проиндексированы`;
  } else if (emb.isReady) {
    dot.className = 'embedding-dot partial';
    countEl.textContent = `${emb.entriesEmbedded}/${emb.entriesTotal}`;
    const pct = emb.entriesTotal > 0 ? Math.round(emb.entriesEmbedded / emb.entriesTotal * 100) : 0;
    indicator.title = `${emb.model} · ${emb.dimensions}d · ${pct}% проиндексировано`;
  } else {
    dot.className = 'embedding-dot inactive';
    countEl.textContent = '—';
    indicator.title = 'Модель не инициализирована';
  }

  // Render models panel
  renderEmbeddingPanel(emb);

  // Toggle on click
  indicator.onclick = (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
  };
}

function renderEmbeddingPanel(emb) {
  const modelsEl = document.getElementById('embedding-models');
  const progressEl = document.getElementById('embedding-progress');

  const models = [
    {
      id: 'gemini',
      label: 'Gemini API',
      name: 'gemini-embedding-001',
      dims: 768,
      active: emb.provider === 'gemini',
      warning: null
    },
    {
      id: 'local',
      label: 'Local ONNX',
      name: 'all-MiniLM-L6-v2',
      dims: 384,
      active: emb.provider === 'local',
      warning: emb.provider !== 'local' ? 'Модель не установлена' : null
    },
    {
      id: 'disabled',
      label: 'Отключён',
      name: null,
      dims: null,
      active: !emb.provider,
      warning: null
    }
  ];

  modelsEl.innerHTML = models.map(m => `
    <div class="embedding-model ${m.active ? 'active' : ''}">
      <div class="embedding-model-radio"></div>
      <div class="embedding-model-info">
        <div class="embedding-model-title">
          ${escapeHtml(m.label)}
          ${m.dims ? `<span class="embedding-model-dims">${m.dims}d</span>` : ''}
        </div>
        ${m.name ? `<div class="embedding-model-name">${escapeHtml(m.name)}</div>` : ''}
        ${m.warning ? `<div class="embedding-model-warning"><i data-lucide="alert-triangle" style="width:12px;height:12px"></i> ${escapeHtml(m.warning)}</div>` : ''}
      </div>
    </div>
  `).join('');

  // Progress bar
  const pct = emb.entriesTotal > 0 ? Math.round(emb.entriesEmbedded / emb.entriesTotal * 100) : 0;
  let fillClass = 'empty';
  if (pct >= 100) fillClass = 'full';
  else if (pct > 0) fillClass = 'partial';

  progressEl.innerHTML = `
    <div class="embedding-progress-label">
      <span>Проиндексировано</span>
      <span>${emb.entriesEmbedded}/${emb.entriesTotal} (${pct}%)</span>
    </div>
    <div class="embedding-progress-bar">
      <div class="embedding-progress-fill ${fillClass}" style="width: ${pct}%"></div>
    </div>
  `;

  lucide.createIcons();
}

// Close embedding panel on outside click
document.addEventListener('click', (e) => {
  const panel = document.getElementById('embedding-panel');
  const indicator = document.getElementById('embedding-indicator');
  if (panel && !panel.contains(e.target) && !indicator.contains(e.target)) {
    panel.classList.remove('open');
  }
});

function showToast(message, type = 'info') {
  const iconMap = {
    success: 'check-circle',
    error: 'x-circle',
    info: 'info'
  };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <i data-lucide="${iconMap[type]}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  toastContainer.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}
