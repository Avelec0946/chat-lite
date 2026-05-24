// ===== State =====
const state = {
  conversations: [],
  currentId: null,
  loading: false,
  abortController: null,
  settingsOpen: false,
};

const STORAGE_KEY = 'chatlite_data';
const SETTINGS_KEY = 'chatlite_settings';
let settings = loadSettings();

// ===== Helpers =====
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      conversations: state.conversations,
      currentId: state.currentId,
      version: 2
    }));
  } catch(e) {
    console.warn('Failed to save:', e.message);
  }
  // Sync to server
  try {
    fetch('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversations: state.conversations, currentId: state.currentId })
    });
  } catch(e) {}
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      state.conversations = data.conversations || [];
      state.currentId = data.currentId || null;
      // Migrate v1 (array format) to v2 (tree format)
      if (!data.version || data.version < 2) {
        for (const conv of state.conversations) {
          if (conv.messages && Array.isArray(conv.messages) && !conv.messageMap) {
            migrateV1toV2(conv);
          }
        }
      }
    }
  } catch(e) {}
}

function migrateV1toV2(conv) {
  const map = {};
  const oldMsgs = conv.messages || [];
  if (oldMsgs.length === 0) {
    const rootId = uid();
    map[rootId] = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
    conv.rootId = rootId;
    conv.activePath = [rootId];
    conv.messageMap = map;
    delete conv.messages;
    return;
  }
  // Build tree from linear array
  const rootId = uid();
  map[rootId] = { id: rootId, role: 'system', content: '', parentId: null, children: [], title: '根节点', wordCount: 0, versions: [], activeVersion: 0, files: [], createdAt: Date.now() };
  let prevId = rootId;
  const path = [rootId];
  for (const m of oldMsgs) {
    const id = m.id || uid();
    map[id] = {
      ...m,
      parentId: prevId,
      children: [],
      wordCount: countWords(m.content || ''),
      versions: m.versions || [{ content: m.content || '', timestamp: Date.now(), reason: 'original' }],
      activeVersion: m.activeVersion || 0
    };
    map[prevId].children.push(id);
    prevId = id;
    path.push(id);
  }
  conv.rootId = rootId;
  conv.activePath = path;
  conv.messageMap = map;
  delete conv.messages;
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw);
  } catch(e) {}
  return { systemPrompt: '', userIdentity: '', thinkingEnabled: true, apiKey: '', fontSize: '15', lineSpacing: '1.6' };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ===== Conversation Model =====
function newConversation() {
  const msgId = uid();
  const rootMsg = {
    id: msgId, role: 'system', content: '',
    parentId: null, children: [],
    title: '对话根节点', wordCount: 0,
    versions: [{ content: '', timestamp: Date.now(), reason: 'original' }],
    activeVersion: 0, files: [], editing: false, createdAt: Date.now()
  };
  return {
    id: uid(),
    title: '新对话',
    model: 'deepseek-v4-flash',
    thinkingEnabled: settings.thinkingEnabled,
    systemPrompt: '',
    userIdentity: '',
    rootId: msgId,
    activePath: [msgId],
    messageMap: { [msgId]: rootMsg },
    createdAt: Date.now()
  };
}

// Tree helpers
function getMsg(conv, id) { return conv.messageMap[id]; }
function getActiveChain(conv) {
  return conv.activePath.map(id => conv.messageMap[id]).filter(Boolean);
}
function getLastActiveMsg(conv) {
  const chain = getActiveChain(conv);
  return chain[chain.length - 1] || null;
}
function countWords(text) { return (text || '').length; }
function computeBranchWords(conv, fromId) {
  let total = 0, visited = new Set(), stack = [fromId];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    const msg = conv.messageMap[id];
    if (msg) {
      total += countWords(msg.content);
      stack.push(...(msg.children || []));
    }
  }
  return total;
}
function getBranchPath(conv, leafId) {
  const path = [];
  let current = leafId;
  while (current) {
    path.unshift(current);
    const msg = conv.messageMap[current];
    if (!msg || !msg.parentId) break;
    current = msg.parentId;
  }
  return path;
}

