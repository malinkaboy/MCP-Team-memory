// Team Memory Dashboard v2 - JavaScript

const API_BASE = '/api';

// Auth: Bearer token from localStorage (set via ?token= query param or manual input)
const AUTH_TOKEN = new URLSearchParams(window.location.search).get('token') || localStorage.getItem('auth-token') || '';
if (AUTH_TOKEN) {
  localStorage.setItem('auth-token', AUTH_TOKEN);
  // Remove token from URL to prevent leaking via browser history / Referer
  const url = new URL(window.location);
  if (url.searchParams.has('token')) {
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url);
  }
}

function authHeaders() {
  return AUTH_TOKEN ? { 'Authorization': `Bearer ${AUTH_TOKEN}` } : {};
}

async function authFetch(url, options = {}) {
  const headers = { ...authHeaders(), ...(options.headers || {}) };
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('auth-token');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  return res;
}

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
let isAgentsView = false;

// Theme configuration
const THEMES = [
  {
    id: 'default',
    name: 'Default',
    desc: 'Тёмная тема с indigo-акцентом',
    colors: { bg: '#0f0f0f', sidebar: '#1a1a1a', sidebarBorder: '1px solid #333', accent: '#6366f1', line1: '#333', line2: '#6366f1', line3: '#252525', line4: '#252525' }
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    desc: 'Жёсткий геометричный стиль, толстые рамки',
    colors: { bg: '#F8F6F1', sidebar: '#fff', sidebarBorder: '3px solid #111', accent: '#D42B2B', line1: '#D8D4CC', line2: '#D42B2B', line3: '#EDEAE4', line4: '#EDEAE4' }
  },
  {
    id: 'gazette',
    name: 'Gazette',
    desc: 'Газетный editorial-стиль, тёплые тона',
    colors: { bg: '#F6F1E9', sidebar: '#FAF7F1', sidebarBorder: '2px solid #2A241C', accent: '#8B2020', line1: '#D4C9B8', line2: '#8B2020', line3: '#E2D9CA', line4: '#E2D9CA' }
  },
  {
    id: 'sport',
    name: 'Sport',
    desc: 'Тёмный спортивный с неоновым акцентом',
    colors: { bg: '#0A0A0A', sidebar: '#161616', sidebarBorder: '1px solid #3A3A3A', accent: '#CCFF00', line1: '#3A3A3A', line2: '#CCFF00', line3: '#1C1C1C', line4: '#1C1C1C' }
  },
  {
    id: 'dashboard',
    name: 'Dashboard',
    desc: 'Aurora-градиенты, тёплые и холодные тона',
    colors: { bg: '#07070B', sidebar: '#0D0D14', sidebarBorder: '1px solid rgba(255,255,255,0.05)', accent: '#FF8C42', line1: '#2A2A34', line2: 'linear-gradient(90deg, #FF8C42, #FF3B6C)', line3: '#15151E', line4: '#15151E' }
  }
];

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
  // Check if auth is required and redirect to login if needed
  try {
    const checkRes = await fetch('/api/auth/check');
    const { authEnabled } = await checkRes.json();
    if (authEnabled && !AUTH_TOKEN) {
      window.location.href = '/login';
      return;
    }
    if (authEnabled && AUTH_TOKEN) {
      const verifyRes = await authFetch('/api/auth/verify');
      const authInfo = await verifyRes.json();
      if (authInfo.agentName) {
        document.querySelector('.logo-text').textContent = `Team Memory`;
        const badge = document.createElement('span');
        badge.className = 'agent-badge';
        badge.textContent = authInfo.agentName;
        badge.title = `Role: ${authInfo.role}`;
        document.querySelector('.logo').appendChild(badge);
      }
      // Show Agents tab only for master token holder
      if (authInfo.isMaster) {
        const agentsBtn = document.getElementById('btn-agents-view');
        if (agentsBtn) agentsBtn.style.display = '';
      }
    }
  } catch (e) {
    // If check fails, proceed without auth
  }

  lucide.createIcons();
  initSidebarToggle();
  initNavigation();
  initSearch();
  initModal();
  initFormSelects();
  initThemeSwitcher();
  initProjectsModal();
  initEntryActions();
  initWebSocket();
  await loadProjects();
  loadEntries();
  loadStats();
});

