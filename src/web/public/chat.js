/**
 * AI Chat — minimal chat UI for Ollama LLM (Gemma 4)
 */
(function () {
  const overlay = document.getElementById('chat-overlay');
  const messagesEl = document.getElementById('chat-messages');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('chat-send');
  const closeBtn = document.getElementById('chat-close');
  const clearBtn = document.getElementById('chat-clear');
  const openBtn = document.getElementById('btn-ai-chat');
  const modelBadge = document.getElementById('chat-model-badge');

  let chatSessionId = 'ui-' + Date.now();
  let isGenerating = false;

  // Check LLM status
  async function checkStatus() {
    try {
      const res = await fetch('/api/chat/status', { headers: getAuthHeaders() });
      const data = await res.json();
      if (data.available) {
        modelBadge.textContent = data.model || 'LLM';
        modelBadge.classList.add('chat-model-badge--online');
        openBtn.style.display = '';
      } else {
        openBtn.style.display = '';
        modelBadge.textContent = 'offline';
        modelBadge.classList.add('chat-model-badge--offline');
      }
    } catch {
      openBtn.style.display = '';
    }
  }

  function getAuthHeaders() {
    const token = localStorage.getItem('tm_token');
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function openChat() {
    overlay.style.display = 'flex';
    input.focus();
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }

  function closeChat() {
    overlay.style.display = 'none';
  }

  function appendMessage(role, content) {
    // Remove welcome message on first real message
    const welcome = messagesEl.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg--' + role;

    const avatar = document.createElement('div');
    avatar.className = 'chat-msg-avatar';
    avatar.textContent = role === 'user' ? '👤' : '🤖';

    const bubble = document.createElement('div');
    bubble.className = 'chat-msg-bubble';
    bubble.innerHTML = formatContent(content);

    div.appendChild(avatar);
    div.appendChild(bubble);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function appendTyping() {
    const div = document.createElement('div');
    div.className = 'chat-msg chat-msg--assistant chat-typing';
    div.innerHTML = '<div class="chat-msg-avatar">🤖</div><div class="chat-msg-bubble"><span class="chat-dots"><span>.</span><span>.</span><span>.</span></span></div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function formatContent(text) {
    // Basic markdown rendering. SECURITY: HTML entities are escaped FIRST,
    // then markdown regexes run on escaped text. Regex ordering is critical —
    // do NOT reorder without reviewing XSS implications.
    return text
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (!text || isGenerating) return;

    appendMessage('user', text);
    input.value = '';
    input.style.height = 'auto';
    isGenerating = true;
    sendBtn.disabled = true;

    const typing = appendTyping();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ message: text, session_id: chatSessionId }),
      });

      typing.remove();

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        appendMessage('assistant', '⚠️ ' + (err.error || 'Ошибка генерации'));
      } else {
        const data = await res.json();
        appendMessage('assistant', data.reply);
      }
    } catch (err) {
      typing.remove();
      appendMessage('assistant', '⚠️ Сервер недоступен');
    } finally {
      isGenerating = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  async function clearHistory() {
    try {
      await fetch('/api/chat', {
        method: 'DELETE',
        headers: getAuthHeaders(),
        body: JSON.stringify({ session_id: chatSessionId }),
      });
    } catch { /* ignore */ }
    messagesEl.innerHTML = '<div class="chat-welcome"><i data-lucide="sparkles" class="chat-welcome-icon"></i><p>История очищена. Задавайте вопросы!</p></div>';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    chatSessionId = 'ui-' + Date.now();
  }

  // Event listeners
  openBtn.addEventListener('click', openChat);
  closeBtn.addEventListener('click', closeChat);
  clearBtn.addEventListener('click', clearHistory);
  sendBtn.addEventListener('click', sendMessage);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-resize textarea
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  // Close on overlay click (outside panel)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeChat();
  });

  // Esc to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none') closeChat();
  });

  // Init
  checkStatus();
})();