// ===== DOM refs =====
const $ = id => document.getElementById(id);
const convList = $('conv-list');
const messagesEl = $('messages');
const emptyState = $('empty-state');
const chatInput = $('chat-input');
const btnSend = $('btn-send');
const btnNew = $('btn-new-chat');
const btnUpload = $('btn-upload');
const fileInput = $('file-input');
const filePreview = $('file-preview');
const modelSelect = $('model-select');
const statusIndicator = $('status-indicator');
const settingsPanel = $('settings-panel');
const sidebarToggle = $('btn-sidebar-toggle');
const sidebar = $('sidebar');

// Settings panel elements
const thinkingToggle = $('thinking-toggle');
const systemPromptInput = $('system-prompt');
const userIdentityInput = $('user-identity');
const apiKeyInput = $('api-key-input');

// ===== Init =====
async function init() {
  // Try loading from server first (跨设备同步)
  try {
    const resp = await fetch('/api/load');
    const data = await resp.json();
    if (data.conversations && data.conversations.length > 0) {
      state.conversations = data.conversations;
      state.currentId = data.currentId;
    } else {
      loadData();
    }
  } catch(e) {
    // Server not available, fall back to localStorage
    loadData();
  }
  // Migrate any old-format conversations loaded from server
  for (const conv of state.conversations) {
    if (conv.messages && Array.isArray(conv.messages) && !conv.messageMap) {
      migrateV1toV2(conv);
    }
  }

  // Load model list from server
  try {
    const resp = await fetch('/api/config');
    const cfg = await resp.json();
    modelSelect.innerHTML = (cfg.models || ['deepseek-v4-flash', 'deepseek-v4-pro'])
      .map(m => `<option value="${m}">${m}</option>`).join('');
  } catch(e) {
    modelSelect.innerHTML = '<option value="deepseek-v4-flash">deepseek-v4-flash</option><option value="deepseek-v4-pro">deepseek-v4-pro</option>';
  }

  // Apply settings to UI
  thinkingToggle.checked = settings.thinkingEnabled;
  systemPromptInput.value = settings.systemPrompt || '';
  userIdentityInput.value = settings.userIdentity || '';
  apiKeyInput.value = settings.apiKey || '';
  applyDisplaySettings();

  // Thinking toggle auto-saves immediately
  thinkingToggle.addEventListener('change', () => {
    settings.thinkingEnabled = thinkingToggle.checked;
    saveSettings();
    const conv = currentConv();
    if (conv) {
      conv.thinkingEnabled = settings.thinkingEnabled;
      save();
    }
  });

  restoreConversationState();
  renderSidebar();
  renderMessages();

  // Event listeners
  btnSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  btnNew.addEventListener('click', newChat);
  $('btn-settings').addEventListener('click', () => toggleSettings(true));
  $('btn-close-settings').addEventListener('click', () => toggleSettings(false));
  $('btn-save-settings').addEventListener('click', saveSettingsHandler);
  settingsPanel.querySelector('.settings-backdrop').addEventListener('click', () => toggleSettings(false));
  sidebarToggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  $('theme-checkbox').addEventListener('change', e => {
    document.body.classList.toggle('dark', e.target.checked);
  });

  // File upload
  btnUpload.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);
  chatInput.addEventListener('input', updateSendButton);

  // Model change
  modelSelect.addEventListener('change', () => {
    const conv = currentConv();
    if (conv) { conv.model = modelSelect.value; save(); }
  });

  // Enable send button on init
  updateSendButton();
}

function currentConv() {
  return state.conversations.find(c => c.id === state.currentId);
}

function restoreConversationState() {
  if (state.conversations.length === 0) {
    const conv = newConversation();
    conv.title = '对话 1';
    conv.thinkingEnabled = settings.thinkingEnabled;
    conv.systemPrompt = settings.systemPrompt || '';
    conv.userIdentity = settings.userIdentity || '';
    state.conversations.push(conv);
    state.currentId = conv.id;
    save();
  }
  // Set model selector
  const conv = currentConv();
  if (conv) {
    modelSelect.value = conv.model || 'deepseek-v4-flash';
  }
}