// === Projects ===

async function loadProjects() {
  try {
    const response = await authFetch(`${API_BASE}/projects`);
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
  const optionsContainer = document.getElementById('domain-options');
  const project = projects.find(p => p.id === currentProjectId);
  const domains = project ? project.domains : [];

  optionsContainer.innerHTML = '<div class="custom-select-option selected" data-value=""><span class="custom-select-option-name">Без домена</span></div>';
  for (const d of domains) {
    const info = domainInfo[d];
    const label = info ? info.name : d;
    const optEl = document.createElement('div');
    optEl.className = 'custom-select-option';
    optEl.dataset.value = d;
    optEl.innerHTML = `<span class="custom-select-option-name">${escapeHtml(label)}</span>`;
    optionsContainer.appendChild(optEl);
  }

  // Re-bind click handlers for new options
  initFormSelect('domain-select', 'entry-domain');
  setFormSelectValue('domain-select', 'entry-domain', '');
}

// Navigation
function initNavigation() {
  document.querySelectorAll('.nav-item[data-category]').forEach(item => {
    item.addEventListener('click', () => {
      if (isGraphView) toggleGraphView(false);
      if (isAgentsView) toggleAgentsView(false);

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

  // Agents view toggle (admin only)
  const agentsBtn = document.getElementById('btn-agents-view');
  if (agentsBtn) {
    agentsBtn.addEventListener('click', () => toggleAgentsView(true));
  }
  initAgentsPanel();

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

// === Form Custom Selects ===

function initFormSelect(selectId, hiddenInputId) {
  const wrapper = document.getElementById(selectId);
  if (!wrapper) return;
  const trigger = wrapper.querySelector('.custom-select-trigger');
  const valueEl = wrapper.querySelector('.custom-select-value');
  const options = wrapper.querySelectorAll('.custom-select-option');
  const hidden = document.getElementById(hiddenInputId);

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // Close other open selects
    document.querySelectorAll('.custom-select.open').forEach(s => {
      if (s !== wrapper) s.classList.remove('open');
    });
    wrapper.classList.toggle('open');
  });

  options.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      options.forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
      valueEl.textContent = opt.querySelector('.custom-select-option-name').textContent;
      hidden.value = opt.dataset.value;
      wrapper.classList.remove('open');
    });
  });
}

function setFormSelectValue(selectId, hiddenInputId, value) {
  const wrapper = document.getElementById(selectId);
  const hidden = document.getElementById(hiddenInputId);
  if (!wrapper || !hidden) return;
  hidden.value = value;
  const options = wrapper.querySelectorAll('.custom-select-option');
  options.forEach(opt => {
    opt.classList.toggle('selected', opt.dataset.value === value);
    if (opt.dataset.value === value) {
      wrapper.querySelector('.custom-select-value').textContent =
        opt.querySelector('.custom-select-option-name').textContent;
    }
  });
}

function initFormSelects() {
  initFormSelect('category-select', 'entry-category');
  initFormSelect('domain-select', 'entry-domain');
  initFormSelect('priority-select', 'entry-priority');
  initFormSelect('entry-status-select', 'entry-status');

  // Close all selects on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.custom-select.open').forEach(s => s.classList.remove('open'));
  });
}

// === Entry & Project Action Delegation (CSP-safe, no inline handlers) ===

