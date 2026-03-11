// Team Memory - Knowledge Graph Visualization
// Using force-graph (2D canvas + d3-force)

const CATEGORY_COLORS = {
  architecture: '#a855f7',
  tasks:        '#3b82f6',
  decisions:    '#10b981',
  issues:       '#ef4444',
  progress:     '#f59e0b',
};

const PRIORITY_SIZES = {
  low:      4,
  medium:   6,
  high:     9,
  critical: 13,
};

const EDGE_COLORS = {
  related: '#6366f1',
  tag:     '#555555',
  domain:  '#2a4a6b',
};

let graphRef = null;
let graphEntries = [];
let selectedNode = null;

// Trigger a canvas repaint without reheating the d3-force simulation.
// pauseAnimation/resumeAnimation restarts the render loop for one cycle
// without touching d3-force alpha — nodes stay in place.
function refreshGraph() {
  if (!graphRef) return;
  graphRef.pauseAnimation();
  requestAnimationFrame(() => graphRef && graphRef.resumeAnimation());
}

// ── helpers ──────────────────────────────────────────

function truncate(str, len = 40) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '\u2026' : str;
}

function categoryLabel(cat) {
  const map = {
    architecture: '\u0410\u0440\u0445\u0438\u0442\u0435\u043a\u0442\u0443\u0440\u0430',
    tasks: '\u0417\u0430\u0434\u0430\u0447\u0438',
    decisions: '\u0420\u0435\u0448\u0435\u043d\u0438\u044f',
    issues: '\u041f\u0440\u043e\u0431\u043b\u0435\u043c\u044b',
    progress: '\u041f\u0440\u043e\u0433\u0440\u0435\u0441\u0441',
  };
  return map[cat] || cat;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ── build graph data ─────────────────────────────────

function buildGraphData(entries) {
  const nodes = [];
  const links = [];
  const idSet = new Set(entries.map(e => e.id));
  const tagIndex = {};
  const edgeSet = new Set();

  function addLink(source, target, type, value) {
    const key = source < target ? `${source}|${target}` : `${target}|${source}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    links.push({ source, target, type, value: value || 1 });
  }

  for (const entry of entries) {
    nodes.push({
      id: entry.id,
      label: truncate(entry.title, 32),
      fullTitle: entry.title,
      color: CATEGORY_COLORS[entry.category] || '#6b7280',
      size: PRIORITY_SIZES[entry.priority] || 6,
      category: entry.category,
      domain: entry.domain || '',
      priority: entry.priority,
    });

    if (entry.tags) {
      for (const tag of entry.tags) {
        const t = tag.toLowerCase();
        if (!tagIndex[t]) tagIndex[t] = [];
        tagIndex[t].push(entry.id);
      }
    }
  }

  // Edge 1: explicit relatedIds
  for (const entry of entries) {
    if (entry.relatedIds) {
      for (const relId of entry.relatedIds) {
        if (idSet.has(relId)) {
          addLink(entry.id, relId, 'related', 3);
        }
      }
    }
  }

  // Edge 2: shared tags (2+ shared tags)
  const tagEdges = new Map();
  for (const tag of Object.keys(tagIndex)) {
    const ids = tagIndex[tag];
    if (ids.length > 20) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        tagEdges.set(key, (tagEdges.get(key) || 0) + 1);
      }
    }
  }
  for (const [key, count] of tagEdges) {
    if (count < 2) continue;
    const [a, b] = key.split('|');
    addLink(a, b, 'tag', Math.min(count, 4));
  }

  // Edge 3: same domain (small groups only)
  const domainIndex = {};
  for (const entry of entries) {
    if (entry.domain) {
      if (!domainIndex[entry.domain]) domainIndex[entry.domain] = [];
      domainIndex[entry.domain].push(entry.id);
    }
  }
  for (const domain of Object.keys(domainIndex)) {
    const ids = domainIndex[domain];
    if (ids.length > 12 || ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        addLink(ids[i], ids[j], 'domain', 1);
      }
    }
  }

  return { nodes, links };
}

// ── render ───────────────────────────────────────────

function renderGraph(entries) {
  const container = document.getElementById('graph-container');
  if (!container) return;

  graphEntries = entries;
  destroyGraph();

  if (entries.length === 0) {
    container.innerHTML = '<div class="graph-empty">\u041d\u0435\u0442 \u0437\u0430\u043f\u0438\u0441\u0435\u0439 \u0434\u043b\u044f \u0432\u0438\u0437\u0443\u0430\u043b\u0438\u0437\u0430\u0446\u0438\u0438</div>';
    return;
  }

  const data = buildGraphData(entries);

  graphRef = ForceGraph()(container)
    .graphData(data)
    .backgroundColor('#0f0f0f')
    .nodeId('id')
    .nodeLabel(node => {
      const entry = graphEntries.find(e => e.id === node.id);
      if (!entry) return node.label;
      return `<div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:8px 12px;max-width:300px;font-family:sans-serif">
        <div style="font-weight:600;font-size:13px;color:#f5f5f5;margin-bottom:4px">${escapeHtml(entry.title)}</div>
        <div style="font-size:11px">
          <span style="color:${CATEGORY_COLORS[entry.category] || '#999'};font-weight:500">${categoryLabel(entry.category)}</span>
          ${entry.domain ? `<span style="color:#666;margin-left:8px">${escapeHtml(entry.domain)}</span>` : ''}
        </div>
      </div>`;
    })
    .nodeColor('color')
    .nodeVal(node => node.size * node.size * 0.5)
    .nodeCanvasObject((node, ctx, globalScale) => {
      const r = Math.sqrt(node.size * node.size * 0.5) * 1.2;
      const isSelected = selectedNode && selectedNode.id === node.id;
      const isNeighbor = selectedNode && isLinked(selectedNode.id, node.id);
      const dimmed = selectedNode && !isSelected && !isNeighbor;

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
      ctx.fillStyle = dimmed ? (node.color + '30') : node.color;
      ctx.fill();

      if (isSelected) {
        ctx.strokeStyle = '#06b6d4';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label
      if (!dimmed && globalScale > 0.6) {
        const label = node.label;
        const fontSize = Math.max(10 / globalScale, 3);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = dimmed ? '#33333330' : '#e5e5e5';
        ctx.fillText(label, node.x, node.y + r + 2);
      }
    })
    .nodeCanvasObjectMode(() => 'replace')
    .linkColor(link => {
      if (selectedNode) {
        const sid = selectedNode.id;
        const srcId = typeof link.source === 'object' ? link.source.id : link.source;
        const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
        if (srcId !== sid && tgtId !== sid) return '#ffffff08';
      }
      return EDGE_COLORS[link.type] || '#333';
    })
    .linkWidth(link => {
      if (selectedNode) {
        const sid = selectedNode.id;
        const srcId = typeof link.source === 'object' ? link.source.id : link.source;
        const tgtId = typeof link.target === 'object' ? link.target.id : link.target;
        if (srcId === sid || tgtId === sid) return (link.value || 1) * 1.5;
      }
      return link.value || 1;
    })
    .linkDirectionalParticles(link => {
      if (link.type === 'related') return 2;
      return 0;
    })
    .linkDirectionalParticleWidth(2)
    .linkDirectionalParticleColor(() => '#6366f1')
    .onNodeClick(node => {
      try {
        if (selectedNode && selectedNode.id === node.id) {
          selectedNode = null;
          hideNodeDetail();
        } else {
          selectedNode = node;
          showNodeDetail(node.id);
          refreshGraph();
        }
      } catch (e) { console.error('onNodeClick error:', e); }
    })
    .onBackgroundClick(() => {
      try {
        if (!selectedNode) return; // nothing to deselect
        selectedNode = null;
        hideNodeDetail();
      } catch (e) { console.error('onBackgroundClick error:', e); }
    })
    .onRenderFramePre((ctx, globalScale) => {
      const w = ctx.canvas.width / window.devicePixelRatio;
      const h = ctx.canvas.height / window.devicePixelRatio;

      // ── subtle dot grid ──
      const spacing = 30;
      const dotR = 1;
      const transform = graphRef ? graphRef.screen2GraphCoords(0, 0) : { x: 0, y: 0 };
      const transform2 = graphRef ? graphRef.screen2GraphCoords(w, h) : { x: w, y: h };
      const startX = Math.floor(transform.x / spacing) * spacing;
      const startY = Math.floor(transform.y / spacing) * spacing;
      const endX = transform2.x;
      const endY = transform2.y;

      ctx.fillStyle = '#ffffff18';
      for (let x = startX; x < endX; x += spacing) {
        for (let y = startY; y < endY; y += spacing) {
          ctx.beginPath();
          ctx.arc(x, y, dotR / globalScale, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ── radial vignette (screen-space) ──
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0); // reset to screen coords
      const cx = ctx.canvas.width / 2;
      const cy = ctx.canvas.height / 2;
      const radius = Math.max(cx, cy);
      const vignette = ctx.createRadialGradient(cx, cy, radius * 0.4, cx, cy, radius);
      vignette.addColorStop(0, 'transparent');
      vignette.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
      ctx.fillStyle = vignette;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.restore();
    })
    .minZoom(0.1)
    .maxZoom(20)
    .cooldownTicks(200)
    .warmupTicks(50)
    .d3AlphaDecay(0.02)
    .d3VelocityDecay(0.3);

  // Zoom to fit after initial layout settles
  setTimeout(() => {
    if (graphRef) graphRef.zoomToFit(400, 40);
  }, 2000);

  updateGraphLegend();
  updateGraphStats(data);
}

// ── helpers for link detection ───────────────────────

function isLinked(nodeId1, nodeId2) {
  if (!graphRef) return false;
  const data = graphRef.graphData();
  return data.links.some(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    return (s === nodeId1 && t === nodeId2) || (s === nodeId2 && t === nodeId1);
  });
}

function getNeighborIds(nodeId) {
  if (!graphRef) return [];
  const data = graphRef.graphData();
  const neighbors = new Set();
  data.links.forEach(l => {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s === nodeId) neighbors.add(t);
    if (t === nodeId) neighbors.add(s);
  });
  return [...neighbors];
}

// ── Node Detail Panel ────────────────────────────────

function showNodeDetail(nodeId) {
  const panel = document.getElementById('graph-detail-panel');
  if (!panel || !nodeId) { hideNodeDetail(); return; }

  const entry = graphEntries.find(e => e.id === nodeId);
  if (!entry) return;

  const neighborIds = getNeighborIds(nodeId);
  const neighborEntries = neighborIds.map(nId => graphEntries.find(e => e.id === nId)).filter(Boolean);

  panel.innerHTML = `
    <div class="graph-detail-header">
      <span class="priority-dot priority-${entry.priority}"></span>
      <h3>${escapeHtml(entry.title)}</h3>
      <button onclick="hideNodeDetail()" class="graph-detail-close"><i data-lucide="x"></i></button>
    </div>
    <div class="graph-detail-badges">
      <span class="graph-detail-cat" style="background:${CATEGORY_COLORS[entry.category]}20;color:${CATEGORY_COLORS[entry.category]};border:1px solid ${CATEGORY_COLORS[entry.category]}50">${categoryLabel(entry.category)}</span>
      ${entry.domain ? `<span class="graph-detail-domain">${escapeHtml(entry.domain)}</span>` : ''}
      <span class="graph-detail-status graph-detail-status-${entry.status}">${entry.status}</span>
    </div>
    <div class="graph-detail-content">${escapeHtml(entry.content)}</div>
    ${entry.tags && entry.tags.length > 0 ? `
      <div class="graph-detail-tags">
        ${entry.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
      </div>
    ` : ''}
    <div class="graph-detail-actions">
      <button class="btn btn-primary btn-sm" onclick="openEntryFromGraph('${entry.id}')">
        <i data-lucide="pencil"></i> Редактировать
      </button>
    </div>
    <div class="graph-detail-meta">
      <span><i data-lucide="user"></i> ${escapeHtml(entry.author || 'unknown')}</span>
      <span><i data-lucide="calendar"></i> ${new Date(entry.updatedAt).toLocaleDateString('ru-RU')}</span>
      <span><i data-lucide="git-branch"></i> ${neighborIds.length} \u0441\u0432\u044f\u0437\u0435\u0439</span>
    </div>
    ${neighborEntries.length > 0 ? `
      <div class="graph-detail-neighbors">
        <h4>\u0421\u0432\u044f\u0437\u0430\u043d\u043d\u044b\u0435 \u0437\u0430\u043f\u0438\u0441\u0438</h4>
        ${neighborEntries.map(n => `
          <div class="graph-neighbor-item" onclick="focusNode('${n.id}')">
            <span class="priority-dot priority-${n.priority}"></span>
            <span>${escapeHtml(truncate(n.title, 50))}</span>
            <span class="graph-neighbor-cat" style="color:${CATEGORY_COLORS[n.category] || '#999'}">${categoryLabel(n.category)}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;

  panel.classList.add('visible');
  lucide.createIcons();
}

function hideNodeDetail() {
  selectedNode = null;
  const panel = document.getElementById('graph-detail-panel');
  if (panel) panel.classList.remove('visible');
}
window.hideNodeDetail = hideNodeDetail;

function focusNode(nodeId) {
  if (!graphRef) return;
  const data = graphRef.graphData();
  const node = data.nodes.find(n => n.id === nodeId);
  if (!node) return;
  selectedNode = node;
  showNodeDetail(nodeId);
  graphRef.centerAt(node.x, node.y, 400);
  graphRef.zoom(3, 400);
  refreshGraph();
}
window.focusNode = focusNode;

// ── Legend & Stats ───────────────────────────────────

function updateGraphLegend() {
  const legend = document.getElementById('graph-legend');
  if (!legend) return;

  legend.innerHTML = `
    <div class="graph-legend-section">
      <h4>\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438</h4>
      ${Object.entries(CATEGORY_COLORS).map(([cat, color]) => `
        <div class="graph-legend-item">
          <span class="graph-legend-dot" style="background:${color}"></span>
          <span>${categoryLabel(cat)}</span>
        </div>
      `).join('')}
    </div>
    <div class="graph-legend-section">
      <h4>\u0421\u0432\u044f\u0437\u0438</h4>
      <div class="graph-legend-item">
        <span class="graph-legend-line" style="background:${EDGE_COLORS.related}"></span>
        <span>\u042f\u0432\u043d\u0430\u044f \u0441\u0432\u044f\u0437\u044c</span>
      </div>
      <div class="graph-legend-item">
        <span class="graph-legend-line" style="background:${EDGE_COLORS.tag}"></span>
        <span>\u041e\u0431\u0449\u0438\u0435 \u0442\u0435\u0433\u0438</span>
      </div>
      <div class="graph-legend-item">
        <span class="graph-legend-line" style="background:${EDGE_COLORS.domain}"></span>
        <span>\u041e\u0431\u0449\u0438\u0439 \u0434\u043e\u043c\u0435\u043d</span>
      </div>
    </div>
    <div class="graph-legend-section">
      <h4>\u0420\u0430\u0437\u043c\u0435\u0440 = \u041f\u0440\u0438\u043e\u0440\u0438\u0442\u0435\u0442</h4>
      <div class="graph-legend-sizes">
        ${Object.entries(PRIORITY_SIZES).map(([p, s]) => `
          <div class="graph-legend-size-item">
            <span class="graph-legend-size-dot" style="width:${s * 2 + 4}px;height:${s * 2 + 4}px;background:#6366f1"></span>
            <span>${p}</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function updateGraphStats(data) {
  const statsEl = document.getElementById('graph-stats');
  if (!statsEl || !data) return;
  statsEl.innerHTML = `
    <span>${data.nodes.length} \u0443\u0437\u043b\u043e\u0432</span>
    <span>${data.links.length} \u0441\u0432\u044f\u0437\u0435\u0439</span>
  `;
}

// ── Zoom controls ────────────────────────────────────

function graphZoomIn() {
  if (!graphRef) return;
  const z = graphRef.zoom();
  graphRef.zoom(Math.min(z * 1.5, 20), 200);
}
window.graphZoomIn = graphZoomIn;

function graphZoomOut() {
  if (!graphRef) return;
  const z = graphRef.zoom();
  graphRef.zoom(Math.max(z / 1.5, 0.1), 200);
}
window.graphZoomOut = graphZoomOut;

function graphZoomFit() {
  if (!graphRef) return;
  graphRef.zoomToFit(400, 40);
}
window.graphZoomFit = graphZoomFit;

function toggleLayout() {
  if (!graphRef) return;
  const data = graphRef.graphData();
  // Reheat simulation
  graphRef.d3ReheatSimulation();
}
window.toggleLayout = toggleLayout;

function resetGraphFilters() {
  selectedNode = null;
  hideNodeDetail();
  if (graphRef) {
    refreshGraph();
    graphRef.zoomToFit(400, 40);
  }
}
window.resetGraphFilters = resetGraphFilters;

// ── Cleanup ──────────────────────────────────────────

function destroyGraph() {
  if (graphRef) {
    graphRef._destructor && graphRef._destructor();
    graphRef = null;
  }
  selectedNode = null;
  const container = document.getElementById('graph-container');
  if (container) container.innerHTML = '';
}

// Open entry in the main edit modal from graph
function openEntryFromGraph(id) {
  const entry = graphEntries.find(e => e.id === id);
  if (entry && typeof window.openModal === 'function') {
    window.openModal(entry);
  }
}
window.openEntryFromGraph = openEntryFromGraph;

// ── Sidebar toggle ───────────────────────────────────

function toggleGraphSidebar() {
  const sidebar = document.querySelector('.graph-sidebar');
  const btn = document.getElementById('btn-toggle-sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed');
  // Swap icon
  const icon = btn ? btn.querySelector('[data-lucide]') : null;
  if (icon) {
    const isCollapsed = sidebar.classList.contains('collapsed');
    icon.setAttribute('data-lucide', isCollapsed ? 'panel-right-open' : 'panel-right-close');
    lucide.createIcons();
  }
}
window.toggleGraphSidebar = toggleGraphSidebar;

// ── Public API ───────────────────────────────────────

window.renderGraph = renderGraph;
window.destroyGraph = destroyGraph;