// ===== Sidebar =====
function renderSidebar() {
  convList.innerHTML = state.conversations.map(c =>
    `<div class="conv-item${c.id === state.currentId ? ' active' : ''}" data-id="${c.id}">
      <span class="conv-title">${escapeHtml(c.title)}</span>
      <button class="del-btn" data-id="${c.id}" title="删除对话">✕</button>
    </div>`
  ).join('');

  // Click to switch
  convList.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('del-btn')) return;
      switchConversation(el.dataset.id);
    });
  });

  // Delete
  convList.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (state.conversations.length <= 1) { newChat(); return; }
      state.conversations = state.conversations.filter(c => c.id !== id);
      if (state.currentId === id) {
        state.currentId = state.conversations[state.conversations.length - 1].id;
        restoreConversationState();
      }
      save();
      renderSidebar();
      renderMessages();
      modelSelect.value = currentConv()?.model || 'deepseek-v4-flash';
    });
  });
}

function switchConversation(id) {
  if (state.loading) return;
  state.currentId = id;
  save();
  renderSidebar();
  renderMessages();
  const conv = currentConv();
  if (conv) {
    modelSelect.value = conv.model || 'deepseek-v4-flash';
  }
}

function newChat() {
  if (state.loading) return;
  const conv = newConversation();
  conv.title = `对话 ${state.conversations.length + 1}`;
  conv.thinkingEnabled = settings.thinkingEnabled;
  conv.systemPrompt = settings.systemPrompt || '';
  conv.userIdentity = settings.userIdentity || '';
  state.conversations.push(conv);
  state.currentId = conv.id;
  save();
  renderSidebar();
  renderMessages();
  modelSelect.value = conv.model;
  chatInput.focus();
}

// ===== Messages Rendering =====
function renderMessages() {
  const conv = currentConv();
  messagesEl.innerHTML = '';
  emptyState.style.display = 'none';

  if (!conv || !conv.rootId) {
    emptyState.style.display = 'block';
    return;
  }

  const chain = getActiveChain(conv);
  // Filter out root system message for display
  const displayMsgs = chain.filter(m => m && m.role !== 'system');

  if (displayMsgs.length === 0) {
    emptyState.style.display = 'block';
    return;
  }

  displayMsgs.forEach((msg, idx) => {
    const isLastMsg = idx === displayMsgs.length - 1;
    const div = document.createElement('div');
    div.className = `message ${msg.role}${msg.editing ? ' message-editing' : ''}`;
    div.dataset.id = msg.id;

    const content = msg.editing ? renderEditMode(msg) : renderContent(msg);

    div.innerHTML = `
      <div class="msg-bubble">
        ${msg.title && msg.title !== '对话根节点' ? `<div class="msg-title">${escapeHtml(msg.title)}</div>` : ''}
        ${content}
        ${msg.role === 'assistant' && !msg.editing ? `
        <div class="msg-actions">
          <button class="msg-action-btn edit-btn" title="编辑">编辑</button>
          <button class="msg-action-btn regenerate-btn" title="重新生成" ${state.loading ? 'disabled' : ''}>重试</button>
        </div>` : ''}
        ${msg.role === 'user' && !msg.editing && !msg.isFileOnly ? `
        <div class="msg-actions">
          <button class="msg-action-btn edit-btn" title="编辑">编辑</button>
        </div>` : ''}
      </div>
    `;

    messagesEl.appendChild(div);

    const editBtn = div.querySelector('.edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => enterEditMode(msg.id));

    const regenBtn = div.querySelector('.regenerate-btn');
    if (regenBtn) regenBtn.addEventListener('click', () => regenerate(msg.id));

    if (msg.editing) {
      const textarea = div.querySelector('.msg-edit-textarea');
      const saveBtn = div.querySelector('.save-btn');
      const cancelBtn = div.querySelector('.cancel-btn');
      if (textarea) {
        textarea.focus();
        textarea.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msg.id, textarea.value); }
          if (e.key === 'Escape') cancelEdit(msg.id);
        });
      }
      if (saveBtn) saveBtn.addEventListener('click', () => saveEdit(msg.id, textarea?.value || ''));
      if (cancelBtn) cancelBtn.addEventListener('click', () => cancelEdit(msg.id));
    }
  });

  renderBranchInfo();
  scrollToBottom();
}