function initEntryActions() {
  // Entry card actions (delegated on entries container)
  entriesContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    const id = btn.dataset.id;
    if (action === 'togglePin') togglePin(id);
    else if (action === 'editEntry') editEntry(id);
    else if (action === 'showHistory') showHistory(id);
    else if (action === 'archiveEntry') archiveEntry(id);
    else if (action === 'deleteEntry') deleteEntry(id);
  });

  // Project delete action (delegated on projects modal)
  const projectsList = document.getElementById('projects-list');
  if (projectsList) {
    projectsList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="deleteProject"]');
      if (!btn) return;
      e.stopPropagation();
      deleteProject(btn.dataset.id);
    });
  }
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
    setFormSelectValue('category-select', 'entry-category', entry.category);
    setFormSelectValue('domain-select', 'entry-domain', entry.domain || '');
    document.getElementById('entry-title').value = entry.title;
    document.getElementById('entry-content').value = entry.content;
    setFormSelectValue('priority-select', 'entry-priority', entry.priority);
    setFormSelectValue('entry-status-select', 'entry-status', entry.status);
    document.getElementById('entry-tags').value = entry.tags.join(', ');
    document.getElementById('entry-author').value = entry.author;
  } else {
    modalTitle.textContent = 'Добавить запись';
    entryForm.reset();
    document.getElementById('entry-id').value = '';
    setFormSelectValue('category-select', 'entry-category', 'architecture');
    setFormSelectValue('priority-select', 'entry-priority', 'medium');
    setFormSelectValue('entry-status-select', 'entry-status', 'active');
    setFormSelectValue('domain-select', 'entry-domain', '');
    if (currentCategory !== 'all' && currentCategory !== 'pinned') {
      setFormSelectValue('category-select', 'entry-category', currentCategory);
    }
    if (currentDomain) {
      setFormSelectValue('domain-select', 'entry-domain', currentDomain);
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
      response = await authFetch(`${API_BASE}/memory/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    } else {
      response = await authFetch(`${API_BASE}/memory`, {
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
          <button class="btn-icon" data-action="deleteProject" data-id="${p.id}" title="Удалить проект">
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
    const response = await authFetch(`${API_BASE}/projects`, {
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
    const response = await authFetch(`${API_BASE}/projects/${id}`, { method: 'DELETE' });
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

    const response = await authFetch(`${API_BASE}/memory?${params}`);
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
    const response = await authFetch(`${API_BASE}/stats${params}`);
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
    const allResponse = await authFetch(`${API_BASE}/memory?${pinnedParams}`);
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
    <div class="entry-card ${escapeHtml(entry.status)}${entry.pinned ? ' pinned' : ''}" data-id="${escapeHtml(entry.id)}">
      <div class="entry-header">
        <div class="entry-title">
          ${entry.pinned ? '<i data-lucide="pin" class="pin-indicator"></i>' : ''}
          <span class="priority-dot priority-${escapeHtml(entry.priority)}"></span>
          ${escapeHtml(entry.title)}
        </div>
        <div class="entry-badges">
          ${domainBadge}
          <span class="entry-category">
            <i data-lucide="${categoryConfig[entry.category]?.icon || 'file'}"></i>
            ${escapeHtml(entry.category)}
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
          <button data-action="togglePin" data-id="${entry.id}" title="${entry.pinned ? 'Открепить' : 'Закрепить'}" class="${entry.pinned ? 'active' : ''}">
            <i data-lucide="pin"></i>
          </button>
          <button data-action="editEntry" data-id="${entry.id}" title="Редактировать">
            <i data-lucide="pencil"></i>
          </button>
          <button data-action="showHistory" data-id="${entry.id}" title="История">
            <i data-lucide="history"></i>
          </button>
          <button data-action="archiveEntry" data-id="${entry.id}" title="Архивировать">
            <i data-lucide="archive"></i>
          </button>
          <button data-action="deleteEntry" data-id="${entry.id}" title="Удалить">
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
    const response = await authFetch(`${API_BASE}/memory/${id}`, {
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
    const response = await authFetch(`${API_BASE}/memory/${id}?archive=false`, {
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
    const response = await authFetch(`${API_BASE}/memory/${id}/pin`, {
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
    const response = await authFetch(`${API_BASE}/memory/${id}/history`);
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
  const tokenParam = AUTH_TOKEN ? `?token=${encodeURIComponent(AUTH_TOKEN)}` : '';
  const wsUrl = `${protocol}//${window.location.host}/ws${tokenParam}`;

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
  if (show && isAgentsView) toggleAgentsView(false);

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

    const response = await authFetch(`${API_BASE}/memory?${params}`);
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

// === Agents Panel ===

function toggleAgentsView(show) {
  isAgentsView = show;
  if (show && isGraphView) toggleGraphView(false);

  const entriesEl = document.getElementById('entries-container');
  const domainEl = document.getElementById('domain-filters');
  const agentsEl = document.getElementById('agents-panel');
  const headerRight = document.querySelector('.header-right');

  if (show) {
    entriesEl.style.display = 'none';
    domainEl.style.display = 'none';
    agentsEl.style.display = '';
    headerRight.style.visibility = 'hidden';

    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    document.getElementById('btn-agents-view').classList.add('active');
    pageTitle.textContent = 'Агенты';

    loadAgents();
  } else {
    agentsEl.style.display = 'none';
    entriesEl.style.display = '';
    domainEl.style.display = '';
    headerRight.style.visibility = '';
  }
}

function initAgentsPanel() {
  const createBtn = document.getElementById('btn-create-agent');
  const cancelBtn = document.getElementById('btn-cancel-agent');
  const confirmBtn = document.getElementById('btn-confirm-agent');
  const closeRevealBtn = document.getElementById('btn-close-reveal');
  const copyBtn = document.getElementById('btn-copy-token');

  if (createBtn) createBtn.addEventListener('click', () => {
    document.getElementById('agents-create-modal').style.display = 'flex';
    document.getElementById('new-agent-name').value = '';
    // Reset role dropdown to developer
    const roleSelect = document.getElementById('role-select');
    if (roleSelect) {
      roleSelect.querySelector('.custom-select-value').innerHTML = '<i data-lucide="code-2"></i> Разработчик';
      roleSelect.querySelector('.custom-select-value').dataset.role = 'developer';
      roleSelect.querySelectorAll('.custom-select-option').forEach(o => o.classList.toggle('selected', o.dataset.value === 'developer'));
    }
    lucide.createIcons();
    document.getElementById('new-agent-name').focus();
  });

  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    document.getElementById('agents-create-modal').style.display = 'none';
  });

  if (confirmBtn) confirmBtn.addEventListener('click', createAgent);

  if (closeRevealBtn) closeRevealBtn.addEventListener('click', () => {
    document.getElementById('agents-token-reveal').style.display = 'none';
  });

  if (copyBtn) copyBtn.addEventListener('click', () => {
    const token = document.getElementById('revealed-token').textContent;
    navigator.clipboard.writeText(token).then(() => showToast('Токен скопирован', 'success'));
  });

  // Custom role dropdown
  const roleSelect = document.getElementById('role-select');
  if (roleSelect) {
    const trigger = roleSelect.querySelector('.custom-select-trigger');
    const options = roleSelect.querySelectorAll('.custom-select-option');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      roleSelect.classList.toggle('open');
    });
    options.forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        options.forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        const val = roleSelect.querySelector('.custom-select-value');
        val.innerHTML = opt.querySelector('.custom-select-option-name').innerHTML;
        val.dataset.role = opt.dataset.value;
        roleSelect.classList.remove('open');
        lucide.createIcons();
      });
    });
    document.addEventListener('click', () => roleSelect.classList.remove('open'));
  }

  // Event delegation for agents table (CSP-compatible, no inline handlers)
  const tbody = document.getElementById('agents-tbody');
  if (tbody) tbody.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (btn) {
      e.stopPropagation();
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      const token = btn.dataset.token;

      if (action === 'copy' && token) {
        navigator.clipboard.writeText(token).then(() => showToast('Токен скопирован', 'success'));
        return;
      }
      if (action === 'revoke') { await revokeAgent(id, name); return; }
      if (action === 'activate') { await activateAgent(id, name); return; }
      if (action === 'delete') { await deleteAgent(id, name); return; }
    }

    // Row click — toggle token row
    const row = e.target.closest('[data-toggle]');
    if (row) {
      const tokenRow = document.getElementById(row.dataset.toggle);
      if (tokenRow) {
        const isVisible = tokenRow.style.display !== 'none';
        tokenRow.style.display = isVisible ? 'none' : '';
        if (!isVisible) lucide.createIcons();
      }
    }
  });
}

