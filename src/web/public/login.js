const form = document.getElementById('login-form');
const input = document.getElementById('token-input');
const btn = document.getElementById('login-btn');
const errorEl = document.getElementById('login-error');
const agentEl = document.getElementById('login-agent-name');

// If token already in localStorage, try auto-login
const saved = localStorage.getItem('auth-token');
if (saved) {
  input.value = saved;
  tryLogin(saved);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = input.value.trim();
  if (!token) return;
  await tryLogin(token);
});

async function tryLogin(token) {
  btn.disabled = true;
  btn.textContent = 'Проверка...';
  errorEl.style.display = 'none';
  agentEl.style.display = 'none';

  try {
    const res = await fetch('/api/auth/verify', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      const data = await res.json();
      localStorage.setItem('auth-token', token);

      if (data.agentName) {
        agentEl.textContent = `${data.agentName} (${data.role || 'agent'})`;
        agentEl.style.display = 'block';
      }

      // Redirect to dashboard after brief delay to show name
      setTimeout(() => {
        window.location.href = '/';
      }, data.agentName ? 600 : 0);
    } else {
      errorEl.textContent = 'Неверный токен';
      errorEl.style.display = 'block';
      localStorage.removeItem('auth-token');
    }
  } catch (err) {
    errorEl.textContent = 'Ошибка подключения к серверу';
    errorEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}