function renderContent(msg) {
  let html = '';

  // Reasoning content (collapsible, if exists)
  if (msg.reasoningContent) {
    html += `<details class="reasoning-details">
      <summary class="reasoning-summary">思考过程</summary>
      <div class="reasoning-content">${escapeHtml(msg.reasoningContent)}</div>
    </details>`;
  }

  // File attachments
  if (msg.files && msg.files.length > 0) {
    html += msg.files.map(f =>
      `<div class="file-tag" style="margin-bottom:4px">${escapeHtml(f.name)} (${formatSize(f.size)})</div>`
    ).join('');
  }

  if (msg.isFileOnly) return html;

  // Markdown content
  const rendered = marked.parse(msg.content || '', { breaks: true, gfm: true });
  html += rendered;

  // Word count
  const wc = countWords(msg.content || '');
  if (wc > 0) {
    html += `<span class="msg-wordcount">${wc}字</span>`;
  }

  // Version info (if multiple versions exist)
  if (msg.versions && msg.versions.length > 1) {
    html += `<div style="font-size:12px;color:var(--text2);margin-top:4px">
      版本 ${msg.activeVersion + 1}/${msg.versions.length}
      ${msg.activeVersion > 0 ? '<button class="msg-action-btn" onclick="prevVersion(\'' + msg.id + '\')">⬅</button>' : ''}
      ${msg.activeVersion < msg.versions.length - 1 ? '<button class="msg-action-btn" onclick="nextVersion(\'' + msg.id + '\')">➡</button>' : ''}
    </div>`;
  }

  return html;
}

function renderEditMode(msg) {
  return `<div class="edit-wrap">
    <textarea class="msg-edit-textarea" id="edit-ta-${msg.id}">${escapeHtml(msg.content)}</textarea>
    <div class="edit-resize-handle" data-for="${msg.id}"></div>
    <div class="edit-actions">
      <button class="save-btn">保存</button>
      <button class="cancel-btn">取消</button>
    </div>
  </div>`;
}

// Touch-friendly resize for edit textarea
document.addEventListener('DOMContentLoaded', () => {
  document.addEventListener('mousedown', onResizeStart);
  document.addEventListener('touchstart', onResizeStart, { passive: false });
});

function onResizeStart(e) {
  const handle = e.target.closest('.edit-resize-handle');
  if (!handle) return;
  e.preventDefault();
  const msgId = handle.dataset.for;
  const ta = document.getElementById(`edit-ta-${msgId}`);
  if (!ta) return;

  const startX = e.type === 'touchstart' ? e.touches[0].clientX : e.clientX;
  const startY = e.type === 'touchstart' ? e.touches[0].clientY : e.clientY;
  const startW = ta.offsetWidth;
  const startH = ta.offsetHeight;

  const onMove = (ev) => {
    const cx = ev.type === 'touchmove' ? ev.touches[0].clientX : ev.clientX;
    const cy = ev.type === 'touchmove' ? ev.touches[0].clientY : ev.clientY;
    const dw = cx - startX;
    const dh = cy - startY;
    ta.style.width = Math.max(200, startW + dw) + 'px';
    ta.style.height = Math.max(100, startH + dh) + 'px';
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onUp);
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

// ===== Edit Message =====
function enterEditMode(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg) { msg.editing = true; renderMessages(); }
}