async function loadAgents() {
  const tbody = document.getElementById('agents-tbody');
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens`);
    const data = await res.json();

    if (!data.success || !data.tokens?.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:32px">Нет агентов. Создайте первый токен.</td></tr>';
      return;
    }

    tbody.innerHTML = data.tokens.map(t => {
      const statusDot = t.isActive ? '<span class="agent-status-dot active"></span>Активен' : '<span class="agent-status-dot inactive"></span>Отключён';
      const roleIcons = { developer: 'code-2', qa: 'bug', lead: 'crown', devops: 'container' };
      const roleNames = { developer: 'Разработчик', qa: 'Тестировщик', lead: 'Руководитель', devops: 'DevOps' };
      const roleIcon = roleIcons[t.role] || 'user';
      const roleLabel = roleNames[t.role] || escapeHtml(t.role);
      const roleBadge = `<span class="agent-role-badge ${escapeHtml(t.role)}"><i data-lucide="${roleIcon}"></i> ${roleLabel}</span>`;
      const created = t.createdAt ? new Date(t.createdAt).toLocaleDateString('ru-RU') : '—';
      const lastUsed = t.lastUsedAt ? formatDate(t.lastUsedAt) : 'никогда';

      const actions = [];
      if (t.isActive) {
        actions.push(`<button class="btn-revoke" data-action="revoke" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.agentName)}">Отключить</button>`);
      } else {
        actions.push(`<button class="btn-activate" data-action="activate" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.agentName)}">Включить</button>`);
      }
      actions.push(`<button class="btn-delete" data-action="delete" data-id="${escapeHtml(t.id)}" data-name="${escapeHtml(t.agentName)}">Удалить</button>`);

      const rowId = `agent-row-${escapeHtml(t.id)}`;
      return `<tr class="agent-row" data-toggle="${rowId}">
        <td>${statusDot}</td>
        <td><strong>${escapeHtml(t.agentName)}</strong></td>
        <td>${roleBadge}</td>
        <td>${created}</td>
        <td>${lastUsed}</td>
        <td class="agents-actions">${actions.join(' ')}</td>
      </tr>
      <tr class="agent-token-row" id="${rowId}" style="display:none">
        <td colspan="6">
          <div class="agent-token-inline">
            <code>${escapeHtml(t.token)}</code>
            <button class="btn-copy-inline" data-action="copy" data-token="${escapeHtml(t.token)}" title="Копировать">
              <i data-lucide="copy"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
    lucide.createIcons();
  } catch (e) {
    console.error('Failed to load agents:', e);
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--red)">Ошибка загрузки агентов</td></tr>';
  }
}

async function createAgent() {
  const name = document.getElementById('new-agent-name').value.trim();
  const role = document.querySelector('#role-select .custom-select-value')?.dataset.role || 'developer';

  if (!name) {
    showToast('Введите имя агента', 'error');
    return;
  }

  try {
    const res = await authFetch(`${API_BASE}/agent-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: name, role })
    });
    const data = await res.json();

    if (!data.success) {
      showToast(data.error || 'Ошибка создания', 'error');
      return;
    }

    document.getElementById('agents-create-modal').style.display = 'none';
    document.getElementById('revealed-token').textContent = data.token;
    document.getElementById('agents-token-reveal').style.display = 'flex';
    lucide.createIcons();

    loadAgents();
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