function saveEdit(msgId, newContent) {
  const conv = currentConv();
  if (!conv || !conv.messageMap) return;
  const msg = getMsg(conv, msgId);
  if (!msg) return;

  if (msg.role === 'assistant') {
    const prevContent = msg.content;
    msg.versions.push({ content: prevContent, timestamp: Date.now(), reason: 'edited' });
    msg.activeVersion = 0;
    msg.content = newContent;
    msg.wordCount = countWords(newContent);
    msg.editing = false;
    save();
    renderMessages();
    return;
  }

  // User message - edit and branch if needed
  msg.content = newContent;
  msg.wordCount = countWords(newContent);
  msg.title = newContent.substring(0, 30) + (newContent.length > 30 ? '...' : '');

  const msgIdx = conv.activePath.indexOf(msgId);
  if (msgIdx >= 0 && msgIdx < conv.activePath.length - 1) {
    // There are messages after this - truncate and resend
    conv.activePath = conv.activePath.slice(0, msgIdx + 1);
    save();
    renderMessages();
    msg.editing = false;
    const context = buildContext(conv);
    sendFromMessage(context);
    return;
  }

  msg.editing = false;
  save();
  renderMessages();
}

function cancelEdit(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg) { msg.editing = false; renderMessages(); }
}

// ===== Regenerate =====
async function regenerate(msgId) {
  if (state.loading) return;
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (!msg || msg.role !== 'assistant') return;

  // Get parent user message
  const parentId = msg.parentId;
  const parent = getMsg(conv, parentId);

  // Save old version then remove from active path
  if (msg.content) {
    msg.versions.push({ content: msg.content, timestamp: Date.now(), reason: 'regenerated' });
    msg.activeVersion = 0;
  }

  // Pop this msg from active path
  const idx = conv.activePath.indexOf(msgId);
  if (idx >= 0) {
    conv.activePath = conv.activePath.slice(0, idx);
  }

  msg.content = '';
  save();
  renderMessages();

  const context = buildContext(conv);
  await sendFromMessage(context);
}

// ===== Send Message =====
async function sendMessage() {
  const text = chatInput.innerText.trim();
  if (!text && state.pendingFiles?.length === 0) return;

  const conv = currentConv();
  if (!conv || state.loading) return;

  const files = state.pendingFiles || [];
  state.pendingFiles = [];

  // Get parent (last active message)
  const parent = getLastActiveMsg(conv);

  // Build user message
  const userMsg = {
    id: uid(),
    role: 'user',
    content: text,
    parentId: parent ? parent.id : conv.rootId,
    children: [],
    title: text.substring(0, 30) + (text.length > 30 ? '...' : ''),
    wordCount: countWords(text),
    versions: [{ content: text, timestamp: Date.now(), reason: 'original' }],
    activeVersion: 0,
    files: files.map(f => ({ name: f.name, type: f.type, content: f.content.slice(0, 5000), size: f.size })),
    createdAt: Date.now()
  };

  // Add to tree
  conv.messageMap[userMsg.id] = userMsg;
  if (parent) {
    parent.children.push(userMsg.id);
  }
  conv.activePath.push(userMsg.id);

  chatInput.innerText = '';
  updateSendButton();
  clearFilePreview();
  save();
  renderMessages();

  // Build API context
  const context = buildContext(conv);
  await sendFromMessage(context);
}

function buildContext(conv) {
  const msgs = [];

  // System prompt
  const sysParts = [];
  if (conv.systemPrompt || settings.systemPrompt) {
    sysParts.push(conv.systemPrompt || settings.systemPrompt);
  }
  if (conv.userIdentity || settings.userIdentity) {
    sysParts.push('用户身份：' + (conv.userIdentity || settings.userIdentity));
  }
  if (sysParts.length > 0) {
    msgs.push({ role: 'system', content: sysParts.join('\n\n') });
  }

  // Message history from active path
  const chain = getActiveChain(conv);
  for (const m of chain) {
    if (!m || m.role === 'system') continue;
    let content = m.content;

    // Include file content for user messages
    if (m.files && m.files.length > 0 && m.role === 'user') {
      const fileContext = m.files.map(f => `--- ${f.name} ---\n${f.content}`).join('\n\n');
      if (m.content) {
        content = `用户附带了以下文件内容：\n${fileContext}\n\n用户消息：\n${m.content}`;
      } else {
        content = `用户附带了以下文件内容：\n${fileContext}`;
      }
    }

    msgs.push({ role: m.role, content });
  }

  return msgs;
}

async function sendFromMessage(context) {
  const conv = currentConv();
  if (!conv) return;

  state.loading = true;
  updateSendButton();
  setStatus('busy');

  // Add placeholder assistant message (tree node)
  const lastUser = getLastActiveMsg(conv);
  const assistantMsg = {
    id: uid(),
    role: 'assistant',
    content: '',
    reasoningContent: '',
    parentId: lastUser ? lastUser.id : conv.rootId,
    children: [],
    title: '回复',
    wordCount: 0,
    versions: [{ content: '', timestamp: Date.now(), reason: 'original' }],
    activeVersion: 0,
    files: [],
    createdAt: Date.now()
  };
  conv.messageMap[assistantMsg.id] = assistantMsg;
  if (lastUser) lastUser.children.push(assistantMsg.id);
  conv.activePath.push(assistantMsg.id);
  save();
  renderMessages();

  const lastMsgEl = messagesEl.lastElementChild;
  if (lastMsgEl) {
    const bubble = lastMsgEl.querySelector('.msg-bubble');
    if (bubble) bubble.classList.add('cursor-blink');
  }

  try {
    const resp = await fetch('/api/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: context,
        model: conv.model || modelSelect.value,
        stream: true,
        thinkingEnabled: conv.thinkingEnabled !== false,
        apiKey: settings.apiKey || undefined
      })
    });

    if (!resp.ok) {
      const err = await resp.json();
      throw new Error(err.detail || err.error || `HTTP ${resp.status}`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let fullReasoning = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta;
          if (delta) {
            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
              assistantMsg.reasoningContent = fullReasoning;
            }
            if (delta.content) {
              fullContent += delta.content;
              assistantMsg.content = fullContent;
            }
            // Update display: pass both reasoning and content
            updateMessageContent(assistantMsg.id, fullContent, fullReasoning);
          }
        } catch(e) {
          // Skip malformed lines
        }
      }
    }

    // Update versions
    assistantMsg.versions[0] = { content: fullContent, timestamp: Date.now(), reason: 'original' };
    save();
    setStatus('ok');

  } catch (err) {
    console.error('Send error:', err);
    assistantMsg.content = `**错误：** ${escapeHtml(err.message)}`;
    assistantMsg.isError = true;
    save();
    renderMessages();
    setStatus('err');
  } finally {
    state.loading = false;
    updateSendButton();
    // Remove cursor blink
    const bubbles = messagesEl.querySelectorAll('.cursor-blink');
    bubbles.forEach(el => el.classList.remove('cursor-blink'));
    scrollToBottom();
  }
}

function updateMessageContent(msgId, content, reasoning) {
  const el = messagesEl.querySelector(`.message[data-id="${msgId}"] .msg-bubble`);
  if (!el) return;

  // Reasoning block (collapsible, at top)
  let reasoningEl = el.querySelector('.reasoning-block');
  if (reasoning) {
    if (!reasoningEl) {
      reasoningEl = document.createElement('div');
      reasoningEl.className = 'reasoning-block';
      reasoningEl.innerHTML = `<details class="reasoning-details">
        <summary class="reasoning-summary">思考过程</summary>
        <div class="reasoning-content rendered-reasoning"></div>
      </details>`;
      el.insertBefore(reasoningEl, el.firstChild);
    }
    const rContent = reasoningEl.querySelector('.rendered-reasoning');
    if (rContent) rContent.textContent = reasoning;
  } else if (reasoningEl) {
    reasoningEl.remove();
  }

  // Content area
  let contentEl = el.querySelector('.rendered-content');
  if (!contentEl) {
    contentEl = document.createElement('div');
    contentEl.className = 'rendered-content';
    const actions = el.querySelector('.msg-actions');
    if (actions) {
      el.insertBefore(contentEl, actions);
    } else {
      el.appendChild(contentEl);
    }
  }
  contentEl.innerHTML = marked.parse(content || '', { breaks: true, gfm: true });

  // Highlight code blocks
  contentEl.querySelectorAll('pre code').forEach(block => {
    if (typeof hljs !== 'undefined') {
      hljs.highlightElement(block);
    }
  });

  scrollToBottom();
}