async function revokeAgent(id, name) {
  if (!confirm(`Отключить токен для "${name}"?`)) return;
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens/${id}/revoke`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Токен ${name} отключён`, 'success');
      loadAgents();
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

async function activateAgent(id, name) {
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens/${id}/activate`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Токен ${name} активирован`, 'success');
      loadAgents();
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

async function deleteAgent(id, name) {
  if (!confirm(`Удалить токен "${name}" навсегда? Это действие нельзя отменить.`)) return;
  try {
    const res = await authFetch(`${API_BASE}/agent-tokens/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Токен ${name} удалён`, 'success');
      loadAgents();
    } else {
      showToast(data.error || 'Ошибка', 'error');
    }
  } catch (e) {
    showToast('Ошибка сети', 'error');
  }
}

// ============================================
// Theme Switching
// ============================================

function getCurrentTheme() {
  return document.documentElement.dataset.theme || 'default';
}

function applyTheme(themeId) {
  if (themeId === 'default') {
    document.documentElement.removeAttribute('data-theme');
    localStorage.removeItem('tm-theme');
  } else {
    document.documentElement.dataset.theme = themeId;
    localStorage.setItem('tm-theme', themeId);
  }
}

function renderThemePreview(colors) {
  return `<div class="theme-preview">
    <div class="theme-preview-inner" style="background:${colors.bg}">
      <div class="theme-preview-sidebar" style="background:${colors.sidebar};border-right:${colors.sidebarBorder}"></div>
      <div class="theme-preview-main">
        <div class="theme-preview-line" style="width:80%;background:${colors.line1}"></div>
        <div class="theme-preview-line" style="width:60%;background:${colors.line2}"></div>
        <div class="theme-preview-line" style="width:80%;background:${colors.line3}"></div>
        <div class="theme-preview-line" style="width:40%;background:${colors.line4}"></div>
      </div>
    </div>
  </div>`;
}