// ===== Branch tree panel =====
function renderBranchInfo() {
  const conv = currentConv();
  if (!conv) return;
  const panel = document.getElementById('branch-panel');
  if (!panel) return;
  panel.innerHTML = '';

  // Branch word count
  const totalWords = computeBranchWords(conv, conv.rootId);
  const info = document.createElement('div');
  info.className = 'branch-info';
  info.textContent = `当前分支 ${getActiveChain(conv).filter(m => m && m.role !== 'system').length} 条消息 · ${totalWords} 字`;
  panel.appendChild(info);

  // Build tree
  const tree = buildTreeHTML(conv, conv.rootId, conv.activePath, 0);
  if (tree) panel.appendChild(tree);
}

function buildTreeHTML(conv, nodeId, activePath, depth) {
  const msg = conv.messageMap[nodeId];
  if (!msg || msg.role === 'system') return null;

  const isActive = activePath.includes(nodeId);
  const isLeaf = !msg.children || msg.children.length === 0;
  const hasBranch = msg.children && msg.children.length > 1;

  const div = document.createElement('div');
  div.className = `branch-node${isActive ? ' active' : ''}`;
  div.style.paddingLeft = Math.min(depth * 16, 80) + 'px';

  const icon = msg.role === 'user' ? '👤' : '🤖';
  const title = msg.title || (msg.content ? msg.content.substring(0, 20) + (msg.content.length > 20 ? '...' : '') : '(空)');
  const wc = msg.wordCount || countWords(msg.content || '');

  div.innerHTML = `<span class="branch-icon">${icon}</span>
    <span class="branch-title">${escapeHtml(title)}</span>
    <span class="branch-wc">${wc}</span>`;

  div.addEventListener('click', () => {
    // Switch active path to this node
    const newPath = getBranchPath(conv, nodeId);
    conv.activePath = newPath;
    save();
    renderMessages();
    renderBranchInfo();
  });

  // Rename on double-click
  div.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const titleSpan = div.querySelector('.branch-title');
    const oldTitle = msg.title || '';
    const input = document.createElement('input');
    input.className = 'branch-rename-input';
    input.value = oldTitle;
    input.addEventListener('blur', () => {
      msg.title = input.value.trim() || oldTitle;
      save();
      renderBranchInfo();
      renderMessages();
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') { input.value = oldTitle; input.blur(); }
    });
    titleSpan.innerHTML = '';
    titleSpan.appendChild(input);
    input.focus();
    input.select();
  });

  // Recurse children
  if (msg.children && msg.children.length > 0) {
    for (const childId of msg.children) {
      const childEl = buildTreeHTML(conv, childId, activePath, depth + 1);
      if (childEl) div.appendChild(childEl);
    }
  }

  // Branch indicator
  if (hasBranch) {
    div.classList.add('has-branch');
  }

  return div;
}

// ===== File Upload =====
state.pendingFiles = [];

function handleFileUpload(e) {
  const files = e.target.files;
  if (!files.length) return;

  for (const file of files) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const content = ev.target.result;
      state.pendingFiles.push({
        name: file.name,
        type: file.type || 'text/plain',
        content: content,
        size: file.size
      });
      renderFilePreview();
    };
    reader.readAsText(file);
  }
  fileInput.value = '';
}

function renderFilePreview() {
  if (state.pendingFiles.length === 0) {
    filePreview.style.display = 'none';
    return;
  }
  filePreview.style.display = 'flex';
  filePreview.innerHTML = state.pendingFiles.map((f, i) =>
    `<span class="file-tag">${escapeHtml(f.name)} (${formatSize(f.size)})
      <button class="remove-file" data-idx="${i}">✕</button>
    </span>`
  ).join('');

  filePreview.querySelectorAll('.remove-file').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      state.pendingFiles.splice(idx, 1);
      renderFilePreview();
    });
  });
}

function clearFilePreview() {
  state.pendingFiles = [];
  filePreview.style.display = 'none';
  filePreview.innerHTML = '';
}

// ===== Settings =====
function applyDisplaySettings() {
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--lh', settings.lineSpacing);
}

function toggleSettings(open) {
  state.settingsOpen = open;
  settingsPanel.style.display = open ? 'flex' : 'none';
  if (open) {
    const conv = currentConv();
    thinkingToggle.checked = conv ? conv.thinkingEnabled : settings.thinkingEnabled;
    systemPromptInput.value = conv?.systemPrompt || settings.systemPrompt || '';
    userIdentityInput.value = conv?.userIdentity || settings.userIdentity || '';
    apiKeyInput.value = settings.apiKey || '';
    // Display settings
    const fsSelect = document.getElementById('font-size-select');
    const lsSelect = document.getElementById('line-spacing-select');
    if (fsSelect) fsSelect.value = settings.fontSize || '15';
    if (lsSelect) lsSelect.value = settings.lineSpacing || '1.6';
  }
}

function saveSettingsHandler() {
  settings.thinkingEnabled = thinkingToggle.checked;
  settings.systemPrompt = systemPromptInput.value.trim();
  settings.userIdentity = userIdentityInput.value.trim();
  settings.apiKey = apiKeyInput.value.trim();
  // Display settings
  const fsSelect = document.getElementById('font-size-select');
  const lsSelect = document.getElementById('line-spacing-select');
  if (fsSelect) settings.fontSize = fsSelect.value;
  if (lsSelect) settings.lineSpacing = lsSelect.value;
  applyDisplaySettings();
  saveSettings();

  // Apply to current conversation
  const conv = currentConv();
  if (conv) {
    conv.thinkingEnabled = settings.thinkingEnabled;
    conv.systemPrompt = settings.systemPrompt;
    conv.userIdentity = settings.userIdentity;
    save();
  }

  toggleSettings(false);
}

// ===== Version Navigation =====
window.prevVersion = function(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg && msg.activeVersion > 0) {
    const curContent = msg.content;
    msg.content = msg.versions[msg.activeVersion - 1].content;
    msg.versions[msg.activeVersion - 1].content = curContent;
    msg.activeVersion--;
    msg.wordCount = countWords(msg.content);
    save();
    renderMessages();
  }
};

window.nextVersion = function(msgId) {
  const conv = currentConv();
  if (!conv) return;
  const msg = getMsg(conv, msgId);
  if (msg && msg.activeVersion < msg.versions.length - 1) {
    const curContent = msg.content;
    msg.content = msg.versions[msg.activeVersion + 1].content;
    msg.versions[msg.activeVersion + 1].content = curContent;
    msg.activeVersion++;
    msg.wordCount = countWords(msg.content);
    save();
    renderMessages();
  }
};

// ===== UI Helpers =====
function updateSendButton() {
  const hasText = chatInput.innerText.trim().length > 0;
  const hasFiles = state.pendingFiles?.length > 0;
  btnSend.disabled = (!hasText && !hasFiles) || state.loading;
}

function setStatus(type) {
  statusIndicator.className = type === 'ok' ? 'status-ok' : type === 'err' ? 'status-err' : 'status-ok';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

// ===== Sidebar close on mobile =====
document.addEventListener('click', (e) => {
  if (window.innerWidth <= 768 && sidebar.classList.contains('open')) {
    if (!sidebar.contains(e.target) && e.target !== sidebarToggle) {
      sidebar.classList.remove('open');
    }
  }
});

// ===== Start =====
document.addEventListener('DOMContentLoaded', init);