function openThemeModal() {
  const current = getCurrentTheme();
  const list = document.getElementById('theme-list');

  list.innerHTML = THEMES.map(t => `
    <div class="theme-row ${t.id === current ? 'active' : ''}" data-theme-id="${t.id}">
      ${renderThemePreview(t.colors)}
      <div class="theme-info">
        <div class="theme-name">${t.name}</div>
        <div class="theme-desc">${t.desc}</div>
      </div>
      <div class="theme-check">\u2713</div>
    </div>
  `).join('');

  let selectedId = null;
  list.querySelectorAll('.theme-row').forEach(row => {
    row.addEventListener('click', () => {
      list.querySelectorAll('.theme-row').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      selectedId = row.dataset.themeId;
    });
  });

  const themeModal = document.getElementById('theme-modal');
  themeModal.classList.add('active');

  const applyBtn = document.getElementById('theme-apply');
  const cancelBtn = document.getElementById('theme-cancel');
  const closeBtn = document.getElementById('theme-modal-close');

  const handleApply = () => {
    if (selectedId) {
      applyTheme(selectedId);
    }
    closeThemeModal();
  };

  const handleClose = () => closeThemeModal();

  applyBtn.onclick = handleApply;
  cancelBtn.onclick = handleClose;
  closeBtn.onclick = handleClose;

  themeModal.onclick = (e) => {
    if (e.target === themeModal) handleClose();
  };
}

function closeThemeModal() {
  document.getElementById('theme-modal').classList.remove('active');
}

function initThemeSwitcher() {
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.addEventListener('click', openThemeModal);
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const themeModal = document.getElementById('theme-modal');
      if (themeModal && themeModal.classList.contains('active')) {
        closeThemeModal();
      }
    }
  });
}
